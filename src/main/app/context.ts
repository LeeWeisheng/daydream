/**
 * 评估上下文组装（摘要器）：按需组装轻量上下文，控制 token 成本与质量。
 * 上下文块：策略版本状态、待决策事项、受阻工作项、最近事件（docs《Agent 决策闭环设计》§3.2）。
 */
import { getDb } from '../db/connection'

export interface EvalContextSummary {
  strategy: { title: string; version: number; updatedAt: string } | null
  pendingDecisions: number
  blockedWorkItems: number
  recentEvents: { type: string; at: string }[]
  recentSignals: number
}

/** 组装评估上下文摘要（轻量；全部经读查询） */
export function buildContextSummary(accountId: string): EvalContextSummary {
  const db = getDb()
  const strategy = db.prepare('SELECT title, version, updated_at FROM strategy WHERE account_id = ? LIMIT 1').get(accountId) as
    | { title: string; version: number; updated_at: string }
    | undefined
  const pendingReports = db.prepare("SELECT COUNT(*) AS c FROM report WHERE account_id = ? AND status = 'pending' AND level = 'need_decision'").get(accountId) as { c: number }
  const blockedWorkItems = db.prepare("SELECT COUNT(*) AS c FROM work_item WHERE account_id = ? AND status = 'blocked'").get(accountId) as { c: number }
  const recentSignals = db.prepare("SELECT COUNT(*) AS c FROM signal WHERE account_id = ? AND created_at >= datetime('now', '-7 days')").get(accountId) as { c: number }
  const recentEvents = db
    .prepare('SELECT type, occurred_at FROM event_log WHERE account_id = ? ORDER BY id DESC LIMIT 5')
    .all(accountId) as Array<{ type: string; occurred_at: string }>
  return {
    strategy: strategy ? { title: strategy.title, version: strategy.version, updatedAt: strategy.updated_at } : null,
    pendingDecisions: pendingReports.c,
    blockedWorkItems: blockedWorkItems.c,
    recentEvents: recentEvents.map((e) => ({ type: e.type, at: e.occurred_at })),
    recentSignals: recentSignals.c
  }
}
