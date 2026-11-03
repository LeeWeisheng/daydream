/**
 * 回测引擎：纯函数式确定性引擎（bar 级，日线）。
 * 输入（DSL + K 线数据 + 参数）→ 输出（净值序列 + 指标 + 交易明细），
 * 相同输入必得相同输出。A 股规则建模见《实现方案-数据模型与模块设计》§4.2：
 * T+1、涨跌停不成交、整手交易、佣金/印花税/过户费、滑点、停牌冻结、次日开盘成交。
 *
 * 注意：引擎为纯函数，由调用方在 Worker 中执行，避免阻塞主进程。
 */
import type { BacktestMetrics, BacktestParams, BacktestResult, BacktestTrade, Bar } from '@shared/types'
import type { DslCondition, StrategyDSL } from '@shared/strategy/schema'
import { LOT_SIZE, calcFee, limitPrices } from '@shared/constants'
import { boll, crossDetect, macd, momentum, obv, rsi, sma, volumeRatio } from './indicators'

export const DEFAULT_BACKTEST_PARAMS: BacktestParams = {
  start: '',
  end: '',
  initialCash: 1_000_000,
  commissionRate: 0.00025,
  minCommission: 5,
  stampTaxRate: 0.0005,
  transferFeeRate: 0.00001,
  slippage: 0.001
}

// ---------- 数据准备 ----------
interface AdjBar extends Bar {
  adjOpen: number
  adjHigh: number
  adjLow: number
  adjClose: number
}

interface UniverseInfo {
  code: string
  name: string
  bars: AdjBar[] // 按日期升序
  dateIndex: Map<string, number>
}

/** 前复权换算：前复权价 = 原价 × 因子 ÷ 最新因子（以区间末日为基准） */
function prepareData(
  klines: Bar[],
  stockNames: Map<string, string>,
  start: string,
  end: string
): Map<string, UniverseInfo> {
  const byCode = new Map<string, Bar[]>()
  for (const bar of klines) {
    if (bar.date < start || bar.date > end) continue
    const list = byCode.get(bar.code) ?? []
    list.push(bar)
    byCode.set(bar.code, list)
  }
  const out = new Map<string, UniverseInfo>()
  for (const [code, bars] of byCode) {
    bars.sort((a, b) => (a.date < b.date ? -1 : 1))
    // 基准因子 = 区间内最后一条的因子（若区间末日无数据，取最后一条）
    const lastFactor = bars.length > 0 ? bars[bars.length - 1].adjFactor || 1 : 1
    const adjBars: AdjBar[] = bars.map((b) => {
      const f = lastFactor > 0 ? (b.adjFactor || 1) / lastFactor : 1
      return { ...b, adjOpen: b.open * f, adjHigh: b.high * f, adjLow: b.low * f, adjClose: b.close * f }
    })
    const dateIndex = new Map<string, number>()
    adjBars.forEach((b, i) => dateIndex.set(b.date, i))
    out.set(code, { code, name: stockNames.get(code) ?? code, bars: adjBars, dateIndex })
  }
  return out
}

// ---------- 选股域过滤 ----------
function applyUniverseFilters(universe: Map<string, UniverseInfo>, dsl: StrategyDSL): Map<string, UniverseInfo> {
  const out = new Map(universe)
  for (const f of dsl.universe.filters) {
    for (const [code, info] of Array.from(out.entries())) {
      let excluded = false
      let reason = ''
      switch (f.op) {
        case 'exclude_st': {
          if (info.name.includes('ST')) {
            excluded = true
            reason = 'ST'
          }
          break
        }
        case 'exclude_stop': {
          const days = typeof f.params.days === 'number' ? f.params.days : 5
          if (info.bars.length >= days) {
            const recent = info.bars.slice(-days)
            const hasTrade = recent.some((b) => b.volume > 0)
            if (!hasTrade) {
              excluded = true
              reason = `停牌超过 ${days} 日`
            }
          }
          break
        }
        case 'liquidity_min': {
          const amount = typeof f.params.amount === 'number' ? f.params.amount : 1e8
          const days = typeof f.params.days === 'number' ? f.params.days : 20
          if (info.bars.length >= days) {
            const recent = info.bars.slice(-days)
            const avg = recent.reduce((a, b) => a + b.amount, 0) / days
            if (avg < amount) {
              excluded = true
              reason = `日均成交额不足 ${amount}`
            }
          } else {
            excluded = true
            reason = '历史数据不足'
          }
          break
        }
        default:
          break
      }
      if (excluded) out.delete(code)
      if (reason) void reason
    }
  }
  return out
}

