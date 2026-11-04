/**
 * 主题层（antd-style）：
 * - AppThemeProvider：配置 antd 样式 token（亮/暗两套）与组件级 token（Button/Table/Tabs/Tag/Modal 等），
 *   并暴露布局自定义 token（header 高度、侧边栏宽度）；主题模式（亮/暗/系统）与全局 store 联动。
 * - GlobalStyles：全部应用自定义样式（布局/侧边栏/对话流等），统一使用 antd token 编写。
 */
import React from 'react'
import { ConfigProvider, theme as antdTheme } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import { ThemeProvider, createGlobalStyle } from 'antd-style'
import { useAppStore } from './stores'

// ---------- 布局自定义 token（随 ThemeProvider 注入，样式里经 theme.customToken 访问） ----------
export interface LayoutToken {
  /** header 高度 */
  headerH: number
  /** 侧边栏宽度（始终展开，不折叠） */
  siderW: number
}

const LAYOUT_TOKEN: LayoutToken = {
  headerH: 48,
  /** 侧边栏宽度（紧凑型：图标 + 两字导航名，刚好容纳菜单不出现滚动条） */
  siderW: 92
}

// ---------- antd 样式 token：亮/暗两套（保持交易终端观感） ----------
const baseToken = {
  colorPrimary: '#1677ff',
  borderRadius: 6
}

const darkToken = {
  ...baseToken,
  colorBgLayout: '#0f1115',
  colorBgContainer: '#14161b',
  colorBgElevated: '#1a1e26',
  colorBorder: '#2a303a',
  colorBorderSecondary: '#232833',
  colorText: '#e6e9f0',
  colorTextSecondary: '#8c93a3',
  colorTextTertiary: '#5f6773',
  /** 侧边栏 hover 背景 */
  colorFillTertiary: '#1c212b',
  /** 侧边栏选中背景 */
  colorPrimaryBg: '#232a37',
  colorPrimaryBgHover: '#2a3444'
}

const lightToken = {
  ...baseToken,
  colorBgLayout: '#eef1f5',
  colorBgContainer: '#ffffff',
  colorBgElevated: '#ffffff',
  colorBorder: '#d9dde3',
  colorBorderSecondary: '#e2e6ec',
  colorText: '#1f2329',
  colorTextSecondary: '#6b7280',
  colorTextTertiary: '#9ca3af',
  colorFillTertiary: '#e3e7ee',
  colorPrimaryBg: '#e8f0fe',
  colorPrimaryBgHover: '#dce9ff'
}

// ---------- antd 组件级 token ----------
const componentsToken = {
  Button: { controlHeightSM: 26, paddingInlineSM: 8, borderRadius: 6 },
  Table: { cellFontSize: 12, headerBg: 'transparent' },
  Tabs: { titleFontSize: 13 },
  Tag: { fontSizeSM: 11 },
  Modal: { borderRadiusLG: 10 },
  Tooltip: { borderRadius: 6 },
  Dropdown: { borderRadiusLG: 8 }
}

export function AppThemeProvider({ children }: { children: React.ReactNode }): React.ReactNode {
  const themeMode = useAppStore((s) => s.theme)
  // 应用主题模式（light/dark/system）→ antd-style 主题模式（light/dark/auto）
  const mode = themeMode === 'system' ? 'auto' : themeMode
  return (
    <ThemeProvider
      themeMode={mode}
      customToken={LAYOUT_TOKEN}
      theme={(appearance) => ({
        algorithm: appearance === 'dark' ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
        token: appearance === 'dark' ? darkToken : lightToken,
        components: componentsToken
      })}
    >
      <ConfigProvider locale={zhCN}>
        <GlobalStyles />
        {children}
      </ConfigProvider>
    </ThemeProvider>
  )
}

