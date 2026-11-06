/**
 * 策略服务（Strategy）：strategy 与 strategy_version 的唯一写者（dsh「one writer per state」）。
 * 规则（docs《系统规则与账户模型》/《数据模型与模块设计》§3）：
 * - 每账户唯一一份策略（= 交易策略 DSL + 用户偏好）；Markdown 为主载体，
 *   ```dsl 代码块同步执行层（extractDslFromMarkdown）；
 * - 每次内容变更产生新 strategy_version（留档可回滚）；偏好修改不产生版本；
 * - 用户偏好仅用户可改（Agent 只读）；生命周期：draft → backtesting → pending_approval → active
 *   （paused ↔ active；deactivated 终态）。
 */
import type { Strategy, StrategyPreferences, StrategyVersion } from '@shared/types'
import { extractDslFromMarkdown, validatePreferences } from '@shared/strategy/schema'
import { DEFAULT_PREFERENCES } from '@shared/constants'
import { newId, nowIso, queryAll, queryOne, run, inTransaction } from '../db/connection'
import { audit } from '../services/audit'
import { assertUser, UserError } from '../core/errors'

// ---------- 读取 ----------
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

export function getStrategyForAccount(accountId: string): Strategy | undefined {
  const row = queryOne<Record<string, unknown>>('SELECT * FROM strategy WHERE account_id = ?', [accountId])
  return row ? toStrategy(row) : undefined
}

export function getStrategyById(id: string): Strategy | undefined {
  const row = queryOne<Record<string, unknown>>('SELECT * FROM strategy WHERE id = ?', [id])
  return row ? toStrategy(row) : undefined
}

export function getStrategyPreferences(accountId: string): StrategyPreferences | null {
  const strategy = getStrategyForAccount(accountId)
  if (!strategy) return null
  try {
    return JSON.parse(strategy.preferencesJson) as StrategyPreferences
  } catch {
    return null
  }
}

export function latestVersionId(strategyId: string): string | undefined {
  return queryOne<{ id: string }>('SELECT id FROM strategy_version WHERE strategy_id = ? ORDER BY version DESC LIMIT 1', [strategyId])?.id
}

export function listVersions(strategyId: string): StrategyVersion[] {
  return queryAll<Record<string, unknown>>('SELECT * FROM strategy_version WHERE strategy_id = ? ORDER BY version DESC', [strategyId]).map((r) => ({
    id: String(r.id),
    strategyId: String(r.strategy_id),
    version: Number(r.version),
    markdown: String(r.markdown ?? ''),
    dslJson: String(r.dsl_json),
    changeLog: String(r.change_log),
    createdAt: String(r.created_at)
  }))
}

// ---------- 写入 ----------
export interface SaveMarkdownOptions {
  accountId: string
  name?: string
  markdown: string
  rationale?: string
  createdBy: 'user' | 'agent'
  changeLog?: string
}

/** 保存策略 Markdown（首次创建 / 迭代新版本；```dsl 块自动同步执行层；不改用户偏好） */
export function saveStrategyMarkdown(options: SaveMarkdownOptions): Strategy {
  const extracted = extractDslFromMarkdown(options.markdown)
  if (extracted.errors.length > 0) throw new UserError('invalid_dsl', { detail: extracted.errors.join('; ') })
  const dslJson = extracted.dsl ? JSON.stringify(extracted.dsl, null, 2) : ''
  const now = nowIso()
  const existing = getStrategyForAccount(options.accountId)
  if (!existing) {
    // 首次创建：账户唯一策略（默认偏好，后续仅用户可改）
    const id = newId()
    inTransaction(() => {
      run(
        `INSERT INTO strategy (id, account_id, name, version, dsl_json, markdown, preferences_json, status, created_by, rationale, created_at, updated_at)
         VALUES (?, ?, ?, 1, ?, ?, ?, 'draft', ?, ?, ?, ?)`,
        [id, options.accountId, options.name?.trim() || '策略', dslJson, options.markdown, JSON.stringify(DEFAULT_PREFERENCES), options.createdBy, options.rationale ?? '', now, now]
      )
      run('INSERT INTO strategy_version (id, strategy_id, version, dsl_json, markdown, change_log, created_at) VALUES (?, ?, 1, ?, ?, ?, ?)', [
        newId(),
        id,
        dslJson,
        options.markdown,
        '初始版本',
        now
      ])
    })
    audit({ accountId: options.accountId, actor: options.createdBy, action: 'strategy.create', target: id, detail: { name: options.name } })
    return getStrategyById(id)!
  }
  // 迭代：新版本留档
  const newVersion = existing.version + 1
  inTransaction(() => {
    run('UPDATE strategy SET dsl_json = ?, markdown = ?, version = ?, name = ?, rationale = ?, updated_at = ? WHERE id = ?', [
      dslJson,
      options.markdown,
      newVersion,
      options.name?.trim() || existing.name,
      options.rationale ?? existing.rationale,
      now,
      existing.id
    ])
    run('INSERT INTO strategy_version (id, strategy_id, version, dsl_json, markdown, change_log, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
      newId(),
      existing.id,
      newVersion,
      dslJson,
      options.markdown,
      options.changeLog ?? `${options.createdBy === 'agent' ? 'Agent 迭代' : '用户修改'}`,
      now
    ])
  })
  audit({ accountId: options.accountId, actor: options.createdBy, action: 'strategy.update', target: existing.id, detail: { version: newVersion } })
  return getStrategyById(existing.id)!
}