// ---------- 条件评估 ----------
interface PositionCtx {
  buyDate: string // 建仓日期
  costPrice: number // 建仓价（含费用摊销）
  qty: number
}

export type { PositionCtx }

interface EvalCtx {
  closes: number[]
  highs: number[]
  lows: number[]
  volumes: number[]
  position?: PositionCtx
  date: string
}

/** 评估单个条件（截至当前 bar） */
export function evalCondition(c: DslCondition, ctx: EvalCtx): boolean {
  const p = c.params as Record<string, number>
  switch (c.indicator) {
    case 'ma_cross_up': {
      const { up } = crossDetect(sma(ctx.closes, p.fast), sma(ctx.closes, p.slow))
      return up
    }
    case 'ma_cross_down': {
      const { down } = crossDetect(sma(ctx.closes, p.fast), sma(ctx.closes, p.slow))
      return down
    }
    case 'price_above_ma': {
      const ma = sma(ctx.closes, p.n)
      const last = ma[ma.length - 1]
      return !isNaN(last) && ctx.closes[ctx.closes.length - 1] > last
    }
    case 'price_below_ma': {
      const ma = sma(ctx.closes, p.n)
      const last = ma[ma.length - 1]
      return !isNaN(last) && ctx.closes[ctx.closes.length - 1] < last
    }
    case 'boll_break_up': {
      const { upper } = boll(ctx.closes, p.n, p.k)
      const u = upper[upper.length - 1]
      return !isNaN(u) && ctx.closes[ctx.closes.length - 1] > u
    }
    case 'rsi_below': {
      const r = rsi(ctx.closes, p.n)
      const last = r[r.length - 1]
      return !isNaN(last) && last < p.threshold
    }
    case 'rsi_above': {
      const r = rsi(ctx.closes, p.n)
      const last = r[r.length - 1]
      return !isNaN(last) && last > p.threshold
    }
    case 'macd_golden_cross': {
      const { dif, dea } = macd(ctx.closes, p.fast, p.slow, p.signal)
      const { up } = crossDetect(dif, dea)
      return up
    }
    case 'macd_dead_cross': {
      const { dif, dea } = macd(ctx.closes, p.fast, p.slow, p.signal)
      const { down } = crossDetect(dif, dea)
      return down
    }
    case 'momentum_gt': {
      const m = momentum(ctx.closes, p.n)
      const last = m[m.length - 1]
      return !isNaN(last) && last > p.threshold
    }
    case 'volume_ratio_gt': {
      const vr = volumeRatio(ctx.volumes, p.n)
      const last = vr[vr.length - 1]
      return !isNaN(last) && last > p.ratio
    }
    case 'obv_trend_up': {
      const o = obv(ctx.closes, ctx.volumes)
      const ma = sma(o, p.n)
      const last = ma[ma.length - 1]
      const lastObv = o[o.length - 1]
      return !isNaN(last) && lastObv > last
    }
    case 'stop_loss': {
      if (!ctx.position) return false
      const price = ctx.closes[ctx.closes.length - 1]
      return price <= ctx.position.costPrice * (1 - p.pct)
    }
    case 'take_profit': {
      if (!ctx.position) return false
      const price = ctx.closes[ctx.closes.length - 1]
      return price >= ctx.position.costPrice * (1 + p.pct)
    }
    case 'max_holding_days': {
      if (!ctx.position) return false
      return calcHoldingDays(ctx.position.buyDate, ctx.date) >= p.days
    }
    default:
      return false
  }
}

