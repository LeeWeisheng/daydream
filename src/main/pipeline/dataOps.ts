/**
 * 数据补数管线：数据缺失时的补数工作项（data_backfill）。
 */
import { backfill } from '../data/pipeline'
import { queryAll } from '../db'
import { audit } from '../services/audit'
import { logger } from '../services/logger'

export async function backfillFromContext(accountId: string, context: Record<string, unknown>): Promise<Record<string, unknown>> {
  const code = String(context.code ?? '')
  const start = String(context.start ?? '')
  const end = String(context.end ?? '')
  if (!code) throw new Error('补数缺少代码')
  const nameRow = queryAll<{ name: string }>('SELECT name FROM stock_basic WHERE code = ?', [code])[0]
  await backfill(code, nameRow?.name ?? code, start, end)
  audit({ accountId, actor: 'agent', action: 'data.backfill', target: code, detail: { start, end } })
  logger.info(`[pipeline] backfilled ${code} (${start} ~ ${end})`)
  return { code, done: true }
}
