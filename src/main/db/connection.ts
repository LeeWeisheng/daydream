/**
 * 数据库连接（主进程独占）：打开 SQLite、执行迁移、暴露薄查询辅助。
 * 领域数据（工作项/事件/决策）由 app/store.ts 仓储写入；
 * 业务表由各自的服务（单写者）写入；本模块只提供连接与通用 SQL 辅助。
 */
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { migrate } from './schema'
import { initAudit } from '../services/audit'
import { initStore } from '../app/store'

let db: Database.Database | null = null

/** 打开数据库（WAL + NORMAL），执行迁移，初始化审计与仓储；返回连接 */
export function openDatabase(dataDir: string): Database.Database {
  const fs = require('node:fs')
  fs.mkdirSync(dataDir, { recursive: true })
  const conn = new Database(`${dataDir}/daydream.db`)
  conn.pragma('journal_mode = WAL')
  conn.pragma('synchronous = NORMAL')
  migrate(conn)
  db = conn
  initAudit(conn)
  initStore(conn)
  return conn
}

/** 获取数据库连接（必须在 openDatabase 后调用） */
export function getDb(): Database.Database {
  if (!db) throw new Error('database not initialized')
  return db
}

// ---------- 通用 SQL 辅助 ----------
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

/** 当前 ISO 时间 */
export const nowIso = (): string => new Date().toISOString()

/** 随机 ID（UUID） */
export const newId = (): string => randomUUID()