function evalConditionGroup(conditions: DslCondition[], logic: 'and' | 'or', ctx: EvalCtx): boolean {
  const results = conditions.map((c) => evalCondition(c, ctx))
  return logic === 'and' ? results.every(Boolean) : results.some(Boolean)
}

function calcHoldingDays(buyDate: string, currentDate: string): number {
  const d1 = new Date(`${buyDate}T00:00:00Z`).getTime()
  const d2 = new Date(`${currentDate}T00:00:00Z`).getTime()
  return Math.round((d2 - d1) / 86400000)
}

// ---------- 引擎主体 ----------
interface OpenPosition {
  code: string
  qty: number
  buyDate: string
  costPrice: number
}

interface PendingOrder {
  code: string
  side: 'buy' | 'sell'
  qty: number
  costPrice?: number // 卖出时携带原持仓成本
}

export function runBacktest(
  dsl: StrategyDSL,
  klines: Bar[],
  stockNames: Map<string, string>,
  benchmark: { date: string; close: number }[],
  params: BacktestParams
): BacktestResult {
  const p: BacktestParams = { ...DEFAULT_BACKTEST_PARAMS, ...params }
  let universe = prepareData(klines, stockNames, p.start, p.end)
  universe = applyUniverseFilters(universe, dsl)

  // 交易日历：合并全部候选股票日期 + 基准日期
  const allDates = new Set<string>()
  for (const info of universe.values()) for (const b of info.bars) allDates.add(b.date)
  for (const b of benchmark) allDates.add(b.date)
  const calendar = Array.from(allDates).sort()

  const benchIndex = new Map(benchmark.map((b) => [b.date, b.close]))

  let cash = p.initialCash
  const positions = new Map<string, OpenPosition>()
  const pendingOrders: PendingOrder[] = []
  const trades: BacktestTrade[] = []
  const equity: BacktestResult['equity'] = []
  const holdingStart = new Map<string, string>()

  const equityValue = (date: string): number => {
    let v = cash
    for (const pos of positions.values()) {
      const info = universe.get(pos.code)
      if (!info) continue
      const idx = info.dateIndex.get(date)
      if (idx != null) v += pos.qty * info.bars[idx].adjClose
      else if (info.bars.length > 0) {
        // 当日无 bar（停牌）：用最近收盘估值
        v += pos.qty * info.bars[Math.min(info.bars.length - 1, 0)].adjClose
      }
    }
    return v
  }

  for (const date of calendar) {
    // 1) 执行昨日挂单（次日开盘成交，含滑点与涨跌停校验）
    for (const order of [...pendingOrders]) {
      const info = universe.get(order.code)
      if (!info) continue
      const idx = info.dateIndex.get(date)
      if (idx == null) continue // 当日停牌无数据 → 挂单顺延
      const bar = info.bars[idx]
      const prevBar = idx > 0 ? info.bars[idx - 1] : undefined
      const suspended = bar.volume <= 0
      if (suspended) continue // 停牌 → 顺延

      if (order.side === 'buy') {
        const { up } = prevBar ? limitPrices(order.code, info.name, prevBar.close) : { up: Infinity }
        if (bar.open >= up * 0.999) continue // 开盘即涨停 → 不成交，挂单取消
        const price = bar.open * (1 + p.slippage)
        const lots = Math.floor(order.qty / LOT_SIZE)
        const finalQty = lots * LOT_SIZE
        if (finalQty <= 0) continue
        const amount = price * finalQty
        const fee = calcFee('buy', amount, p)
        if (amount + fee > cash) {
          // 资金不足：按可买数量重算
          const affordableLots = Math.floor((cash / (price * (1 + p.commissionRate + p.transferFeeRate) + p.minCommission / LOT_SIZE)) / LOT_SIZE)
          if (affordableLots <= 0) continue
          const qty2 = affordableLots * LOT_SIZE
          const amount2 = price * qty2
          const fee2 = calcFee('buy', amount2, p)
          if (amount2 + fee2 > cash) continue
          cash -= amount2 + fee2
          positions.set(order.code, { code: order.code, qty: qty2, buyDate: date, costPrice: price + fee2 / qty2 })
          holdingStart.set(order.code, date)
          trades.push({ runId: '', code: order.code, side: 'buy', price, qty: qty2, fee: fee2, tradedAt: date, note: 'opening' })
        } else {
          cash -= amount + fee
          positions.set(order.code, { code: order.code, qty: finalQty, buyDate: date, costPrice: price + fee / finalQty })
          holdingStart.set(order.code, date)
          trades.push({ runId: '', code: order.code, side: 'buy', price, qty: finalQty, fee, tradedAt: date, note: 'opening' })
        }
      } else {
        const pos = positions.get(order.code)
        if (!pos) continue
        // T+1 校验：建仓当日不可卖
        if (date === pos.buyDate) continue
        const { down } = prevBar ? limitPrices(order.code, info.name, prevBar.close) : { down: 0 }
        if (bar.open <= down * 1.001) continue // 开盘即跌停 → 不成交，挂单顺延（保留仓位）
        const price = bar.open * (1 - p.slippage)
        const qty = Math.min(order.qty, pos.qty)
        const amount = price * qty
        const fee = calcFee('sell', amount, p)
        cash += amount - fee
        const pnl = (price - fee / qty - pos.costPrice) * qty
        pos.qty -= qty
        trades.push({ runId: '', code: order.code, side: 'sell', price, qty, fee, tradedAt: date, pnl })
        if (pos.qty <= 0) {
          positions.delete(order.code)
          holdingStart.delete(order.code)
        }
      }
    }
    pendingOrders.length = 0

    // 2) 收盘后评估信号（基于当日收盘数据，次日开盘成交）
    for (const [code, info] of universe) {
      const idx = info.dateIndex.get(date)
      if (idx == null) continue
      const bar = info.bars[idx]
      if (bar.volume <= 0) continue // 停牌不可评估

      const window = info.bars.slice(0, idx + 1)
      const ctx: EvalCtx = {
        closes: window.map((b) => b.adjClose),
        highs: window.map((b) => b.adjHigh),
        lows: window.map((b) => b.adjLow),
        volumes: window.map((b) => b.volume),
        date
      }
      const pos = positions.get(code)
      const holding = holdingStart.get(code)

      // 卖出信号
      if (pos && holding) {
        const exitCtx: EvalCtx = {
          ...ctx,
          position: { buyDate: holding, costPrice: pos.costPrice, qty: pos.qty }
        }
        if (evalConditionGroup(dsl.exit.conditions, dsl.exit.logic, exitCtx)) {
          pendingOrders.push({ code, side: 'sell', qty: pos.qty, costPrice: pos.costPrice })
        }
      }

      // 买入信号
      if (!pos) {
        if (evalConditionGroup(dsl.entry.conditions, dsl.entry.logic, ctx)) {
          pendingOrders.push({ code, side: 'buy', qty: 0 }) // qty 在成交时按资金分配
        }
      }
    }

    // 3) 买入资金分配：等权/等现金（在信号集合内均分可用现金）
    const buyOrders = pendingOrders.filter((o) => o.side === 'buy')
    if (buyOrders.length > 0 && positions.size < dsl.portfolio.max_positions) {
      const slots = dsl.portfolio.max_positions - positions.size
      const selected = buyOrders.slice(0, Math.min(slots, buyOrders.length))
      const perSlot = cash / selected.length
      // 资金预算：以信号日收盘价估算手数（开盘价差异由成交逻辑兜底）
      for (const o of selected) {
        const info = universe.get(o.code)
        const idx = info?.dateIndex.get(date)
        if (idx == null || !info) continue
        const estPrice = info.bars[idx].adjClose * (1 + p.slippage)
        o.qty = Math.floor(perSlot / (estPrice * (1 + p.commissionRate + p.transferFeeRate)) / LOT_SIZE) * LOT_SIZE
      }
      // 丢弃超出仓位上限的信号
      pendingOrders.forEach((o, i) => {
        if (o.side === 'buy' && !selected.includes(o)) pendingOrders.splice(i, 1)
      })
    } else if (buyOrders.length > 0) {
      // 仓位已满：取消全部买入挂单
      for (let i = pendingOrders.length - 1; i >= 0; i--) {
        if (pendingOrders[i].side === 'buy') pendingOrders.splice(i, 1)
      }
    }

    // 4) 记录当日净值
    const eq = equityValue(date)
    const bench = benchIndex.get(date)
    equity.push({
      date,
      equity: Math.round(eq * 100) / 100,
      benchmark: bench != null ? bench : equity[equity.length - 1]?.benchmark ?? 1
    })
  }

  // 5) 期末强平估值（不计交易，直接按最后收盘估值折算现金）
  const lastDate = calendar[calendar.length - 1] ?? p.end
  for (const [code, pos] of positions) {
    const info = universe.get(code)
    if (!info || info.bars.length === 0) continue
    const idx = info.dateIndex.get(lastDate)
    const close = idx != null ? info.bars[idx].adjClose : info.bars[info.bars.length - 1].adjClose
    trades.push({
      runId: '',
      code,
      side: 'sell',
      price: close,
      qty: pos.qty,
      fee: 0,
      tradedAt: lastDate,
      pnl: (close - pos.costPrice) * pos.qty,
      note: 'forced_close'
    })
  }

  const metrics = computeMetrics(equity, trades, calendar, p)
  return { params: p, equity, trades, metrics }
}

