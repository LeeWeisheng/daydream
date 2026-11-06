/**
 * IPC：策略域（strategy:…）。每账户唯一一份策略（Markdown 纯文本 = 交易策略 + 用户偏好）：
 * 读取/保存（新版本留档，保存即生效）/版本列表/设置生效版本（默认最新，用户可指定）。
 * 全部读写经策略服务（唯一写者），handler 保持薄层。
 */
import { ipcMain } from 'electron'
import { IPC, type StrategySaveReq } from '@shared/ipc'
import { getStrategyForAccount, listVersions, saveStrategyMarkdown, setActiveVersion } from '../strategy/service'
import { uiBus } from '../app/events'

export function registerStrategyHandlers(): void {
  ipcMain.handle(IPC.strategyGetForAccount, (_e, accountId: string) => getStrategyForAccount(accountId) ?? null)
  ipcMain.handle(IPC.strategySave, (_e, req: StrategySaveReq) => {
    const saved = saveStrategyMarkdown({
      accountId: req.accountId,
      title: req.title,
      markdown: req.markdown,
      changeLog: req.changeLog,
      createdBy: req.actor === 'agent' ? 'agent' : 'user'
    })
    uiBus.broadcast('strategy.updated', { accountId: req.accountId, strategyId: saved.id, version: saved.version })
    return saved
  })
  ipcMain.handle(IPC.strategyGetVersions, (_e, strategyId: string) => listVersions(strategyId))
  ipcMain.handle(IPC.strategySetActiveVersion, (_e, req: { accountId: string; versionId: string | null }) => {
    const saved = setActiveVersion(req.accountId, req.versionId)
    uiBus.broadcast('strategy.updated', { accountId: req.accountId, strategyId: saved.id })
    return saved
  })
}