// ---------- 全局样式（全部使用 antd token 编写） ----------
export const GlobalStyles = createGlobalStyle(({ theme }) => {
  // theme 即合并后的 FullToken（antd token + 自定义布局 token）
  const token = theme
  const layout = theme as unknown as LayoutToken
  const { headerH, siderW } = layout
  const isDark = theme.isDarkMode
  const danger = token.colorError
  const success = token.colorSuccess
  const warning = token.colorWarning
  // 亮色：header/sider 浅灰、content 白色卡片（上/左边框 + 左上圆角）；暗色：保持面板式布局
  const chromeBg = isDark ? token.colorBgContainer : token.colorBgLayout
  const contentBg = isDark ? token.colorBgLayout : token.colorBgContainer
  return {
    '*': { boxSizing: 'border-box' },
    // 网页整体 color-schema：随亮/暗主题切换，驱动原生滚动条/表单控件/系统 UI 配色
    'html': { colorScheme: isDark ? 'dark' : 'light' },
    'html, body, #root': {
      margin: 0,
      padding: 0,
      height: '100%',
      overflow: 'hidden',
      background: token.colorBgLayout,
      color: token.colorText,
      fontFamily:
        "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif",
      fontSize: 13
    },
    // 滚动条配色（跟随主题 token）
    '::-webkit-scrollbar': { width: 10, height: 10 },
    '::-webkit-scrollbar-thumb': { background: token.colorFillSecondary, borderRadius: 6, border: '2px solid transparent', backgroundClip: 'content-box' },
    '::-webkit-scrollbar-thumb:hover': { background: token.colorFill, backgroundClip: 'content-box', border: '2px solid transparent' },
    '::-webkit-scrollbar-track': { background: 'transparent' },

    // ---------- 整体布局 ----------
    '.dd-app': { display: 'flex', flexDirection: 'column', height: '100vh', background: token.colorBgLayout },
    '.dd-body': { display: 'flex', flex: 1, minHeight: 0 },
    '.dd-content': {
      flex: 1,
      minWidth: 0,
      overflow: 'auto',
      padding: 0,
      background: contentBg,
      // 内容区卡片：上/左边框 + 左上大圆角（macOS 应用窗口圆角风格，亮/暗主题一致）
      borderTop: `1px solid ${token.colorBorderSecondary}`,
      borderLeft: `1px solid ${token.colorBorderSecondary}`,
      borderTopLeftRadius: 14
    },

    // ---------- header（自绘标题栏） ----------
    '.dd-header': {
      height: headerH,
      flex: 'none',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      background: chromeBg,
      borderBottom: 'none',
      padding: '0 12px',
      WebkitAppRegion: 'drag',
      userSelect: 'none',
      // macOS 交通灯预留空间的过渡动效：250ms + Material standard easing（社区推荐 200~300ms）
      transition: 'padding-left 250ms cubic-bezier(0.2, 0, 0, 1)'
    },
    '.dd-header.dd-header-mac': { paddingLeft: 84 },
    '.dd-header-left, .dd-header-right': { display: 'flex', alignItems: 'center', gap: 8 },
    '.dd-no-drag': { WebkitAppRegion: 'no-drag' },
    '.dd-header-title': { fontWeight: 700, fontSize: 14, letterSpacing: 0.5 },

    '.dd-win-controls': {
      display: 'flex',
      alignItems: 'center',
      overflow: 'hidden',
      // 全屏隐藏/恢复的过渡动效：200ms opacity + width（社区推荐 200~300ms）
      transition: 'width 200ms ease, opacity 200ms ease'
    },
    '.dd-win-controls.dd-win-hidden': { width: 0, opacity: 0, pointerEvents: 'none' },
    '.dd-win-btn': {
      width: 40,
      height: headerH,
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      border: 'none',
      background: 'transparent',
      color: token.colorTextSecondary,
      cursor: 'default',
      WebkitAppRegion: 'no-drag'
    },
    '.dd-win-btn:hover': { background: token.colorFillTertiary, color: token.colorText },
    '.dd-win-btn.dd-win-close:hover': { background: '#c42b1c', color: '#fff' },

    // ---------- sidebar（shadcn 风格自研导航） ----------
    '.dd-sidebar': {
      flex: 'none',
      width: siderW,
      background: chromeBg,
      borderRight: 'none',
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden'
    },
    '.dd-sidebar-content': {
      flex: 1,
      overflowY: 'auto',
      padding: '10px 8px',
      display: 'flex',
      flexDirection: 'column',
      gap: 14
    },
    '.dd-sidebar-group': { display: 'flex', flexDirection: 'column', gap: 2 },
    // 系统组：推到 sider 底部（margin-top:auto 吸收上方剩余空间）
    '.dd-sidebar-group-bottom': { marginTop: 'auto' },
    '.dd-sidebar-item': {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      width: '100%',
      padding: '8px 10px',
      border: 'none',
      background: 'transparent',
      borderRadius: token.borderRadius,
      color: token.colorTextSecondary,
      fontSize: 13,
      fontWeight: 500,
      cursor: 'pointer',
      textAlign: 'left',
      whiteSpace: 'nowrap',
      transition: 'background 0.15s ease, color 0.15s ease'
    },
    '.dd-sidebar-item:hover': { background: token.colorFillTertiary, color: token.colorText },
    '.dd-sidebar-item[data-active]': { background: token.colorPrimaryBg, color: token.colorPrimary, fontWeight: 600 },
    '.dd-sidebar-icon': { fontSize: 16, flex: 'none', display: 'inline-flex' },
    '.dd-sidebar-label': { overflow: 'hidden', textOverflow: 'ellipsis' },

    // ---------- 首页两列 ----------
    '.dd-home': { display: 'flex', height: '100%', gap: 0 },
    '.dd-home-left': { flex: 3, minWidth: 0, display: 'flex', flexDirection: 'column', paddingRight: 16 },
    '.dd-home-right': { flex: 2, minWidth: 240, paddingLeft: 16, borderLeft: `1px solid ${token.colorBorder}`, overflow: 'auto' },
    '.dd-section': { padding: '10px 0', borderBottom: `1px dashed ${token.colorBorderSecondary}` },
    '.dd-section:last-child': { borderBottom: 'none' },
    '.dd-section-title': { fontSize: 12, fontWeight: 600, color: token.colorTextSecondary, marginBottom: 8, letterSpacing: 0.5 },
    '.dd-stat-row': { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '3px 0' },
    '.dd-stat-label': { color: token.colorTextSecondary, fontSize: 12 },
    '.dd-stat-value': { fontSize: 13, fontWeight: 600, fontVariantNumeric: 'tabular-nums' },
    '.dd-up': { color: danger },
    '.dd-down': { color: success },

    // ---------- 对话流 ----------
    '.dd-chat': { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' },
    '.dd-chat-list': { flex: 1, overflow: 'auto', padding: '4px 4px 12px' },
    '.dd-chat-sender': { flex: 'none', borderTop: `1px dashed ${token.colorBorderSecondary}`, paddingTop: 10 },
    '.dd-chat-empty': {
      display: 'flex',
      height: '100%',
      alignItems: 'center',
      justifyContent: 'center',
      color: token.colorTextSecondary,
      flexDirection: 'column',
      gap: 8
    },
    '.dd-chat-group': { marginBottom: 10 },
    '.dd-chat-top': { display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 24, padding: '2px 0', fontSize: 12 },
    '.dd-chat .ant-bubble-list': { padding: '0 4px' },
    '.dd-chat .ant-bubble-content': { maxHeight: 420, overflow: 'auto' },

    // 消息元信息
    '.dd-msg-meta': { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '4px 8px', marginBottom: 2, minHeight: 20 },
    '.dd-msg-role': { fontWeight: 600, fontSize: 12, color: token.colorText },
    '.dd-msg-time': { fontSize: 12, color: token.colorTextSecondary, fontVariantNumeric: 'tabular-nums' },

    // 运行细节折叠
    '.dd-run-details': { margin: '2px 0 4px 40px' },
    '.dd-details-toggle': {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 4,
      border: 'none',
      background: 'transparent',
      color: token.colorTextSecondary,
      fontSize: 12,
      cursor: 'pointer',
      padding: '2px 4px',
      borderRadius: 4
    },
    '.dd-details-toggle:hover': { color: token.colorPrimary, background: token.colorFillTertiary },
    '.dd-details-body': { marginTop: 4, borderLeft: `2px solid ${token.colorBorderSecondary}`, paddingLeft: 8 },
    '.dd-detail-row': { display: 'flex', alignItems: 'baseline', gap: 4, padding: '3px 0', fontSize: 12 },
    '.dd-detail-time': { color: token.colorTextSecondary, fontSize: 11, flex: 'none', fontVariantNumeric: 'tabular-nums' },
    '.dd-detail-content': {
      color: token.colorTextSecondary,
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-word',
      maxHeight: 120,
      overflow: 'auto',
      flex: 1,
      minWidth: 0
    },

    // ---------- 策略文档 Markdown 渲染 ----------
    '.dd-markdown': {
      fontSize: 13,
      lineHeight: 1.7,
      color: token.colorText,
      wordBreak: 'break-word'
    },
    '.dd-markdown h1': { fontSize: 18, fontWeight: 700, margin: '0 0 12px', borderBottom: `1px solid ${token.colorBorderSecondary}`, paddingBottom: 8 },
    '.dd-markdown h2': { fontSize: 15, fontWeight: 700, margin: '18px 0 8px' },
    '.dd-markdown h3, .dd-markdown h4': { fontSize: 14, fontWeight: 600, margin: '14px 0 6px' },
    '.dd-markdown p': { margin: '0 0 10px' },
    '.dd-markdown ul, .dd-markdown ol': { margin: '0 0 10px', paddingLeft: 22 },
    '.dd-markdown li': { marginBottom: 2 },
    '.dd-markdown blockquote': {
      margin: '0 0 10px',
      padding: '6px 12px',
      borderLeft: `3px solid ${token.colorBorder}`,
      background: token.colorFillTertiary,
      color: token.colorTextSecondary,
      borderRadius: '0 6px 6px 0'
    },
    '.dd-markdown code': {
      fontFamily: "'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace",
      fontSize: '0.92em',
      background: token.colorFillTertiary,
      padding: '2px 5px',
      borderRadius: 4
    },
    '.dd-markdown pre': {
      background: isDark ? '#0d1017' : '#f6f8fa',
      border: `1px solid ${token.colorBorderSecondary}`,
      borderRadius: 8,
      padding: 12,
      overflow: 'auto',
      margin: '0 0 10px'
    },
    '.dd-markdown pre code': { background: 'transparent', padding: 0, fontSize: 12, lineHeight: 1.6 },
    '.dd-markdown table': { borderCollapse: 'collapse', margin: '0 0 10px', fontSize: 12 },
    '.dd-markdown th, .dd-markdown td': { border: `1px solid ${token.colorBorderSecondary}`, padding: '4px 10px' },
    '.dd-markdown th': { background: token.colorFillTertiary, fontWeight: 600 },
    '.dd-markdown hr': { border: 'none', borderTop: `1px dashed ${token.colorBorderSecondary}`, margin: '14px 0' },

    // ---------- 通用 ----------
    '.dd-page-title': { fontSize: 15, fontWeight: 700, marginBottom: 12 },
    // 页面级容器留白（content 本身无内边距，由页面自行控制）
    '.dd-page': { padding: 16 },
    '.dd-muted': { color: token.colorTextSecondary },
    '.dd-scroll': { overflow: 'auto' },
    '.dd-warn-color': { color: warning },
    '.ant-table': { fontSize: 12 },
    // 面板（实线边框）
    '.dd-panel': { border: `1px solid ${token.colorBorder}`, borderRadius: token.borderRadius, padding: 12 },
    // 面板（虚线边框，条件块等）
    '.dd-panel-dashed': { border: `1px dashed ${token.colorBorderSecondary}`, borderRadius: token.borderRadius, padding: 10 },
    // 虚线分隔线
    '.dd-dashed-line': { borderBottom: `1px dashed ${token.colorBorderSecondary}` },
    // 左侧实线分隔栏
    '.dd-split-left': { borderLeft: `1px solid ${token.colorBorder}` }
  }
})
