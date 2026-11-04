/**
 * Agent 决策闭环主循环：「触发 → 评估 → 决策 → 工作项 → 执行 → 汇报」。
 * 常驻主进程；评估与决策串行（单队列）；工作项并发默认 2（同一业务对象互斥）。
 * 崩溃恢复、幂等、超时重试见 workitem.ts。
 */
import { z } from 'zod'
import type { WorkItem } from '@shared/types'
import { nowIso, queryAll, run } from '../db'
import { audit, auditDecision } from '../services/audit'
import { logger } from '../services/logger'
import { agentEventBus, type AgentEvent, recentEvents } from './events'
import { createWorkItem, getWorkItem, incrementAttempts, nextRunnableWorkItem, parseContext, updateWorkItemStatus } from './workitem'
import { structuredOutput, runAgentTurn, llmTraceContext } from './llm'
import { EVALUATION_PROMPT, SYSTEM_IDENTITY } from './prompts'
import { isModelConfigured } from './llm'
import * as pipelines from '../pipeline'
import { addChatMessage } from '../chat'

// ---------- 运行时状态 ----------
const state = {
  active: false,
  /** 运行开关（开始运行/停止运行）；持久化于 app_config 全局行，重启保持 */
  running: false,
  lastTickAt: '',
  activeKeys: new Set<string>(),
  processing: false
}

const RUNNING_CONFIG_KEY = 'agent_running'

export function initAgentRunning(): void {
  const row = queryAll<{ value_encrypted: string }>(
    "SELECT value_encrypted FROM app_config WHERE account_id = 'global' AND key = ?",
    [RUNNING_CONFIG_KEY]
  )[0]
  state.running = row?.value_encrypted === '1'
  logger.info(`[agent] running switch initialized: ${state.running}`)
}

export function isAgentRunning(): boolean {
  return state.running
}

/** 应用退出时优雅停止运行（不修改持久化开关：用户未点击停止，重启后恢复上次状态） */
export function stopAgentRuntime(): void {
  state.active = false
  state.processing = false
  logger.info('[agent] runtime stopped gracefully (app quitting)')
}

export function setAgentRunning(running: boolean): void {
  if (state.running === running) return
  state.running = running
  run(
    `INSERT INTO app_config (account_id, scope, key, value_encrypted, updated_at) VALUES ('global', 'global', ?, '1', ?)
     ON CONFLICT(account_id, key) DO UPDATE SET value_encrypted = excluded.value_encrypted, updated_at = excluded.updated_at`,
    [RUNNING_CONFIG_KEY, nowIso()]
  )
  if (!running) state.active = false
  logger.info(`[agent] running switch ${running ? 'ON' : 'OFF'}`)
}

export function getAgentStatus(): { active: boolean; running: boolean; lastTickAt: string } {
  return { active: state.active, running: state.running, lastTickAt: state.lastTickAt }
}

/** 用户主动触发的事件（不受运行开关限制） */
const USER_EVENTS = new Set(['user.message', 'user_request'])
function isUserEvent(type: string): boolean {
  return USER_EVENTS.has(type)
}

/**
 * 仅 UI/审计的事件（不进入 LLM 评估，节省 token）：
 * - alert.triggered：盯盘预警由定时任务确定性产出（规则预先配置），无需评估；
 * - chat.message：对话流消息（Agent 输出/工具调用等）只推送 UI，不反馈给模型。
 */
const UI_ONLY_EVENTS = new Set(['alert.triggered', 'chat.message'])
function isUiOnlyEvent(type: string): boolean {
  return UI_ONLY_EVENTS.has(type)
}

// ---------- 评估 Schema ----------
const evaluationSchema = z.object({
  needsAction: z.boolean(),
  reason: z.string(),
  suggestedActions: z
    .array(
      z.object({
        kind: z.enum(['create_workitem']),
        workitemType: z.string(),
        refStrategyId: z.string().optional(),
        note: z.string().optional()
      })
    )
    .optional(),
  needsUserAttention: z.boolean().optional()
})
type Evaluation = z.infer<typeof evaluationSchema>

