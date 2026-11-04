/**
 * 对话流服务：首页左列对话流持久化（chat_message）与事件推送。
 * 适配 Claude Code 全部消息格式（text/thinking/tool_use/tool_result/system/result 等，
 * 见 messageSink.ts 归一化），用户消息、Agent 回复、Agent 汇报统一进入对话流。
 * 运行细节（工具调用/思考/系统消息）默认折叠，仅主要结果（result/error/report/用户消息）触发 UI 刷新事件。
 */
import { randomUUID } from 'node:crypto'
import type { ChatMessage, ChatMessageKind, ReportLevel } from '@shared/types'
import { nowIso, queryAll, run } from './db'
import { agentEventBus } from './agent/events'
import { audit } from './services/audit'

/** 主要消息类型：渲染为主气泡并触发 UI 事件 */
export const MAIN_CHAT_KINDS: ReadonlySet<string> = new Set(['text', 'result', 'error', 'report'])

export interface ChatMessageInput {
  accountId: string
  role: 'user' | 'assistant'
  content: string
  kind?: ChatMessageKind
  /** 元数据（工具名/入参/耗时等），JSON 字符串 */
  metaJson?: string
  workItemId?: string
  sessionId?: string
  reportId?: string
  reportLevel?: ReportLevel
  reportStatus?: string
}

/** 写入对话流；主要消息推送 chat.message 事件，运行细节不推送（避免事件风暴） */
export function addChatMessage(input: ChatMessageInput): ChatMessage {
  const id = randomUUID()
  const now = nowIso()
  const kind = input.kind ?? (input.role === 'user' ? 'text' : 'text')
  const { lastInsertRowid } = run(
    'INSERT INTO chat_message (id, account_id, role, content, kind, meta_json, work_item_id, session_id, report_id, report_level, report_status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [
      id,
      input.accountId,
      input.role,
      input.content,
      kind,
      input.metaJson ?? null,
      input.workItemId ?? null,
      input.sessionId ?? null,
      input.reportId ?? null,
      input.reportLevel ?? null,
      input.reportStatus ?? null,
      now
    ]
  )
  if (MAIN_CHAT_KINDS.has(kind)) {
    agentEventBus.emitAgentEvent('chat.message', input.accountId, { messageId: id, role: input.role, kind, reportId: input.reportId }, { debounceMs: 1000 })
  }
  return {
    id,
    accountId: input.accountId,
    role: input.role,
    content: input.content,
    kind,
    rowid: Number(lastInsertRowid),
    metaJson: input.metaJson,
    workItemId: input.workItemId,
    sessionId: input.sessionId,
    reportId: input.reportId,
    reportLevel: input.reportLevel,
    reportStatus: input.reportStatus,
    createdAt: now
  }
}

export function listChatMessages(accountId: string, opts: { limit?: number; before?: ChatCursor; after?: ChatCursor } = {}): ChatPage {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500)
  const baseSelect = `SELECT id, account_id as accountId, role, content, kind, rowid,
            meta_json as metaJson, work_item_id as workItemId, session_id as sessionId,
            report_id as reportId, report_level as reportLevel, report_status as reportStatus,
            created_at as createdAt
     FROM chat_message`

  if (opts.after) {
    // 增量拉取：比 after 游标更新的消息（正序返回）
    const rows = queryAll<Record<string, unknown>>(
      `${baseSelect} WHERE account_id = ? AND (created_at > ? OR (created_at = ? AND rowid > ?))
       ORDER BY created_at ASC, rowid ASC LIMIT ?`,
      [accountId, opts.after.createdAt, opts.after.createdAt, opts.after.rowid, limit]
    )
    return { messages: rows.map(mapChatRow), hasMore: false }
  }

  if (opts.before) {
    // 向上翻页：比 before 游标更早的消息（倒序取 limit+1 判 hasMore，再反转为正序）
    const rows = queryAll<Record<string, unknown>>(
      `${baseSelect} WHERE account_id = ? AND (created_at < ? OR (created_at = ? AND rowid < ?))
       ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      [accountId, opts.before.createdAt, opts.before.createdAt, opts.before.rowid, limit + 1]
    )
    const hasMore = rows.length > limit
    return { messages: rows.slice(0, limit).reverse().map(mapChatRow), hasMore }
  }

  // 最新一页
  const rows = queryAll<Record<string, unknown>>(
    `${baseSelect} WHERE account_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    [accountId, limit + 1]
  )
  const hasMore = rows.length > limit
  return { messages: rows.slice(0, limit).reverse().map(mapChatRow), hasMore }
}

/** 分页游标（createdAt + rowid，同一时间戳多条消息时精确分页） */
export interface ChatCursor {
  createdAt: string
  rowid: number
}

export interface ChatPage {
  messages: ChatMessage[]
  hasMore: boolean
}

function mapChatRow(r: Record<string, unknown>): ChatMessage {
  return {
    id: String(r.id),
    accountId: String(r.accountId),
    role: r.role as 'user' | 'assistant',
    content: String(r.content),
    kind: (r.kind as ChatMessageKind) ?? 'text',
    rowid: Number(r.rowid),
    metaJson: r.metaJson !== undefined && r.metaJson !== null ? String(r.metaJson) : undefined,
    workItemId: r.workItemId !== undefined && r.workItemId !== null ? String(r.workItemId) : undefined,
    sessionId: r.sessionId !== undefined && r.sessionId !== null ? String(r.sessionId) : undefined,
    reportId: r.reportId !== undefined && r.reportId !== null ? String(r.reportId) : undefined,
    reportLevel: r.reportLevel ? (r.reportLevel as ReportLevel) : undefined,
    reportStatus: r.reportStatus ? String(r.reportStatus) : undefined,
    createdAt: String(r.createdAt)
  }
}

/** 同步对话流中关联汇报的状态（决策响应后） */
export function syncChatReportStatus(reportId: string, status: string): void {
  run('UPDATE chat_message SET report_status = ? WHERE report_id = ?', [status, reportId])
}

/** 汇报内容格式化为对话消息文本 */
export function formatReportContent(title: string, summary: string, level: ReportLevel): string {
  const levelLabel = level === 'need_decision' ? '待决策' : level === 'result' ? '结果' : '摘要'
  return `【${levelLabel}】${title}\n${summary}`
}

/** 对话消息审计（可选） */
export function auditChat(accountId: string, action: string, detail: Record<string, unknown>): void {
  audit({ accountId, actor: 'user', action, detail })
}
