/**
 * 自动运行（runner）：运行中的策略按调度产出交易建议（信号）。
 * 调度默认每交易日 15:05（收盘后），用收盘实时快照（当日收盘价）；
 * 信号产出前必经风控引擎校验；信号仅推送，人工执行后反馈闭环。
 */
import type { Strategy } from '@shared/types'
import { nowIso, queryAll, run } from '../db'
import { audit } from '../services/audit'
import { logger } from '../services/logger'
import { parseAndValidateDsl } from '@shared/strategy/schema'
import { evalCondition, type PositionCtx } from '../backtest/engine'
import { sma, crossDetect, macd, momentum, volumeRatio, rsi, boll, obv } from '../backtest/indicators'
import { runRiskCheck, enabledRulesFromRows, type EnabledRule } from '../risk/engine'
import { getQuotes } from '../data/service'
import { agentEventBus } from '../agent/events'
import { persistSignal } from '../agent/tools'
import { LOT_SIZE } from '@shared/constants'

/** 运行决策：对全部 active 策略跑一遍信号评估（策略全局共享，信号/持仓按活跃账户隔离） */
export async function runDailyDecision(accountId: string): Promise<{ signals: number }> {
  const strategies = queryAll<Strategy & Record<string, unknown>>(
    "SELECT * FROM strategy WHERE status IN ('active', 'paused')",
    []
  )
  let total = 0
  for (const strategy of strategies) {
    try {
      total += await evaluateStrategy(accountId, strategy)
    } catch (e) {
      logger.warn(`[runner] strategy ${strategy.id} evaluate failed: ${(e as Error).message}`)
    }
  }
  logger.info(`[runner] daily decision done: ${total} signals`)
  return { signals: total }
}

