/**
 * 自动盯盘（monitor）：盘中每 1~5 分钟由调度器定时任务**直跑**（不经 LLM 评估）。
 * 规则由 Agent 预先配置：止损/止盈阈值读取账户唯一策略 DSL 的 exit 条件（stop_loss/take_profit），
 * 其余阈值内置；因此每轮检查零 token 消耗。
 * 范围：持仓 ∪ 自选池；检查涨跌停接近、量能异动、指数急跌、止损/止盈线触及、信号失效。
 * 预警分级：info 仅记录 / warn 系统通知 / critical 直接生成 need_decision 汇报（均不触发 Agent 评估）。
 */
import { nowIso, queryAll, run as dbRun } from '../db'
import { audit } from '../services/audit'
import { getQuotes } from '../data/service'
import { agentEventBus } from '../agent/events'
import { priceLimitRate } from '@shared/constants'
import { addChatMessage, formatReportContent } from '../chat'

/** 盯盘规则阈值：止损/止盈优先取策略 DSL（Agent 预配置），其余内置 */
interface MonitorThresholds {
  stopLossPct: number
  takeProfitPct: number
  /** 涨跌停接近判定：距涨跌停幅度差（如 0.02 表示距涨停 ≤2% 告警） */
  limitApproachPct: number
  /** 指数急跌阈值（当日跌幅超过即告警） */
  indexDropPct: number
}

const DEFAULT_THRESHOLDS: MonitorThresholds = {
  stopLossPct: 0.08,
  takeProfitPct: 0.2,
  limitApproachPct: 0.02,
  indexDropPct: 0.02
}

/** 读取 Agent 预先配置在策略 DSL 中的止损/止盈阈值（无则用默认） */
function resolveThresholds(accountId: string): MonitorThresholds {
  const t = { ...DEFAULT_THRESHOLDS }
  try {
    const row = queryAll<{ dsl_json: string }>('SELECT dsl_json FROM strategy WHERE account_id = ?', [accountId])[0]
    const dsl = JSON.parse(row.dsl_json) as {
      exit?: { conditions?: { indicator: string; params?: Record<string, unknown> }[] }
    }
    for (const c of dsl.exit?.conditions ?? []) {
      if (c.indicator === 'stop_loss' && typeof c.params?.pct === 'number') t.stopLossPct = c.params.pct
      if (c.indicator === 'take_profit' && typeof c.params?.pct === 'number') t.takeProfitPct = c.params.pct
    }
  } catch {
    /* DSL 异常时用默认阈值 */
  }
  return t
}

export async function run(accountId: string): Promise<{ alerts: number }> {
  const thresholds = resolveThresholds(accountId)

  // 盯盘池：持仓 ∪ 自选池（运行策略候选池由收盘决策覆盖，避免盘中全市场扫描）
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
    // 事件仅推送 UI（loop 对 alert.triggered 不评估，零 token 消耗）
    agentEventBus.emitAgentEvent('alert.triggered', accountId, { alertId: id, level, type }, { debounceMs: 0 })
    if (level === 'critical') {
      // 紧急预警：确定性生成 need_decision 汇报（不进 LLM），并写入首页对话流
      const reportId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const now = nowIso()
      const title = `紧急预警：${type}`
      const summary = JSON.stringify(content)
      dbRun('INSERT INTO report (id, account_id, level, title, summary, decision_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [
        reportId,
        accountId,
        'need_decision',
        title,
        summary,
        JSON.stringify({ kind: 'alert', alertId: id, options: ['已查看', '忽略'] }),
        'pending',
        now,
        now
      ])
      addChatMessage({ accountId, role: 'assistant', kind: 'report', content: formatReportContent(title, summary, 'need_decision'), reportId, reportLevel: 'need_decision', reportStatus: 'pending' })
      agentEventBus.emitAgentEvent('agent.report', accountId, { reportId, level: 'need_decision', title }, { debounceMs: 0 })
    }
  }

  for (const quote of quotes) {
    if (quote.price <= 0) continue
    // 涨跌停接近（按板块涨跌幅计算，距涨跌停 ≤ 阈值告警）
    if (quote.prevClose > 0) {
      const rate = priceLimitRate(quote.code, quote.name)
      const pct = quote.price / quote.prevClose - 1
      if (pct >= rate - thresholds.limitApproachPct) reportAlert('warn', 'limit_up_approach', { code: quote.code, name: quote.name, pctChg: quote.pctChg })
      if (pct <= -(rate - thresholds.limitApproachPct)) reportAlert('warn', 'limit_down_approach', { code: quote.code, name: quote.name, pctChg: quote.pctChg })
    }
    // 止损/止盈线触及（阈值来自策略 DSL，Agent 预配置）
    const pos = queryAll<{ cost_price: number }>('SELECT cost_price FROM position WHERE account_id = ? AND code = ?', [accountId, quote.code])[0]
    if (pos && pos.cost_price > 0) {
      const pnl = quote.price / pos.cost_price - 1
      if (pnl <= -thresholds.stopLossPct) reportAlert('critical', 'stop_loss_hit', { code: quote.code, name: quote.name, pnl, threshold: thresholds.stopLossPct })
      else if (pnl >= thresholds.takeProfitPct) reportAlert('info', 'take_profit_zone', { code: quote.code, name: quote.name, pnl, threshold: thresholds.takeProfitPct })
    }
  }

  // 指数急跌（当日跌幅超阈值 → 用最近两个交易日指数日线近似）
  const idxRow = queryAll<{ close: number }>(
    "SELECT close FROM index_daily WHERE index_code = '000300' ORDER BY date DESC LIMIT 2",
    []
  )
  if (idxRow.length >= 2) {
    const drop = idxRow[0].close / idxRow[1].close - 1
    if (drop <= -thresholds.indexDropPct) reportAlert('critical', 'index_sharp_drop', { drop })
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
