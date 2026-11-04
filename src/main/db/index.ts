/**
 * 数据库层：SQLite 连接、Schema 迁移与仓储。
 * 主进程独占访问（better-sqlite3 同步 API），WAL 模式。
 * 大事务分批提交，避免阻塞主进程事件循环。
 * 表结构见《实现方案-数据模型与模块设计》§1.3。
 */
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { logger } from '../services/logger'
import { audit, initAudit } from '../services/audit'
import { DEFAULT_RISK_RULES } from '../risk/engine'
import { DEFAULT_INITIAL_CASH, DEFAULT_PREFERENCES, emptyDslTemplate } from '@shared/constants'
import { markdownFromDsl, type StrategyDSL } from '@shared/strategy/schema'

let db: Database.Database | null = null

// ---------- 迁移 ----------
/** 迁移脚本（按版本号顺序执行），每个版本一个事务 */
const MIGRATIONS: { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS account (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, config_json TEXT NOT NULL DEFAULT '{}',
  autonomy_level TEXT NOT NULL DEFAULT 'conservative',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS app_config (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL, scope TEXT NOT NULL DEFAULT 'account',
  key TEXT NOT NULL, value_encrypted TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(account_id, key)
);

CREATE TABLE IF NOT EXISTS stock_basic (
  code TEXT PRIMARY KEY, name TEXT NOT NULL, exchange TEXT NOT NULL,
  industry TEXT, status TEXT NOT NULL DEFAULT 'listed', updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS kline_daily (
  code TEXT NOT NULL, date TEXT NOT NULL,
  open REAL NOT NULL, high REAL NOT NULL, low REAL NOT NULL, close REAL NOT NULL,
  volume REAL NOT NULL, amount REAL NOT NULL, adj_factor REAL NOT NULL DEFAULT 1,
  PRIMARY KEY (code, date)
);
CREATE INDEX IF NOT EXISTS idx_kline_daily_date ON kline_daily(date);

CREATE TABLE IF NOT EXISTS kline_minute (
  code TEXT NOT NULL, datetime TEXT NOT NULL, period TEXT NOT NULL DEFAULT '1m',
  open REAL NOT NULL, high REAL NOT NULL, low REAL NOT NULL, close REAL NOT NULL,
  volume REAL NOT NULL, amount REAL NOT NULL,
  PRIMARY KEY (code, period, datetime)
);

CREATE TABLE IF NOT EXISTS market_quote (
  code TEXT PRIMARY KEY, name TEXT, price REAL, pct_chg REAL,
  open REAL, high REAL, low REAL, prev_close REAL,
  volume REAL, amount REAL, ts TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS index_daily (
  index_code TEXT NOT NULL, date TEXT NOT NULL,
  open REAL NOT NULL, high REAL NOT NULL, low REAL NOT NULL, close REAL NOT NULL,
  volume REAL NOT NULL, amount REAL NOT NULL,
  PRIMARY KEY (index_code, date)
);

CREATE TABLE IF NOT EXISTS data_status (
  code TEXT PRIMARY KEY, last_update_date TEXT, integrity_level INTEGER DEFAULT 1,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS strategy (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL, name TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1, dsl_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft', created_by TEXT NOT NULL DEFAULT 'agent',
  rationale TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_strategy_account ON strategy(account_id, status);

CREATE TABLE IF NOT EXISTS strategy_version (
  id TEXT PRIMARY KEY, strategy_id TEXT NOT NULL, version INTEGER NOT NULL,
  dsl_json TEXT NOT NULL, change_log TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_strategy_version_sid ON strategy_version(strategy_id);

CREATE TABLE IF NOT EXISTS backtest_run (
  id TEXT PRIMARY KEY, strategy_version_id TEXT NOT NULL,
  params_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
  metrics_json TEXT, equity_json TEXT, report_json TEXT, error TEXT,
  created_at TEXT NOT NULL, finished_at TEXT
);

CREATE TABLE IF NOT EXISTS backtest_trade (
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL,
  code TEXT NOT NULL, side TEXT NOT NULL, price REAL NOT NULL, qty REAL NOT NULL,
  fee REAL NOT NULL, traded_at TEXT NOT NULL, pnl REAL, note TEXT
);
CREATE INDEX IF NOT EXISTS idx_backtest_trade_run ON backtest_trade(run_id);

CREATE TABLE IF NOT EXISTS run_instance (
  id TEXT PRIMARY KEY, strategy_id TEXT NOT NULL, strategy_version_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active', started_at TEXT NOT NULL, stopped_at TEXT
);

CREATE TABLE IF NOT EXISTS signal (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL, run_id TEXT NOT NULL,
  strategy_id TEXT NOT NULL, code TEXT NOT NULL, side TEXT NOT NULL,
  qty INTEGER NOT NULL, ref_price REAL NOT NULL,
  basis_json TEXT NOT NULL DEFAULT '{}', risk_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending_execution', expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_signal_account ON signal(account_id, status, created_at);

CREATE TABLE IF NOT EXISTS position (
  id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL, code TEXT NOT NULL,
  qty REAL NOT NULL, cost_price REAL NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(account_id, code)
);

CREATE TABLE IF NOT EXISTS trade_record (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL, code TEXT NOT NULL,
  side TEXT NOT NULL, price REAL NOT NULL, qty REAL NOT NULL, fee REAL NOT NULL,
  traded_at TEXT NOT NULL, signal_id TEXT, note TEXT
);

CREATE TABLE IF NOT EXISTS watchlist (
  id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL, code TEXT NOT NULL,
  note TEXT, tags TEXT, UNIQUE(account_id, code)
);

CREATE TABLE IF NOT EXISTS alert (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL, level TEXT NOT NULL,
  type TEXT NOT NULL, content_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'open', created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS risk_rule (
  id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL,
  rule_key TEXT NOT NULL, params_json TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1, UNIQUE(account_id, rule_key)
);

CREATE TABLE IF NOT EXISTS risk_check_result (
  id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL,
  ref_type TEXT NOT NULL, ref_id TEXT NOT NULL,
  results_json TEXT NOT NULL, passed INTEGER NOT NULL, checked_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS plan (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL, period TEXT NOT NULL,
  content_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS work_item (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL, type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', priority TEXT NOT NULL DEFAULT 'medium',
  context_json TEXT NOT NULL DEFAULT '{}', session_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 3,
  scheduled_at TEXT, deadline TEXT,
  result_json TEXT, error TEXT,
  created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_work_item_status ON work_item(account_id, status, priority);

CREATE TABLE IF NOT EXISTS agent_message (
  id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
  work_item_id TEXT, role TEXT NOT NULL, content TEXT NOT NULL,
  tool_calls_json TEXT, tool_results_json TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_message_session ON agent_message(session_id);

CREATE TABLE IF NOT EXISTS decision_record (
  id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL,
  work_item_id TEXT, event_id TEXT,
  input_snapshot_json TEXT NOT NULL, output_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS event_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL,
  type TEXT NOT NULL, payload_json TEXT NOT NULL DEFAULT '{}',
  source TEXT NOT NULL DEFAULT 'system', correlation_id TEXT,
  occurred_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_event_log_time ON event_log(occurred_at);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL,
  actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT,
  detail_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_log_time ON audit_log(created_at);

CREATE TABLE IF NOT EXISTS review_report (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL, period TEXT NOT NULL,
  content_json TEXT NOT NULL, metrics_json TEXT, created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS report (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL, level TEXT NOT NULL,
  title TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '',
  decision_json TEXT, status TEXT NOT NULL DEFAULT 'pending',
  work_item_id TEXT, artifacts_json TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_report_account ON report(account_id, status, level);

CREATE TABLE IF NOT EXISTS performance_snapshot (
  id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL,
  scope TEXT NOT NULL, date TEXT NOT NULL, metrics_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS account_snapshot (
  id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL,
  date TEXT NOT NULL, total_assets REAL NOT NULL, cash REAL NOT NULL,
  positions_json TEXT NOT NULL DEFAULT '[]',
  UNIQUE(account_id, date)
);
`
  },
  {
    // v2：本次重构——每账户唯一策略（含用户偏好）、账户资金、对话流
    version: 2,
    sql: `
ALTER TABLE strategy ADD COLUMN preferences_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE account ADD COLUMN cash REAL NOT NULL DEFAULT ${DEFAULT_INITIAL_CASH};

CREATE TABLE IF NOT EXISTS chat_message (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL, role TEXT NOT NULL,
  content TEXT NOT NULL, report_id TEXT, report_level TEXT, report_status TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_message_account ON chat_message(account_id, created_at);

-- 存量策略：每账户保留最新一份，其余删除（其历史版本仍保留于 strategy_version）
DELETE FROM strategy WHERE id IN (
  SELECT s1.id FROM strategy s1 JOIN strategy s2 ON s2.account_id = s1.account_id
  WHERE s2.updated_at > s1.updated_at
     OR (s2.updated_at = s1.updated_at AND s2.version > s1.version)
     OR (s2.updated_at = s1.updated_at AND s2.version = s1.version AND s2.id > s1.id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_strategy_account ON strategy(account_id);

-- 存量策略回填默认偏好
UPDATE strategy SET preferences_json = '${JSON.stringify(DEFAULT_PREFERENCES).replace(/'/g, "''")}' WHERE preferences_json = '{}';
`
  },
  {
    // v3：对话流适配 Claude Code 全部消息格式（kind/meta/工作项/会话关联，运行细节折叠）
    version: 3,
    sql: `
ALTER TABLE chat_message ADD COLUMN kind TEXT NOT NULL DEFAULT 'text';
ALTER TABLE chat_message ADD COLUMN meta_json TEXT;
ALTER TABLE chat_message ADD COLUMN work_item_id TEXT;
ALTER TABLE chat_message ADD COLUMN session_id TEXT;
CREATE INDEX IF NOT EXISTS idx_chat_message_workitem ON chat_message(work_item_id, created_at);
`
  },
  {
    // v4：策略改 Markdown 文档（markdown 为主载体，内嵌 ```dsl 代码块同步 dsl_json）
    version: 4,
    sql: `
ALTER TABLE strategy ADD COLUMN markdown TEXT NOT NULL DEFAULT '';
ALTER TABLE strategy_version ADD COLUMN markdown TEXT NOT NULL DEFAULT '';
`
  }
]

/** 打开数据库并执行迁移；返回连接 */
export function openDatabase(dataDir: string): Database.Database {
  const fs = require('node:fs')
  fs.mkdirSync(dataDir, { recursive: true })
  const conn = new Database(`${dataDir}/daydream.db`)
  conn.pragma('journal_mode = WAL')
  conn.pragma('synchronous = NORMAL')
  migrate(conn)
  db = conn
  initAudit(conn)
  seedDefaults()
  return conn
}

function migrate(conn: Database.Database): void {
  conn.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)`)
  const applied = new Set(
    (conn.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]).map((r) => r.version)
  )
  for (const m of MIGRATIONS.sort((a, b) => a.version - b.version)) {
    if (applied.has(m.version)) continue
    const tx = conn.transaction(() => {
      conn.exec(m.sql)
      conn.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(m.version, new Date().toISOString())
    })
    tx()
    logger.info(`[db] migrated to v${m.version}`)
  }
}

/** 默认数据：风控规则（账户创建时按需播种；不再自动创建默认账户——用户必须先创建账户） */
function seedDefaults(): void {
  if (!db) return
  // 存量账户补默认策略（v2 迁移后：每账户唯一一份策略）
  const accounts = queryAll<{ id: string; name: string }>('SELECT id, name FROM account')
  for (const a of accounts) {
    ensureStrategyForAccount(a.id, a.name)
  }
}

/** 为新账户播种默认风控规则 */
export function seedRiskRulesForAccount(accountId: string): void {
  if (!db) return
  const rules = db.prepare('SELECT rule_key FROM risk_rule WHERE account_id = ?').all(accountId) as { rule_key: string }[]
  const existing = new Set(rules.map((r) => r.rule_key))
  const insert = db.prepare('INSERT INTO risk_rule (account_id, rule_key, params_json, enabled) VALUES (?, ?, ?, 1)')
  for (const [key, params] of Object.entries(DEFAULT_RISK_RULES)) {
    if (!existing.has(key)) insert.run(accountId, key, JSON.stringify(params))
  }
}

/** 确保账户存在唯一策略（无则创建默认 draft：默认偏好 + Markdown 模板） */
export function ensureStrategyForAccount(accountId: string, accountName: string): void {
  if (!db) return
  const existing = db.prepare('SELECT id FROM strategy WHERE account_id = ?').get(accountId)
  if (existing) return
  const now = nowIso()
  const strategyId = randomUUID()
  const versionId = randomUUID()
  const dsl = emptyDslTemplate(`${accountName} 的策略`)
  const dslJson = JSON.stringify(dsl)
  const markdown = markdownFromDsl(`${accountName} 的策略`, dsl as unknown as StrategyDSL)
  const prefs = JSON.stringify(DEFAULT_PREFERENCES)
  db.prepare(
    "INSERT INTO strategy (id, account_id, name, version, dsl_json, markdown, preferences_json, status, created_by, rationale, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?, 'draft', 'system', '', ?, ?)"
  ).run(strategyId, accountId, `${accountName} 的策略`, dslJson, markdown, prefs, now, now)
  db.prepare(
    'INSERT INTO strategy_version (id, strategy_id, version, dsl_json, markdown, change_log, created_at) VALUES (?, ?, 1, ?, ?, ?, ?)'
  ).run(versionId, strategyId, dslJson, markdown, '初始版本（系统播种）', now)
}

/** 获取数据库连接（必须在 openDatabase 后调用） */
export function getDb(): Database.Database {
  if (!db) throw new Error('database not initialized')
  return db
}

// ---------- 通用查询辅助 ----------
export function queryAll<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T[] {
  return getDb().prepare(sql).all(...params) as T[]
}

export function queryOne<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T | undefined {
  return getDb().prepare(sql).get(...params) as T | undefined
}

export function run(sql: string, params: unknown[] = []): { changes: number; lastInsertRowid: number | bigint } {
  return getDb().prepare(sql).run(...params)
}

/** 事务包装 */
export function inTransaction<T>(fn: () => T): T {
  return getDb().transaction(fn)()
}

// ---------- 账户 ----------
/** 获取第一个账户（无账户时返回 undefined；不再自动创建） */
export function firstAccount(): { id: string; name: string } | undefined {
  return queryOne<{ id: string; name: string }>('SELECT id, name FROM account ORDER BY created_at LIMIT 1')
}

/** 确保存在账户：优先指定账户，其次第一个账户；无账户返回 undefined */
export function ensureAccount(accountId?: string): { id: string } | undefined {
  const row = accountId ? queryOne<{ id: string }>('SELECT id FROM account WHERE id = ?', [accountId]) : undefined
  if (row) return row
  const first = queryOne<{ id: string }>('SELECT id FROM account ORDER BY created_at LIMIT 1')
  return first
}

/** 创建账户（播种风控规则与唯一默认策略，审计留痕） */
export function createAccount(name: string): { id: string; name: string } {
  const id = randomUUID()
  const now = nowIso()
  run(
    'INSERT INTO account (id, name, config_json, autonomy_level, cash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [id, name, JSON.stringify({ initialCash: DEFAULT_INITIAL_CASH }), 'conservative', DEFAULT_INITIAL_CASH, now, now]
  )
  seedRiskRulesForAccount(id)
  ensureStrategyForAccount(id, name)
  audit({ accountId: id, actor: 'user', action: 'account.create', target: id })
  return { id, name }
}

export const nowIso = (): string => new Date().toISOString()
export const newId = (): string => randomUUID()
