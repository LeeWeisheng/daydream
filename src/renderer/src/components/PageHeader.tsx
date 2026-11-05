/**
 * 页面标题区：统一「标题 + 状态标记 + 描述 + 右侧操作」的排版。
 * 页面内容统一使用 .dd-page 容器（自带纵向间距），标题区不再自带下边距。
 */
interface Props {
  title: string
  /** 标题右侧的状态标记（Tag / 版本号等） */
  badge?: React.ReactNode
  description?: React.ReactNode
  extra?: React.ReactNode
}

export default function PageHeader({ title, badge, description, extra }: Props): React.ReactNode {
  return (
    <div className="dd-page-head">
      <div className="dd-page-head-main">
        <div className="dd-page-title-row">
          <h2 className="dd-page-title">{title}</h2>
          {badge}
        </div>
        {description ? <div className="dd-page-desc">{description}</div> : null}
      </div>
      {extra ? <div className="dd-page-actions">{extra}</div> : null}
    </div>
  )
}
