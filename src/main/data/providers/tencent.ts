/**
 * 腾讯行情公开接口适配器（次选源）。
 * 能力：实时行情、日 K（分钟线走分时接口，能力标记为不具备分钟 K，由首选源兜底）。
 */
import type { Bar, Quote, StockBasic } from '@shared/types'
import type { IndexBar, MarketDataProvider } from './base'

function toTencentCode(code: string): string {
  if (code.startsWith('6')) return `sh${code}`
  if (code.startsWith('8') || code.startsWith('4') || code.startsWith('92')) return `bj${code}`
  return `sz${code}`
}

async function fetchText(url: string): Promise<string> {
  const resp = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://stockapp.finance.qq.com/' }
  })
  if (!resp.ok) throw new Error(`tencent http ${resp.status}`)
  return resp.text()
}

export class TencentProvider implements MarketDataProvider {
  readonly name = 'tencent'
  readonly capabilities = {
    stockList: false, // 不具备全市场列表能力（由东财提供）
    quote: true,
    dailyKline: true,
    minuteKline: false,
    indexDaily: true,
    adjFactors: false
  }

  async getStockList(): Promise<StockBasic[]> {
    throw new Error('tencent does not support stock list')
  }

  async getQuote(codes: string[]): Promise<Quote[]> {
    if (codes.length === 0) return []
    const qcodes = codes.map(toTencentCode).join(',')
    const text = await fetchText(`https://qt.gtimg.cn/q=${qcodes}`)
    const now = new Date().toISOString()
    const out: Quote[] = []
    for (const line of text.split(';')) {
      const m = line.match(/v_(\w+)="([^"]*)"/)
      if (!m) continue
      const tcode = m[1]
      const fields = m[2].split('~')
      if (fields.length < 40) continue
      out.push({
        code: tcode.slice(2),
        name: fields[1],
        price: Number(fields[3]) || 0,
        prevClose: Number(fields[4]) || 0,
        open: Number(fields[5]) || 0,
        volume: Number(fields[6]) || 0,
        high: Number(fields[33]) || 0,
        low: Number(fields[34]) || 0,
        amount: Number(fields[37]) || 0,
        pctChg: Number(fields[32]) || 0,
        ts: now
      })
    }
    return out
  }

  async getDailyKline(code: string, start: string, end: string, adjusted = false): Promise<Bar[]> {
    const tcode = toTencentCode(code)
    // fqkline 接口：qfq 前复权 / hfq 后复权 / 空 不复权
    const fq = adjusted ? 'hfq' : ''
    const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${tcode},day,${start},${end},640,${fq}`
    const text = await fetchText(url)
    const data = JSON.parse(text) as {
      data?: { [code: string]: { qfqday?: string[][]; hfqday?: string[][]; day?: string[][] } }
    }
    const node = data.data?.[tcode]
    if (!node) throw new Error(`tencent kline no data for ${code}`)
    const rows = adjusted ? node.hfqday ?? node.qfqday : node.day
    if (!rows) throw new Error(`tencent kline empty for ${code}`)
    return rows.map((r) => ({
      code,
      date: r[0],
      open: Number(r[1]),
      close: Number(r[2]),
      high: Number(r[3]),
      low: Number(r[4]),
      volume: Number(r[5]),
      amount: 0,
      adjFactor: 1
    }))
  }

  async getMinuteKline(_code: string, _period: string, _count: number): Promise<Bar[]> {
    throw new Error('tencent minute kline not supported (routed to eastmoney)')
  }

  async getIndexDaily(code: string, start: string, end: string): Promise<IndexBar[]> {
    const tcode = toTencentCode(code)
    const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${tcode},day,${start},${end},640,`
    const text = await fetchText(url)
    const data = JSON.parse(text) as { data?: { [code: string]: { day?: string[][] } } }
    const rows = data.data?.[tcode]?.day
    if (!rows) throw new Error(`tencent index kline empty for ${code}`)
    return rows.map((r) => ({
      indexCode: code,
      date: r[0],
      open: Number(r[1]),
      close: Number(r[2]),
      high: Number(r[3]),
      low: Number(r[4]),
      volume: Number(r[5]),
      amount: 0
    }))
  }
}
