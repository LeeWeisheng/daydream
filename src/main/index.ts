/**
 * 主进程入口：窗口生命周期、模块装配、Agent 闭环与调度器启动。
 * 架构：主进程承载全部业务（Agent/数据/回测/风控/绩效/SQLite），
 * 渲染进程仅展示与交互（contextIsolation + sandbox + 白名单 IPC）。
 */
import { app, BrowserWindow, shell } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { initLogger, logger } from './services/logger'
import { initCrypto, encryptString } from './services/crypto'
import { openDatabase, ensureAccount, getDb } from './db'
import { registerIpcHandlers, collectAccountSnapshot } from './ipc/handlers'
import { startScheduler } from './scheduler'
import { startAgentLoop, initAgentRunning, isAgentRunning, stopAgentRuntime } from './agent/loop'
import { recoverRunningWorkItems } from './agent/workitem'
import { audit } from './services/audit'
import { getDataStats } from './data/service'
import { runAgentSelfTest } from './agentSelfTest'
import { runCryptoDiagnostic, runSpawnDiagnostic } from './cryptoDiag'
import { initTheme } from './theme'

/**
 * 配置种子：DAYDREAM_SEED_MODEL=1 时写入模型配置后退出（CLI/CI 用）。
 * 环境变量：SEED_BASE_URL / SEED_API_KEY / SEED_MODEL / SEED_MODEL_PRO
 * DAYDREAM_RESET_CRYPTO=1 时清空已加密配置（.masterkey 的删除在 initCrypto 之前完成）。
 */
