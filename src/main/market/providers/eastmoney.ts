/**
 * 东方财富公开行情接口适配器（首选源）。
 * 能力：股票列表、实时行情、日/分钟 K 线、指数日线、复权（hfq）。
 * 公开接口仅供个人研究使用，需限频；字段变化时按错误信息排查调整。
 */
import type { Bar, Quote, StockBasic } from '@shared/types'
import type { IndexBar, MarketDataProvider } from './base'

const HOST = 'https://push2.eastmoney.com'
const HOST_HIS = 'https://push2his.eastmoney.com'

/** 深市/沪市/北交所前缀 → 东财 secid 市场号 */
function toSecId(code: string): string {
  if (code.startsWith('6') || code.startsWith('9') || code.startsWith('5')) return `1.${code}`
  if (code.startsWith('8') || code.startsWith('4') || code.startsWith('92')) return `0.${code}` // 北交所并入深市通道（接口按 0 处理）
  return `0.${code}`
}

async function fetchJson(url: string): Promise<unknown> {
  const resp = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
      Referer: 'https://quote.eastmoney.com/'
    }
  })
  if (!resp.ok) throw new Error(`eastmoney http ${resp.status}`)
  return resp.json()
}

export class EastmoneyProvider implements MarketDataProvider {
  readonly name = 'eastmoney'
  readonly capabilities = {
    stockList: true,
    quote: true,
    dailyKline: true,
    minuteKline: true,
    indexDaily: true,
    adjFactors: true
  }

  async getStockList(): Promise<StockBasic[]> {
    const out: StockBasic[] = []
    const markets = [
      'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23', // 沪深 A 股
      'm:0+t:81+s:2048' // 北交所
    ]
    for (const fs of markets) {
      for (let page = 1; page <= 100; page++) {
        const url = `${HOST}/api/qt/clist/get?pn=${page}&pz=200&po=1&np=1&fltt=2&invt=2&fid=f12&fs=${encodeURIComponent(fs)}&fields=f12,f14`
        const data = (await fetchJson(url)) as { data?: { diff?: Array<{ f12: string; f14: string }> } }
        const diff = data.data?.diff
        if (!diff || diff.length === 0) break
        for (const item of diff) {
          const code = item.f12
          const exchange = code.startsWith('6') ? 'SH' : code.startsWith('8') || code.startsWith('4') || code.startsWith('92') ? 'BJ' : 'SZ'
          out.push({ code, name: item.f14, exchange, status: 'listed' })
        }
        if (diff.length < 200) break
      }
    }
    return out
  }

  async getQuote(codes: string[]): Promise<Quote[]> {
    if (codes.length === 0) return []
    const secids = codes.map(toSecId).join(',')
    const url = `${HOST}/api/qt/ulist.np/get?fltt=2&invt=2&secids=${encodeURIComponent(secids)}&fields=f12,f14,f2,f3,f4,f5,f6,f15,f16,f17,f18`
    const data = (await fetchJson(url)) as { data?: { diff?: Array<Record<string, number | string>> } }
    const diff = data.data?.diff ?? []
    const now = new Date().toISOString()
    return diff.map((item) => ({
      code: String(item.f12),
      name: String(item.f14 ?? ''),
      price: Number(item.f2 ?? 0),
      pctChg: Number(item.f3 ?? 0) / 100,
      open: Number(item.f17 ?? 0),
      high: Number(item.f15 ?? 0),
      low: Number(item.f16 ?? 0),
      prevClose: Number(item.f18 ?? 0),
      volume: Number(item.f5 ?? 0),
      amount: Number(item.f6 ?? 0),
      ts: now
    }))
  }

  async getDailyKline(code: string, start: string, end: string, adjusted = false): Promise<Bar[]> {
    // fqt: 0 不复权 / 1 前复权 / 2 后复权
    const fqt = adjusted ? 2 : 0
    const url = `${HOST_HIS}/api/qt/stock/kline/get?secid=${toSecId(code)}&klt=101&fqt=${fqt}&beg=${start.replace(/-/g, '')}&end=${end.replace(/-/g, '')}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61`
    const data = (await fetchJson(url)) as { data?: { klines?: string[]; name?: string } }
    const klines = data.data?.klines ?? []
    return klines.map((line) => {
      // 日期,开,收,高,低,成交量,成交额,振幅,涨跌幅,涨跌额,换手率
      const parts = line.split(',')
      const date = parts[0]
      const open = Number(parts[1])
      const close = Number(parts[2])
      const high = Number(parts[3])
      const low = Number(parts[4])
      const volume = Number(parts[5])
      const amount = Number(parts[6])
      return {
        code,
        date,
        open,
        high,
        low,
        close,
        volume,
        amount,
        // adjusted=true 时返回的是后复权价，adjFactor 由数据管线对比不复权价计算
        adjFactor: 1
      }
    })
  }

  async getMinuteKline(code: string, period: string, count: number): Promise<Bar[]> {
    const klt = period === '1m' ? 1 : period === '5m' ? 5 : period === '15m' ? 15 : period === '30m' ? 30 : 60
    const url = `${HOST_HIS}/api/qt/stock/kline/get?secid=${toSecId(code)}&klt=${klt}&fqt=0&lmt=${count}&end=20500101&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57`
    const data = (await fetchJson(url)) as { data?: { klines?: string[] } }
    const klines = data.data?.klines ?? []
    return klines.map((line) => {
      const parts = line.split(',')
      const date = parts[0].slice(0, 10)
      return {
        code,
        date,
        open: Number(parts[1]),
        close: Number(parts[2]),
        high: Number(parts[3]),
        low: Number(parts[4]),
        volume: Number(parts[5]),
        amount: Number(parts[6]),
        adjFactor: 1
      }
    })
  }

  async getIndexDaily(code: string, start: string, end: string): Promise<IndexBar[]> {
    // 指数代码：000001(上证) 1.000001 / 399001(深证成指) 0.399001 / 399300(沪深300) 0.399300
    const secid = code.startsWith('399') ? `0.${code}` : `1.${code}`
    const url = `${HOST_HIS}/api/qt/stock/kline/get?secid=${secid}&klt=101&fqt=0&beg=${start.replace(/-/g, '')}&end=${end.replace(/-/g, '')}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57`
    const data = (await fetchJson(url)) as { data?: { klines?: string[] } }
    const klines = data.data?.klines ?? []
    return klines.map((line) => {
      const parts = line.split(',')
      return {
        indexCode: code,
        date: parts[0],
        open: Number(parts[1]),
        close: Number(parts[2]),
        high: Number(parts[3]),
        low: Number(parts[4]),
        volume: Number(parts[5]),
        amount: Number(parts[6])
      }
    })
  }
}