async function evaluateStrategy(accountId: string, strategy: Strategy & Record<string, unknown>): Promise<number> {
  const { dsl } = parseAndValidateDsl(String(strategy.dsl_json ?? ''))
  if (!dsl) throw new Error('策略 DSL 非法')
  // 运行实例（无则创建）
  let instance = queryAll<{ id: string; strategy_version_id: string }>(
    'SELECT id, strategy_version_id FROM run_instance WHERE strategy_id = ? AND status = ?',
    [strategy.id, 'active']
  )[0]
  if (!instance) {
    const versionId = queryAll<{ id: string }>('SELECT id FROM strategy_version WHERE strategy_id = ? ORDER BY version DESC LIMIT 1', [strategy.id])[0]?.id
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    run('INSERT INTO run_instance (id, strategy_id, strategy_version_id, status, started_at) VALUES (?, ?, ?, ?, ?)', [
      id,
      strategy.id,
      versionId ?? '',
      'active',
      nowIso()
    ])
    instance = { id, strategy_version_id: versionId ?? '' }
  }

  // 候选池 = 满足 universe 过滤 + entry 条件的股票（用本地日线评估）
  const candidates = evaluateCandidates(accountId, strategy, dsl)
  // 持仓（人工维护）
  const positions = queryAll<{ code: string; qty: number; cost_price: number }>(
    'SELECT code, qty, cost_price FROM position WHERE account_id = ?',
    [accountId]
  )
  const rules = enabledRulesFromRows(
    queryAll<{ rule_key: string; params_json: string; enabled: number }>('SELECT rule_key, params_json, enabled FROM risk_rule WHERE account_id = ?', [accountId])
  )
  const signalsToday = (
    queryAll<{ c: number }>(
      "SELECT COUNT(*) AS c FROM signal WHERE account_id = ? AND created_at >= datetime('now', 'start of day')",
      [accountId]
    )[0] ?? { c: 0 }
  ).c as number

  // 市场状态（熔断规则）
  const indexRow = queryAll<{ close: number }>(
    "SELECT close FROM index_daily WHERE index_code = '000300' ORDER BY date DESC LIMIT 2",
    []
  )
  const indexPctChg = indexRow.length >= 2 ? indexRow[0].close / indexRow[1].close - 1 : 0

  let emitted = 0
  // 卖出信号：持仓中满足 exit 条件的标的
  for (const pos of positions) {
    const exitHit = evaluateExit(strategy, dsl, pos)
    if (!exitHit) continue
    const quote = (await getQuotes([pos.code], true))[0]
    const refPrice = quote?.price ?? 0
    if (refPrice <= 0) continue
    const risk = runRiskCheck(
      {
        accountId,
        totalAssets: 0,
        cash: 0,
        positions: positions.map((p) => ({ accountId, code: p.code, qty: p.qty, costPrice: p.cost_price, updatedAt: '' })),
        signalsToday: signalsToday + emitted,
        signal: { code: pos.code, name: quote?.name ?? pos.code, side: 'sell', qty: pos.qty, refPrice, latestPrice: quote?.price },
        market: { indexPctChg, prevCloseOfStock: quote?.prevClose }
      },
      rules
    )
    persistRiskResult(accountId, 'signal', pos.code, risk)
    if (!risk.passed) continue
    persistSignal(accountId, {
      runId: instance.id,
      strategyId: strategy.id,
      code: pos.code,
      side: 'sell',
      qty: pos.qty,
      refPrice,
      basisJson: JSON.stringify({ trigger: 'exit_condition', strategy: strategy.name }),
      riskJson: JSON.stringify(risk),
      status: 'pending_execution'
    })
    emitted += 1
  }

  // 买入信号：候选池（持仓外）满足 entry 条件
  const heldCodes = new Set(positions.map((p) => p.code))
  const maxPositions = dsl.portfolio.max_positions
  const freeSlots = Math.max(maxPositions - positions.length, 0)
  const buyCodes = candidates.filter((c) => !heldCodes.has(c.code)).slice(0, Math.min(freeSlots, 5))
  const quotes = await getQuotes(buyCodes.map((c) => c.code), true)
  for (const candidate of buyCodes) {
    const quote = quotes.find((q) => q.code === candidate.code)
    if (!quote || quote.price <= 0) continue
    const refPrice = quote.price
    // 数量：以账户资产均分估算（无资产快照时默认 10 万元账户）
    const snap = queryAll<{ total_assets: number }>('SELECT total_assets FROM account_snapshot WHERE account_id = ? ORDER BY date DESC LIMIT 1', [accountId])[0]
    const totalAssets = snap?.total_assets ?? 100_000
    const budget = (totalAssets * Math.min(dsl.portfolio.max_position_pct, 0.2)) / 1
    const qty = Math.max(Math.floor(budget / (refPrice * (1.001)) / LOT_SIZE) * LOT_SIZE, LOT_SIZE)
    const risk = runRiskCheck(
      {
        accountId,
        totalAssets,
        cash: 0,
        positions: positions.map((p) => ({ accountId, code: p.code, qty: p.qty, costPrice: p.cost_price, updatedAt: '' })),
        signalsToday: signalsToday + emitted,
        signal: { code: candidate.code, name: quote.name, side: 'buy', qty, refPrice, latestPrice: quote.price },
        market: { indexPctChg, prevCloseOfStock: quote.prevClose }
      },
      rules
    )
    persistRiskResult(accountId, 'signal', candidate.code, risk)
    if (!risk.passed) continue
    persistSignal(accountId, {
      runId: instance.id,
      strategyId: strategy.id,
      code: candidate.code,
      side: 'buy',
      qty,
      refPrice,
      basisJson: JSON.stringify({ trigger: 'entry_condition', strategy: strategy.name, reason: candidate.reason }),
      riskJson: JSON.stringify(risk),
      status: 'pending_execution'
    })
    emitted += 1
  }
  return emitted
}

function persistRiskResult(accountId: string, refType: string, refId: string, risk: { passed: boolean; checks: unknown[] }): void {
  run('INSERT INTO risk_check_result (account_id, ref_type, ref_id, results_json, passed, checked_at) VALUES (?, ?, ?, ?, ?, ?)', [
    accountId,
    refType,
    refId,
    JSON.stringify(risk),
    risk.passed ? 1 : 0,
    nowIso()
  ])
}

