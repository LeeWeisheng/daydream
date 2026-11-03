import type { DaydreamApi } from '@shared/ipc'

declare global {
  interface Window {
    daydream: DaydreamApi
  }
}

export {}
