/**
 * 主题持久化与同步：light / dark / system（默认 system，跟随系统）。
 * 存储于 app_config 全局行（account_id='global', key='theme'），
 * 主进程同步 nativeTheme.themeSource，重启保持。
 */
import { nativeTheme } from 'electron'
import type { ThemeMode } from '@shared/types'
import { queryOne, run, nowIso } from './db'

export const GLOBAL_THEME_KEY = 'theme'
export const THEME_ACCOUNT = 'global'

export function getTheme(): ThemeMode {
  const row = queryOne<{ value_encrypted: string }>('SELECT value_encrypted FROM app_config WHERE account_id = ? AND key = ?', [
    THEME_ACCOUNT,
    GLOBAL_THEME_KEY
  ])
  const mode = row?.value_encrypted
  if (mode === 'light' || mode === 'dark' || mode === 'system') return mode
  return 'system'
}

export function setTheme(mode: ThemeMode): ThemeMode {
  run(
    `INSERT INTO app_config (account_id, scope, key, value_encrypted, updated_at) VALUES (?, 'global', ?, ?, ?)
     ON CONFLICT(account_id, key) DO UPDATE SET value_encrypted = excluded.value_encrypted, updated_at = excluded.updated_at`,
    [THEME_ACCOUNT, GLOBAL_THEME_KEY, mode, nowIso()]
  )
  syncNativeTheme(mode)
  return mode
}

/** 启动时同步原生主题 */
export function syncNativeTheme(mode: ThemeMode = getTheme()): void {
  nativeTheme.themeSource = mode
}

export function initTheme(): void {
  syncNativeTheme(getTheme())
}
