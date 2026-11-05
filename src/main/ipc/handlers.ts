/**
 * IPC Handler：白名单通道注册（`域:动作` 命名）。
 * 事件推送统一走 `daydream:event` 通道；密钥类配置不回传明文。
 * 本次重构：每账户唯一策略（DSL+偏好）、交易资金联动、对话流、主题、窗口控制、数据 CRUD。
 */
import { ipcMain, BrowserWindow, safeStorage } from 'electron'
import { randomUUID } from 'node:crypto'
import { IPC, type SettingsPatch, type SignalFeedbackReq, type ReportRespondReq, type StrategySaveReq, type TradeOrderReq, type StockUpsertReq, type KlineUpsertReq } from '@shared/ipc'
import type { Account, AccountSummary, ModelConfig, Report, Signal, Strategy, StrategyVersion } from '@shared/types'
import { ensureAccount, firstAccount, createAccount as dbCreateAccount, getDb, nowIso, queryAll, run, inTransaction } from '../db'
import { audit } from '../services/audit'
import { encryptString, decryptString } from '../services/crypto'
import { logger } from '../services/logger'
import * as dataService from '../data/service'
import { initialSync, dailyUpdate, dataTaskState } from '../data/pipeline'
import { providerManager } from '../data/providers/base'
import { EastmoneyProvider } from '../data/providers/eastmoney'
import { TencentProvider } from '../data/providers/tencent'
import * as runnerPipeline from '../pipeline/runner'
import { extractDslFromMarkdown, validatePreferences } from '@shared/strategy/schema'
import { calcFee, DEFAULT_INITIAL_CASH, MODEL_PRESETS } from '@shared/constants'
import { agentEventBus, subscribeAgentEvents } from '../agent/events'
import { createWorkItem, listWorkItems } from '../agent/workitem'
import { getAgentStatus, retryWorkItem, cancelWorkItem, setAgentRunning, isAgentRunning } from '../agent/loop'
import { isModelConfigured } from '../agent/llm'
import { getModelConfig, saveModelConfig, GLOBAL_CONFIG_ACCOUNT } from '../agent/modelConfig'
import { getTheme, setTheme as persistTheme } from '../theme'
import { addChatMessage, listChatMessages, formatReportContent } from '../chat'
import { getRunMode, setRunMode as persistRunMode } from '../runMode'
import { applyReportDecision } from '../reportDecision'

/** 活跃账户（Agent/调度器运行的资金视角；header 账户下拉切换时更新） */
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
      'chat.message': 'chat.message',
      'workitem.completed': 'workitem.updated',
      'workitem.failed': 'workitem.updated',
      'backtest.completed': 'strategy.updated',
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

