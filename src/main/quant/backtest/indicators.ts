/**
 * 技术指标库：确定性纯函数实现（回测引擎与信号引擎共用）。
 * 输入为截至某日的价格序列，输出指标序列或最新值。
 * 白名单见 @shared/strategy/schema（INDICATOR_WHITELIST）。
 */

// ---------- 基础统计 ----------
export function sma(values: number[], n: number): number[] {
  const out: number[] = []
  let sum = 0
  for (let i = 0; i < values.length; i++) {
    sum += values[i]
    if (i >= n) sum -= values[i - n]
    out.push(i >= n - 1 ? sum / n : NaN)
  }
  return out
}

export function ema(values: number[], n: number): number[] {
  const out: number[] = []
  const k = 2 / (n + 1)
  let prev = NaN
  for (let i = 0; i < values.length; i++) {
    if (i < n - 1) {
      out.push(NaN)
      continue
    }
    if (i === n - 1) {
      prev = values.slice(0, n).reduce((a, b) => a + b, 0) / n
    } else {
      prev = values[i] * k + prev * (1 - k)
    }
    out.push(prev)
  }
  return out
}

/** Wilder RSI */
export function rsi(closes: number[], n = 14): number[] {
  const out: number[] = []
  let avgGain = NaN
  let avgLoss = NaN
  for (let i = 0; i < closes.length; i++) {
    if (i === 0) {
      out.push(NaN)
      continue
    }
    const change = closes[i] - closes[i - 1]
    const gain = Math.max(change, 0)
    const loss = Math.max(-change, 0)
    if (i === n) {
      // 初始平均
      let g = 0
      let l = 0
      for (let j = 1; j <= n; j++) {
        const c = closes[j] - closes[j - 1]
        g += Math.max(c, 0)
        l += Math.max(-c, 0)
      }
      avgGain = g / n
      avgLoss = l / n
    } else if (i > n) {
      avgGain = (avgGain * (n - 1) + gain) / n
      avgLoss = (avgLoss * (n - 1) + loss) / n
    }
    if (i < n) {
      out.push(NaN)
    } else {
      out.push(avgLoss === 0 ? (avgGain === 0 ? 50 : 100) : 100 - 100 / (1 + avgGain / avgLoss))
    }
  }
  return out
}

export interface MacdResult {
  dif: number[]
  dea: number[]
  hist: number[]
}

export function macd(closes: number[], fast = 12, slow = 26, signal = 9): MacdResult {
  const emaFast = ema(closes, fast)
  const emaSlow = ema(closes, slow)
  const dif: number[] = []
  for (let i = 0; i < closes.length; i++) {
    dif.push(isNaN(emaFast[i]) || isNaN(emaSlow[i]) ? NaN : emaFast[i] - emaSlow[i])
  }
  const dea = ema(
    dif.map((v) => (isNaN(v) ? 0 : v)),
    signal
  ).map((v, i) => (isNaN(dif[i]) ? NaN : v))
  const hist = dif.map((v, i) => (isNaN(v) || isNaN(dea[i]) ? NaN : v - dea[i]))
  return { dif, dea, hist }
}

/** 真实波幅 ATR */
export function atr(highs: number[], lows: number[], closes: number[], n = 14): number[] {
  const trs: number[] = [NaN]
  for (let i = 1; i < closes.length; i++) {
    trs.push(
      Math.max(
        highs[i] - lows[i],
        Math.abs(highs[i] - closes[i - 1]),
        Math.abs(lows[i] - closes[i - 1])
      )
    )
  }
  const out: number[] = []
  let prev = NaN
  for (let i = 1; i < trs.length; i++) {
    if (i === n) {
      prev = trs.slice(1, n + 1).reduce((a, b) => a + b, 0) / n
    } else if (i > n) {
      prev = (prev * (n - 1) + trs[i]) / n
    }
    out.push(i >= n ? prev : NaN)
  }
  out.unshift(NaN)
  return out
}

export interface BollResult {
  upper: number[]
  mid: number[]
  lower: number[]
}

export function boll(closes: number[], n = 20, k = 2): BollResult {
  const mid = sma(closes, n)
  const upper: number[] = []
  const lower: number[] = []
  for (let i = 0; i < closes.length; i++) {
    if (isNaN(mid[i])) {
      upper.push(NaN)
      lower.push(NaN)
      continue
    }
    const window = closes.slice(i - n + 1, i + 1)
    const mean = mid[i]
    const variance = window.reduce((a, b) => a + (b - mean) ** 2, 0) / n
    const std = Math.sqrt(variance)
    upper.push(mean + k * std)
    lower.push(mean - k * std)
  }
  return { upper, mid, lower }
}

/** 动量（n 日涨跌幅） */
export function momentum(closes: number[], n: number): number[] {
  const out: number[] = []
  for (let i = 0; i < closes.length; i++) {
    out.push(i >= n ? closes[i] / closes[i - n] - 1 : NaN)
  }
  return out
}

/** 量比：当日成交量 / n 日均量 */
export function volumeRatio(volumes: number[], n = 20): number[] {
  const avg = sma(volumes, n)
  return volumes.map((v, i) => (isNaN(avg[i]) || avg[i] === 0 ? NaN : v / avg[i]))
}

/** OBV（能量潮） */
export function obv(closes: number[], volumes: number[]): number[] {
  const out: number[] = []
  let acc = 0
  for (let i = 0; i < closes.length; i++) {
    if (i === 0) {
      acc = 0
    } else if (closes[i] > closes[i - 1]) {
      acc += volumes[i]
    } else if (closes[i] < closes[i - 1]) {
      acc -= volumes[i]
    }
    out.push(acc)
  }
  return out
}

/** 均线金叉/死叉检测：返回最后一根 bar 是否发生交叉 */
export function crossDetect(seriesFast: number[], seriesSlow: number[]): { up: boolean; down: boolean } {
  const n = seriesFast.length
  if (n < 2) return { up: false, down: false }
  const f0 = seriesFast[n - 1]
  const f1 = seriesFast[n - 2]
  const s0 = seriesSlow[n - 1]
  const s1 = seriesSlow[n - 2]
  if ([f0, f1, s0, s1].some((v) => isNaN(v))) return { up: false, down: false }
  return { up: f1 <= s1 && f0 > s0, down: f1 >= s1 && f0 < s0 }
}
