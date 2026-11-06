/**
 * 绩效分析：账户/策略指标计算、收益归因。
 * 数据口径：trade_record（人工执行记录）+ 每日 account_snapshot 为输入；
 * 信号与执行偏差单独统计（见《实现方案-数据模型与模块设计》§8）。
 */
import type { TradeRecord } from '@shared/types'

// ---------- 收益序列指标（复用回测指标口径） ----------
export interface PerfMetrics {
  totalReturn: number
  annualReturn: number
  maxDrawdown: number
  annualVolatility: number
  sharpe: number
  calmar: number
  winRate: number
  profitLossRatio: number
  tradeCount: number
  signalHitRate?: number // 信号命中率（已执行/总信号）
  executionDeviationRate?: number // 执行偏差率（过期+忽略/总信号）
}

export interface SnapshotPoint {
  date: string
  totalAssets: number
}

/** 由每日账户快照计算净值指标 */
export function computeSnapshotMetrics(points: SnapshotPoint[], rf = 0.02): PerfMetrics {
  if (points.length < 2) {
    return {
      totalReturn: 0,
      annualReturn: 0,
      maxDrawdown: 0,
      annualVolatility: 0,
      sharpe: 0,
      calmar: 0,
      winRate: 0,
      profitLossRatio: 0,
      tradeCount: 0
    }
  }
  const dailyReturns = computeDailyReturns(points)
  const totalReturn = points[points.length - 1].totalAssets / points[0].totalAssets - 1
  const years = dailyReturns.length / 244 // A 股年均交易日约 244
  const annualReturn = Math.pow(1 + totalReturn, 1 / Math.max(years, 1 / 244)) - 1
  const { maxDrawdown } = computeDrawdown(points)
  const mean = dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length
  const variance = dailyReturns.reduce((a, b) => a + (b - mean) ** 2, 0) / dailyReturns.length
  const annualVolatility = Math.sqrt(variance) * Math.sqrt(244)
  const sharpe = annualVolatility > 0 ? (annualReturn - rf) / annualVolatility : 0
  const calmar = maxDrawdown > 0 ? annualReturn / maxDrawdown : 0
  return {
    totalReturn,
    annualReturn,
    maxDrawdown,
    annualVolatility,
    sharpe,
    calmar,
    winRate: 0,
    profitLossRatio: 0,
    tradeCount: 0
  }
}

export function computeDailyReturns(points: SnapshotPoint[]): number[] {
  const out: number[] = []
  for (let i = 1; i < points.length; i++) {
    out.push(points[i].totalAssets / points[i - 1].totalAssets - 1)
  }
  return out
}

export function computeDrawdown(points: SnapshotPoint[]): { maxDrawdown: number; peakDate: string; troughDate: string } {
  let peak = points[0].totalAssets
  let maxDd = 0
  let peakDate = points[0].date
  let troughDate = points[0].date
  for (const p of points) {
    if (p.totalAssets > peak) {
      peak = p.totalAssets
      peakDate = p.date
    }
    const dd = peak > 0 ? (peak - p.totalAssets) / peak : 0
    if (dd > maxDd) {
      maxDd = dd
      troughDate = p.date
    }
  }
  return { maxDrawdown: maxDd, peakDate, troughDate }
}

// ---------- 交易记录统计 ----------
export interface TradeStats {
  tradeCount: number
  winRate: number
  profitLossRatio: number
  totalPnl: number
  byStrategy: Record<string, { pnl: number; trades: number }>
  byIndustry: Record<string, number>
  byCode: Record<string, number>
}

/** 按配对（先进先出简化）计算已平仓盈亏与统计 */
export function computeTradeStats(trades: TradeRecord[]): TradeStats {
  const stats: TradeStats = {
    tradeCount: trades.length,
    winRate: 0,
    profitLossRatio: 0,
    totalPnl: 0,
    byStrategy: {},
    byIndustry: {},
    byCode: {}
  }
  // 简化归因：按代码 FIFO 配对
  const queue = new Map<string, { qty: number; cost: number }[]>()
  const wins: number[] = []
  const losses: number[] = []
  for (const t of trades) {
    if (t.side === 'buy') {
      const q = queue.get(t.code) ?? []
      q.push({ qty: t.qty, cost: t.price * t.qty + t.fee })
      queue.set(t.code, q)
    } else {
      let sellQty = t.qty
      let sellProceeds = t.price * t.qty - t.fee
      const q = queue.get(t.code) ?? []
      while (sellQty > 0 && q.length > 0) {
        const lot = q[0]
        const matchQty = Math.min(lot.qty, sellQty)
        const costPart = (lot.cost * matchQty) / lot.qty
        const proceedsPart = (sellProceeds * matchQty) / t.qty
        const pnl = proceedsPart - costPart
        stats.totalPnl += pnl
        if (pnl >= 0) wins.push(pnl)
        else losses.push(-pnl)
        lot.qty -= matchQty
        sellQty -= matchQty
        if (lot.qty <= 0) q.shift()
      }
      queue.set(t.code, q)
    }
    stats.byCode[t.code] = (stats.byCode[t.code] ?? 0) + 1
  }
  const closed = wins.length + losses.length
  stats.winRate = closed > 0 ? wins.length / closed : 0
  const avgWin = wins.length > 0 ? wins.reduce((a, b) => a + b, 0) / wins.length : 0
  const avgLoss = losses.length > 0 ? losses.reduce((a, b) => a + b, 0) / losses.length : 0
  stats.profitLossRatio = avgLoss > 0 ? avgWin / avgLoss : avgWin > 0 ? Infinity : 0
  return stats
}

/** 信号执行偏差统计 */
export function computeSignalDeviation(
  signals: { status: string }[]
): { total: number; executed: number; ignored: number; expired: number; hitRate: number; deviationRate: number } {
  const total = signals.length
  const executed = signals.filter((s) => s.status === 'executed').length
  const ignored = signals.filter((s) => s.status === 'ignored').length
  const expired = signals.filter((s) => s.status === 'expired').length
  return {
    total,
    executed,
    ignored,
    expired,
    hitRate: total > 0 ? executed / total : 0,
    deviationRate: total > 0 ? (ignored + expired) / total : 0
  }
}
