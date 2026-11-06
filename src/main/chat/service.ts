/**
 * 对话流服务（Chat）：首页左列对话流的读写。
 * 写入经 Outbox（先存后发，单写者）；读取提供游标分页（createdAt + rowid）。
 */
import { getDb } from '../db/connection'
import { outbox, syncReportStatus, type ChatMessage, type ChatMessageInput } from '../app/outbox'

export { syncReportStatus }

export interface ChatCursor {
  createdAt: string
  rowid: number
}

export interface ChatPage {
  messages: ChatMessage[]
  hasMore: boolean
}

/** 发送一条对话流消息（经 Outbox，先落 receipt 再投递） */
export function addChatMessage(input: ChatMessageInput & { id?: string }): void {
  outbox.send(input)
}

export function listChatMessages(accountId: string, opts: { limit?: number; before?: ChatCursor; after?: ChatCursor } = {}): ChatPage {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500)
  const db = getDb()
  const baseSelect = `SELECT id, account_id as accountId, role, content, kind, rowid,
            meta_json as metaJson, work_item_id as workItemId, session_id as sessionId,
            report_id as reportId, report_level as reportLevel, report_status as reportStatus,
            created_at as createdAt
     FROM chat_message`

  if (opts.after) {
    const rows = db
      .prepare(
        `${baseSelect} WHERE account_id = ? AND (created_at > ? OR (created_at = ? AND rowid > ?))
         ORDER BY created_at ASC, rowid ASC LIMIT ?`
      )
      .all(accountId, opts.after.createdAt, opts.after.createdAt, opts.after.rowid, limit) as Record<string, unknown>[]
    return { messages: rows.map(mapChatRow), hasMore: false }
  }

  if (opts.before) {
    const rows = db
      .prepare(
        `${baseSelect} WHERE account_id = ? AND (created_at < ? OR (created_at = ? AND rowid < ?))
         ORDER BY created_at DESC, rowid DESC LIMIT ?`
      )
      .all(accountId, opts.before.createdAt, opts.before.createdAt, opts.before.rowid, limit + 1) as Record<string, unknown>[]
    const hasMore = rows.length > limit
    return { messages: rows.slice(0, limit).reverse().map(mapChatRow), hasMore }
  }

  const rows = db.prepare(`${baseSelect} WHERE account_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`).all(accountId, limit + 1) as Record<string, unknown>[]
  const hasMore = rows.length > limit
  return { messages: rows.slice(0, limit).reverse().map(mapChatRow), hasMore }
}

/** 汇报内容格式化为对话消息文本 */
export function formatReportContent(title: string, summary: string, level: string): string {
  const levelLabel = level === 'need_decision' ? '待决策' : level === 'result' ? '结果' : '摘要'
  return `【${levelLabel}】${title}\n${summary}`
}

function mapChatRow(r: Record<string, unknown>): ChatMessage {
  return {
    id: String(r.id),
    accountId: String(r.accountId),
    role: r.role as 'user' | 'assistant',
    content: String(r.content),
    kind: String(r.kind ?? 'text'),
    rowid: Number(r.rowid),
    metaJson: r.metaJson !== undefined && r.metaJson !== null ? String(r.metaJson) : undefined,
    workItemId: r.workItemId !== undefined && r.workItemId !== null ? String(r.workItemId) : undefined,
    sessionId: r.sessionId !== undefined && r.sessionId !== null ? String(r.sessionId) : undefined,
    reportId: r.reportId !== undefined && r.reportId !== null ? String(r.reportId) : undefined,
    reportLevel: r.reportLevel ? String(r.reportLevel) : undefined,
    reportStatus: r.reportStatus ? String(r.reportStatus) : undefined,
    createdAt: String(r.createdAt)
  }
}
