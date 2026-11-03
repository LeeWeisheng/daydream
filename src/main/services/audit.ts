/**
 * 审计服务：全系统操作审计（含 LLM 调用统计与决策快照）。
 * 记录到 audit_log 表，永不记录明文密钥（见《实现方案》§8.2）。
 */
import type { Database } from 'better-sqlite3'

let dbRef: Database | null = null

export function initAudit(db: Database): void {
  dbRef = db
}

export interface AuditEntry {
  accountId: string
  actor: string
  action: string
  target?: string
  detail?: Record<string, unknown>
}

/** 写入一条审计记录 */
export function audit(entry: AuditEntry): void {
  if (!dbRef) return
  try {
    dbRef
      .prepare(
        `INSERT INTO audit_log (account_id, actor, action, target, detail_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        entry.accountId,
        entry.actor,
        entry.action,
        entry.target ?? null,
        JSON.stringify(entry.detail ?? {}),
        new Date().toISOString()
      )
  } catch (e) {
    // 审计失败不能中断业务
    console.error('[audit] failed', e)
  }
}

/** LLM 调用统计审计（记录 token 消耗，不记录请求内容中的密钥） */
export function auditLlmCall(accountId: string, model: string, action: string, tokensUsed: unknown, ok: boolean): void {
  audit({
    accountId,
    actor: 'agent',
    action: 'llm.call',
    target: model,
    detail: { purpose: action, tokens: tokensUsed, ok }
  })
}

/** 记录关键决策快照（评估/决策上下文） */
export function auditDecision(accountId: string, workItemId: string | undefined, input: unknown, output: unknown): void {
  if (!dbRef) return
  try {
    dbRef
      .prepare(
        `INSERT INTO decision_record (account_id, work_item_id, input_snapshot_json, output_json, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(accountId, workItemId ?? null, JSON.stringify(input), JSON.stringify(output), new Date().toISOString())
  } catch (e) {
    console.error('[audit] decision failed', e)
  }
}
