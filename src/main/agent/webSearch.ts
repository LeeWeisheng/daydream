/**
 * DeepSeek 原生 Web Search：经 Anthropic 兼容 Messages API 发起辅助搜索请求。
 * 机制（官方文档）：请求携带服务端原生工具 { type: 'web_search_20250305', name: 'web_search', max_uses }，
 * 服务端执行搜索后返回 server_tool_use + web_search_tool_result + text（模型基于搜索结果的总结）块。
 * 注意：结果正文（encrypted_content）为服务端加密，不可外部处理；工具返回 text 总结与明文来源（title/url）。
 * 每次搜索消耗一次完整模型轮次（延迟与 token），并产生 Search API 计费。
 */
import { getModelConfig } from '../settings/service'
import { assertLlmAllowed } from './llmGate'

export interface WebSearchResult {
  query: string
  summary: string
  sources: { title: string; url: string; publishedAt?: string }[]
}

interface SearchResponseBlock {
  type: string
  text?: string
  name?: string
  input?: { query?: string }
  content?: Array<{
    type: string
    title?: string
    url?: string
    page_age?: string | null
  }>
}

/** 构造 Messages 端点：baseUrl（如 https://api.deepseek.com/anthropic）→ /v1/messages */
function resolveMessagesUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, '')
  if (/\/v1$/.test(base)) return `${base}/messages`
  return `${base}/v1/messages`
}

export async function deepseekWebSearch(accountId: string, query: string, maxUses = 1): Promise<WebSearchResult> {
  // 联网搜索同样是一次完整模型轮次：必须过闸（停止运行/退出后禁止）
  assertLlmAllowed(accountId, 'web_search')
  const cfg = getModelConfig()
  if (!cfg) throw new Error('未配置模型，无法联网搜索')

  const resp = await fetch(resolveMessagesUrl(cfg.baseUrl), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': cfg.apiKey,
      Authorization: `Bearer ${cfg.apiKey}`,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: cfg.model,
      max_tokens: 2048,
      thinking: { type: 'disabled' },
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: maxUses }],
      messages: [
        {
          role: 'user',
          content: `Perform a web search for the query: ${query}. Summarize the search results in Chinese, include key facts, numbers and dates.`
        }
      ]
    })
  })

  const data = (await resp.json()) as
    | { type: 'error'; error?: { message?: string } }
    | { content?: SearchResponseBlock[] }

  if (!resp.ok || (data as { type?: string }).type === 'error') {
    const message = (data as { error?: { message?: string } }).error?.message ?? `HTTP ${resp.status}`
    throw new Error(`DeepSeek 搜索失败: ${message}`)
  }

  const blocks = (data as { content?: SearchResponseBlock[] }).content ?? []
  const sources: WebSearchResult['sources'] = []
  const seenUrls = new Set<string>()
  for (const block of blocks) {
    if (block.type !== 'web_search_tool_result') continue
    for (const item of block.content ?? []) {
      if (item.type !== 'web_search_result' || !item.url) continue
      if (seenUrls.has(item.url)) continue
      seenUrls.add(item.url)
      sources.push({
        title: item.title ?? item.url,
        url: item.url,
        publishedAt: item.page_age ?? undefined
      })
    }
  }
  const summary = blocks
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('\n')

  if (!summary && sources.length === 0) {
    throw new Error('DeepSeek 搜索未返回结果（可能是空结果或端点不支持）')
  }
  return { query, summary, sources }
}