// ---------- 策略（每账户唯一一份，Markdown 主载体 + 内嵌 ```dsl 块同步执行层） ----------
function toStrategy(row: Record<string, unknown>): Strategy {
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

function getAccountStrategy(accountId: string): Strategy | undefined {
  const row = queryAll<Record<string, unknown>>('SELECT * FROM strategy WHERE account_id = ?', [accountId])[0]
  return row ? toStrategy(row) : undefined
}

function saveStrategy(req: StrategySaveReq): Strategy {
  const existing = getAccountStrategy(req.accountId)
  if (!existing) throw new Error('策略不存在')
  const now = nowIso()

  // Markdown 变更（唯一载体）：提取 ```dsl 块同步执行层，新版本留档
  let markdown = existing.markdown
  let dslJson = existing.dslJson
  if (req.markdown !== undefined && req.markdown !== existing.markdown) {
    const extracted = extractDslFromMarkdown(req.markdown)
    if (extracted.errors.length > 0) throw new Error(`策略 Markdown 校验失败: ${extracted.errors.join('; ')}`)
    markdown = req.markdown
    // 无 dsl 块 → 文档态（清空执行层，自动运行跳过）；有块 → 同步 dsl_json
    dslJson = extracted.dsl ? JSON.stringify(extracted.dsl, null, 2) : ''
  }
  // 偏好变更：仅用户可改（Agent 只读）
  let preferencesJson = existing.preferencesJson
  if (req.preferencesJson !== undefined) {
    if (req.actor !== 'user') throw new Error('用户偏好仅用户可修改')
    const errors = validatePreferences(JSON.parse(req.preferencesJson))
    if (errors.length > 0) throw new Error(`用户偏好校验失败: ${errors.join('; ')}`)
    preferencesJson = req.preferencesJson
  }
  const name = req.name?.trim() || existing.name
  const dslChanged = dslJson !== existing.dslJson
  const contentChanged = dslChanged || markdown !== existing.markdown
  const newVersion = contentChanged ? existing.version + 1 : existing.version

  inTransaction(() => {
    run('UPDATE strategy SET name = ?, markdown = ?, dsl_json = ?, preferences_json = ?, version = ?, updated_at = ? WHERE id = ?', [
      name,
      markdown,
      dslJson,
      preferencesJson,
      newVersion,
      now,
      existing.id
    ])
    if (contentChanged) {
      run('INSERT INTO strategy_version (id, strategy_id, version, markdown, dsl_json, change_log, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
        randomUUID(),
        existing.id,
        newVersion,
        markdown,
        dslJson,
        req.changeLog || `${req.actor === 'agent' ? 'Agent 迭代' : '用户修改'}`,
        now
      ])
    }
  })
  // 偏好中的自主级别同步到账户列（兼容保留字段）
  try {
    const prefs = JSON.parse(preferencesJson) as { autonomyLevel?: string }
    if (prefs.autonomyLevel) run('UPDATE account SET autonomy_level = ? WHERE id = ?', [prefs.autonomyLevel, req.accountId])
  } catch {
    /* 忽略 */
  }
  audit({ accountId: req.accountId, actor: req.actor, action: 'strategy.save', target: existing.id, detail: { contentChanged, version: newVersion } })
  agentEventBus.emitAgentEvent('strategy.updated', req.accountId, { strategyId: existing.id, dslChanged }, { debounceMs: 0 })
  return getAccountStrategy(req.accountId)!
}

// ---------- 交易与资金 ----------
/** 买入/卖出联动：现金、持仓、成交记录在同一事务内完成 */
export function executeTradeOrder(req: TradeOrderReq): void {
  const account = ensureAccount(req.accountId)
  if (!account) throw new Error('账户不存在')
  const qty = Math.max(1, Math.floor(req.qty))
  const price = req.price
  const amount = Math.round(price * qty * 100) / 100
  const fee = req.fee !== undefined ? req.fee : calcFee(req.side, amount)

  inTransaction(() => {
    const acc = queryAll<{ cash: number }>('SELECT cash FROM account WHERE id = ?', [req.accountId])[0]
    if (!acc) throw new Error('账户不存在')
    let cash = acc.cash
    if (req.side === 'buy') {
      if (cash < amount + fee) throw new Error(`可用资金不足：需要 ${(amount + fee).toFixed(2)}，可用 ${cash.toFixed(2)}`)
      cash = Math.round((cash - amount - fee) * 100) / 100
    } else {
      const pos = queryAll<{ qty: number }>('SELECT qty FROM position WHERE account_id = ? AND code = ?', [req.accountId, req.code])[0]
      if (!pos || pos.qty < qty) throw new Error(`持仓不足：当前持有 ${pos?.qty ?? 0}，卖出 ${qty}`)
      cash = Math.round((cash + amount - fee) * 100) / 100
    }
    run('UPDATE account SET cash = ?, updated_at = ? WHERE id = ?', [cash, nowIso(), req.accountId])

    // 持仓联动
    const pos = queryAll<{ qty: number; cost_price: number }>('SELECT qty, cost_price FROM position WHERE account_id = ? AND code = ?', [
      req.accountId,
      req.code
    ])[0]
    if (req.side === 'buy') {
      const newQty = (pos?.qty ?? 0) + qty
      const newCost = pos ? (pos.cost_price * pos.qty + amount + fee) / newQty : (amount + fee) / newQty
      run(
        'INSERT INTO position (account_id, code, qty, cost_price, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(account_id, code) DO UPDATE SET qty=excluded.qty, cost_price=excluded.cost_price, updated_at=excluded.updated_at',
        [req.accountId, req.code, newQty, Math.round(newCost * 10000) / 10000, nowIso()]
      )
    } else {
      const newQty = (pos?.qty ?? 0) - qty
      if (newQty <= 0) run('DELETE FROM position WHERE account_id = ? AND code = ?', [req.accountId, req.code])
      else run('UPDATE position SET qty = ?, updated_at = ? WHERE account_id = ? AND code = ?', [newQty, nowIso(), req.accountId, req.code])
    }

    run('INSERT INTO trade_record (id, account_id, code, side, price, qty, fee, traded_at, signal_id, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [
      randomUUID(),
      req.accountId,
      req.code,
      req.side,
      price,
      qty,
      fee,
      req.tradedAt || nowIso(),
      req.signalId ?? null,
      req.note ?? null
    ])
  })
  audit({ accountId: req.accountId, actor: 'user', action: `trade.${req.side}`, target: req.code, detail: { price, qty, fee } })
}

