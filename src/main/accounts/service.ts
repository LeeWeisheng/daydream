/**
 * 账户服务（Accounts）：账户行的唯一写者（dsh「one writer per state」）。
 * 规则（docs《系统规则与账户模型》§1）：
 * - 本地账户，无登录；首次使用必须先创建账户（不自动创建默认账户）；
 * - 创建副作用：播种默认风控规则 + 唯一默认策略（纯 Markdown 文档）；
 * - 无账户时交易节律调度不运行。
 */
import type { Account } from '@shared/types'
import { DEFAULT_INITIAL_CASH, buildDefaultStrategyMarkdown } from '@shared/constants'
import { newId, nowIso, queryAll, queryOne, run, inTransaction } from '../db/connection'
import { audit } from '../services/audit'
import { UserError } from '../core/errors'
import { DEFAULT_RISK_RULES } from '../quant/risk'
import { computeAccountStats } from '../strategy/service'

/** 活跃账户（Agent/调度器运行的资金视角；header 账户下拉切换时更新） */
let activeAccountId = ''

export function getActiveAccountId(): string {
  if (activeAccountId) return activeAccountId
  return firstAccount()?.id ?? ''
}

export function setActiveAccountId(id: string): void {
  activeAccountId = id
}

export function firstAccount(): { id: string; name: string } | undefined {
  return queryOne<{ id: string; name: string }>('SELECT id, name FROM account ORDER BY created_at LIMIT 1')
}

/** 确保账户存在：优先指定账户，其次第一个账户；无账户返回 undefined */
export function ensureAccount(accountId?: string): { id: string } | undefined {
  const row = accountId ? queryOne<{ id: string }>('SELECT id FROM account WHERE id = ?', [accountId]) : undefined
  if (row) return row
  return firstAccount()
}

export function listAccounts(): Account[] {
  return queryAll<Record<string, unknown>>('SELECT * FROM account ORDER BY created_at').map(toAccount)
}

export function getAccount(accountId: string): Account | undefined {
  const row = queryOne<Record<string, unknown>>('SELECT * FROM account WHERE id = ?', [accountId])
  return row ? toAccount(row) : undefined
}

/** 创建账户（播种风控规则与唯一默认策略在同一事务，审计留痕） */
export function createAccount(name: string): Account {
  const id = newId()
  const now = nowIso()
  inTransaction(() => {
    run(
      'INSERT INTO account (id, name, config_json, autonomy_level, cash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, name, JSON.stringify({ initialCash: DEFAULT_INITIAL_CASH }), 'conservative', DEFAULT_INITIAL_CASH, now, now]
    )
    seedRiskRules(id)
    ensureStrategyForAccount(id, name)
  })
  audit({ accountId: id, actor: 'user', action: 'account.create', target: id })
  if (!activeAccountId) activeAccountId = id
  return getAccount(id)!
}

export function renameAccount(accountId: string, name: string): Account {
  const trimmed = name.trim()
  if (!trimmed) throw new UserError('invalid_input', { detail: '账户名称不能为空' })
  run('UPDATE account SET name = ?, updated_at = ? WHERE id = ?', [trimmed, nowIso(), accountId])
  audit({ accountId, actor: 'user', action: 'account.rename', detail: { name: trimmed } })
  return getAccount(accountId)!
}

/** 删除账户：清理全部账户级数据（隔离规则的边界动作；行情数据全局共享不动）。
 * 顺序约束：无 account_id 列的表（回测/版本/运行实例/执行实例/会话消息）
 * 依赖子查询，必须在其子查询所引用的表之前删除。 */
