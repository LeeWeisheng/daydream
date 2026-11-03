/**
 * 指标库单元测试：确定性计算正确性。
 */
import { describe, expect, it } from 'vitest'
import { sma, ema, rsi, macd, atr, boll, momentum, volumeRatio, obv, crossDetect } from '../src/main/backtest/indicators'

describe('sma', () => {
  it('计算简单移动平均', () => {
    const out = sma([1, 2, 3, 4, 5], 3)
    expect(out[0]).toBeNaN()
    expect(out[1]).toBeNaN()
    expect(out[2]).toBe(2) // (1+2+3)/3
    expect(out[3]).toBe(3) // (2+3+4)/3
    expect(out[4]).toBe(4) // (3+4+5)/3
  })
})

describe('ema', () => {
  it('初始值为前 n 期均值', () => {
    const out = ema([1, 2, 3, 4, 5], 3)
    expect(out[2]).toBeCloseTo(2)
    expect(out[4]).toBeGreaterThan(out[2])
  })
})

describe('rsi', () => {
  it('单调上涨序列 RSI=100', () => {
    const closes = Array.from({ length: 30 }, (_, i) => 10 + i)
    const out = rsi(closes, 14)
    expect(out[out.length - 1]).toBeCloseTo(100)
  })
  it('单调下跌序列 RSI=0', () => {
    const closes = Array.from({ length: 30 }, (_, i) => 100 - i)
    const out = rsi(closes, 14)
    expect(out[out.length - 1]).toBeCloseTo(0)
  })
})

describe('macd', () => {
  it('输出长度与输入一致', () => {
    const closes = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 5) * 10)
    const { dif, dea, hist } = macd(closes)
    expect(dif.length).toBe(closes.length)
    expect(dea.length).toBe(closes.length)
    expect(hist.length).toBe(closes.length)
    expect(dif[closes.length - 1]).toBeCloseTo(hist[closes.length - 1] + dea[closes.length - 1], 6)
  })
})

describe('atr', () => {
  it('波动为 2 的序列 ATR 约为 2', () => {
    const n = 30
    const highs = Array.from({ length: n }, (_, i) => 10 + i + 1)
    const lows = Array.from({ length: n }, (_, i) => 10 + i - 1)
    const closes = Array.from({ length: n }, (_, i) => 10 + i)
    const out = atr(highs, lows, closes, 14)
    expect(out[out.length - 1]).toBeCloseTo(2, 5)
  })
})

describe('boll', () => {
  it('常数序列带宽为 0', () => {
    const closes = Array.from({ length: 30 }, () => 100)
    const { upper, mid, lower } = boll(closes, 20, 2)
    expect(upper[upper.length - 1]).toBeCloseTo(100)
    expect(mid[mid.length - 1]).toBeCloseTo(100)
    expect(lower[lower.length - 1]).toBeCloseTo(100)
  })
})

describe('momentum / volumeRatio / obv / crossDetect', () => {
  it('momentum 计算 n 日涨跌幅', () => {
    const closes = [100, 101, 102, 103, 104]
    expect(momentum(closes, 2)[4]).toBeCloseTo(104 / 102 - 1)
  })
  it('volumeRatio 计算量比', () => {
    const volumes = [100, 100, 100, 100, 200]
    // n=4：最近 4 日均量 = (100+100+100+200)/4 = 125，当日量比 = 200/125 = 1.6
    expect(volumeRatio(volumes, 4)[4]).toBeCloseTo(1.6)
  })
  it('obv 上涨累加成交量', () => {
    const out = obv([10, 11, 12], [100, 200, 300])
    expect(out[2]).toBe(500)
  })
  it('crossDetect 检测金叉/死叉', () => {
    expect(crossDetect([1, 2, 3], [2, 2, 2]).up).toBe(true)
    expect(crossDetect([3, 2, 1], [2, 2, 2]).down).toBe(true)
  })
})
