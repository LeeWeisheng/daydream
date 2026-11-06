/**
 * 设置服务（Settings）：app_config 键值记录的唯一写者（dsh「one writer per state」）。
 * 键由本模块集中声明（dsh KV registry 的对应），其余模块只读：
 * - model_config：全局模型配置（AES-256-GCM 加密，密钥不回传明文）
 * - agent_running：Agent 运行开关（全局，持久化，重启恢复）
 * - run_mode：运行模式 manual/auto（全局）
 * - theme：主题 light/dark/system（全局）
 * - data_prefs：数据偏好（盯盘间隔/数据源偏好/初始化年数）
 * - autonomy：账户自主级别在 account.autonomy_level（由偏好同步，兼容保留）
 */
import type { ModelConfig, RunMode, ThemeMode } from '@shared/types'
import type { AutonomyLevel } from '../policy'
import { decryptString, encryptString } from '../services/crypto'
import { nowIso, queryOne, run } from '../db/connection'

export const GLOBAL_ACCOUNT = 'global'

// ---------- 键清单（集中声明，禁止散落字面量） ----------
export const SETTING_KEYS = {
  modelConfig: 'model_config',
  agentRunning: 'agent_running',
  runMode: 'run_mode',
  theme: 'theme',
  dataPrefs: 'data_prefs'
} as const

function getValue(key: string): string | undefined {
  return queryOne<{ value_encrypted: string }>('SELECT value_encrypted FROM app_config WHERE account_id = ? AND key = ?', [
    GLOBAL_ACCOUNT,
    key
  ])?.value_encrypted
}

function setValue(key: string, value: string): void {
  run(
    `INSERT INTO app_config (account_id, scope, key, value_encrypted, updated_at) VALUES (?, 'global', ?, ?, ?)
     ON CONFLICT(account_id, key) DO UPDATE SET value_encrypted = excluded.value_encrypted, updated_at = excluded.updated_at`,
    [GLOBAL_ACCOUNT, key, value, nowIso()]
  )
}

// ---------- 模型配置（全局通用，加密存储） ----------
export function getModelConfig(): ModelConfig | null {
  const encrypted = getValue(SETTING_KEYS.modelConfig)
  if (!encrypted) return null
  const decrypted = decryptString(encrypted)
  if (!decrypted) return null
  try {
    const cfg = JSON.parse(decrypted) as ModelConfig
    if (!cfg.baseUrl || !cfg.apiKey || !cfg.model) return null
    return cfg
  } catch {
    return null
  }
}

export function saveModelConfig(cfg: ModelConfig): void {
  setValue(SETTING_KEYS.modelConfig, encryptString(JSON.stringify(cfg)))
}

export function isModelConfigured(): boolean {
  return getModelConfig() != null
}

// ---------- Agent 运行开关（全局，持久化） ----------
export function getAgentRunning(): boolean {
  return getValue(SETTING_KEYS.agentRunning) === '1'
}

export function setAgentRunning(running: boolean): void {
  setValue(SETTING_KEYS.agentRunning, running ? '1' : '0')
}

// ---------- 运行模式（manual 手动 / auto 自动） ----------
export function getRunMode(): RunMode {
  return getValue(SETTING_KEYS.runMode) === 'auto' ? 'auto' : 'manual'
}

export function setRunMode(mode: RunMode): RunMode {
  setValue(SETTING_KEYS.runMode, mode)
  return mode
}

export function isAutoMode(): boolean {
  return getRunMode() === 'auto'
}

// ---------- 主题 ----------
export function getTheme(): ThemeMode {
  const mode = getValue(SETTING_KEYS.theme)
  if (mode === 'light' || mode === 'dark' || mode === 'system') return mode
  return 'system'
}

export function setTheme(mode: ThemeMode): ThemeMode {
  setValue(SETTING_KEYS.theme, mode)
  return mode
}

// ---------- 数据偏好 ----------
export interface DataPrefs {
  monitorIntervalMinutes: number
  dataSourcePreference?: string
  initYears?: number
}

export function getDataPrefs(): DataPrefs {
  try {
    const raw = getValue(SETTING_KEYS.dataPrefs)
    if (!raw) return { monitorIntervalMinutes: 2 }
    const parsed = JSON.parse(raw) as Partial<DataPrefs>
    return {
      ...parsed,
      monitorIntervalMinutes: parsed.monitorIntervalMinutes ?? 2
    }
  } catch {
    return { monitorIntervalMinutes: 2 }
  }
}

export function setDataPrefs(prefs: Partial<DataPrefs>): void {
  setValue(SETTING_KEYS.dataPrefs, JSON.stringify({ ...getDataPrefs(), ...prefs }))
}

// ---------- 账户自主级别（策略输入；事实来源为账户行） ----------
export function getAutonomyLevel(accountId: string): AutonomyLevel {
  const row = queryOne<{ autonomy_level: string }>('SELECT autonomy_level FROM account WHERE id = ?', [accountId])
  const value = row?.autonomy_level
  if (value === 'conservative' || value === 'standard' || value === 'aggressive') return value
  return 'conservative'
}
