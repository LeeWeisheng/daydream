/**
 * Agent 事件总线：统一事件结构，落库 event_log 保证触发链路可追溯。
 * 同一评估窗口内同类事件合并（去抖）；评估与决策串行执行（单队列）。
 */
import { EventEmitter } from 'node:events'
import { getDb, run } from '../db'
import { audit } from '../services/audit'
import { logger } from '../services/logger'

export interface AgentEvent {
  id: string
  type: string
  accountId: string
  payload: Record<string, unknown>
  source: string
  correlationId?: string
  occurredAt: string
}

class AgentEventBus extends EventEmitter {
  private recent = new Map<string, number>() // type:accountId -> last emit ts

  /** 发布事件：落库 + 去抖 + 通知监听者 */
  emitAgentEvent(
    type: string,
    accountId: string,
    payload: Record<string, unknown> = {},
    options: { source?: string; correlationId?: string; debounceMs?: number } = {}
  ): AgentEvent {
    const now = Date.now()
    const key = `${type}:${accountId}`
    const last = this.recent.get(key) ?? 0
    const debounce = options.debounceMs ?? 5 * 60_000 // 默认 5 分钟去抖
    if (now - last < debounce) {
      logger.debug(`[agent] event ${type} debounced`)
      return { id: '', type, accountId, payload, source: options.source ?? 'system', occurredAt: new Date().toISOString() }
    }
    this.recent.set(key, now)

    const event: AgentEvent = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      type,
      accountId,
      payload,
      source: options.source ?? 'system',
      correlationId: options.correlationId,
      occurredAt: new Date().toISOString()
    }
    try {
      run(
        'INSERT INTO event_log (account_id, type, payload_json, source, correlation_id, occurred_at) VALUES (?, ?, ?, ?, ?, ?)',
        [accountId, type, JSON.stringify(payload), event.source, event.correlationId ?? null, event.occurredAt]
      )
    } catch (e) {
      logger.error(`[agent] event persist failed: ${(e as Error).message}`)
    }
    audit({ accountId, actor: 'system', action: 'agent.event', target: type, detail: payload })
    // 异步通知，避免阻塞事件发布方
    setImmediate(() => this.emit('event', event))
    return event
  }
}

/** 全局事件总线单例 */
export const agentEventBus = new AgentEventBus()

export function subscribeAgentEvents(handler: (e: AgentEvent) => void): () => void {
  agentEventBus.on('event', handler)
  return () => agentEventBus.off('event', handler)
}

/** 查询最近事件（供上下文组装） */
export function recentEvents(accountId: string, limit = 20): { type: string; payloadJson: string; occurredAt: string }[] {
  return getDb()
    .prepare('SELECT type, payload_json as payloadJson, occurred_at as occurredAt FROM event_log WHERE account_id = ? ORDER BY id DESC LIMIT ?')
    .all(accountId, limit) as { type: string; payloadJson: string; occurredAt: string }[]
}
