/**
 * IPC：策略域（strategy:…）。每账户唯一一份策略（DSL + 用户偏好）：
 * 读取/保存（DSL 校验 + 新版本留档；偏好仅用户可改）/版本历史/回滚/激活/停用/最近回测。
 * 全部读写经策略服务（唯一写者），handler 保持薄层。
 */
import { ipcMain } from 'electron'
import { IPC, type StrategySaveReq } from '@shared/ipc'
import { queryAll } from '../db/connection'
import { UserError } from '../core/errors'
import { deactivateStrategy, getStrategyForAccount, listVersions, rollback, saveStrategy } from '../strategy/service'
import * as runnerPipeline from '../pipeline/runner'
import { uiBus } from '../app/events'

export function registerStrategyHandlers(): void {
  ipcMain.handle(IPC.strategyGetForAccount, (_e, accountId: string) => getStrategyForAccount(accountId) ?? null)
  ipcMain.handle(IPC.strategySave, (_e, req: StrategySaveReq) => {
    const saved = saveStrategy(req)
    uiBus.broadcast('strategy.updated', { accountId: req.accountId, strategyId: saved.id })
    return saved
  })
  ipcMain.handle(IPC.strategyGetVersions, (_e, strategyId: string) => listVersions(strategyId))
  ipcMain.handle(IPC.strategyRollback, (_e, req: { accountId: string; versionId: string }) => rollback(req.accountId, req.versionId))
  ipcMain.handle(IPC.strategyActivate, async (_e, req: { accountId: string }) => {
    const s = getStrategyForAccount(req.accountId)
    if (!s) throw new UserError('missing_strategy', { accountId: req.accountId })
    await runnerPipeline.activateStrategy(req.accountId, { strategyId: s.id })
  })
  ipcMain.handle(IPC.strategyDeactivate, (_e, req: { accountId: string; reason?: string }) => {
    const s = getStrategyForAccount(req.accountId)
    if (!s) throw new UserError('missing_strategy', { accountId: req.accountId })
    deactivateStrategy(req.accountId, s.id, req.reason ?? '')
  })
  ipcMain.handle(IPC.strategyGetLatestBacktest, (_e, accountId: string) => {
    const s = getStrategyForAccount(accountId)
    if (!s) return null
    return queryAll<Record<string, unknown>>(
      `SELECT br.* FROM backtest_run br
       JOIN strategy_version sv ON sv.id = br.strategy_version_id
       WHERE sv.strategy_id = ? ORDER BY br.created_at DESC LIMIT 1`,
      [s.id]
    )[0] ?? null
  })
}
