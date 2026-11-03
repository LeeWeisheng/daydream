/**
 * IPC Handler：白名单通道注册（`域:动作` 命名）。
 * 事件推送统一走 `daydream:event` 通道；密钥类配置不回传明文。
 */
import { ipcMain, BrowserWindow, safeStorage } from 'electron'
import { randomUUID } from 'node:crypto'
import { IPC, type SettingsPatch, type SignalFeedbackReq, type ReportRespondReq } from '@shared/ipc'
import type { Account, ModelConfig, Report, Signal, Strategy } from '@shared/types'
import { ensureAccount, firstAccount, createAccount as dbCreateAccount, getDb, nowIso, queryAll, run } from '../db'
import { audit } from '../services/audit'
import { encryptString, decryptString } from '../services/crypto'
import { logger } from '../services/logger'
import * as dataService from '../data/service'
import { initialSync, dailyUpdate, dataTaskState } from '../data/pipeline'
import { providerManager } from '../data/providers/base'
import { EastmoneyProvider } from '../data/providers/eastmoney'
import { TencentProvider } from '../data/providers/tencent'
import * as backtestPipeline from '../pipeline/backtester'
import * as runnerPipeline from '../pipeline/runner'
import * as reviewPipeline from '../pipeline/reviewer'
import { parseAndValidateDsl } from '@shared/strategy/schema'
import { calcFee } from '@shared/constants'
import { agentEventBus, subscribeAgentEvents } from '../agent/events'
import { createWorkItem, listWorkItems } from '../agent/workitem'
import { getAgentStatus, retryWorkItem, cancelWorkItem, setAgentRunning, isAgentRunning } from '../agent/loop'
import { createStrategyDirect } from '../agent/tools'
import { computeSnapshotMetrics, computeSignalDeviation, computeTradeStats } from '../perf/engine'
import { isModelConfigured } from '../agent/llm'
import { getModelConfig, saveModelConfig, GLOBAL_CONFIG_ACCOUNT } from '../agent/modelConfig'

/** 活跃账户（Agent/调度器运行的资金视角；顶栏切换时更新） */
let activeAccountId = ''

export function getActiveAccountId(): string {
  if (activeAccountId) return activeAccountId
  return firstAccount()?.id ?? ''
}

function broadcast(event: { type: string; payload: unknown }): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(IPC.uiEvent, event)
  }
}

/** 桥接 Agent 事件与信号事件到渲染进程统一事件流 */
function bridgeAgentEvents(): void {
  subscribeAgentEvents((e) => {
    const typeMap: Record<string, string> = {
      'signal.new': 'signal.new',
      'alert.triggered': 'alert.triggered',
      'agent.report': 'agent.report',
      'workitem.completed': 'workitem.updated',
      'workitem.failed': 'workitem.updated',
      'backtest.completed': 'backtest.finished',
      'strategy.updated': 'strategy.updated',
      'strategy.activated': 'strategy.updated',
      'plan.completed': 'agent.status'
    }
    const type = typeMap[e.type] ?? 'agent.status'
    broadcast({ type, payload: { ...e.payload, accountId: e.accountId, eventType: e.type } })
  })
}

// ---------- 账户 ----------
function toAccount(row: Record<string, unknown>): Account {
  return {
    id: String(row.id),
    name: String(row.name),
    configJson: String(row.config_json),
    autonomyLevel: row.autonomy_level as Account['autonomyLevel'],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  }
}

// ---------- 设置（模型配置全局通用） ----------
function getSettings(accountId: string): { modelConfig?: ModelConfig; autonomyLevel?: string; monitorIntervalMinutes?: number; modelConfigured: boolean } {
  void accountId
  const account = firstAccount()
  const cfg = getModelConfig()
  const modelConfig: ModelConfig | undefined = cfg ? { ...cfg, apiKey: cfg.apiKey ? '********' : '' } : undefined // 密钥不回传明文
  return {
    modelConfig,
    autonomyLevel: account ? 'conservative' : 'conservative',
    monitorIntervalMinutes: 2,
    modelConfigured: isModelConfigured()
  }
}

