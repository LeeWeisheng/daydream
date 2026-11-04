/**
 * Header 自绘 SVG 图标：
 * 统一 24 viewBox / stroke 2 / 1em 渲染（跟随按钮字号，small button = 14px），
 * 图形主体填充 24×24 视觉空间，与 antd outlined 图标（SunOutlined 等）视觉尺寸一致。
 */
import type { CSSProperties } from 'react'

/** 统一 SVG 基础属性 */
const BASE_SVG_PROPS = {
  width: '1em',
  height: '1em',
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true
} as const

interface HeaderIconProps {
  style?: CSSProperties
}

/** 手动模式：手形（人手掌/手指轮廓，直观表达“手动操作”） */
export function ManualModeIcon({ style }: HeaderIconProps): React.ReactNode {
  return (
    <svg {...BASE_SVG_PROPS} style={style}>
      <path d="M18 11V6a2 2 0 0 0-2-2 2 2 0 0 0-2 2" />
      <path d="M14 10V4a2 2 0 0 0-2-2 2 2 0 0 0-2 2v2" />
      <path d="M10 10.5V6a2 2 0 0 0-2-2 2 2 0 0 0-2 2v8" />
      <path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15" />
    </svg>
  )
}

/** 自动模式：闪电（饱满对称的折线造型，视觉重量与其它图标一致） */
export function AutoModeIcon({ style }: HeaderIconProps): React.ReactNode {
  return (
    <svg {...BASE_SVG_PROPS} style={style}>
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
    </svg>
  )
}

/** 主题-跟随系统：显示器（屏幕 + 底座，直观表达“跟随操作系统主题”） */
export function SystemThemeIcon({ style }: HeaderIconProps): React.ReactNode {
  return (
    <svg {...BASE_SVG_PROPS} style={style}>
      <rect width="20" height="14" x="2" y="3" rx="2" />
      <line x1="8" x2="16" y1="21" y2="21" />
      <line x1="12" x2="12" y1="17" y2="21" />
    </svg>
  )
}