function buildAccountSummary(accountId: string): AccountSummary {
  const acc = queryAll<{ cash: number; config_json: string }>('SELECT cash, config_json FROM account WHERE id = ?', [accountId])[0]
  const cash = acc?.cash ?? DEFAULT_INITIAL_CASH
  let initialCash = DEFAULT_INITIAL_CASH
  try {
    const cfg = JSON.parse(acc?.config_json ?? '{}') as { initialCash?: number }
    if (cfg.initialCash) initialCash = cfg.initialCash
  } catch {
    /* 忽略 */
  }
  const positions = queryAll<{ code: string; qty: number; cost_price: number }>(
    'SELECT code, qty, cost_price FROM position WHERE account_id = ?',
    [accountId]
  )
  let marketValue = 0
  let positionPnl = 0
  const details = positions.map((p) => {
    const quote = queryAll<{ price: number }>('SELECT price FROM market_quote WHERE code = ?', [p.code])[0]
    const nameRow = queryAll<{ name: string }>('SELECT name FROM stock_basic WHERE code = ?', [p.code])[0]
    const price = quote?.price ?? p.cost_price
    const mv = Math.round(p.qty * price * 100) / 100
    const pnl = Math.round((price - p.cost_price) * p.qty * 100) / 100
    marketValue += mv
    positionPnl += pnl
    return {
      code: p.code,
      name: nameRow?.name ?? p.code,
      qty: p.qty,
      costPrice: p.cost_price,
      price,
      marketValue: mv,
      pnl,
      pnlPct: p.cost_price > 0 ? Math.round(((price - p.cost_price) / p.cost_price) * 10000) / 100 : 0,
      positionPct: 0
    }
  })
  const totalAssets = Math.round((cash + marketValue) * 100) / 100
  for (const d of details) d.positionPct = totalAssets > 0 ? Math.round((d.marketValue / totalAssets) * 10000) / 100 : 0
  const snapshots = queryAll<{ date: string; total_assets: number }>(
    'SELECT date, total_assets FROM account_snapshot WHERE account_id = ? ORDER BY date ASC',
    [accountId]
  )
  const prev = snapshots[snapshots.length - 2]
  return {
    accountId,
    cash,
    initialCash,
    marketValue: Math.round(marketValue * 100) / 100,
    totalAssets,
    positionPnl: Math.round(positionPnl * 100) / 100,
    totalPnl: Math.round((totalAssets - initialCash) * 100) / 100,
    todayPnl: prev ? Math.round((totalAssets - prev.total_assets) * 100) / 100 : 0,
    positionPct: totalAssets > 0 ? Math.round((marketValue / totalAssets) * 10000) / 100 : 0,
    positionCount: positions.length,
    positions: details,
    equityCurve: snapshots.map((s) => ({ date: s.date, totalAssets: s.total_assets }))
  }
}

// ---------- 设置（模型配置全局通用） ----------
function getSettings(_accountId: string): {
  modelConfig?: ModelConfig
  presets: typeof MODEL_PRESETS
  theme: ReturnType<typeof getTheme>
  modelConfigured: boolean
  monitorIntervalMinutes?: number
  dataSourcePreference?: string
} {
  const cfg = getModelConfig()
  const modelConfig: ModelConfig | undefined = cfg ? { ...cfg, apiKey: cfg.apiKey ? '********' : '' } : undefined // 密钥不回传明文
  return {
    modelConfig,
    presets: MODEL_PRESETS,
    theme: getTheme(),
    modelConfigured: isModelConfigured(),
    monitorIntervalMinutes: 2
  }
}

