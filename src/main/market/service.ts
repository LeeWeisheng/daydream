/**
 * 数据服务：对上层（IPC/Agent 工具/管线）的统一数据出口。
 * 查询缺数据时自动触发补数任务；实时快照缓存到 market_quote（仅存最新值）。
 */
import type { Bar, IndexDaily, Quote, StockBasic } from '@shared/types'
import { getDb, queryAll, run } from '../db/connection'
import { logger } from '../services/logger'
import { providerManager } from './providers/base'
import { backfill, syncIndexDaily } from './pipeline'

// ---------- 查询 ----------
export function getStockList(): StockBasic[] {
  return queryAll<StockBasic>('SELECT code, name, exchange, industry, status FROM stock_basic ORDER BY code')
}

export function searchStocks(keyword: string, limit = 20): StockBasic[] {
  return queryAll<StockBasic>(
    'SELECT code, name, exchange, industry, status FROM stock_basic WHERE code LIKE ? OR name LIKE ? LIMIT ?',
    [`%${keyword}%`, `%${keyword}%`, limit]
  )
}

/** 查询日线；本地缺失时触发补数（异步，不阻塞本次返回） */
export function getDailyKline(code: string, start: string, end: string): Bar[] {
  const rows = queryAll<Bar & { adj_factor: number }>(
    'SELECT code, date, open, high, low, close, volume, amount, adj_factor FROM kline_daily WHERE code = ? AND date >= ? AND date <= ? ORDER BY date',
    [code, start, end]
  )
  const stock = queryAll<{ name: string }>('SELECT name FROM stock_basic WHERE code = ?', [code])[0]
  if (rows.length === 0 && stock) {
    // 缺失补数（异步触发，限频由管理器保证）
    backfill(code, stock.name, start, end).catch((e) => logger.debug(`[data] backfill ${code} failed: ${(e as Error).message}`))
  }
  return rows.map((r) => ({ ...r, adjFactor: r.adj_factor }))
}

/** 查询指数日线（缺数据时异步补） */
export function getIndexDaily(code: string, start: string, end: string): IndexDaily[] {
  const rows = queryAll<IndexDaily>(
    'SELECT index_code as indexCode, date, open, high, low, close, volume, amount FROM index_daily WHERE index_code = ? AND date >= ? AND date <= ? ORDER BY date',
    [code, start, end]
  )
  if (rows.length === 0) {
    syncIndexDaily(start, end).catch((e) => logger.debug(`[data] index ${code} sync failed: ${(e as Error).message}`))
  }
  return rows
}

/** 实时行情：先查缓存（10 秒内有效），否则拉取并更新缓存 */
export async function getQuotes(codes: string[], forceRefresh = false): Promise<Quote[]> {
  if (codes.length === 0) return []
  const cached: Quote[] = []
  const missing: string[] = []
  const db = getDb()
  for (const code of codes) {
    const row = db.prepare('SELECT * FROM market_quote WHERE code = ?').get(code) as Record<string, unknown> | undefined
    if (row && !forceRefresh && Date.now() - new Date(String(row.ts)).getTime() < 10_000) {
      cached.push(rowToQuote(code, row))
    } else {
      missing.push(code)
    }
  }
  if (missing.length > 0) {
    try {
      const fresh = await providerManager.getQuote(missing)
      const upsert = db.prepare(
        `INSERT INTO market_quote (code, name, price, pct_chg, open, high, low, prev_close, volume, amount, ts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(code) DO UPDATE SET name=excluded.name, price=excluded.price, pct_chg=excluded.pct_chg,
           open=excluded.open, high=excluded.high, low=excluded.low, prev_close=excluded.prev_close,
           volume=excluded.volume, amount=excluded.amount, ts=excluded.ts`
      )
      const tx = db.transaction(() => {
        for (const q of fresh) {
          upsert.run(q.code, q.name, q.price, q.pctChg, q.open, q.high, q.low, q.prevClose, q.volume, q.amount, q.ts)
        }
      })
      tx()
      return [...cached, ...fresh]
    } catch (e) {
      logger.warn(`[data] quote fetch failed, return cache: ${(e as Error).message}`)
      return cached
    }
  }
  return cached
}

function rowToQuote(code: string, row: Record<string, unknown>): Quote {
  return {
    code,
    name: String(row.name ?? ''),
    price: Number(row.price ?? 0),
    pctChg: Number(row.pct_chg ?? 0),
    open: Number(row.open ?? 0),
    high: Number(row.high ?? 0),
    low: Number(row.low ?? 0),
    prevClose: Number(row.prev_close ?? 0),
    volume: Number(row.volume ?? 0),
    amount: Number(row.amount ?? 0),
    ts: String(row.ts ?? '')
  }
}

/** 市场简报：指数涨跌 + 涨跌家数 + 量能 */
export async function getMarketBrief(): Promise<Record<string, unknown>> {
  const today = new Date().toISOString().slice(0, 10)
  const sh = getIndexDaily('000001', today.slice(0, 8) + '01', today)
  const brief: Record<string, unknown> = { date: today }
  if (sh.length > 0) {
    const last = sh[sh.length - 1]
    const prev = sh.length > 1 ? sh[sh.length - 2] : undefined
    brief.shIndex = last.close
    brief.shPctChg = prev ? last.close / prev.close - 1 : 0
  }
  try {
    const quotes = await getQuotes(['000300'])
    if (quotes.length > 0) {
      brief.hs300 = quotes[0].price
      brief.hs300PctChg = quotes[0].pctChg
    }
  } catch {
    /* 忽略 */
  }
  // 涨跌家数（缓存快照统计，仅统计有当日快照的标的）
  const rows = queryAll<{ pct_chg: number }>('SELECT pct_chg FROM market_quote')
  let up = 0
  let down = 0
  for (const r of rows) {
    if (r.pct_chg > 0) up++
    else if (r.pct_chg < 0) down++
  }
  brief.upCount = up
  brief.downCount = down
  return brief
}

/** 数据状态概览（用于界面展示与 Agent 感知） */
export function getDataStatus(): Record<string, unknown>[] {
  return queryAll(
    `SELECT code, last_update_date, integrity_level, updated_at
     FROM data_status ORDER BY last_update_date DESC LIMIT 200`
  )
}

/** 全量数据统计 */
export function getDataStats(): Record<string, number | string> {
  const db = getDb()
  const stocks = db.prepare('SELECT COUNT(*) AS c FROM stock_basic').get() as { c: number }
  const bars = db.prepare('SELECT COUNT(*) AS c FROM kline_daily').get() as { c: number }
  const minDate = db.prepare('SELECT MIN(date) AS d FROM kline_daily').get() as { d: string | null }
  const maxDate = db.prepare('SELECT MAX(date) AS d FROM kline_daily').get() as { d: string | null }
  return { stocks: stocks.c, bars: bars.c, minDate: minDate.d ?? '', maxDate: maxDate.d ?? '' }
}

/** 记录数据任务审计 */
export function auditDataAction(accountId: string, action: string, detail: Record<string, unknown>): void {
  run(
    'INSERT INTO audit_log (account_id, actor, action, target, detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [accountId, 'system', action, 'data', JSON.stringify(detail), new Date().toISOString()]
  )
}
