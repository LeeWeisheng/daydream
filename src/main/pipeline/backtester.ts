/**
 * 自动回测（backtester）：调用确定性回测引擎，LLM 评估报告给出
 * 通过/不通过/需调整 结论；通过则生成 activate 工作项（需人工批准）。
 * 引擎为纯函数；此处直接调用（数据量受限时可迁移至 Worker，接口不变）。
 */
import { z } from 'zod'
import type { Strategy } from '@shared/types'
import { nowIso, queryAll, run, getDb } from '../db'
import { audit } from '../services/audit'
import { logger } from '../services/logger'
import { structuredOutput } from '../agent/llm'
import { BACKTEST_EVALUATOR_PROMPT, SYSTEM_IDENTITY } from '../agent/prompts'
import { createWorkItem } from '../agent/workitem'
import { agentEventBus } from '../agent/events'
import { parseAndValidateDsl } from '@shared/strategy/schema'
import { runBacktest, DEFAULT_BACKTEST_PARAMS } from '../backtest/engine'
import { getDailyKline, getIndexDaily } from '../data/service'
import { shanghaiDateStr, addDays } from '@shared/constants'

const evaluationSchema = z.object({
  verdict: z.enum(['pass', 'fail', 'adjust']),
  reason: z.string(),
  summary: z.string()
})

export async function runBacktestWorkItem(accountId: string, context: Record<string, unknown>): Promise<Record<string, unknown>> {
  const strategyId = String(context.strategyId ?? '')
  // 策略全局共享：查询不按账户过滤
  const strategyRow = queryAll<Strategy & Record<string, unknown>>('SELECT * FROM strategy WHERE id = ?', [strategyId])[0]
  if (!strategyRow) throw new Error(`策略不存在: ${strategyId}`)
  const strategy = { ...strategyRow, dsl_json: String(strategyRow.dsl_json ?? '') }
  if (!strategy.dsl_json.trim()) throw new Error('策略 Markdown 中无可执行的 ```dsl 代码块，无法回测')
  const { dsl, errors } = parseAndValidateDsl(strategy.dsl_json)
  if (!dsl || errors.length > 0) throw new Error(`策略 DSL 非法: ${errors.join('; ')}`)

  // 更新策略状态
  run('UPDATE strategy SET status = ?, updated_at = ? WHERE id = ?', ['backtesting', nowIso(), strategyId])

  // 回测区间：近 3 年（前 2 年样本内 + 最近 1 年样本外），与初建数据深度一致
  const end = shanghaiDateStr()
  const start = addDays(end, -Math.round(3 * 365))
  const sampleOutStart = addDays(end, -365)

  const klines = queryAll<Parameters<typeof runBacktest>[1][number]>(
    `SELECT code, date, open, high, low, close, volume, amount, adj_factor as adjFactor
     FROM kline_daily WHERE date >= ? AND date <= ?`,
    [start, end]
  )
  if (klines.length === 0) throw new Error('本地无 K 线数据，请先完成数据初始化')
  const stockNames = new Map(
    queryAll<{ code: string; name: string }>('SELECT code, name FROM stock_basic').map((r) => [r.code, r.name])
  )
  const benchmark = getIndexDaily('000300', start, end).map((b) => ({ date: b.date, close: b.close }))

  const params = { ...DEFAULT_BACKTEST_PARAMS, start, end }
  const result = runBacktest(dsl, klines, stockNames, benchmark, params)

  // 样本外分段：重跑最近 1 年
  let sampleMetrics = undefined
  if (sampleOutStart > start) {
    const outKlines = klines.filter((k) => k.date >= sampleOutStart)
    const outBench = benchmark.filter((b) => b.date >= sampleOutStart)
    if (outKlines.length > 30) {
      const outResult = runBacktest(dsl, outKlines, stockNames, outBench, { ...params, start: sampleOutStart })
      sampleMetrics = outResult.metrics
    }
  }

  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const metricsJson = JSON.stringify(result.metrics)
  const equityJson = JSON.stringify(result.equity)
  const reportJson = JSON.stringify({ inSample: result.metrics, outOfSample: sampleMetrics, params })
  run(
    `UPDATE strategy SET updated_at = ? WHERE id = ?`,
    [nowIso(), strategyId]
  )
  run('INSERT INTO backtest_run (id, strategy_version_id, params_json, status, metrics_json, equity_json, report_json, created_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [
    runId,
    String(context.strategyVersionId ?? ''),
    JSON.stringify(params),
    'succeeded',
    metricsJson,
    equityJson,
    reportJson,
    nowIso(),
    nowIso()
  ])
  // 成交明细落库
  const insertTrade = getDb()
    .prepare('INSERT INTO backtest_trade (run_id, code, side, price, qty, fee, traded_at, pnl, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
  const tx = getDb().transaction(() => {
    for (const t of result.trades) {
      insertTrade.run(runId, t.code, t.side, t.price, t.qty, t.fee, t.tradedAt, t.pnl ?? null, t.note ?? null)
    }
  })
  tx()

  // LLM 评估回测报告
  const evaluation = await structuredOutput(accountId, {
    system: `${SYSTEM_IDENTITY}\n\n${BACKTEST_EVALUATOR_PROMPT}`,
    prompt: JSON.stringify({ strategy: { name: strategy.name, dsl: dsl }, metrics: result.metrics, sampleMetrics }, null, 2),
    schema: evaluationSchema,
    purpose: `backtest_eval:${strategyId}`
  })
  run('UPDATE backtest_run SET report_json = ? WHERE id = ?', [JSON.stringify({ ...JSON.parse(reportJson), evaluation }), runId])
  audit({ accountId, actor: 'agent', action: 'backtest.evaluated', target: runId, detail: { strategyId, verdict: evaluation.verdict } })

  agentEventBus.emitAgentEvent('backtest.completed', accountId, { runId, strategyId, verdict: evaluation.verdict }, { debounceMs: 0 })

  if (evaluation.verdict === 'pass') {
    // 通过：进入待批准
    run('UPDATE strategy SET status = ?, updated_at = ? WHERE id = ?', ['pending_approval', nowIso(), strategyId])
    const activateItem = createWorkItem({
      accountId,
      type: 'activate',
      priority: 'high',
      context: { strategyId, runId, __busKey: `strategy:${strategyId}` }
    })
    return { runId, verdict: evaluation.verdict, activateWorkItemId: activateItem.id, summary: evaluation.summary }
  }
  if (evaluation.verdict === 'fail') {
    run('UPDATE strategy SET status = ?, updated_at = ? WHERE id = ?', ['draft', nowIso(), strategyId])
    return { runId, verdict: evaluation.verdict, summary: evaluation.summary }
  }
  // adjust：保持 draft，等待 Agent 调整（评估环节可再生成）
  run('UPDATE strategy SET status = ?, updated_at = ? WHERE id = ?', ['draft', nowIso(), strategyId])
  return { runId, verdict: evaluation.verdict, summary: evaluation.summary, note: '需调整，可重新生成策略' }
}

