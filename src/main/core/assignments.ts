/**
 * Assignments：执行器报告的事实（dsh src/core/assignments.ts 的对应）。
 * 命令用祈使命名（retryTicket），事实用过去式命名（assignmentStarted / assignmentEnded）。
 * 事实只记录已经发生的事，不做重试判断（重试由 Tickets 部分决定）。
 */
import type { Assignment, Ticket } from './model'
import { EnginePart } from './part'
import { assertUser } from './errors'

export class Assignments extends EnginePart {
  /** 一个 Assignment 已启动：工作项进入 running，attempts +1，落执行实例 */
  assignmentStarted(ticketId: string): Assignment {
    const ticket = this.requireOpenTicket(ticketId)
    const now = this.now()
    const assignment: Assignment = { id: this.newId(), ticketId, startedAt: now }
    this.repo.atomic(() => {
      ticket.status = 'running'
      ticket.attempts += 1
      ticket.startedAt = now
      this.repo.tickets.save(ticket)
      this.repo.assignments.add(assignment)
    })
    this.emit({ name: 'assignment.started', accountId: ticket.accountId, ticketId, payload: { assignmentId: assignment.id, attempt: ticket.attempts }, at: now })
    return assignment
  }

  /** 一个 Assignment 已结束（成功/失败/取消）：记录结果，工作项状态由调用方决定 */
  assignmentEnded(assignmentId: string, outcome: Assignment['outcome'], error?: string): void {
    const now = this.now()
    this.repo.atomic(() => {
      this.repo.assignments.end(assignmentId, outcome, error, now)
    })
    this.emit({ name: 'assignment.ended', accountId: '', payload: { assignmentId, outcome, error }, at: now })
  }

  // ---------- 内部 ----------
  private requireOpenTicket(ticketId: string): Ticket {
    const ticket = this.repo.tickets.get(ticketId)
    assertUser(ticket, 'missing_workitem', { id: ticketId })
    assertUser(ticket.status === 'pending', 'not_ready', { status: ticket.status })
    return ticket
  }
}
