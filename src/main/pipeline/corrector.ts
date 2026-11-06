/**
 * 自动纠正（corrector）：依据复盘结论执行纠正动作。
 * 谱系（按强度递增）：参数微调 → 结构调整 → 暂停运行 → 停用淘汰。
 * 微调/结构调整：生成新版本 DSL 并自动回测验证，通过后替换（留档可回滚）；
 * 暂停/淘汰或涉及运行中策略：走 need_decision 人工确认；
 * 纠正完成 → correction.completed 触发（开启新一轮规划）。
 */
import { z } from 'zod'
import { nowIso, queryAll, run as dbRun } from '../db/connection'
import { audit } from '../services/audit'
import { logger } from '../services/logger'
import { structuredOutput } from '../app/sessions'
import { CORRECTOR_PROMPT, SYSTEM_IDENTITY } from '../agent/prompts'
import { uiBus } from '../app/events'
import { publishReport } from '../reports/service'
import { getAutonomyLevel } from '../settings/service'
import { parseAndValidateDsl, validateStrategyDsl, upsertDslBlockInMarkdown } from '@shared/strategy/schema'
import { runBacktest, DEFAULT_BACKTEST_PARAMS } from '../quant/backtest/engine'
import { getStrategyById, setStrategyStatus, latestVersionId, replaceDslWithVersion } from '../strategy/service'
import { shanghaiDateStr, addDays } from '@shared/constants'
import type { PipelineHost } from './index'

const correctionSchema = z.object({
  action: z.enum(['tweak', 'restructure', 'pause', 'retire']),
  reasoning: z.string(),
  evidence: z.string(),
  newDsl: z.unknown().optional()
})

