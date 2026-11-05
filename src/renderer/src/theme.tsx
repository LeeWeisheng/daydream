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
  /** 侧边栏宽度（紧凑型：48px 导航项 + 左右各 8px 内边距） */
  siderW: 64
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
  // 内容卡片：亮色白底 + 极轻阴影，暗色提亮一档并去掉阴影（避免浑浊）
  const cardBg = isDark ? token.colorBgContainer : token.colorBgElevated
  const cardShadow = isDark ? 'none' : '0 1px 2px rgba(16, 24, 40, 0.04), 0 10px 24px -18px rgba(16, 24, 40, 0.35)'
  // 侧边栏导航态：暗色用白色透明度、亮色用黑色透明度叠加，选中文本取纯白/纯黑保证对比
  const navHoverBg = isDark ? 'rgba(255, 255, 255, 0.06)' : 'rgba(0, 0, 0, 0.045)'
  const navActiveBg = isDark ? 'rgba(255, 255, 255, 0.12)' : 'rgba(0, 0, 0, 0.08)'
  const navActiveText = isDark ? '#ffffff' : '#000000'
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
    // Tooltip 包裹层：disabled 的 antd Button 不派发鼠标事件，需外层 span 承载悬浮提示
    '.dd-tooltip-wrap': { display: 'inline-flex' },
    '.dd-header-title': { fontWeight: 700, fontSize: 14, letterSpacing: 0.5 },

    // 账户切换下拉选项：名称占满剩余宽度并省略，选中勾靠右对齐（不参与挤压名称）
    '.dd-account-option': { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 },
    '.dd-account-option-name': {
      flex: 1,
      minWidth: 0,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap'
    },
    '.dd-account-option-check': { fontSize: 11, flex: 'none', color: token.colorPrimary },

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
      // 组间间距与组内项间距一致，保证任意相邻导航项上下距离均为 8px
      gap: 8
    },
    '.dd-sidebar-group': { display: 'flex', flexDirection: 'column' },
    // 导航项实际容器（group 的直接子层）：项与项上下间距 4px
    '.dd-sidebar-menu': { display: 'flex', flexDirection: 'column', gap: 4 },
    // 系统组：推到 sider 底部（margin-top:auto 吸收上方剩余空间）
    '.dd-sidebar-group-bottom': { marginTop: 'auto' },
    // 导航项：图标在上、名称在下，固定 48x48 居中
    '.dd-sidebar-item': {
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 0,
      width: 48,
      height: 48,
      padding: 0,
      border: 'none',
      background: 'transparent',
      borderRadius: 10,
      color: token.colorTextSecondary,
      fontSize: 12,
      fontWeight: 500,
      lineHeight: '16px',
      cursor: 'pointer',
      whiteSpace: 'nowrap',
      transition: 'background 0.15s ease, color 0.15s ease'
    },
    '.dd-sidebar-item:hover': { background: navHoverBg, color: token.colorText },
    // 选中态仅改颜色与背景，字重恒为 500
    '.dd-sidebar-item[data-active]': { background: navActiveBg, color: navActiveText },
    '.dd-sidebar-item[data-active]:hover': { background: navActiveBg, color: navActiveText },
    // 图标 16px / 行高 24px（与文本 16px 行高合计正好 40px）
    '.dd-sidebar-icon': {
      fontSize: 16,
      lineHeight: '24px',
      height: 24,
      flex: 'none',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center'
    },
    '.dd-sidebar-label': { fontSize: 12, lineHeight: '16px', fontWeight: 500, letterSpacing: 0.5 },

    // ---------- 页面壳（标题区 / 工具栏 / 栅格） ----------
    '.dd-page': {
      display: 'flex',
      flexDirection: 'column',
      gap: 14,
      padding: '18px 22px 26px',
      minHeight: '100%'
    },
    '.dd-page-fill': { height: '100%', minHeight: 0 },
    '.dd-page-head': {
      display: 'flex',
      alignItems: 'flex-start',
      justifyContent: 'space-between',
      gap: 16,
      flexWrap: 'wrap'
    },
    '.dd-page-head-main': { minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 },
    '.dd-page-title-row': { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
    '.dd-page-title': { fontSize: 17, fontWeight: 700, lineHeight: 1.3, letterSpacing: 0.2, margin: 0 },
    '.dd-page-desc': { fontSize: 12, color: token.colorTextSecondary, lineHeight: 1.65 },
    '.dd-page-actions': { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
    '.dd-toolbar': { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
    '.dd-toolbar-spacer': { flex: 1, minWidth: 8 },
    '.dd-grid-2': { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 14, alignItems: 'start' },
    // 主区 + 侧栏（默认侧栏 300px，窄窗口自动堆叠）
    '.dd-grid-main-side': { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 300px', gap: 14, alignItems: 'start' },
    '.dd-grid-main-side-wide': { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 340px', gap: 14, alignItems: 'start' },
    // 表单 + 预估算卡（表单固定宽度上限，右侧自适应）
    '.dd-grid-form-side': { display: 'grid', gridTemplateColumns: 'minmax(320px, 440px) minmax(0, 1fr)', gap: 14, alignItems: 'start' },
    '@media (max-width: 1080px)': {
      '.dd-grid-main-side, .dd-grid-main-side-wide, .dd-grid-form-side': { gridTemplateColumns: 'minmax(0, 1fr)' },
      '.dd-rail': { width: 300, minWidth: 260 }
    },
    '.dd-form-grid': { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', columnGap: 12 },

    // ---------- 卡片 / 面板 ----------
    '.dd-card': {
      display: 'flex',
      flexDirection: 'column',
      minWidth: 0,
      background: cardBg,
      border: `1px solid ${token.colorBorderSecondary}`,
      borderRadius: 10,
      boxShadow: cardShadow,
      overflow: 'hidden'
    },
    '.dd-card-flat': { boxShadow: 'none' },
    '.dd-card-head': {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 10,
      flex: 'none',
      minHeight: 42,
      padding: '9px 14px',
      borderBottom: `1px solid ${token.colorBorderSecondary}`,
      flexWrap: 'wrap'
    },
    '.dd-card-head-plain': { borderBottom: 'none', paddingBottom: 0 },
    '.dd-card-heading': { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flexWrap: 'wrap' },
    '.dd-card-title': { fontSize: 13, fontWeight: 600, letterSpacing: 0.2, color: token.colorText },
    '.dd-card-sub': { fontSize: 12, color: token.colorTextSecondary },
    '.dd-card-actions': { display: 'flex', alignItems: 'center', gap: 8, flex: 'none' },
    '.dd-card-body': { padding: 14 },
    '.dd-card-body-tight': { padding: 10 },
    '.dd-card-body-flush': { padding: 0 },
    '.dd-card-scroll': { overflow: 'auto', minHeight: 0 },

    // ---------- KPI 指标卡 ----------
    '.dd-kpi-grid': { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(146px, 1fr))', gap: 10 },
    '.dd-kpi': {
      display: 'flex',
      flexDirection: 'column',
      gap: 3,
      minWidth: 0,
      padding: '10px 12px',
      borderRadius: 8,
      border: `1px solid ${token.colorBorderSecondary}`,
      background: isDark ? token.colorFillQuaternary : token.colorBgLayout
    },
    '.dd-kpi-label': {
      display: 'flex',
      alignItems: 'center',
      gap: 5,
      fontSize: 11,
      color: token.colorTextSecondary,
      letterSpacing: 0.2,
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis'
    },
    '.dd-kpi-value': {
      fontSize: 19,
      fontWeight: 700,
      lineHeight: 1.2,
      letterSpacing: '-0.2px',
      fontVariantNumeric: 'tabular-nums',
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis'
    },
    '.dd-kpi-sub': { fontSize: 11, color: token.colorTextTertiary, fontVariantNumeric: 'tabular-nums' },

    // ---------- 通用行 / 列表 ----------
    '.dd-row': { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 },
    '.dd-row-label': { fontSize: 12, color: token.colorTextSecondary },
    '.dd-row-value': { fontSize: 13, fontWeight: 600, fontVariantNumeric: 'tabular-nums' },
    '.dd-list': { display: 'flex', flexDirection: 'column' },
    '.dd-list-item': {
      display: 'flex',
      flexDirection: 'column',
      gap: 4,
      padding: '9px 0',
      borderBottom: `1px dashed ${token.colorBorderSecondary}`
    },
    '.dd-list-item:first-of-type': { paddingTop: 0 },
    '.dd-list-item:last-of-type': { borderBottom: 'none', paddingBottom: 0 },
    '.dd-empty': {
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      padding: '26px 12px',
      color: token.colorTextSecondary,
      fontSize: 12,
      textAlign: 'center'
    },
    '.dd-chip-row': { display: 'flex', gap: 6, flexWrap: 'wrap' },
    '.dd-chip': {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 4,
      border: `1px dashed ${token.colorBorder}`,
      background: 'transparent',
      color: token.colorTextSecondary,
      borderRadius: 999,
      padding: '3px 10px',
      fontSize: 12,
      lineHeight: '18px',
      cursor: 'pointer',
      transition: 'all 0.15s ease'
    },
    '.dd-chip:hover': { color: token.colorPrimary, borderColor: token.colorPrimary, background: token.colorPrimaryBg },
    '.dd-dot': { display: 'inline-block', width: 6, height: 6, borderRadius: '50%', flex: 'none' },
    '.dd-pulse': { animation: 'dd-pulse 1.8s ease-out infinite' },
    '@keyframes dd-pulse': {
      '0%': { boxShadow: '0 0 0 0 rgba(82, 196, 26, 0.45)' },
      '70%': { boxShadow: '0 0 0 5px rgba(82, 196, 26, 0)' },
      '100%': { boxShadow: '0 0 0 0 rgba(82, 196, 26, 0)' }
    },
    '.dd-mono': {
      fontFamily: "'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace",
      fontSize: 12,
      lineHeight: 1.65
    },
    '.dd-up': { color: danger },
    '.dd-down': { color: success },

    // ---------- 首页：对话流 + 信息栏 ----------
    '.dd-home': { display: 'flex', height: '100%', minHeight: 0 },
    '.dd-home-main': { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0 },
    '.dd-chat': { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' },
    '.dd-chat-head': {
      flex: 'none',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 12,
      padding: '10px 20px',
      borderBottom: `1px solid ${token.colorBorderSecondary}`
    },
    '.dd-chat-list-wrap': { position: 'relative', flex: 1, minHeight: 0 },
    '.dd-chat-list': { position: 'absolute', inset: 0, overflowY: 'auto', overflowX: 'hidden', padding: '16px 20px 8px' },
    '.dd-chat-sender': {
      flex: 'none',
      padding: '10px 20px 12px',
      borderTop: `1px solid ${token.colorBorderSecondary}`
    },
    '.dd-chat-hint': { marginTop: 6, fontSize: 11, color: token.colorTextTertiary, textAlign: 'right' },
    '.dd-chat-empty': {
      display: 'flex',
      height: 'calc(100% - 30px)',
      alignItems: 'center',
      justifyContent: 'center',
      color: token.colorTextSecondary,
      flexDirection: 'column',
      gap: 10,
      textAlign: 'center'
    },
    '.dd-chat-group': { marginBottom: 16, maxWidth: '100%' },
    '.dd-chat-top': {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      minHeight: 22,
      fontSize: 11,
      color: token.colorTextTertiary
    },
    '.dd-chat-day': { display: 'flex', alignItems: 'center', gap: 10, margin: '2px 0 14px', color: token.colorTextTertiary },
    '.dd-chat-day::before, .dd-chat-day::after': {
      content: '""',
      flex: 1,
      borderTop: `1px dashed ${token.colorBorderSecondary}`
    },
    '.dd-chat-day > span': { fontSize: 11, whiteSpace: 'nowrap' },
    '.dd-chat-jump': { position: 'absolute', right: 18, bottom: 14, zIndex: 5 },
    '.dd-chat .ant-bubble': { maxWidth: 'min(100%, 820px)' },
    '.dd-chat .ant-bubble-content': { maxHeight: 460, overflow: 'auto' },
    '.dd-chat .ant-bubble-footer': { marginTop: 8 },

    // 消息元信息
    '.dd-msg-meta': { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '4px 8px', minHeight: 22 },
    '.dd-msg-role': { fontWeight: 600, fontSize: 12, color: token.colorText },
    '.dd-msg-time': { fontSize: 11, color: token.colorTextTertiary, fontVariantNumeric: 'tabular-nums' },
    '.dd-msg-copy': {
      border: 'none',
      background: 'transparent',
      color: token.colorTextTertiary,
      cursor: 'pointer',
      padding: '0 2px',
      fontSize: 11,
      lineHeight: 1,
      opacity: 0,
      transition: 'opacity 0.15s ease, color 0.15s ease'
    },
    '.dd-chat-group:hover .dd-msg-copy': { opacity: 1 },
    '.dd-msg-copy:hover': { color: token.colorPrimary },

    // 运行细节折叠
    '.dd-run-details': { margin: '6px 0 0 42px' },
    '.dd-details-toggle': {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 4,
      border: `1px solid ${token.colorBorderSecondary}`,
      background: 'transparent',
      color: token.colorTextSecondary,
      fontSize: 11,
      cursor: 'pointer',
      padding: '2px 8px',
      borderRadius: 999,
      transition: 'all 0.15s ease'
    },
    '.dd-details-toggle:hover': { color: token.colorPrimary, borderColor: token.colorPrimary, background: token.colorPrimaryBg },
    '.dd-details-body': {
      marginTop: 6,
      borderLeft: `2px solid ${token.colorBorderSecondary}`,
      paddingLeft: 10,
      display: 'flex',
      flexDirection: 'column',
      gap: 2
    },
    '.dd-detail-row': { display: 'flex', alignItems: 'baseline', gap: 6, padding: '3px 0', fontSize: 12 },
    '.dd-detail-time': { color: token.colorTextTertiary, fontSize: 11, flex: 'none', fontVariantNumeric: 'tabular-nums' },
    '.dd-detail-content': {
      color: token.colorTextSecondary,
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-word',
      maxHeight: 140,
      overflow: 'auto',
      flex: 1,
      minWidth: 0
    },

    // 右栏信息卡
    '.dd-rail': {
      flex: 'none',
      width: 344,
      minWidth: 288,
      display: 'flex',
      flexDirection: 'column',
      gap: 12,
      padding: 14,
      overflowY: 'auto',
      borderLeft: `1px solid ${token.colorBorderSecondary}`,
      background: token.colorBgLayout
    },
    '.dd-rail .dd-card': { flex: 'none' },

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
    '.dd-muted': { color: token.colorTextSecondary, fontSize: 12 },
    '.dd-scroll': { overflow: 'auto' },
    '.dd-warn-color': { color: warning },
    '.ant-table': { fontSize: 12 },
    '.ant-table-thead > tr > th': { fontWeight: 600, fontSize: 12, color: token.colorTextSecondary },
    // 面板（兼容旧类名，等价 .dd-card）
    '.dd-panel': {
      border: `1px solid ${token.colorBorderSecondary}`,
      borderRadius: 10,
      background: cardBg,
      boxShadow: cardShadow,
      padding: 14
    },
    // 面板（虚线边框，条件块等）
    '.dd-panel-dashed': { border: `1px dashed ${token.colorBorderSecondary}`, borderRadius: 8, padding: 10 },
    // 虚线分隔线
    '.dd-dashed-line': { borderBottom: `1px dashed ${token.colorBorderSecondary}` },
    // 左侧实线分隔栏
    '.dd-split-left': { borderLeft: `1px solid ${token.colorBorderSecondary}` },
    // 页面内 Tabs 间距收紧
    '.dd-page .ant-tabs-nav': { marginBottom: 14 },
    '.dd-page .ant-tabs-tab': { paddingBlock: 8 },
    // 描述型表单标签统一为次级色
    '.dd-form-hint': { fontSize: 12, color: token.colorTextSecondary, lineHeight: 1.7 },
    '.dd-field-value': { fontSize: 13, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }
  }
})