async function seedModelConfigIfRequested(): Promise<boolean> {
  if (process.env.DAYDREAM_SEED_MODEL !== '1') return false
  if (process.env.DAYDREAM_RESET_CRYPTO === '1') {
    getDb().prepare("DELETE FROM app_config WHERE key = 'model_config'").run()
    logger.info('[seed] crypto reset done (config cleared)')
  }
  // 模型配置全局通用（无账户也可配置；种子流程不依赖账户）
  const cfg = {
    baseUrl: process.env.SEED_BASE_URL ?? 'https://api.deepseek.com/anthropic',
    apiKey: process.env.SEED_API_KEY ?? '',
    model: process.env.SEED_MODEL ?? 'deepseek-flash',
    modelPro: process.env.SEED_MODEL_PRO ?? '',
    contextWindow: 128000,
    maxCallsPerHour: 100
  }
  if (!cfg.apiKey) {
    logger.error('[seed] SEED_API_KEY missing')
    app.exit(1)
    return true
  }
  const encrypted = encryptString(JSON.stringify(cfg))
  getDb()
    .prepare(
      `INSERT INTO app_config (account_id, scope, key, value_encrypted, updated_at) VALUES ('global', 'global', 'model_config', ?, ?)
       ON CONFLICT(account_id, key) DO UPDATE SET value_encrypted = excluded.value_encrypted, updated_at = excluded.updated_at`
    )
    .run(encrypted, new Date().toISOString())
  logger.info(`[seed] model config written (global, model=${cfg.model}, modelPro=${cfg.modelPro || '-'})`)
  app.exit(0)
  return true
}

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  // 自绘标题栏：macOS 交通灯悬浮 header 左上角（hiddenInset）；Windows 无边框 + header 自绘窗口控制按钮
  // 开发模式下使用本地图标（打包产物由 electron-builder 嵌入 exe / app bundle，无需此处处理）
  const devIcon = join(app.getAppPath(), 'resources', 'icon.png')
  const hasDevIcon = existsSync(devIcon)
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    title: 'Daydream',
    backgroundColor: '#0f1115',
    icon: hasDevIcon && process.platform !== 'darwin' ? devIcon : undefined,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    frame: process.platform !== 'darwin',
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  })

  // Windows：最大化/还原状态变化通知渲染端（同步自绘按钮图标）
  mainWindow.on('maximize', () => mainWindow?.webContents.send('daydream:event', { type: 'window.maximized', payload: { maximized: true } }))
  mainWindow.on('unmaximize', () => mainWindow?.webContents.send('daydream:event', { type: 'window.maximized', payload: { maximized: false } }))
  // 全屏状态：macOS 全屏时交通灯自动隐藏（header 无需留白）；Windows 全屏时隐藏自绘窗口控制
  mainWindow.on('enter-full-screen', () => mainWindow?.webContents.send('daydream:event', { type: 'window.fullscreen', payload: { fullscreen: true } }))
  mainWindow.on('leave-full-screen', () => mainWindow?.webContents.send('daydream:event', { type: 'window.fullscreen', payload: { fullscreen: false } }))

  // 开发模式：macOS Dock 显示本地图标
  if (process.platform === 'darwin' && hasDevIcon) {
    app.dock.setIcon(devIcon)
  }

  mainWindow.on('ready-to-show', () => mainWindow?.show())
  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(async () => {
  initLogger()
  logger.info('[app] starting Daydream…')

  // macOS 应用菜单「关于 Daydream」面板信息
  if (process.platform === 'darwin') {
    app.setAboutPanelOptions({
      applicationName: 'Daydream',
      applicationVersion: app.getVersion(),
      version: `v${app.getVersion()}`,
      copyright: 'Copyright © 2026 Daydream Team',
      credits: 'A 股 AI 量化决策辅助：行情数据、策略回测、风控与 AI Agent 决策闭环自动化，交易由人工执行'
    })
  }

  // 密钥重置（CLI 模式）：必须在 initCrypto 之前删除 .masterkey，否则新配置将不可解密
  if (process.env.DAYDREAM_RESET_CRYPTO === '1') {
    const fs = require('node:fs') as typeof import('node:fs')
    fs.rmSync(join(app.getPath('userData'), 'data', '.masterkey'), { force: true })
  }

  const dataDir = join(app.getPath('userData'), 'data')
  initCrypto(app.getPath('userData'))
  const db = openDatabase(dataDir)
  void db
  const account = ensureAccount()
  if (account) {
    audit({ accountId: account.id, actor: 'system', action: 'app.start', detail: getDataStats() })
    // 每日账户快照采集（收盘后，绩效输入）
    collectAccountSnapshot(account.id)
  }

  // 崩溃恢复：重置可安全重跑的工作项
  const recovered = recoverRunningWorkItems()
  logger.info(`[app] recovered ${recovered.length} running workitems`)

  registerIpcHandlers()
  initTheme()
  startAgentLoop()
  initAgentRunning()
  startScheduler()

  // 配置种子（CLI 模式：写入后退出）
  if (await seedModelConfigIfRequested()) return

  // Agent 自测（CLI 模式：自测后退出）
  if (process.env.DAYDREAM_TEST_AGENT === '1') {
    void runAgentSelfTest()
    return
  }

  // 加密诊断（CLI 模式）
  if (process.env.DAYDREAM_DIAG_CRYPTO === '1') {
    await runCryptoDiagnostic()
    return
  }

  // spawn 诊断（CLI 模式）
  if (process.env.DAYDREAM_DIAG_SPAWN === '1') {
    await runSpawnDiagnostic()
    return
  }

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  // 单窗口应用：关闭窗口即退出（Agent 不后台残留；macOS 亦同）
  app.quit()
})

let quitting = false
app.on('before-quit', () => {
  if (quitting) return
  quitting = true
  // 关闭软件时优雅停止 Agent 运行（不修改持久化开关：用户并未点击停止，重启后恢复）
  const account = ensureAccount()
  const running = isAgentRunning()
  if (running) {
    stopAgentRuntime()
    audit({ accountId: account?.id ?? 'global', actor: 'system', action: 'agent.stop_on_quit' })
  }
  if (account) audit({ accountId: account.id, actor: 'system', action: 'app.quit' })
})
