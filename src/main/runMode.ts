/**
 * 运行模式（全局）：manual 手动模式（默认）/ auto 自动模式（策略验证用）。
 * 自动模式：Agent 产出的审批类决策（策略激活/停用、纠正、紧急预警）自动批准并执行，
 * 无需人工干预；真实交易边界不变（不代执行交易）。
 * 存储：app_config 全局行（account_id='global', key='run_mode'），重启保持。
 */
import type { RunMode } from '@shared/types'
import { queryOne, run, nowIso } from './db'

export const RUN_MODE_ACCOUNT = 'global'
const RUN_MODE_KEY = 'run_mode'

export function getRunMode(): RunMode {
  const row = queryOne<{ value_encrypted: string }>('SELECT value_encrypted FROM app_config WHERE account_id = ? AND key = ?', [
    RUN_MODE_ACCOUNT,
    RUN_MODE_KEY
  ])
  return row?.value_encrypted === 'auto' ? 'auto' : 'manual'
}

export function isAutoMode(): boolean {
  return getRunMode() === 'auto'
}

export function setRunMode(mode: RunMode): RunMode {
  run(
    `INSERT INTO app_config (account_id, scope, key, value_encrypted, updated_at) VALUES (?, 'global', ?, ?, ?)
     ON CONFLICT(account_id, key) DO UPDATE SET value_encrypted = excluded.value_encrypted, updated_at = excluded.updated_at`,
    [RUN_MODE_ACCOUNT, RUN_MODE_KEY, mode, nowIso()]
  )
  return mode
}
