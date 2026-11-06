/**
 * Agent 工具执行层（主进程侧）：按工具名分发执行（LLM 桥接子进程经 RPC 调用）。
 * 规则（docs《系统规则与账户模型》§5/§6）：
 * - 权限白名单：仅放行自有工具（bridge 侧 canUseTool 强制）；
 * - 所有业务读写经服务层（单写者），工具不再直写 SQL；
 * - 策略为 Markdown 纯文本，Agent 可读（get_strategy）可改（update_strategy，新版本立即生效）。
 */
import type { Signal, Strategy } from '@shared/types'
import { getDb, queryAll } from '../../db/connection'
import * as marketService from '../../market/service'
import { dailyUpdate } from '../../market/pipeline'
import { deepseekWebSearch } from '../webSearch'
import {
  computeAccountStats,
  getEffectiveVersion,
  getStrategyForAccount,
  listVersions,
  saveStrategyMarkdown
} from '../../strategy/service'
import { checkRiskForSignal } from '../../signals/service'
import { publishSignal } from '../../signals/service'
import { raiseAlert, listAlerts, acknowledgeAlert } from '../../alerts/service'
import { publishReport } from '../../reports/service'
import { listChatMessages } from '../../chat/service'
import { computeSignalDeviation, computeSnapshotMetrics, computeTradeStats } from '../../quant/perf'
import { uiBus } from '../../app/events'
import type { TradeRecord } from '@shared/types'

// ---------- 工具上下文（当前账户） ----------
let currentAccountId = ''

function accountOf(): string {
  return currentAccountId
}

/** 账户资金与持仓概览（工具与管线共用） */
function accountSummary(accountId: string): Record<string, unknown> {
  const positions = queryAll<{ code: string; qty: number; cost_price: number }>('SELECT code, qty, cost_price FROM position WHERE account_id = ?', [accountId])
  const marketValue = positions.reduce((sum, p) => {
    const row = getDb().prepare('SELECT price FROM market_quote WHERE code = ?').get(p.code) as { price: number } | undefined
    return sum + p.qty * (row?.price ?? p.cost_price)
  }, 0)
  const acc = queryAll<{ cash: number }>('SELECT cash FROM account WHERE id = ?', [accountId])[0]
  const cash = acc?.cash ?? 0
  return { accountId, positionCount: positions.length, marketValue, totalAssets: cash + marketValue, cash, positions }
}

