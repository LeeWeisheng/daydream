/**
 * 数据管线：股票列表/日线拉取、清洗校验、入库；初建全量与每日增量。
 * 复权方案：存不复权原始数据 + 复权因子（后复权价/原价），
 * 来源缺失时由除权日价格跳空推算（以涨跌停阈值过滤误判）。
 * 下载为 IO 异步，解析分段让出事件循环；任务进度经 onProgress 回调推送。
 */
import type { Bar, StockBasic } from '@shared/types'
import { addDays, isTradingDay, priceLimitRate, shanghaiDateStr } from '@shared/constants'
import { getDb, nowIso, inTransaction } from '../db'
import { logger } from '../services/logger'
import { providerManager } from './providers/base'

export type ProgressFn = (done: number, total: number, message: string) => void

/** 校验单条日线（OHLC 合法性） */
function isValidBar(b: Bar): boolean {
  if (!b.date || !Number.isFinite(b.open) || !Number.isFinite(b.close)) return false
  if (b.open <= 0 || b.close <= 0 || b.high < Math.max(b.open, b.close) * 0.9 || b.low <= 0) return false
  if (b.high < b.low) return false
  return true
}

/** 入库前清洗：过滤非法行、去重 */
function cleanBars(code: string, bars: Bar[]): Bar[] {
  const seen = new Set<string>()
  const out: Bar[] = []
  for (const b of bars) {
    if (!isValidBar(b) || seen.has(b.date)) continue
    seen.add(b.date)
    out.push({ ...b, code })
  }
  out.sort((a, b) => (a.date < b.date ? -1 : 1))
  return out
}

/** 由不复权价与后复权价推算复权因子（hfq/raw）；异常跳空（超涨跌停）不更新 */
function deriveAdjFactor(raw: Bar, hfq: Bar | undefined, name: string): number {
  if (!hfq || raw.close <= 0 || hfq.close <= 0) return raw.adjFactor || 1
  const factor = hfq.close / raw.close
  if (!Number.isFinite(factor) || factor <= 0) return raw.adjFactor || 1
  return factor
}

/**
 * 拉取单只股票的日线（不复权 + 后复权）并计算复权因子。
 */
async function fetchKlineWithFactors(code: string, name: string, start: string, end: string): Promise<Bar[]> {
  const rawBars = await providerManager.getDailyKline(code, start, end, false)
  let hfqBars: Bar[] = []
  try {
    hfqBars = await providerManager.getDailyKline(code, start, end, true)
  } catch (e) {
    logger.debug(`[data] hfq fetch failed for ${code}, fallback to jump detection: ${(e as Error).message}`)
  }
  const hfqMap = new Map(hfqBars.map((b) => [b.date, b]))
  const cleaned = cleanBars(code, rawBars)
  return cleaned.map((b, i) => {
    const hfq = hfqMap.get(b.date)
    if (hfq) {
      return { ...b, adjFactor: deriveAdjFactor(b, hfq, name) }
    }
    // 无后复权数据：跳空推算（超出涨跌停幅度视为除权）
    if (i > 0) {
      const prev = cleaned[i - 1]
      const jump = prev.close > 0 ? b.close / prev.close - 1 : 0
      const rate = priceLimitRate(code, name)
      if (Math.abs(jump) > rate + 0.005) {
        const factor = prev.adjFactor * (1 + jump)
        return { ...b, adjFactor: factor }
      }
      return { ...b, adjFactor: prev.adjFactor }
    }
    return { ...b, adjFactor: 1 }
  })
}

/** 批量入库日线（事务 + 分批） */
function storeBars(bars: Bar[]): void {
  const db = getDb()
  const stmt = db.prepare(
    `INSERT INTO kline_daily (code, date, open, high, low, close, volume, amount, adj_factor)
     VALUES (@code, @date, @open, @high, @low, @close, @volume, @amount, @adjFactor)
     ON CONFLICT(code, date) DO UPDATE SET
       open=excluded.open, high=excluded.high, low=excluded.low, close=excluded.close,
       volume=excluded.volume, amount=excluded.amount, adj_factor=excluded.adj_factor`
  )
  const markStatus = db.prepare(
    `INSERT INTO data_status (code, last_update_date, integrity_level, updated_at)
     VALUES (?, ?, 1, ?) ON CONFLICT(code) DO UPDATE SET last_update_date=excluded.last_update_date, updated_at=excluded.updated_at`
  )
  const batch = (chunk: Bar[]): void => {
    inTransaction(() => {
      for (const b of chunk) stmt.run(b)
      for (const b of chunk) markStatus.run(b.code, b.date, nowIso())
    })
  }
  // 分批提交（每批 500 条），避免大事务阻塞主进程事件循环
  for (let i = 0; i < bars.length; i += 500) {
    batch(bars.slice(i, i + 500))
  }
}

/** 批量入库股票列表 */
function storeStockList(list: StockBasic[]): void {
  const db = getDb()
  const stmt = db.prepare(
    `INSERT INTO stock_basic (code, name, exchange, industry, status, updated_at)
     VALUES (?, ?, ?, NULL, ?, ?) ON CONFLICT(code) DO UPDATE SET name=excluded.name, exchange=excluded.exchange, updated_at=excluded.updated_at`
  )
  inTransaction(() => {
    for (const s of list) stmt.run(s.code, s.name, s.exchange, s.status, nowIso())
  })
}

