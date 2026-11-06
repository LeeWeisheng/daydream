/**
 * Claude Code（claude-agent-sdk）消息归一化：把 SDK 全部消息格式映射为首页对话流消息。
 * - assistant（text/thinking/tool_use 内容块）、user（tool_result 内容块）→ 运行细节（折叠）
 * - result（success/error）→ 主要结果
 * - system（权限/提示等）→ 系统细节；init/session_ready 等噪声丢弃
 * - stream_event（增量流）、thinking_tokens、后台任务等高频噪声 → 丢弃
 */
import type { ChatMessageKind } from '@shared/types'
import { addChatMessage } from '../chat/service'
import { logger } from '../services/logger'

const MAX_CONTENT_LEN = 4000 // 细节内容截断上限（防大结果撑爆 DB）

function truncate(text: string, limit = MAX_CONTENT_LEN): string {
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}…（已截断，共 ${text.length} 字符）`
}

function str(v: unknown): string {
  if (typeof v === 'string') return v
  if (v === undefined || v === null) return ''
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

/** 工具结果内容块 → 文本（Anthropic tool_result content 为 string 或块数组） */
function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (typeof c === 'string') return c
        if (c && typeof c === 'object' && 'text' in (c as Record<string, unknown>)) return String((c as Record<string, unknown>).text)
        return str(c)
      })
      .join('\n')
  }
  return str(content)
}

/** 噪声系统消息：初始化/会话就绪等纯噪声，不进入对话流 */
const NOISE_SYSTEM_SUBTYPES = new Set([
  'init',
  'session_ready',
  'session_state_changed',
  'background_tasks_changed',
  'commands_changed',
  'thinking_tokens',
  'compact_boundary',
  'auth_status',
  'worker_shutting_down'
])

interface Normalized {
  role: 'user' | 'assistant'
  kind: ChatMessageKind
  content: string
  metaJson?: string
  sessionId?: string
}

/**
 * 归一化一条 SDK 消息 → 对话流消息（或 null 表示丢弃）。
 * raw 为 SDKMessage 的 JSON 序列化形态（消息流中除 result 外的每条消息）。
 */
export function normalizeSdkMessage(raw: Record<string, unknown>): Normalized | null {
  const type = String(raw.type ?? '')
  const sessionId = typeof raw.session_id === 'string' ? raw.session_id : undefined

  switch (type) {
    case 'assistant': {
      // Claude Messages API assistant 消息：content 为内容块数组
      const message = raw.message as { content?: unknown; error?: unknown } | undefined
      if (message?.error) {
        return { role: 'assistant', kind: 'system', content: `[API 错误] ${str(message.error)}`, metaJson: JSON.stringify({ error: message.error }), sessionId }
      }
      const blocks = Array.isArray(message?.content) ? (message.content as Record<string, unknown>[]) : []
      if (blocks.length === 0) return null
      // 多块消息：仅取第一块语义最强者？逐块记录（每块一条细节）
      const first = blocks[0]
      if (blocks.length === 1) {
        return normalizeBlock(first, sessionId)
      }
      // 多块：text 块为主内容，其余为细节
      const textBlock = blocks.find((b) => b.type === 'text')
      if (textBlock && blocks.length > 1) {
        return normalizeBlock(textBlock, sessionId)
      }
      return normalizeBlock(first, sessionId)
    }

    case 'user': {
      // user 消息：content 为 string 或内容块数组（tool_result / text）
      const message = raw.message as { content?: unknown; isSynthetic?: boolean } | undefined
      if (message?.isSynthetic) return null // 合成消息（元提示）不入对话流
      if (typeof message?.content === 'string') {
        // 用户文本（一般为回显/权限回复）；不展示回显
        return null
      }
      const blocks = Array.isArray(message?.content) ? (message.content as Record<string, unknown>[]) : []
      for (const b of blocks) {
        if (b.type === 'tool_result') {
          return {
            role: 'assistant',
            kind: 'tool_result',
            content: truncate(toolResultText(b.content)),
            metaJson: JSON.stringify({ toolUseId: b.tool_use_id }),
            sessionId
          }
        }
      }
      return null
    }

    case 'result': {
      const subtype = String(raw.subtype ?? '')
      if (subtype === 'success') {
        return {
          role: 'assistant',
          kind: 'result',
          content: str(raw.result),
          metaJson: JSON.stringify({ durationMs: raw.duration_ms, modelUsage: raw.modelUsage }),
          sessionId
        }
      }
      // 各种 error 子类型 / is_error
      return {
        role: 'assistant',
        kind: 'error',
        content: raw.is_error === true ? str(raw.result) : `${subtype}: ${str(raw.result ?? '')}`.trim(),
        metaJson: JSON.stringify({ subtype }),
        sessionId
      }
    }

    case 'system': {
      const subtype = String(raw.subtype ?? '')
      if (NOISE_SYSTEM_SUBTYPES.has(subtype)) return null
      return { role: 'assistant', kind: 'system', content: `[系统 ${subtype}] ${str(extractSystemText(raw)).slice(0, 500)}`, metaJson: JSON.stringify({ subtype }), sessionId }
    }

    case 'tool_progress': {
      const heartbeat = raw.heartbeat === true
      if (heartbeat) return null
      return {
        role: 'assistant',
        kind: 'tool_progress',
        content: `工具 ${str(raw.tool_name)} 执行中（${Number(raw.elapsed_time_seconds ?? 0).toFixed(0)}s）`,
        metaJson: JSON.stringify({ toolName: raw.tool_name, elapsed: raw.elapsed_time_seconds, toolUseId: raw.tool_use_id }),
        sessionId
      }
    }

    case 'tool_use_summary': {
      return { role: 'assistant', kind: 'tool_use_summary', content: truncate(str(raw.summary), 2000), sessionId }
    }

    case 'stream_event':
    case 'compact_boundary':
    default:
      // stream_event 为增量流噪声；未知类型一律丢弃
      return null
  }
}

/** 内容块归一化：text / thinking / tool_use */
function normalizeBlock(block: Record<string, unknown>, sessionId?: string): Normalized | null {
  switch (block.type) {
    case 'text': {
      const text = str(block.text)
      if (!text.trim()) return null
      return { role: 'assistant', kind: 'assistant_text', content: truncate(text, 8000), sessionId }
    }
    case 'thinking':
      return { role: 'assistant', kind: 'thinking', content: truncate(str(block.thinking)), sessionId }
    case 'tool_use': {
      const input = block.input ?? {}
      return {
        role: 'assistant',
        kind: 'tool_use',
        content: `调用工具 ${str(block.name)}`,
        metaJson: JSON.stringify({ toolName: block.name, input }),
        sessionId
      }
    }
    default:
      return null
  }
}

/** 从 system 消息中提取人类可读文本（各 subtype 字段名不一，取常见字段） */
function extractSystemText(raw: Record<string, unknown>): string {
  for (const key of ['message', 'text', 'content', 'summary', 'description', 'suggestion', 'error', 'reason']) {
    if (raw[key] !== undefined && raw[key] !== null && raw[key] !== '') return str(raw[key])
  }
  // 剩余字段摘要
  const rest = { ...raw }
  delete rest.type
  delete rest.subtype
  delete rest.uuid
  delete rest.session_id
  return str(rest)
}

/**
 * 记录一条 SDK 消息到对话流（主进程在收到桥接 agentMessage 通知时调用）。
 * workItemId 存在时挂到对应工作项（用于分组折叠）；purpose 写入 meta 供 UI 标注来源。
 * 覆盖 Agent 全部消息输出：用户请求、工作项执行、工具调用、思考、系统消息与最终结果。
 */
export function recordSdkMessage(accountId: string, workItemId: string | undefined, purpose: string, raw: Record<string, unknown>): void {
  try {
    const normalized = normalizeSdkMessage(raw)
    if (!normalized) return
    // 把调用目的合并进 meta（如 generate_strategy:xxx / evaluate:xxx），便于 UI 标注消息来源
    let meta: Record<string, unknown> | undefined
    try {
      meta = normalized.metaJson ? (JSON.parse(normalized.metaJson) as Record<string, unknown>) : {}
    } catch {
      meta = {}
    }
    if (purpose) meta.purpose = purpose
    addChatMessage({
      accountId,
      role: normalized.role,
      content: normalized.content,
      kind: normalized.kind,
      meta,
      workItemId,
      sessionId: normalized.sessionId
    })
  } catch (e) {
    logger.warn(`[chat] record sdk message failed: ${(e as Error).message}`)
  }
}
