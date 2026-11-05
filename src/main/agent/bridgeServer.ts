/**
 * LLM 桥接服务端（独立入口，由主进程 spawn 系统 node 运行）。
 * 背景：claude-agent-sdk 在 Electron 主进程强制走 native binary（Electron 下 spawn 失败），
 * 而在纯 Node 环境走 JS 运行时且稳定可用；故将 SDK 隔离到本子进程，经 stdin/stdout JSON 行协议通信。
 * 工具不在此进程执行：SDK 工具为 stub，调用时发 tool_call 通知给主进程，由主进程执行并回传结果。
 *
 * 协议（每行一个 JSON）：
 *  主进程 → 本进程: {id, method: 'init'|'structuredOutput'|'agentTurn', params}
 *  本进程 → 主进程: {id, ok, data?} | {id, ok:false, error}
 *  本进程 → 主进程: {method:'toolCall', params:{toolCallId, tool, args}}   （主进程执行后回 {id:toolCallId, ok, data|error}）
 */
import * as readline from 'node:readline'
import { TOOL_SCHEMAS } from './toolSchemas'

interface RpcRequest {
  id: string
  method: string
  params: Record<string, unknown>
}

interface ModelCfg {
  baseUrl: string
  apiKey: string
  model: string
  modelPro?: string
}

let modelCfg: ModelCfg | null = null
let sdk: typeof import('@anthropic-ai/claude-agent-sdk') | null = null
/** 在途 query 的中止句柄（父进程退出 / 停止运行时立即中断模型请求） */
let currentAbort: AbortController | null = null
/** 已关闭：不再接受新请求、不再向父进程写消息 */
let closed = false

/**
 * 关闭桥接：中止在途模型请求并退出。
 * 触发场景：父进程（Electron 主进程）退出导致 stdin EOF / 父进程消失 / 收到 SIGTERM。
 * 这是"应用退出后不得再有模型请求"的子进程侧兜底。
 */
function shutdown(reason: string, code = 0): void {
  if (closed) return
  closed = true
  try {
    process.stderr.write(`[bridge] shutdown: ${reason}\n`)
  } catch {
    /* 父进程已退出，管道不可写 */
  }
  currentAbort?.abort()
  // 给 SDK 一点时间终止其 cli 子进程，再强制退出（不再等待任何网络响应）
  setTimeout(() => process.exit(code), 200).unref()
}

