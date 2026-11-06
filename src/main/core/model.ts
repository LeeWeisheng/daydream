/**
 * 领域模型 —— 参考 dsh-superagent-prototype 的领域概念（docs/001-domain.md）。
 * 概念映射（dsh → Daydream）：
 * - Trigger → Agent 事件（调度节律 / 用户消息 / 工作项完成 / 回测完成 / 纠正完成 / 数据更新）
 * - Thread  → 账户事件流（每账户一个评估线程，同一时刻一个 Eval）
 * - Eval    → 评估（gate 确定性门槛 + assessment LLM 研判，两层）
 * - Decision→ 决策（accept / stop / ignore / unavailable，落 decision_record）
 * - Mandate → 工作项授权依据（强度、依据、策略版本、匹配规则）
 * - Ticket  → 工作项（闭环中的最小可管理单位；open → ended）
 * - Assignment → 工作项执行实例（一次尝试：pending → running → ended）
 *
 * 本模块是纯领域代码：不 import Electron / SQLite / app 层，不做 I/O。
 * 规则由 Engine 独占执行（见 engine.ts），本模块只声明类型与共享谓词。
 */

// ---------- 基础 ----------
export type Strength = 'explicit' | 'inferred'

/** 授权依据：事件如何被准入（dsh MandateBasis 的 Daydream 对应） */
export type MandateBasis = 'addressed' | 'followup' | 'schedule' | 'internal'

export type WorkItemStatus = 'pending' | 'running' | 'blocked' | 'succeeded' | 'failed' | 'cancelled'

export type WorkItemPriority = 'low' | 'medium' | 'high'

export type WorkItemType =
  | 'plan'
  | 'generate_strategy'
  | 'backtest'
  | 'monitor_review'
  | 'review_daily'
  | 'review_weekly'
  | 'correct'
  | 'data_backfill'
  | 'user_request'

// ---------- Trigger（事件） ----------
export interface Trigger {
  /** 稳定 ID：由来源与业务键派生（幂等；重复接收只入一次） */
  id: string
  type: string
  accountId: string
  payload: Record<string, unknown>
  source: string
  correlationId?: string
  occurredAt: string
  /** 去向（Intake 写入）：stored 待评估 / filtered 被门槛过滤 / ui-only 仅 UI / decided 已决策 */
  disposition?: 'stored' | 'filtered' | 'ui-only' | 'decided'
}

/** 触发源名（Intake 判定 UI-only / 过滤的依据之一） */
export const TRIGGER_SOURCES = ['scheduler', 'user', 'workitem', 'pipeline', 'monitor'] as const
export type TriggerSource = (typeof TRIGGER_SOURCES)[number]

// ---------- Thread（账户事件流） ----------
/** 每账户一个评估线程：Triggers 按时间顺序入队，同一时刻至多一个 Eval 运行 */
export interface Thread {
  /** `account:<accountId>` */
  key: string
  accountId: string
  /** 等待评估的事件批次 */
  queued: Trigger[]
  /** 进行中的评估（串行） */
  eval?: Evaluation
  /** 连续过期次数（超时重排两次后记录 unavailable） */
  expiryStreak: number
  lastTriggerAt: string
}

// ---------- Eval（评估） ----------
export type EvalStatus = 'queued' | 'assessing' | 'decided' | 'unavailable'

export interface Evaluation {
  id: string
  threadKey: string
  triggers: Trigger[]
  /** 批次强度与依据（gate 计算，取最强触发） */
  strength: Strength
  basis: MandateBasis
  status: EvalStatus
  /** 候选是否已送达评估器（送达后才开始计时） */
  delivered: boolean
  deadline: string
}

// ---------- Decision（决策） ----------
export type DecisionOutcome = 'accept' | 'stop' | 'ignore' | 'unavailable'

export interface Decision {
  id: string
  evalId: string
  accountId: string
  outcome: DecisionOutcome
  /** 决策原因（reasons.ts 的 Reason） */
  reason: { code: string; values?: Record<string, string> }
  /** accept 时创建的工作项 */
  workItemIds: string[]
  /** 评估输入快照与输出结论（可回溯「为什么这么做」） */
  inputSnapshot: unknown
  output: unknown
  createdAt: string
}

// ---------- Mandate（工作项授权） ----------
export interface Mandate {
  /** 策略版本（运行模式 + 自主级别；变更不溯及已发授权，恢复前重校验） */
  policyVersion: string
  strength: Strength
  basis: MandateBasis
  /** 发起事件 */
  triggerId: string
  /** 匹配的规则（Daydream 暂无规则集，保留字段供扩展） */
  matchedRules: string[]
}

// ---------- Ticket（工作项） ----------
export interface Ticket {
  id: string
  accountId: string
  type: WorkItemType
  status: WorkItemStatus
  priority: WorkItemPriority
  mandate: Mandate
  /** 任务上下文（关联对象：策略 ID、回测 ID、事件 ID、用户消息等） */
  context: Record<string, unknown>
  attempts: number
  maxAttempts: number
  scheduledAt?: string
  deadline?: string
  result?: Record<string, unknown>
  error?: string
  createdAt: string
  startedAt?: string
  finishedAt?: string
}

/** 工作项是否未结束（open） */
export function isOpenTicket(t: Ticket): boolean {
  return t.status === 'pending' || t.status === 'running' || t.status === 'blocked'
}

/** 工作项是否已结束（ended） */
export function isEndedTicket(t: Ticket): boolean {
  return !isOpenTicket(t)
}

// ---------- Assignment（执行实例：一次尝试） ----------
export type AssignmentOutcome = 'succeeded' | 'failed' | 'cancelled'

export interface Assignment {
  id: string
  ticketId: string
  startedAt: string
  endedAt?: string
  outcome?: AssignmentOutcome
  error?: string
}

// ---------- 域事件（Engine 每次变更后发出，见 ports.ts DomainEvents） ----------
export type DomainEventName =
  | 'trigger.received'
  | 'trigger.filtered'
  | 'eval.started'
  | 'decision.recorded'
  | 'ticket.created'
  | 'ticket.resumed'
  | 'ticket.ended'
  | 'assignment.started'
  | 'assignment.ended'
  | 'trigger.requeued'
  | 'policy.changed'

export interface DomainEvent {
  name: DomainEventName
  accountId: string
  ticketId?: string
  triggerId?: string
  payload?: Record<string, unknown>
  at: string
}

// ---------- 时间与 ID 辅助（核心可用的最小工具集） ----------
/** 当前 ISO 时间（可注入便于测试） */
export const nowIso = (): string => new Date().toISOString()

/** 稳定 ID 派生：相同输入必得相同 ID（幂等键） */
export function keyOf(...parts: string[]): string {
  return parts.map((p) => p.replace(/:/g, '|')).join(':')
}
