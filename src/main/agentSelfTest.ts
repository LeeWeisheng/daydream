/**
 * Agent 自测（DAYDREAM_TEST_AGENT=1 触发，CLI/CI 用）：
 * 1) structuredOutput（flash）2) structuredOutput useProModel（pro）
 * 3) DeepSeek 原生 web search 4) runAgentTurn 工具调用（含 web_search）。
 * 结果写日志，全部通过后退出 0，任一失败退出 1。
 */
import { app } from 'electron'
import { z } from 'zod'
import { ensureAccount, queryAll } from './db'
import { logger } from './services/logger'
import { decryptString } from './services/crypto'
import { structuredOutput, runAgentTurn, isModelConfigured } from './agent/llm'
import { setLlmRunning } from './agent/llmGate'
import { deepseekWebSearch } from './agent/webSearch'
import { SYSTEM_IDENTITY } from './agent/prompts'

const echoSchema = z.object({
  answer: z.string(),
  confidence: z.number()
})

export async function runAgentSelfTest(): Promise<number> {
  const account = ensureAccount()
  if (!account) {
    logger.error('[selftest] FAIL: 无账户（先创建账户）')
    app.exit(1)
    return 1
  }
  logger.info('[selftest] ===== Agent 自测开始 =====')
  // CLI 诊断模式：显式放行模型请求（不受运行开关限制）
  setLlmRunning(true)
  if (!isModelConfigured()) {
    // 诊断：输出配置行与解密结果（不输出密钥明文）
    const row = queryAll<{ value_encrypted: string }>(
      'SELECT value_encrypted FROM app_config WHERE account_id = ? AND key = ?',
      ['global', 'model_config']
    )[0]
    logger.error(
      `[selftest] FAIL: 未配置模型（先运行 DAYDREAM_SEED_MODEL=1 种子）。诊断: row=${!!row} decrypted=${row ? !!decryptString(row.value_encrypted) : false} account=${account.id}`
    )
    return 1
  }

  // 1) structuredOutput（flash）
  try {
    const r1 = await structuredOutput(account.id, {
      system: `${SYSTEM_IDENTITY}\n输出 JSON。`,
      prompt: '用 JSON 回答：1+1 等于几？confidence 取 0~1。',
      schema: echoSchema,
      purpose: 'selftest:echo'
    })
    logger.info(`[selftest] 1) structuredOutput(flash) OK: ${JSON.stringify(r1)}`)
  } catch (e) {
    logger.error(`[selftest] 1) structuredOutput(flash) FAIL: ${(e as Error).message}`)
    return 1
  }

  // 2) structuredOutput with useProModel（pro）
  try {
    const r2 = await structuredOutput(account.id, {
      system: `${SYSTEM_IDENTITY}\n输出 JSON。`,
      prompt: '用 JSON 回答：A 股主板股票每日涨跌幅限制是多少？confidence 取 0~1。',
      schema: echoSchema,
      purpose: 'selftest:echo_pro',
      useProModel: true
    })
    logger.info(`[selftest] 2) structuredOutput(pro) OK: ${JSON.stringify(r2)}`)
  } catch (e) {
    logger.error(`[selftest] 2) structuredOutput(pro) FAIL: ${(e as Error).message}`)
    return 1
  }

  // 3) web search
  try {
    const search = await deepseekWebSearch(account.id, '今天 A 股市场行情')
    logger.info(
      `[selftest] 3) webSearch OK: ${search.sources.length} sources, summary=${search.summary.slice(0, 120).replace(/\n/g, ' ')}`
    )
  } catch (e) {
    logger.error(`[selftest] 3) webSearch FAIL: ${(e as Error).message}`)
    return 1
  }

  // 4) runAgentTurn：让模型调用工具（web_search + get_market_breadth）
  try {
    const reply = await runAgentTurn(account.id, {
      system: `${SYSTEM_IDENTITY}\n本次任务是自测：请依次调用 web_search（搜索"今日A股行情"）与 get_market_breadth 工具，然后用一段话总结你获取到的信息。`,
      prompt: '请执行自测：先用 web_search 搜索今日 A 股行情，再调用 get_market_breadth，最后总结。',
      purpose: 'selftest:agent_turn',
      maxSteps: 8
    })
    logger.info(`[selftest] 4) agentTurn(工具调用) OK: ${reply.slice(0, 200).replace(/\n/g, ' ')}`)
  } catch (e) {
    logger.error(`[selftest] 4) agentTurn FAIL: ${(e as Error).message}`)
    return 1
  }

  logger.info('[selftest] ===== 全部通过 =====')
  app.exit(0)
  return 0
}