// ---------- 工具执行分发 ----------
export async function executeToolCall(accountId: string, toolName: string, args: Record<string, unknown>): Promise<unknown> {
  currentAccountId = accountId
  const account = accountOf()
  const arg = (key: string, fallback = ''): string => String(args[key] ?? fallback)
  const num = (key: string, fallback = 0): number => Number(args[key] ?? fallback)

  switch (toolName) {
    // —— 市场数据 ——
    case 'search_symbols':
      return marketService.searchStocks(arg('keyword'), 20)
    case 'get_quote':
      return marketService.getQuotes((args.codes as string[]) ?? [], true)
    case 'get_kline':
      return marketService.getDailyKline(arg('code'), arg('start'), arg('end'))
    case 'get_index_overview':
      return marketService.getIndexDaily(arg('code'), arg('start'), arg('end'))
    case 'get_market_breadth':
      return marketService.getMarketBrief()
    case 'get_data_status':
      return marketService.getDataStatus()
    case 'get_data_stats':
      return marketService.getDataStats()
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

    // —— 策略管理（每账户唯一一份 Markdown 纯文本策略；Agent 可读可改，新版本立即生效） ——
    case 'get_strategy': {
      const s = getStrategyForAccount(account)
      if (!s) return null
      // 与注入系统提示词的文档保持一致：生效版本优先（用户指定历史版本时为其内容）
      const eff = getEffectiveVersion(account)
      const versions = listVersions(s.id)
      return {
        id: s.id,
        title: eff?.title ?? s.title,
        version: eff?.version ?? s.version,
        markdown: eff?.markdown ?? s.markdown,
        pinned: eff?.pinned ?? false,
        activeVersionId: s.activeVersionId,
        stats: computeAccountStats(account),
        versions: versions.map((v) => ({ id: v.id, version: v.version, title: v.title, changeLog: v.changeLog, stats: safeParse(v.statsJson), createdAt: v.createdAt }))
      }
    }
    case 'get_strategy_versions': {
      const s = getStrategyForAccount(account)
      if (!s) return []
      return listVersions(s.id).map((v) => ({ id: v.id, version: v.version, title: v.title, changeLog: v.changeLog, stats: safeParse(v.statsJson), createdAt: v.createdAt }))
    }
    case 'update_strategy': {
      // 校验必填字段：标题（大模型生成）与一句话变更记录
      const title = arg('title').trim()
      const changeLog = arg('changeLog').trim()
      const markdown = arg('markdown')
      if (!markdown.trim()) throw new Error('策略文档（markdown）不能为空')
      if (!title) throw new Error('必须提供简短标题（title）')
      if (!changeLog) throw new Error('必须提供一句话变更记录（changeLog）')
      if (title.length > 40) throw new Error('标题过长（≤ 40 字）')
      if (changeLog.length > 120) throw new Error('变更记录过长（≤ 120 字）')
      const s = saveStrategyMarkdown({ accountId: account, title, markdown, changeLog, createdBy: 'agent' })
      uiBus.broadcast('strategy.updated', { accountId: account, strategyId: s.id, version: s.version })
      return { strategyId: s.id, title: s.title, version: s.version, effective: 'latest' }
    }

    // —— 策略评估记录 ——
    case 'get_backtest_result':
      return queryAll(
        'SELECT id, strategy_version_id as strategyVersionId, status, metrics_json as metricsJson, report_json as reportJson, error FROM backtest_run WHERE id = ?',
        [arg('runId')]
      )
    case 'list_backtests':
      return queryAll(
        `SELECT br.id, br.strategy_version_id as strategyVersionId, s.title as strategyTitle, br.status,
           br.metrics_json as metricsJson, br.report_json as reportJson, br.error, br.created_at as createdAt, br.finished_at as finishedAt
         FROM backtest_run br
         JOIN strategy_version sv ON sv.id = br.strategy_version_id
         JOIN strategy s ON s.id = sv.strategy_id
         ORDER BY br.created_at DESC LIMIT 100`
      )

    // —— 账户、资金与风控 ——
    case 'list_accounts':
      return queryAll('SELECT id, name, autonomy_level as autonomyLevel, created_at as createdAt FROM account ORDER BY created_at')
    case 'get_account_summary':
      return accountSummary(account)
    case 'get_positions':
      return queryAll('SELECT code, qty, cost_price as costPrice, updated_at as updatedAt FROM position WHERE account_id = ?', [account])
    case 'list_trade_records':
      return queryAll(
        'SELECT id, code, side, price, qty, fee, traded_at as tradedAt, signal_id as signalId, note FROM trade_record WHERE account_id = ? ORDER BY traded_at DESC LIMIT ?',
        [account, num('limit', 100)]
      )
    case 'check_risk': {
      return checkRiskForSignal(account, {
        code: arg('code'),
        side: (args.side as 'buy' | 'sell') ?? 'buy',
        qty: num('qty'),
        refPrice: num('refPrice')
      })
    }
    case 'publish_signal': {
      const signal = publishSignal(account, {
        runId: arg('runId'),
        strategyId: arg('strategyId'),
        code: arg('code'),
        side: (args.side as 'buy' | 'sell') ?? 'buy',
        qty: num('qty'),
        refPrice: num('refPrice'),
        basis: arg('basis')
      })
      return { signalId: signal.id, status: signal.status, riskPassed: true }
    }
    case 'list_signals':
      return queryAll(
        'SELECT id, run_id as runId, strategy_id as strategyId, code, side, qty, ref_price as refPrice, basis_json as basisJson, risk_json as riskJson, status, expires_at as expiresAt, created_at as createdAt FROM signal WHERE account_id = ? ORDER BY created_at DESC LIMIT ?',
        [account, num('limit', 100)]
      )
    case 'list_run_instances':
      return queryAll(
        'SELECT ri.id, ri.strategy_id as strategyId, s.title as strategyTitle, ri.status, ri.started_at as startedAt, ri.stopped_at as stoppedAt FROM run_instance ri LEFT JOIN strategy s ON s.id = ri.strategy_id ORDER BY ri.started_at DESC LIMIT 100'
      )
    case 'get_chat_history':
      return listChatMessages(account, { limit: num('limit', 30) }).messages.map((m) => ({ role: m.role, content: m.content, createdAt: m.createdAt }))

    // —— 盯盘与预警 ——
    case 'raise_alert':
      return { alertId: raiseAlert({ accountId: account, level: (args.level as 'info' | 'warn' | 'critical') ?? 'info', type: arg('type'), content: arg('content') }).id }
    case 'list_alerts':
      return listAlerts(account, num('limit', 50))
    case 'acknowledge_alert':
      acknowledgeAlert(arg('alertId'))
      return { acknowledged: true, alertId: arg('alertId') }

    // —— 复盘与绩效 ——
    case 'list_review_reports':
      return queryAll('SELECT id, period, content_json as contentJson, metrics_json as metricsJson, created_by as createdBy, created_at as createdAt FROM review_report WHERE account_id = ? ORDER BY created_at DESC LIMIT ?', [
        account,
        num('limit', 20)
      ])
    case 'get_review_report':
      return queryAll('SELECT id, period, content_json as contentJson, metrics_json as metricsJson, created_at as createdAt FROM review_report WHERE id = ?', [arg('reviewId')])
    case 'get_performance': {
      const snapshots = queryAll<{ date: string; total_assets: number }>('SELECT date, total_assets FROM account_snapshot WHERE account_id = ? ORDER BY date ASC', [account])
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

    // —— 汇报、计划与系统自查 ——
    case 'list_reports':
      return queryAll(
        'SELECT id, level, title, summary, decision_json as decisionJson, status, work_item_id as workItemId, created_at as createdAt, updated_at as updatedAt FROM report WHERE account_id = ? ORDER BY created_at DESC LIMIT ?',
        [account, num('limit', 50)]
      )
    case 'report_to_user': {
      const level = (args.level as 'result' | 'summary' | 'need_decision') ?? 'result'
      const result = publishReport({
        accountId: account,
        level,
        title: arg('title'),
        summary: arg('summary'),
        decisionJson: args.decisionJson ? String(args.decisionJson) : undefined
      })
      return { reportId: result.reportId, autoApproved: result.autoApproved }
    }
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
    case 'finish_workitem':
      return { done: true, summary: arg('summary') }

    default:
      throw new Error(`未知工具: ${toolName}`)
  }
}

/** JSON 解析兜底（策略版本统计等字段） */
function safeParse(json: string): unknown {
  try {
    return JSON.parse(json)
  } catch {
    return {}
  }
}

export type { Signal, Strategy }
