/**
 * IPC API 客户端：渲染进程访问主进程能力的唯一类型化入口。
 * 页面与 store 一律经此模块访问 window.daydream，不直接触碰全局对象
 * （便于替换 transport、集中错误处理与 mock）。
 */
import type { Account, ChatMessage, RunMode, ThemeMode, UiEvent } from '@shared/types'
import type { DaydreamApi } from '@shared/ipc'

const api: DaydreamApi = window.daydream

export { api }

export type { Account, ChatMessage, RunMode, ThemeMode, UiEvent }

/** 统一异常：把 IPC 拒绝转换为可读错误（错误码文案由主进程 UserError 提供） */
export function toMessage(e: unknown): string {
  if (e instanceof Error) {
    const text = e.message.replace(/^Error invoking remote method '[^']+': /, '')
    return text || e.message
  }
  return String(e)
}

/** 订阅主进程统一事件流；返回取消订阅函数 */
export function onEvent(cb: (ev: UiEvent) => void): () => void {
  return api.onEvent(cb)
}
