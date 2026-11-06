/**
 * 自动规划（planner）：综合市场简报、策略与绩效摘要、待决策事项、上一轮纠正结论，
 * 产出结构化《阶段性行动计划》并转为生成策略工作项（docs《Agent 决策闭环设计》§7.1）。
 */
import { z } from 'zod'
import { newId, nowIso, queryAll, run as dbRun } from '../db/connection'
import { audit } from '../services/audit'
import { logger } from '../services/logger'
import { structuredOutput } from '../app/sessions'
import { PLANNER_PROMPT, SYSTEM_IDENTITY } from '../agent/prompts'
import { getMarketBrief } from '../market/service'
import { uiBus } from '../app/events'
import type { PipelineHost } from './index'

const planSchema = z.object({
  goal: z.string(),
  marketView: z.string(),
  directions: z.array(
    z.object({
      title: z.string(),
      description: z.string(),
      priority: z.enum(['high', 'medium', 'low'])
    })
  ),
  schedule: z.string()
})

export async function run(accountId: string, period: 'daily' | 'weekly', host?: PipelineHost): Promise<Record<string, unknown>> {
  // 规划的方向必须能转为工作项：缺少宿主时直接失败（失败即失败，不静默降级）
  if (!host) throw new Error('规划管线缺少 PipelineHost（无法入队生成策略工作项）')
  const brief = await getMarketBrief()
  const strategySummary = queryAll<{ status: string; c: number }>('SELECT status, COUNT(*) AS c FROM strategy WHERE account_id = ? GROUP BY status', [accountId])
  const recentSignals = queryAll<{ status: string; c: number }>("SELECT status, COUNT(*) AS c FROM signal WHERE account_id = ? AND created_at >= datetime('now', '-7 days') GROUP BY status", [accountId])
  const lastCorrection = queryAll<{ content_json: string; created_at: string }>(
    "SELECT content_json, created_at FROM review_report WHERE account_id = ? AND json_extract(content_json, '$.hasCorrection') = 1 ORDER BY created_at DESC LIMIT 1",
    [accountId]
  )[0]
  const prompt = JSON.stringify(
    {
      period,
      marketBrief: brief,
      strategySummary,
      recentSignals,
      lastCorrection: lastCorrection ? JSON.parse(lastCorrection.content_json) : null
    },
    null,
    2
  )
  const plan = await structuredOutput(accountId, {
    system: `${SYSTEM_IDENTITY}\n\n${PLANNER_PROMPT}`,
    prompt,
    schema: planSchema,
    purpose: `plan:${period}`
  })
  const id = newId()
  dbRun('INSERT INTO plan (id, account_id, period, content_json, status, created_at) VALUES (?, ?, ?, ?, ?, ?)', [
    id,
    accountId,
    period,
    JSON.stringify(plan),
    'active',
    nowIso()
  ])
  audit({ accountId, actor: 'agent', action: 'plan.created', target: id, detail: { period, goal: plan.goal } })

  // 计划中的策略方向 → 生成策略工作项（每个方向一个）
  const created: string[] = []
  for (const direction of plan.directions) {
    const item = host.enqueueTicket({
      accountId,
      type: 'generate_strategy',
      priority: direction.priority,
      context: { direction: direction.title, description: direction.description, planId: id }
    })
    created.push(item.id)
  }
  uiBus.broadcast('agent.status', { accountId, planId: id })
  logger.info(`[pipeline] plan ${period} created: ${plan.goal}, ${created.length} strategy workitems`)
  return { planId: id, goal: plan.goal, directions: plan.directions.length }
}