function updateSettings(accountId: string, patch: SettingsPatch): void {
  if (patch.autonomyLevel) {
    const account = ensureAccount(accountId)
    if (account) run('UPDATE account SET autonomy_level = ?, updated_at = ? WHERE id = ?', [patch.autonomyLevel, nowIso(), account.id])
  }
  if (patch.modelConfig) {
    // 模型配置全局通用（所有账户共用）
    saveModelConfig(patch.modelConfig, encryptString, nowIso, (sql, params) => run(sql, params))
    audit({ accountId: GLOBAL_CONFIG_ACCOUNT, actor: 'user', action: 'settings.model_config.updated' })
  }
}

// ---------- 注册 ----------
export function registerIpcHandlers(): void {
  // 数据源注册
  providerManager.register(new EastmoneyProvider())
  providerManager.register(new TencentProvider())
  bridgeAgentEvents()

  // 账户
  ipcMain.handle(IPC.accountList, () => queryAll<Record<string, unknown>>('SELECT * FROM account ORDER BY created_at').map(toAccount))
  ipcMain.handle(IPC.accountCreate, (_e, req: { name: string }) => {
    const created = dbCreateAccount(req.name || '新账户')
    if (!activeAccountId) activeAccountId = created.id
    return toAccount(queryAll<Record<string, unknown>>('SELECT * FROM account WHERE id = ?', [created.id])[0])
  })
  ipcMain.handle(IPC.accountSwitch, (_e, req: { accountId: string }) => {
    const row = queryAll<Record<string, unknown>>('SELECT * FROM account WHERE id = ?', [req.accountId])[0]
    if (!row) throw new Error('账户不存在')
    activeAccountId = req.accountId
    return toAccount(row)
  })
  ipcMain.handle(IPC.accountDelete, (_e, accountId: string) => {
    run('DELETE FROM account WHERE id = ?', [accountId])
    audit({ accountId, actor: 'user', action: 'account.delete', target: accountId })
    if (activeAccountId === accountId) activeAccountId = firstAccount()?.id ?? ''
  })

  // 设置
  ipcMain.handle(IPC.settingsGet, (_e, accountId: string) => getSettings(accountId))
  ipcMain.handle(IPC.settingsUpdate, (_e, accountId: string, patch: SettingsPatch) => updateSettings(accountId, patch))

  // 数据
  ipcMain.handle(IPC.dataGetStockList, () => dataService.getStockList())
  ipcMain.handle(IPC.dataGetQuote, (_e, codes: string[]) => dataService.getQuotes(codes))
  ipcMain.handle(IPC.dataGetKline, (_e, req: { code: string; start: string; end: string }) => dataService.getDailyKline(req.code, req.start, req.end))
  ipcMain.handle(IPC.dataGetDataStatus, () => dataService.getDataStatus())
  ipcMain.handle(IPC.dataInitialSync, async () => {
    initialSync(3, (done, total, message) => broadcast({ type: 'data.progress', payload: { done, total, message } })).catch((e) =>
      logger.error(`[ipc] initial sync failed: ${(e as Error).message}`)
    )
    return { started: true }
  })
  ipcMain.handle(IPC.dataDailyUpdate, async () => {
    dailyUpdate((done, total, message) => broadcast({ type: 'data.progress', payload: { done, total, message } })).catch((e) =>
      logger.error(`[ipc] daily update failed: ${(e as Error).message}`)
    )
    return { started: true }
  })

  // 策略（全局共享：所有账户共用同一策略库，资金/持仓隔离由信号与持仓表承担）
  ipcMain.handle(IPC.strategyList, () =>
    queryAll<Record<string, unknown>>('SELECT * FROM strategy ORDER BY created_at DESC')
  )
  ipcMain.handle(IPC.strategyGet, (_e, id: string) => queryAll<Record<string, unknown>>('SELECT * FROM strategy WHERE id = ?', [id])[0])
  ipcMain.handle(IPC.strategyCreate, (_e, req: { accountId: string; name: string; dslJson: string; rationale?: string }) => {
    const { errors } = parseAndValidateDsl(req.dslJson)
    if (errors.length > 0) throw new Error(`DSL 校验失败: ${errors.join('; ')}`)
    return createStrategyDirect(req.accountId, req.name, req.dslJson, req.rationale ?? '', 'user')
  })
  ipcMain.handle(IPC.strategyUpdate, (_e, req: { id: string; dslJson: string; changeLog: string }) => {
    const { errors } = parseAndValidateDsl(req.dslJson)
    if (errors.length > 0) throw new Error(`DSL 校验失败: ${errors.join('; ')}`)
    const existing = queryAll<{ version: number }>('SELECT version FROM strategy WHERE id = ?', [req.id])[0]
    if (!existing) throw new Error('策略不存在')
    const next = existing.version + 1
    const now = nowIso()
    run('UPDATE strategy SET dsl_json = ?, version = ?, updated_at = ? WHERE id = ?', [req.dslJson, next, now, req.id])
    run('INSERT INTO strategy_version (id, strategy_id, version, dsl_json, change_log, created_at) VALUES (?, ?, ?, ?, ?, ?)', [
      randomUUID(),
      req.id,
      next,
      req.dslJson,
      req.changeLog,
      now
    ])
    return queryAll<Record<string, unknown>>('SELECT * FROM strategy WHERE id = ?', [req.id])[0]
  })
  ipcMain.handle(IPC.strategyActivate, async (_e, req: { accountId: string; id: string }) => runnerPipeline.activateStrategy(req.accountId, { strategyId: req.id }))
  ipcMain.handle(IPC.strategyDeactivate, (_e, req: { accountId: string; id: string; reason?: string }) =>
    runnerPipeline.deactivateStrategy(req.accountId, req.id, req.reason ?? '')
  )

  // 回测
  ipcMain.handle(IPC.backtestStart, (_e, req: { accountId: string; strategyVersionId: string; start: string; end: string }) =>
    backtestPipeline.startBacktestTask(req.accountId, req.strategyVersionId, req.start, req.end).then((runId) => ({ runId }))
  )
  ipcMain.handle(IPC.backtestCancel, (_e, runId: string) => run("UPDATE backtest_run SET status = 'failed', error = '已取消' WHERE id = ? AND status IN ('pending','running')", [runId]))
  ipcMain.handle(IPC.backtestList, (_e, accountId: string) =>
    queryAll(
      `SELECT br.* FROM backtest_run br
       JOIN strategy_version sv ON sv.id = br.strategy_version_id
       JOIN strategy s ON s.id = sv.strategy_id
       WHERE s.account_id = ? ORDER BY br.created_at DESC LIMIT 200`,
      [accountId]
    )
  )
  ipcMain.handle(IPC.backtestGetResult, (_e, runId: string) => queryAll<Record<string, unknown>>('SELECT * FROM backtest_run WHERE id = ?', [runId])[0])
  ipcMain.handle(IPC.backtestGetTrades, (_e, runId: string) => queryAll('SELECT * FROM backtest_trade WHERE run_id = ? ORDER BY traded_at', [runId]))

  // 信号
  ipcMain.handle(IPC.signalList, (_e, accountId: string, limit = 100) =>
    queryAll<Record<string, unknown>>('SELECT * FROM signal WHERE account_id = ? ORDER BY created_at DESC LIMIT ?', [accountId, limit])
  )
  ipcMain.handle(IPC.signalFeedback, (_e, req: SignalFeedbackReq) => {
    run('UPDATE signal SET status = ?, updated_at = ? WHERE id = ?', [req.feedback, nowIso(), req.signalId])
    const signal = queryAll<{ account_id: string; code: string; side: string; qty: number }>('SELECT * FROM signal WHERE id = ?', [req.signalId])[0]
    if (signal && req.feedback === 'executed') {
      // 已执行 → 自动生成成交记录（含费用）
      const price = req.tradedPrice ?? 0
      const qty = req.tradedQty ?? signal.qty
      const amount = price * qty
      const fee = req.fee ?? calcFee(signal.side as 'buy' | 'sell', amount)
      run('INSERT INTO trade_record (id, account_id, code, side, price, qty, fee, traded_at, signal_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [
        randomUUID(),
        signal.account_id,
        signal.code,
        signal.side,
        price,
        qty,
        fee,
        nowIso(),
        req.signalId
      ])
      // 更新持仓
      const pos = queryAll<{ qty: number; cost_price: number }>('SELECT qty, cost_price FROM position WHERE account_id = ? AND code = ?', [signal.account_id, signal.code])[0]
      if (signal.side === 'buy') {
        const newQty = (pos?.qty ?? 0) + qty
        const newCost = pos ? (pos.cost_price * pos.qty + amount + fee) / newQty : (amount + fee) / newQty
        run(
          'INSERT INTO position (account_id, code, qty, cost_price, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(account_id, code) DO UPDATE SET qty=excluded.qty, cost_price=excluded.cost_price, updated_at=excluded.updated_at',
          [signal.account_id, signal.code, newQty, newCost, nowIso()]
        )
      } else {
        const newQty = (pos?.qty ?? 0) - qty
        if (newQty <= 0) run('DELETE FROM position WHERE account_id = ? AND code = ?', [signal.account_id, signal.code])
        else run('UPDATE position SET qty = ?, updated_at = ? WHERE account_id = ? AND code = ?', [newQty, nowIso(), signal.account_id, signal.code])
      }
    }
    broadcast({ type: 'signal.updated', payload: { signalId: req.signalId, feedback: req.feedback } })
  })

  // 预警
  ipcMain.handle(IPC.alertList, (_e, accountId: string) => queryAll('SELECT * FROM alert WHERE account_id = ? ORDER BY created_at DESC LIMIT 200', [accountId]))
  ipcMain.handle(IPC.alertAcknowledge, (_e, alertId: string) => run("UPDATE alert SET status = 'acknowledged' WHERE id = ?", [alertId]))

  // Agent
  ipcMain.handle(IPC.agentGetWorkItems, (_e, accountId: string) => listWorkItems(accountId))
  ipcMain.handle(IPC.agentRetryWorkItem, (_e, id: string) => retryWorkItem(id))
  ipcMain.handle(IPC.agentCancelWorkItem, (_e, id: string) => cancelWorkItem(id))
  ipcMain.handle(IPC.agentGetPlan, (_e, accountId: string) => queryAll('SELECT * FROM plan WHERE account_id = ? ORDER BY created_at DESC LIMIT 20', [accountId]))
  ipcMain.handle(IPC.agentGetStatus, () => getAgentStatus())
  ipcMain.handle(IPC.agentStart, () => {
    // 开始运行前置校验：必须已配置模型（全局）
    if (!isModelConfigured()) throw new Error('请先配置模型再开始运行')
    setAgentRunning(true)
    broadcast({ type: 'agent.status', payload: { running: true } })
    audit({ accountId: getActiveAccountId() || 'global', actor: 'user', action: 'agent.start' })
    return { running: true }
  })
  ipcMain.handle(IPC.agentStop, () => {
    setAgentRunning(false)
    broadcast({ type: 'agent.status', payload: { running: false } })
    audit({ accountId: getActiveAccountId() || 'global', actor: 'user', action: 'agent.stop' })
    return { running: false }
  })

  // 汇报（待决策中心）
  ipcMain.handle(IPC.reportList, (_e, accountId: string) =>
    queryAll<Record<string, unknown>>('SELECT * FROM report WHERE account_id = ? ORDER BY created_at DESC LIMIT 200', [accountId])
  )
  ipcMain.handle(IPC.reportRespond, (_e, req: ReportRespondReq) => {
    const report = queryAll<{ account_id: string; decision_json: string; status: string; level: string }>('SELECT * FROM report WHERE id = ?', [req.reportId])[0]
    if (!report) throw new Error('汇报不存在')
    const decision = req.decision === 'approved' ? 'approved' : req.decision === 'postponed' ? 'postponed' : 'rejected'
    run('UPDATE report SET status = ?, updated_at = ? WHERE id = ?', [decision, nowIso(), req.reportId])
    audit({ accountId: report.account_id, actor: 'user', action: 'report.respond', target: req.reportId, detail: { decision, note: req.note } })
    // 批准后的动作：激活策略 / 纠正执行
    if (decision === 'approved' && report.decision_json) {
      try {
        const d = JSON.parse(report.decision_json) as { kind?: string; strategyId?: string; alertId?: string }
        if (d.kind === 'activate' && d.strategyId) {
          runnerPipeline.activateStrategy(report.account_id, { strategyId: d.strategyId }).catch((e) => logger.error(`[ipc] activate failed: ${(e as Error).message}`))
        } else if (d.kind === 'correct_pause' && d.strategyId) {
          run("UPDATE strategy SET status = 'paused', updated_at = ? WHERE id = ?", [nowIso(), d.strategyId])
          audit({ accountId: report.account_id, actor: 'user', action: 'correction.paused', target: d.strategyId })
        } else if (d.kind === 'correct_retire' && d.strategyId) {
          runnerPipeline.deactivateStrategy(report.account_id, d.strategyId, '纠正淘汰（人工批准）')
        } else if (d.kind === 'alert') {
          run('UPDATE alert SET status = ? WHERE id = ?', ['acknowledged', String(d.alertId)])
        }
      } catch (e) {
        logger.warn(`[ipc] report decision action failed: ${(e as Error).message}`)
      }
    }
    broadcast({ type: 'agent.report', payload: { reportId: req.reportId, decision } })
  })

  // 绩效
  ipcMain.handle(IPC.perfGetSnapshot, (_e, accountId: string) => {
    const snapshots = queryAll<{ date: string; total_assets: number; cash: number }>(
      'SELECT date, total_assets, cash FROM account_snapshot WHERE account_id = ? ORDER BY date ASC',
      [accountId]
    )
    const metrics = computeSnapshotMetrics(snapshots.map((s) => ({ date: s.date, totalAssets: s.total_assets })))
    return snapshots.map((s) => ({ ...s, date: s.date })).concat([{ metrics }] as never)
  })
  ipcMain.handle(IPC.perfGetCharts, (_e, accountId: string) => {
    const snapshots = queryAll<{ date: string; total_assets: number }>(
      'SELECT date, total_assets FROM account_snapshot WHERE account_id = ? ORDER BY date ASC',
      [accountId]
    )
    const signals = queryAll<{ status: string }>('SELECT status FROM signal WHERE account_id = ?', [accountId])
    const trades = queryAll<Record<string, unknown>>('SELECT * FROM trade_record WHERE account_id = ?', [accountId])
    const deviation = computeSignalDeviation(signals)
    const stats = computeTradeStats(trades as never)
    return {
      equity: snapshots.map((s) => [s.date, s.total_assets]),
      metrics: computeSnapshotMetrics(snapshots.map((s) => ({ date: s.date, totalAssets: s.total_assets }))),
      deviation,
      tradeStats: stats
    }
  })

  // 复盘
  ipcMain.handle(IPC.reviewList, (_e, accountId: string) => queryAll('SELECT * FROM review_report WHERE account_id = ? ORDER BY created_at DESC LIMIT 100', [accountId]))
  ipcMain.handle(IPC.reviewGetReport, (_e, id: string) => queryAll('SELECT * FROM review_report WHERE id = ?', [id])[0])

  // 持仓与成交
  ipcMain.handle(IPC.positionList, (_e, accountId: string) => queryAll('SELECT * FROM position WHERE account_id = ?', [accountId]))
  ipcMain.handle(IPC.positionUpsert, (_e, req: { accountId: string; code: string; qty: number; costPrice: number }) => {
    if (req.qty <= 0) run('DELETE FROM position WHERE account_id = ? AND code = ?', [req.accountId, req.code])
    else
      run(
        'INSERT INTO position (account_id, code, qty, cost_price, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(account_id, code) DO UPDATE SET qty=excluded.qty, cost_price=excluded.cost_price, updated_at=excluded.updated_at',
        [req.accountId, req.code, req.qty, req.costPrice, nowIso()]
      )
  })
  ipcMain.handle(IPC.tradeList, (_e, accountId: string) => queryAll('SELECT * FROM trade_record WHERE account_id = ? ORDER BY traded_at DESC LIMIT 200', [accountId]))
  ipcMain.handle(IPC.tradeCreate, (_e, req: { accountId: string; code: string; side: 'buy' | 'sell'; price: number; qty: number; fee: number; tradedAt: string; note?: string }) => {
    run('INSERT INTO trade_record (id, account_id, code, side, price, qty, fee, traded_at, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [
      randomUUID(),
      req.accountId,
      req.code,
      req.side,
      req.price,
      req.qty,
      req.fee,
      req.tradedAt || nowIso(),
      req.note ?? null
    ])
  })

  // 运行实例
  ipcMain.handle('runs:list', (_e, accountId: string) =>
    queryAll('SELECT ri.*, s.name as strategy_name FROM run_instance ri LEFT JOIN strategy s ON s.id = ri.strategy_id WHERE s.account_id = ?', [accountId])
  )

  // 审计
  ipcMain.handle(IPC.auditList, (_e, accountId: string, limit = 200) =>
    queryAll('SELECT * FROM audit_log WHERE account_id = ? ORDER BY id DESC LIMIT ?', [accountId, limit])
  )
  ipcMain.handle(IPC.eventList, (_e, accountId: string, limit = 200) =>
    queryAll('SELECT * FROM event_log WHERE account_id = ? ORDER BY id DESC LIMIT ?', [accountId, limit])
  )

  // 对话
  ipcMain.handle(IPC.chatSend, (_e, req: { accountId: string; message: string }) => {
    const item = createWorkItem({
      accountId: req.accountId,
      type: 'user_request',
      priority: 'high',
      context: { message: req.message }
    })
    audit({ accountId: req.accountId, actor: 'user', action: 'chat.send', target: item.id, detail: { message: req.message.slice(0, 200) } })
    return { accepted: true, workItemId: item.id }
  })

  logger.info('[ipc] handlers registered')
}

