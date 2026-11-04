/**
 * Agent 工具执行层（主进程侧）：按工具名分发执行（LLM 桥接子进程经 RPC 调用）。
 * 受限操作：activate / deactivate / publish_signal 按自主级别与批准流程控制。
 */
import type { Account, RiskCheckResult, Signal, Strategy } from '@shared/types'
import { extractDslFromMarkdown } from '@shared/strategy/schema'
import { DEFAULT_PREFERENCES } from '@shared/constants'
import { getDb, nowIso, queryAll, run } from '../db'
import { audit } from '../services/audit'
import * as dataService from '../data/service'
import { runRiskCheck, enabledRulesFromRows } from '../risk/engine'
import { computeSignalDeviation, computeSnapshotMetrics, computeTradeStats } from '../perf/engine'
import { agentEventBus } from './events'
import { deepseekWebSearch } from './webSearch'
import { dailyUpdate } from '../data/pipeline'
import { addChatMessage, formatReportContent, listChatMessages } from '../chat'
import { isAutoMode } from '../runMode'
import { applyReportDecision } from '../reportDecision'
import type { TradeRecord } from '@shared/types'

// 工具共享上下文（当前账户）
let currentAccountId = ''

function setToolAccount(accountId: string): void {
  currentAccountId = accountId
}

function accountOf(): string {
  return currentAccountId
}

function toAccountStrategy(row: Record<string, unknown>): Strategy {
  return {
    id: String(row.id),
    accountId: String(row.account_id),
    name: String(row.name),
    version: Number(row.version),
    markdown: String(row.markdown ?? ''),
    dslJson: String(row.dsl_json),
    preferencesJson: String(row.preferences_json ?? '{}'),
    status: row.status as Strategy['status'],
    createdBy: String(row.created_by),
    rationale: String(row.rationale),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  }
}

export function getStrategyForAccountDirect(accountId: string): Strategy | undefined {
  const row = getDb().prepare('SELECT * FROM strategy WHERE account_id = ?').get(accountId) as Record<string, unknown> | undefined
  return row ? toAccountStrategy(row) : undefined
}

export function getStrategyDirect(id: string): Strategy | undefined {
  const row = getDb().prepare('SELECT * FROM strategy WHERE id = ?').get(id) as Record<string, unknown> | undefined
  return row ? toAccountStrategy(row) : undefined
}