// ---------- 绩效指标 ----------
export function computeMetrics(
  equity: BacktestResult['equity'],
  trades: BacktestTrade[],
  calendar: string[],
  p: BacktestParams
): BacktestMetrics {
  const dailyReturns: number[] = []
  for (let i = 1; i < equity.length; i++) {
    dailyReturns.push(equity[i].equity / equity[i - 1].equity - 1)
  }
  const totalReturn = equity.length > 0 ? equity[equity.length - 1].equity / p.initialCash - 1 : 0
  const years = Math.max(dailyReturns.length / 244, 1 / 244)
  const annualReturn = Math.pow(1 + totalReturn, 1 / years) - 1

  // 最大回撤
  let peak = equity[0]?.equity ?? p.initialCash
  let maxDd = 0
  for (const e of equity) {
    peak = Math.max(peak, e.equity)
    maxDd = Math.max(maxDd, peak > 0 ? (peak - e.equity) / peak : 0)
  }

  const mean = dailyReturns.length > 0 ? dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length : 0
  const variance =
    dailyReturns.length > 0 ? dailyReturns.reduce((a, b) => a + (b - mean) ** 2, 0) / dailyReturns.length : 0
  const annualVol = Math.sqrt(variance) * Math.sqrt(244)
  const rf = 0.02
  const sharpe = annualVol > 0 ? (annualReturn - rf) / annualVol : 0
  const downside =
    dailyReturns.length > 0
      ? Math.sqrt(dailyReturns.filter((r) => r < 0).reduce((a, b) => a + b ** 2, 0) / dailyReturns.length) *
        Math.sqrt(244)
      : 0
  const sortino = downside > 0 ? (annualReturn - rf) / downside : 0
  const calmar = maxDd > 0 ? annualReturn / maxDd : 0

  // 交易统计
  const sells = trades.filter((t) => t.side === 'sell')
  const wins = sells.filter((t) => (t.pnl ?? 0) > 0)
  const losses = sells.filter((t) => (t.pnl ?? 0) < 0)
  const winRate = sells.length > 0 ? wins.length / sells.length : 0
  const avgWin = wins.length > 0 ? wins.reduce((a, t) => a + (t.pnl ?? 0), 0) / wins.length : 0
  const avgLoss = losses.length > 0 ? -losses.reduce((a, t) => a + (t.pnl ?? 0), 0) / losses.length : 0
  const profitLossRatio = avgLoss > 0 ? avgWin / avgLoss : 0

  // 平均持仓天数（按卖出配对估算：用买入→卖出间隔）
  const buyTimes = new Map<string, string[]>()
  const holdingDays: number[] = []
  for (const t of trades) {
    if (t.side === 'buy') {
      const arr = buyTimes.get(t.code) ?? []
      arr.push(t.tradedAt)
      buyTimes.set(t.code, arr)
    } else {
      const arr = buyTimes.get(t.code) ?? []
      if (arr.length > 0) {
        const buyDate = arr.shift()!
        holdingDays.push(calcHoldingDays(buyDate, t.tradedAt))
        buyTimes.set(t.code, arr)
      }
    }
  }
  const avgHoldingDays =
    holdingDays.length > 0 ? holdingDays.reduce((a, b) => a + b, 0) / holdingDays.length : 0

  // 换手率（成交额 / 平均权益）
  const avgEquity = equity.length > 0 ? equity.reduce((a, e) => a + e.equity, 0) / equity.length : p.initialCash
  const totalTurnover =
    trades.reduce((a, t) => a + t.price * t.qty, 0) / Math.max(avgEquity, 1)

  // 基准与超额
  const benchReturn =
    equity.length > 1 && equity[0].benchmark > 0 ? equity[equity.length - 1].benchmark / equity[0].benchmark - 1 : 0
  const excessReturn = totalReturn - benchReturn
  const benchDaily: number[] = []
  for (let i = 1; i < equity.length; i++) {
    benchDaily.push(equity[i].benchmark / equity[i - 1].benchmark - 1)
  }
  const { alpha, beta, informationRatio } = computeAlphaBeta(dailyReturns, benchDaily, rf, years)

  // 月度收益
  const monthlyReturns: Record<string, number> = {}
  let monthStart = equity[0]?.equity ?? p.initialCash
  let monthKey = equity[0] ? equity[0].date.slice(0, 7) : ''
  for (const e of equity) {
    const key = e.date.slice(0, 7)
    if (key !== monthKey) {
      monthlyReturns[monthKey] = e.equity / monthStart - 1
      monthStart = e.equity
      monthKey = key
    }
  }
  if (monthKey) monthlyReturns[monthKey] = (equity[equity.length - 1].equity / monthStart) - 1

  void calendar
  return {
    totalReturn,
    annualReturn,
    maxDrawdown: maxDd,
    annualVolatility: annualVol,
    sharpe,
    sortino,
    calmar,
    tradeCount: trades.length,
    winRate,
    profitLossRatio,
    avgHoldingDays,
    turnover: totalTurnover,
    benchmarkReturn: benchReturn,
    excessReturn,
    alpha,
    beta,
    informationRatio,
    monthlyReturns
  }
}

