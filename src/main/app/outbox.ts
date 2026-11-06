/**
 * Outbox：对话流消息的出口（dsh src/app/outbox.ts 的对应）。
 * 规则：
 * - chat_message 的唯一写者（dsh「one writer per state」：Engine 的消息与业务服务的消息都经 send）；
 * - send 先落 receipt（effect 行，kind='reply'），事务提交后由 effect 处理器投递，
 *   失败指数退避重试——消息「先存后发」，不会丢；
 * - 主要消息（result/error/report/用户消息）投递时推送 chat.message 事件，
 *   运行细节（思考/工具调用）不推送（避免事件风暴）。
 */
import type { Outbox as OutboxPort } from '../core/ports'
import { effects } from './effects'
import { uiBus } from './events'
import { getDb, nowIso } from '../db/connection'
import { randomUUID } from 'node:crypto'

/** 主要消息类型：渲染为主气泡并触发 UI 事件 */
export const MAIN_CHAT_KINDS: ReadonlySet<string> = new Set(['text', 'result', 'error', 'report'])

export interface ChatMessageInput {
  accountId: string
  role: 'user' | 'assistant'
  content: string
  kind?: string
  /** 元数据（工具名/入参/耗时等） */
  meta?: Record<string, unknown>
  workItemId?: string
  sessionId?: string
  reportId?: string
  reportLevel?: string
  reportStatus?: string
}

export interface ChatMessage {
  id: string
  accountId: string
  role: 'user' | 'assistant'
  content: string
  kind: string
  rowid: number
  metaJson?: string
  workItemId?: string
  sessionId?: string
  reportId?: string
  reportLevel?: string
  reportStatus?: string
  createdAt: string
}

/** 同步对话流中关联汇报的状态（决策响应后）。chat_message 的唯一写者包含状态同步（同一模块，不另设写者）。 */
export function syncReportStatus(reportId: string, status: string): void {
  getDb().prepare('UPDATE chat_message SET report_status = ? WHERE report_id = ?').run(status, reportId)
}

/** 实现 Engine 的 Outbox 端口 */
export const outbox: OutboxPort = {
  send(message): void {
    effects.enqueue('reply', message.id ?? `msg:${randomUUID()}`, { ...message, id: message.id ?? randomUUID() })
    // 低延迟：立即处理到期行（同一队列保证顺序）
    void effects.processAll()
  }
}

/** 投递一条对话流消息（effect 处理器调用）：写 chat_message 并推送 UI 事件 */
export function deliverChatMessage(input: ChatMessageInput & { id: string }): ChatMessage {
  const now = nowIso()
  const kind = input.kind ?? 'text'
  const db = getDb()
  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO chat_message (id, account_id, role, content, kind, meta_json, work_item_id, session_id, report_id, report_level, report_status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.id,
      input.accountId,
      input.role,
      input.content,
      kind,
      input.meta ? JSON.stringify(input.meta) : null,
      input.workItemId ?? null,
      input.sessionId ?? null,
      input.reportId ?? null,
      input.reportLevel ?? null,
      input.reportStatus ?? null,
      now
    )
  const message: ChatMessage = {
    id: input.id,
    accountId: input.accountId,
    role: input.role,
    content: input.content,
    kind,
    rowid: Number(lastInsertRowid),
    metaJson: input.meta ? JSON.stringify(input.meta) : undefined,
    workItemId: input.workItemId,
    sessionId: input.sessionId,
    reportId: input.reportId,
    reportLevel: input.reportLevel,
    reportStatus: input.reportStatus,
    createdAt: now
  }
  if (MAIN_CHAT_KINDS.has(kind)) {
    uiBus.broadcast('chat.message', {
      accountId: input.accountId,
      messageId: input.id,
      role: input.role,
      kind,
      reportId: input.reportId
    })
  }
  return message
}
