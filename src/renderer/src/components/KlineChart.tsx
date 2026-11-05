/**
 * K 线图（lightweight-charts）：日线蜡烛图 + MA5/MA20 均线 + 成交量。
 * 图表颜色统一使用 antd token，随亮/暗主题切换。
 */
import { useEffect, useRef } from 'react'
import { createChart, ColorType, CrosshairMode, type IChartApi } from 'lightweight-charts'
import { useAntdToken } from 'antd-style'
import type { Bar } from '@shared/types'

interface Props {
  bars: Bar[]
  height?: number
}

export default function KlineChart({ bars, height = 420 }: Props): React.ReactNode {
  const token = useAntdToken()
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)

  useEffect(() => {
    if (!containerRef.current) return
    const chart = createChart(containerRef.current, {
      height,
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: token.colorTextSecondary,
        fontSize: 11
      },
      grid: {
        vertLines: { color: token.colorBorderSecondary },
        horzLines: { color: token.colorBorderSecondary }
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: token.colorTextTertiary, labelBackgroundColor: token.colorPrimary },
        horzLine: { color: token.colorTextTertiary, labelBackgroundColor: token.colorPrimary }
      },
      rightPriceScale: { borderColor: token.colorBorderSecondary },
      timeScale: { borderColor: token.colorBorderSecondary, rightOffset: 2 }
    })
    chartRef.current = chart

    // 成交量（独立价格轴，压缩到下方 20% 区域）
    const volume = chart.addHistogramSeries({
      priceFormat: { type: 'volume' },
      priceScaleId: 'volume',
      priceLineVisible: false,
      lastValueVisible: false
    })
    volume.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } })
    volume.setData(
      bars.map((b) => ({
        time: b.date,
        value: b.volume,
        color: b.close >= b.open ? `${token.colorError}55` : `${token.colorSuccess}55`
      }))
    )

    const candle = chart.addCandlestickSeries({
      upColor: token.colorError,
      downColor: token.colorSuccess,
      borderVisible: false,
      wickUpColor: token.colorError,
      wickDownColor: token.colorSuccess,
      priceScaleId: 'right'
    })
    // 主图区域不与成交量重叠
    chart.priceScale('right').applyOptions({ scaleMargins: { top: 0.08, bottom: 0.22 } })
    candle.setData(
      bars.map((b) => ({
        time: b.date,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close
      }))
    )

    // MA5 / MA20 叠加
    const addMa = (n: number, color: string): void => {
      const ma = chart.addLineSeries({ color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false })
      const values: { time: string; value: number }[] = []
      let sum = 0
      bars.forEach((b, i) => {
        sum += b.close
        if (i >= n) sum -= bars[i - n].close
        if (i >= n - 1) values.push({ time: b.date, value: Math.round((sum / n) * 100) / 100 })
      })
      ma.setData(values)
    }
    addMa(5, token.colorWarning)
    addMa(20, token.colorPrimary)
    chart.timeScale().fitContent()

    const handleResize = (): void => {
      if (containerRef.current) chart.applyOptions({ width: containerRef.current.clientWidth })
    }
    window.addEventListener('resize', handleResize)
    return () => {
      window.removeEventListener('resize', handleResize)
      chart.remove()
      chartRef.current = null
    }
  }, [bars, height, token])

  return (
    <div>
      <div className="dd-toolbar" style={{ gap: 12, fontSize: 11, marginBottom: 4, color: token.colorTextTertiary }}>
        <span style={{ color: token.colorWarning }}>— MA5</span>
        <span style={{ color: token.colorPrimary }}>— MA20</span>
        <span style={{ marginLeft: 'auto' }}>成交量（下方柱状）</span>
      </div>
      <div ref={containerRef} style={{ width: '100%' }} />
    </div>
  )
}