// ---------- 上下文组装（摘要器） ----------
function buildContextSummary(accountId: string): Record<string, unknown> {
  // 轻量摘要：策略状态、最近事件、待决策事项
  const strategies = queryAll<{ status: string; c: number }>('SELECT status, COUNT(*) AS c FROM strategy WHERE account_id = ? GROUP BY status', [accountId])
  const pendingReports = queryAll<{ c: number }>(
    "SELECT COUNT(*) AS c FROM report WHERE account_id = ? AND status = 'pending' AND level = 'need_decision'",
    [accountId]
  )
  const blockedWorkItems = queryAll<{ c: number }>("SELECT COUNT(*) AS c FROM work_item WHERE account_id = ? AND status = 'blocked'", [accountId])
  return {
    strategies: strategies.reduce<Record<string, number>>((acc, s) => ((acc[s.status] = s.c), acc), {}),
    pendingDecisions: pendingReports[0]?.c ?? 0,
    blockedWorkItems: blockedWorkItems[0]?.c ?? 0,
    recentEvents: recentEvents(accountId, 5).map((e) => ({ type: e.type, at: e.occurredAt }))
  }
}

// ---------- 事件处理（评估 → 决策） ----------
export async function handleAgentEvent(event: AgentEvent): Promise<void> {
  // 仅 UI 的事件：不评估、不决策（如盯盘预警——规则已预先配置，定时任务确定性产出）
  if (isUiOnlyEvent(event.type)) {
    logger.debug(`[agent] ui-only event, no evaluation: ${event.type}`)
    return
  }
  // 运行开关：停止运行时，自动事件一律忽略（用户主动事件除外）
  if (!state.running && !isUserEvent(event.type)) {
    logger.debug(`[agent] not running, skip event ${event.type}`)
    return
  }
  if (state.processing) {
    // 串行队列：当前有评估进行中则跳过（去抖已合并同类事件）
    logger.debug('[agent] busy, skip event', event.type)
    return
  }
  state.processing = true
  state.active = true
  state.lastTickAt = new Date().toISOString()
  try {
    // 模型未配置：评估降级为不行动（系统保持"仅数据/回测"可用），不阻塞
    if (!isModelConfigured()) {
      logger.info('[agent] model not configured, skip evaluation (degrade: no action)')
      return
    }
    const context = buildContextSummary(event.accountId)
    const input = { event: { type: event.type, payload: event.payload }, context }
    let evaluation: Evaluation
    try {
      evaluation = await structuredOutput(event.accountId, {
        system: `${SYSTEM_IDENTITY}\n\n${EVALUATION_PROMPT}`,
        prompt: JSON.stringify(input, null, 2),
        schema: evaluationSchema,
        purpose: `evaluate:${event.type}`
      })
    } catch (e) {
      // 评估失败：按事件类型默认策略降级并审计
      const fallback = fallbackForEvent(event.type)
      logger.warn(`[agent] evaluate failed for ${event.type}, fallback: ${fallback}`)
      audit({ accountId: event.accountId, actor: 'agent', action: 'evaluate_fallback', target: event.type, detail: { reason: (e as Error).message, fallback } })
      if (fallback === 'retry_later') {
        // 推迟重试：重新入队评估事件（低频率）
        setTimeout(() => agentEventBus.emitAgentEvent(event.type, event.accountId, event.payload, { debounceMs: 0 }), 10 * 60_000)
      }
      return
    }
    auditDecision(event.accountId, undefined, input, evaluation)
    if (!evaluation.needsAction) {
      logger.debug('[agent] no action needed for', event.type)
      return
    }
    // 决策：评估建议 → 工作项
    for (const action of evaluation.suggestedActions ?? []) {
      if (action.kind !== 'create_workitem') continue
      const workItemType = action.workitemType as WorkItem['type']
      const context: Record<string, unknown> = { eventType: event.type, note: action.note ?? '' }
      if (action.refStrategyId) context.strategyId = action.refStrategyId
      if (action.refStrategyId) context.__busKey = `strategy:${action.refStrategyId}`
      const item = createWorkItem({ accountId: event.accountId, type: workItemType, context })
      audit({ accountId: event.accountId, actor: 'agent', action: 'workitem.decided', target: item.id, detail: { type: workItemType, reason: evaluation.reason } })
    }
  } finally {
    state.processing = false
  }
}

function fallbackForEvent(eventType: string): 'no_action' | 'retry_later' {
  switch (eventType) {
    case 'schedule.plan':
    case 'schedule.plan_weekly':
    case 'schedule.review_daily':
    case 'schedule.review_weekly':
      return 'retry_later'
    default:
      return 'no_action'
  }
}

// ---------- 工作项执行调度 ----------
const MAX_CONCURRENCY = 2
const runningItems = new Map<string, { promise: Promise<void>; settled: boolean }>()

