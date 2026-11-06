/**
 * Runtime：组合根（dsh src/app/runtime.ts 的对应）。
 * 职责（dsh 007-architecture §Runtime）：
 * - 构造应用：Engine（领域核心）+ Store 仓储 + Policy + Assessor + Executor + Outbox + Passes；
 * - 不包含领域规则（规则在 core/policy）；
 * - 启动：注册副作用处理器 → 恢复中断的工作项 → 启动 Passes；
 * - 停止：关闸（禁止新模型请求）→ 终止桥接进程组（中断在途请求）→ 停止 Passes。
 */
import { Engine } from './core/engine'
import { store } from './app/store'
import { effects } from './app/effects'
import { outbox, deliverChatMessage } from './app/outbox'
import { MasterAssessor } from './app/assessment'
import { WorkItemExecutor } from './app/executor'
import { Passes } from './app/passes'
import { uiBus } from './app/events'
import { makePolicy, type PolicySettings } from './policy'
import { getAgentRunning, getRunMode, getAutonomyLevel, setAgentRunning } from './settings/service'
import { getActiveAccountId } from './accounts/service'
import { setLlmRunning, closeLlmGate, isLlmGateOpen } from './agent/llmGate'
import { shutdownBridge } from './agent/bridge/client'
import { audit } from './services/audit'
import { logger } from './services/logger'

let engine: Engine | null = null
let executor: WorkItemExecutor | null = null
let passes: Passes | null = null
/** 应用退出后永久关闸 */
let closed = false

/** 当前策略（每次使用取最新设置；运行开关与运行模式为全局，自主级别取活跃账户） */
export function currentPolicy(): ReturnType<typeof makePolicy> {
  const accountId = getActiveAccountId()
  const settings: PolicySettings = {
    running: getAgentRunning(),
    runMode: getRunMode(),
    autonomyLevel: accountId ? getAutonomyLevel(accountId) : 'conservative'
  }
  return makePolicy(settings)
}

export function getEngine(): Engine {
  if (!engine) throw new Error('runtime not initialized')
  return engine
}

/** 初始化组合（openDatabase 后调用一次） */
export function initRuntime(): void {
  if (engine) return
  const assessorRef: { assessor: MasterAssessor | null } = { assessor: null }
  const executorRef: { executor: WorkItemExecutor | null } = { executor: null }
  engine = new Engine({
    repo: store,
    policy: () => currentPolicy(),
    assessor: {
      request: (evalId) => assessorRef.assessor?.request(evalId),
      release: (evalId) => assessorRef.assessor?.release(evalId)
    },
    executor: {
      start: (ticketId) => executorRef.executor?.start(ticketId)
    },
    outbox,
    emit: (event) => uiBus.onDomainEvent(event)
  })
  executor = new WorkItemExecutor(engine)
  executorRef.executor = executor
  const assessor = new MasterAssessor({ engine, policy: () => currentPolicy() })
  assessorRef.assessor = assessor
  passes = new Passes(engine, executor)

  // 副作用处理器（dsh Effects 表：assessment/launch/reply）
  effects.handle('assessment', (payload) => assessor.assess(String((payload as { evalId: string }).evalId)), { atOnce: 1 })
  effects.handle('launch', (payload) => executor!.launch(String((payload as { ticketId: string }).ticketId)), { atOnce: 4 })
  effects.handle('reply', async (payload) => {
    deliverChatMessage(payload as Parameters<typeof deliverChatMessage>[0])
  }, { atOnce: 1 })
}

/** 启动运行时：恢复未决策事件与中断工作项 → 恢复运行开关 → 启动 Passes 与副作用队列 */
export function startRuntime(): void {
  if (!engine) initRuntime()
  logger.info(`[runtime] requeued ${engine!.requeueStored()} stored triggers, recovered ${engine!.recoverInterrupted().length} interrupted workitems`)
  setLlmRunning(getAgentRunning())
  effects.start()
  passes?.start()
  logger.info('[runtime] started')
}

/** 优雅停止（应用退出）：关闸 → 终止桥接 → 停止 Passes（不修改持久化开关） */
export async function stopRuntime(reason: string): Promise<void> {
  if (closed) return
  closed = true
  setLlmRunning(false)
  closeLlmGate(reason)
  passes?.drain()
  effects.drain()
  await shutdownBridge(reason)
  logger.info(`[runtime] stopped (${reason})`)
}

/** 开始运行（用户点击）：持久化开关 + 开闸 + 广播 */
export function startAgent(): void {
  setAgentRunning(true)
  setLlmRunning(true)
  uiBus.broadcast('agent.status', { running: true })
  audit({ accountId: getActiveAccountId() || 'global', actor: 'user', action: 'agent.start' })
}

/** 停止运行（用户点击）：持久化开关 + 关闸 + 终止在途模型请求 */
export async function stopAgent(): Promise<void> {
  setAgentRunning(false)
  setLlmRunning(false)
  await shutdownBridge('agent stopped')
  uiBus.broadcast('agent.status', { running: false })
  audit({ accountId: getActiveAccountId() || 'global', actor: 'user', action: 'agent.stop' })
}

export function isAgentRunning(): boolean {
  return getAgentRunning() && isLlmGateOpen() && !closed
}

export function getAgentStatus(): { active: boolean; running: boolean } {
  return { active: passes != null, running: isAgentRunning() }
}

export function isRuntimeClosed(): boolean {
  return closed
}
