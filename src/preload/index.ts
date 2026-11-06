/**
 * 预加载脚本：contextBridge 白名单类型化 API（window.daydream）。
 * 渲染进程仅能通过此桥接访问主进程能力。
 */
import { contextBridge, ipcRenderer } from 'electron'
import { IPC, type DaydreamApi } from '@shared/ipc'
import type { UiEvent } from '@shared/types'

function invoke(channel: string, ...args: unknown[]): Promise<never> {
  return ipcRenderer.invoke(channel, ...args) as Promise<never>
}

const api: DaydreamApi = {
  accounts: {
    list: () => invoke(IPC.accountList),
    create: (req) => invoke(IPC.accountCreate, req),
    switchTo: (req) => invoke(IPC.accountSwitch, req),
    rename: (req) => invoke(IPC.accountRename, req),
    remove: (accountId) => invoke(IPC.accountDelete, accountId)
  },
  settings: {
    get: (accountId) => invoke(IPC.settingsGet, accountId),
    update: (patch) => invoke(IPC.settingsUpdate, '', patch)
  },
  theme: {
    get: () => invoke(IPC.themeGet),
    set: (mode) => invoke(IPC.themeSet, mode)
  },
  runMode: {
    get: () => invoke(IPC.runModeGet),
    set: (mode) => invoke(IPC.runModeSet, mode)
  },
  window: {
    minimize: () => invoke(IPC.windowMinimize),
    toggleMaximize: () => invoke(IPC.windowToggleMaximize),
    close: () => invoke(IPC.windowClose),
    isMaximized: () => invoke(IPC.windowIsMaximized),
    isFullScreen: () => invoke(IPC.windowIsFullScreen)
  },
  data: {
    getStockList: () => invoke(IPC.dataGetStockList),
    getQuote: (codes) => invoke(IPC.dataGetQuote, codes),
    getKline: (code, start, end) => invoke(IPC.dataGetKline, { code, start, end }),
    getIndexDaily: (code, start, end) => invoke(IPC.dataGetIndexDaily, { code, start, end }),
    getDataStatus: () => invoke(IPC.dataGetDataStatus),
    getDataStats: () => invoke(IPC.dataGetDataStats),
    initialSync: () => invoke(IPC.dataInitialSync),
    dailyUpdate: () => invoke(IPC.dataDailyUpdate),
    upsertStock: (req) => invoke(IPC.dataUpsertStock, req),
    deleteStock: (code) => invoke(IPC.dataDeleteStock, code),
    upsertKline: (req) => invoke(IPC.dataUpsertKline, req),
    deleteKline: (code, date) => invoke(IPC.dataDeleteKline, { code, date })
  },
  strategy: {
    getForAccount: (accountId) => invoke(IPC.strategyGetForAccount, accountId),
    save: (req) => invoke(IPC.strategySave, req),
    getVersions: (strategyId) => invoke(IPC.strategyGetVersions, strategyId),
    setActiveVersion: (accountId, versionId) => invoke(IPC.strategySetActiveVersion, { accountId, versionId })
  },
  trades: {
    order: (req) => invoke(IPC.tradeOrder, req),
    list: (accountId) => invoke(IPC.tradeList, accountId),
    accountSummary: (accountId) => invoke(IPC.tradeAccountSummary, accountId),
    setInitialCash: (accountId, cash) => invoke(IPC.tradeSetInitialCash, { accountId, cash })
  },
  signals: {
    list: (accountId, limit) => invoke(IPC.signalList, accountId, limit ?? 100),
    feedback: (req) => invoke(IPC.signalFeedback, req)
  },
  positions: {
    list: (accountId) => invoke(IPC.positionList, accountId),
    upsert: (req) => invoke(IPC.positionUpsert, req)
  },
  alerts: {
    list: (accountId) => invoke(IPC.alertList, accountId),
    acknowledge: (alertId) => invoke(IPC.alertAcknowledge, alertId)
  },
  agent: {
    getWorkItems: (accountId) => invoke(IPC.agentGetWorkItems, accountId),
    retryWorkItem: (id) => invoke(IPC.agentRetryWorkItem, id),
    cancelWorkItem: (id) => invoke(IPC.agentCancelWorkItem, id),
    getPlan: (accountId) => invoke(IPC.agentGetPlan, accountId),
    getStatus: () => invoke(IPC.agentGetStatus),
    start: () => invoke(IPC.agentStart),
    stop: () => invoke(IPC.agentStop)
  },
  reports: {
    list: (accountId) => invoke(IPC.reportList, accountId),
    respond: (req) => invoke(IPC.reportRespond, req)
  },
  chat: {
    send: (req) => invoke(IPC.chatSend, req),
    list: (accountId, opts) => invoke(IPC.chatList, { accountId, ...opts })
  },
  events: {
    list: (accountId, limit) => invoke(IPC.eventList, accountId, limit ?? 200)
  },
  onEvent: (cb: (ev: UiEvent) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, ev: UiEvent): void => cb(ev)
    ipcRenderer.on(IPC.uiEvent, listener)
    return () => ipcRenderer.removeListener(IPC.uiEvent, listener)
  }
}

contextBridge.exposeInMainWorld('daydream', api)
