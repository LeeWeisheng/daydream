/**
 * 策略评估（backtester）：策略为纯文本文档，无法确定性回测；
 * 本环节由 LLM 做定性评估（逻辑自洽性、可执行性、与用户偏好一致性、当前市场适用性），
 * 结论留档并推送；策略无审核流，评估结论仅供 Agent 迭代参考。
 */
import { z } from 'zod'
import { newId, nowIso, run, inTransaction } from '../db/connection'
import { audit } from '../services/audit'
import { logger } from '../services/logger'
import { structuredOutput } from '../app/sessions'
import { BACKTEST_EVALUATOR_PROMPT } from '../agent/prompts'
import { uiBus } from '../app/events'
import { getMarketBrief } from '../market/service'
import { computeAccountStats, getStrategyById, listVersions } from '../strategy/service'

const evaluationSchema = z.object({
  verdict: z.enum(['pass', 'fail', 'adjust']),
  reason: z.string(),
  summary: z.string()
})

export async function runBacktestWorkItem(accountId: string, context: Record<string, unknown>): Promise<Record<string, unknown>> {
  const strategyId = String(context.strategyId ?? '')
  const strategy = getStrategyById(strategyId)
  if (!strategy) throw new Error(`策略不存在: ${strategyId}`)
  // 评估对象：指定版本，缺省为最新版本
  const versionId = String(context.strategyVersionId ?? '')
  const versions = listVersions(strategyId)
  const version = versionId ? versions.find((v) => v.id === versionId) : versions[0]
  if (!version) throw new Error(`策略版本不存在: ${versionId}`)

  const marketBrief = await getMarketBrief()
  const stats = computeAccountStats(accountId)
  const evaluation = await structuredOutput(accountId, {
    system: BACKTEST_EVALUATOR_PROMPT,
    prompt: JSON.stringify(
      {
        strategy: { title: version.title || strategy.title, version: version.version, markdown: version.markdown },
        accountStats: stats,
        marketBrief,
        note: '策略为纯文本，无法确定性回测；请做定性评估。'
      },
      null,
      2
    ),
    schema: evaluationSchema,
    purpose: `strategy_eval:${strategyId}`,
    useProModel: true
  })

  const runId = newId()
  inTransaction(() => {
    run('UPDATE strategy SET updated_at = ? WHERE id = ?', [nowIso(), strategyId])
    run(
      'INSERT INTO backtest_run (id, strategy_version_id, params_json, status, metrics_json, equity_json, report_json, created_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [runId, version.id, '{}', 'succeeded', null, null, JSON.stringify({ evaluation, kind: 'qualitative' }), nowIso(), nowIso()]
    )
  })
  audit({ accountId, actor: 'agent', action: 'strategy.evaluated', target: runId, detail: { strategyId, version: version.version, verdict: evaluation.verdict } })
  uiBus.broadcast('backtest.completed', { accountId, runId, strategyId, verdict: evaluation.verdict })

  if (evaluation.verdict === 'pass') {
    return { runId, verdict: evaluation.verdict, summary: evaluation.summary }
  }
  // fail/adjust：评估不通过，仅提示 Agent 迭代（策略已生效，无审核流）
  logger.info(`[backtest] strategy ${strategyId} eval: ${evaluation.verdict} — ${evaluation.reason}`)
  return { runId, verdict: evaluation.verdict, summary: evaluation.summary, note: evaluation.verdict === 'adjust' ? '需调整，可重新生成策略' : undefined }
}