/** IPC/工具触发的回测任务入口（异步执行 + 状态流转） */
export async function startBacktestTask(accountId: string, strategyVersionId: string, start: string, end: string): Promise<string> {
  const version = queryAll<{ strategy_id: string }>('SELECT strategy_id FROM strategy_version WHERE id = ?', [strategyVersionId])[0]
  if (!version) throw new Error('策略版本不存在')
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  run('INSERT INTO backtest_run (id, strategy_version_id, params_json, status, created_at) VALUES (?, ?, ?, ?, ?)', [
    runId,
    strategyVersionId,
    JSON.stringify({ start, end }),
    'running',
    nowIso()
  ])
  // 异步执行
  ;(async () => {
    try {
      // 策略全局共享：查询不按账户过滤
      const strategyRow = queryAll<Strategy & Record<string, unknown>>('SELECT * FROM strategy WHERE id = ?', [version.strategy_id])[0]
      if (!strategyRow) throw new Error('策略不存在')
      const dslJson = String(strategyRow.dsl_json ?? '')
      if (!dslJson.trim()) throw new Error('策略 Markdown 中无可执行的 ```dsl 代码块，无法回测')
      const { dsl, errors } = parseAndValidateDsl(dslJson)
      if (!dsl) throw new Error(errors.join('; '))
      const klines = queryAll<Parameters<typeof runBacktest>[1][number]>(
        'SELECT code, date, open, high, low, close, volume, amount, adj_factor as adjFactor FROM kline_daily WHERE date >= ? AND date <= ?',
        [start, end]
      )
      const stockNames = new Map(queryAll<{ code: string; name: string }>('SELECT code, name FROM stock_basic').map((r) => [r.code, r.name]))
      const benchmark = getIndexDaily('000300', start, end).map((b) => ({ date: b.date, close: b.close }))
      const result = runBacktest(dsl, klines, stockNames, benchmark, { ...DEFAULT_BACKTEST_PARAMS, start, end })
      run('UPDATE backtest_run SET status = ?, metrics_json = ?, equity_json = ?, report_json = ?, finished_at = ? WHERE id = ?', [
        'succeeded',
        JSON.stringify(result.metrics),
        JSON.stringify(result.equity),
        JSON.stringify({ params: { start, end } }),
        nowIso(),
        runId
      ])
      agentEventBus.emitAgentEvent('backtest.completed', accountId, { runId, strategyId: version.strategy_id }, { debounceMs: 0 })
    } catch (e) {
      run('UPDATE backtest_run SET status = ?, error = ?, finished_at = ? WHERE id = ?', ['failed', (e as Error).message, nowIso(), runId])
    }
  })().catch((e) => logger.error(`[backtest] task ${runId} crashed: ${(e as Error).message}`))
  return runId
}
