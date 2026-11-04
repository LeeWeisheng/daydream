/**
 * App 布局：header（自绘标题栏）+ sider（自研导航 shadcn 风格）+ content。
 * 页面：首页 / 交易 / 策略 / 规划 / 数据 / 设置（与导航无关的功能已删除）。
 * 主题：AppThemeProvider（antd-style）统一配置 antd token / 组件 token / 全局样式。
 */
import { useEffect, useState } from 'react'
import { message } from 'antd'
import { useAppStore } from './stores'
import { AppThemeProvider } from './theme'
import AppHeader from './components/AppHeader'
import NavSide from './components/NavSide'
import ModelConfigModal from './components/ModelConfigModal'
import AccountSetup from './pages/AccountSetup'
import Home from './pages/Home'
import Trade from './pages/Trade'
import StrategyPage from './pages/Strategy'
import Plan from './pages/Plan'
import Data from './pages/Data'
import Settings from './pages/Settings'

const PAGES: Record<string, { title: string; node: React.ReactNode }> = {
  home: { title: '首页', node: <Home /> },
  trade: { title: '交易', node: <Trade /> },
  strategy: { title: '策略', node: <StrategyPage /> },
  plan: { title: '规划', node: <Plan /> },
  data: { title: '数据', node: <Data /> },
  settings: { title: '设置', node: <Settings /> }
}

function AppInner(): React.ReactNode {
  const { accounts, currentAccount, init } = useAppStore()
  const [page, setPage] = useState('home')
  const [initialized, setInitialized] = useState(false)

  useEffect(() => {
    init()
      .then(() => setInitialized(true))
      .catch(() => {
        setInitialized(true)
        message.error('初始化失败')
      })
  }, [init])

  // 无账户：必须先创建账户才能进入主界面
  if (initialized && accounts.length === 0) {
    return <AccountSetup />
  }

  return (
    <div className="dd-app">
      <AppHeader />
      <div className="dd-body">
        <NavSide page={page} onNavigate={setPage} />
        <main className="dd-content">{PAGES[page]?.node ?? <Home />}</main>
      </div>
      {/* 进入主界面后强制配置模型（全局通用） */}
      {initialized && currentAccount && <ModelConfigModal />}
    </div>
  )
}

export default function App(): React.ReactNode {
  return (
    <AppThemeProvider>
      <AppInner />
    </AppThemeProvider>
  )
}