// ---------- 账户快照采集（绩效输入） ----------
export function collectAccountSnapshot(accountId: string): void {
  try {
    const positions = queryAll<{ code: string; qty: number; cost_price: number }>('SELECT code, qty, cost_price FROM position WHERE account_id = ?', [accountId])
    let marketValue = 0
    for (const p of positions) {
      const row = getDb().prepare('SELECT price FROM market_quote WHERE code = ?').get(p.code) as { price: number } | undefined
      marketValue += p.qty * (row?.price ?? p.cost_price)
    }
    const last = queryAll<{ total_assets: number; cash: number }>('SELECT total_assets, cash FROM account_snapshot WHERE account_id = ? ORDER BY date DESC LIMIT 1', [accountId])[0]
    const totalAssets = marketValue + (last?.cash ?? 100_000)
    const today = new Date().toISOString().slice(0, 10)
    run(
      'INSERT INTO account_snapshot (account_id, date, total_assets, cash, positions_json) VALUES (?, ?, ?, ?, ?) ON CONFLICT(account_id, date) DO UPDATE SET total_assets=excluded.total_assets, positions_json=excluded.positions_json',
      [accountId, today, totalAssets, last?.cash ?? 100_000, JSON.stringify(positions)]
    )
  } catch (e) {
    logger.warn(`[snapshot] collect failed: ${(e as Error).message}`)
  }
}

export { dataTaskState, safeStorage }
export type { Report, Signal, Strategy }
