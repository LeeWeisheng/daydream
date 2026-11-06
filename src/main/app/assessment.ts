/**
 * MasterAssessor：评估器（dsh src/app/assessment.ts 的对应）。
 * 职责：
 * - request(evalId)：入队评估副作用（持久化，重启后可重试）；
 * - assess(evalId)：组装候选上下文 → LLM 研判 → 转换为决策（accept/ignore）提交 Engine；
 * - 失败时按 Policy.fallbackFor 降级（推迟重试 / 直接接单 / 不行动），降级决策同样留档；
 * - 候选送达（candidateDelivered）后 deadline 才起算（超时由 Evals 部分重排）。
 */
import { z } from 'zod'
import type { Engine } from '../core/engine'
import type { Policy } from '../core/ports'
import { effects } from './effects'
import { structuredOutput } from './sessions'
import { buildContextSummary } from './context'
import { EVALUATION_PROMPT } from '../agent/prompts'
import { audit } from '../services/audit'
import { logger } from '../services/logger'

/** 评估输出 Schema（docs《Agent 决策闭环设计》§3.1） */
const evaluationSchema = z.object({
  needsAction: z.boolean(),
  reason: z.string(),
  suggestedActions: z
    .array(
      z.object({
        kind: z.enum(['create_workitem']),
        workitemType: z.string(),
        refStrategyId: z.string().optional(),
        note: z.string().optional()
      })
    )
    .optional(),
  needsUserAttention: z.boolean().optional()
})
type Evaluation = z.infer<typeof evaluationSchema>

export interface MasterAssessorDeps {
  engine: Engine
  policy: () => Policy
  /** 事件类型 → 工作项类型的转换由评估 prompt 完成；这里只透传 */
}

export class MasterAssessor {
  constructor(private readonly deps: MasterAssessorDeps) {}

  /** 请求评估一个 Eval（入队持久化副作用） */
  request(evalId: string): void {
    effects.enqueue('assessment', evalId, { evalId })
    void effects.processAll()
  }

  /** 释放 Eval 的缓存状态（Engine 决策后无状态，无需清理） */
  release(_evalId: string): void {
    /* 无缓存状态 */
  }

  /** 执行一次评估（effect 处理器调用） */
  async assess(evalId: string): Promise<void> {
    const engine = this.deps.engine
    const evalItem = engine.candidate(evalId)
    if (!evalItem) return
    engine.candidateDelivered(evalId)
    const accountId = evalItem.threadKey.replace(/^account:/, '')

    const context = buildContextSummary(accountId)
    const input = {
      event: evalItem.triggers.map((t) => ({ type: t.type, payload: t.payload })),
      context
    }
    const policy = this.deps.policy()
    let evaluation: Evaluation
    try {
      evaluation = await structuredOutput(accountId, {
        system: EVALUATION_PROMPT,
        prompt: JSON.stringify(input, null, 2),
        schema: evaluationSchema,
        purpose: `evaluate:${evalItem.triggers.map((t) => t.type).join(',')}`
      })
    } catch (e) {
      const err = e as Error
      logger.warn(`[assess] evaluation failed for eval ${evalId}: ${err.message}`)
      // 评估失败：按事件类型的默认策略降级（docs §3.3）
      const fallback = policy.fallbackFor(evalItem.triggers[0]?.type ?? '')
      if (fallback === 'direct_accept') {
        // 用户消息：直接接单（不重试，用户体验优先）
        engine.decide(
          evalId,
          'accept',
          { code: 'assessment_failed', values: { fallback } },
          [{ kind: 'create_workitem', workitemType: 'user_request' }],
          input,
          { fallback }
        )
        return
      }
      if (fallback === 'retry_later') {
        // 推迟重试：重新入队评估副作用（低频率；由 effect 退避控制）
        audit({ accountId, actor: 'agent', action: 'evaluate_fallback', detail: { reason: err.message, fallback } })
        throw err
      }
      // no_action：记录 ignore 决策并结束
      engine.decide(evalId, 'ignore', { code: 'assessment_failed', values: { fallback } }, [], input, { fallback })
      audit({ accountId, actor: 'agent', action: 'evaluate_fallback', detail: { reason: err.message, fallback } })
      return
    }
    // 决策留档由 Engine 唯一写入（one writer per state）；此处只审计降级路径
    if (!evaluation.needsAction) {
      logger.debug(`[assess] no action needed for eval ${evalId}`)
      engine.decide(evalId, 'ignore', { code: 'assessment_ignored' }, [], input, evaluation)
      return
    }
    if (!evaluation.suggestedActions || evaluation.suggestedActions.length === 0) {
      // needsAction 但无具体动作：按 ignore 记录（不静默断链），审计留痕
      audit({ accountId, actor: 'agent', action: 'evaluate_no_actions', detail: { evalId, reason: evaluation.reason } })
      engine.decide(evalId, 'ignore', { code: 'assessment_ignored', values: { reason: 'no actions' } }, [], input, evaluation)
      return
    }
    // 决策：评估建议 → 工作项（Engine.accept 创建）
    engine.decide(evalId, 'accept', { code: 'assessment_accepted' }, evaluation.suggestedActions, input, evaluation)
  }
}