/** 账户唯一策略的 Markdown 保存：首次创建 / 迭代新版本（不改用户偏好）；```dsl 块自动同步执行层 */
export function saveStrategyMarkdownForAccount(accountId: string, name: string, markdown: string, rationale: string, createdBy: string): Strategy {
  const extracted = extractDslFromMarkdown(markdown)
  if (extracted.errors.length > 0) {
    throw new Error(`策略 Markdown 校验失败: ${extracted.errors.join('; ')}`)
  }
  const dslJson = extracted.dsl ? JSON.stringify(extracted.dsl, null, 2) : ''
  const now = nowIso()
  const existing = getStrategyForAccountDirect(accountId)
  if (!existing) {
    // 首次创建：账户唯一策略（默认偏好，后续仅用户可改）
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    run(
      'INSERT INTO strategy (id, account_id, name, version, dsl_json, markdown, preferences_json, status, created_by, rationale, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)',
      [id, accountId, name, dslJson, markdown, JSON.stringify(DEFAULT_PREFERENCES), 'draft', createdBy, rationale, now, now]
    )
    run('INSERT INTO strategy_version (id, strategy_id, version, dsl_json, markdown, change_log, created_at) VALUES (?, ?, 1, ?, ?, ?, ?)', [
      `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      id,
      dslJson,
      markdown,
      '初始版本',
      now
    ])
    audit({ accountId, actor: createdBy, action: 'strategy.create', target: id, detail: { name } })
    return getStrategyDirect(id)!
  }
  // 迭代：新版本留档
  const newVersion = existing.version + 1
  run('UPDATE strategy SET dsl_json = ?, markdown = ?, version = ?, name = ?, rationale = ?, updated_at = ? WHERE id = ?', [
    dslJson,
    markdown,
    newVersion,
    name || existing.name,
    rationale || existing.rationale,
    now,
    existing.id
  ])
  run('INSERT INTO strategy_version (id, strategy_id, version, dsl_json, markdown, change_log, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
    `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    existing.id,
    newVersion,
    dslJson,
    markdown,
    `${createdBy === 'agent' ? 'Agent 迭代' : '用户修改'}`,
    now
  ])
  audit({ accountId, actor: createdBy, action: 'strategy.update', target: existing.id, detail: { version: newVersion } })
  agentEventBus.emitAgentEvent('strategy.updated', accountId, { strategyId: existing.id, version: newVersion }, { debounceMs: 0 })
  return getStrategyDirect(existing.id)!
}

function getAccountSummary(accountId: string): Record<string, unknown> {
  const positions = queryAll<{ code: string; qty: number; cost_price: number }>(
    'SELECT code, qty, cost_price FROM position WHERE account_id = ?',
    [accountId]
  )
  const marketValue = positions.reduce((sum, p) => {
    const row = getDb().prepare('SELECT price FROM market_quote WHERE code = ?').get(p.code) as { price: number } | undefined
    return sum + p.qty * (row?.price ?? p.cost_price)
  }, 0)
  const acc = queryAll<{ cash: number }>('SELECT cash FROM account WHERE id = ?', [accountId])[0]
  const cash = acc?.cash ?? 0
  return {
    accountId,
    positionCount: positions.length,
    marketValue,
    totalAssets: cash + marketValue,
    cash,
    positions
  }
}

/** 风控检查（工具与管线共用） */
function checkRiskForSignal(
  accountId: string,
  code: string,
  side: 'buy' | 'sell',
  qty: number,
  refPrice: number
): { passed: boolean; result: RiskCheckResult } {
  const rules = enabledRulesFromRows(
    queryAll<{ rule_key: string; params_json: string; enabled: number }>('SELECT rule_key, params_json, enabled FROM risk_rule WHERE account_id = ?', [accountId])
  )
  const positions = queryAll<{ code: string; qty: number; cost_price: number }>(
    'SELECT code, qty, cost_price FROM position WHERE account_id = ?',
    [accountId]
  )
  const signalsToday = (
    queryAll<{ c: number }>(
      "SELECT COUNT(*) AS c FROM signal WHERE account_id = ? AND created_at >= datetime('now', 'start of day')",
      [accountId]
    )[0] ?? { c: 0 }
  ).c as number
  const nameRow = queryAll<{ name: string }>('SELECT name FROM stock_basic WHERE code = ?', [code])[0]
  const result = runRiskCheck(
    {
      accountId,
      totalAssets: 0,
      cash: 0,
      positions: positions.map((p) => ({ accountId, code: p.code, qty: p.qty, costPrice: p.cost_price, updatedAt: '' })),
      signalsToday,
      signal: { code, name: nameRow?.name ?? code, side, qty, refPrice }
    },
    rules
  )
  return { passed: result.passed, result }
}

// ---------- 工具执行分发 ----------
export async function executeToolCall(accountId: string, toolName: string, args: Record<string, unknown>): Promise<unknown> {
  setToolAccount(accountId)
  const account = accountOf()
  const arg = (key: string, fallback = ''): string => String(args[key] ?? fallback)
  const num = (key: string, fallback = 0): number => Number(args[key] ?? fallback)

  switch (toolName) {
    case 'search_symbols':
      return dataService.searchStocks(arg('keyword'), 20)

    case 'get_quote':
      return dataService.getQuotes((args.codes as string[]) ?? [], true)

    case 'get_kline':
      return dataService.getDailyKline(arg('code'), arg('start'), arg('end'))

    case 'get_index_overview':
      return dataService.getIndexDaily(arg('code'), arg('start'), arg('end'))

    case 'get_market_breadth':
      return dataService.getMarketBrief()

    case 'get_data_status':
      return dataService.getDataStatus()

    case 'get_data_stats':
      return dataService.getDataStats()

    case 'trigger_data_update': {
      // 数据增量更新（已在运行则忽略）；异步执行，立即返回受理状态
      try {
        void dailyUpdate().catch(() => undefined)
        return { started: true, note: '已触发增量更新（若已有任务在运行则忽略）' }
      } catch (e) {
        return { started: false, note: `更新已在进行中: ${(e as Error).message}` }
      }
    }

    case 'web_search':
      return deepseekWebSearch(account, arg('query'))

    case 'create_strategy': {
      const existing = getStrategyForAccountDirect(account)
      if (existing) throw new Error('账户已有唯一策略，请使用 update_strategy 迭代')
      // Agent 创建的策略必须含可执行 ```dsl 块（闭环完整性：生成 → 回测 → 运行）
      const md = arg('markdown')
      const extracted = extractDslFromMarkdown(md)
      if (extracted.errors.length > 0) throw new Error(`策略 Markdown 校验失败: ${extracted.errors.join('; ')}`)
      if (!extracted.dsl) throw new Error('策略 Markdown 缺少可执行的 ```dsl 代码块')
      const s = saveStrategyMarkdownForAccount(account, arg('name'), md, arg('rationale'), 'agent')
      return { id: s.id, name: s.name, status: s.status }
    }

    case 'update_strategy': {
      // 迭代账户唯一策略 Markdown（不修改用户偏好）；无 ```dsl 块时执行层清空（文档态）
      const md = arg('markdown')
      const extracted = extractDslFromMarkdown(md)
      if (extracted.errors.length > 0) throw new Error(`策略 Markdown 校验失败: ${extracted.errors.join('; ')}`)
      const s = saveStrategyMarkdownForAccount(account, arg('name'), md, arg('rationale'), 'agent')
      return { strategyId: s.id, version: s.version, executable: Boolean(extracted.dsl) }
    }

    case 'list_strategies':
    case 'get_strategy': {
      const s = getStrategyForAccountDirect(account)
      return s ? { id: s.id, name: s.name, version: s.version, status: s.status, markdown: s.markdown, dslJson: s.dslJson, preferencesJson: s.preferencesJson, rationale: s.rationale } : null
    }

    case 'activate_strategy': {
      // 自动模式（策略验证）：直接激活，无需人工批准
      const strategyId = arg('strategyId')
      if (isAutoMode()) {
        run('UPDATE strategy SET status = ?, updated_at = ? WHERE id = ?', ['active', nowIso(), strategyId])
        agentEventBus.emitAgentEvent('strategy.activated', account, { strategyId }, { debounceMs: 0 })
        audit({ accountId: account, actor: 'auto', action: 'strategy.activate.auto', target: strategyId })
        return { activated: true, strategyId, note: '自动模式：已直接激活' }
      }
      audit({ accountId: account, actor: 'agent', action: 'strategy.activate.request', target: strategyId })
      return { requested: true, strategyId, note: '已提交上线评审，需人工批准' }
    }

    case 'deactivate_strategy': {
      // 自动模式（策略验证）：直接停用，无需人工确认
      const strategyId = arg('strategyId')
      if (isAutoMode()) {
        run("UPDATE strategy SET status = 'deactivated', updated_at = ? WHERE id = ?", [nowIso(), strategyId])
        run("UPDATE run_instance SET status = 'stopped', stopped_at = ? WHERE strategy_id = ? AND status = 'active'", [nowIso(), strategyId])
        audit({ accountId: account, actor: 'auto', action: 'strategy.deactivate.auto', target: strategyId, detail: { reason: arg('reason') } })
        return { deactivated: true, strategyId, note: '自动模式：已直接停用' }
      }
      audit({ accountId: account, actor: 'agent', action: 'strategy.deactivate.request', target: strategyId, detail: { reason: arg('reason') } })
      return { requested: true, strategyId, note: '已提交停用评审，需人工确认' }
    }

    case 'run_backtest': {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      run('INSERT INTO backtest_run (id, strategy_version_id, params_json, status, created_at) VALUES (?, ?, ?, ?, ?)', [
        id,
        arg('strategyVersionId'),
        JSON.stringify({ start: arg('start'), end: arg('end') }),
        'pending',
        nowIso()
      ])
      agentEventBus.emitAgentEvent('backtest.requested', account, { runId: id, strategyVersionId: arg('strategyVersionId') }, { debounceMs: 0 })
      return { runId: id, status: 'pending' }
    }

    case 'get_backtest_result':
      return queryAll(
        'SELECT id, strategy_version_id as strategyVersionId, status, metrics_json as metricsJson, report_json as reportJson, error FROM backtest_run WHERE id = ?',
        [arg('runId')]
      )

    case 'get_backtest_trades':
      return queryAll('SELECT * FROM backtest_trade WHERE run_id = ? LIMIT 500', [arg('runId')])

    case 'list_backtests':
      // 回测任务全局列表（策略全局共享）
      return queryAll(
        `SELECT br.id, br.strategy_version_id as strategyVersionId, s.name as strategyName, br.status,
           br.metrics_json as metricsJson, br.report_json as reportJson, br.error, br.created_at as createdAt, br.finished_at as finishedAt
         FROM backtest_run br
         JOIN strategy_version sv ON sv.id = br.strategy_version_id
         JOIN strategy s ON s.id = sv.strategy_id
         ORDER BY br.created_at DESC LIMIT 100`
      )

    case 'list_accounts':
      return queryAll('SELECT id, name, autonomy_level as autonomyLevel, created_at as createdAt FROM account ORDER BY created_at')

    case 'get_account_summary':
      return getAccountSummary(account)

    case 'get_positions':
      return queryAll('SELECT code, qty, cost_price as costPrice, updated_at as updatedAt FROM position WHERE account_id = ?', [account])

    case 'list_trade_records':
      return queryAll(
        'SELECT id, code, side, price, qty, fee, traded_at as tradedAt, signal_id as signalId, note FROM trade_record WHERE account_id = ? ORDER BY traded_at DESC LIMIT ?',
        [account, num('limit', 100)]
      )

    case 'check_risk': {
      const { result } = checkRiskForSignal(account, arg('code'), (args.side as 'buy' | 'sell') ?? 'buy', num('qty'), num('refPrice'))
      return result
    }

    case 'publish_signal': {
      const code = arg('code')
      const side = (args.side as 'buy' | 'sell') ?? 'buy'
      const qty = num('qty')
      const refPrice = num('refPrice')
      const { passed, result: risk } = checkRiskForSignal(account, code, side, qty, refPrice)
      if (!passed) {
        run('INSERT INTO risk_check_result (account_id, ref_type, ref_id, results_json, passed, checked_at) VALUES (?, ?, ?, ?, 0, ?)', [
          account,
          'signal',
          code,
          JSON.stringify(risk),
          nowIso()
        ])
        throw new Error(`风控拒绝: ${risk.checks.filter((c) => c.result === 'reject').map((c) => c.message).join('; ')}`)
      }
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const now = nowIso()
      const expiresAt = new Date(Date.now() + 24 * 3600 * 1000).toISOString()
      run(
        'INSERT INTO signal (id, account_id, run_id, strategy_id, code, side, qty, ref_price, basis_json, risk_json, status, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [id, account, arg('runId'), arg('strategyId'), code, side, qty, refPrice, JSON.stringify({ basis: arg('basis') }), JSON.stringify(risk), 'pending_execution', expiresAt, now, now]
      )
      run('INSERT INTO risk_check_result (account_id, ref_type, ref_id, results_json, passed, checked_at) VALUES (?, ?, ?, ?, 1, ?)', [
        account,
        'signal',
        id,
        JSON.stringify(risk),
        now
      ])
      agentEventBus.emitAgentEvent('signal.new', account, { signalId: id, code, side }, { debounceMs: 0 })
      return { signalId: id, status: 'pending_execution', riskPassed: true }
    }

    case 'raise_alert': {
      const level = (args.level as 'info' | 'warn' | 'critical') ?? 'info'
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      run('INSERT INTO alert (id, account_id, level, type, content_json, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
        id,
        account,
        level,
        arg('type'),
        JSON.stringify({ content: arg('content') }),
        'open',
        nowIso()
      ])
      agentEventBus.emitAgentEvent('alert.triggered', account, { alertId: id, level, type: arg('type') }, { debounceMs: 0 })
      return { alertId: id }
    }

    case 'list_alerts':
      return queryAll('SELECT id, level, type, content_json as contentJson, status, created_at as createdAt FROM alert WHERE account_id = ? ORDER BY created_at DESC LIMIT ?', [
        account,
        num('limit', 50)
      ])

    case 'acknowledge_alert':
      run("UPDATE alert SET status = 'acknowledged' WHERE id = ?", [arg('alertId')])
      return { acknowledged: true, alertId: arg('alertId') }

    case 'list_signals':
      return queryAll(
        'SELECT id, run_id as runId, strategy_id as strategyId, code, side, qty, ref_price as refPrice, basis_json as basisJson, risk_json as riskJson, status, expires_at as expiresAt, created_at as createdAt FROM signal WHERE account_id = ? ORDER BY created_at DESC LIMIT ?',
        [account, num('limit', 100)]
      )

    case 'list_run_instances':
      return queryAll(
        'SELECT ri.id, ri.strategy_id as strategyId, s.name as strategyName, ri.status, ri.started_at as startedAt, ri.stopped_at as stoppedAt FROM run_instance ri LEFT JOIN strategy s ON s.id = ri.strategy_id ORDER BY ri.started_at DESC LIMIT 100'
      )

    case 'list_review_reports':
      return queryAll('SELECT id, period, content_json as contentJson, metrics_json as metricsJson, created_by as createdBy, created_at as createdAt FROM review_report WHERE account_id = ? ORDER BY created_at DESC LIMIT ?', [
        account,
        num('limit', 20)
      ])

    case 'get_review_report':
      return queryAll('SELECT id, period, content_json as contentJson, metrics_json as metricsJson, created_at as createdAt FROM review_report WHERE id = ?', [
        arg('reviewId')
      ])

    case 'get_performance': {
      const snapshots = queryAll<{ date: string; total_assets: number }>(
        'SELECT date, total_assets FROM account_snapshot WHERE account_id = ? ORDER BY date ASC',
        [account]
      )
      const signals = queryAll<{ status: string }>('SELECT status FROM signal WHERE account_id = ?', [account])
      const trades = queryAll<TradeRecord>(
        'SELECT id, account_id as accountId, code, side, price, qty, fee, traded_at as tradedAt, signal_id as signalId, note FROM trade_record WHERE account_id = ? ORDER BY traded_at',
        [account]
      )
      return {
        metrics: computeSnapshotMetrics(snapshots.map((s) => ({ date: s.date, totalAssets: s.total_assets }))),
        signalDeviation: computeSignalDeviation(signals),
        tradeStats: computeTradeStats(trades)
      }
    }

    case 'list_reports':
      return queryAll(
        'SELECT id, level, title, summary, decision_json as decisionJson, status, work_item_id as workItemId, created_at as createdAt, updated_at as updatedAt FROM report WHERE account_id = ? ORDER BY created_at DESC LIMIT ?',
        [account, num('limit', 50)]
      )

    case 'get_plan':
      return queryAll('SELECT id, period, content_json as contentJson, status, created_at as createdAt FROM plan WHERE account_id = ? ORDER BY created_at DESC LIMIT ?', [
        account,
        num('limit', 5)
      ])

    case 'list_work_items':
      return queryAll(
        'SELECT id, type, status, priority, context_json as contextJson, attempts, error, created_at as createdAt, finished_at as finishedAt FROM work_item WHERE account_id = ? ORDER BY created_at DESC LIMIT ?',
        [account, num('limit', 50)]
      )

    case 'list_audit_logs':
      return queryAll(
        'SELECT id, actor, action, target, detail_json as detailJson, created_at as createdAt FROM audit_log WHERE account_id = ? ORDER BY id DESC LIMIT ?',
        [account, num('limit', 50)]
      )

    case 'list_events':
      return queryAll(
        'SELECT id, type, payload_json as payloadJson, source, correlation_id as correlationId, occurred_at as occurredAt FROM event_log WHERE account_id = ? ORDER BY id DESC LIMIT ?',
        [account, num('limit', 50)]
      )

    case 'report_to_user': {
      const level = (args.level as 'result' | 'summary' | 'need_decision') ?? 'result'
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const now = nowIso()
      const title = arg('title')
      const summary = arg('summary')
      const decisionJson = args.decisionJson ?? null
      // 自动模式（策略验证）：need_decision 汇报自动批准并执行，无需人工干预
      const autoApproved = level === 'need_decision' && isAutoMode()
      run('INSERT INTO report (id, account_id, level, title, summary, decision_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [
        id,
        account,
        level,
        title,
        summary,
        decisionJson,
        autoApproved ? 'approved' : 'pending',
        now,
        now
      ])
      // 汇报同步进入首页对话流
      addChatMessage({
        accountId: account,
        role: 'assistant',
        kind: 'report',
        content: autoApproved ? `${formatReportContent(title, summary, level)}\n（自动模式：已自动批准并执行）` : formatReportContent(title, summary, level),
        reportId: id,
        reportLevel: level,
        reportStatus: autoApproved ? 'approved' : 'pending'
      })
      if (autoApproved && decisionJson) {
        applyReportDecision({ reportId: id, accountId: account, decisionJson: String(decisionJson), decision: 'approved', actor: 'auto', note: '自动模式自动批准' })
      }
      agentEventBus.emitAgentEvent('agent.report', account, { reportId: id, level, title, autoApproved }, { debounceMs: 0 })
      return { reportId: id, autoApproved }
    }

    case 'get_chat_history':
      return listChatMessages(account, { limit: num('limit', 30) }).messages.map((m) => ({ role: m.role, content: m.content, createdAt: m.createdAt }))

    case 'finish_workitem':
      return { done: true, summary: arg('summary') }

    default:
      throw new Error(`未知工具: ${toolName}`)
  }
}

