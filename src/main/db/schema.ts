/**
 * 数据库 Schema 与迁移（版本化，按序执行，每版本一个事务）。
 * 引擎：SQLite + better-sqlite3（主进程独占连接，WAL，synchronous=NORMAL）。
 * 表结构见 docs《实现方案-数据模型与模块设计》§1.3；迁移变更见各版本注释。
 */
import type { Database } from 'better-sqlite3'
import { logger } from '../services/logger'
import { DEFAULT_INITIAL_CASH, DEFAULT_PREFERENCES } from '@shared/constants'

export const SCHEMA_VERSION = 6

interface Migration {
  version: number
  sql: string
}

export const MIGRATIONS: Migration[] = [
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
    // v2：每账户唯一策略（含用户偏好）、账户资金、对话流
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
  },
  {
    // v5（本次重构）：dsh 架构对齐——事件去向、工作项授权（Mandate）、执行实例（Assignment）、持久化副作用队列（Effect）
    version: 5,
    sql: `
ALTER TABLE event_log ADD COLUMN trigger_id TEXT;
ALTER TABLE event_log ADD COLUMN disposition TEXT NOT NULL DEFAULT 'stored';
CREATE UNIQUE INDEX IF NOT EXISTS idx_event_log_trigger ON event_log(trigger_id);
CREATE INDEX IF NOT EXISTS idx_event_log_disposition ON event_log(disposition);

ALTER TABLE work_item ADD COLUMN mandate_json TEXT;

CREATE TABLE IF NOT EXISTS work_item_assignment (
  id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL,
  started_at TEXT NOT NULL, ended_at TEXT, outcome TEXT, error TEXT
);
CREATE INDEX IF NOT EXISTS idx_assignment_ticket ON work_item_assignment(ticket_id);

CREATE TABLE IF NOT EXISTS effect (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL, key TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  due_at TEXT NOT NULL,
  UNIQUE(kind, key)
);
`
  },
  {
    // v6（本次重构）：策略彻底 Markdown 化——移除 DSL 结构与偏好 JSON（偏好并入文档文本），
    // 增加标题（大模型生成）、版本统计（本金/盈亏/盈亏比/胜率）与用户指定的生效版本。
    // 策略无审核流：保存即生效，默认使用最新版本，用户可指定其它版本。
    version: 6,
    sql: `
CREATE TABLE strategy_new (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL, title TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1, markdown TEXT NOT NULL DEFAULT '',
  active_version_id TEXT,
  created_by TEXT NOT NULL DEFAULT 'agent',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
INSERT INTO strategy_new (id, account_id, title, version, markdown, active_version_id, created_by, created_at, updated_at)
  SELECT id, account_id, name, version, COALESCE(markdown, ''), NULL, created_by, created_at, updated_at FROM strategy;
DROP TABLE strategy;
ALTER TABLE strategy_new RENAME TO strategy;
CREATE UNIQUE INDEX IF NOT EXISTS idx_strategy_account ON strategy(account_id);

CREATE TABLE strategy_version_new (
  id TEXT PRIMARY KEY, strategy_id TEXT NOT NULL, version INTEGER NOT NULL,
  title TEXT NOT NULL DEFAULT '', markdown TEXT NOT NULL DEFAULT '',
  change_log TEXT NOT NULL DEFAULT '', stats_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
INSERT INTO strategy_version_new (id, strategy_id, version, title, markdown, change_log, created_at)
  SELECT id, strategy_id, version, '', COALESCE(markdown, ''), change_log, created_at FROM strategy_version;
DROP TABLE strategy_version;
ALTER TABLE strategy_version_new RENAME TO strategy_version;
CREATE INDEX IF NOT EXISTS idx_strategy_version_sid ON strategy_version(strategy_id);

-- 策略无审核流：取消存量 activate（上线）工作项，避免执行器报未知类型
UPDATE work_item SET status = 'cancelled' WHERE type = 'activate';
`
  }
]

/** 执行迁移（按版本号升序，每版本一个事务，幂等） */
export function migrate(conn: Database): void {
  conn.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)`)
  const applied = new Set((conn.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]).map((r) => r.version))
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
