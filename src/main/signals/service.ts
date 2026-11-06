/**
 * 信号服务（Signals）：signal 的唯一写者（dsh「one writer per state」）。
 * 规则（docs《数据模型与模块设计》§5.2）：
 * - 信号产出前必经风控引擎校验（不通过不落库、不推送）；
 * - 状态机：pending_confirmation → pending_execution → executed / ignored / expired；
 * - 反馈「已执行」= 自动联动资金/持仓（交易服务），形成「建议 → 执行 → 绩效」闭环；
 * - 每次风控检查留痕 risk_check_result。
 */
import type { RiskCheckResult, Signal } from '@shared/types'
import { inTransaction, newId, nowIso, queryAll, queryOne, run } from '../db/connection'
import { audit } from '../services/audit'
import { assertUser, UserError } from '../core/errors'
import { runRiskCheck, enabledRulesFromRows, type EnabledRule, type RiskCheckContext } from '../quant/risk'
import { executeTradeOrder, collectAccountSnapshot } from '../trading/service'
import { uiBus } from '../app/events'

export interface SignalInput {
  runId: string
  strategyId: string
  code: string
  side: 'buy' | 'sell'
  qty: number
  refPrice: number
  basis: string
  status?: Signal['status']
}

/** 组装风控上下文（工具与运行管线共用） */
export function buildRiskContext(accountId: string, signal: { code: string; name: string; side: 'buy' | 'sell'; qty: number; refPrice: number; latestPrice?: number }): RiskCheckContext {
  const positions = queryAll<{ code: string; qty: number; cost_price: number }>('SELECT code, qty, cost_price FROM position WHERE account_id = ?', [accountId])
  const signalsToday = (
    queryOne<{ c: number }>("SELECT COUNT(*) AS c FROM signal WHERE account_id = ? AND created_at >= datetime('now', 'start of day')", [accountId]) ?? { c: 0 }
  ).c
  const acc = queryOne<{ cash: number }>('SELECT cash FROM account WHERE id = ?', [accountId])
  const totalAssets = (acc?.cash ?? 0) + positions.reduce((sum, p) => sum + p.qty * p.cost_price, 0)
  return {
    accountId,
    totalAssets,
    cash: acc?.cash ?? 0,
    positions: positions.map((p) => ({ accountId, code: p.code, qty: p.qty, costPrice: p.cost_price, updatedAt: '' })),
    signalsToday,
    signal
  }
}

export function enabledRules(accountId: string): EnabledRule[] {
  return enabledRulesFromRows(
    queryAll<{ rule_key: string; params_json: string; enabled: number }>('SELECT rule_key, params_json, enabled FROM risk_rule WHERE account_id = ?', [accountId])
  )
}

/** 风控检查（只读校验；结果结构化） */
export function checkRiskForSignal(accountId: string, signal: { code: string; name?: string; side: 'buy' | 'sell'; qty: number; refPrice: number; latestPrice?: number }, market?: { indexPctChg: number; prevCloseOfStock?: number }): RiskCheckResult {
  const name = signal.name ?? queryOne<{ name: string }>('SELECT name FROM stock_basic WHERE code = ?', [signal.code])?.name ?? signal.code
  return runRiskCheck({ ...buildRiskContext(accountId, { ...signal, name }), market }, enabledRules(accountId))
}

/** 记录风控检查结果（留痕） */
export function persistRiskResult(accountId: string, refType: string, refId: string, risk: { passed: boolean; checks: unknown[] }): void {
  run('INSERT INTO risk_check_result (account_id, ref_type, ref_id, results_json, passed, checked_at) VALUES (?, ?, ?, ?, ?, ?)', [
    accountId,
    refType,
    refId,
    JSON.stringify(risk),
    risk.passed ? 1 : 0,
    nowIso()
  ])
}

/** 产出交易建议（必经风控校验；拒绝不落库并抛固定拒绝） */
export function publishSignal(accountId: string, input: SignalInput, market?: { indexPctChg: number; prevCloseOfStock?: number }): Signal {
  const risk = checkRiskForSignal(accountId, { code: input.code, side: input.side, qty: input.qty, refPrice: input.refPrice }, market)
  if (!risk.passed) {
    persistRiskResult(accountId, 'signal', input.code, risk)
    throw new UserError('risk_rejected', { detail: risk.checks.filter((c) => c.result === 'reject').map((c) => c.message).join('; ') })
  }
  const now = nowIso()
  const expiresAt = new Date(Date.now() + 24 * 3600 * 1000).toISOString()
  const signal: Signal = {
    id: newId(),
    accountId,
    runId: input.runId,
    strategyId: input.strategyId,
    code: input.code,
    side: input.side,
    qty: input.qty,
    refPrice: input.refPrice,
    basisJson: JSON.stringify({ basis: input.basis }),
    riskJson: JSON.stringify(risk),
    status: input.status ?? 'pending_execution',
    expiresAt,
    createdAt: now,
    updatedAt: now
  }
  inTransaction(() => {
    run(
      'INSERT INTO signal (id, account_id, run_id, strategy_id, code, side, qty, ref_price, basis_json, risk_json, status, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [signal.id, accountId, signal.runId, signal.strategyId, signal.code, signal.side, signal.qty, signal.refPrice, signal.basisJson, signal.riskJson, signal.status, signal.expiresAt, signal.createdAt, signal.updatedAt]
    )
    persistRiskResult(accountId, 'signal', signal.id, risk)
  })
  uiBus.broadcast('signal.new', { accountId, signalId: signal.id, code: signal.code, side: signal.side })
  return signal
}

