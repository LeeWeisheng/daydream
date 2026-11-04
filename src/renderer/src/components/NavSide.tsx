/**
 * Sider 自研导航（shadcn 风格：圆角菜单项 + 背景高亮选中态，无 antd Menu 默认样式）。
 * 始终展开显示「图标 + 名称」，永不收起。
 * 按账户相关性拆分：
 * - 上方：首页（对话流）、交易（资金/持仓）、策略（每账户唯一策略）——按账户隔离；
 * - 下方（sider 底部）：规划（Agent 执行规划）、数据（行情全局共享）、设置（模型/主题全局配置）——与账户无关。
 */
import { HomeOutlined, StockOutlined, NodeIndexOutlined, ScheduleOutlined, DatabaseOutlined, SettingOutlined } from '@ant-design/icons'

export interface NavItem {
  key: string
  label: string
  icon: React.ReactNode
}

interface NavGroup {
  key: string
  /** 是否固定到 sider 底部 */
  bottom?: boolean
  items: NavItem[]
}

const NAV_GROUPS: NavGroup[] = [
  {
    key: 'account',
    items: [
      { key: 'home', label: '首页', icon: <HomeOutlined /> },
      { key: 'trade', label: '交易', icon: <StockOutlined /> },
      { key: 'strategy', label: '策略', icon: <NodeIndexOutlined /> }
    ]
  },
  {
    key: 'system',
    bottom: true,
    items: [
      { key: 'plan', label: '规划', icon: <ScheduleOutlined /> },
      { key: 'data', label: '数据', icon: <DatabaseOutlined /> },
      { key: 'settings', label: '设置', icon: <SettingOutlined /> }
    ]
  }
]

interface Props {
  page: string
  onNavigate: (key: string) => void
}

export default function NavSide({ page, onNavigate }: Props): React.ReactNode {
  return (
    <aside className="dd-sidebar">
      <div className="dd-sidebar-content" role="navigation" aria-label="主导航">
        {NAV_GROUPS.map((group) => (
          <div key={group.key} className={`dd-sidebar-group${group.bottom ? ' dd-sidebar-group-bottom' : ''}`}>
            <div className="dd-sidebar-menu">
              {group.items.map((item) => (
                <button
                  key={item.key}
                  data-active={page === item.key || undefined}
                  className="dd-sidebar-item"
                  onClick={() => onNavigate(item.key)}
                  aria-current={page === item.key ? 'page' : undefined}
                >
                  <span className="dd-sidebar-icon">{item.icon}</span>
                  <span className="dd-sidebar-label">{item.label}</span>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </aside>
  )
}
