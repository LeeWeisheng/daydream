/**
 * 自动运行（runner）：收盘后由 Agent 基于策略文档（系统提示词主体）产出交易建议（信号）。
 * 调度默认每交易日 15:05（收盘后），用收盘实时快照（当日收盘价）；
 * 信号经 Agent 调用 publish_signal 产出，必经风控引擎校验；信号仅推送，人工执行后反馈闭环。
 * 运行结束后刷新生效版本的统计（本金/盈亏/盈亏比/胜率）。
 */
import { newId, nowIso, queryAll, run } from '../db/connection'
import { audit } from '../services/audit'
import { logger } from '../services/logger'
import { runAgentTurn } from '../app/sessions'
import { RUNNER_PROMPT } from '../agent/prompts'
import { getMarketBrief } from '../market/service'
import { getStrategyForAccount, getEffectiveVersion, refreshVersionStats } from '../strategy/service'
import { checkRiskForSignal } from '../signals/service'
import { shanghaiDateStr } from '@shared/constants'

/** 运行决策：对活跃账户的生效策略跑一遍 Agent 信号评估（每账户唯一策略） */
export async function runDailyDecision(accountId: string): Promise<{ signals: number }> {
  const strategy = getStrategyForAccount(accountId)
  if (!strategy) {
    logger.info(`[runner] account ${accountId} has no strategy, skipped`)
    return { signals: 0 }
  }
  const before = countSignalsToday(accountId)
  try {
    await evaluateStrategy(accountId, strategy.id)
  } catch (e) {
    logger.warn(`[runner] strategy ${strategy.id} decision failed: ${(e as Error).message}`)
  }
  // 刷新生效版本统计（成交记录可能有更新）
  const eff = getEffectiveVersion(accountId)
  if (eff) refreshVersionStats(strategy.id, eff.versionId)
  const after = countSignalsToday(accountId)
  const emitted = Math.max(after - before, 0)
  logger.info(`[runner] daily decision done: ${emitted} signals`)
  return { signals: emitted }
}

/** 由 Agent 基于策略文档决策并产出信号（策略文档经 sessions 注入系统提示词） */
async function evaluateStrategy(accountId: string, strategyId: string): Promise<void> {
  // 运行实例（无则创建；记录运行事实，供信号关联）
  let instance = queryAll<{ id: string }>('SELECT id FROM run_instance WHERE strategy_id = ? AND status = ?', [strategyId, 'active'])[0]
  if (!instance) {
    const id = newId()
    const versionId = queryAll<{ id: string }>('SELECT id FROM strategy_version WHERE strategy_id = ? ORDER BY version DESC LIMIT 1', [strategyId])[0]?.id ?? ''
    run('INSERT INTO run_instance (id, strategy_id, strategy_version_id, status, started_at) VALUES (?, ?, ?, ?, ?)', [id, strategyId, versionId, 'active', nowIso()])
    instance = { id }
  }

  // 市场简报与账户概览作为决策输入（Agent 可继续用工具深入）
  const brief = await getMarketBrief()
  const positions = queryAll<{ code: string; qty: number; cost_price: number }>('SELECT code, qty, cost_price FROM position WHERE account_id = ?', [accountId])
  const prompt = [
    `今天是 ${shanghaiDateStr()}（交易日），请执行收盘后的运行决策。`,
    '',
    `当前运行实例 runId: ${instance.id}`,
    `当前策略 strategyId: ${strategyId}`,
    '',
    '账户持仓（code, qty, cost_price）：',
    positions.length ? positions.map((p) => `- ${p.code} 数量 ${p.qty} 成本 ${p.cost_price}`).join('\n') : '- （空仓）',
    '',
    '市场简报：',
    JSON.stringify(brief, null, 2),
    '',
    '请严格按系统提示词中的策略文档决策；只产出有明确依据的信号。'
  ].join('\n')

  const reply = await runAgentTurn(accountId, {
    system: RUNNER_PROMPT,
    prompt,
    purpose: 'daily_decision',
    maxSteps: 12,
    useProModel: true
  })
  audit({ accountId, actor: 'agent', action: 'runner.decided', target: strategyId, detail: { reply: reply.slice(0, 500) } })
}

function countSignalsToday(accountId: string): number {
  // 按上海时区当日零点起算（信号 created_at 为 UTC ISO 串）
  const shDate = shanghaiDateStr()
  const startUtc = new Date(`${shDate}T00:00:00+08:00`).toISOString()
  return queryAll<{ c: number }>('SELECT COUNT(*) AS c FROM signal WHERE account_id = ? AND created_at >= ?', [accountId, startUtc])[0]?.c ?? 0
}

/** 风控复检（供工具与管线复用） */
export { checkRiskForSignal }
