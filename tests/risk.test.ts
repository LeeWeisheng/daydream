/**
 * 风控引擎单元测试：规则检查与总体结论。
 */
import { describe, expect, it } from 'vitest'
import { runRiskCheck, defaultEnabledRules, type RiskCheckContext } from '../src/main/quant/risk'

function baseCtx(overrides: Partial<RiskCheckContext> = {}): RiskCheckContext {
  return {
    accountId: 'acc1',
    totalAssets: 100_000,
    cash: 100_000,
    positions: [],
    signalsToday: 0,
    signal: { code: '600000', name: '浦发银行', side: 'buy', qty: 1000, refPrice: 10, latestPrice: 10 },
    market: { indexPctChg: 0, prevCloseOfStock: 10 },
    ...overrides
  }
}

describe('风控引擎', () => {
  it('正常信号全部通过', () => {
    const result = runRiskCheck(baseCtx(), defaultEnabledRules())
    expect(result.passed).toBe(true)
    expect(result.checks.every((c) => c.result === 'ok')).toBe(true)
  })

  it('单标的仓位超限被拒绝', () => {
    const ctx = baseCtx({ signal: { code: '600000', name: '浦发银行', side: 'buy', qty: 5000, refPrice: 10, latestPrice: 10 } })
    const result = runRiskCheck(ctx, defaultEnabledRules())
    expect(result.passed).toBe(false)
    expect(result.checks.find((c) => c.rule === 'position_limit')?.result).toBe('reject')
  })

  it('ST 标的被拒绝', () => {
    const ctx = baseCtx({ signal: { code: '600000', name: 'ST 某股', side: 'buy', qty: 100, refPrice: 10, latestPrice: 10 } })
    const result = runRiskCheck(ctx, defaultEnabledRules())
    expect(result.passed).toBe(false)
    expect(result.checks.find((c) => c.rule === 'exclude_st')?.result).toBe('reject')
  })

  it('单日信号数超限被拒绝', () => {
    const ctx = baseCtx({ signalsToday: 10 })
    const result = runRiskCheck(ctx, defaultEnabledRules())
    expect(result.passed).toBe(false)
    expect(result.checks.find((c) => c.rule === 'daily_signal_limit')?.result).toBe('reject')
  })

  it('指数暴跌熔断买入', () => {
    const ctx = baseCtx({ market: { indexPctChg: -0.06, prevCloseOfStock: 10 } })
    const result = runRiskCheck(ctx, defaultEnabledRules())
    expect(result.passed).toBe(false)
    expect(result.checks.find((c) => c.rule === 'market_circuit_breaker')?.result).toBe('reject')
  })

  it('涨停不买（涨跌停防护）', () => {
    const ctx = baseCtx({
      signal: { code: '600000', name: '浦发银行', side: 'buy', qty: 100, refPrice: 10, latestPrice: 10.99 },
      market: { indexPctChg: 0, prevCloseOfStock: 10 }
    })
    const result = runRiskCheck(ctx, defaultEnabledRules())
    expect(result.checks.find((c) => c.rule === 'limit_protection')?.result).toBe('reject')
  })

  it('价格偏离超限降级为需人工复核', () => {
    const ctx = baseCtx({
      signal: { code: '600000', name: '浦发银行', side: 'buy', qty: 100, refPrice: 10, latestPrice: 10.5 }
    })
    const result = runRiskCheck(ctx, defaultEnabledRules())
    expect(result.checks.find((c) => c.rule === 'price_deviation')?.result).toBe('degrade')
  })

  it('禁用规则不参与检查', () => {
    const rules = defaultEnabledRules().filter((r) => r.key !== 'exclude_st')
    const ctx = baseCtx({ signal: { code: '600000', name: 'ST 某股', side: 'buy', qty: 100, refPrice: 10, latestPrice: 10 } })
    const result = runRiskCheck(ctx, rules)
    expect(result.passed).toBe(true)
  })
})