export function deleteAccount(accountId: string): void {
  inTransaction(() => {
    for (const table of [
      'backtest_trade',
      'backtest_run',
      'strategy_version',
      'run_instance',
      'signal',
      'position',
      'trade_record',
      'watchlist',
      'alert',
      'risk_rule',
      'risk_check_result',
      'plan',
      'work_item_assignment',
      'agent_message',
      'work_item',
      'decision_record',
      'event_log',
      'review_report',
      'report',
      'chat_message',
      'performance_snapshot',
      'account_snapshot',
      'audit_log',
      'app_config'
    ]) {
      if (table === 'backtest_run') {
        run(
          `DELETE FROM backtest_run WHERE id IN (SELECT br.id FROM backtest_run br JOIN strategy_version sv ON sv.id = br.strategy_version_id JOIN strategy s ON s.id = sv.strategy_id WHERE s.account_id = ?)`,
          [accountId]
        )
        continue
      }
      if (table === 'backtest_trade') {
        run(
          `DELETE FROM backtest_trade WHERE run_id IN (SELECT br.id FROM backtest_run br JOIN strategy_version sv ON sv.id = br.strategy_version_id JOIN strategy s ON s.id = sv.strategy_id WHERE s.account_id = ?)`,
          [accountId]
        )
        continue
      }
      if (table === 'strategy_version') {
        run(`DELETE FROM strategy_version WHERE strategy_id IN (SELECT id FROM strategy WHERE account_id = ?)`, [accountId])
        continue
      }
      if (table === 'run_instance') {
        run(`DELETE FROM run_instance WHERE strategy_id IN (SELECT id FROM strategy WHERE account_id = ?)`, [accountId])
        continue
      }
      if (table === 'work_item_assignment') {
        run(`DELETE FROM work_item_assignment WHERE ticket_id IN (SELECT id FROM work_item WHERE account_id = ?)`, [accountId])
        continue
      }
      if (table === 'agent_message') {
        run(`DELETE FROM agent_message WHERE work_item_id IN (SELECT id FROM work_item WHERE account_id = ?)`, [accountId])
        continue
      }
      run(`DELETE FROM ${table} WHERE account_id = ?`, [accountId])
    }
    run('DELETE FROM strategy WHERE account_id = ?', [accountId])
    run('DELETE FROM account WHERE id = ?', [accountId])
  })
  audit({ accountId, actor: 'user', action: 'account.delete', target: accountId })
  if (activeAccountId === accountId) activeAccountId = firstAccount()?.id ?? ''
}

/** 存量账户补默认策略（迁移后：每账户唯一一份策略） */
export function seedDefaultsForExisting(): void {
  const accounts = queryAll<{ id: string; name: string }>('SELECT id, name FROM account')
  for (const a of accounts) ensureStrategyForAccount(a.id, a.name)
}

// ---------- 播种 ----------
function seedRiskRules(accountId: string): void {
  const rules = queryAll<{ rule_key: string }>('SELECT rule_key FROM risk_rule WHERE account_id = ?', [accountId])
  const existing = new Set(rules.map((r) => r.rule_key))
  for (const [key, params] of Object.entries(DEFAULT_RISK_RULES)) {
    if (existing.has(key)) continue
    run('INSERT INTO risk_rule (account_id, rule_key, params_json, enabled) VALUES (?, ?, ?, 1)', [accountId, key, JSON.stringify(params)])
  }
}

/** 确保账户存在唯一策略（无则创建默认策略：纯 Markdown 文档，含交易策略框架与用户偏好段落） */
function ensureStrategyForAccount(accountId: string, accountName: string): void {
  const existing = queryOne<{ id: string; markdown: string }>('SELECT id, markdown FROM strategy WHERE account_id = ?', [accountId])
  if (existing) {
    // 旧库迁移兜底：策略存在但文档为空（v4 之前创建且从未保存）时回填默认文档与最新版本行
    if (!String(existing.markdown ?? '').trim()) {
      const markdown = buildDefaultStrategyMarkdown(accountName)
      const now = nowIso()
      run('UPDATE strategy SET markdown = ?, updated_at = ? WHERE id = ?', [markdown, now, existing.id])
      run('UPDATE strategy_version SET markdown = ? WHERE id = (SELECT id FROM strategy_version WHERE strategy_id = ? ORDER BY version DESC LIMIT 1)', [
        markdown,
        existing.id
      ])
    }
    return
  }
  const now = nowIso()
  const strategyId = newId()
  const title = `${accountName} 的策略`
  const markdown = buildDefaultStrategyMarkdown(accountName)
  run(
    "INSERT INTO strategy (id, account_id, title, version, markdown, active_version_id, created_by, created_at, updated_at) VALUES (?, ?, ?, 1, ?, NULL, 'system', ?, ?)",
    [strategyId, accountId, title, markdown, now, now]
  )
  run('INSERT INTO strategy_version (id, strategy_id, version, title, markdown, change_log, stats_json, created_at) VALUES (?, ?, 1, ?, ?, ?, ?, ?)', [
    newId(),
    strategyId,
    title,
    markdown,
    '初始版本（系统播种）',
    // 真实统计快照（本金/盈亏/盈亏比/胜率），与保存新版本的口径一致
    JSON.stringify(computeAccountStats(accountId)),
    now
  ])
}

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
