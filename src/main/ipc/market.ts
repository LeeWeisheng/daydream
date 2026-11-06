/**
 * IPC：行情数据域（data:…）。
 * - 查询与一键同步（全量/增量，进度经 data.progress 事件推送）；
 * - 数据 CRUD（Agent 运行时同样可用，不互斥）；删除为受限操作（审计留痕）。
 */
import { ipcMain } from 'electron'
import { IPC, type KlineUpsertReq, type StockUpsertReq } from '@shared/ipc'
import * as marketService from '../market/service'
import { dailyUpdate, initialSync } from '../market/pipeline'
import { inTransaction, nowIso, run } from '../db/connection'
import { audit } from '../services/audit'
import { getActiveAccountId } from '../accounts/service'
import { uiBus } from '../app/events'
import { logger } from '../services/logger'

export function registerMarketHandlers(): void {
  ipcMain.handle(IPC.dataGetStockList, () => marketService.getStockList())
  ipcMain.handle(IPC.dataGetQuote, (_e, codes: string[]) => marketService.getQuotes(codes))
  ipcMain.handle(IPC.dataGetKline, (_e, req: { code: string; start: string; end: string }) => marketService.getDailyKline(req.code, req.start, req.end))
  ipcMain.handle(IPC.dataGetIndexDaily, (_e, req: { code: string; start: string; end: string }) => marketService.getIndexDaily(req.code, req.start, req.end))
  ipcMain.handle(IPC.dataGetDataStatus, () => marketService.getDataStatus())
  ipcMain.handle(IPC.dataGetDataStats, () => marketService.getDataStats())

  ipcMain.handle(IPC.dataInitialSync, () => {
    const years = 3
    initialSync(years, (done, total, message) => uiBus.broadcast('data.progress', { done, total, message })).catch((e) =>
      logger.error(`[ipc] initial sync failed: ${(e as Error).message}`)
    )
    return { started: true }
  })
  ipcMain.handle(IPC.dataDailyUpdate, () => {
    dailyUpdate((done, total, message) => uiBus.broadcast('data.progress', { done, total, message })).catch((e) =>
      logger.error(`[ipc] daily update failed: ${(e as Error).message}`)
    )
    return { started: true }
  })

  // 数据 CRUD（Agent 运行时同样可用）
  ipcMain.handle(IPC.dataUpsertStock, (_e, req: StockUpsertReq) => {
    if (!req.code || !req.name) throw new Error('代码与名称不能为空')
    run(
      `INSERT INTO stock_basic (code, name, exchange, industry, status, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(code) DO UPDATE SET name=excluded.name, exchange=excluded.exchange, industry=excluded.industry, status=excluded.status, updated_at=excluded.updated_at`,
      [req.code, req.name, req.exchange ?? 'SH', req.industry ?? null, req.status ?? 'listed', nowIso()]
    )
    audit({ accountId: getActiveAccountId() || 'global', actor: 'user', action: 'data.stock.upsert', target: req.code })
  })
  ipcMain.handle(IPC.dataDeleteStock, (_e, code: string) => {
    inTransaction(() => {
      run('DELETE FROM kline_daily WHERE code = ?', [code])
      run('DELETE FROM market_quote WHERE code = ?', [code])
      run('DELETE FROM data_status WHERE code = ?', [code])
      run('DELETE FROM stock_basic WHERE code = ?', [code])
    })
    audit({ accountId: getActiveAccountId() || 'global', actor: 'user', action: 'data.stock.delete', target: code })
  })
  ipcMain.handle(IPC.dataUpsertKline, (_e, req: KlineUpsertReq) => {
    if (!req.code || !req.date) throw new Error('代码与日期不能为空')
    if (!(req.high >= req.low && req.high >= req.open && req.low <= req.close)) throw new Error('OHLC 数据非法（最高价必须 ≥ 最低价）')
    run(
      `INSERT INTO kline_daily (code, date, open, high, low, close, volume, amount, adj_factor) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(code, date) DO UPDATE SET open=excluded.open, high=excluded.high, low=excluded.low, close=excluded.close, volume=excluded.volume, amount=excluded.amount, adj_factor=excluded.adj_factor`,
      [req.code, req.date, req.open, req.high, req.low, req.close, req.volume, req.amount, req.adjFactor ?? 1]
    )
    run(
      `INSERT INTO data_status (code, last_update_date, integrity_level, updated_at) VALUES (?, ?, 1, ?)
       ON CONFLICT(code) DO UPDATE SET last_update_date=excluded.last_update_date, updated_at=excluded.updated_at`,
      [req.code, req.date, nowIso()]
    )
  })
  ipcMain.handle(IPC.dataDeleteKline, (_e, req: { code: string; date: string }) => {
    run('DELETE FROM kline_daily WHERE code = ? AND date = ?', [req.code, req.date])
  })
}
