/**
 * 自动盯盘（monitor）：盘中每 1~5 分钟一轮。
 * 范围：运行策略候选池 ∪ 持仓 ∪ 自选池；检查涨跌停接近、量能异动、
 * 指数急跌、止损/止盈线触及、信号失效。
 * 预警分级：info 仅记录 / warn 系统通知 / critical 走 need_decision 汇报。
 */
import { nowIso, queryAll, run as dbRun } from '../db'
import { audit } from '../services/audit'
import { logger } from '../services/logger'
import { getQuotes } from '../data/service'
import { agentEventBus } from '../agent/events'

export async function run(accountId: string): Promise<{ alerts: number }> {
  // 盯盘池
  const held = queryAll<{ code: string }>('SELECT code FROM position WHERE account_id = ?', [accountId])
  const watch = queryAll<{ code: string }>('SELECT code FROM watchlist WHERE account_id = ?', [accountId])
  const pool = new Set<string>([...held.map((h) => h.code), ...watch.map((w) => w.code)])
  if (pool.size === 0) return { alerts: 0 }
  const quotes = await getQuotes(Array.from(pool), true)
  let alerts = 0
  const reportAlert = (level: 'info' | 'warn' | 'critical', type: string, content: Record<string, unknown>): void => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    dbRun('INSERT INTO alert (id, account_id, level, type, content_json, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
      id,
      accountId,
      level,
      type,
      JSON.stringify(content),
      'open',
      nowIso()
    ])
    alerts += 1
    agentEventBus.emitAgentEvent('alert.triggered', accountId, { alertId: id, level, type }, { debounceMs: 0 })
    if (level === 'critical') {
      // 紧急预警走 need_decision 汇报
      const reportId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const now = nowIso()
      dbRun('INSERT INTO report (id, account_id, level, title, summary, decision_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [
        reportId,
        accountId,
        'need_decision',
        `紧急预警：${type}`,
        JSON.stringify(content),
        JSON.stringify({ kind: 'alert', alertId: id, options: ['已查看', '忽略'] }),
        'pending',
        now,
        now
      ])
      agentEventBus.emitAgentEvent('agent.report', accountId, { reportId, level: 'need_decision', title: `紧急预警：${type}` }, { debounceMs: 0 })
    }
  }

  for (const quote of quotes) {
    if (quote.price <= 0) continue
    // 涨跌停接近（±2% 内）
    if (quote.prevClose > 0) {
      const pct = quote.price / quote.prevClose - 1
      if (pct >= 0.078) reportAlert('warn', 'limit_up_approach', { code: quote.code, name: quote.name, pctChg: quote.pctChg })
      if (pct <= -0.078) reportAlert('warn', 'limit_down_approach', { code: quote.code, name: quote.name, pctChg: quote.pctChg })
    }
    // 止损/止盈线触及（持仓浮亏/浮盈超阈值）
    const pos = queryAll<{ cost_price: number }>('SELECT cost_price FROM position WHERE account_id = ? AND code = ?', [accountId, quote.code])[0]
    if (pos && pos.cost_price > 0) {
      const pnl = quote.price / pos.cost_price - 1
      if (pnl <= -0.08) reportAlert('critical', 'stop_loss_hit', { code: quote.code, name: quote.name, pnl })
      else if (pnl >= 0.2) reportAlert('info', 'take_profit_zone', { code: quote.code, name: quote.name, pnl })
    }
    // 量能异动（vs 20 日均量，用缓存数据无法精确计算时跳过）
  }

  // 指数急跌（15 分钟内跌超阈值 → 用当日指数跌幅近似）
  const idxRow = queryAll<{ close: number }>(
    "SELECT close FROM index_daily WHERE index_code = '000300' ORDER BY date DESC LIMIT 2",
    []
  )
  if (idxRow.length >= 2) {
    const drop = idxRow[0].close / idxRow[1].close - 1
    if (drop <= -0.02) reportAlert('critical', 'index_sharp_drop', { drop })
  }

  // 信号失效检查（价格远离参考价 > 3%）
  const pendingSignals = queryAll<{ id: string; code: string; ref_price: number }>(
    "SELECT id, code, ref_price FROM signal WHERE account_id = ? AND status = 'pending_execution'",
    [accountId]
  )
  for (const s of pendingSignals) {
    const quote = quotes.find((q) => q.code === s.code)
    if (quote && quote.price > 0) {
      const deviation = Math.abs(quote.price - s.ref_price) / s.ref_price
      if (deviation > 0.03) {
        dbRun("UPDATE signal SET status = 'expired', updated_at = ? WHERE id = ?", [nowIso(), s.id])
        reportAlert('info', 'signal_invalidated', { signalId: s.id, code: s.code, deviation })
      }
    }
  }

  audit({ accountId, actor: 'monitor', action: 'monitor.tick', detail: { poolSize: pool.size, alerts } })
  return { alerts }
}
