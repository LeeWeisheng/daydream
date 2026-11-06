/**
 * 自动盯盘（monitor）：盘中每 1~5 分钟由调度器定时任务**直跑**（不经 LLM 评估）。
 * 止损/止盈阈值使用内置默认值（策略为纯文本，盘中的精确止损判断由 Agent 决策环节基于策略文档完成）；
 * 因此每轮检查零 token 消耗。
 * 范围：持仓 ∪ 自选池；检查涨跌停接近、量能异动、指数急跌、止损/止盈线触及、信号失效。
 * 预警分级：info 仅记录 / warn 系统通知 / critical 直接生成 need_decision 汇报（均不触发 Agent 评估）。
 */
import { queryAll } from '../db/connection'
import { audit } from '../services/audit'
import { getQuotes } from '../market/service'
import { priceLimitRate } from '@shared/constants'
import { raiseAlert } from '../alerts/service'
import { expireSignal } from '../signals/service'
import { publishReport } from '../reports/service'

/** 盯盘规则阈值：内置默认值（策略为纯文本文档，不提供结构化阈值） */
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

/** 阈值读取：策略为纯文本文档，无结构化阈值，使用内置默认值 */
function resolveThresholds(_accountId: string): MonitorThresholds {
  return { ...DEFAULT_THRESHOLDS }
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
    const alert = raiseAlert({ accountId, level, type, content })
    alerts += 1
    if (level === 'critical') {
      // 紧急预警：确定性生成 need_decision 汇报（不进 LLM），并写入首页对话流
      publishReport({
        accountId,
        level: 'need_decision',
        title: `紧急预警：${type}`,
        summary: JSON.stringify(content),
        decisionJson: JSON.stringify({ kind: 'alert', alertId: alert.id, options: ['已查看', '忽略'] })
      })
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
    // 止损/止盈线触及（内置默认阈值；策略为纯文本，精确阈值由 Agent 决策环节掌握）
    const pos = queryAll<{ cost_price: number }>('SELECT cost_price FROM position WHERE account_id = ? AND code = ?', [accountId, quote.code])[0]
    if (pos && pos.cost_price > 0) {
      const pnl = quote.price / pos.cost_price - 1
      if (pnl <= -thresholds.stopLossPct) reportAlert('critical', 'stop_loss_hit', { code: quote.code, name: quote.name, pnl, threshold: thresholds.stopLossPct })
      else if (pnl >= thresholds.takeProfitPct) reportAlert('info', 'take_profit_zone', { code: quote.code, name: quote.name, pnl, threshold: thresholds.takeProfitPct })
    }
  }

  // 指数急跌（当日跌幅超阈值 → 用最近两个交易日指数日线近似）
  const idxRow = queryAll<{ close: number }>("SELECT close FROM index_daily WHERE index_code = '000300' ORDER BY date DESC LIMIT 2", [])
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
        expireSignal(s.id)
        reportAlert('info', 'signal_invalidated', { signalId: s.id, code: s.code, deviation })
      }
    }
  }

  audit({ accountId, actor: 'monitor', action: 'monitor.tick', detail: { poolSize: pool.size, alerts } })
  return { alerts }
}
