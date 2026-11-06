/**
 * 数据源适配器：MarketDataProvider 抽象 + 限频队列 + 健康检查与自动降级。
 * 按能力路由：次选源不具备的能力（如分钟线）仍由首选源提供。
 * 全部源不可用时挂起更新任务并告警（不影响已入库数据的查询与回测）。
 */
import type { Bar, Quote, StockBasic } from '@shared/types'
import { logger } from '../../services/logger'

export interface IndexBar {
  indexCode: string
  date: string
  open: number
  high: number
  low: number
  close: number
  volume: number
  amount: number
}

export interface MarketDataProvider {
  readonly name: string
  /** 能力集合 */
  readonly capabilities: { stockList: boolean; quote: boolean; dailyKline: boolean; minuteKline: boolean; indexDaily: boolean; adjFactors: boolean }
  getStockList(): Promise<StockBasic[]>
  getQuote(codes: string[]): Promise<Quote[]>
  getDailyKline(code: string, start: string, end: string, adjusted?: boolean): Promise<Bar[]>
  getMinuteKline(code: string, period: string, count: number): Promise<Bar[]>
  getIndexDaily(code: string, start: string, end: string): Promise<IndexBar[]>
}

// ---------- 限频队列（令牌桶） ----------
export class RateLimiter {
  private tokens: number
  private lastRefill: number
  private queue: Array<() => void> = []

  constructor(private ratePerSec: number, private burst = ratePerSec) {
    this.tokens = burst
    this.lastRefill = Date.now()
  }

  /** 获取令牌；返回 Promise，在允许时 resolve */
  async acquire(): Promise<void> {
    this.refill()
    if (this.tokens >= 1) {
      this.tokens -= 1
      return
    }
    await new Promise<void>((resolve) => {
      this.queue.push(resolve)
      if (!this.timer) this.startTimer()
    })
  }

  private timer: ReturnType<typeof setTimeout> | null = null

  private startTimer(): void {
    this.timer = setTimeout(() => {
      this.refill()
      while (this.tokens >= 1 && this.queue.length > 0) {
        this.tokens -= 1
        const resolve = this.queue.shift()!
        resolve()
      }
      this.timer = null
      if (this.queue.length > 0) this.startTimer()
    }, 100)
  }

  private refill(): void {
    const now = Date.now()
    const elapsed = (now - this.lastRefill) / 1000
    this.tokens = Math.min(this.tokens + elapsed * this.ratePerSec, this.burst)
    this.lastRefill = now
  }
}

// ---------- 管理器 ----------
export class ProviderManager {
  private providers: MarketDataProvider[] = []
  private health = new Map<string, { ok: boolean; lastCheck: number }>()
  private limiter: RateLimiter
  private suspended = false

  constructor(ratePerSec = 3) {
    this.limiter = new RateLimiter(ratePerSec)
  }

  register(provider: MarketDataProvider): void {
    this.providers.push(provider)
    this.health.set(provider.name, { ok: true, lastCheck: 0 })
  }

  get allSuspended(): boolean {
    return this.suspended
  }

  private async call<T>(capability: keyof MarketDataProvider['capabilities'], fn: (p: MarketDataProvider) => Promise<T>): Promise<T> {
    const candidates = this.providers.filter((p) => this.health.get(p.name)?.ok !== false && p.capabilities[capability])
    if (candidates.length === 0) {
      // 全部不健康或全部不具备该能力
      throw new Error(`[data] no healthy provider for capability ${capability}`)
    }
    let lastErr: Error | null = null
    for (const provider of candidates) {
      try {
        await this.limiter.acquire()
        const result = await Promise.race([
          fn(provider),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${provider.name} timeout`)), 10_000))
        ])
        this.markHealthy(provider.name, true)
        return result
      } catch (e) {
        lastErr = e as Error
        this.markHealthy(provider.name, false)
        logger.warn(`[data] provider ${provider.name} failed for ${capability}: ${(e as Error).message}，切换备用源`)
      }
    }
    throw lastErr ?? new Error('[data] all providers failed')
  }

  private markHealthy(name: string, ok: boolean): void {
    const h = this.health.get(name)
    if (h) {
      h.ok = ok
      h.lastCheck = Date.now()
    }
    this.suspended = this.providers.every((p) => this.health.get(p.name)?.ok === false)
  }

  /** 恢复尝试：健康检查周期后重置状态 */
  resetIfPossible(): void {
    const now = Date.now()
    for (const p of this.providers) {
      const h = this.health.get(p.name)
      if (h && !h.ok && now - h.lastCheck > 5 * 60_000) h.ok = true
    }
  }

  getStockList(): Promise<StockBasic[]> {
    return this.call('stockList', (p) => p.getStockList())
  }
  getQuote(codes: string[]): Promise<Quote[]> {
    return this.call('quote', (p) => p.getQuote(codes))
  }
  getDailyKline(code: string, start: string, end: string, adjusted = false): Promise<Bar[]> {
    return this.call('dailyKline', (p) => p.getDailyKline(code, start, end, adjusted))
  }
  getMinuteKline(code: string, period: string, count: number): Promise<Bar[]> {
    return this.call('minuteKline', (p) => p.getMinuteKline(code, period, count))
  }
  getIndexDaily(code: string, start: string, end: string): Promise<IndexBar[]> {
    return this.call('indexDaily', (p) => p.getIndexDaily(code, start, end))
  }
}

/** 全局单例管理器 */
export const providerManager = new ProviderManager(3)
