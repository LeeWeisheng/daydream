/**
 * LLM 调用闸门：所有大模型请求（结构化输出 / Agent 会话 / 联网搜索）的唯一出入口。
 * 语义：
 * - 点击「停止运行」后，任何账户的模型请求一律拒绝（抛 LlmBlockedError，不重试）；
 * - 应用退出或系统关机时闸门永久关闭，本次进程生命周期内不再放行；
 * - 关闸只阻止"新的"请求，在途请求必须靠终止桥接子进程中断（见 llmBridge.shutdownBridge）。
 */
import { logger } from '../services/logger'

export class LlmBlockedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LlmBlockedError'
  }
}

/** 运行开关（与 Agent 内存状态同步；持久化由 app_config 的 agent_running 负责） */
let running = false
/** 退出/关机后永久关闸 */
let closed = false

/** 同步运行开关（启动初始化 / 用户开始-停止运行） */
export function setLlmRunning(value: boolean): void {
  running = value
}

/** 关闭闸门：应用退出、系统关机时调用（不可逆） */
export function closeLlmGate(reason: string): void {
  if (closed) return
  closed = true
  running = false
  logger.info(`[llm] gate closed (${reason})：禁止后续全部模型请求`)
}

export function isLlmGateClosed(): boolean {
  return closed
}

/** 闸门是否放行（false 表示已停止运行或正在退出） */
export function isLlmGateOpen(): boolean {
  return running && !closed
}

/** 闸门校验：未放行即抛 LlmBlockedError（调用方不得重试） */
export function assertLlmAllowed(accountId: string, purpose: string): void {
  if (closed) throw new LlmBlockedError(`应用已退出或正在退出，禁止模型请求（${purpose}）`)
  if (!running) throw new LlmBlockedError(`Agent 已停止运行，禁止模型请求（${purpose}）`)
  void accountId
}
