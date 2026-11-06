/**
 * WorkItemExecutor：工作项执行器（dsh src/executor/dsh.ts 的对应）。
 * 规则（docs/003-execution.md 的 Daydream 对应）：
 * - 每个工作项一个 Assignment（一次尝试）；并发受 WorkerSlots 上限约束（默认 2）；
 * - 同一业务对象串行（context.__busKey），不同对象可并行；
 * - 超时自动失败（默认 30 分钟）；失败按 attempts 重试（耗尽 → failed）；
 * - 停止运行/退出导致的中断 → cancelled（不重试、不再触发模型请求）；
 * - start(ticketId) 入队 launch 副作用（持久化，重启可恢复）。
 */
import type { Engine } from '../core/engine'
import type { Ticket } from '../core/model'
import { effects, Later } from './effects'
import { llmTraceContext, runAgentTurn, LlmBlockedError } from './sessions'
import { isLlmGateOpen } from '../agent/llmGate'
import { SYSTEM_IDENTITY, USER_CHAT_PROMPT } from '../agent/prompts'
import { audit } from '../services/audit'
import { logger } from '../services/logger'
import * as pipelines from '../pipeline'
import { correctionCompletedTrigger, workitemFailedTrigger } from './triggers'

const MAX_CONCURRENCY = 2
const WORKITEM_TIMEOUT_MS = 30 * 60_000

/** 工作槽：并发上限 + 同一业务对象互斥（dsh WorkerSlots 的简化对应） */
class WorkerSlots {
  private readonly active = new Map<string, { settled: boolean }>()

  get size(): number {
    this.sweep()
    return this.active.size
  }

  /** 是否可承接（槽位未满且业务对象未占用） */
  canAcquire(busKey: string): boolean {
    this.sweep()
    return this.active.size < MAX_CONCURRENCY && !this.active.has(busKey)
  }

  acquire(ticket: Ticket): () => void {
    const busKey = (ticket.context['__busKey'] as string | undefined) ?? `wi:${ticket.id}`
    const entry = { settled: false }
    this.active.set(busKey, entry)
    return () => {
      entry.settled = true
    }
  }

  private sweep(): void {
    for (const [key, entry] of this.active) {
      if (entry.settled) this.active.delete(key)
    }
  }
}

export interface PipelineHost {
  accountId: string
  /** 入队后续工作项（Engine 的唯一写者路径） */
  enqueueTicket: Engine['enqueueTicket']
  /** 工作项上下文（含 eventType/strategyId/message 等） */
  context: Record<string, unknown>
}

export class WorkItemExecutor {
  private readonly slots = new WorkerSlots()

  constructor(private readonly engine: Engine) {}

  /** 请求启动一个工作项（入队持久化 launch 副作用） */
  start(ticketId: string): void {
    effects.enqueue('launch', ticketId, { ticketId })
    void effects.processAll()
  }

  /** 执行一个工作项（launch effect 处理器调用） */
  async launch(ticketId: string): Promise<void> {
    const ticket = this.engine.getTicket(ticketId)
    if (ticket.status !== 'pending') return
    if (!this.slots.canAcquire(String(ticket.context['__busKey'] ?? `wi:${ticket.id}`))) {
      // 槽位满或业务对象占用：推迟，不计失败
      throw new Later(`no worker slot for ${ticketId}`)
    }
    const release = this.slots.acquire(ticket)
    try {
      await this.execute(ticket)
    } finally {
      release()
    }
  }

