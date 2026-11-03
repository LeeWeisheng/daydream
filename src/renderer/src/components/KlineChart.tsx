/**
 * K 线图（lightweight-charts）：日线蜡烛图 + 均线叠加。
 */
import { useEffect, useRef } from 'react'
import { createChart, ColorType, type IChartApi } from 'lightweight-charts'
import type { Bar } from '@shared/types'

interface Props {
  bars: Bar[]
  height?: number
}

export default function KlineChart({ bars, height = 420 }: Props): React.ReactNode {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)

  useEffect(() => {
    if (!containerRef.current) return
    const chart = createChart(containerRef.current, {
      height,
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: '#8c93a3' },
      grid: {
        vertLines: { color: '#1f242c' },
        horzLines: { color: '#1f242c' }
      },
      timeScale: { borderColor: '#2a303a' }
    })
    chartRef.current = chart
    const candle = chart.addCandlestickSeries({
      upColor: '#e0564b',
      downColor: '#2e9e63',
      borderVisible: false,
      wickUpColor: '#e0564b',
      wickDownColor: '#2e9e63'
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
    addMa(5, '#d9b64a')
    addMa(20, '#4a90d9')
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
  }, [bars, height])

  return <div ref={containerRef} style={{ width: '100%' }} />
}
