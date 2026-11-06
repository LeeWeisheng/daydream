/**
 * Effects：持久化副作用队列（dsh src/app/effects.ts 的对应）。
 * 规则：
 * - 命令在事务内 enqueue，事务提交后才执行（失败不执行）；
 * - 每 kind/key 一行；同 key 重新入队替换载荷并立即可执行，不改变队列顺序；
 * - 到期行按入队顺序处理，受并发上限约束；失败指数退避重试（Later 不计失败）；
 * - start 开始处理，drain 停机时保留待执行行。
 */
import type { Database } from 'better-sqlite3'
import { getDb } from '../db/connection'
import { logger } from '../services/logger'

export type EffectKind = 'assessment' | 'launch' | 'reply'

interface EffectRow {
  id: number
  kind: EffectKind
  key: string
  payload_json: string
  attempts: number
  last_error: string | null
  due_at: string
}

interface HandlerOptions {
  /** 同时处理数 */
  atOnce: number
  /** 初始退避（毫秒） */
  backoffStartMs?: number
  /** 退避上限（毫秒） */
  backoffMaxMs?: number
  /** 最大尝试次数（超限丢弃，避免孤儿行永久重试；默认 8） */
  maxAttempts?: number
}

type Handler = (payload: unknown) => Promise<void>

/** 推迟执行而不计失败（如无可用槽位） */
export class Later extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = 'Later'
  }
}

const DEFAULT_BACKOFF_START = 2_000
const DEFAULT_BACKOFF_MAX = 60_000
const DEFAULT_MAX_ATTEMPTS = 8

export class Effects {
  private readonly handlers = new Map<EffectKind, { run: Handler; options: HandlerOptions }>()
  private readonly inFlight = new Map<EffectKind, number>()
  private running = false
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(private readonly db: () => Database) {}

  /** 入队一个副作用（事务内调用；提交后执行） */
  enqueue(kind: EffectKind, key: string, payload: unknown): void {
    this.db()
      .prepare(
        `INSERT INTO effect (kind, key, payload_json, attempts, due_at) VALUES (?, ?, ?, 0, ?)
         ON CONFLICT(kind, key) DO UPDATE SET payload_json = excluded.payload_json, attempts = 0, last_error = NULL, due_at = excluded.due_at`
      )
      .run(kind, key, JSON.stringify(payload), new Date().toISOString())
  }

  /** 注册一个处理函数 */
  handle(kind: EffectKind, run: Handler, options: HandlerOptions): void {
    this.handlers.set(kind, { run, options })
  }

  /** 启动轮询（幂等） */
  start(intervalMs = 1_000): void {
    if (this.running) return
    this.running = true
    void this.processAll()
    this.timer = setInterval(() => void this.processAll(), intervalMs)
    this.timer.unref?.()
  }

  /** 停机：保留待执行行，停止轮询 */
  drain(): void {
    this.running = false
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** 立即处理一遍全部到期行（enqueue 后可由调用方主动触发，降低延迟） */
  async processAll(): Promise<void> {
    for (const kind of this.handlers.keys()) {
      await this.processKind(kind)
    }
  }

  /** 待执行行数（健康检查用） */
  pending(): number {
    return (this.db().prepare('SELECT COUNT(*) AS c FROM effect WHERE due_at <= ?').get(new Date().toISOString()) as { c: number }).c
  }

  // ---------- 内部 ----------
  private async processKind(kind: EffectKind): Promise<void> {
    const handler = this.handlers.get(kind)
    if (!handler) return
    const busy = this.inFlight.get(kind) ?? 0
    if (busy >= handler.options.atOnce) return
    const row = this.nextDue(kind)
    if (!row) return
    this.inFlight.set(kind, busy + 1)
    try {
      await handler.run(JSON.parse(row.payload_json) as unknown)
      this.db().prepare('DELETE FROM effect WHERE id = ?').run(row.id)
    } catch (e) {
      const err = e as Error
      if (err instanceof Later) {
        // 推迟：不计失败，稍后重试
        this.db()
          .prepare('UPDATE effect SET due_at = ?, last_error = ? WHERE id = ?')
          .run(new Date(Date.now() + 2_000).toISOString(), err.message, row.id)
      } else {
        const maxAttempts = handler.options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
        if (row.attempts + 1 >= maxAttempts) {
          // 尝试耗尽：丢弃（如引用已删除工作项的孤儿行），避免永久重试刷屏
          this.db().prepare('DELETE FROM effect WHERE id = ?').run(row.id)
          logger.error(`[effects] ${kind}/${row.key} dropped after ${maxAttempts} attempts: ${err.message}`)
        } else {
          const start = handler.options.backoffStartMs ?? DEFAULT_BACKOFF_START
          const max = handler.options.backoffMaxMs ?? DEFAULT_BACKOFF_MAX
          const delay = Math.min(start * 2 ** Math.max(row.attempts, 0), max)
          this.db()
            .prepare('UPDATE effect SET attempts = attempts + 1, last_error = ?, due_at = ? WHERE id = ?')
            .run(`${err.name}: ${err.message}`.slice(0, 500), new Date(Date.now() + delay).toISOString(), row.id)
          logger.warn(`[effects] ${kind}/${row.key} failed (attempt ${row.attempts + 1}): ${err.message}`)
        }
      }
    } finally {
      this.inFlight.set(kind, Math.max((this.inFlight.get(kind) ?? 1) - 1, 0))
    }
  }

  private nextDue(kind: EffectKind): EffectRow | undefined {
    return this.db()
      .prepare(`SELECT id, kind, key, payload_json, attempts, last_error, due_at FROM effect WHERE kind = ? AND due_at <= ? ORDER BY id ASC LIMIT 1`)
      .get(kind, new Date().toISOString()) as EffectRow | undefined
  }
}

/** 全局副作用队列单例（Runtime 注册处理函数后 start） */
export const effects = new Effects(() => getDb())