  private async execute(ticket: Ticket): Promise<void> {
    const assignment = this.engine.assignmentStarted(ticket.id)
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      logger.warn(`[executor] workitem ${ticket.id} timeout (${WORKITEM_TIMEOUT_MS / 60000} min)`)
      // 标记终态 failed；若成功路径先到，end 的幂等守卫保证不覆盖
      this.engine.reportEnded(ticket.id, 'failed', { error: `执行超时（${WORKITEM_TIMEOUT_MS / 60000} 分钟）` })
    }, WORKITEM_TIMEOUT_MS)
    try {
      logger.info(`[executor] executing workitem ${ticket.id} (${ticket.type})`)
      // 注入 LLM 追踪上下文：工作项内全部模型消息挂到本工作项分组
      const result = await llmTraceContext.run({ workItemId: ticket.id }, () => this.dispatch(ticket))
      clearTimeout(timeout)
      if (timedOut) {
        // 超时已把工作项标记 failed（执行未中断，但结果不再覆盖终态）
        this.engine.assignmentEnded(assignment.id, 'failed', 'timeout')
        return
      }
      this.engine.assignmentEnded(assignment.id, 'succeeded')
      this.engine.reportEnded(ticket.id, 'succeeded', { result: normalizeResult(result) })
      // 纠正完成 → 开启新一轮规划（纠正闭环的最后一步，docs §7.7）
      if (ticket.type === 'correct') {
        this.engine.receive(correctionCompletedTrigger(ticket.accountId, ticket.id))
      }
      audit({ accountId: ticket.accountId, actor: 'agent', action: 'workitem.succeeded', target: ticket.id, detail: { type: ticket.type } })
    } catch (e) {
      clearTimeout(timeout)
      const err = e as Error
      if (timedOut) {
        // 超时已判定失败：不再重试、不覆盖终态
        this.engine.assignmentEnded(assignment.id, 'failed', 'timeout')
        return
      }
      this.engine.assignmentEnded(assignment.id, 'failed', err.message)
      // 停止运行/退出导致的中断：取消，不重试、不再触发任何模型请求
      if (err instanceof LlmBlockedError || !isLlmGateOpen()) {
        this.engine.reportEnded(ticket.id, 'cancelled', { error: 'Agent 已停止运行，执行被中断' })
        audit({ accountId: ticket.accountId, actor: 'system', action: 'workitem.cancelled', target: ticket.id, detail: { type: ticket.type, reason: 'agent_stopped' } })
        return
      }
      // 重试次数以数据库为准（避免多跑一轮）
      const fresh = this.engine.getTicket(ticket.id)
      const attemptsNow = fresh?.attempts ?? ticket.attempts + 1
      logger.warn(`[executor] workitem ${ticket.id} failed (attempt ${attemptsNow}/${ticket.maxAttempts}): ${err.message}`)
      if (attemptsNow >= ticket.maxAttempts) {
        this.engine.reportEnded(ticket.id, 'failed', { error: err.message })
        // 失败事实作为触发进入评估（可决定补救动作：如重试/换方向）
        this.engine.receive(workitemFailedTrigger(ticket.accountId, ticket.id, err.message))
        audit({ accountId: ticket.accountId, actor: 'agent', action: 'workitem.failed', target: ticket.id, detail: { type: ticket.type, error: err.message } })
      } else {
        // 自动重试：attempts 保留（已由 assignmentStarted 递增），重置为 pending
        this.engine.requeueTicket(ticket.id)
      }
    }
  }

  /** 按工作项类型分发到业务管线（管线 = 确定性动作 + LLM 智能判断组合） */
  private async dispatch(ticket: Ticket): Promise<unknown> {
    const host: PipelineHost = { accountId: ticket.accountId, enqueueTicket: (opts) => this.engine.enqueueTicket(opts), context: ticket.context }
    switch (ticket.type) {
      case 'plan':
        return pipelines.planning.run(ticket.accountId, 'daily', host)
      case 'generate_strategy':
        return pipelines.strategyGen.runFromPlan(ticket.accountId, ticket.context, host)
      case 'backtest':
        return pipelines.backtestPipeline.runBacktestWorkItem(ticket.accountId, ticket.context)
      case 'activate':
        return pipelines.runnerPipeline.activateStrategy(ticket.accountId, ticket.context)
      case 'monitor_review':
        return pipelines.monitorPipeline.run(ticket.accountId)
      case 'review_daily':
        return pipelines.reviewPipeline.run(ticket.accountId, 'daily', host)
      case 'review_weekly':
        return pipelines.reviewPipeline.run(ticket.accountId, 'weekly', host)
      case 'correct':
        return pipelines.correctionPipeline.run(ticket.accountId, ticket.context, host)
      case 'data_backfill':
        return pipelines.dataOps.backfillFromContext(ticket.accountId, ticket.context)
      case 'user_request': {
        // 用户请求：以 Agent 会话执行（业务工具经 SDK MCP server 可用）；
        // 会话全部消息经消息流进入首页对话流，此处只返回结果
        const message = String(ticket.context.message ?? '')
        if (!message) return { skipped: true }
        const text = await runAgentTurn(ticket.accountId, {
          system: `${SYSTEM_IDENTITY}\n\n${USER_CHAT_PROMPT}`,
          prompt: message,
          purpose: 'user_request'
        })
        return { reply: typeof text === 'string' && text.trim() ? text.trim() : '（任务已完成）' }
      }
      default:
        throw new Error(`未知工作项类型: ${ticket.type}`)
    }
  }
}

function normalizeResult(result: unknown): Record<string, unknown> {
  if (result == null) return {}
  if (typeof result === 'object' && !Array.isArray(result)) return result as Record<string, unknown>
  return { value: result }
}
