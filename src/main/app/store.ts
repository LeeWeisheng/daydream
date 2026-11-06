/**
 * Store：领域仓储（Repositories 的 SQLite 实现）+ 读查询（dsh src/app/store.ts 的对应）。
 * 规则（dsh「one writer per state」）：
 * - Trigger / Ticket / Assignment / Decision 由 Engine 写入（经本仓储）；
 * - 业务表（策略/资金/信号等）由各自服务写入，本模块提供读查询；
 * - 生成列与索引见 db/schema.ts；事务经 atomic 包装（与 better-sqlite3 同步 API 兼容）。
 */
import type { Database } from 'better-sqlite3'
import type { Assignment, Decision, Ticket, Trigger } from '../core/model'
import type { Repositories, TicketQuery } from '../core/ports'

let conn: Database | null = null

/** 打开数据库后初始化（db/connection.ts 调用） */
export function initStore(db: Database): void {
  conn = db
}

function db(): Database {
  if (!conn) throw new Error('store not initialized')
  return conn
}

// ---------- 行映射 ----------
interface TicketRow {
  id: string
  account_id: string
  type: string
  status: string
  priority: string
  context_json: string
  mandate_json: string | null
  attempts: number
  max_attempts: number
  scheduled_at: string | null
  deadline: string | null
  result_json: string | null
  error: string | null
  created_at: string
  started_at: string | null
  finished_at: string | null
}

function rowToTicket(r: TicketRow): Ticket {
  return {
    id: r.id,
    accountId: r.account_id,
    type: r.type as Ticket['type'],
    status: r.status as Ticket['status'],
    priority: r.priority as Ticket['priority'],
    mandate: r.mandate_json ? safeParse(r.mandate_json, { policyVersion: '', strength: 'inferred', basis: 'internal', triggerId: '', matchedRules: [] }) : { policyVersion: '', strength: 'inferred', basis: 'internal', triggerId: '', matchedRules: [] },
    context: safeParse(r.context_json, {}),
    attempts: r.attempts,
    maxAttempts: r.max_attempts,
    scheduledAt: r.scheduled_at ?? undefined,
    deadline: r.deadline ?? undefined,
    result: r.result_json ? safeParse(r.result_json, {}) : undefined,
    error: r.error ?? undefined,
    createdAt: r.created_at,
    startedAt: r.started_at ?? undefined,
    finishedAt: r.finished_at ?? undefined
  }
}

const TICKET_COLUMNS = `id, account_id, type, status, priority, context_json, mandate_json, attempts, max_attempts,
  scheduled_at, deadline, result_json, error, created_at, started_at, finished_at`

function ticketToRow(t: Ticket): TicketRow {
  return {
    id: t.id,
    account_id: t.accountId,
    type: t.type,
    status: t.status,
    priority: t.priority,
    context_json: JSON.stringify(t.context),
    mandate_json: JSON.stringify(t.mandate),
    attempts: t.attempts,
    max_attempts: t.maxAttempts,
    scheduled_at: t.scheduledAt ?? null,
    deadline: t.deadline ?? null,
    result_json: t.result ? JSON.stringify(t.result) : null,
    error: t.error ?? null,
    created_at: t.createdAt,
    started_at: t.startedAt ?? null,
    finished_at: t.finishedAt ?? null
  }
}

function safeParse<T>(json: string, fallback: T): T {
  try {
    return JSON.parse(json) as T
  } catch {
    return fallback
  }
}

