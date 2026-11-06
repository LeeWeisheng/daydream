/**
 * 策略服务（Strategy）：strategy 与 strategy_version 的唯一写者（dsh「one writer per state」）。
 * 规则：
 * - 每账户唯一一份策略 = Markdown 纯文本（交易策略 + 用户偏好 + 风控纪律等全部信息），
 *   是注入 Agent 的系统提示词主体；无 DSL、无偏好 JSON、无审核流；
 * - 每次内容变更产生新 strategy_version（版本号单调递增；Agent 更新必须带标题与一句话变更记录）；
 * - 保存即生效：默认使用最新版本，用户可指定其它版本生效（active_version_id）；
 * - 每个版本记录统计快照（本金/盈亏/盈亏比/胜率），运行决策后刷新生效版本统计。
 */
import type { Strategy, StrategyStats, StrategyVersion, TradeRecord } from '@shared/types'
import { DEFAULT_INITIAL_CASH } from '@shared/constants'
import { computeTradeStats } from '../quant/perf'
import { newId, nowIso, queryAll, queryOne, run, inTransaction } from '../db/connection'
import { audit } from '../services/audit'
import { assertUser, UserError } from '../core/errors'

// ---------- 读取 ----------
function toStrategy(row: Record<string, unknown>): Strategy {
  return {
    id: String(row.id),
    accountId: String(row.account_id),
    title: String(row.title),
    version: Number(row.version),
    markdown: String(row.markdown ?? ''),
    activeVersionId: row.active_version_id ? String(row.active_version_id) : null,
    createdBy: String(row.created_by),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  }
}

function toVersion(row: Record<string, unknown>): StrategyVersion {
  return {
    id: String(row.id),
    strategyId: String(row.strategy_id),
    version: Number(row.version),
    title: String(row.title ?? ''),
    markdown: String(row.markdown ?? ''),
    changeLog: String(row.change_log ?? ''),
    statsJson: String(row.stats_json ?? '{}'),
    createdAt: String(row.created_at)
  }
}

export function getStrategyForAccount(accountId: string): Strategy | undefined {
  const row = queryOne<Record<string, unknown>>('SELECT * FROM strategy WHERE account_id = ?', [accountId])
  return row ? toStrategy(row) : undefined
}

export function getStrategyById(id: string): Strategy | undefined {
  const row = queryOne<Record<string, unknown>>('SELECT * FROM strategy WHERE id = ?', [id])
  return row ? toStrategy(row) : undefined
}

export function listVersions(strategyId: string): StrategyVersion[] {
  return queryAll<Record<string, unknown>>('SELECT * FROM strategy_version WHERE strategy_id = ? ORDER BY version DESC', [strategyId]).map(toVersion)
}

export function latestVersionId(strategyId: string): string | undefined {
  return queryOne<{ id: string }>('SELECT id FROM strategy_version WHERE strategy_id = ? ORDER BY version DESC LIMIT 1', [strategyId])?.id
}

export interface EffectiveVersion {
  versionId: string
  version: number
  title: string
  markdown: string
  stats: StrategyStats
  /** 是否用户指定版本（false = 跟随最新） */
  pinned: boolean
}

/**
 * 当前生效策略版本：
 * - 用户指定版本（active_version_id）优先；
 * - 未指定或指定版本不存在（数据异常/被删除）时回退最新版本。
 */
export function getEffectiveVersion(accountId: string): EffectiveVersion | undefined {
  const strategy = getStrategyForAccount(accountId)
  if (!strategy) return undefined
  const pinned = strategy.activeVersionId
  const pinnedRow = pinned ? queryOne<Record<string, unknown>>('SELECT * FROM strategy_version WHERE strategy_id = ? AND id = ?', [strategy.id, pinned]) : undefined
  const row =
    pinnedRow ?? queryOne<Record<string, unknown>>('SELECT * FROM strategy_version WHERE strategy_id = ? ORDER BY version DESC LIMIT 1', [strategy.id])
  if (!row) return undefined
  const v = toVersion(row)
  return {
    versionId: v.id,
    version: v.version,
    title: v.title || strategy.title,
    markdown: v.markdown,
    stats: parseStats(v.statsJson),
    pinned: Boolean(pinnedRow)
  }
}

// ---------- 版本统计 ----------
/** 空统计（无成交数据时的占位） */
export function emptyStats(): StrategyStats {
  return { principal: DEFAULT_INITIAL_CASH, totalPnl: 0, profitLossRatio: 0, winRate: 0, tradeCount: 0, updatedAt: nowIso() }
}

export function parseStats(statsJson: string): StrategyStats {
  try {
    const parsed = JSON.parse(statsJson) as Partial<StrategyStats>
    return {
      principal: typeof parsed.principal === 'number' ? parsed.principal : DEFAULT_INITIAL_CASH,
      totalPnl: typeof parsed.totalPnl === 'number' ? parsed.totalPnl : 0,
      profitLossRatio: typeof parsed.profitLossRatio === 'number' ? parsed.profitLossRatio : 0,
      winRate: typeof parsed.winRate === 'number' ? parsed.winRate : 0,
      tradeCount: typeof parsed.tradeCount === 'number' ? parsed.tradeCount : 0,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : ''
    }
  } catch {
    return emptyStats()
  }
}

/**
 * 计算账户当前统计：本金（账户初始资金）、累计已实现盈亏、盈亏比、胜率。
 * 盈亏/盈亏比/胜率由成交记录按代码 FIFO 配对计算（与绩效模块同口径）。
 */
