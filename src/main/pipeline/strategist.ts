/**
 * 自动生成策略（strategist）：依据规划方向与市场数据生成策略 DSL。
 * DSL 必须通过 Schema 校验（白名单指标）；新策略存 draft 并自动创建回测工作项。
 */
import { z } from 'zod'
import { nowIso, queryAll, run } from '../db'
import { audit } from '../services/audit'
import { logger } from '../services/logger'
import { structuredOutput } from '../agent/llm'
import { STRATEGIST_PROMPT, SYSTEM_IDENTITY } from '../agent/prompts'
import { createWorkItem } from '../agent/workitem'
import { createStrategyDirect } from '../agent/tools'
import { parseAndValidateDsl, validateStrategyDsl } from '@shared/strategy/schema'

// DSL 生成约束：LLM 输出整体 DSL 对象，再经白名单 Schema 校验
const dslGenSchema = z.object({
  meta: z.object({
    name: z.string().min(1).max(64),
    description: z.string().default(''),
    rationale: z.string().default(''),
    complexity: z.number().int().min(1).max(10).default(1)
  }),
  universe: z
    .object({
      source: z.enum(['all_a']).default('all_a'),
      filters: z.array(z.unknown()).default([])
    })
    .default({ source: 'all_a', filters: [] }),
  entry: z.object({ logic: z.enum(['and', 'or']).default('and'), conditions: z.array(z.unknown()).min(1) }),
  exit: z.object({ logic: z.enum(['and', 'or']).default('or'), conditions: z.array(z.unknown()).min(1) }),
  portfolio: z.object({
    max_positions: z.number().int().min(1).max(50),
    position_size: z.enum(['equal_weight', 'equal_cash']).default('equal_weight'),
    max_position_pct: z.number().min(0.01).max(1),
    rebalance: z.enum(['daily', 'weekly']).default('daily')
  })
})

export async function runFromPlan(accountId: string, context: Record<string, unknown>): Promise<Record<string, unknown>> {
  const direction = String(context.direction ?? '未命名方向')
  const description = String(context.description ?? '')
  const existingStrategies = queryAll<{ name: string; status: string }>(
    'SELECT name, status FROM strategy WHERE account_id = ? ORDER BY created_at DESC LIMIT 30',
    [accountId]
  )
  const prompt = JSON.stringify(
    {
      direction,
      description,
      existingStrategies,
      note: '输出完整策略 DSL 对象（符合给定 schema）。universe.filters 支持 op: exclude_st / exclude_stop / liquidity_min；entry/exit.conditions 为 indicator+params 对象数组。'
    },
    null,
    2
  )
  const generated = await structuredOutput(accountId, {
    system: `${SYSTEM_IDENTITY}\n\n${STRATEGIST_PROMPT}`,
    prompt,
    schema: dslGenSchema,
    purpose: `generate_strategy:${direction}`,
    useProModel: true
  })

  // 全量 Schema 校验（白名单指标/参数/复杂度），未通过则不落库（失败即失败）
  const dslJson = JSON.stringify(generated, null, 2)
  const validation = validateStrategyDsl(generated)
  if (!validation.ok) {
    throw new Error(`生成的策略 DSL 校验失败: ${validation.errors.join('; ')}`)
  }
  const strategy = createStrategyDirect(accountId, generated.meta.name, dslJson, String(generated.meta.rationale ?? ''), 'agent')
  audit({ accountId, actor: 'agent', action: 'strategy.generated', target: strategy.id, detail: { direction } })

  // 自动创建回测工作项
  const btItem = createWorkItem({
    accountId,
    type: 'backtest',
    priority: 'medium',
    context: { strategyId: strategy.id, strategyVersionId: latestVersionId(strategy.id) ?? '', __busKey: `strategy:${strategy.id}` }
  })
  logger.info(`[pipeline] strategy generated: ${strategy.name} (${strategy.id}), backtest workitem ${btItem.id}`)
  return { strategyId: strategy.id, name: strategy.name, backtestWorkItemId: btItem.id }
}

function latestVersionId(strategyId: string): string | undefined {
  const row = queryAll<{ id: string }>('SELECT id FROM strategy_version WHERE strategy_id = ? ORDER BY version DESC LIMIT 1', [strategyId])[0]
  return row?.id
}

/** 供 UI/用户请求复用的入口（不依赖 LLM 时由调用方提供 DSL） */
export function createFromDsl(accountId: string, name: string, dslJson: string, rationale: string): Record<string, unknown> {
  const { errors } = parseAndValidateDsl(dslJson)
  if (errors.length > 0) throw new Error(`DSL 校验失败: ${errors.join('; ')}`)
  const strategy = createStrategyDirect(accountId, name, dslJson, rationale, 'user')
  run('UPDATE strategy SET status = ? WHERE id = ?', ['backtesting', strategy.id])
  return { strategyId: strategy.id }
}
