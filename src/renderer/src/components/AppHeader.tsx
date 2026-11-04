/**
 * Header（自绘标题栏，48px 拖拽区）：
 * 左：账户切换（Text Button + Dropdown）、添加账户（icon）；
 *     macOS 非全屏时预留交通灯空间（全屏时带过渡动效收起预留）。
 * 右：Agent 启动/停止、运行模式（手动/自动）、主题（亮/暗/系统）——均为点击按钮直接切换；
 *     Windows 窗口控制（全屏时带过渡动效隐藏）。
 */
import { useEffect, useState } from 'react'
import { Button, Dropdown, Tooltip, Modal, Input, message } from 'antd'
import { useAntdToken } from 'antd-style'
import {
  UserAddOutlined,
  PlayCircleOutlined,
  PauseCircleOutlined,
  SunOutlined,
  MoonOutlined,
  MinusOutlined,
  FullscreenOutlined,
  FullscreenExitOutlined,
  CloseOutlined,
  UserOutlined,
  DownOutlined
} from '@ant-design/icons'
import { ManualModeIcon, AutoModeIcon, SystemThemeIcon } from './HeaderIcons'
import { useAppStore } from '../stores'
import type { RunMode, ThemeMode } from '@shared/types'

/** 主题循环顺序：亮 → 暗 → 系统 */
const THEME_ORDER: ThemeMode[] = ['light', 'dark', 'system']
const THEME_META: Record<ThemeMode, { label: string; icon: React.ReactNode }> = {
  light: { label: '亮色', icon: <SunOutlined /> },
  dark: { label: '暗色', icon: <MoonOutlined /> },
  system: { label: '系统', icon: <SystemThemeIcon /> }
}

