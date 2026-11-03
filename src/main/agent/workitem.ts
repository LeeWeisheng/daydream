/**
 * 工作项模型与状态机：闭环中的最小可管理单位。
 * 单工作队列 + 优先级调度；同一业务对象串行、不同对象可并行（默认并发 2）；
 * 超时自动失败并重试；幂等键 = 工作项 ID。
 */
import type { WorkItem, WorkItemStatus, WorkItemType } from '@shared/types'
import { getDb, nowIso, queryAll, queryOne, run } from '../db'
import { audit } from '../services/audit'
import { logger } from '../services/logger'

export interface WorkItemContext {
  [key: string]: unknown
}

export interface CreateWorkItemOptions {
  accountId: string
  type: WorkItemType
  priority?: 'low' | 'medium' | 'high'
  context?: WorkItemContext
  scheduledAt?: string
  deadline?: string
  maxAttempts?: number
}

export function createWorkItem(options: CreateWorkItemOptions): WorkItem {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const now = nowIso()
  const item: WorkItem = {
    id,
    accountId: options.accountId,
    type: options.type,
    status: 'pending',
    priority: options.priority ?? 'medium',
    contextJson: JSON.stringify(options.context ?? {}),
    attempts: 0,
    maxAttempts: options.maxAttempts ?? 3,
    scheduledAt: options.scheduledAt,
    deadline: options.deadline,
    createdAt: now
  }
  run(
    `INSERT INTO work_item (id, account_id, type, status, priority, context_json, attempts, max_attempts, scheduled_at, deadline, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
    [item.id, item.accountId, item.type, item.status, item.priority, item.contextJson, item.maxAttempts, item.scheduledAt ?? null, item.deadline ?? null, item.createdAt]
  )
  audit({ accountId: item.accountId, actor: 'agent', action: 'workitem.create', target: item.id, detail: { type: item.type } })
  return item
}

export function getWorkItem(id: string): WorkItem | undefined {
  return queryOne<WorkItem & Record<string, unknown>>(
    `SELECT id, account_id as accountId, type, status, priority, context_json as contextJson, session_id as sessionId,
       attempts, max_attempts as maxAttempts, scheduled_at as scheduledAt, deadline, result_json as resultJson, error,
       created_at as createdAt, started_at as startedAt, finished_at as finishedAt
     FROM work_item WHERE id = ?`,
    [id]
  ) as WorkItem | undefined
}

export function updateWorkItemStatus(id: string, status: WorkItemStatus, extra?: { resultJson?: string; error?: string; sessionId?: string }): void {
  const now = nowIso()
  const sets = ['status = ?']
  const params: unknown[] = [status]
  if (extra?.resultJson != null) {
    sets.push('result_json = ?')
    params.push(extra.resultJson)
  }
  if (extra?.error != null) {
    sets.push('error = ?')
    params.push(extra.error)
  }
  if (extra?.sessionId != null) {
    sets.push('session_id = ?')
    params.push(extra.sessionId)
  }
  if (status === 'running') {
    sets.push('started_at = ?')
    params.push(now)
  }
  if (status === 'succeeded' || status === 'failed' || status === 'cancelled') {
    sets.push('finished_at = ?')
    params.push(now)
  }
  run(`UPDATE work_item SET ${sets.join(', ')} WHERE id = ?`, [...params, id])
}

export function incrementAttempts(id: string): void {
  run('UPDATE work_item SET attempts = attempts + 1 WHERE id = ?', [id])
}

/** 取下一个可执行工作项（到期的 pending，按优先级/创建时间排序；同一业务对象互斥；可传类型过滤器） */
export function nextRunnableWorkItem(activeKeys: Set<string>, now: string, typeFilter?: (item: WorkItem) => boolean): WorkItem | undefined {
  const rows = queryAll<WorkItem & Record<string, unknown>>(
    `SELECT id, account_id as accountId, type, status, priority, context_json as contextJson, session_id as sessionId,
       attempts, max_attempts as maxAttempts, scheduled_at as scheduledAt, deadline, result_json as resultJson, error,
       created_at as createdAt, started_at as startedAt, finished_at as finishedAt
     FROM work_item
     WHERE status = 'pending' AND (scheduled_at IS NULL OR scheduled_at <= ?)
     ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, created_at ASC
     LIMIT 50`,
    [now]
  )
  const row = rows.find((r) => {
    const ctx = parseContext(r.contextJson)
    const key = ctx['__busKey'] as string | undefined
    if (key && activeKeys.has(key)) return false
    if (typeFilter && !typeFilter(r as WorkItem)) return false
    return true
  })
  return row as WorkItem | undefined
}

export function parseContext(json: string): WorkItemContext {
  try {
    return JSON.parse(json) as WorkItemContext
  } catch {
    return {}
  }
}

export function listWorkItems(accountId: string): WorkItem[] {
  return queryAll<WorkItem>(
    `SELECT id, account_id as accountId, type, status, priority, context_json as contextJson, session_id as sessionId,
       attempts, max_attempts as maxAttempts, scheduled_at as scheduledAt, deadline, result_json as resultJson, error,
       created_at as createdAt, started_at as startedAt, finished_at as finishedAt
     FROM work_item WHERE account_id = ? ORDER BY created_at DESC LIMIT 200`,
    [accountId]
  )
}

/** 崩溃恢复：启动时扫描 running 工作项 */
export function recoverRunningWorkItems(): WorkItem[] {
  const rows = queryAll<WorkItem>(
    `SELECT id, account_id as accountId, type, status, priority, context_json as contextJson, session_id as sessionId,
       attempts, max_attempts as maxAttempts, scheduled_at as scheduledAt, deadline, result_json as resultJson, error,
       created_at as createdAt, started_at as startedAt, finished_at as finishedAt
     FROM work_item WHERE status = 'running'`
  )
  for (const item of rows) {
    // 可安全重跑的（生成/回测/复盘/规划）重置为 pending；涉及信号/资金类的标记 failed 并汇报
    const safeTypes: WorkItemType[] = ['plan', 'generate_strategy', 'backtest', 'review_daily', 'review_weekly', 'data_backfill']
    if (safeTypes.includes(item.type)) {
      run(`UPDATE work_item SET status = 'pending', started_at = NULL WHERE id = ?`, [item.id])
      logger.info(`[agent] recover: reset ${item.type} ${item.id} to pending`)
    } else {
      updateWorkItemStatus(item.id, 'failed', { error: '应用中断，工作项终止（不可安全重跑）' })
    }
  }
  return rows
}
