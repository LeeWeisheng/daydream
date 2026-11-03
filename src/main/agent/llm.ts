/**
 * LLM 接入层：经 llmBridge（系统 node 子进程运行 claude-agent-sdk）调用模型。
 * 背景：claude-agent-sdk 在 Electron 主进程强制走 native binary（spawn 失败），
 * 纯 Node 环境稳定可用，故桥接到子进程；业务工具经 RPC 在主进程执行。
 * 用户配置 Anthropic 兼容 API（原生 Claude / DeepSeek anthropic 端点 / 其他兼容服务）。
 * 结构化输出经 outputFormat(json_schema) + Zod 校验，失败自动重试；调用统计进审计。
 */
import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'
import { auditLlmCall } from '../services/audit'
import { logger } from '../services/logger'
import { bridgeStructuredOutput, bridgeAgentTurn } from './llmBridge'
import { getModelConfig } from './modelConfig'

export { getModelConfig }

export class LlmUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LlmUnavailableError'
  }
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/**
 * 结构化输出：桥接子进程 outputFormat(json_schema) + Zod Schema 校验，失败自动重试。
 */
export async function structuredOutput<T>(
  accountId: string,
  opts: {
    system: string
    prompt: string
    schema: z.ZodType<T>
    retries?: number
    purpose: string
    useProModel?: boolean
  }
): Promise<T> {
  const jsonSchema = zodToJsonSchema(opts.schema) as Record<string, unknown>
  const attempts = opts.retries ?? 2
  let lastError: Error | null = null
  for (let attempt = 0; attempt <= attempts; attempt++) {
    try {
      const result = await bridgeStructuredOutput({
        accountId,
        system: opts.system,
        prompt: opts.prompt,
        jsonSchema,
        purpose: opts.purpose,
        useProModel: opts.useProModel
      })
      auditLlmCall(accountId, 'structured', opts.purpose, result.modelUsage, true)
      // structured_output 为主，result 文本 JSON 兜底
      const raw = result.structuredOutput ?? safeJsonParse(result.result)
      if (raw == null) throw new Error('结构化输出为空')
      return opts.schema.parse(raw)
    } catch (e) {
      lastError = e as Error
      auditLlmCall(accountId, 'structured', opts.purpose, null, false)
      logger.warn(`[llm] structured output attempt ${attempt + 1} failed for ${opts.purpose}: ${lastError.message}`)
    }
  }
  throw new LlmUnavailableError(`结构化输出失败（${opts.purpose}）: ${lastError?.message}`)
}

/**
 * Agent 会话执行：桥接子进程内建 agentic loop（工具循环，maxTurns 上限）。
 * 业务工具经 RPC 回主进程执行，权限仅放行自有工具。
 */
export async function runAgentTurn(
  accountId: string,
  opts: {
    system: string
    prompt: string
    purpose: string
    maxSteps?: number
    useProModel?: boolean
  }
): Promise<string> {
  try {
    const result = await bridgeAgentTurn({
      accountId,
      system: opts.system,
      prompt: opts.prompt,
      purpose: opts.purpose,
      maxSteps: opts.maxSteps,
      useProModel: opts.useProModel
    })
    auditLlmCall(accountId, 'agent', opts.purpose, result.modelUsage, true)
    return result.result
  } catch (e) {
    if (e instanceof LlmUnavailableError) throw e
    auditLlmCall(accountId, 'agent', opts.purpose, null, false)
    throw new LlmUnavailableError(`Agent 会话失败（${opts.purpose}）: ${(e as Error).message}`)
  }
}

/** 模型是否已配置（全局通用，供状态查询） */
export function isModelConfigured(): boolean {
  return getModelConfig() != null
}
