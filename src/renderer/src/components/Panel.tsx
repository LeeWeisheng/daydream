/**
 * 内容卡片：统一的边框/圆角（不使用阴影）与「标题 + 右侧操作」头部。
 * 通过 bodyClassName / flush 控制内容区留白，便于表格铺满卡片。
 */
import type { CSSProperties } from 'react'

interface Props {
  title?: React.ReactNode
  /** 标题右侧的说明文字 */
  subtitle?: React.ReactNode
  extra?: React.ReactNode
  children?: React.ReactNode
  className?: string
  bodyClassName?: string
  /** 内容区去掉内边距（表格、图表铺满） */
  flush?: boolean
  /** 头部不显示分隔线 */
  plainHead?: boolean
  style?: CSSProperties
}

export default function Panel({
  title,
  subtitle,
  extra,
  children,
  className,
  bodyClassName,
  flush,
  plainHead,
  style
}: Props): React.ReactNode {
  return (
    <section className={`dd-card${className ? ` ${className}` : ''}`} style={style}>
      {title || extra ? (
        <div className={`dd-card-head${plainHead ? ' dd-card-head-plain' : ''}`}>
          <div className="dd-card-heading">
            {title ? <span className="dd-card-title">{title}</span> : null}
            {subtitle ? <span className="dd-card-sub">{subtitle}</span> : null}
          </div>
          {extra ? <div className="dd-card-actions">{extra}</div> : null}
        </div>
      ) : null}
      <div className={`dd-card-body${flush ? ' dd-card-body-flush' : ''}${bodyClassName ? ` ${bodyClassName}` : ''}`}>
        {children}
      </div>
    </section>
  )
}