/** 管线直写信号（风控由调用方负责或已通过；仍留痕） */
export function persistSignal(accountId: string, input: SignalInput, risk: RiskCheckResult): Signal {
  const now = nowIso()
  const expiresAt = new Date(Date.now() + 24 * 3600 * 1000).toISOString()
  const signal: Signal = {
    id: newId(),
    accountId,
    runId: input.runId,
    strategyId: input.strategyId,
    code: input.code,
    side: input.side,
    qty: input.qty,
    refPrice: input.refPrice,
    basisJson: JSON.stringify({ basis: input.basis }),
    riskJson: JSON.stringify(risk),
    status: input.status ?? 'pending_execution',
    expiresAt,
    createdAt: now,
    updatedAt: now
  }
  inTransaction(() => {
    run(
      'INSERT INTO signal (id, account_id, run_id, strategy_id, code, side, qty, ref_price, basis_json, risk_json, status, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [signal.id, accountId, signal.runId, signal.strategyId, signal.code, signal.side, signal.qty, signal.refPrice, signal.basisJson, signal.riskJson, signal.status, signal.expiresAt, signal.createdAt, signal.updatedAt]
    )
    persistRiskResult(accountId, 'signal', signal.id, risk)
  })
  uiBus.broadcast('signal.new', { accountId, signalId: signal.id, code: signal.code, side: signal.side })
  return signal
}

export function listSignals(accountId: string, limit = 100): Signal[] {
  return queryAll<Record<string, unknown>>(
    'SELECT * FROM signal WHERE account_id = ? ORDER BY created_at DESC LIMIT ?',
    [accountId, limit]
  ).map(toSignal)
}

export function getSignal(id: string): Signal {
  const row = queryOne<Record<string, unknown>>('SELECT * FROM signal WHERE id = ?', [id])
  assertUser(row, 'missing_signal', { id })
  return toSignal(row)
}

/** 人工反馈：executed → 联动资金/持仓；ignored 仅标记。
 * 状态机守卫：仅 pending_execution 可反馈（重复反馈拒绝，防止重复成交）；
 * 交易与状态变更在同一事务（失败回滚，账实一致）。 */
export function feedbackSignal(signalId: string, feedback: 'executed' | 'ignored', traded?: { price?: number; qty?: number; fee?: number }): void {
  const signal = getSignal(signalId)
  assertUser(signal.status === 'pending_execution', 'trade_conflict', { status: signal.status, detail: '信号已处理，不可重复反馈' })
  inTransaction(() => {
    if (feedback === 'executed') {
      executeTradeOrder({
        accountId: signal.accountId,
        code: signal.code,
        side: signal.side,
        price: traded?.price ?? signal.refPrice,
        qty: traded?.qty ?? signal.qty,
        fee: traded?.fee,
        signalId
      })
    }
    run('UPDATE signal SET status = ?, updated_at = ? WHERE id = ?', [feedback, nowIso(), signalId])
  })
  if (feedback === 'executed') collectAccountSnapshot(signal.accountId)
  audit({ accountId: signal.accountId, actor: 'user', action: 'signal.feedback', target: signalId, detail: { feedback } })
  uiBus.broadcast('signal.updated', { signalId, feedback })
}

/** 信号过期（盯盘检查价格远离参考价时确定性判定） */
export function expireSignal(signalId: string): void {
  run("UPDATE signal SET status = 'expired', updated_at = ? WHERE id = ?", [nowIso(), signalId])
}

function toSignal(r: Record<string, unknown>): Signal {
  return {
    id: String(r.id),
    accountId: String(r.account_id),
    runId: String(r.run_id),
    strategyId: String(r.strategy_id),
    code: String(r.code),
    side: r.side as 'buy' | 'sell',
    qty: Number(r.qty),
    refPrice: Number(r.ref_price),
    basisJson: String(r.basis_json),
    riskJson: String(r.risk_json),
    status: r.status as Signal['status'],
    expiresAt: String(r.expires_at),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at)
  }
}