function updateSettings(_accountId: string, patch: SettingsPatch): void {
  void _accountId
  if (patch.modelConfig) {
    // 模型配置全局通用（所有账户共用）
    saveModelConfig(patch.modelConfig, encryptString, nowIso, (sql, params) => run(sql, params))
    audit({ accountId: GLOBAL_CONFIG_ACCOUNT, actor: 'user', action: 'settings.model_config.updated' })
  }
  if (patch.monitorIntervalMinutes || patch.dataSourcePreference || patch.initYears) {
    run(
      `INSERT INTO app_config (account_id, scope, key, value_encrypted, updated_at) VALUES ('global', 'global', 'data_prefs', ?, ?)
       ON CONFLICT(account_id, key) DO UPDATE SET value_encrypted = excluded.value_encrypted, updated_at = excluded.updated_at`,
      [
        JSON.stringify({ monitorIntervalMinutes: patch.monitorIntervalMinutes, dataSourcePreference: patch.dataSourcePreference, initYears: patch.initYears }),
        nowIso()
      ]
    )
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
    // 切换账户不中断 Agent 运行：仅更新资金视角（运行开关是全局状态）
    activeAccountId = req.accountId
    return toAccount(row)
  })
  ipcMain.handle(IPC.accountRename, (_e, req: { accountId: string; name: string }) => {
    if (!req.name?.trim()) throw new Error('账户名称不能为空')
    run('UPDATE account SET name = ?, updated_at = ? WHERE id = ?', [req.name.trim(), nowIso(), req.accountId])
    audit({ accountId: req.accountId, actor: 'user', action: 'account.rename', detail: { name: req.name.trim() } })
    return toAccount(queryAll<Record<string, unknown>>('SELECT * FROM account WHERE id = ?', [req.accountId])[0])
  })
  ipcMain.handle(IPC.accountDelete, (_e, accountId: string) => {
    run('DELETE FROM account WHERE id = ?', [accountId])
    audit({ accountId, actor: 'user', action: 'account.delete', target: accountId })
    if (activeAccountId === accountId) activeAccountId = firstAccount()?.id ?? ''
  })

  // 设置
  ipcMain.handle(IPC.settingsGet, (_e, accountId: string) => getSettings(accountId))
  ipcMain.handle(IPC.settingsUpdate, (_e, _accountId: string, patch: SettingsPatch) => updateSettings(_accountId, patch))

  // 主题
  ipcMain.handle(IPC.themeGet, () => getTheme())
  ipcMain.handle(IPC.themeSet, (_e, mode: 'light' | 'dark' | 'system') => {
    const next = persistTheme(mode)
    broadcast({ type: 'agent.status', payload: { theme: next } })
    return next
  })

  // 运行模式（manual 手动 / auto 自动：自动处理审批与信号，用于策略验证）
  ipcMain.handle(IPC.runModeGet, () => getRunMode())
  ipcMain.handle(IPC.runModeSet, (_e, mode: 'manual' | 'auto') => {
    const next = persistRunMode(mode)
    audit({ accountId: getActiveAccountId() || 'global', actor: 'user', action: 'run_mode.set', detail: { mode: next } })
    broadcast({ type: 'runMode.changed', payload: { runMode: next } })
    return next
  })

  // 窗口控制（自绘标题栏）
  ipcMain.handle(IPC.windowMinimize, (e) => BrowserWindow.fromWebContents(e.sender)?.minimize())
  ipcMain.handle(IPC.windowToggleMaximize, (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return false
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
    return win.isMaximized()
  })
  ipcMain.handle(IPC.windowClose, (e) => BrowserWindow.fromWebContents(e.sender)?.close())
  ipcMain.handle(IPC.windowIsMaximized, (e) => BrowserWindow.fromWebContents(e.sender)?.isMaximized() ?? false)
  ipcMain.handle(IPC.windowIsFullScreen, (e) => BrowserWindow.fromWebContents(e.sender)?.isFullScreen() ?? false)

  // 数据
  ipcMain.handle(IPC.dataGetStockList, () => dataService.getStockList())
  ipcMain.handle(IPC.dataGetQuote, (_e, codes: string[]) => dataService.getQuotes(codes))
  ipcMain.handle(IPC.dataGetKline, (_e, req: { code: string; start: string; end: string }) => dataService.getDailyKline(req.code, req.start, req.end))
  ipcMain.handle(IPC.dataGetIndexDaily, (_e, req: { code: string; start: string; end: string }) => dataService.getIndexDaily(req.code, req.start, req.end))
  ipcMain.handle(IPC.dataGetDataStatus, () => dataService.getDataStatus())
  ipcMain.handle(IPC.dataGetDataStats, () => dataService.getDataStats())
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
  // 数据 CRUD（Agent 运行时同样可用）
  ipcMain.handle(IPC.dataUpsertStock, (_e, req: StockUpsertReq) => {
    if (!req.code || !req.name) throw new Error('代码与名称不能为空')
    run(
      `INSERT INTO stock_basic (code, name, exchange, industry, status, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(code) DO UPDATE SET name=excluded.name, exchange=excluded.exchange, industry=excluded.industry, status=excluded.status, updated_at=excluded.updated_at`,
      [req.code, req.name, req.exchange ?? 'SH', req.industry ?? null, req.status ?? 'listed', nowIso()]
    )
    audit({ accountId: getActiveAccountId() || 'global', actor: 'user', action: 'data.stock.upsert', target: req.code })
  })
  ipcMain.handle(IPC.dataDeleteStock, (_e, code: string) => {
    inTransaction(() => {
      run('DELETE FROM kline_daily WHERE code = ?', [code])
      run('DELETE FROM market_quote WHERE code = ?', [code])
      run('DELETE FROM data_status WHERE code = ?', [code])
      run('DELETE FROM stock_basic WHERE code = ?', [code])
    })
    audit({ accountId: getActiveAccountId() || 'global', actor: 'user', action: 'data.stock.delete', target: code })
  })
  ipcMain.handle(IPC.dataUpsertKline, (_e, req: KlineUpsertReq) => {
    if (!req.code || !req.date) throw new Error('代码与日期不能为空')
    if (!(req.high >= req.low && req.high >= req.open && req.low <= req.close)) throw new Error('OHLC 数据非法（最高价必须 ≥ 最低价）')
    run(
      `INSERT INTO kline_daily (code, date, open, high, low, close, volume, amount, adj_factor) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(code, date) DO UPDATE SET open=excluded.open, high=excluded.high, low=excluded.low, close=excluded.close, volume=excluded.volume, amount=excluded.amount, adj_factor=excluded.adj_factor`,
      [req.code, req.date, req.open, req.high, req.low, req.close, req.volume, req.amount, req.adjFactor ?? 1]
    )
    run(
      `INSERT INTO data_status (code, last_update_date, integrity_level, updated_at) VALUES (?, ?, 1, ?)
       ON CONFLICT(code) DO UPDATE SET last_update_date=excluded.last_update_date, updated_at=excluded.updated_at`,
      [req.code, req.date, nowIso()]
    )
  })
  ipcMain.handle(IPC.dataDeleteKline, (_e, req: { code: string; date: string }) => {
    run('DELETE FROM kline_daily WHERE code = ? AND date = ?', [req.code, req.date])
  })

  // 策略（每账户唯一一份）
  ipcMain.handle(IPC.strategyGetForAccount, (_e, accountId: string) => getAccountStrategy(accountId) ?? null)
  ipcMain.handle(IPC.strategySave, (_e, req: StrategySaveReq) => saveStrategy(req))
  ipcMain.handle(IPC.strategyGetVersions, (_e, strategyId: string) =>
    queryAll<Record<string, unknown>>('SELECT * FROM strategy_version WHERE strategy_id = ? ORDER BY version DESC', [strategyId]).map(
      (r): StrategyVersion => ({
        id: String(r.id),
        strategyId: String(r.strategy_id),
        version: Number(r.version),
        markdown: String(r.markdown ?? ''),
        dslJson: String(r.dsl_json),
        changeLog: String(r.change_log),
        createdAt: String(r.created_at)
      })
    )
  )
  ipcMain.handle(IPC.strategyRollback, (_e, req: { accountId: string; versionId: string }) => {
    const v = queryAll<{ strategy_id: string; version: number; dsl_json: string; markdown: string }>('SELECT * FROM strategy_version WHERE id = ?', [req.versionId])[0]
    if (!v) throw new Error('版本不存在')
    run('UPDATE strategy SET markdown = ?, dsl_json = ?, version = ?, updated_at = ? WHERE id = ? AND account_id = ?', [
      v.markdown ?? '',
      v.dsl_json,
      v.version,
      nowIso(),
      v.strategy_id,
      req.accountId
    ])
    audit({ accountId: req.accountId, actor: 'user', action: 'strategy.rollback', target: v.strategy_id, detail: { toVersion: v.version } })
    return getAccountStrategy(req.accountId)
  })
  ipcMain.handle(IPC.strategyActivate, async (_e, req: { accountId: string }) => {
    const s = getAccountStrategy(req.accountId)
    if (!s) throw new Error('策略不存在')
    await runnerPipeline.activateStrategy(req.accountId, { strategyId: s.id })
  })
  ipcMain.handle(IPC.strategyDeactivate, (_e, req: { accountId: string; reason?: string }) => {
    const s = getAccountStrategy(req.accountId)
    if (!s) throw new Error('策略不存在')
    return runnerPipeline.deactivateStrategy(req.accountId, s.id, req.reason ?? '')
  })
  ipcMain.handle(IPC.strategyGetLatestBacktest, (_e, accountId: string) => {
    const s = getAccountStrategy(accountId)
    if (!s) return null
    const row = queryAll<Record<string, unknown>>(
      `SELECT br.* FROM backtest_run br
       JOIN strategy_version sv ON sv.id = br.strategy_version_id
       WHERE sv.strategy_id = ? ORDER BY br.created_at DESC LIMIT 1`,
      [s.id]
    )[0]
    return row ?? null
  })

  // 交易（人工录入，联动资金与持仓）
  ipcMain.handle(IPC.tradeOrder, (_e, req: TradeOrderReq) => {
    executeTradeOrder(req)
    broadcast({ type: 'signal.updated', payload: { accountId: req.accountId, kind: 'trade', code: req.code } })
    collectAccountSnapshot(req.accountId)
  })
  ipcMain.handle(IPC.tradeList, (_e, accountId: string) =>
    queryAll('SELECT * FROM trade_record WHERE account_id = ? ORDER BY traded_at DESC LIMIT 500', [accountId])
  )
  ipcMain.handle(IPC.tradeAccountSummary, (_e, accountId: string) => buildAccountSummary(accountId))
  ipcMain.handle(IPC.tradeSetInitialCash, (_e, req: { accountId: string; cash: number }) => {
    if (!(req.cash > 0)) throw new Error('初始资金必须为正数')
    const acc = queryAll<{ config_json: string }>('SELECT config_json FROM account WHERE id = ?', [req.accountId])[0]
    if (!acc) throw new Error('账户不存在')
    let cfg: Record<string, unknown> = {}
    try {
      cfg = JSON.parse(acc.config_json) as Record<string, unknown>
    } catch {
      /* 忽略 */
    }
    cfg.initialCash = req.cash
    run('UPDATE account SET config_json = ?, updated_at = ? WHERE id = ?', [JSON.stringify(cfg), nowIso(), req.accountId])
    audit({ accountId: req.accountId, actor: 'user', action: 'account.initial_cash.set', detail: { cash: req.cash } })
  })

  // 信号
  ipcMain.handle(IPC.signalList, (_e, accountId: string, limit = 100) =>
    queryAll<Record<string, unknown>>('SELECT * FROM signal WHERE account_id = ? ORDER BY created_at DESC LIMIT ?', [accountId, limit])
  )
  ipcMain.handle(IPC.signalFeedback, (_e, req: SignalFeedbackReq) => {
    const signal = queryAll<{ account_id: string; code: string; side: string; qty: number; ref_price: number }>('SELECT * FROM signal WHERE id = ?', [
      req.signalId
    ])[0]
    if (!signal) throw new Error('信号不存在')
    run('UPDATE signal SET status = ?, updated_at = ? WHERE id = ?', [req.feedback, nowIso(), req.signalId])
    if (req.feedback === 'executed') {
      // 已执行 → 走资金/持仓/成交记录联动
      executeTradeOrder({
        accountId: signal.account_id,
        code: signal.code,
        side: signal.side as 'buy' | 'sell',
        price: req.tradedPrice ?? signal.ref_price,
        qty: req.tradedQty ?? signal.qty,
        fee: req.fee,
        signalId: req.signalId
      })
      collectAccountSnapshot(signal.account_id)
    }
    broadcast({ type: 'signal.updated', payload: { signalId: req.signalId, feedback: req.feedback } })
  })

  // 持仓
  ipcMain.handle(IPC.positionList, (_e, accountId: string) => queryAll('SELECT * FROM position WHERE account_id = ?', [accountId]))
  ipcMain.handle(IPC.positionUpsert, (_e, req: { accountId: string; code: string; qty: number; costPrice: number }) => {
    if (req.qty <= 0) run('DELETE FROM position WHERE account_id = ? AND code = ?', [req.accountId, req.code])
    else
      run(
        'INSERT INTO position (account_id, code, qty, cost_price, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(account_id, code) DO UPDATE SET qty=excluded.qty, cost_price=excluded.cost_price, updated_at=excluded.updated_at',
        [req.accountId, req.code, req.qty, req.costPrice, nowIso()]
      )
    audit({ accountId: req.accountId, actor: 'user', action: 'position.upsert', target: req.code, detail: { qty: req.qty, costPrice: req.costPrice } })
    collectAccountSnapshot(req.accountId)
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

  // 汇报（待决策，首页右列）
  ipcMain.handle(IPC.reportList, (_e, accountId: string) =>
    queryAll<Record<string, unknown>>('SELECT * FROM report WHERE account_id = ? ORDER BY created_at DESC LIMIT 200', [accountId])
  )
  ipcMain.handle(IPC.reportRespond, (_e, req: ReportRespondReq) => {
    const report = queryAll<{ account_id: string; decision_json: string; status: string; level: string }>('SELECT * FROM report WHERE id = ?', [req.reportId])[0]
    if (!report) throw new Error('汇报不存在')
    const decision = req.decision === 'approved' ? 'approved' : req.decision === 'postponed' ? 'postponed' : 'rejected'
    applyReportDecision({ reportId: req.reportId, accountId: report.account_id, decisionJson: report.decision_json, decision, actor: 'user', note: req.note })
    broadcast({ type: 'agent.report', payload: { reportId: req.reportId, decision } })
  })

  // 对话流
  ipcMain.handle(IPC.chatSend, (_e, req: { accountId: string; message: string }) => {
    const message = req.message?.trim()
    if (!message) throw new Error('消息不能为空')
    // 用户消息写入对话流
    addChatMessage({ accountId: req.accountId, role: 'user', content: message })
    // 停止运行：不创建请求、不发起任何模型请求，仅在对话流说明
    if (!isAgentRunning()) {
      addChatMessage({
        accountId: req.accountId,
        role: 'assistant',
        kind: 'error',
        content: 'Agent 已停止运行，本次消息未处理（未发起任何模型请求）。如需继续，请先点击「开始运行」。'
      })
      audit({ accountId: req.accountId, actor: 'user', action: 'chat.rejected', detail: { reason: 'agent_not_running' } })
      return { accepted: false, reason: 'agent_not_running' }
    }
    const item = createWorkItem({
      accountId: req.accountId,
      type: 'user_request',
      priority: 'high',
      context: { message }
    })
    audit({ accountId: req.accountId, actor: 'user', action: 'chat.send', target: item.id, detail: { message: message.slice(0, 200) } })
    return { accepted: true, workItemId: item.id }
  })
  ipcMain.handle(IPC.chatList, (_e, req: { accountId: string; limit?: number; before?: { createdAt: string; rowid: number }; after?: { createdAt: string; rowid: number } }) =>
    listChatMessages(req.accountId, { limit: req.limit ?? 100, before: req.before, after: req.after })
  )

  // 事件流水（规划页）
  ipcMain.handle(IPC.eventList, (_e, accountId: string, limit = 200) =>
    queryAll('SELECT id, type, payload_json as payloadJson, occurred_at as occurredAt FROM event_log WHERE account_id = ? ORDER BY id DESC LIMIT ?', [
      accountId,
      limit
    ])
  )

  logger.info('[ipc] handlers registered')
}

// ---------- 账户快照采集（资金统计输入） ----------
export function collectAccountSnapshot(accountId: string): void {
  try {
    const summary = buildAccountSummary(accountId)
    const today = new Date().toISOString().slice(0, 10)
    run(
      'INSERT INTO account_snapshot (account_id, date, total_assets, cash, positions_json) VALUES (?, ?, ?, ?, ?) ON CONFLICT(account_id, date) DO UPDATE SET total_assets=excluded.total_assets, cash=excluded.cash, positions_json=excluded.positions_json',
      [accountId, today, summary.totalAssets, summary.cash, JSON.stringify(summary.positions)]
    )
  } catch (e) {
    logger.warn(`[snapshot] collect failed: ${(e as Error).message}`)
  }
}

export { dataTaskState, safeStorage, formatReportContent }
export type { Report, Signal, Strategy }
