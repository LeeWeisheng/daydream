/**
 * 端口（Ports）：Engine 只依赖这些窄接口，不依赖任何具体实现。
 * 与 dsh-superagent-prototype 的 src/core/ports.ts 对齐：
 * - Repositories：聚合（Trigger / Ticket / Assignment / Decision）的持久化
 * - Policy：授权与准入规则
 * - Assessor / Executor / Outbox：外部边界（LLM 评估、工作项执行、消息发送）
 * - Emitter：域事件输出
 */
import type { Assignment, Decision, DomainEvent, Trigger, Ticket, WorkItemType } from './model'

// ---------- Policy ----------
export interface PolicyGateResult {
  admitted: boolean
  strength: 'explicit' | 'inferred'
  basis: 'addressed' | 'followup' | 'schedule' | 'internal'
  reasonCode?: string
}

export interface Policy {
  /** 策略版本：运行模式 + 自主级别（Mandate 记录它） */
  version: string
  running: boolean
  /** 接受模式：auto 自动批准 / observe 手动批准（dsh accept mode 的 Daydream 对应） */
  acceptMode: 'auto' | 'observe'
  /** 确定性门槛：事件是否准入、以何强度与依据（两层评估的第一层） */
  gate(trigger: Pick<Trigger, 'type' | 'source'>): PolicyGateResult
  /** 评估失败时按事件类型的降级策略 */
  fallbackFor(type: string): 'no_action' | 'retry_later' | 'direct_accept'
}

// ---------- Repositories ----------
export interface TicketQuery {
  accountId?: string
  status?: Ticket['status'] | Ticket['status'][]
  dueAt?: string
  limit?: number
}

export interface Repositories {
  triggers: {
    add(t: Trigger): void
    has(id: string): boolean
    /** 更新去向（filtered / ui-only 事件的落库标记） */
    markDisposition(id: string, disposition: NonNullable<Trigger['disposition']>): void
    /** 已入库但未决策的事件（重启后重入评估队列） */
    stored(): Trigger[]
  }
  tickets: {
    add(t: Ticket): void
    get(id: string): Ticket | undefined
    save(t: Ticket): void
    /** 到期可执行（pending 且 scheduledAt 已到） */
    due(now: string): Ticket[]
    running(): Ticket[]
    list(query?: TicketQuery): Ticket[]
  }
  assignments: {
    add(a: Assignment): void
    end(id: string, outcome: Assignment['outcome'], error?: string, at?: string): void
    forTicket(ticketId: string): Assignment[]
  }
  decisions: {
    add(d: Decision): void
    list(accountId: string, limit?: number): Decision[]
  }
  /** 读查询（仅读，供上下文组装与界面） */
  read: {
    recentTriggers(accountId: string, limit: number): { type: string; payload: Record<string, unknown>; occurredAt: string }[]
    listTickets(accountId: string, limit?: number): Ticket[]
  }
  /** 事务包装：命令的聚合变更在同一事务内提交 */
  atomic<T>(fn: () => T): T
}

// ---------- 评估器 / 执行器 / 消息出口 ----------
export interface Assessor {
  /** 请求评估一个 Eval（实现侧入队持久化副作用，见 app/effects.ts） */
  request(evalId: string): void
  /** 释放 Eval 的缓存状态 */
  release(evalId: string): void
}

export interface Executor {
  /** 请求启动一个工作项的 Assignment（实现侧入队 launch 副作用） */
  start(ticketId: string): void
}

export interface OutboxMessage {
  id: string
  accountId: string
  role: 'user' | 'assistant'
  content: string
  kind?: string
  meta?: Record<string, unknown>
  ticketId?: string
  reportId?: string
}

export interface Outbox {
  /** 发送一条对话流消息（实现侧先落 receipt 再投递，见 app/outbox.ts） */
  send(message: Omit<OutboxMessage, 'id'> & { id?: string }): void
}

// ---------- 域事件 ----------
export type DomainEventEmitter = (event: DomainEvent) => void

// ---------- Engine 构造依赖 ----------
export interface EngineDeps {
  repo: Repositories
  /** 当前策略的惰性获取（每次使用取最新，策略变更即时生效） */
  policy: () => Policy
  assessor: Assessor
  executor: Executor
  outbox: Outbox
  now?: () => string
  emit?: DomainEventEmitter
  /** 事件 ID 派生（测试注入稳定 ID） */
  newId?: () => string
}

// ---------- 工作项创建（Engine 内部与宿主共用） ----------
export interface CreateTicketOptions {
  accountId: string
  type: WorkItemType
  priority?: Ticket['priority']
  context?: Record<string, unknown>
  scheduledAt?: string
  deadline?: string
  maxAttempts?: number
  /** 触发事件（评估接单时自动填充） */
  trigger?: Trigger
}
