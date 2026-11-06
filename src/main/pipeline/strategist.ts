/**
 * 自动生成策略（strategist）：依据规划方向与市场数据生成/迭代账户唯一策略 Markdown 文档。
 * 文档内嵌 ```dsl 代码块（白名单指标）作为可执行部分；新版本留档并自动创建回测工作项。
 */
import { z } from 'zod'
import { audit } from '../services/audit'
import { logger } from '../services/logger'
import { structuredOutput } from '../app/sessions'
import { STRATEGIST_PROMPT, SYSTEM_IDENTITY } from '../agent/prompts'
import { getStrategyForAccount, latestVersionId, saveStrategyMarkdown, setStrategyStatus } from '../strategy/service'
import { extractDslFromMarkdown } from '@shared/strategy/schema'
import type { PipelineHost } from './index'

// 生成约束：LLM 输出策略文档（Markdown + 名称）
const genSchema = z.object({
  name: z.string().min(1).max(64),
  markdown: z.string().min(1).describe('策略 Markdown 文档，必须内嵌一个 ```dsl JSON 代码块（可执行部分）'),
  rationale: z.string().default('')
})

export async function runFromPlan(accountId: string, context: Record<string, unknown>, host?: PipelineHost): Promise<Record<string, unknown>> {
  const direction = String(context.direction ?? '未命名方向')
  const description = String(context.description ?? '')
  // 每账户唯一策略：读取现有文档与用户偏好（偏好仅作约束，不可修改）
  const existing = getStrategyForAccount(accountId)
  const prompt = JSON.stringify(
    {
      direction,
      description,
      existingStrategy: existing ? { name: existing.name, status: existing.status, markdown: existing.markdown } : null,
      note: '每账户只有一份策略。输出完整策略 Markdown 文档：自然语言说明策略逻辑/选股域/入场出场条件/组合约束，并内嵌一个 ```dsl JSON 代码块（白名单指标）。'
    },
    null,
    2
  )
  const generated = await structuredOutput(accountId, {
    system: `${SYSTEM_IDENTITY}\n\n${STRATEGIST_PROMPT}`,
    prompt,
    schema: genSchema,
    purpose: `generate_strategy:${direction}`,
    useProModel: true
  })

  // 提取 ```dsl 块全量校验（白名单指标/参数/复杂度），未通过则不落库（失败即失败）
  const extracted = extractDslFromMarkdown(generated.markdown)
  if (extracted.errors.length > 0) {
    throw new Error(`生成的策略 Markdown 校验失败: ${extracted.errors.join('; ')}`)
  }
  if (!extracted.dsl) {
    throw new Error('生成的策略 Markdown 缺少可执行的 ```dsl 代码块')
  }
  // 首次创建或迭代新版本（不改用户偏好）
  const strategy = saveStrategyMarkdown({
    accountId,
    name: generated.name,
    markdown: generated.markdown,
    rationale: generated.rationale || String(extracted.dsl.meta.rationale ?? ''),
    createdBy: 'agent'
  })
  audit({ accountId, actor: 'agent', action: 'strategy.generated', target: strategy.id, detail: { direction, version: strategy.version } })

  // 自动创建回测工作项
  const btItem = host?.enqueueTicket({
    accountId,
    type: 'backtest',
    priority: 'medium',
    context: { strategyId: strategy.id, strategyVersionId: latestVersionId(strategy.id) ?? '', __busKey: `strategy:${strategy.id}` }
  })
  logger.info(`[pipeline] strategy generated: ${strategy.name} v${strategy.version} (${strategy.id}), backtest workitem ${btItem?.id ?? '-'}`)
  return { strategyId: strategy.id, name: strategy.name, version: strategy.version, backtestWorkItemId: btItem?.id }
}

/** 供 UI/用户请求复用的入口（不依赖 LLM 时由调用方提供 Markdown） */
export function createFromMarkdown(accountId: string, name: string, markdown: string, rationale: string): Record<string, unknown> {
  const extracted = extractDslFromMarkdown(markdown)
  if (extracted.errors.length > 0) throw new Error(`Markdown 校验失败: ${extracted.errors.join('; ')}`)
  if (!extracted.dsl) throw new Error('策略 Markdown 缺少可执行的 ```dsl 代码块')
  const strategy = saveStrategyMarkdown({ accountId, name, markdown, rationale, createdBy: 'user' })
  setStrategyStatus(strategy.id, 'backtesting')
  return { strategyId: strategy.id }
}
