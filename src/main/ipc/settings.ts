/**
 * IPC：设置域（settings:·/theme:·/runMode:·/window:·）。
 * - 模型配置全局通用（所有账户共用；密钥不回传明文，仅回传掩码）；
 * - 主题持久化并同步 nativeTheme（macOS 交通灯 / Windows 自绘窗口控制）；
 * - 运行模式（manual 手动 / auto 自动）变更触发策略变更（作废进行中的评估）；
 * - 窗口控制服务于自绘标题栏。
 */
import { ipcMain, BrowserWindow, nativeTheme } from 'electron'
import { IPC, type SettingsPatch } from '@shared/ipc'
import { audit } from '../services/audit'
import { getActiveAccountId } from '../accounts/service'
import {
  GLOBAL_ACCOUNT,
  getDataPrefs,
  getModelConfig,
  getRunMode,
  getTheme,
  isModelConfigured,
  saveModelConfig,
  setDataPrefs,
  setRunMode,
  setTheme
} from '../settings/service'
import { MODEL_PRESETS } from '@shared/constants'
import { getEngine } from '../runtime'
import { uiBus } from '../app/events'

export function registerSettingsHandlers(): void {
  // 设置
  ipcMain.handle(IPC.settingsGet, () => {
    const cfg = getModelConfig()
    return {
      // 密钥不回传明文（掩码）
      modelConfig: cfg ? { ...cfg, apiKey: cfg.apiKey ? '********' : '' } : undefined,
      presets: MODEL_PRESETS,
      theme: getTheme(),
      modelConfigured: isModelConfigured(),
      monitorIntervalMinutes: getDataPrefs().monitorIntervalMinutes,
      dataSourcePreference: getDataPrefs().dataSourcePreference
    }
  })
  ipcMain.handle(IPC.settingsUpdate, (_e, patch: SettingsPatch) => {
    if (patch.modelConfig) {
      // 模型配置全局通用（所有账户共用）
      saveModelConfig(patch.modelConfig)
      audit({ accountId: GLOBAL_ACCOUNT, actor: 'user', action: 'settings.model_config.updated' })
    }
    if (patch.monitorIntervalMinutes || patch.dataSourcePreference || patch.initYears) {
      // 只传有值字段（避免未携带字段被清空）
      setDataPrefs({
        ...(patch.monitorIntervalMinutes != null ? { monitorIntervalMinutes: patch.monitorIntervalMinutes } : {}),
        ...(patch.dataSourcePreference != null ? { dataSourcePreference: patch.dataSourcePreference } : {}),
        ...(patch.initYears != null ? { initYears: patch.initYears } : {})
      })
    }
  })

  // 主题
  ipcMain.handle(IPC.themeGet, () => getTheme())
  ipcMain.handle(IPC.themeSet, (_e, mode: 'light' | 'dark' | 'system') => {
    const next = setTheme(mode)
    nativeTheme.themeSource = next
    uiBus.broadcast('agent.status', { theme: next })
    return next
  })

  // 运行模式（manual 手动 / auto 自动：自动处理审批与信号，用于策略验证）
  ipcMain.handle(IPC.runModeGet, () => getRunMode())
  ipcMain.handle(IPC.runModeSet, (_e, mode: 'manual' | 'auto') => {
    const next = setRunMode(mode)
    // 策略变更：作废进行中的评估（docs/002 §Policy version）
    getEngine().policyChanged()
    audit({ accountId: getActiveAccountId() || GLOBAL_ACCOUNT, actor: 'user', action: 'run_mode.set', detail: { mode: next } })
    uiBus.broadcast('runMode.changed', { runMode: next })
    return next
  })

  // 窗口控制（自绘标题栏）
  ipcMain.handle(IPC.windowMinimize, (e) => BrowserWindow.fromWebContents(e.sender)?.minimize())
  ipcMain.handle(IPC.windowToggleMaximize, (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return false
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
    return win.isMaximized()
  })
  ipcMain.handle(IPC.windowClose, (e) => BrowserWindow.fromWebContents(e.sender)?.close())
  ipcMain.handle(IPC.windowIsMaximized, (e) => BrowserWindow.fromWebContents(e.sender)?.isMaximized() ?? false)
  ipcMain.handle(IPC.windowIsFullScreen, (e) => BrowserWindow.fromWebContents(e.sender)?.isFullScreen() ?? false)
}
