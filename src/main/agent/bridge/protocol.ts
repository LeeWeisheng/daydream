/**
 * LLM 桥接协议（主进程 ↔ 桥接子进程的 JSON 行协议，双方共用）。
 * 每行一个 JSON：
 * - 主进程 → 子进程：{id, method: 'init'|'structuredOutput'|'agentTurn', params}
 * - 子进程 → 主进程：{id, ok, data?} | {id, ok:false, error}
 * - 子进程 → 主进程：{method:'toolCall', params:{toolCallId, tool, args}}（主进程执行后回 {id:toolCallId, ok, data|error}）
 * - 子进程 → 主进程：{method:'agentMessage', params:{accountId, workItemId, purpose, msg}}（SDK 消息流转发）
 */

export interface BridgeRequest {
  id: string
  method: 'init' | 'structuredOutput' | 'agentTurn'
  params: Record<string, unknown>
}

export interface BridgeResponse {
  id: string
  ok: boolean
  data?: unknown
  error?: string
}

export interface BridgeNotification {
  method: 'toolCall' | 'agentMessage'
  params: Record<string, unknown>
}

export interface BridgeStructuredParams {
  accountId: string
  system: string
  prompt: string
  jsonSchema: Record<string, unknown>
  purpose: string
  useProModel?: boolean
  /** 关联工作项（消息流分组） */
  workItemId?: string
}

export interface BridgeAgentTurnParams {
  accountId: string
  system: string
  prompt: string
  purpose: string
  maxSteps?: number
  useProModel?: boolean
  /** 关联工作项（消息流分组） */
  workItemId?: string
}

export interface BridgeModelUsage {
  inputTokens?: number
  outputTokens?: number
  [key: string]: unknown
}

export interface StructuredOutputResult {
  structuredOutput?: unknown
  result: string
  modelUsage?: BridgeModelUsage
}

export interface AgentTurnResult {
  result: string
  modelUsage?: BridgeModelUsage
}
