/**
 * 全局状态（Zustand）：账户、主题、运行模式、Agent 状态、统一事件流订阅。
 * 主进程访问经 lib/api（唯一类型化入口），此处不直接触碰 window.daydream。
 */
import { create } from 'zustand'
import { api } from './lib/api'
import type { Account, RunMode, ThemeMode, UiEvent } from '@shared/types'

interface AppState {
  accounts: Account[]
  currentAccount: Account | null
  agentActive: boolean
  agentRunning: boolean
  theme: ThemeMode
  /** 运行模式：manual 手动（默认）/ auto 自动（自动处理审批与信号，策略验证用） */
  runMode: RunMode
  /** 事件计数（对话/信号/汇报刷新触发器） */
  eventSeq: number
  lastEvent: UiEvent | null
  init(): Promise<void>
  switchAccount(accountId: string): Promise<void>
  refreshAccounts(): Promise<void>
  addAccount(name: string): Promise<void>
  startAgent(): Promise<void>
  stopAgent(): Promise<void>
  setTheme(mode: ThemeMode): Promise<void>
  setRunMode(mode: RunMode): Promise<void>
  subscribeEvents(): void
}

export const useAppStore = create<AppState>((set, get) => ({
  accounts: [],
  currentAccount: null,
  agentActive: false,
  agentRunning: false,
  theme: 'system',
  runMode: 'manual',
  eventSeq: 0,
  lastEvent: null,
  async init() {
    const accounts = await api.accounts.list()
    const theme = await api.theme.get().catch(() => 'system' as ThemeMode)
    const runMode = await api.runMode.get().catch(() => 'manual' as RunMode)
    const current = accounts[0] ?? null
    set({ accounts, currentAccount: current, theme, runMode })
    const status = await api.agent.getStatus()
    set({ agentActive: status.active, agentRunning: status.running })
    get().subscribeEvents()
  },
  async switchAccount(accountId: string) {
    const account = await api.accounts.switchTo({ accountId })
    set({ currentAccount: account })
  },
  async refreshAccounts() {
    const accounts = await api.accounts.list()
    const current = accounts.find((a) => a.id === get().currentAccount?.id) ?? accounts[0] ?? null
    set({ accounts, currentAccount: current })
  },
  async addAccount(name: string) {
    await api.accounts.create({ name })
    await get().refreshAccounts()
  },
  async startAgent() {
    await api.agent.start()
    set({ agentRunning: true })
  },
  async stopAgent() {
    await api.agent.stop()
    set({ agentRunning: false, agentActive: false })
  },
  async setTheme(mode: ThemeMode) {
    await api.theme.set(mode)
    set({ theme: mode })
  },
  async setRunMode(mode: RunMode) {
    await api.runMode.set(mode)
    set({ runMode: mode })
  },
  subscribeEvents() {
    api.onEvent((ev) => {
      if (ev.type === 'agent.status') {
        const payload = ev.payload as { running?: boolean }
        set({ agentRunning: payload.running ?? false, agentActive: true, lastEvent: ev, eventSeq: get().eventSeq + 1 })
        return
      }
      if (ev.type === 'runMode.changed') {
        const payload = ev.payload as { runMode?: RunMode }
        set({ runMode: payload.runMode ?? 'manual', lastEvent: ev, eventSeq: get().eventSeq + 1 })
        return
      }
      set({ lastEvent: ev, agentActive: true, eventSeq: get().eventSeq + 1 })
    })
  }
}))

export function currentAccountId(): string {
  return useAppStore.getState().currentAccount?.id ?? ''
}
