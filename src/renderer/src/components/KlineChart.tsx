/**
 * K 线图（lightweight-charts）：日线蜡烛图 + 均线叠加。
 * 图表颜色统一使用 antd token。
 */
import { useEffect, useRef } from 'react'
import { createChart, ColorType, type IChartApi } from 'lightweight-charts'
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
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: token.colorTextSecondary },
      grid: {
        vertLines: { color: token.colorBorderSecondary },
        horzLines: { color: token.colorBorderSecondary }
      },
      timeScale: { borderColor: token.colorBorder }
    })
    chartRef.current = chart
    const candle = chart.addCandlestickSeries({
      upColor: token.colorError,
      downColor: token.colorSuccess,
      borderVisible: false,
      wickUpColor: token.colorError,
      wickDownColor: token.colorSuccess
    })
    const data = bars.map((b) => ({
      time: b.date,
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close
    }))
    candle.setData(data)

    // MA5 / MA20 叠加
    const addMa = (n: number, color: string): void => {
      const ma = chart.addLineSeries({ color, lineWidth: 1, priceLineVisible: false })
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

  return <div ref={containerRef} style={{ width: '100%' }} />
}