/** 候选池评估：universe 过滤 + entry 条件（基于本地日线，纯确定性） */
function evaluateCandidates(
  accountId: string,
  strategy: Strategy & Record<string, unknown>,
  dsl: NonNullable<ReturnType<typeof parseAndValidateDsl>['dsl']>
): { code: string; reason: string }[] {
  const end = new Date().toISOString().slice(0, 10)
  const start = new Date(Date.now() - 400 * 86400000).toISOString().slice(0, 10)
  const rows = queryAll<{ code: string; name: string }>('SELECT code, name FROM stock_basic WHERE status = ?', ['listed'])
  const out: { code: string; reason: string }[] = []
  for (const stock of rows) {
    if (out.length >= 20) break
    // universe 过滤
    if (stock.name.includes('ST') && dsl.universe.filters.some((f) => f.op === 'exclude_st')) continue
    const bars = queryAll<{ date: string; open: number; high: number; low: number; close: number; volume: number; amount: number }>(
      'SELECT date, open, high, low, close, volume, amount FROM kline_daily WHERE code = ? AND date >= ? ORDER BY date',
      [stock.code, start]
    )
    if (bars.length < 40) continue
    for (const f of dsl.universe.filters) {
      if (f.op === 'liquidity_min') {
        const amount = typeof f.params.amount === 'number' ? f.params.amount : 1e8
        const days = typeof f.params.days === 'number' ? f.params.days : 20
        const recent = bars.slice(-days)
        const avg = recent.reduce((a, b) => a + b.amount, 0) / days
        if (avg < amount) continue
      }
    }
    const closes = bars.map((b) => b.close)
    const ctx = { closes, highs: bars.map((b) => b.high), lows: bars.map((b) => b.low), volumes: bars.map((b) => b.volume), date: end }
    const hit = evalConditionGroup(dsl.entry.conditions, dsl.entry.logic, ctx)
    if (hit) out.push({ code: stock.code, reason: `entry conditions hit` })
  }
  void accountId
  void strategy
  return out
}

/** 持仓退出信号评估（含持仓上下文：止损/止盈/持有天数） */
function evaluateExit(
  strategy: Strategy & Record<string, unknown>,
  dsl: NonNullable<ReturnType<typeof parseAndValidateDsl>['dsl']>,
  pos: { code: string; qty: number; cost_price: number }
): boolean {
  const end = new Date().toISOString().slice(0, 10)
  const start = new Date(Date.now() - 400 * 86400000).toISOString().slice(0, 10)
  const bars = queryAll<{ date: string; open: number; high: number; low: number; close: number; volume: number }>(
    'SELECT date, open, high, low, close, volume FROM kline_daily WHERE code = ? AND date >= ? ORDER BY date',
    [pos.code, start]
  )
  if (bars.length < 20) return false
  const positionCtx: PositionCtx = { buyDate: bars[Math.max(bars.length - 2, 0)].date, costPrice: pos.cost_price, qty: pos.qty }
  const ctx = {
    closes: bars.map((b) => b.close),
    highs: bars.map((b) => b.high),
    lows: bars.map((b) => b.low),
    volumes: bars.map((b) => b.volume),
    date: end,
    position: positionCtx
  }
  const results = dsl.exit.conditions.map((c) => evalCondition(c, ctx))
  void strategy
  return dsl.exit.logic === 'and' ? results.every(Boolean) : results.some(Boolean)
}

function evalConditionGroup(
  conditions: { indicator: string; params: Record<string, unknown> }[],
  logic: 'and' | 'or',
  ctx: { closes: number[]; highs: number[]; lows: number[]; volumes: number[]; date: string }
): boolean {
  const results = conditions.map((c) => evalCondition(c as never, ctx as never))
  return logic === 'and' ? results.every(Boolean) : results.some(Boolean)
}

/** 激活策略（activate 工作项/人工批准后）：pending_approval → active */
export async function activateStrategy(accountId: string, context: Record<string, unknown>): Promise<Record<string, unknown>> {
  const strategyId = String(context.strategyId ?? '')
  const strategy = queryAll<{ id: string }>('SELECT id FROM strategy WHERE id = ?', [strategyId])[0]
  if (!strategy) throw new Error('策略不存在')
  run('UPDATE strategy SET status = ?, updated_at = ? WHERE id = ?', ['active', nowIso(), strategyId])
  audit({ accountId, actor: 'user', action: 'strategy.activated', target: strategyId })
  agentEventBus.emitAgentEvent('strategy.activated', accountId, { strategyId }, { debounceMs: 0 })
  return { strategyId, status: 'active' }
}

/** 停用策略 */
export function deactivateStrategy(accountId: string, strategyId: string, reason = ''): void {
  run('UPDATE strategy SET status = ?, updated_at = ? WHERE id = ?', ['deactivated', nowIso(), strategyId])
  run('UPDATE run_instance SET status = ?, stopped_at = ? WHERE strategy_id = ? AND status = ?', ['stopped', nowIso(), strategyId, 'active'])
  audit({ accountId, actor: 'user', action: 'strategy.deactivated', target: strategyId, detail: { reason } })
}

// 导出供测试与工具使用的评估辅助
export const indicatorUtils = { sma, crossDetect, macd, momentum, volumeRatio, rsi, boll, obv }
export type { EnabledRule }
