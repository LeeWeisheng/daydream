/**
 * 触发源（Sources）：把调度节律 / 用户消息 / 管线完成事实翻译为 Trigger（dsh Source 的 Daydream 对应）。
 * 稳定 ID 规则（dsh「稳定 id 派生，重放安全」）：
 * - 调度事件：`sched:<type>:<accountId>:<date>`（同一天同类型只入一次）；
 * - 用户消息：`user:<accountId>:<chatMessageId>`；
 * - 工作项失败：`workitem:<ticketId>:failed`；
 * - 纠正完成：`pipeline:correction:<accountId>:<planId>`（每轮一次）。
 */
import type { Trigger } from '../core/model'
import { keyOf, nowIso } from '../core/model'

export type TriggerInput = Omit<Trigger, 'id' | 'occurredAt' | 'disposition'>

export function makeTrigger(parts: string[], input: TriggerInput): Trigger {
  return {
    id: keyOf(...parts),
    occurredAt: nowIso(),
    ...input
  }
}

/** 调度节律触发（盘前规划/盘后复盘等） */
export function scheduleTrigger(type: string, accountId: string, date: string, payload: Record<string, unknown> = {}): Trigger {
  return makeTrigger(['sched', type, accountId, date], { type, accountId, payload: { date, ...payload }, source: 'scheduler' })
}

/** 用户消息触发（幂等键 = 对话消息 ID） */
export function userMessageTrigger(accountId: string, messageId: string, text: string): Trigger {
  return makeTrigger(['user', accountId, messageId], {
    type: 'user.message',
    accountId,
    payload: { message: text, messageId },
    source: 'user'
  })
}

/** 工作项失败触发（评估可据此决定补救动作） */
export function workitemFailedTrigger(accountId: string, ticketId: string, error: string): Trigger {
  return makeTrigger(['workitem', ticketId, 'failed'], {
    type: 'workitem.failed',
    accountId,
    payload: { workItemId: ticketId, error },
    source: 'workitem',
    correlationId: ticketId
  })
}

/** 纠正完成触发（开启新一轮规划） */
export function correctionCompletedTrigger(accountId: string, planId: string): Trigger {
  return makeTrigger(['pipeline', 'correction', accountId, planId], {
    type: 'correction.completed',
    accountId,
    payload: { planId },
    source: 'pipeline',
    correlationId: planId
  })
}