function send(msg: Record<string, unknown>): void {
  if (closed) return
  try {
    process.stdout.write(JSON.stringify(msg) + '\n')
  } catch {
    shutdown('stdout 写入失败（父进程已退出）')
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
process.stdout.on('error', () => shutdown('stdout EPIPE'))

async function loadSdk(): Promise<typeof import('@anthropic-ai/claude-agent-sdk')> {
  if (!sdk) sdk = await import('@anthropic-ai/claude-agent-sdk')
  return sdk
}

/** 构建 SDK MCP 工具（stub：调用时 RPC 回主进程执行），返回工具数组 */
function buildTools(): ReturnType<typeof import('@anthropic-ai/claude-agent-sdk').tool>[] {
  const sdkMod = sdk!
  return TOOL_SCHEMAS.map((def) =>
    sdkMod.tool(
      def.name,
      def.description,
      def.zodShape,
      async (args: Record<string, unknown>) => {
        const toolCallId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        const response = await rpcToHost({ method: 'toolCall', params: { toolCallId, tool: def.name, args } })
        if (!response.ok) {
          return { isError: true, content: [{ type: 'text', text: String(response.error ?? '工具执行失败') }] }
        }
        const text = typeof response.data === 'string' ? response.data : JSON.stringify(response.data)
        return { content: [{ type: 'text', text }] }
      }
    )
  )
}

/** 向主进程发通知并等待响应 */
const pendingToolCalls = new Map<string, (msg: { id: string; ok: boolean; data?: unknown; error?: string }) => void>()

function rpcToHost(msg: { method: string; params: Record<string, unknown> }): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  return new Promise((resolve) => {
    const id = msg.params.toolCallId as string
    pendingToolCalls.set(id, resolve)
    send(msg)
    // 超时兜底（120s，工具可能较慢如搜索）
    setTimeout(() => {
      if (pendingToolCalls.has(id)) {
        pendingToolCalls.delete(id)
        resolve({ ok: false, error: '工具调用超时' })
      }
    }, 120_000)
  })
}

function baseOptions(usePro: boolean): Record<string, unknown> {
  if (!modelCfg) throw new Error('bridge 未初始化（缺少模型配置）')
  const model = usePro && modelCfg.modelPro ? modelCfg.modelPro : modelCfg.model
  return {
    cwd: process.cwd(),
    model,
    executable: 'node',
    env: {
      ...(process.env as Record<string, string>),
      ANTHROPIC_BASE_URL: modelCfg.baseUrl,
      ANTHROPIC_AUTH_TOKEN: modelCfg.apiKey,
      ANTHROPIC_API_KEY: modelCfg.apiKey,
      ANTHROPIC_MODEL: model,
      ANTHROPIC_SMALL_FAST_MODEL: model
    },
    permissionMode: 'dontAsk',
    canUseTool: async (toolName: string) =>
      toolName.startsWith('mcp__daydream__')
        ? { behavior: 'allow' as const, updatedInput: {} }
        : { behavior: 'deny' as const, message: `工具 ${toolName} 不允许` }
  }
}

async function runQuery(
  prompt: string,
  options: Record<string, unknown>,
  trace: { accountId: string; workItemId?: string; purpose: string }
): Promise<{ result: string; structuredOutput?: unknown; modelUsage?: unknown }> {
  if (closed) throw new Error('桥接已关闭')
  const controller = new AbortController()
  currentAbort = controller
  try {
    return await iterateQuery(prompt, { ...options, abortController: controller }, trace)
  } finally {
    if (currentAbort === controller) currentAbort = null
  }
}

async function iterateQuery(
  prompt: string,
  options: Record<string, unknown>,
  trace: { accountId: string; workItemId?: string; purpose: string }
): Promise<{ result: string; structuredOutput?: unknown; modelUsage?: unknown }> {
  const sdkMod = await loadSdk()
  const q = sdkMod.query({ prompt, options: options as never })
  let last: { result: string; structuredOutput?: unknown; modelUsage?: unknown } | null = null
  for await (const msg of q) {
    if (msg.type === 'result') {
      const m = msg as { subtype?: string; result?: string; structured_output?: unknown; modelUsage?: unknown; errors?: unknown[] }
      if (m.subtype === 'success') {
        last = { result: m.result ?? '', structuredOutput: m.structured_output, modelUsage: m.modelUsage }
      } else {
        const detail = m.result ?? (m.errors ?? []).map((e) => JSON.stringify(e)).join('; ')
        throw new Error(`Claude Agent 执行失败: ${detail || '未知错误'}`)
      }
      continue
    }
    // 转发全部消息给主进程记录（stream_event 增量流等高频噪声除外）
    if (msg.type === 'stream_event') continue
    send({
      method: 'agentMessage',
      params: { accountId: trace.accountId, workItemId: trace.workItemId, purpose: trace.purpose, msg }
    })
  }
  if (!last) throw new Error('Claude Agent 无结果返回')
  return last
}

async function handleRequest(req: RpcRequest): Promise<void> {
  if (closed) return
  try {
    switch (req.method) {
      case 'init': {
        modelCfg = req.params.modelConfig as ModelCfg
        await loadSdk()
        send({ id: req.id, ok: true, data: { ready: true } })
        return
      }
      case 'structuredOutput': {
        const p = req.params
        const result = await runQuery(
          String(p.prompt),
          {
            ...baseOptions(Boolean(p.useProModel)),
            systemPrompt: String(p.system),
            outputFormat: { type: 'json_schema', schema: p.jsonSchema },
            maxTurns: 4
          },
          { accountId: String(p.accountId ?? ''), workItemId: p.workItemId ? String(p.workItemId) : undefined, purpose: String(p.purpose ?? 'structured') }
        )
        send({ id: req.id, ok: true, data: { structuredOutput: result.structuredOutput, result: result.result, modelUsage: result.modelUsage } })
        return
      }
      case 'agentTurn': {
        const p = req.params
        const sdkMod = await loadSdk()
        const server = sdkMod.createSdkMcpServer({
          name: 'daydream',
          version: '1.0.0',
          instructions: 'Daydream 业务工具集：市场数据、策略管理、回测、风控、信号、预警、汇报与联网搜索。',
          tools: buildTools()
        })
        const result = await runQuery(
          String(p.prompt),
          {
            ...baseOptions(Boolean(p.useProModel)),
            systemPrompt: String(p.system),
            mcpServers: { daydream: server },
            allowedTools: TOOL_SCHEMAS.map((t) => `mcp__daydream__${t.name}`),
            maxTurns: Number(p.maxSteps ?? 12)
          },
          { accountId: String(p.accountId ?? ''), workItemId: p.workItemId ? String(p.workItemId) : undefined, purpose: String(p.purpose ?? 'agent_turn') }
        )
        send({ id: req.id, ok: true, data: { result: result.result, modelUsage: result.modelUsage } })
        return
      }
      default:
        send({ id: req.id, ok: false, error: `未知方法: ${req.method}` })
    }
  } catch (e) {
    if (!closed) send({ id: req.id, ok: false, error: (e as Error).message })
  }
}

async function main(): Promise<void> {
  // 父进程退出后本进程会被 launchd 收养：检测到 ppid 变化立即自杀，避免残留模型请求
  const parentPid = process.ppid
  const watchdog = setInterval(() => {
    if (!closed && process.ppid !== parentPid) shutdown('父进程已退出')
  }, 2000)
  watchdog.unref()

  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
  // stdin EOF（父进程退出）：中止在途请求并退出
  rl.on('close', () => shutdown('stdin 已关闭'))
  for await (const line of rl) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let msg: { id?: string; ok?: boolean; data?: unknown; error?: string; method?: string; params?: Record<string, unknown> }
    try {
      msg = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (msg.id && !msg.method) {
      // 主进程执行工具后的响应 → 转发给等待中的 tool stub
      const waiter = pendingToolCalls.get(msg.id)
      if (waiter) {
        pendingToolCalls.delete(msg.id)
        waiter({ id: msg.id, ok: Boolean(msg.ok), data: msg.data, error: msg.error })
      }
      continue
    }
    if (msg.id && msg.method) {
      void handleRequest({ id: msg.id, method: msg.method, params: msg.params ?? {} })
    }
  }
  shutdown('请求循环结束')
}

main().catch((e) => {
  send({ id: 'fatal', ok: false, error: `bridge fatal: ${(e as Error).message}` })
  process.exit(1)
})
