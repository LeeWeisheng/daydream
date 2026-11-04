/**
 * 自动纠正（corrector）：依据复盘结论执行纠正动作。
 * 谱系（按强度递增）：参数微调 → 结构调整 → 暂停运行 → 停用淘汰。
 * 微调/结构调整：生成新版本 DSL 并自动回测验证，通过后替换（留档可回滚）；
 * 暂停/淘汰或涉及运行中策略：走 need_decision 人工确认。
 */
import { z } from 'zod'
import { nowIso, queryAll, run as dbRun } from '../db'
import { audit } from '../services/audit'
import { logger } from '../services/logger'
import { structuredOutput } from '../agent/llm'
import { CORRECTOR_PROMPT, SYSTEM_IDENTITY } from '../agent/prompts'
import { agentEventBus } from '../agent/events'
import { createWorkItem } from '../agent/workitem'
import { parseAndValidateDsl, validateStrategyDsl, upsertDslBlockInMarkdown } from '@shared/strategy/schema'
import { runBacktest, DEFAULT_BACKTEST_PARAMS } from '../backtest/engine'
import { shanghaiDateStr, addDays } from '@shared/constants'

const correctionSchema = z.object({
  action: z.enum(['tweak', 'restructure', 'pause', 'retire']),
  reasoning: z.string(),
  evidence: z.string(),
  newDsl: z.unknown().optional()
})

export async function run(accountId: string, context: Record<string, unknown>): Promise<Record<string, unknown>> {
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

  const account = queryAll<{ autonomy_level: string }>('SELECT autonomy_level FROM account WHERE id = ?', [accountId])[0]
  const autonomy = (account?.autonomy_level ?? 'conservative') as 'conservative' | 'standard' | 'aggressive'

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
        const benchmark = queryAll<{ date: string; close: number }>(
          "SELECT date, close FROM index_daily WHERE index_code = '000300' AND date >= ? AND date <= ?",
          [start, end]
        )
        if (klines.length === 0) throw new Error('无回测数据，无法验证纠正方案')
        const dsl = parseAndValidateDsl(newDslJson).dsl!
        const result = runBacktest(dsl, klines, stockNames, benchmark, { ...DEFAULT_BACKTEST_PARAMS, start, end })
        const improved = result.metrics.totalReturn > -0.3 // 基础门槛：未灾难性亏损
        if (!improved) {
          // 验证不通过：保持原策略，报告原因
          const reason = `纠正后回测不达标（总收益 ${(result.metrics.totalReturn * 100).toFixed(1)}%），保持原策略`
          dbRun("INSERT INTO report (id, account_id, level, title, summary, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [
            `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            accountId,
            'result',
            `纠正验证未通过：${strategy.name}`,
            reason,
            'closed',
            nowIso(),
            nowIso()
          ])
          return { strategyId, applied: false, reason }
        }
        // 新版本留档并替换（dsl_json 与 markdown 的 ```dsl 块同步更新，保留手写内容）
        const current = queryAll<{ version: number }>('SELECT version FROM strategy WHERE id = ?', [strategyId])[0]
        const next = (current?.version ?? 0) + 1
        const newMarkdown = upsertDslBlockInMarkdown(strategy.markdown, dsl)
        dbRun('UPDATE strategy SET dsl_json = ?, markdown = ?, version = ?, updated_at = ? WHERE id = ?', [newDslJson, newMarkdown, next, nowIso(), strategyId])
        dbRun('INSERT INTO strategy_version (id, strategy_id, version, dsl_json, markdown, change_log, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
          `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          strategyId,
          next,
          newDslJson,
          newMarkdown,
          `纠正（${correction.action}）: ${correction.reasoning}`,
          nowIso()
        ])
        audit({ accountId, actor: 'agent', action: 'correction.applied', target: strategyId, detail: { action: correction.action, version: next } })
        agentEventBus.emitAgentEvent('strategy.updated', accountId, { strategyId, version: next }, { debounceMs: 0 })
        return { strategyId, applied: true, version: next, action: correction.action }
      }
      // 无 newDsl：转为生成策略工作项（结构调整路径）
      createWorkItem({
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
        dbRun("UPDATE strategy SET status = 'paused', updated_at = ? WHERE id = ?", [nowIso(), strategyId])
        audit({ accountId, actor: 'agent', action: 'correction.paused', target: strategyId })
        return { strategyId, applied: true, action: 'pause' }
      }
      return requestApproval(accountId, strategyId, correction, 'pause')
    }
    case 'retire': {
      // 淘汰：保守/标准需人工确认；激进自动
      if (autonomy === 'aggressive') {
        dbRun("UPDATE strategy SET status = 'deactivated', updated_at = ? WHERE id = ?", [nowIso(), strategyId])
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
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const now = nowIso()
  const strategy = queryAll<{ name: string }>('SELECT name FROM strategy WHERE id = ?', [strategyId])[0]
  dbRun('INSERT INTO report (id, account_id, level, title, summary, decision_json, status, work_item_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [
    id,
    accountId,
    'need_decision',
    `纠正方案待确认：${action === 'pause' ? '暂停' : '淘汰'}「${strategy?.name ?? strategyId}」`,
    `${correction.reasoning}\n证据：${correction.evidence}`,
    JSON.stringify({ kind: `correct_${action}`, strategyId, options: ['批准', '驳回', '暂缓'] }),
    'pending',
    null,
    now,
    now
  ])
  agentEventBus.emitAgentEvent('agent.report', accountId, { reportId: id, level: 'need_decision', title: `纠正方案待确认` }, { debounceMs: 0 })
  logger.info(`[pipeline] correction ${action} approval requested for ${strategyId}`)
  return { strategyId, applied: false, pendingApproval: id }
}

/** 纠正完成事件：开启新一轮规划 */
export function emitCorrectionCompleted(accountId: string): void {
  agentEventBus.emitAgentEvent('correction.completed', accountId, {}, { debounceMs: 0 })
}
