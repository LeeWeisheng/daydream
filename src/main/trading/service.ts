/**
 * 交易服务（Trading）：账户资金、持仓、成交记录、每日快照的唯一写者。
 * 规则（docs《数据模型与模块设计》§6）：
 * - 系统不接入券商通道：买入/卖出为应用内录入（记录人工在券商侧的真实成交）；
 * - 买入/卖出在一个事务内联动现金、持仓、成交记录（三方一致）；
 * - 信号反馈「已执行」= 自动走一遍联动（价格/数量取人工填写的实际成交值）。
 */
import type { AccountSummary, Position, PositionDetail, TradeRecord } from '@shared/types'
import { DEFAULT_INITIAL_CASH, calcFee } from '@shared/constants'
import { inTransaction, newId, nowIso, queryAll, queryOne, run } from '../db/connection'
import { audit } from '../services/audit'
import { assertUser, UserError } from '../core/errors'
import { logger } from '../services/logger'

export interface TradeOrderInput {
  accountId: string
  code: string
  side: 'buy' | 'sell'
  price: number
  qty: number
  fee?: number
  tradedAt?: string
  signalId?: string
  note?: string
}

/** 买入/卖出联动：现金、持仓、成交记录在同一事务内完成 */
export function executeTradeOrder(req: TradeOrderInput): void {
  const account = queryOne<{ id: string }>('SELECT id FROM account WHERE id = ?', [req.accountId])
  assertUser(account, 'missing_account', { id: req.accountId })
  const qty = Math.max(1, Math.floor(req.qty))
  const price = req.price
  if (!(price > 0)) throw new UserError('trade_conflict', { detail: '价格必须为正数' })
  const amount = Math.round(price * qty * 100) / 100
  const fee = req.fee !== undefined ? req.fee : calcFee(req.side, amount)

  inTransaction(() => {
    const acc = queryOne<{ cash: number }>('SELECT cash FROM account WHERE id = ?', [req.accountId])
    if (!acc) throw new UserError('missing_account', { id: req.accountId })
    let cash = acc.cash
    if (req.side === 'buy') {
      if (cash < amount + fee) {
        throw new UserError('insufficient_cash', { need: (amount + fee).toFixed(2), have: cash.toFixed(2) })
      }
      cash = Math.round((cash - amount - fee) * 100) / 100
    } else {
      const pos = queryOne<{ qty: number }>('SELECT qty FROM position WHERE account_id = ? AND code = ?', [req.accountId, req.code])
      if (!pos || pos.qty < qty) {
        throw new UserError('insufficient_position', { hold: String(pos?.qty ?? 0), sell: String(qty) })
      }
      cash = Math.round((cash + amount - fee) * 100) / 100
    }
    run('UPDATE account SET cash = ?, updated_at = ? WHERE id = ?', [cash, nowIso(), req.accountId])

    // 持仓联动（买入加权成本；卖出清仓删除持仓行）
    const pos = queryOne<{ qty: number; cost_price: number }>('SELECT qty, cost_price FROM position WHERE account_id = ? AND code = ?', [req.accountId, req.code])
    if (req.side === 'buy') {
      const newQty = (pos?.qty ?? 0) + qty
      const newCost = pos ? (pos.cost_price * pos.qty + amount + fee) / newQty : (amount + fee) / newQty
      run(
        'INSERT INTO position (account_id, code, qty, cost_price, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(account_id, code) DO UPDATE SET qty=excluded.qty, cost_price=excluded.cost_price, updated_at=excluded.updated_at',
        [req.accountId, req.code, newQty, Math.round(newCost * 10000) / 10000, nowIso()]
      )
    } else {
      const newQty = (pos?.qty ?? 0) - qty
      if (newQty <= 0) run('DELETE FROM position WHERE account_id = ? AND code = ?', [req.accountId, req.code])
      else run('UPDATE position SET qty = ?, updated_at = ? WHERE account_id = ? AND code = ?', [newQty, nowIso(), req.accountId, req.code])
    }

    run('INSERT INTO trade_record (id, account_id, code, side, price, qty, fee, traded_at, signal_id, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [
      newId(),
      req.accountId,
      req.code,
      req.side,
      price,
      qty,
      fee,
      req.tradedAt || nowIso(),
      req.signalId ?? null,
      req.note ?? null
    ])
  })
  audit({ accountId: req.accountId, actor: 'user', action: `trade.${req.side}`, target: req.code, detail: { price, qty, fee } })
}

export function listTradeRecords(accountId: string, limit = 500): TradeRecord[] {
  return queryAll<Record<string, unknown>>('SELECT * FROM trade_record WHERE account_id = ? ORDER BY traded_at DESC LIMIT ?', [accountId, limit]).map(
    (r) => ({
      id: String(r.id),
      accountId: String(r.account_id),
      code: String(r.code),
      side: r.side as 'buy' | 'sell',
      price: Number(r.price),
      qty: Number(r.qty),
      fee: Number(r.fee),
      tradedAt: String(r.traded_at),
      signalId: r.signal_id ? String(r.signal_id) : undefined,
      note: r.note ? String(r.note) : undefined
    })
  )
}

