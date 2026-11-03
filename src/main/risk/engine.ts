/**
 * 风控引擎：所有交易建议（信号）产出前必经校验。
 * 规则 = 声明式配置 + 确定性检查函数；结果结构化输出并落 risk_check_result。
 * 默认规则见《实现方案-数据模型与模块设计》§7.2。
 */
import type { Position, RiskCheck, RiskCheckResult } from '@shared/types'
import { priceLimitRate } from '@shared/constants'

// ---------- 默认规则（账户级可配） ----------
export const DEFAULT_RISK_RULES: Record<string, Record<string, unknown>> = {
  position_limit: { maxPct: 0.2 }, // 单标的仓位上限 20%
  total_position_limit: { maxPct: 0.8 }, // 总仓位上限 80%
  daily_signal_limit: { maxCount: 10 }, // 单日新增信号上限
  exclude_st: {}, // 排除 ST
  limit_protection: {}, // 涨跌停防护
  stop_loss_protect: { pct: 0.08 }, // 浮亏 8% 强制止损建议
  market_circuit_breaker: { indexDropPct: 0.05 }, // 指数跌 5% 熔断买入
  price_deviation: { maxPct: 0.03 } // 价格偏离 3% 需人工复核
}

// ---------- 检查上下文 ----------
export interface RiskCheckContext {
  accountId: string
  totalAssets: number // 账户总资产
  cash: number
  positions: Position[]
  signalsToday: number // 今日已产出信号数
  signal?: {
    code: string
    name: string
    side: 'buy' | 'sell'
    qty: number
    refPrice: number
    latestPrice?: number
  }
  market?: {
    indexPctChg: number // 指数当日涨跌幅
    prevCloseOfStock?: number
  }
}

interface RuleDef {
  key: string
  check(ctx: RiskCheckContext, params: Record<string, unknown>): RiskCheck
}

// ---------- 规则实现 ----------
function num(params: Record<string, unknown>, key: string, fallback: number): number {
  const v = params[key]
  return typeof v === 'number' ? v : fallback
}

