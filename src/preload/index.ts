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
    remove: (accountId) => invoke(IPC.accountDelete, accountId)
  },
  settings: {
    get: (accountId) => invoke(IPC.settingsGet, accountId),
    update: (accountId, patch) => invoke(IPC.settingsUpdate, accountId, patch)
  },
  data: {
    getStockList: () => invoke(IPC.dataGetStockList),
    getQuote: (codes) => invoke(IPC.dataGetQuote, codes),
    getKline: (code, start, end) => invoke(IPC.dataGetKline, { code, start, end }),
    getDataStatus: () => invoke(IPC.dataGetDataStatus),
    initialSync: () => invoke(IPC.dataInitialSync),
    dailyUpdate: () => invoke(IPC.dataDailyUpdate)
  },
  strategies: {
    list: (accountId) => invoke(IPC.strategyList, accountId),
    get: (id) => invoke(IPC.strategyGet, id),
    create: (req) => invoke(IPC.strategyCreate, req),
    update: (id, dslJson, changeLog) => invoke(IPC.strategyUpdate, { id, dslJson, changeLog }),
    activate: (id) => invoke(IPC.strategyActivate, { id }),
    deactivate: (id) => invoke(IPC.strategyDeactivate, { id })
  },
  backtests: {
    start: (req) => invoke(IPC.backtestStart, req),
    cancel: (runId) => invoke(IPC.backtestCancel, runId),
    list: (accountId) => invoke(IPC.backtestList, accountId),
    getResult: (runId) => invoke(IPC.backtestGetResult, runId),
    getTrades: (runId) => invoke(IPC.backtestGetTrades, runId)
  },
  signals: {
    list: (accountId, limit) => invoke(IPC.signalList, accountId, limit ?? 100),
    feedback: (req) => invoke(IPC.signalFeedback, req)
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
  perf: {
    getSnapshot: (accountId) => invoke(IPC.perfGetSnapshot, accountId),
    getCharts: (accountId) => invoke(IPC.perfGetCharts, accountId)
  },
  reviews: {
    list: (accountId) => invoke(IPC.reviewList, accountId),
    getReport: (id) => invoke(IPC.reviewGetReport, id)
  },
  positions: {
    list: (accountId) => invoke(IPC.positionList, accountId),
    upsert: (req) => invoke(IPC.positionUpsert, req)
  },
  trades: {
    list: (accountId) => invoke(IPC.tradeList, accountId),
    create: (req) => invoke(IPC.tradeCreate, req)
  },
  audit: {
    list: (accountId, limit) => invoke(IPC.auditList, accountId, limit ?? 200),
    events: (accountId, limit) => invoke(IPC.eventList, accountId, limit ?? 200)
  },
  chat: {
    send: (req) => invoke(IPC.chatSend, req)
  },
  runs: {
    list: (accountId) => invoke('runs:list', accountId)
  },
  onEvent: (cb: (ev: UiEvent) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, ev: UiEvent): void => cb(ev)
    ipcRenderer.on(IPC.uiEvent, listener)
    return () => ipcRenderer.removeListener(IPC.uiEvent, listener)
  }
}

contextBridge.exposeInMainWorld('daydream', api)