/** 保存用户偏好（仅用户可改；不产生策略版本；同步账户兼容列 autonomy_level） */
export function savePreferences(accountId: string, preferencesJson: string, actor: 'user' | 'agent'): Strategy {
  if (actor !== 'user') throw new UserError('preference_user_only')
  let parsed: unknown
  try {
    parsed = JSON.parse(preferencesJson)
  } catch {
    throw new UserError('invalid_preferences', { detail: '不是合法 JSON' })
  }
  const errors = validatePreferences(parsed)
  if (errors.length > 0) throw new UserError('invalid_preferences', { detail: errors.join('; ') })
  const strategy = getStrategyForAccount(accountId)
  assertUser(strategy, 'missing_strategy', { accountId })
  const prefs = parsed as StrategyPreferences
  // 偏好与账户兼容列在同一事务内同步（一致性）
  inTransaction(() => {
    run('UPDATE strategy SET preferences_json = ?, updated_at = ? WHERE id = ?', [preferencesJson, nowIso(), strategy.id])
    run('UPDATE account SET autonomy_level = ? WHERE id = ?', [prefs.autonomyLevel, accountId])
  })
  audit({ accountId, actor: 'user', action: 'strategy.preferences.updated' })
  return getStrategyForAccount(accountId)!
}

/** 保存策略（Markdown 主载体 + 偏好，UI/Agent 共用入口）：DSL 同步执行层 + 新版本留档；偏好仅用户可改 */
export interface SaveStrategyRequest {
  accountId: string
  name?: string
  markdown?: string
  preferencesJson?: string
  changeLog?: string
  actor: 'user' | 'agent'
}

export function saveStrategy(req: SaveStrategyRequest): Strategy {
  const existing = getStrategyForAccount(req.accountId)
  assertUser(existing, 'missing_strategy', { accountId: req.accountId })
  const now = nowIso()

  // Markdown 变更（唯一载体）：提取 ```dsl 块同步执行层，新版本留档
  let markdown = existing.markdown
  let dslJson = existing.dslJson
  if (req.markdown !== undefined && req.markdown !== existing.markdown) {
    const extracted = extractDslFromMarkdown(req.markdown)
    if (extracted.errors.length > 0) throw new UserError('invalid_dsl', { detail: extracted.errors.join('; ') })
    markdown = req.markdown
    // 无 dsl 块 → 文档态（清空执行层，自动运行跳过）；有块 → 同步 dsl_json
    dslJson = extracted.dsl ? JSON.stringify(extracted.dsl, null, 2) : ''
  }
  // 偏好变更：仅用户可改（Agent 只读）
  let preferencesJson = existing.preferencesJson
  if (req.preferencesJson !== undefined) {
    if (req.actor !== 'user') throw new UserError('preference_user_only')
    let parsed: unknown
    try {
      parsed = JSON.parse(req.preferencesJson)
    } catch {
      throw new UserError('invalid_preferences', { detail: '不是合法 JSON' })
    }
    const errors = validatePreferences(parsed)
    if (errors.length > 0) throw new UserError('invalid_preferences', { detail: errors.join('; ') })
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
        newId(),
        existing.id,
        newVersion,
        markdown,
        dslJson,
        req.changeLog || `${req.actor === 'agent' ? 'Agent 迭代' : '用户修改'}`,
        now
      ])
    }
    // 偏好中的自主级别同步到账户列（兼容保留字段，同事务）
    try {
      const prefs = JSON.parse(preferencesJson) as { autonomyLevel?: string }
      if (prefs.autonomyLevel) run('UPDATE account SET autonomy_level = ? WHERE id = ?', [prefs.autonomyLevel, req.accountId])
    } catch {
      /* 忽略 */
    }
  })
  audit({ accountId: req.accountId, actor: req.actor, action: 'strategy.save', target: existing.id, detail: { contentChanged, version: newVersion } })
  return getStrategyForAccount(req.accountId)!
}

