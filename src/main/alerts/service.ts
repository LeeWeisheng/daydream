/**
 * 预警服务（Alerts）：alert 的唯一写者（dsh「one writer per state」）。
 * 规则（docs《Agent 决策闭环设计》§7.5）：预警全部确定性产出（盯盘定时任务直跑，零 token）；
 * 分级：info 仅记录 / warn 系统通知（不置顶）/ critical 直接生成 need_decision 汇报。
 * critical 汇报由 reports 服务产出（本服务只写 alert + 推送 UI 事件）。
 */
import type { Alert, AlertLevel } from '@shared/types'
import { newId, nowIso, queryAll, run } from '../db/connection'
import { audit } from '../services/audit'
import { uiBus } from '../app/events'

export interface RaiseAlertInput {
  accountId: string
  level: AlertLevel
  type: string
  content: Record<string, unknown> | string
}

/** 发布一条预警（确定性产出；不进 LLM 评估） */
export function raiseAlert(input: RaiseAlertInput): Alert {
  const id = newId()
  const now = nowIso()
  const contentJson = JSON.stringify({ content: input.content })
  run('INSERT INTO alert (id, account_id, level, type, content_json, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
    id,
    input.accountId,
    input.level,
    input.type,
    contentJson,
    'open',
    now
  ])
  const alert: Alert = {
    id,
    accountId: input.accountId,
    level: input.level,
    type: input.type,
    contentJson,
    status: 'open',
    createdAt: now
  }
  uiBus.broadcast('alert.triggered', { accountId: input.accountId, alertId: id, level: input.level, type: input.type })
  audit({ accountId: input.accountId, actor: 'monitor', action: 'alert.raised', target: id, detail: { level: input.level, type: input.type } })
  return alert
}

export function listAlerts(accountId: string, limit = 200): Alert[] {
  return queryAll<Record<string, unknown>>('SELECT * FROM alert WHERE account_id = ? ORDER BY created_at DESC LIMIT ?', [accountId, limit]).map(toAlert)
}

export function acknowledgeAlert(alertId: string): void {
  run("UPDATE alert SET status = 'acknowledged' WHERE id = ?", [alertId])
}

export function countOpenAlerts(accountId: string): number {
  return (queryAll<{ c: number }>("SELECT COUNT(*) AS c FROM alert WHERE account_id = ? AND status = 'open'", [accountId])[0] ?? { c: 0 }).c
}

function toAlert(r: Record<string, unknown>): Alert {
  return {
    id: String(r.id),
    accountId: String(r.account_id),
    level: r.level as AlertLevel,
    type: String(r.type),
    contentJson: String(r.content_json),
    status: r.status as 'open' | 'acknowledged',
    createdAt: String(r.created_at)
  }
}
