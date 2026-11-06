/**
 * 自动复盘（reviewer）：日复盘（轻量）+ 周复盘（深度）。
 * 内容：信号与执行情况、策略表现 vs 基准、市场判断回顾、问题归因；
 * 产出复盘报告（review_report）并以 summary 级汇报；显著问题入队 correct 工作项。
 */
import { z } from 'zod'
import { newId, nowIso, queryAll, run as dbRun } from '../db/connection'
import { audit } from '../services/audit'
import { logger } from '../services/logger'
import { structuredOutput } from '../app/sessions'
import { REVIEWER_PROMPT, SYSTEM_IDENTITY } from '../agent/prompts'
import { publishReport } from '../reports/service'
import { computeSignalDeviation, computeTradeStats } from '../quant/perf'
import type { TradeRecord } from '@shared/types'
import type { PipelineHost } from './index'

const reviewSchema = z.object({
  summary: z.string(),
  marketReview: z.string(),
  strategyPerformance: z.array(
    z.object({
      strategyId: z.string().optional(),
      name: z.string(),
      verdict: z.enum(['good', 'neutral', 'poor']),
      note: z.string()
    })
  ),
  problemAttribution: z.array(
    z.object({
      kind: z.enum(['strategy_decay', 'parameter_drift', 'market_regime', 'execution_deviation', 'other']),
      description: z.string(),
      severity: z.enum(['low', 'medium', 'high'])
    })
  ),
  corrections: z.array(
    z.object({
      strategyId: z.string().optional(),
      suggestion: z.string(),
      action: z.enum(['tweak', 'restructure', 'pause', 'retire']),
      evidence: z.string()
    })
  ),
  hasCorrection: z.boolean()
})

export async function run(accountId: string, period: 'daily' | 'weekly', host?: PipelineHost): Promise<Record<string, unknown>> {
  const since = period === 'daily' ? "datetime('now', '-1 day')" : "datetime('now', '-7 days')"
  const signals = queryAll<{ status: string }>(`SELECT status FROM signal WHERE account_id = ? AND created_at >= ${since}`, [accountId])
  const trades = queryAll<TradeRecord & Record<string, unknown>>(
    `SELECT id, account_id as accountId, code, side, price, qty, fee, traded_at as tradedAt, signal_id as signalId, note
     FROM trade_record WHERE account_id = ? AND traded_at >= ${since}`,
    [accountId]
  )
  const strategies = queryAll<{ id: string; name: string; status: string }>('SELECT id, name, status FROM strategy WHERE account_id = ?', [accountId])
  const deviation = computeSignalDeviation(signals)
  const tradeStats = computeTradeStats(trades as TradeRecord[])
  // 基准（沪深300）区间涨跌
  const bench = queryAll<{ close: number }>(`SELECT close FROM index_daily WHERE index_code = '000300' ORDER BY date DESC LIMIT ${period === 'daily' ? 2 : 5}`, [])
  const benchReturn = bench.length >= 2 ? bench[0].close / bench[bench.length - 1].close - 1 : 0

  const prompt = JSON.stringify(
    {
      period,
      signalDeviation: deviation,
      tradeStats: { tradeCount: tradeStats.tradeCount, winRate: tradeStats.winRate, totalPnl: tradeStats.totalPnl },
      benchmarkReturn: benchReturn,
      strategies,
      guidance: '基于真实统计复盘；不编造数据；corrections 仅在有证据时给出。'
    },
    null,
    2
  )
  const report = await structuredOutput(accountId, {
    system: `${SYSTEM_IDENTITY}\n\n${REVIEWER_PROMPT}`,
    prompt,
    schema: reviewSchema,
    purpose: `review:${period}`,
    useProModel: true
  })
  const id = newId()
  dbRun('INSERT INTO review_report (id, account_id, period, content_json, metrics_json, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
    id,
    accountId,
    period,
    JSON.stringify(report),
    JSON.stringify({ deviation, tradeStats: { tradeCount: tradeStats.tradeCount, winRate: tradeStats.winRate }, benchReturn }),
    'agent',
    nowIso()
  ])
  audit({ accountId, actor: 'agent', action: 'review.created', target: id, detail: { period } })

  // 显著问题 → correct 工作项
  let corrections = 0
  for (const correction of report.corrections) {
    if (correction.strategyId) {
      host?.enqueueTicket({
        accountId,
        type: 'correct',
        priority: correction.action === 'retire' || correction.action === 'pause' ? 'high' : 'medium',
        context: {
          strategyId: correction.strategyId,
          suggestion: correction.suggestion,
          action: correction.action,
          evidence: correction.evidence,
          __busKey: `strategy:${correction.strategyId}`
        }
      })
      corrections += 1
    }
  }

  // summary 级汇报（盘后统一推送，进入对话流）
  publishReport({
    accountId,
    level: 'summary',
    title: `${period === 'daily' ? '日' : '周'}复盘：${report.summary.slice(0, 60)}`,
    summary: report.summary
  })
  logger.info(`[pipeline] review ${period} done: ${id}, ${corrections} corrections`)
  return { reviewId: id, corrections }
}
