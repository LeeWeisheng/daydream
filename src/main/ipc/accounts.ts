/**
 * IPC：账户域（account:…）。切换账户不中断 Agent 运行（运行开关是全局状态，
 * 仅更新资金视角）；账户 CRUD 经账户服务（唯一写者）。
 */
import { ipcMain } from 'electron'
import { IPC } from '@shared/ipc'
import { createAccount, deleteAccount, getAccount, listAccounts, renameAccount, setActiveAccountId } from '../accounts/service'
import { UserError } from '../core/errors'

export function registerAccountHandlers(): void {
  ipcMain.handle(IPC.accountList, () => listAccounts())
  ipcMain.handle(IPC.accountCreate, (_e, req: { name: string }) => createAccount(req.name || '新账户'))
  ipcMain.handle(IPC.accountSwitch, (_e, req: { accountId: string }) => {
    const account = getAccount(req.accountId)
    if (!account) throw new UserError('missing_account', { id: req.accountId })
    // 切换账户不中断 Agent 运行：仅更新资金视角（运行开关是全局状态）
    setActiveAccountId(req.accountId)
    return account
  })
  ipcMain.handle(IPC.accountRename, (_e, req: { accountId: string; name: string }) => renameAccount(req.accountId, req.name))
  ipcMain.handle(IPC.accountDelete, (_e, accountId: string) => deleteAccount(accountId))
}