const RULES: RuleDef[] = [
  {
    key: 'position_limit',
    check(ctx, params) {
      if (!ctx.signal || ctx.signal.side !== 'buy') return ok('position_limit')
      const maxPct = num(params, 'maxPct', 0.2)
      const targetValue = ctx.signal.qty * ctx.signal.refPrice
      if (ctx.totalAssets > 0 && targetValue / ctx.totalAssets > maxPct) {
        return reject('position_limit', `单标的仓位 ${((targetValue / ctx.totalAssets) * 100).toFixed(1)}% 超过上限 ${maxPct * 100}%`)
      }
      return ok('position_limit')
    }
  },
  {
    key: 'total_position_limit',
    check(ctx, params) {
      if (!ctx.signal || ctx.signal.side !== 'buy') return ok('total_position_limit')
      const maxPct = num(params, 'maxPct', 0.8)
      const currentValue = ctx.positions.reduce((sum, p) => sum + p.qty * p.costPrice, 0)
      const targetValue = ctx.signal.qty * ctx.signal.refPrice
      if (ctx.totalAssets > 0 && (currentValue + targetValue) / ctx.totalAssets > maxPct) {
        return reject('total_position_limit', `总仓位将超过 ${maxPct * 100}% 上限`)
      }
      return ok('total_position_limit')
    }
  },
  {
    key: 'daily_signal_limit',
    check(ctx, params) {
      const maxCount = num(params, 'maxCount', 10)
      if (ctx.signalsToday >= maxCount) {
        return reject('daily_signal_limit', `今日信号数已达上限 ${maxCount} 条`)
      }
      return ok('daily_signal_limit')
    }
  },
  {
    key: 'exclude_st',
    check(ctx) {
      if (ctx.signal && ctx.signal.name.includes('ST')) {
        return reject('exclude_st', `标的 ${ctx.signal.name} 为 ST/*ST，禁止建议`)
      }
      return ok('exclude_st')
    }
  },
  {
    key: 'limit_protection',
    check(ctx) {
      if (!ctx.signal || ctx.signal.latestPrice == null || !ctx.market?.prevCloseOfStock) return ok('limit_protection')
      const rate = priceLimitRate(ctx.signal.code, ctx.signal.name)
      const up = ctx.market.prevCloseOfStock * (1 + rate)
      const down = ctx.market.prevCloseOfStock * (1 - rate)
      if (ctx.signal.side === 'buy' && ctx.signal.latestPrice >= up * 0.999) {
        return reject('limit_protection', '标的已涨停（或接近涨停），禁止买入建议')
      }
      if (ctx.signal.side === 'sell' && ctx.signal.latestPrice <= down * 1.001) {
        return reject('limit_protection', '标的已跌停（或接近跌停），无法卖出')
      }
      return ok('limit_protection')
    }
  },
  {
    key: 'stop_loss_protect',
    check(ctx, params) {
      const pct = num(params, 'pct', 0.08)
      if (!ctx.signal) return ok('stop_loss_protect')
      const pos = ctx.positions.find((p) => p.code === ctx.signal!.code)
      if (pos && ctx.signal.latestPrice != null) {
        const loss = (ctx.signal.latestPrice - pos.costPrice) / pos.costPrice
        if (loss <= -pct && ctx.signal.side !== 'sell') {
          return degrade('stop_loss_protect', `持仓浮亏 ${(loss * 100).toFixed(1)}% 超过 ${pct * 100}% 止损线，建议优先止损`)
        }
      }
      return ok('stop_loss_protect')
    }
  },
  {
    key: 'market_circuit_breaker',
    check(ctx, params) {
      const dropPct = num(params, 'indexDropPct', 0.05)
      if (ctx.signal?.side === 'buy' && ctx.market && ctx.market.indexPctChg <= -dropPct) {
        return reject('market_circuit_breaker', `指数当日跌幅 ${(ctx.market.indexPctChg * 100).toFixed(1)}% 超过熔断线，暂停买入建议`)
      }
      return ok('market_circuit_breaker')
    }
  },
  {
    key: 'price_deviation',
    check(ctx, params) {
      const maxPct = num(params, 'maxPct', 0.03)
      if (!ctx.signal || ctx.signal.latestPrice == null) return ok('price_deviation')
      const deviation = Math.abs(ctx.signal.latestPrice - ctx.signal.refPrice) / ctx.signal.refPrice
      if (deviation > maxPct) {
        return degrade('price_deviation', `参考价与最新价偏离 ${(deviation * 100).toFixed(1)}%，信号需人工复核`)
      }
      return ok('price_deviation')
    }
  }
]

function ok(rule: string): RiskCheck {
  return { rule, result: 'ok', message: '通过' }
}
function reject(rule: string, message: string): RiskCheck {
  return { rule, result: 'reject', message }
}
function degrade(rule: string, message: string): RiskCheck {
  return { rule, result: 'degrade', message }
}

// ---------- 对外接口 ----------
export interface EnabledRule {
  key: string
  params: Record<string, unknown>
}

/** 执行风控检查（纯函数）：返回每个启用规则的检查结果与总体结论 */
export function runRiskCheck(ctx: RiskCheckContext, enabledRules: EnabledRule[] = defaultEnabledRules()): RiskCheckResult {
  const checks: RiskCheck[] = []
  for (const er of enabledRules) {
    const def = RULES.find((r) => r.key === er.key)
    if (!def) continue
    try {
      checks.push(def.check(ctx, er.params))
    } catch (e) {
      checks.push({ rule: er.key, result: 'degrade', message: `规则执行异常: ${(e as Error).message}` })
    }
  }
  const passed = checks.every((c) => c.result !== 'reject')
  return {
    refType: 'signal',
    refId: ctx.signal?.code ?? '',
    passed,
    checks,
    checkedAt: new Date().toISOString()
  }
}

/** 默认启用全部内置规则 */
export function defaultEnabledRules(): EnabledRule[] {
  return Object.entries(DEFAULT_RISK_RULES).map(([key, params]) => ({ key, params }))
}

/** 从数据库行转换为启用规则列表 */
export function enabledRulesFromRows(rows: { rule_key: string; params_json: string; enabled: number }[]): EnabledRule[] {
  return rows
    .filter((r) => r.enabled === 1)
    .map((r) => ({ key: r.rule_key, params: safeParse(r.params_json) }))
}

function safeParse(json: string): Record<string, unknown> {
  try {
    return JSON.parse(json) as Record<string, unknown>
  } catch {
    return {}
  }
}