export default function AppHeader(): React.ReactNode {
  const { accounts, currentAccount, agentRunning, theme, runMode, switchAccount, addAccount, startAgent, stopAgent, setTheme, setRunMode } = useAppStore()
  const token = useAntdToken()
  const [addOpen, setAddOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [maximized, setMaximized] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  const isMac = navigator.platform.toLowerCase().includes('mac')

  useEffect(() => {
    window.daydream.window.isMaximized().then(setMaximized).catch(() => undefined)
    window.daydream.window.isFullScreen().then(setFullscreen).catch(() => undefined)
    // 文档级全屏状态：macOS 原生全屏时 webkit fullscreen 在系统动画开始时即触发，
    // 从而让 header 预留空间的过渡动画与系统全屏动画**同时执行**（主进程事件作为兜底）
    const onDocFs = (): void => {
      const el = document.documentElement as HTMLElement & { webkitIsFullScreen?: boolean }
      setFullscreen(document.fullscreenElement != null || el.webkitIsFullScreen === true)
    }
    document.addEventListener('fullscreenchange', onDocFs)
    document.addEventListener('webkitfullscreenchange', onDocFs)
    const off = window.daydream.onEvent((ev) => {
      if (ev.type === 'window.maximized') setMaximized(Boolean((ev.payload as { maximized?: boolean })?.maximized))
      if (ev.type === 'window.fullscreen') setFullscreen(Boolean((ev.payload as { fullscreen?: boolean })?.fullscreen))
    })
    return () => {
      document.removeEventListener('fullscreenchange', onDocFs)
      document.removeEventListener('webkitfullscreenchange', onDocFs)
      off()
    }
  }, [])

  const toggleAgent = async (): Promise<void> => {
    try {
      if (agentRunning) await stopAgent()
      else await startAgent()
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  /** 点击切换运行模式：手动 ↔ 自动 */
  const toggleRunMode = (): void => {
    setRunMode(runMode === 'auto' ? 'manual' : 'auto').catch((e) => message.error((e as Error).message))
  }

  /** 点击循环切换主题：亮 → 暗 → 系统 */
  const toggleTheme = (): void => {
    const next = THEME_ORDER[(THEME_ORDER.indexOf(theme) + 1) % THEME_ORDER.length]
    setTheme(next).catch((e) => message.error((e as Error).message))
  }

  const createAccount = async (): Promise<void> => {
    if (!newName.trim()) {
      message.warning('请输入账户名称')
      return
    }
    try {
      await addAccount(newName.trim())
      setAddOpen(false)
      setNewName('')
      message.success('账户已创建')
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  // macOS 全屏时交通灯自动隐藏，header 无需预留空间（过渡动效见全局样式）
  const needMacInset = isMac && !fullscreen

  return (
    <header className={`dd-header${needMacInset ? ' dd-header-mac' : ''}`}>
      <div className="dd-header-left dd-no-drag">
        {/* 账户切换：Text Button + Dropdown */}
        <Dropdown
          menu={{
            items: accounts.map((a) => ({
              key: a.id,
              icon: <UserOutlined />,
              label: `${a.name}${currentAccount?.id === a.id ? ' ✓' : ''}`,
              onClick: () => switchAccount(a.id).catch((e) => message.error((e as Error).message))
            })),
            selectedKeys: currentAccount ? [currentAccount.id] : []
          }}
          trigger={['click']}
        >
          <Button type="text" size="small" icon={<UserOutlined />}>
            {currentAccount?.name ?? '选择账户'}
            <DownOutlined style={{ fontSize: 10, marginLeft: 2 }} />
          </Button>
        </Dropdown>

        {/* 添加账户 */}
        <Tooltip title="添加账户">
          <Button type="text" size="small" icon={<UserAddOutlined />} onClick={() => setAddOpen(true)} />
        </Tooltip>
      </div>

      <div className="dd-header-right dd-no-drag">
        {/* Agent 启动/停止：点击切换（无徽标） */}
        <Tooltip title={agentRunning ? '停止' : '启动'}>
          <Button
            type="text"
            size="small"
            icon={agentRunning ? <PauseCircleOutlined /> : <PlayCircleOutlined />}
            style={agentRunning ? { color: token.colorError } : undefined}
            onClick={toggleAgent}
          />
        </Tooltip>

        {/* 运行模式：点击切换（手动 ↔ 自动） */}
        <Tooltip title={runMode === 'auto' ? '自动模式' : '手动模式'}>
          <Button
            type="text"
            size="small"
            icon={runMode === 'auto' ? <AutoModeIcon /> : <ManualModeIcon />}
            style={runMode === 'auto' ? { color: token.colorSuccess } : undefined}
            onClick={toggleRunMode}
          />
        </Tooltip>

        {/* 主题：点击循环切换（亮 → 暗 → 系统） */}
        <Tooltip title={THEME_META[theme].label}>
          <Button type="text" size="small" icon={THEME_META[theme].icon} onClick={toggleTheme} />
        </Tooltip>

        {/* Windows 窗口控制（macOS 由交通灯承担；全屏时过渡隐藏） */}
        {!isMac && (
          <div className={`dd-win-controls${fullscreen ? ' dd-win-hidden' : ''}`}>
            <button className="dd-win-btn" onClick={() => window.daydream.window.minimize()} title="最小化">
              <MinusOutlined style={{ fontSize: 11 }} />
            </button>
            <button className="dd-win-btn" onClick={() => window.daydream.window.toggleMaximize()} title={maximized ? '还原' : '最大化'}>
              {maximized ? <FullscreenExitOutlined style={{ fontSize: 10 }} /> : <FullscreenOutlined style={{ fontSize: 10 }} />}
            </button>
            <button className="dd-win-btn dd-win-close" onClick={() => window.daydream.window.close()} title="关闭">
              <CloseOutlined style={{ fontSize: 11 }} />
            </button>
          </div>
        )}
      </div>

      <Modal title="添加账户" open={addOpen} onOk={createAccount} onCancel={() => setAddOpen(false)} okText="创建" width={360}>
        <Input
          placeholder="账户名称（如：实盘 A、研究账户）"
          value={newName}
          maxLength={32}
          onChange={(e) => setNewName(e.target.value)}
          onPressEnter={createAccount}
        />
      </Modal>
    </header>
  )
}