/** 供非 Agent 路径（管线）复用的信号入库函数 */
export function persistSignal(accountId: string, signal: Omit<Signal, 'id' | 'createdAt' | 'updatedAt' | 'expiresAt' | 'accountId'> & { accountId?: string }): Signal {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const now = nowIso()
  const expiresAt = new Date(Date.now() + 24 * 3600 * 1000).toISOString()
  run(
    'INSERT INTO signal (id, account_id, run_id, strategy_id, code, side, qty, ref_price, basis_json, risk_json, status, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [
      id,
      signal.accountId ?? accountId,
      signal.runId,
      signal.strategyId,
      signal.code,
      signal.side,
      signal.qty,
      signal.refPrice,
      signal.basisJson,
      signal.riskJson,
      signal.status,
      expiresAt,
      now,
      now
    ]
  )
  agentEventBus.emitAgentEvent('signal.new', signal.accountId ?? accountId, { signalId: id, code: signal.code }, { debounceMs: 0 })
  return { ...signal, id, accountId: signal.accountId ?? accountId, expiresAt, createdAt: now, updatedAt: now }
}

export function getAccountDirect(accountId: string): Account | undefined {
  const row = getDb().prepare('SELECT * FROM account WHERE id = ?').get(accountId) as Record<string, unknown> | undefined
  if (!row) return undefined
  return {
    id: String(row.id),
    name: String(row.name),
    configJson: String(row.config_json),
    autonomyLevel: row.autonomy_level as Account['autonomyLevel'],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  }
}
