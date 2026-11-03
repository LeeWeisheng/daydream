/**
 * 模型配置读取（全局通用，所有账户共用）：
 * 存于 app_config 的全局行（account_id='global', key='model_config'），加密存储。
 * 独立模块供 llm.ts / llmBridge.ts / webSearch.ts 共用，避免循环依赖。
 */
import type { ModelConfig } from '@shared/types'
import { queryAll } from '../db'
import { decryptString } from '../services/crypto'

/** 全局模型配置行标识 */
export const GLOBAL_CONFIG_ACCOUNT = 'global'

export function getModelConfig(): ModelConfig | null {
  const row = queryAll<{ value_encrypted: string }>(
    'SELECT value_encrypted FROM app_config WHERE account_id = ? AND key = ?',
    [GLOBAL_CONFIG_ACCOUNT, 'model_config']
  )[0]
  if (!row) return null
  const decrypted = decryptString(row.value_encrypted)
  if (!decrypted) return null
  try {
    const cfg = JSON.parse(decrypted) as ModelConfig
    if (!cfg.baseUrl || !cfg.apiKey || !cfg.model) return null
    return cfg
  } catch {
    return null
  }
}

/** 保存全局模型配置（加密存储） */
export function saveModelConfig(cfg: ModelConfig, encrypt: (plain: string) => string, nowIso: () => string, run: (sql: string, params: unknown[]) => void): void {
  const encrypted = encrypt(JSON.stringify(cfg))
  run(
    `INSERT INTO app_config (account_id, scope, key, value_encrypted, updated_at) VALUES (?, 'global', 'model_config', ?, ?)
     ON CONFLICT(account_id, key) DO UPDATE SET value_encrypted = excluded.value_encrypted, updated_at = excluded.updated_at`,
    [GLOBAL_CONFIG_ACCOUNT, encrypted, nowIso()]
  )
}