/** 批量入库指数日线 */
function storeIndexDaily(rows: { indexCode: string; date: string; open: number; high: number; low: number; close: number; volume: number; amount: number }[]): void {
  const db = getDb()
  const stmt = db.prepare(
    `INSERT INTO index_daily (index_code, date, open, high, low, close, volume, amount)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(index_code, date) DO UPDATE SET
       open=excluded.open, high=excluded.high, low=excluded.low, close=excluded.close,
       volume=excluded.volume, amount=excluded.amount`
  )
  inTransaction(() => {
    for (const r of rows) stmt.run(r.indexCode, r.date, r.open, r.high, r.low, r.close, r.volume, r.amount)
  })
}

// ---------- 任务状态（主进程内存态） ----------
export interface DataTaskState {
  running: boolean
  done: number
  total: number
  message: string
  error?: string
}

export const dataTaskState: DataTaskState = { running: false, done: 0, total: 0, message: '' }

/** 初建：全市场股票列表 + 近 N 年日线（约 30~60 分钟，可暂停/恢复） */
export async function initialSync(years = 3, onProgress?: ProgressFn): Promise<void> {
  if (dataTaskState.running) throw new Error('数据任务已在进行中')
  dataTaskState.running = true
  dataTaskState.done = 0
  dataTaskState.total = 0
  dataTaskState.message = '拉取股票列表'
  const report = (message: string): void => {
    dataTaskState.message = message
    onProgress?.(dataTaskState.done, dataTaskState.total, message)
  }
  try {
    providerManager.resetIfPossible()
    const stockList = await providerManager.getStockList()
    storeStockList(stockList)
    logger.info(`[data] stock list: ${stockList.length}`)

    const end = shanghaiDateStr()
    const start = addDays(end, -Math.round(years * 365))
    dataTaskState.total = stockList.length
    report(`拉取日线（${start} ~ ${end}）`)

    for (const stock of stockList) {
      try {
        const bars = await fetchKlineWithFactors(stock.code, stock.name, start, end)
        storeBars(bars)
        dataTaskState.done += 1
        if (dataTaskState.done % 50 === 0) report(`日线入库 ${dataTaskState.done}/${dataTaskState.total}`)
        // 每 50 只让出事件循环
        if (dataTaskState.done % 50 === 0) await new Promise((r) => setTimeout(r, 0))
      } catch (e) {
        logger.warn(`[data] skip ${stock.code} ${stock.name}: ${(e as Error).message}`)
        dataTaskState.done += 1
      }
    }

    // 指数日线（基准与市场简报）
    await syncIndexDaily(start, end)
    report('初建完成')
  } catch (e) {
    dataTaskState.error = (e as Error).message
    logger.error(`[data] initial sync failed: ${dataTaskState.error}`)
    throw e
  } finally {
    dataTaskState.running = false
  }
}

/** 指数日线同步（沪深300 为基准，上证/深证成指为市场简报） */
export async function syncIndexDaily(start: string, end: string): Promise<void> {
  for (const code of ['000300', '000001', '399001']) {
    try {
      const rows = await providerManager.getIndexDaily(code, start, end)
      storeIndexDaily(rows)
    } catch (e) {
      logger.warn(`[data] index ${code} sync failed: ${(e as Error).message}`)
    }
  }
}

/** 每日增量：收盘后（16:30）更新当日全市场日线 */
export async function dailyUpdate(onProgress?: ProgressFn): Promise<void> {
  if (dataTaskState.running) throw new Error('数据任务已在进行中')
  const today = shanghaiDateStr()
  if (!isTradingDay(today)) {
    logger.info('[data] not a trading day, skip daily update')
    return
  }
  dataTaskState.running = true
  dataTaskState.done = 0
  dataTaskState.message = '增量更新'
  const report = (message: string): void => {
    dataTaskState.message = message
    onProgress?.(dataTaskState.done, dataTaskState.total, message)
  }
  try {
    providerManager.resetIfPossible()
    const db = getDb()
    const stocks = db.prepare('SELECT code, name FROM stock_basic').all() as { code: string; name: string }[]
    dataTaskState.total = stocks.length
    const start = addDays(today, -7)
    for (const s of stocks) {
      try {
        const bars = await fetchKlineWithFactors(s.code, s.name, start, today)
        storeBars(bars)
        dataTaskState.done += 1
        if (dataTaskState.done % 100 === 0) report(`增量入库 ${dataTaskState.done}/${dataTaskState.total}`)
        if (dataTaskState.done % 100 === 0) await new Promise((r) => setTimeout(r, 0))
      } catch (e) {
        dataTaskState.done += 1
        logger.debug(`[data] daily skip ${s.code}: ${(e as Error).message}`)
      }
    }
    await syncIndexDaily(start, today)
    report('增量更新完成')
  } catch (e) {
    dataTaskState.error = (e as Error).message
    logger.error(`[data] daily update failed: ${dataTaskState.error}`)
    throw e
  } finally {
    dataTaskState.running = false
  }
}

/** 按需补数：Agent/查询发现缺失时触发 */
export async function backfill(code: string, name: string, start: string, end: string): Promise<void> {
  const bars = await fetchKlineWithFactors(code, name, start, end)
  storeBars(bars)
  logger.info(`[data] backfilled ${code} (${bars.length} bars)`)
}