export function listPositions(accountId: string): Position[] {
  return queryAll<Record<string, unknown>>('SELECT * FROM position WHERE account_id = ?', [accountId]).map((r) => ({
    accountId: String(r.account_id),
    code: String(r.code),
    qty: Number(r.qty),
    costPrice: Number(r.cost_price),
    updatedAt: String(r.updated_at)
  }))
}

/** 人工维护持仓（增改删；qty<=0 删除） */
export function upsertPosition(accountId: string, code: string, qty: number, costPrice: number): void {
  if (qty <= 0) {
    run('DELETE FROM position WHERE account_id = ? AND code = ?', [accountId, code])
  } else {
    run(
      'INSERT INTO position (account_id, code, qty, cost_price, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(account_id, code) DO UPDATE SET qty=excluded.qty, cost_price=excluded.cost_price, updated_at=excluded.updated_at',
      [accountId, code, qty, costPrice, nowIso()]
    )
  }
  audit({ accountId, actor: 'user', action: 'position.upsert', target: code, detail: { qty, costPrice } })
}

export function setInitialCash(accountId: string, cash: number): void {
  if (!(cash > 0)) throw new UserError('trade_conflict', { detail: '初始资金必须为正数' })
  const acc = queryOne<{ config_json: string }>('SELECT config_json FROM account WHERE id = ?', [accountId])
  assertUser(acc, 'missing_account', { id: accountId })
  let cfg: Record<string, unknown> = {}
  try {
    cfg = JSON.parse(acc.config_json) as Record<string, unknown>
  } catch {
    /* 忽略 */
  }
  cfg.initialCash = cash
  run('UPDATE account SET config_json = ?, updated_at = ? WHERE id = ?', [JSON.stringify(cfg), nowIso(), accountId])
  audit({ accountId, actor: 'user', action: 'account.initial_cash.set', detail: { cash } })
}

// ---------- 资金统计 ----------
export function buildAccountSummary(accountId: string): AccountSummary {
  const acc = queryOne<{ cash: number; config_json: string }>('SELECT cash, config_json FROM account WHERE id = ?', [accountId])
  const cash = acc?.cash ?? DEFAULT_INITIAL_CASH
  let initialCash = DEFAULT_INITIAL_CASH
  try {
    const cfg = JSON.parse(acc?.config_json ?? '{}') as { initialCash?: number }
    if (cfg.initialCash) initialCash = cfg.initialCash
  } catch {
    /* 忽略 */
  }
  const positions = queryAll<{ code: string; qty: number; cost_price: number }>('SELECT code, qty, cost_price FROM position WHERE account_id = ?', [accountId])
  let marketValue = 0
  let positionPnl = 0
  const details: PositionDetail[] = positions.map((p) => {
    const quote = queryOne<{ price: number }>('SELECT price FROM market_quote WHERE code = ?', [p.code])
    const nameRow = queryOne<{ name: string }>('SELECT name FROM stock_basic WHERE code = ?', [p.code])
    const price = quote?.price ?? p.cost_price
    const mv = Math.round(p.qty * price * 100) / 100
    const pnl = Math.round((price - p.cost_price) * p.qty * 100) / 100
    marketValue += mv
    positionPnl += pnl
    return {
      code: p.code,
      name: nameRow?.name ?? p.code,
      qty: p.qty,
      costPrice: p.cost_price,
      price,
      marketValue: mv,
      pnl,
      pnlPct: p.cost_price > 0 ? Math.round(((price - p.cost_price) / p.cost_price) * 10000) / 100 : 0,
      positionPct: 0
    }
  })
  const totalAssets = Math.round((cash + marketValue) * 100) / 100
  for (const d of details) d.positionPct = totalAssets > 0 ? Math.round((d.marketValue / totalAssets) * 10000) / 100 : 0
  const snapshots = queryAll<{ date: string; total_assets: number }>('SELECT date, total_assets FROM account_snapshot WHERE account_id = ? ORDER BY date ASC', [accountId])
  const prev = snapshots[snapshots.length - 2]
  return {
    accountId,
    cash,
    initialCash,
    marketValue: Math.round(marketValue * 100) / 100,
    totalAssets,
    positionPnl: Math.round(positionPnl * 100) / 100,
    totalPnl: Math.round((totalAssets - initialCash) * 100) / 100,
    todayPnl: prev ? Math.round((totalAssets - prev.total_assets) * 100) / 100 : 0,
    positionPct: totalAssets > 0 ? Math.round((marketValue / totalAssets) * 10000) / 100 : 0,
    positionCount: positions.length,
    positions: details,
    equityCurve: snapshots.map((s) => ({ date: s.date, totalAssets: s.total_assets }))
  }
}

/** 每日账户快照采集（收盘后，绩效输入） */
export function collectAccountSnapshot(accountId: string): void {
  try {
    const summary = buildAccountSummary(accountId)
    const today = new Date().toISOString().slice(0, 10)
    run(
      'INSERT INTO account_snapshot (account_id, date, total_assets, cash, positions_json) VALUES (?, ?, ?, ?, ?) ON CONFLICT(account_id, date) DO UPDATE SET total_assets=excluded.total_assets, cash=excluded.cash, positions_json=excluded.positions_json',
      [accountId, today, summary.totalAssets, summary.cash, JSON.stringify(summary.positions)]
    )
  } catch (e) {
    logger.warn(`[snapshot] collect failed: ${(e as Error).message}`)
  }
}
