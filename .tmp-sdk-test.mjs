// SDK 隔离测试：纯 Node 环境验证 claude-agent-sdk + DeepSeek 端点
process.env.ANTHROPIC_BASE_URL = 'https://api.deepseek.com/anthropic'
process.env.ANTHROPIC_AUTH_TOKEN = 'sk-f350da7bcd974450a1bba374eceda1d3'
process.env.ANTHROPIC_API_KEY = 'sk-f350da7bcd974450a1bba374eceda1d3'
process.env.ANTHROPIC_MODEL = 'deepseek-flash'
process.env.ANTHROPIC_SMALL_FAST_MODEL = 'deepseek-flash'

const { query } = await import('@anthropic-ai/claude-agent-sdk')

console.log('starting query...')
const q = query({
  prompt: '用一句话回答：1+1等于几？',
  options: {
    cwd: '/tmp',
    model: 'deepseek-flash',
    systemPrompt: '你是测试助手',
    permissionMode: 'bypassPermissions',
    maxTurns: 3
  }
})
let final = null
for await (const msg of q) {
  if (msg.type === 'result') {
    final = msg
    console.log('RESULT subtype:', msg.subtype)
    if (msg.subtype === 'success') {
      console.log('RESULT text:', (msg.result ?? '').slice(0, 200))
    } else {
      console.log('ERROR result:', JSON.stringify(msg).slice(0, 400))
    }
  } else if (msg.type === 'system' && msg.subtype === 'init') {
    console.log('INIT OK')
  }
}
if (!final) console.log('NO RESULT')
console.log('done')