function computeAlphaBeta(
  daily: number[],
  benchDaily: number[],
  rf: number,
  years: number
): { alpha: number; beta: number; informationRatio: number } {
  const n = Math.min(daily.length, benchDaily.length)
  if (n < 2) return { alpha: 0, beta: 0, informationRatio: 0 }
  const x = benchDaily.slice(0, n)
  const y = daily.slice(0, n)
  const mx = x.reduce((a, b) => a + b, 0) / n
  const my = y.reduce((a, b) => a + b, 0) / n
  let cov = 0
  let vx = 0
  for (let i = 0; i < n; i++) {
    cov += (x[i] - mx) * (y[i] - my)
    vx += (x[i] - mx) ** 2
  }
  const beta = vx > 0 ? cov / vx : 0
  const alphaAnnual = (my - beta * mx - rf / 244) * 244
  const residuals = y.map((yi, i) => yi - beta * x[i])
  const active = residuals.map((r) => r - (residuals.reduce((a, b) => a + b, 0) / n))
  const volActive = Math.sqrt(active.reduce((a, b) => a + b ** 2, 0) / n) * Math.sqrt(244)
  const informationRatio = volActive > 0 ? (my - mx) * 244 / volActive : 0
  void years
  return { alpha: alphaAnnual, beta, informationRatio }
}
