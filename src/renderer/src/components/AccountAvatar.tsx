/**
 * 账户头像：使用 DiceBear `pixel-art` 样式（MIT，像素质感），
 * 以账户名称作为 seed 哈希生成确定性 SVG，同名账户的头像恒定不变。
 * 颜色需传不带 # 前缀的十六进制（DiceBear 内部自行拼接，#xxx 会生成非法 fill 导致透明）。
 */
import { useMemo } from 'react'
import type { CSSProperties, ImgHTMLAttributes } from 'react'
import { createAvatar } from '@dicebear/core'
import * as pixelArtStyle from '@dicebear/pixel-art'

/** 背景调色板：与主题主色相协调的 6 色，按 seed 哈希取色 */
const PALETTE = ['1677ff', '722ed1', '13c2c2', '2f9e44', 'fa8c16', 'eb2f96']

interface AccountAvatarProps extends Omit<ImgHTMLAttributes<HTMLImageElement>, 'name' | 'src' | 'width' | 'height'> {
  /** 账户名称（同时作为 DiceBear 的 seed） */
  name: string
  /** 渲染尺寸（px），18 用于 header 按钮、20 用于下拉项 */
  size?: number
  style?: CSSProperties
}

export default function AccountAvatar({ name, size = 20, style, ...rest }: AccountAvatarProps): React.ReactNode {
  const src = useMemo(
    () =>
      createAvatar(pixelArtStyle, {
        seed: name.trim() || '?',
        size,
        radius: 50,
        backgroundColor: PALETTE
      }).toDataUri(),
    [name, size]
  )

  return (
    <img
      {...rest}
      src={src}
      width={size}
      height={size}
      alt=""
      draggable={false}
      style={{ display: 'block', flex: 'none', borderRadius: '50%', imageRendering: 'pixelated', userSelect: 'none', ...style }}
    />
  )
}
