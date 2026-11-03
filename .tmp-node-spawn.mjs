// 纯 Node 下模拟 SDK 的 native binary stream-json 启动
import { spawn } from 'node:child_process'

const bin = '/Users/liweisheng/Projects/LeeWeisheng/daydream/node_modules/.pnpm/@anthropic-ai+claude-agent-sdk-darwin-x64@0.3.316/node_modules/@anthropic-ai/claude-agent-sdk-darwin-x64/claude'

const t0 = Date.now()
const child = spawn(bin, ['--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env }
})
let out = ''
let err = ''
child.stdout.on('data', (d) => {
  out += String(d)
  console.log(`[${Date.now() - t0}ms] stdout chunk:`, String(d).slice(0, 150))
})
child.stderr.on('data', (d) => {
  err += String(d)
  console.log(`[${Date.now() - t0}ms] stderr chunk:`, String(d).slice(0, 150))
})
child.on('error', (e) => console.log('error event:', e.message))
child.on('exit', (c) => console.log(`exit ${c} after ${Date.now() - t0}ms`))

child.stdin.write(JSON.stringify({ type: 'command', command: 'get_version', request_id: 'diag-1' }) + '\n')

setTimeout(() => {
  console.log('=== final ===')
  console.log('stdout:', out.slice(0, 300))
  console.log('stderr:', err.slice(0, 300))
  child.kill('SIGKILL')
  process.exit(0)
}, 12000)
