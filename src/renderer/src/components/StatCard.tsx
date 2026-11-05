/**
 * 指标卡：标签 / 主数值 / 辅助说明，支持涨跌与主色配色。
 * 用于各页顶部关键数字（资金、绩效、数据规模等）。
 */
import type { CSSProperties } from 'react'
import { useAntdToken } from 'antd-style'

type Tone = 'default' | 'primary' | 'up' | 'down' | 'warning'

interface Props {
  label: React.ReactNode
  value: React.ReactNode
  sub?: React.ReactNode
  tone?: Tone
  icon?: React.ReactNode
  style?: CSSProperties
}

const TONE_KEY: Record<Tone, 'colorText' | 'colorPrimary' | 'colorError' | 'colorSuccess' | 'colorWarning'> = {
  default: 'colorText',
  primary: 'colorPrimary',
  up: 'colorError',
  down: 'colorSuccess',
  warning: 'colorWarning'
}

export default function StatCard({ label, value, sub, tone = 'default', icon, style }: Props): React.ReactNode {
  const token = useAntdToken()
  return (
    <div className="dd-kpi" style={style}>
      <span className="dd-kpi-label">
        {icon}
        {label}
      </span>
      <span className="dd-kpi-value" style={{ color: token[TONE_KEY[tone]] }}>
        {value}
      </span>
      {sub ? <span className="dd-kpi-sub">{sub}</span> : null}
    </div>
  )
}