// ---------- 仓储实现 ----------
export const store: Repositories = {
  triggers: {
    add(t: Trigger): void {
      db()
        .prepare(
          `INSERT INTO event_log (trigger_id, account_id, type, payload_json, source, correlation_id, occurred_at, disposition)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(t.id, t.accountId, t.type, JSON.stringify(t.payload), t.source, t.correlationId ?? null, t.occurredAt, t.disposition ?? 'stored')
    },
    has(id: string): boolean {
      return db().prepare('SELECT 1 FROM event_log WHERE trigger_id = ?').get(id) !== undefined
    },
    markDisposition(id: string, disposition: NonNullable<Trigger['disposition']>): void {
      db().prepare('UPDATE event_log SET disposition = ? WHERE trigger_id = ?').run(disposition, id)
    },
    stored(): Trigger[] {
      const rows = db()
        .prepare("SELECT trigger_id, account_id, type, payload_json, source, correlation_id, occurred_at FROM event_log WHERE disposition = 'stored' ORDER BY id ASC")
        .all() as Array<{
        trigger_id: string
        account_id: string
        type: string
        payload_json: string
        source: string
        correlation_id: string | null
        occurred_at: string
      }>
      return rows.map((r) => ({
        id: r.trigger_id,
        accountId: r.account_id,
        type: r.type,
        payload: safeParse(r.payload_json, {}),
        source: r.source,
        correlationId: r.correlation_id ?? undefined,
        occurredAt: r.occurred_at,
        disposition: 'stored'
      }))
    }
  },

  tickets: {
    add(t: Ticket): void {
      const r = ticketToRow(t)
      db()
        .prepare(
          `INSERT INTO work_item (id, account_id, type, status, priority, context_json, mandate_json, attempts, max_attempts, scheduled_at, deadline, result_json, error, created_at, started_at, finished_at)
           VALUES (@id, @account_id, @type, @status, @priority, @context_json, @mandate_json, @attempts, @max_attempts, @scheduled_at, @deadline, @result_json, @error, @created_at, @started_at, @finished_at)`
        )
        .run(r)
    },
    get(id: string): Ticket | undefined {
      const row = db().prepare(`SELECT ${TICKET_COLUMNS} FROM work_item WHERE id = ?`).get(id) as TicketRow | undefined
      return row ? rowToTicket(row) : undefined
    },
    save(t: Ticket): void {
      const r = ticketToRow(t)
      db()
        .prepare(
          `UPDATE work_item SET account_id=@account_id, type=@type, status=@status, priority=@priority, context_json=@context_json,
             mandate_json=@mandate_json, attempts=@attempts, max_attempts=@max_attempts, scheduled_at=@scheduled_at, deadline=@deadline,
             result_json=@result_json, error=@error, created_at=@created_at, started_at=@started_at, finished_at=@finished_at
           WHERE id=@id`
        )
        .run(r)
    },
    due(now: string): Ticket[] {
      const rows = db()
        .prepare(
          `SELECT ${TICKET_COLUMNS} FROM work_item WHERE status = 'pending' AND (scheduled_at IS NULL OR scheduled_at <= ?)
           ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, created_at ASC LIMIT 50`
        )
        .all(now) as TicketRow[]
      return rows.map(rowToTicket)
    },
    running(): Ticket[] {
      const rows = db().prepare(`SELECT ${TICKET_COLUMNS} FROM work_item WHERE status = 'running'`).all() as TicketRow[]
      return rows.map(rowToTicket)
    },
    list(query: TicketQuery = {}): Ticket[] {
      const clauses: string[] = []
      const params: unknown[] = []
      if (query.accountId) {
        clauses.push('account_id = ?')
        params.push(query.accountId)
      }
      if (query.status) {
        const statuses = Array.isArray(query.status) ? query.status : [query.status]
        clauses.push(`status IN (${statuses.map(() => '?').join(',')})`)
        params.push(...statuses)
      }
      const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
      const rows = db()
        .prepare(`SELECT ${TICKET_COLUMNS} FROM work_item ${where} ORDER BY created_at DESC LIMIT ?`)
        .all(...params, query.limit ?? 200) as TicketRow[]
      return rows.map(rowToTicket)
    }
  },

  assignments: {
    add(a: Assignment): void {
      db()
        .prepare('INSERT INTO work_item_assignment (id, ticket_id, started_at) VALUES (?, ?, ?)')
        .run(a.id, a.ticketId, a.startedAt)
    },
    end(id: string, outcome: Assignment['outcome'], error?: string, at = new Date().toISOString()): void {
      db().prepare('UPDATE work_item_assignment SET ended_at = ?, outcome = ?, error = ? WHERE id = ?').run(at, outcome, error ?? null, id)
    },
    forTicket(ticketId: string): Assignment[] {
      const rows = db()
        .prepare('SELECT id, ticket_id as ticketId, started_at as startedAt, ended_at as endedAt, outcome, error FROM work_item_assignment WHERE ticket_id = ? ORDER BY started_at ASC')
        .all(ticketId) as Assignment[]
      return rows
    }
  },

  decisions: {
    add(d: Decision): void {
      db()
        .prepare(
          `INSERT INTO decision_record (account_id, work_item_id, event_id, input_snapshot_json, output_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(d.accountId, d.workItemIds[0] ?? null, d.evalId, JSON.stringify(d.inputSnapshot ?? {}), JSON.stringify(d.output ?? {}), d.createdAt)
    },
    list(accountId: string, limit = 100): Decision[] {
      const rows = db()
        .prepare(
          `SELECT id, account_id as accountId, work_item_id as workItemId, event_id as evalId,
             input_snapshot_json as inputSnapshot, output_json as output, created_at as createdAt
           FROM decision_record WHERE account_id = ? ORDER BY id DESC LIMIT ?`
        )
        .all(accountId, limit) as Array<{
        id: number
        accountId: string
        workItemId: string | null
        evalId: string
        inputSnapshot: string
        output: string
        createdAt: string
      }>
      return rows.map((r) => ({
        id: String(r.id),
        evalId: r.evalId,
        accountId: r.accountId,
        outcome: 'ignore',
        reason: { code: 'recorded' },
        workItemIds: r.workItemId ? [r.workItemId] : [],
        inputSnapshot: safeParse(r.inputSnapshot, {}),
        output: safeParse(r.output, {}),
        createdAt: r.createdAt
      }))
    }
  },

  read: {
    recentTriggers(accountId: string, limit: number): { type: string; payload: Record<string, unknown>; occurredAt: string }[] {
      const rows = db()
        .prepare('SELECT type, payload_json, occurred_at FROM event_log WHERE account_id = ? ORDER BY id DESC LIMIT ?')
        .all(accountId, limit) as Array<{ type: string; payload_json: string; occurred_at: string }>
      return rows.map((r) => ({ type: r.type, payload: safeParse(r.payload_json, {}), occurredAt: r.occurred_at }))
    },
    listTickets(accountId: string, limit = 200): Ticket[] {
      return store.tickets.list({ accountId, limit })
    }
  },

  atomic<T>(fn: () => T): T {
    return db().transaction(fn)()
  }
}
