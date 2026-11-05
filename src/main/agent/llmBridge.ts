/**
 * LLM 桥接客户端（主进程侧）：spawn 系统 node 运行 bridgeServer 子进程，
 * 经 stdin/stdout JSON 行协议通信（详见 bridgeServer.ts）。
 * 工具调用（toolCall 通知）在主进程内执行后回传结果。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import * as readline from 'node:readline'
import { join } from 'node:path'
import { logger } from '../services/logger'
import { executeToolCall } from './tools'
import { getModelConfig } from './modelConfig'
import { recordSdkMessage } from './messageSink'
import { assertLlmAllowed } from './llmGate'

interface PendingRequest {
  resolve: (msg: { ok: boolean; data?: unknown; error?: string }) => void
}

let bridge: ChildProcess | null = null
let bridgeReady = false
/** 正在关闭（停止运行/退出）：不再向子进程写任何请求 */
let bridgeClosing = false
const pending = new Map<string, PendingRequest>()
let nextId = 1
let initAccountId = ''

function bridgePath(): string {
  // electron-vite 将 bridgeServer 输出为 out/main/bridgeServer.js
  return join(__dirname, 'bridgeServer.js')
}

function nodeCommand(): string {
  // 优先系统 node；Electron 环境需真实 node 运行时（SDK 在 node 下运行）
  const candidates = process.env.PATH?.split(':').map((p) => join(p, 'node')) ?? []
  for (const c of candidates) {
    try {
      const { spawnSync } = require('node:child_process') as typeof import('node:child_process')
      const r = spawnSync(c, ['--version'], { timeout: 3000 })
      if (r.status === 0 && r.stdout) return c
    } catch {
      /* 继续 */
    }
  }
  return 'node'
}

/** 启动桥接子进程并初始化模型配置（幂等） */
export async function ensureBridge(accountId: string): Promise<void> {
  // 闸门已关（停止运行/退出）：不得拉起子进程，更不得发请求
  assertLlmAllowed(accountId, 'bridge')
  initAccountId = accountId
  if (bridge && bridgeReady) return
  if (!bridge) {
    const cmd = nodeCommand()
    const script = bridgePath()
    logger.info(`[bridge] spawning node bridge: ${cmd} ${script}`)
    bridgeClosing = false
    bridge = spawn(cmd, [script], {
      stdio: ['pipe', 'pipe', 'pipe'],
      // 独立进程组：停止运行/退出时可连同 SDK 再拉起的 cli 子进程一起终止
      detached: true,
      cwd: join(__dirname, '..', '..')
    })
    bridge.on('error', (e) => {
      logger.error(`[bridge] spawn failed: ${e.message}`)
      bridge = null
      bridgeReady = false
    })
    bridge.on('exit', (code) => {
      logger.warn(`[bridge] exited with code ${code}`)
      bridge = null
      bridgeReady = false
      // 失败所有等待中的请求
      for (const [, p] of pending) p.resolve({ ok: false, error: 'LLM 桥接进程退出' })
      pending.clear()
    })
    bridge.stderr?.on('data', (d) => logger.warn(`[bridge] stderr: ${String(d).slice(0, 300)}`))

    const rl = readline.createInterface({ input: bridge.stdout! })
    rl.on('line', (line) => {
      let msg: { id?: string; ok?: boolean; data?: unknown; error?: string; method?: string; params?: Record<string, unknown> }
      try {
        msg = JSON.parse(line)
      } catch {
        return
      }
      if (msg.method === 'toolCall' && msg.params) {
        // bridge 请求执行工具 → 主进程执行后回传
        void handleToolCall(msg.params).catch((e) =>
          send({ id: String(msg.params?.toolCallId), ok: false, error: (e as Error).message })
        )
        return
      }
      if (msg.method === 'agentMessage' && msg.params) {
        // bridge 转发的 Claude 消息流 → 记录到首页对话流（运行细节折叠）
        recordSdkMessage(
          String(msg.params.accountId ?? ''),
          msg.params.workItemId ? String(msg.params.workItemId) : undefined,
          String(msg.params.purpose ?? ''),
          msg.params.msg as Record<string, unknown>
        )
        return
      }
      if (msg.id) {
        const p = pending.get(msg.id)
        if (p) {
          pending.delete(msg.id)
          p.resolve({ ok: Boolean(msg.ok), data: msg.data, error: msg.error })
        }
      }
    })
  }

  // init 握手（携带模型配置，全局通用）
  const cfg = getModelConfig()
  if (!cfg) throw new Error('未配置模型（设置 → 模型配置）')
  const resp = await request('init', { modelConfig: { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model, modelPro: cfg.modelPro ?? '' } })
  if (!resp.ok) throw new Error(String(resp.error ?? '桥接初始化失败'))
  bridgeReady = true
}

function send(msg: Record<string, unknown>): void {
  if (bridgeClosing) throw new Error('LLM 桥接已关闭（已停止运行/正在退出）')
  if (!bridge?.stdin?.writable) throw new Error('LLM 桥接进程不可用')
  bridge.stdin.write(JSON.stringify(msg) + '\n')
}

