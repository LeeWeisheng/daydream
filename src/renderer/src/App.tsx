/**
 * App 布局：左导航（页面）+ 顶栏（账户切换器、Agent 状态灯、待决策角标、通知中心）+ 内容区。
 * 页面：仪表盘 / 行情 / 策略中心 / 回测 / 运行与信号 / 盯盘 / 复盘 / 待决策中心 / 审计 / 设置。
 */
import { useEffect, useState } from 'react'
import { Layout, Menu, Select, Badge, Tag, Button, Space, message } from 'antd'
import {
  DashboardOutlined,
  LineChartOutlined,
  ExperimentOutlined,
  HistoryOutlined,
  SendOutlined,
  EyeOutlined,
  FileTextOutlined,
  CheckSquareOutlined,
  AuditOutlined,
  SettingOutlined,
  RobotOutlined,
  PlayCircleOutlined,
  PauseCircleOutlined
} from '@ant-design/icons'
import { useAppStore } from './stores'
import AccountSetup from './pages/AccountSetup'
import ModelConfigModal from './components/ModelConfigModal'
import Dashboard from './pages/Dashboard'
import Market from './pages/Market'
import Strategies from './pages/Strategies'
import Backtests from './pages/Backtests'
import Signals from './pages/Signals'
import Monitor from './pages/Monitor'
import Reviews from './pages/Reviews'
import Decisions from './pages/Decisions'
import AuditPage from './pages/Audit'
import Settings from './pages/Settings'

const { Sider, Header, Content } = Layout

const PAGES: Record<string, { label: string; icon: React.ReactNode; node: React.ReactNode }> = {
  dashboard: { label: '仪表盘', icon: <DashboardOutlined />, node: <Dashboard /> },
  market: { label: '行情', icon: <LineChartOutlined />, node: <Market /> },
  strategies: { label: '策略中心', icon: <ExperimentOutlined />, node: <Strategies /> },
  backtests: { label: '回测', icon: <HistoryOutlined />, node: <Backtests /> },
  signals: { label: '运行与信号', icon: <SendOutlined />, node: <Signals /> },
  monitor: { label: '盯盘', icon: <EyeOutlined />, node: <Monitor /> },
  reviews: { label: '复盘', icon: <FileTextOutlined />, node: <Reviews /> },
  decisions: { label: '待决策中心', icon: <CheckSquareOutlined />, node: <Decisions /> },
  audit: { label: '审计', icon: <AuditOutlined />, node: <AuditPage /> },
  settings: { label: '设置', icon: <SettingOutlined />, node: <Settings /> }
}

export default function App(): React.ReactNode {
  const { accounts, currentAccount, agentActive, agentRunning, init, switchAccount, lastEvent, startAgent, stopAgent } = useAppStore()
  const [page, setPage] = useState('dashboard')
  const [pendingCount, setPendingCount] = useState(0)
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

  // 待决策角标：汇报事件与切页刷新
  useEffect(() => {
    if (!currentAccount) return
    window.daydream.reports
      .list(currentAccount.id)
      .then((reports) => setPendingCount(reports.filter((r) => r.status === 'pending' && r.level === 'need_decision').length))
      .catch(() => undefined)
  }, [currentAccount, lastEvent, page])

  return (
    <Layout style={{ height: '100vh' }}>
      <Sider width={180} theme="dark">
        <div style={{ padding: '16px 16px 8px', fontSize: 18, fontWeight: 700, color: '#fff' }}>
          Daydream
          <div style={{ fontSize: 11, fontWeight: 400, color: '#8c93a3' }}>AI 量化决策辅助</div>
        </div>
        <Menu
          theme="dark"
          mode="inline"
          selectedKeys={[page]}
          onClick={(e) => setPage(e.key)}
          items={Object.entries(PAGES).map(([key, p]) => ({
            key,
            icon: p.icon,
            label:
              key === 'decisions' && pendingCount > 0 ? (
                <span>
                  {p.label} <Badge count={pendingCount} size="small" />
                </span>
              ) : (
                p.label
              )
          }))}
        />
      </Sider>
      <Layout>
        <Header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: '#14161b', padding: '0 16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <Tag icon={<RobotOutlined />} color={agentActive ? 'success' : 'default'}>
              Agent {agentActive ? '运行中' : '待命'}
            </Tag>
            {agentRunning ? (
              <Button size="small" danger icon={<PauseCircleOutlined />} onClick={() => stopAgent().catch((e) => message.error((e as Error).message))}>
                停止运行
              </Button>
            ) : (
              <Button
                size="small"
                type="primary"
                icon={<PlayCircleOutlined />}
                onClick={() => startAgent().catch((e) => message.error((e as Error).message))}
              >
                开始运行
              </Button>
            )}
            {lastEvent && <span style={{ color: '#8c93a3', fontSize: 12 }}>最近事件：{lastEvent.type}</span>}
          </div>
          <Select
            size="small"
            style={{ width: 180 }}
            value={currentAccount?.id}
            onChange={(id) => switchAccount(id)}
            options={accounts.map((a) => ({ value: a.id, label: a.name }))}
          />
        </Header>
        <Content style={{ padding: 16, overflow: 'auto' }}>{PAGES[page]?.node ?? <Dashboard />}</Content>
      </Layout>
      {/* 进入主界面后强制配置模型（全局通用） */}
      {initialized && currentAccount && <ModelConfigModal />}
    </Layout>
  )
}
