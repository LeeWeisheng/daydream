/**
 * Replies：对话流消息的写入（dsh src/core/replies.ts 的对应）。
 * 所有对话流消息经 Outbox 发出（先落 receipt 再投递，见 app/outbox.ts），
 * 本部分负责「写什么、按什么规则写」。
 */
import type { OutboxMessage } from './ports'
import { EnginePart } from './part'

/** 工作项类型的中文标签（对话流完成消息用） */
const WORKITEM_LABELS: Record<string, string> = {
  plan: '规划',
  generate_strategy: '生成策略',
  backtest: '回测',
  activate: '上线评审',
  monitor_review: '盯盘检查',
  review_daily: '日复盘',
  review_weekly: '周复盘',
  correct: '纠正',
  data_backfill: '数据补数',
  user_request: '用户请求'
}

export class Replies extends EnginePart {
  /** 工作项完成的对话流消息（主要结果；user_request 的结果已由消息流记录，不重复） */
  ticketFinished(accountId: string, ticketId: string, type: string, outcome: 'succeeded' | 'failed' | 'cancelled', detail?: { result?: unknown; error?: string }): void {
    const label = WORKITEM_LABELS[type] ?? type
    if (outcome === 'succeeded') {
      if (type === 'user_request') return
      this.send({
        accountId,
        role: 'assistant',
        kind: 'result',
        content: `${label}完成`,
        meta: { workItemType: type, result: summarizeResult(detail?.result) },
        ticketId
      })
    } else {
      const content = `${label}${outcome === 'cancelled' ? '已取消' : '失败'}：${detail?.error ?? ''}`
      this.send({
        accountId,
        role: 'assistant',
        kind: 'error',
        content,
        meta: { workItemType: type, outcome },
        ticketId
      })
    }
  }

  /** 发送一条对话流消息（经 Outbox，单写者） */
  send(message: Omit<OutboxMessage, 'id'>): void {
    this.options.outbox.send(message)
  }
}

/** 结果摘要（对话流 meta，截断防爆） */
export function summarizeResult(result: unknown): unknown {
  try {
    const text = typeof result === 'string' ? result : JSON.stringify(result ?? {})
    return text.length > 800 ? `${text.slice(0, 800)}…（截断）` : text
  } catch {
    return undefined
  }
}
