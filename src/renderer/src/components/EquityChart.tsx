/**
 * 绩效净值曲线（ECharts）：净值序列对比基准（沪深 300）。
 */
import { useEffect, useRef } from 'react'
import * as echarts from 'echarts'

interface Point {
  date: string
  equity: number
  benchmark: number
}

interface Props {
  points: Point[]
  height?: number
}

export default function EquityChart({ points, height = 320 }: Props): React.ReactNode {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!ref.current || points.length === 0) return
    const chart = echarts.init(ref.current, undefined, { renderer: 'svg' })
    // 归一化到 1
    const base = points[0].equity || 1
    const benchBase = points[0].benchmark || 1
    chart.setOption({
      backgroundColor: 'transparent',
      tooltip: { trigger: 'axis' },
      legend: { data: ['策略净值', '基准（沪深300）'], textStyle: { color: '#8c93a3' } },
      grid: { left: 50, right: 16, top: 36, bottom: 28 },
      xAxis: {
        type: 'category',
        data: points.map((p) => p.date),
        axisLine: { lineStyle: { color: '#2a303a' } },
        axisLabel: { color: '#8c93a3' }
      },
      yAxis: {
        type: 'value',
        scale: true,
        axisLabel: { color: '#8c93a3' },
        splitLine: { lineStyle: { color: '#1f242c' } }
      },
      series: [
        {
          name: '策略净值',
          type: 'line',
          data: points.map((p) => Math.round((p.equity / base) * 1000) / 1000),
          showSymbol: false,
          lineStyle: { color: '#1677ff', width: 1.5 },
          areaStyle: { color: 'rgba(22,119,255,0.08)' }
        },
        {
          name: '基准（沪深300）',
          type: 'line',
          data: points.map((p) => Math.round((p.benchmark / benchBase) * 1000) / 1000),
          showSymbol: false,
          lineStyle: { color: '#8c93a3', width: 1 }
        }
      ]
    })
    const handleResize = (): void => chart.resize()
    window.addEventListener('resize', handleResize)
    return () => {
      window.removeEventListener('resize', handleResize)
      chart.dispose()
    }
  }, [points, height])

  return <div ref={ref} style={{ width: '100%', height }} />
}
