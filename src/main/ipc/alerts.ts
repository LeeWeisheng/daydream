/**
 * IPC：预警域（alert:…）。
 */
import { ipcMain } from 'electron'
import { IPC } from '@shared/ipc'
import { acknowledgeAlert, listAlerts } from '../alerts/service'

export function registerAlertHandlers(): void {
  ipcMain.handle(IPC.alertList, (_e, accountId: string) => listAlerts(accountId))
  ipcMain.handle(IPC.alertAcknowledge, (_e, alertId: string) => acknowledgeAlert(alertId))
}