/** 常驻 tick：取到期工作项并执行；由 scheduler 周期性调用 */
export async function tickWorkItems(): Promise<void> {
  state.lastTickAt = new Date().toISOString()
  // 运行开关：停止运行时仅执行用户主动请求（user_request），自动任务不再调度
  if (!state.running) {
    for (const [id, entry] of Array.from(runningItems.entries())) {
      if (entry.settled) runningItems.delete(id)
    }
    while (runningItems.size < MAX_CONCURRENCY) {
      const item = nextRunnableWorkItem(state.activeKeys, nowIso(), (wi) => wi.type === 'user_request')
      if (!item) break
      const busKey = (parseContext(item.contextJson)['__busKey'] as string | undefined) ?? `wi:${item.id}`
      state.activeKeys.add(busKey)
      const entry = { promise: Promise.resolve(), settled: false }
      entry.promise = executeWorkItem(item)
        .catch((e) => logger.error(`[agent] workitem ${item.id} crashed: ${(e as Error).message}`))
        .finally(() => {
          entry.settled = true
          state.activeKeys.delete(busKey)
        })
      runningItems.set(item.id, entry)
    }
    return
  }
  // 清理已完成的任务槽
  for (const [id, entry] of Array.from(runningItems.entries())) {
    if (entry.settled) runningItems.delete(id)
  }
  while (runningItems.size < MAX_CONCURRENCY) {
    const item = nextRunnableWorkItem(state.activeKeys, nowIso())
    if (!item) break
    const busKey = (parseContext(item.contextJson)['__busKey'] as string | undefined) ?? `wi:${item.id}`
    state.activeKeys.add(busKey)
    const entry = { promise: Promise.resolve(), settled: false }
    entry.promise = executeWorkItem(item)
      .catch((e) => logger.error(`[agent] workitem ${item.id} crashed: ${(e as Error).message}`))
      .finally(() => {
        entry.settled = true
        state.activeKeys.delete(busKey)
      })
    runningItems.set(item.id, entry)
  }
}

// ---------- 工作项执行 ----------
const WORKITEM_TIMEOUT_MS = 30 * 60_000

/** 工作项类型中文标签（对话流完成消息） */
const WORKITEM_LABELS: Record<string, string> = {
  plan: '规划',
  generate_strategy: '生成策略',
  backtest: '回测',
  activate: '上线评审',
  monitor_review: '盯盘检查',
  review_daily: '日复盘',
  review_weekly: '周复盘',
  correct: '纠正',
  data_backfill: '数据补数',
  user_request: '用户请求'
}

export async function executeWorkItem(item: WorkItem): Promise<void> {
  updateWorkItemStatus(item.id, 'running')
  incrementAttempts(item.id)
  const timeout = setTimeout(() => {
    updateWorkItemStatus(item.id, 'failed', { error: `执行超时（${WORKITEM_TIMEOUT_MS / 60000} 分钟）` })
    logger.warn(`[agent] workitem ${item.id} timeout`)
  }, WORKITEM_TIMEOUT_MS)
  try {
    const context = parseContext(item.contextJson)
    logger.info(`[agent] executing workitem ${item.id} (${item.type})`)
    // 注入 LLM 追踪上下文：工作项内全部模型消息（含工具调用/思考）挂到本工作项分组
    const result = await llmTraceContext.run({ workItemId: item.id, sessionId: item.sessionId }, () => dispatchWorkItem(item, context))
    clearTimeout(timeout)
    updateWorkItemStatus(item.id, 'succeeded', { resultJson: JSON.stringify(result ?? {}) })
    // 工作项完成 → 主要结果进首页对话流（user_request 的结果已由消息流记录，不重复）
    if (item.type !== 'user_request') {
      const label = WORKITEM_LABELS[item.type] ?? item.type
      addChatMessage({
        accountId: item.accountId,
        role: 'assistant',
        kind: 'result',
        content: `${label}完成`,
        metaJson: JSON.stringify({ workItemType: item.type, result: summarizeResult(result) }),
        workItemId: item.id,
        sessionId: item.sessionId
      })
    }
    agentEventBus.emitAgentEvent('workitem.completed', item.accountId, { workItemId: item.id, type: item.type, result: result ?? {} }, { debounceMs: 0 })
    audit({ accountId: item.accountId, actor: 'agent', action: 'workitem.succeeded', target: item.id, detail: { type: item.type } })
  } catch (e) {
    clearTimeout(timeout)
    const err = e as Error
    logger.warn(`[agent] workitem ${item.id} failed (attempt ${item.attempts}/${item.maxAttempts}): ${err.message}`)
    if (item.attempts >= item.maxAttempts) {
      updateWorkItemStatus(item.id, 'failed', { error: err.message })
      // 失败结果进首页对话流
      const label = WORKITEM_LABELS[item.type] ?? item.type
      addChatMessage({
        accountId: item.accountId,
        role: 'assistant',
        kind: 'error',
        content: `${label}失败：${err.message}`,
        metaJson: JSON.stringify({ workItemType: item.type }),
        workItemId: item.id,
        sessionId: item.sessionId
      })
      agentEventBus.emitAgentEvent('workitem.failed', item.accountId, { workItemId: item.id, type: item.type, error: err.message }, { debounceMs: 0 })
      audit({ accountId: item.accountId, actor: 'agent', action: 'workitem.failed', target: item.id, detail: { type: item.type, error: err.message } })
    } else {
      // 重试（重置 pending，稍后重新调度）
      updateWorkItemStatus(item.id, 'pending', { error: err.message })
    }
  }
}

