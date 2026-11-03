/**
 * Agent 会话：消息历史持久化（agent_message 表），崩溃后可恢复续跑。
 * 每个工作项在独立会话中执行（对齐 dsh-superagent 隔离工作会话）。
 */
import type { AgentMessage } from '@shared/types'
import { getDb, nowIso, queryAll } from '../db'

export interface SessionMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
}

export function createSession(workItemId?: string): string {
  const sessionId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  if (workItemId) {
    getDb().prepare('UPDATE work_item SET session_id = ? WHERE id = ?').run(sessionId, workItemId)
  }
  return sessionId
}

export function appendMessage(sessionId: string, workItemId: string | undefined, msg: SessionMessage): void {
  getDb()
    .prepare('INSERT INTO agent_message (session_id, work_item_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(sessionId, workItemId ?? null, msg.role, msg.content, nowIso())
}

export function appendToolMessage(sessionId: string, workItemId: string | undefined, role: 'assistant' | 'tool', content: string, toolCallsJson?: string, toolResultsJson?: string): void {
  getDb()
    .prepare('INSERT INTO agent_message (session_id, work_item_id, role, content, tool_calls_json, tool_results_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(sessionId, workItemId ?? null, role, content, toolCallsJson ?? null, toolResultsJson ?? null, nowIso())
}

export function loadMessages(sessionId: string): AgentMessage[] {
  return queryAll<AgentMessage>(
    'SELECT id, session_id as sessionId, work_item_id as workItemId, role, content, tool_calls_json as toolCallsJson, tool_results_json as toolResultsJson, created_at as createdAt FROM agent_message WHERE session_id = ? ORDER BY id ASC',
    [sessionId]
  )
}
