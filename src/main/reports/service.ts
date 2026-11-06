/**
 * 汇报服务（Reports）：report 的唯一写者（dsh「one writer per state」）。
 * 规则（docs《Agent 决策闭环设计》§6）：
 * - 分级：silent（仅审计）/ summary（对话流静默）/ result（可用结果）/ need_decision（待人工决策）；
 * - 全部 summary 及以上汇报同步进入首页对话流（经 Outbox）；
 * - need_decision 决策响应（批准/驳回/暂缓）执行对应动作：
 *   activate（激活）、correct_pause（暂停）、correct_retire（淘汰）、alert（预警确认）；
 * - 自动模式（accept mode = auto）：need_decision 自动批准并执行（策略验证场景，
 *   真实交易边界不变），全程审计留痕。
 */
import type { Report, ReportLevel } from '@shared/types'
import { inTransaction, newId, nowIso, queryAll, queryOne, run } from '../db/connection'
import { audit } from '../services/audit'
import { assertUser } from '../core/errors'
import { isAutoMode } from '../settings/service'
import { activateStrategy, deactivateStrategy, pauseStrategy } from '../strategy/service'
import { acknowledgeAlert } from '../alerts/service'
import { addChatMessage, formatReportContent, syncReportStatus } from '../chat/service'
import { uiBus } from '../app/events'

export interface PublishReportInput {
  accountId: string
  level: Exclude<ReportLevel, 'silent'>
  title: string
  summary: string
  decisionJson?: string
  workItemId?: string
}

/** 发布一条汇报：落 report + 对话流 + UI 事件；自动模式下 need_decision 自动批准 */
export function publishReport(input: PublishReportInput): { reportId: string; autoApproved: boolean } {
  const id = newId()
  const now = nowIso()
  const autoApproved = input.level === 'need_decision' && isAutoMode()
  inTransaction(() => {
    run('INSERT INTO report (id, account_id, level, title, summary, decision_json, status, work_item_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [
      id,
      input.accountId,
      input.level,
      input.title,
      input.summary,
      input.decisionJson ?? null,
      autoApproved ? 'approved' : 'pending',
      input.workItemId ?? null,
      now,
      now
    ])
  })
  addChatMessage({
    accountId: input.accountId,
    role: 'assistant',
    kind: 'report',
    content: autoApproved ? `${formatReportContent(input.title, input.summary, input.level)}\n（自动模式：已自动批准并执行）` : formatReportContent(input.title, input.summary, input.level),
    reportId: id,
    reportLevel: input.level,
    reportStatus: autoApproved ? 'approved' : 'pending',
    workItemId: input.workItemId
  })
  if (autoApproved && input.decisionJson) {
    applyReportDecision({ reportId: id, accountId: input.accountId, decisionJson: input.decisionJson, decision: 'approved', actor: 'auto', note: '自动模式自动批准' })
  }
  uiBus.broadcast('agent.report', { accountId: input.accountId, reportId: id, level: input.level, title: input.title, autoApproved })
  audit({ accountId: input.accountId, actor: 'agent', action: 'report.published', target: id, detail: { level: input.level, autoApproved } })
  return { reportId: id, autoApproved }
}

export function listReports(accountId: string, limit = 200): Report[] {
  return queryAll<Record<string, unknown>>('SELECT * FROM report WHERE account_id = ? ORDER BY created_at DESC LIMIT ?', [accountId, limit]).map(toReport)
}

export function getReport(id: string): Report {
  const row = queryOne<Record<string, unknown>>('SELECT * FROM report WHERE id = ?', [id])
  assertUser(row, 'missing_report', { id })
  return toReport(row)
}

export interface ReportDecisionInput {
  reportId: string
  accountId: string
  decisionJson: string | null
  decision: 'approved' | 'rejected' | 'postponed'
  /** 决策者（user / auto 自动模式） */
  actor: 'user' | 'auto'
  note?: string
}

/** 执行汇报决策：更新汇报状态 + 同步对话流 + 批准动作（自动模式经此路径全自动执行） */
export function applyReportDecision(input: ReportDecisionInput): void {
  const { reportId, accountId, decisionJson, decision, actor, note } = input
  run('UPDATE report SET status = ?, updated_at = ? WHERE id = ?', [decision, nowIso(), reportId])
  syncReportStatus(reportId, decision)
  audit({ accountId, actor, action: 'report.respond', target: reportId, detail: { decision, note, auto: actor === 'auto' } })

  if (decision !== 'approved' || !decisionJson) return
  try {
    const d = JSON.parse(decisionJson) as { kind?: string; strategyId?: string; alertId?: string }
    if (d.kind === 'activate' && d.strategyId) {
      activateStrategy(accountId, d.strategyId, actor === 'auto' ? 'auto' : 'user')
      audit({ accountId, actor, action: 'strategy.activated', target: d.strategyId, detail: { via: reportId, auto: actor === 'auto' } })
    } else if (d.kind === 'correct_pause' && d.strategyId) {
      pauseStrategy(accountId, d.strategyId, actor === 'auto' ? 'auto' : 'user')
      audit({ accountId, actor, action: 'correction.paused', target: d.strategyId, detail: { via: reportId, auto: actor === 'auto' } })
    } else if (d.kind === 'correct_retire' && d.strategyId) {
      deactivateStrategy(accountId, d.strategyId, `纠正淘汰（${actor === 'auto' ? '自动模式' : '人工批准'}）`, actor === 'auto' ? 'auto' : 'user')
    } else if (d.kind === 'alert' && d.alertId) {
      acknowledgeAlert(String(d.alertId))
    }
  } catch (e) {
    // 决策动作失败不影响汇报状态（已记录；错误经审计留痕）
    audit({ accountId, actor: 'system', action: 'report.action_failed', target: reportId, detail: { error: (e as Error).message } })
  }
  uiBus.broadcast('agent.report', { reportId, decision })
}

function toReport(r: Record<string, unknown>): Report {
  return {
    id: String(r.id),
    accountId: String(r.account_id),
    level: r.level as ReportLevel,
    title: String(r.title),
    summary: String(r.summary),
    decisionJson: r.decision_json ? String(r.decision_json) : undefined,
    status: r.status as Report['status'],
    workItemId: r.work_item_id ? String(r.work_item_id) : undefined,
    artifactsJson: r.artifacts_json ? String(r.artifacts_json) : undefined,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at)
  }
}