/** 结果摘要（对话流 meta，截断防爆） */
function summarizeResult(result: unknown): unknown {
  try {
    const text = typeof result === 'string' ? result : JSON.stringify(result ?? {})
    return text.length > 800 ? `${text.slice(0, 800)}…（截断）` : text
  } catch {
    return undefined
  }
}

/** 按工作项类型分发到业务管线 */
async function dispatchWorkItem(item: WorkItem, context: Record<string, unknown>): Promise<unknown> {
  switch (item.type) {
    case 'plan':
      return pipelines.planning.run(item.accountId, 'daily')
    case 'generate_strategy':
      return pipelines.strategyGen.runFromPlan(item.accountId, context)
    case 'backtest':
      return pipelines.backtestPipeline.runBacktestWorkItem(item.accountId, context)
    case 'activate':
      return pipelines.runnerPipeline.activateStrategy(item.accountId, context)
    case 'monitor_review':
      return pipelines.monitorPipeline.run(item.accountId)
    case 'review_daily':
      return pipelines.reviewPipeline.run(item.accountId, 'daily')
    case 'review_weekly':
      return pipelines.reviewPipeline.run(item.accountId, 'weekly')
    case 'correct':
      return pipelines.correctionPipeline.run(item.accountId, context)
    case 'data_backfill':
      return pipelines.dataOps.backfillFromContext(item.accountId, context)
    case 'user_request': {
      // 用户请求：以 Agent 会话执行（业务工具经 SDK MCP server 可用）；
      // 会话全部消息（工具调用/思考/结果）经消息流进入首页对话流，此处只返回结果
      const message = String(context.message ?? '')
      if (!message) return { skipped: true }
      const text = await runAgentTurn(item.accountId, {
        system: `${SYSTEM_IDENTITY}\n\n你是 Daydream 助手，执行用户指令。`,
        prompt: message,
        purpose: 'user_request'
      })
      return { reply: typeof text === 'string' && text.trim() ? text.trim() : '（任务已完成）' }
    }
    default:
      throw new Error(`未知工作项类型: ${item.type}`)
  }
}

// ---------- 手动干预 ----------
export function retryWorkItem(id: string): void {
  const item = getWorkItem(id)
  if (!item) throw new Error('工作项不存在')
  if (item.status === 'failed' || item.status === 'cancelled') {
    updateWorkItemStatus(id, 'pending', { error: undefined })
    audit({ accountId: item.accountId, actor: 'user', action: 'workitem.retry', target: id })
  }
}

export function cancelWorkItem(id: string): void {
  const item = getWorkItem(id)
  if (!item) throw new Error('工作项不存在')
  if (item.status === 'pending' || item.status === 'running' || item.status === 'blocked') {
    updateWorkItemStatus(id, 'cancelled')
    audit({ accountId: item.accountId, actor: 'user', action: 'workitem.cancel', target: id })
  }
}

/** 启动闭环：订阅事件 + 周期 tick（由 scheduler 驱动 tick） */
export function startAgentLoop(): void {
  agentEventBus.on('event', (event: AgentEvent) => {
    // 评估串行队列（不 await，避免阻塞事件发布）
    handleAgentEvent(event).catch((e) => logger.error(`[agent] handle event failed: ${(e as Error).message}`))
  })
  logger.info('[agent] loop started')
}