export async function run(accountId: string, context: Record<string, unknown>, host?: PipelineHost): Promise<Record<string, unknown>> {
  const strategyId = String(context.strategyId ?? '')
  const strategy = queryAll<{ id: string; name: string; dsl_json: string; markdown: string; status: string }>(
    'SELECT id, name, dsl_json, markdown, status FROM strategy WHERE id = ?',
    [strategyId]
  )[0]
  if (!strategy) throw new Error(`策略不存在: ${strategyId}`)

  const prompt = JSON.stringify(
    {
      strategy: { id: strategy.id, name: strategy.name, status: strategy.status, markdown: strategy.markdown, dsl: safeParseDsl(strategy.dsl_json) },
      suggestion: context.suggestion ?? '',
      evidence: context.evidence ?? ''
    },
    null,
    2
  )
  const correction = await structuredOutput(accountId, {
    system: `${SYSTEM_IDENTITY}\n\n${CORRECTOR_PROMPT}`,
    prompt,
    schema: correctionSchema,
    purpose: `correct:${strategyId}`,
    useProModel: true
  })
  audit({ accountId, actor: 'agent', action: 'correction.decided', target: strategyId, detail: { action: correction.action, evidence: correction.evidence } })

  const autonomy = getAutonomyLevel(accountId)

  switch (correction.action) {
    case 'tweak':
    case 'restructure': {
      // 生成新版本 DSL（若 LLM 未提供 newDsl，则由 generate_strategy 工作项补做）
      if (correction.newDsl) {
        const validation = validateStrategyDsl(correction.newDsl)
        if (!validation.ok) throw new Error(`纠正后 DSL 校验失败: ${validation.errors.join('; ')}`)
        const newDslJson = JSON.stringify(correction.newDsl)
        // 回测验证
        const end = shanghaiDateStr()
        const start = addDays(end, -365)
        const klines = queryAll<Parameters<typeof runBacktest>[1][number]>(
          'SELECT code, date, open, high, low, close, volume, amount, adj_factor as adjFactor FROM kline_daily WHERE date >= ? AND date <= ?',
          [start, end]
        )
        const stockNames = new Map(queryAll<{ code: string; name: string }>('SELECT code, name FROM stock_basic').map((r) => [r.code, r.name]))
        const benchmark = queryAll<{ date: string; close: number }>("SELECT date, close FROM index_daily WHERE index_code = '000300' AND date >= ? AND date <= ?", [start, end])
        if (klines.length === 0) throw new Error('无回测数据，无法验证纠正方案')
        const dsl = parseAndValidateDsl(newDslJson).dsl!
        const result = runBacktest(dsl, klines, stockNames, benchmark, { ...DEFAULT_BACKTEST_PARAMS, start, end })
        const improved = result.metrics.totalReturn > -0.3 // 基础门槛：未灾难性亏损
        if (!improved) {
          // 验证不通过：保持原策略，报告原因
          const reason = `纠正后回测不达标（总收益 ${(result.metrics.totalReturn * 100).toFixed(1)}%），保持原策略`
          publishReport({ accountId, level: 'result', title: `纠正验证未通过：${strategy.name}`, summary: reason })
          return { strategyId, applied: false, reason }
        }
        // 新版本留档并替换（dsl_json 与 markdown 的 ```dsl 块同步更新，保留手写内容；经策略服务唯一写者）
        const newMarkdown = upsertDslBlockInMarkdown(strategy.markdown, dsl)
        const { version: next } = replaceDslWithVersion(strategyId, newDslJson, newMarkdown, `纠正（${correction.action}）: ${correction.reasoning}`)
        audit({ accountId, actor: 'agent', action: 'correction.applied', target: strategyId, detail: { action: correction.action, version: next } })
        uiBus.broadcast('strategy.updated', { accountId, strategyId, version: next })
        host?.enqueueTicket({
          accountId,
          type: 'backtest',
          priority: 'medium',
          context: { strategyId, strategyVersionId: latestVersionId(strategyId) ?? '', __busKey: `strategy:${strategyId}` }
        })
        return { strategyId, applied: true, version: next, action: correction.action }
      }
      // 无 newDsl：转为生成策略工作项（结构调整路径）
      host?.enqueueTicket({
        accountId,
        type: 'generate_strategy',
        priority: 'medium',
        context: { direction: `纠正：${correction.reasoning}`, description: context.suggestion ?? '', __busKey: `strategy:${strategyId}` }
      })
      return { strategyId, applied: false, note: '已转为策略重新生成' }
    }
    case 'pause': {
      // 暂停运行：激进模式自动执行；其余走人工确认
      if (autonomy === 'aggressive') {
        setStrategyStatus(strategyId, 'paused')
        audit({ accountId, actor: 'agent', action: 'correction.paused', target: strategyId })
        return { strategyId, applied: true, action: 'pause' }
      }
      return requestApproval(accountId, strategyId, correction, 'pause')
    }
    case 'retire': {
      // 淘汰：保守/标准需人工确认；激进自动
      if (autonomy === 'aggressive') {
        setStrategyStatus(strategyId, 'deactivated')
        dbRun("UPDATE run_instance SET status = 'stopped', stopped_at = ? WHERE strategy_id = ? AND status = 'active'", [nowIso(), strategyId])
        audit({ accountId, actor: 'agent', action: 'correction.retired', target: strategyId })
        return { strategyId, applied: true, action: 'retire' }
      }
      return requestApproval(accountId, strategyId, correction, 'retire')
    }
  }
}

function safeParseDsl(dslJson: string): unknown {
  try {
    return JSON.parse(dslJson)
  } catch {
    return null
  }
}

function requestApproval(
  accountId: string,
  strategyId: string,
  correction: { action: string; reasoning: string; evidence: string },
  action: string
): Record<string, unknown> {
  const strategy = getStrategyById(strategyId)
  const result = publishReport({
    accountId,
    level: 'need_decision',
    title: `纠正方案待确认：${action === 'pause' ? '暂停' : '淘汰'}「${strategy?.name ?? strategyId}」`,
    summary: `${correction.reasoning}\n证据：${correction.evidence}`,
    decisionJson: JSON.stringify({ kind: `correct_${action}`, strategyId, options: ['批准', '驳回', '暂缓'] })
  })
  logger.info(`[pipeline] correction ${action} approval requested for ${strategyId}`)
  return { strategyId, applied: false, pendingApproval: result.reportId }
}