export function computeAccountStats(accountId: string): StrategyStats {
  const acc = queryOne<{ config_json: string }>('SELECT config_json FROM account WHERE id = ?', [accountId])
  let principal = DEFAULT_INITIAL_CASH
  try {
    const cfg = JSON.parse(acc?.config_json ?? '{}') as { initialCash?: number }
    if (typeof cfg.initialCash === 'number' && cfg.initialCash > 0) principal = cfg.initialCash
  } catch {
    /* 配置异常用默认本金 */
  }
  const trades = queryAll<TradeRecord>(
    'SELECT id, account_id as accountId, code, side, price, qty, fee, traded_at as tradedAt, signal_id as signalId, note FROM trade_record WHERE account_id = ? ORDER BY traded_at',
    [accountId]
  )
  const stats = computeTradeStats(trades)
  const round = (v: number): number => Math.round(v * 100) / 100
  return {
    principal,
    totalPnl: round(stats.totalPnl),
    profitLossRatio: Number.isFinite(stats.profitLossRatio) ? round(stats.profitLossRatio) : 0,
    winRate: round(stats.winRate),
    tradeCount: stats.tradeCount,
    updatedAt: nowIso()
  }
}

/** 刷新指定版本统计（如运行决策后刷新生效版本） */
export function refreshVersionStats(strategyId: string, versionId: string): void {
  const owned = queryOne<{ id: string; account_id: string }>(
    'SELECT sv.id, s.account_id FROM strategy_version sv JOIN strategy s ON s.id = sv.strategy_id WHERE sv.id = ? AND sv.strategy_id = ?',
    [versionId, strategyId]
  )
  if (!owned) return
  run('UPDATE strategy_version SET stats_json = ? WHERE id = ?', [JSON.stringify(computeAccountStats(owned.account_id)), versionId])
}

// ---------- 写入 ----------
export interface SaveMarkdownOptions {
  accountId: string
  /** 简短标题（Agent 更新时由大模型生成；缺省保留现有标题） */
  title?: string
  markdown: string
  /** 一句话变更记录（Agent 更新必填） */
  changeLog?: string
  createdBy: 'user' | 'agent'
}

/** 保存策略 Markdown：首次创建 / 迭代新版本（版本号单调递增，写入统计快照） */
export function saveStrategyMarkdown(options: SaveMarkdownOptions): Strategy {
  const markdown = options.markdown.trim()
  if (!markdown) throw new UserError('invalid_input', { detail: '策略文档不能为空' })
  const now = nowIso()
  const existing = getStrategyForAccount(options.accountId)
  if (!existing) {
    // 首次创建（正常情况下账户创建时已播种，此处兜底）
    const id = newId()
    const title = options.title?.trim() || '初始策略'
    inTransaction(() => {
      run(
        `INSERT INTO strategy (id, account_id, title, version, markdown, active_version_id, created_by, created_at, updated_at)
         VALUES (?, ?, ?, 1, ?, NULL, ?, ?, ?)`,
        [id, options.accountId, title, markdown, options.createdBy, now, now]
      )
      run(
        `INSERT INTO strategy_version (id, strategy_id, version, title, markdown, change_log, stats_json, created_at)
         VALUES (?, ?, 1, ?, ?, ?, ?, ?)`,
        [newId(), id, title, markdown, options.changeLog?.trim() || '初始版本', JSON.stringify(computeAccountStats(options.accountId)), now]
      )
    })
    audit({ accountId: options.accountId, actor: options.createdBy, action: 'strategy.create', target: id, detail: { title } })
    return getStrategyById(id)!
  }
  // 迭代：新版本留档；保存即生效（清除用户指定的历史版本 pin，新版本立即成为生效版本）
  const newVersion = existing.version + 1
  const title = options.title?.trim() || existing.title
  const changeLog = options.changeLog?.trim() || (options.createdBy === 'agent' ? 'Agent 迭代策略' : '用户修改策略')
  inTransaction(() => {
    run('UPDATE strategy SET title = ?, markdown = ?, version = ?, active_version_id = NULL, updated_at = ? WHERE id = ?', [title, markdown, newVersion, now, existing.id])
    run(
      `INSERT INTO strategy_version (id, strategy_id, version, title, markdown, change_log, stats_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [newId(), existing.id, newVersion, title, markdown, changeLog, JSON.stringify(computeAccountStats(options.accountId)), now]
    )
  })
  audit({ accountId: options.accountId, actor: options.createdBy, action: 'strategy.update', target: existing.id, detail: { version: newVersion, changeLog } })
  return getStrategyById(existing.id)!
}

/** 设置生效版本：versionId 为空 = 恢复默认（使用最新版本）。仅用户可指定。 */
export function setActiveVersion(accountId: string, versionId: string | null): Strategy {
  const strategy = getStrategyForAccount(accountId)
  assertUser(strategy, 'missing_strategy', { accountId })
  if (versionId) {
    const owned = queryOne<{ id: string }>('SELECT id FROM strategy_version WHERE id = ? AND strategy_id = ?', [versionId, strategy.id])
    assertUser(owned, 'missing_strategy_version', { versionId })
  }
  run('UPDATE strategy SET active_version_id = ?, updated_at = ? WHERE id = ?', [versionId, nowIso(), strategy.id])
  audit({ accountId, actor: 'user', action: versionId ? 'strategy.version.pinned' : 'strategy.version.latest', target: strategy.id, detail: { versionId } })
  return getStrategyById(strategy.id)!
}
