/**
 * 自动纠正（corrector）：依据复盘结论执行纠正。
 * - update：输出更新后的完整策略 Markdown 文档，新版本留档立即生效（无审核流）；
 * - suggest：仅给出建议，不更新文档。
 * 纠正完成 → correction.completed 触发（开启新一轮规划）。
 */
import { z } from 'zod'
import { audit } from '../services/audit'
import { logger } from '../services/logger'
import { structuredOutput } from '../app/sessions'
import { CORRECTOR_PROMPT } from '../agent/prompts'
import { uiBus } from '../app/events'
import { publishReport } from '../reports/service'
import { getStrategyById, latestVersionId, saveStrategyMarkdown } from '../strategy/service'
import type { PipelineHost } from './index'

const correctionSchema = z
  .object({
    action: z.enum(['update', 'suggest']),
    reasoning: z.string(),
    evidence: z.string(),
    newMarkdown: z.string().optional(),
    title: z.string().max(40).optional(),
    changeLog: z.string().max(120).optional()
  })
  .superRefine((v, ctx) => {
    // update 动作必须携带新文档、标题与一句话变更记录（与 update_strategy 工具口径一致）
    if (v.action === 'update') {
      if (!v.newMarkdown?.trim()) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'update 动作必须提供 newMarkdown（完整策略文档）' })
      if (!v.title?.trim()) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'update 动作必须提供 title（简短标题）' })
      if (!v.changeLog?.trim()) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'update 动作必须提供 changeLog（一句话变更记录）' })
    }
  })

export async function run(accountId: string, context: Record<string, unknown>, host?: PipelineHost): Promise<Record<string, unknown>> {
  const strategyId = String(context.strategyId ?? '')
  const strategy = getStrategyById(strategyId)
  if (!strategy) throw new Error(`策略不存在: ${strategyId}`)

  const prompt = JSON.stringify(
    {
      strategy: { id: strategy.id, title: strategy.title, version: strategy.version, markdown: strategy.markdown },
      suggestion: context.suggestion ?? '',
      evidence: context.evidence ?? ''
    },
    null,
    2
  )
  const correction = await structuredOutput(accountId, {
    system: CORRECTOR_PROMPT,
    prompt,
    schema: correctionSchema,
    purpose: `correct:${strategyId}`,
    useProModel: true
  })
  audit({ accountId, actor: 'agent', action: 'correction.decided', target: strategyId, detail: { action: correction.action, evidence: correction.evidence } })

  if (correction.action === 'update') {
    if (!correction.newMarkdown?.trim()) {
      // 无新文档：转为生成策略工作项（重新生成路径）
      host?.enqueueTicket({
        accountId,
        type: 'generate_strategy',
        priority: 'medium',
        context: { direction: `纠正：${correction.reasoning}`, description: context.suggestion ?? '', __busKey: `strategy:${strategyId}` }
      })
      return { strategyId, applied: false, note: '已转为策略重新生成' }
    }
    // 新版本留档并立即生效（无审核流；Schema 已保证 update 时三字段必填）
    const saved = saveStrategyMarkdown({
      accountId,
      title: correction.title!.trim(),
      markdown: correction.newMarkdown!,
      changeLog: correction.changeLog!.trim(),
      createdBy: 'agent'
    })
    audit({ accountId, actor: 'agent', action: 'correction.applied', target: strategyId, detail: { version: saved.version, reasoning: correction.reasoning } })
    uiBus.broadcast('strategy.updated', { accountId, strategyId, version: saved.version })
    host?.enqueueTicket({
      accountId,
      type: 'backtest',
      priority: 'medium',
      context: { strategyId, strategyVersionId: latestVersionId(strategyId) ?? '', __busKey: `strategy:${strategyId}` }
    })
    return { strategyId, applied: true, version: saved.version, action: correction.action }
  }

  // suggest：仅建议，向用户汇报
  publishReport({
    accountId,
    level: 'result',
    title: `策略建议：${strategy.title}`,
    summary: `${correction.reasoning}\n证据：${correction.evidence}`
  })
  logger.info(`[pipeline] correction suggest for ${strategyId}: ${correction.reasoning}`)
  return { strategyId, applied: false, action: 'suggest' }
}
