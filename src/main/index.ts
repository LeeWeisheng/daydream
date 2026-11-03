/**
 * 主进程入口：窗口生命周期、模块装配、Agent 闭环与调度器启动。
 * 架构：主进程承载全部业务（Agent/数据/回测/风控/绩效/SQLite），
 * 渲染进程仅展示与交互（contextIsolation + sandbox + 白名单 IPC）。
 */
import { app, BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import { initLogger, logger } from './services/logger'
import { initCrypto, encryptString } from './services/crypto'
import { openDatabase, ensureAccount, getDb } from './db'
import { registerIpcHandlers, collectAccountSnapshot } from './ipc/handlers'
import { startScheduler } from './scheduler'
import { startAgentLoop, initAgentRunning } from './agent/loop'
import { recoverRunningWorkItems } from './agent/workitem'
import { audit } from './services/audit'
import { getDataStats } from './data/service'
import { runAgentSelfTest } from './agentSelfTest'
import { runCryptoDiagnostic, runSpawnDiagnostic } from './cryptoDiag'

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
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    title: 'Daydream',
    backgroundColor: '#0f1115',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  })

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
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  const account = ensureAccount()
  if (account) audit({ accountId: account.id, actor: 'system', action: 'app.quit' })
})
