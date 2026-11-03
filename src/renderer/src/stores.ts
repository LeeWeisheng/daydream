/**
 * 全局状态（Zustand）：当前账户、Agent 状态、统一事件流订阅。
 */
import { create } from 'zustand'
import type { Account, UiEvent } from '@shared/types'

interface AppState {
  accounts: Account[]
  currentAccount: Account | null
  agentActive: boolean
  agentRunning: boolean
  lastEvent: UiEvent | null
  init(): Promise<void>
  switchAccount(accountId: string): Promise<void>
  startAgent(): Promise<void>
  stopAgent(): Promise<void>
  subscribeEvents(): void
}

export const useAppStore = create<AppState>((set, get) => ({
  accounts: [],
  currentAccount: null,
  agentActive: false,
  agentRunning: false,
  lastEvent: null,
  async init() {
    const accounts = await window.daydream.accounts.list()
    const current = accounts[0] ?? null
    set({ accounts, currentAccount: current })
    const status = await window.daydream.agent.getStatus()
    set({ agentActive: status.active, agentRunning: status.running })
    get().subscribeEvents()
  },
  async switchAccount(accountId: string) {
    const account = await window.daydream.accounts.switchTo({ accountId })
    set({ currentAccount: account })
  },
  async startAgent() {
    await window.daydream.agent.start()
    set({ agentRunning: true })
  },
  async stopAgent() {
    await window.daydream.agent.stop()
    set({ agentRunning: false, agentActive: false })
  },
  subscribeEvents() {
    window.daydream.onEvent((ev) => {
      if (ev.type === 'agent.status') {
        const payload = ev.payload as { running?: boolean }
        set({ agentRunning: payload.running ?? false, agentActive: true, lastEvent: ev })
        return
      }
      set({ lastEvent: ev, agentActive: true })
    })
  }
}))

export function currentAccountId(): string {
  return useAppStore.getState().currentAccount?.id ?? ''
}
