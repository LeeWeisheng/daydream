/**
 * Tickets：工作项生命周期（dsh src/core/tickets.ts 的对应）。
 * 规则：
 * - 仅 Eval 接单或宿主显式入队可创建工作项；每个工作项携带 Mandate（授权依据）；
 * - 状态机：pending → running → (succeeded | failed | cancelled)；blocked 为等待人工的中间态；
 * - 重试 = 新 Assignment（attempts 清零）；取消/结束均留档并发出域事件；
 * - 崩溃恢复：可安全重跑的类型重置为 pending，其余标记 failed。
 */
import type { Ticket, WorkItemType } from './model'
import { isEndedTicket } from './model'
import type { CreateTicketOptions } from './ports'
import { EnginePart } from './part'
import { canCancel, canRetry } from './stage'
import { assertUser } from './errors'

/** 可安全重跑的工作项类型（幂等或纯研究类） */
const SAFE_RETRY_TYPES: WorkItemType[] = ['plan', 'generate_strategy', 'backtest', 'review_daily', 'review_weekly', 'data_backfill']

export class Tickets extends EnginePart {
  /** 创建一个工作项（Mandate 由当前策略与触发事件派生） */
  create(options: CreateTicketOptions): Ticket {
    const now = this.now()
    const trigger = options.trigger
    const gate = trigger ? this.policy.gate(trigger) : { strength: 'inferred' as const, basis: 'internal' as const }
    const ticket: Ticket = {
      id: this.newId(),
      accountId: options.accountId,
      type: options.type,
      status: 'pending',
      priority: options.priority ?? 'medium',
      mandate: {
        policyVersion: this.policy.version,
        strength: trigger ? gate.strength : 'inferred',
        basis: trigger ? gate.basis : 'internal',
        triggerId: trigger?.id ?? '',
        matchedRules: []
      },
      context: options.context ?? {},
      attempts: 0,
      maxAttempts: options.maxAttempts ?? 3,
      scheduledAt: options.scheduledAt,
      deadline: options.deadline,
      createdAt: now
    }
    this.repo.atomic(() => this.repo.tickets.add(ticket))
    this.emit({ name: 'ticket.created', accountId: ticket.accountId, ticketId: ticket.id, triggerId: trigger?.id, payload: { type: ticket.type, priority: ticket.priority }, at: now })
    return ticket
  }

  /** 读取一个工作项（不存在时抛固定拒绝） */
  getOrThrow(id: string): Ticket {
    const ticket = this.repo.tickets.get(id)
    assertUser(ticket, 'missing_workitem', { id })
    return ticket
  }

  /** 重试：失败/取消/受阻的工作项重置为 pending（新 Assignment，attempts 清零） */
  retry(id: string): Ticket {
    const ticket = this.getOrThrow(id)
    assertUser(canRetry(ticket), 'not_retryable', { status: ticket.status })
    return this.requeue(ticket, { resetAttempts: true })
  }

  /** 自动重试重入队（attempts 保留，由执行器在 attempts 耗尽时判定失败） */
  requeueAfterFailure(id: string): Ticket {
    const ticket = this.getOrThrow(id)
    assertUser(ticket.status === 'running', 'not_ready', { status: ticket.status })
    return this.requeue(ticket, { resetAttempts: false })
  }

  private requeue(ticket: Ticket, options: { resetAttempts: boolean }): Ticket {
    const now = this.now()
    this.repo.atomic(() => {
      ticket.status = 'pending'
      if (options.resetAttempts) ticket.attempts = 0
      ticket.error = undefined
      ticket.startedAt = undefined
      ticket.finishedAt = undefined
      ticket.scheduledAt = undefined
      this.repo.tickets.save(ticket)
    })
    this.emit({ name: 'ticket.resumed', accountId: ticket.accountId, ticketId: ticket.id, payload: { type: ticket.type }, at: now })
    return ticket
  }

  /** 取消：未结束的工作项标记 cancelled */
  cancel(id: string): Ticket {
    const ticket = this.getOrThrow(id)
    assertUser(canCancel(ticket), 'not_cancellable', { status: ticket.status })
    this.endTicket(ticket, 'cancelled', { error: '人工取消' })
    return ticket
  }

  /** 结束：running/blocked → 终态（成功/失败/取消）；已结束幂等返回（不覆盖终态） */
  end(id: string, outcome: 'succeeded' | 'failed' | 'cancelled', detail?: { result?: Record<string, unknown>; error?: string }): Ticket {
    const ticket = this.getOrThrow(id)
    if (isEndedTicket(ticket)) return ticket
    this.endTicket(ticket, outcome, detail ?? {})
    return ticket
  }

  /** 崩溃恢复：启动时扫描 running 工作项（docs 009 故障恢复的对应） */
  recoverInterrupted(): Ticket[] {
    const running = this.repo.tickets.running()
    const recovered: Ticket[] = []
    for (const ticket of running) {
      if (SAFE_RETRY_TYPES.includes(ticket.type)) {
        this.repo.atomic(() => {
          ticket.status = 'pending'
          ticket.startedAt = undefined
          this.repo.tickets.save(ticket)
        })
        recovered.push(ticket)
      } else {
        this.endTicket(ticket, 'failed', { error: '应用中断，工作项终止（不可安全重跑）' })
      }
    }
    return recovered
  }

  // ---------- 内部 ----------
  private endTicket(ticket: Ticket, outcome: 'succeeded' | 'failed' | 'cancelled', detail: { result?: Record<string, unknown>; error?: string }): void {
    const now = this.now()
    this.repo.atomic(() => {
      ticket.status = outcome
      ticket.result = detail.result
      ticket.error = detail.error
      ticket.finishedAt = now
      this.repo.tickets.save(ticket)
    })
    this.emit({ name: 'ticket.ended', accountId: ticket.accountId, ticketId: ticket.id, payload: { type: ticket.type, outcome, error: detail.error }, at: now })
  }
}
