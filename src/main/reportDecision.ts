/**
 * 汇报决策动作执行（公共模块，handlers 与 agent 工具共用）：
 * 批准/驳回/暂缓 need_decision 汇报后执行对应动作（策略激活/暂停/淘汰/预警确认）。
 * 仅依赖 db/audit/events，不依赖 pipeline，避免循环依赖。
 */
import { nowIso, run } from './db'
import { audit } from './services/audit'
import { agentEventBus } from './agent/events'
import { logger } from './services/logger'

export interface ReportDecisionInput {
  reportId: string
  accountId: string
  decisionJson: string | null
  decision: 'approved' | 'rejected' | 'postponed'
  /** 决策者（user / auto 自动模式） */
  actor: 'user' | 'auto'
  note?: string
}

/** 执行汇报决策：更新汇报状态 + 同步对话流状态 + 批准动作（自动模式经此路径全自动执行） */
export function applyReportDecision(input: ReportDecisionInput): void {
  const { reportId, accountId, decisionJson, decision, actor, note } = input
  run('UPDATE report SET status = ?, updated_at = ? WHERE id = ?', [decision, nowIso(), reportId])
  // 同步对话流中关联消息的状态（syncChatReportStatus 在 chat.ts，避免循环依赖这里用直接 SQL）
  run('UPDATE chat_message SET report_status = ? WHERE report_id = ?', [decision, reportId])
  audit({ accountId, actor, action: 'report.respond', target: reportId, detail: { decision, note, auto: actor === 'auto' } })

  // 批准后的动作：激活策略 / 纠正执行 / 预警确认
  if (decision === 'approved' && decisionJson) {
    try {
      const d = JSON.parse(decisionJson) as { kind?: string; strategyId?: string; alertId?: string }
      if (d.kind === 'activate' && d.strategyId) {
        run('UPDATE strategy SET status = ?, updated_at = ? WHERE id = ?', ['active', nowIso(), d.strategyId])
        agentEventBus.emitAgentEvent('strategy.activated', accountId, { strategyId: d.strategyId }, { debounceMs: 0 })
        audit({ accountId, actor, action: 'strategy.activated', target: d.strategyId, detail: { via: reportId, auto: actor === 'auto' } })
      } else if (d.kind === 'correct_pause' && d.strategyId) {
        run("UPDATE strategy SET status = 'paused', updated_at = ? WHERE id = ?", [nowIso(), d.strategyId])
        audit({ accountId, actor, action: 'correction.paused', target: d.strategyId, detail: { via: reportId, auto: actor === 'auto' } })
      } else if (d.kind === 'correct_retire' && d.strategyId) {
        run("UPDATE strategy SET status = 'deactivated', updated_at = ? WHERE id = ?", [nowIso(), d.strategyId])
        run("UPDATE run_instance SET status = 'stopped', stopped_at = ? WHERE strategy_id = ? AND status = 'active'", [nowIso(), d.strategyId])
        audit({ accountId, actor, action: 'strategy.deactivated', target: d.strategyId, detail: { reason: `纠正淘汰（${actor === 'auto' ? '自动模式' : '人工批准'}）`, via: reportId } })
      } else if (d.kind === 'alert') {
        run('UPDATE alert SET status = ? WHERE id = ?', ['acknowledged', String(d.alertId)])
      }
    } catch (e) {
      logger.warn(`[report] decision action failed: ${(e as Error).message}`)
    }
  }
}
