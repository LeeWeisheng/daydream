/**
 * MemoryRepositories：内存版仓储（dsh src/core/memory.ts 的对应），供领域测试使用。
 * 与 Store 的实现保持相同的顺序语义与嵌套回滚（atomic 嵌套时外层回滚全部）。
 */
import type { Assignment, Decision, Ticket, Trigger } from './model'
import type { Repositories, TicketQuery } from './ports'

export class MemoryRepositories implements Repositories {
  private readonly triggerRows = new Map<string, Trigger>()
  private readonly ticketRows = new Map<string, Ticket>()
  private readonly assignmentRows = new Map<string, Assignment>()
  private readonly decisionRows: Decision[] = []
  private txDepth = 0
  private txLog: Array<() => void> = []

  triggers = {
    add: (t: Trigger): void => this.withTx(() => this.triggerRows.set(t.id, structuredClone(t))),
    has: (id: string): boolean => this.triggerRows.has(id),
    markDisposition: (id: string, disposition: NonNullable<Trigger['disposition']>): void => {
      const t = this.triggerRows.get(id)
      if (t) t.disposition = disposition
    },
    stored: (): Trigger[] =>
      Array.from(this.triggerRows.values())
        .filter((t) => t.disposition === 'stored')
        .map((t) => structuredClone(t))
  }

  tickets = {
    add: (t: Ticket): void => this.withTx(() => this.ticketRows.set(t.id, structuredClone(t))),
    get: (id: string): Ticket | undefined => {
      const t = this.ticketRows.get(id)
      return t ? structuredClone(t) : undefined
    },
    save: (t: Ticket): void => this.withTx(() => this.ticketRows.set(t.id, structuredClone(t))),
    due: (now: string): Ticket[] => this.tickets.list({}).filter((t) => t.status === 'pending' && (!t.scheduledAt || t.scheduledAt <= now)),
    running: (): Ticket[] => this.tickets.list({}).filter((t) => t.status === 'running'),
    list: (query: TicketQuery = {}): Ticket[] => {
      let rows = Array.from(this.ticketRows.values())
      if (query.accountId) rows = rows.filter((t) => t.accountId === query.accountId)
      if (query.status) {
        const statuses = Array.isArray(query.status) ? query.status : [query.status]
        rows = rows.filter((t) => statuses.includes(t.status))
      }
      rows = rows.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
      if (query.limit) rows = rows.slice(-query.limit)
      return rows.map((t) => structuredClone(t))
    }
  }

  assignments = {
    add: (a: Assignment): void => this.withTx(() => this.assignmentRows.set(a.id, structuredClone(a))),
    end: (id: string, outcome: Assignment['outcome'], error?: string, at = new Date().toISOString()): void => {
      const a = this.assignmentRows.get(id)
      if (a) {
        a.outcome = outcome
        a.error = error
        a.endedAt = at
      }
    },
    forTicket: (ticketId: string): Assignment[] => Array.from(this.assignmentRows.values()).filter((a) => a.ticketId === ticketId)
  }

  decisions = {
    add: (d: Decision): void => this.withTx(() => this.decisionRows.push(structuredClone(d))),
    list: (accountId: string, limit = 100): Decision[] =>
      this.decisionRows
        .filter((d) => d.accountId === accountId)
        .slice(-limit)
        .map((d) => structuredClone(d))
  }

  read = {
    recentTriggers: (accountId: string, limit: number): { type: string; payload: Record<string, unknown>; occurredAt: string }[] =>
      Array.from(this.triggerRows.values())
        .filter((t) => t.accountId === accountId)
        .sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : -1))
        .slice(0, limit)
        .map((t) => ({ type: t.type, payload: t.payload, occurredAt: t.occurredAt })),
    listTickets: (accountId: string, limit = 200): Ticket[] => this.tickets.list({ accountId, limit })
  }

  atomic<T>(fn: () => T): T {
    this.txDepth += 1
    const checkpoint = this.txLog.length
    if (this.txDepth === 1) this.txLog = []
    try {
      const result = fn()
      if (this.txDepth === 1) this.txLog.forEach((op) => op())
      return result
    } catch (e) {
      this.txLog.length = checkpoint
      throw e
    } finally {
      this.txDepth -= 1
    }
  }

  /** 事务内暂存写操作，提交时按序重放（嵌套事务失败时丢弃） */
  private withTx(op: () => void): void {
    if (this.txDepth > 0) {
      this.txLog.push(op)
    } else {
      op()
    }
  }
}
