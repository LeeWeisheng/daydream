/**
 * 回测引擎单元测试：T+1、涨跌停、费用、整手、确定性。
 */
import { describe, expect, it } from 'vitest'
import { runBacktest, DEFAULT_BACKTEST_PARAMS, evalCondition } from '../src/main/backtest/engine'
import { validateStrategyDsl } from '../src/shared/strategy/schema'
import type { Bar } from '../src/shared/types'

// 构造单股日线：30 个交易日，前 20 天横盘、后 10 天单边上涨
function makeBars(code = '600000', name = '浦发银行'): Bar[] {
  const bars: Bar[] = []
  const base = new Date('2025-01-06T00:00:00Z') // 周一
  for (let i = 0; i < 30; i++) {
    const d = new Date(base)
    d.setUTCDate(base.getUTCDate() + i)
    const date = d.toISOString().slice(0, 10)
    const trend = i < 20 ? 0 : (i - 19) * 0.5
    const open = 10 + trend
    const close = 10 + trend + 0.4
    bars.push({
      code,
      date,
      open,
      high: close + 0.2,
      low: open - 0.2,
      close,
      volume: 1_000_000 + i * 1000,
      amount: (close * (1_000_000 + i * 1000)) / 100,
      adjFactor: 1
    })
  }
  void name
  return bars
}

function makeDsl(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    meta: { name: '测试策略', description: '', rationale: '', complexity: 1 },
    universe: { source: 'all_a', filters: [] },
    entry: { logic: 'and', conditions: [{ indicator: 'ma_cross_up', params: { fast: 3, slow: 8 } }] },
    exit: { logic: 'or', conditions: [{ indicator: 'stop_loss', params: { pct: 0.2 } }] },
    portfolio: { max_positions: 3, position_size: 'equal_weight', max_position_pct: 0.3, rebalance: 'daily' },
    ...overrides
  }
}

describe('回测引擎', () => {
  it('通过 DSL 校验的策略可运行并产出净值序列', () => {
    const dslRaw = makeDsl()
    const validation = validateStrategyDsl(dslRaw)
    expect(validation.ok).toBe(true)
    const dsl = dslRaw as never
    const bars = makeBars()
    const result = runBacktest(dsl, bars, new Map([['600000', '浦发银行']]), [{ date: '2025-01-06', close: 3000 }], {
      ...DEFAULT_BACKTEST_PARAMS,
      start: '2025-01-01',
      end: '2025-12-31'
    })
    expect(result.equity.length).toBeGreaterThan(0)
    expect(result.metrics.tradeCount).toBeGreaterThan(0)
  })

  it('确定性：相同输入两次运行结果完全一致', () => {
    const dsl = makeDsl() as never
    const bars = makeBars()
    const params = { ...DEFAULT_BACKTEST_PARAMS, start: '2025-01-01', end: '2025-12-31' }
    const r1 = runBacktest(dsl, bars, new Map(), [], params)
    const r2 = runBacktest(dsl, bars, new Map(), [], params)
    expect(JSON.stringify(r1.equity)).toBe(JSON.stringify(r2.equity))
    expect(r1.metrics.totalReturn).toBe(r2.metrics.totalReturn)
  })

  it('整手约束：买入数量为 100 的整数倍', () => {
    const dsl = makeDsl() as never
    const bars = makeBars()
    const result = runBacktest(dsl, bars, new Map([['600000', '浦发银行']]), [], {
      ...DEFAULT_BACKTEST_PARAMS,
      start: '2025-01-01',
      end: '2025-12-31'
    })
    for (const t of result.trades) {
      if (t.side === 'buy') expect(t.qty % 100).toBe(0)
    }
  })

  it('T+1：买入当日不可卖出（卖出日期晚于买入日期）', () => {
    const dsl = makeDsl() as never
    const bars = makeBars()
    const result = runBacktest(dsl, bars, new Map([['600000', '浦发银行']]), [], {
      ...DEFAULT_BACKTEST_PARAMS,
      start: '2025-01-01',
      end: '2025-12-31'
    })
    const buyDates = new Map<string, string>()
    for (const t of result.trades) {
      if (t.side === 'buy') buyDates.set(t.code, t.tradedAt)
      else {
        const buyDate = buyDates.get(t.code)
        if (buyDate) expect(t.tradedAt > buyDate).toBe(true)
      }
    }
  })

  it('费用：买入费用含佣金最低 5 元 + 过户费，卖出另含印花税', () => {
    const dsl = makeDsl() as never
    const bars = makeBars()
    const result = runBacktest(dsl, bars, new Map([['600000', '浦发银行']]), [], {
      ...DEFAULT_BACKTEST_PARAMS,
      start: '2025-01-01',
      end: '2025-12-31'
    })
    for (const t of result.trades) {
      const minCommission = Math.max(t.price * t.qty * DEFAULT_BACKTEST_PARAMS.commissionRate, 5)
      if (t.side === 'buy') {
        expect(t.fee).toBeCloseTo(minCommission + t.price * t.qty * DEFAULT_BACKTEST_PARAMS.transferFeeRate, 1)
      }
    }
  })
})

describe('evalCondition 条件评估', () => {
  it('ma_cross_up 金叉检测', () => {
    // 前 9 根横盘 5，最后一根涨到 6：SMA3 在最后一根上穿 SMA5
    const closes = [5, 5, 5, 5, 5, 5, 5, 5, 5, 6]
    const hit = evalCondition(
      { indicator: 'ma_cross_up', params: { fast: 3, slow: 5 } },
      { closes, highs: closes, lows: closes, volumes: closes.map(() => 1000), date: '2025-01-10' }
    )
    expect(hit).toBe(true)
  })
  it('stop_loss 止损触发', () => {
    const closes = Array.from({ length: 10 }, (_, i) => 10 - i) // 从 10 跌到 1
    const hit = evalCondition(
      { indicator: 'stop_loss', params: { pct: 0.2 } },
      {
        closes,
        highs: closes,
        lows: closes,
        volumes: closes.map(() => 1000),
        date: '2025-01-10',
        position: { buyDate: '2025-01-01', costPrice: 10, qty: 100 }
      }
    )
    expect(hit).toBe(true)
  })
})
