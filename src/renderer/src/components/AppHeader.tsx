/**
 * Header（自绘标题栏，48px 拖拽区）：
 * 左：账户切换（Text Button + Dropdown）、添加账户（icon）；
 *     macOS 非全屏时预留交通灯空间（全屏时带过渡动效收起预留）。
 * 右：Agent 启动/停止、运行模式（自动模式开关）、主题（亮/暗/系统）——均为点击按钮直接切换；
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
  DownOutlined,
  CheckOutlined
} from '@ant-design/icons'
import { MdOutlineMotionPhotosAuto } from 'react-icons/md'
import { PiCircleHalfFill } from 'react-icons/pi'
import AccountAvatar from './AccountAvatar'
import { useAppStore } from '../stores'
import type { RunMode, ThemeMode } from '@shared/types'

/** 主题循环顺序：亮 → 暗 → 系统 */
const THEME_ORDER: ThemeMode[] = ['light', 'dark', 'system']
// react-icons 视觉尺寸校正：antd 图标（viewBox 64 64 896 896）墨迹基本满幅，
// 而 Md（24 网格，墨迹 20/24）、Pi（256 网格，墨迹 208/256）自带留白，直接 1em 渲染会小 16%~19%。
// 用 transform 放大字形而保持 1em 布局盒尺寸，这样盒子尺寸与 antd 图标（14px）完全一致，
// 无论外层是 flex 还是基线对齐，垂直位置都不会偏。
/** Md 图标：墨迹占 83.3%，scale 1.2 → 墨迹 14px */
const MD_ICON_STYLE = { transform: 'scale(1.2)', transformOrigin: 'center' }
/** Pi 图标：墨迹占 81.3%，scale 1.23 → 墨迹 14px */
const PI_ICON_STYLE = { transform: 'scale(1.23)', transformOrigin: 'center' }
/** 自动模式开启时的图标色：antd 色板 orange-6 */
const AUTO_MODE_COLOR = '#fa8c16'
/** 主题图标：亮/暗/系统（tooltip 统一为“切换主题”，点击按 亮 → 暗 → 系统 循环） */
const THEME_ICON: Record<ThemeMode, React.ReactNode> = {
  light: <SunOutlined />,
  dark: <MoonOutlined />,
  system: <PiCircleHalfFill style={PI_ICON_STYLE} />
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

  /** 点击切换运行模式：手动 ↔ 自动（仅 Agent 运行时可用） */
  const toggleRunMode = (): void => {
    if (!agentRunning) return
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
  // 自动模式高亮：仅 Agent 运行中且当前为自动模式（Agent 停止时既不亮也不可点）
  const autoModeActive = agentRunning && runMode === 'auto'

  return (
    <header className={`dd-header${needMacInset ? ' dd-header-mac' : ''}`}>
      <div className="dd-header-left dd-no-drag">
        {/* 账户切换：Text Button + Dropdown（点击展开，头像由账户名哈希生成） */}
        <Dropdown
          menu={{
            items: accounts.map((a) => {
              const active = currentAccount?.id === a.id
              return {
                key: a.id,
                icon: <AccountAvatar name={a.name} size={20} />,
                label: (
                  <span className="dd-account-option">
                    <span className="dd-account-option-name">{a.name}</span>
                    {active && <CheckOutlined className="dd-account-option-check" />}
                  </span>
                ),
                onClick: () => switchAccount(a.id).catch((e) => message.error((e as Error).message))
              }
            }),
            selectedKeys: currentAccount ? [currentAccount.id] : []
          }}
          // 弹层宽高/内边距/头像与文字的间距显式指定：默认间距在 20px 头像下过于拥挤
          styles={{
            root: { minWidth: 208 },
            item: { paddingBlock: 6, paddingInline: 12 },
            itemIcon: { marginInlineEnd: 10 },
            itemContent: { minWidth: 0 }
          }}
          trigger={['click']}
        >
          <Button type="text" size="small" icon={<AccountAvatar name={currentAccount?.name ?? '选择账户'} size={18} />}>
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

        {/* 运行模式：单个自动模式开关，Agent 未运行时禁用；开启时高亮 */}
        <Tooltip title={runMode === 'auto' ? '切换到手动模式' : '切换到自动模式'}>
          <span className="dd-tooltip-wrap">
            <Button
              type="text"
              size="small"
              disabled={!agentRunning}
              icon={<MdOutlineMotionPhotosAuto style={MD_ICON_STYLE} />}
              style={autoModeActive ? { color: AUTO_MODE_COLOR } : undefined}
              onClick={toggleRunMode}
            />
          </span>
        </Tooltip>

        {/* 主题：点击循环切换（亮 → 暗 → 系统） */}
        <Tooltip title="切换主题">
          <Button type="text" size="small" icon={THEME_ICON[theme]} onClick={toggleTheme} />
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