function request(method: string, params: Record<string, unknown>): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  if (!bridge) throw new Error('LLM 桥接进程未启动')
  const id = String(nextId++)
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id)
        resolve({ ok: false, error: `桥接请求超时: ${method}` })
      }
    }, 600_000)
    pending.set(id, {
      resolve: (msg) => {
        clearTimeout(timer)
        resolve(msg)
      }
    })
    try {
      send({ id, method, params })
    } catch (e) {
      clearTimeout(timer)
      pending.delete(id)
      resolve({ ok: false, error: (e as Error).message })
    }
  })
}

/** 主进程执行工具（bridge 请求） */
async function handleToolCall(params: Record<string, unknown>): Promise<void> {
  // 已关闸：不再执行工具（工具可能间接消耗模型配额，如联网搜索）
  if (bridgeClosing) return
  const toolCallId = String(params.toolCallId ?? '')
  const tool = String(params.tool ?? '')
  const args = (params.args ?? {}) as Record<string, unknown>
  try {
    const data = await executeToolCall(initAccountId, tool, args)
    if (!bridgeClosing) send({ id: toolCallId, ok: true, data })
  } catch (e) {
    if (!bridgeClosing) send({ id: toolCallId, ok: false, error: (e as Error).message })
  }
}

export interface BridgeStructuredParams {
  accountId: string
  system: string
  prompt: string
  jsonSchema: Record<string, unknown>
  purpose: string
  useProModel?: boolean
  /** 关联工作项（消息流分组） */
  workItemId?: string
}

export interface BridgeAgentTurnParams {
  accountId: string
  system: string
  prompt: string
  purpose: string
  maxSteps?: number
  useProModel?: boolean
  /** 关联工作项（消息流分组） */
  workItemId?: string
}

/** 结构化输出（经桥接） */
export async function bridgeStructuredOutput(params: BridgeStructuredParams): Promise<{ structuredOutput?: unknown; result: string; modelUsage?: unknown }> {
  await ensureBridge(params.accountId)
  assertLlmAllowed(params.accountId, params.purpose)
  const resp = await request('structuredOutput', {
    accountId: params.accountId,
    system: params.system,
    prompt: params.prompt,
    jsonSchema: params.jsonSchema,
    purpose: params.purpose,
    workItemId: params.workItemId ?? null,
    useProModel: Boolean(params.useProModel)
  })
  if (!resp.ok) throw new Error(String(resp.error ?? '桥接结构化输出失败'))
  return resp.data as { structuredOutput?: unknown; result: string; modelUsage?: unknown }
}

/** Agent 会话（经桥接，工具回主进程执行） */
export async function bridgeAgentTurn(params: BridgeAgentTurnParams): Promise<{ result: string; modelUsage?: unknown }> {
  await ensureBridge(params.accountId)
  assertLlmAllowed(params.accountId, params.purpose)
  const resp = await request('agentTurn', {
    accountId: params.accountId,
    system: params.system,
    prompt: params.prompt,
    purpose: params.purpose,
    workItemId: params.workItemId ?? null,
    maxSteps: params.maxSteps ?? 12,
    useProModel: Boolean(params.useProModel)
  })
  if (!resp.ok) throw new Error(String(resp.error ?? '桥接 Agent 会话失败'))
  return resp.data as { result: string; modelUsage?: unknown }
}

// ---------- 生命周期：停止运行 / 退出 / 关机时终止子进程 ----------

/** 终止桥接子进程及其后代（detached 后子进程为进程组长，可覆盖 SDK 再拉起的 cli 子进程） */
function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return
  try {
    process.kill(-child.pid, signal)
  } catch {
    try {
      child.kill(signal)
    } catch {
      /* 进程已退出 */
    }
  }
}

function waitExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

/**
 * 关闭桥接（停止运行 / 应用退出）：先失败在途请求，再终止子进程组。
 * 返回时保证子进程已退出（SIGTERM → 1.5s → SIGKILL），不再有残留模型请求。
 */
export async function shutdownBridge(reason: string): Promise<void> {
  const child = bridge
  bridgeClosing = true
  bridge = null
  bridgeReady = false
  for (const [, p] of pending) p.resolve({ ok: false, error: 'LLM 桥接已关闭，模型请求已中断' })
  pending.clear()
  if (!child) return
  if (child.exitCode !== null || child.signalCode !== null) return
  logger.info(`[bridge] shutdown (${reason})`)
  try {
    child.stdin?.end()
  } catch {
    /* 管道已关闭 */
  }
  killTree(child, 'SIGTERM')
  await waitExit(child, 1500)
  killTree(child, 'SIGKILL')
  child.stdout?.destroy()
  child.stderr?.destroy()
}

/** 同步终止（process exit / 系统关机等不能 await 的场景） */
export function killBridgeSync(reason: string): void {
  const child = bridge
  bridgeClosing = true
  bridge = null
  bridgeReady = false
  pending.clear()
  if (!child) return
  logger.info(`[bridge] kill sync (${reason})`)
  killTree(child, 'SIGKILL')
}

/** 桥接是否正在关闭（停止运行/退出流程中） */
export function isBridgeClosing(): boolean {
  return bridgeClosing
}
