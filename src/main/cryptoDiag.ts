/**
 * 加密诊断（DAYDREAM_DIAG_CRYPTO=1 触发）：
 * 检查 safeStorage 可用性与 .masterkey 跨进程解密一致性，输出后退出。
 */
import { app, safeStorage } from 'electron'
import { join } from 'node:path'
import fs from 'node:fs'
import { spawn } from 'node:child_process'
import { logger } from './services/logger'

/** spawn 诊断：定位 Claude Code 原生二进制路径并尝试在 Electron 主进程内启动 */
export async function runSpawnDiagnostic(): Promise<void> {
  const out = (msg: string): void => {
    process.stdout.write(`[spawn-diag] ${msg}\n`)
    logger.info(`[spawn-diag] ${msg}`)
  }
  out('start')
  out(`env: NODE_OPTIONS=${process.env.NODE_OPTIONS ?? '(none)'} BUN_=${Object.keys(process.env).filter((k) => k.startsWith('BUN') || k.startsWith('ELECTRON') || k.startsWith('CLAUDE')).join(',') || '(none)'}`)
  const pnpmDir = join(process.cwd(), 'node_modules/.pnpm')
  out(`pnpm dir exists: ${fs.existsSync(pnpmDir)}`)
  const entries = fs
    .readdirSync(pnpmDir, { withFileTypes: true })
    .filter((d) => d.name.startsWith('@anthropic-ai+claude-agent-sdk-darwin-'))
    .map((d) => d.name)
  out(`darwin entries: ${entries.join(', ') || '(none)'}`)
  const candidates = [
    join(process.cwd(), 'node_modules/@anthropic-ai/claude-agent-sdk-darwin-x64/claude'),
    join(process.cwd(), 'node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude'),
    ...entries.map((n) => {
      // pnpm 目录名 @anthropic-ai+claude-agent-sdk-darwin-x64@0.3.316 → 包路径 @anthropic-ai/claude-agent-sdk-darwin-x64
      const pkgName = n.replace(/@\d+\.\d+\.\d+$/, '').replace('+', '/')
      return join(pnpmDir, n, 'node_modules', pkgName, 'claude')
    })
  ]
  for (const bin of candidates) {
    if (!fs.existsSync(bin)) continue
    out(`try spawn ${bin}`)
    try {
      const child = spawn(bin, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] })
      let childOut = ''
      let childErr = ''
      child.stdout.on('data', (d) => (childOut += String(d)))
      child.stderr.on('data', (d) => (childErr += String(d)))
      child.on('error', (e) => out(`child error event: ${e.message}`))
      const code = await new Promise<number | null>((resolve) => {
        const timer = setTimeout(() => {
          out('30s timeout, killing child')
          child.kill('SIGKILL')
          resolve(null)
        }, 30_000)
        child.on('exit', (c) => {
          clearTimeout(timer)
          resolve(c)
        })
      })
      out(`spawn result: exit=${code} stdout=${childOut.slice(0, 80)} stderr=${childErr.slice(0, 120)}`)

      // 模拟 SDK 的 stream-json 模式启动（写 stdin 触发初始化，测量握手耗时）
      out('try stream-json mode with init handshake')
      const t0 = Date.now()
      const child2 = spawn(bin, ['--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env }
      })
      let out2 = ''
      let err2 = ''
      child2.stdout.on('data', (d) => {
        out2 += String(d)
        if (out2.includes('"type":"system"')) out(`init received at ${Date.now() - t0}ms`)
      })
      child2.stderr.on('data', (d) => (err2 += String(d)))
      child2.on('error', (e) => out(`stream-json child error: ${e.message}`))
      child2.on('exit', (c) => out(`stream-json exited: ${c} after ${Date.now() - t0}ms`))
      child2.stdin.write(
        JSON.stringify({
          type: 'command',
          command: 'get_version',
          request_id: 'diag-1'
        }) + '\n'
      )
      await new Promise((resolve) => setTimeout(resolve, 12_000))
      if (!out2 && !err2) out('no output after 12s')
      child2.kill('SIGKILL')
      out(`stream-json result: stdout=${out2.slice(0, 200)} stderr=${err2.slice(0, 200)}`)
    } catch (e) {
      out(`spawn threw: ${(e as Error).message}`)
    }
  }
  out('done')
  app.exit(0)
}

export async function runCryptoDiagnostic(): Promise<void> {
  const keyPath = join(app.getPath('userData'), 'data', '.masterkey')
  logger.info(`[diag] userData=${app.getPath('userData')}`)
  logger.info(`[diag] safeStorage.isEncryptionAvailable=${safeStorage.isEncryptionAvailable()}`)
  if (!fs.existsSync(keyPath)) {
    logger.info('[diag] .masterkey 不存在')
    app.exit(0)
    return
  }
  const raw = fs.readFileSync(keyPath)
  logger.info(`[diag] .masterkey size=${raw.length}`)
  try {
    const d1 = safeStorage.decryptString(raw)
    const d2 = safeStorage.decryptString(raw)
    logger.info(`[diag] decrypt#1 len=${d1.length} hex-prefix=${d1.slice(0, 8)}`)
    logger.info(`[diag] decrypt#2 len=${d2.length} hex-prefix=${d2.slice(0, 8)} same=${d1 === d2}`)
  } catch (e) {
    logger.error(`[diag] decrypt threw: ${(e as Error).message}`)
  }
  app.exit(0)
}