/** 纠正路径：用校验过的 DSL 替换执行层（同步更新 markdown 的 ```dsl 块，新版本留档） */
export function replaceDslWithVersion(strategyId: string, newDslJson: string, newMarkdown: string, changeLog: string): { version: number } {
  const current = queryOne<{ version: number }>('SELECT version FROM strategy WHERE id = ?', [strategyId])
  assertUser(current, 'missing_strategy', { strategyId })
  const next = current.version + 1
  inTransaction(() => {
    run('UPDATE strategy SET dsl_json = ?, markdown = ?, version = ?, updated_at = ? WHERE id = ?', [newDslJson, newMarkdown, next, nowIso(), strategyId])
    run('INSERT INTO strategy_version (id, strategy_id, version, dsl_json, markdown, change_log, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
      newId(),
      strategyId,
      next,
      newDslJson,
      newMarkdown,
      changeLog,
      nowIso()
    ])
  })
  return { version: next }
}

/** 回滚到指定版本：以新版本号（当前+1）恢复历史内容（版本号单调递增，不产生同号版本） */
export function rollback(accountId: string, versionId: string): Strategy {
  const v = queryOne<{ strategy_id: string; version: number; dsl_json: string; markdown: string }>('SELECT * FROM strategy_version WHERE id = ?', [versionId])
  assertUser(v, 'missing_strategy_version', { versionId })
  // 归属校验：版本必须属于该账户的策略（防跨账户回滚插入幻影版本）
  const owned = queryOne<{ id: string }>('SELECT id FROM strategy WHERE id = ? AND account_id = ?', [v.strategy_id, accountId])
  assertUser(owned, 'missing_strategy', { strategyId: v.strategy_id })
  const current = queryOne<{ version: number }>('SELECT version FROM strategy WHERE id = ?', [v.strategy_id])
  assertUser(current, 'missing_strategy', { strategyId: v.strategy_id })
  const next = current.version + 1
  inTransaction(() => {
    run('UPDATE strategy SET markdown = ?, dsl_json = ?, version = ?, updated_at = ? WHERE id = ? AND account_id = ?', [
      v.markdown ?? '',
      v.dsl_json,
      next,
      nowIso(),
      v.strategy_id,
      accountId
    ])
    run('INSERT INTO strategy_version (id, strategy_id, version, dsl_json, markdown, change_log, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
      newId(),
      v.strategy_id,
      next,
      v.dsl_json,
      v.markdown ?? '',
      `回滚至 v${v.version}`,
      nowIso()
    ])
  })
  audit({ accountId, actor: 'user', action: 'strategy.rollback', target: v.strategy_id, detail: { fromVersion: v.version, toVersion: next } })
  return getStrategyForAccount(accountId)!
}

// ---------- 生命周期 ----------
export type StrategyStatus = Strategy['status']

export function setStrategyStatus(strategyId: string, status: StrategyStatus): void {
  run('UPDATE strategy SET status = ?, updated_at = ? WHERE id = ?', [status, nowIso(), strategyId])
}

export function activateStrategy(accountId: string, strategyId: string, actor: 'user' | 'auto'): Strategy {
  const strategy = getStrategyById(strategyId)
  assertUser(strategy, 'missing_strategy', { strategyId })
  setStrategyStatus(strategyId, 'active')
  audit({ accountId, actor, action: 'strategy.activated', target: strategyId })
  return getStrategyById(strategyId)!
}

export function deactivateStrategy(accountId: string, strategyId: string, reason = '', actor: 'user' | 'auto' = 'user'): Strategy {
  const strategy = getStrategyById(strategyId)
  assertUser(strategy, 'missing_strategy', { strategyId })
  inTransaction(() => {
    setStrategyStatus(strategyId, 'deactivated')
    run("UPDATE run_instance SET status = 'stopped', stopped_at = ? WHERE strategy_id = ? AND status = 'active'", [nowIso(), strategyId])
  })
  audit({ accountId, actor, action: 'strategy.deactivated', target: strategyId, detail: { reason } })
  return getStrategyById(strategyId)!
}

export function pauseStrategy(accountId: string, strategyId: string, actor: 'user' | 'agent' | 'auto'): Strategy {
  const strategy = getStrategyById(strategyId)
  assertUser(strategy, 'missing_strategy', { strategyId })
  setStrategyStatus(strategyId, 'paused')
  audit({ accountId, actor, action: 'strategy.paused', target: strategyId })
  return getStrategyById(strategyId)!
}
