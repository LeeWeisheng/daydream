/**
 * 首页：左侧 Agent 对话流，右侧信息栏（卡片式）。
 * 左列：@ant-design/x Bubble + Sender，持久化于 chat_message；适配 Claude 全部消息格式
 *   （text/thinking/tool_use/tool_result/system/result…），运行细节按消息分组折叠，
 *   按天分隔、可复制、支持向上翻页保持视口、回到底部。
 * 右列：账户概览 / Agent 状态 / 待决策 / 最近信号 / 数据状态 / 最近预警。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Bubble, Sender } from '@ant-design/x'
import { Avatar, Button, Empty, Progress, Spin, Tag, Tooltip, message } from 'antd'
import { useAntdToken } from 'antd-style'
import {
  BellOutlined,
  CheckOutlined,
  CloseOutlined,
  CopyOutlined,
  DownOutlined,
  ReloadOutlined,
  RightOutlined,
  RobotOutlined,
  UserOutlined,
  VerticalAlignBottomOutlined
} from '@ant-design/icons'
import ReactMarkdown from 'react-markdown'
import type { AccountSummary, Alert, ChatMessage, Report, Signal } from '@shared/types'
import { useAppStore } from '../stores'
import Panel from '../components/Panel'
import { fmtMoney, fmtSigned, fmtTime, pnlClass } from '../lib/format'
import { eventLabel } from '../lib/labels'

const PAGE_SIZE = 100

/** 空会话快捷提问（点击填入输入框） */
const SUGGESTIONS = ['帮我梳理当前持仓的主要风险', '解释今天为什么没有产生交易信号', '复盘最近一周的策略表现', '检查行情数据是否需要补数']

/** 主要消息：渲染为主气泡（其余为运行细节，默认折叠） */
function isMainMessage(m: ChatMessage): boolean {
  if (m.role === 'user') return true
  return m.kind === 'result' || m.kind === 'error' || m.kind === 'report' || m.kind === 'text'
}

interface Group {
  key: string
  main: ChatMessage
  details: ChatMessage[]
  /** 日期（YYYY-MM-DD），用于按天分隔 */
  day: string
}

/** 按时间顺序分组：细节消息归入其前最近的一个主消息组 */
function buildGroups(messages: ChatMessage[]): Group[] {
  const groups: Group[] = []
  for (const m of messages) {
    const day = m.createdAt.slice(0, 10)
    if (isMainMessage(m)) {
      groups.push({ key: m.id, main: m, details: [], day })
    } else if (groups.length > 0) {
      groups[groups.length - 1].details.push(m)
    } else {
      // 孤儿细节（无前置主消息）：作为独立组渲染
      groups.push({ key: m.id, main: m, details: [], day })
    }
  }
  return groups
}

/** 日期标签：今天 / 昨天 / YYYY-MM-DD */
function dayLabel(day: string): string {
  const today = new Date()
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  if (day === todayStr) return '今天'
  const y = new Date(today.getTime() - 86400000)
  const yStr = `${y.getFullYear()}-${String(y.getMonth() + 1).padStart(2, '0')}-${String(y.getDate()).padStart(2, '0')}`
  if (day === yStr) return '昨天'
  return day
}

/** 消息来源/类型标签（角色、来源、类型尽可能完整展示） */
function messageMeta(m: ChatMessage): { roleLabel: string; tags: { label: string; color: string }[] } {
  const tags: { label: string; color: string }[] = []
  let roleLabel = m.role === 'user' ? '我' : 'Agent'
  try {
    const meta = m.metaJson ? (JSON.parse(m.metaJson) as Record<string, unknown>) : null
    const source = meta?.workItemType ? String(meta.workItemType) : meta?.purpose ? String(meta.purpose).split(':')[0] : ''
    if (source) tags.push({ label: source, color: 'blue' })
  } catch {
    /* 忽略 */
  }
  switch (m.kind) {
    case 'report':
      roleLabel = 'Agent 汇报'
      tags.push({ label: '汇报', color: 'orange' })
      // 已处理的决策回显结果，避免重复展示操作按钮
      if (m.reportStatus && m.reportStatus !== 'pending') {
        const done: Record<string, { label: string; color: string }> = {
          approved: { label: '已批准', color: 'success' },
          rejected: { label: '已驳回', color: 'red' },
          postponed: { label: '已暂缓', color: 'default' },
          closed: { label: '已关闭', color: 'default' }
        }
        const d = done[m.reportStatus]
        if (d) tags.push(d)
      }
      break
    case 'result':
      tags.push({ label: '结果', color: 'green' })
      break
    case 'error':
      tags.push({ label: '错误', color: 'red' })
      break
    default:
      break
  }
  return { roleLabel, tags }
}

/** 运行细节行：按 Claude 消息类型渲染标签、时间与内容 */
function DetailRow({ msg }: { msg: ChatMessage }): React.ReactNode {
  let label = ''
  let color = 'default'
  let content = msg.content
  let meta: Record<string, unknown> | null = null
  try {
    meta = msg.metaJson ? (JSON.parse(msg.metaJson) as Record<string, unknown>) : null
  } catch {
    meta = null
  }
  switch (msg.kind) {
    case 'tool_use':
      label = `工具 · ${String(meta?.toolName ?? '')}`
      color = 'blue'
      content = meta?.input !== undefined ? JSON.stringify(meta.input) : content
      break
    case 'tool_result':
      label = '工具结果'
      color = 'geekblue'
      break
    case 'thinking':
      label = '思考'
      color = 'purple'
      break
    case 'assistant_text':
      label = '中间输出'
      color = 'cyan'
      break
    case 'system':
      label = '系统'
      color = 'default'
      break
    case 'tool_progress':
      label = '工具进度'
      color = 'blue'
      break
    case 'tool_use_summary':
      label = '工具摘要'
      color = 'blue'
      break
    default:
      label = '细节'
  }
  return (
    <div className="dd-detail-row">
      <Tag color={color} style={{ marginInlineEnd: 0, flex: 'none' }}>
        {label}
      </Tag>
      <span className="dd-detail-time">{fmtTime(msg.createdAt)}</span>
      <span className="dd-detail-content">{content}</span>
    </div>
  )
}

export default function Home(): React.ReactNode {
  const { currentAccount, agentRunning, agentActive, runMode, lastEvent, eventSeq } = useAppStore()
  const token = useAntdToken()
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [hasMore, setHasMore] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [summary, setSummary] = useState<AccountSummary | null>(null)
  const [signals, setSignals] = useState<Signal[]>([])
  const [reports, setReports] = useState<Report[]>([])
  const [alerts, setAlerts] = useState<Alert[]>([])
  const [dataStats, setDataStats] = useState<Record<string, unknown> | null>(null)
  /** 展开的运行细节组（默认全部收起，只展示主要结果） */
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set())
  /** 是否贴底（用于“回到底部”浮层） */
  const [atBottom, setAtBottom] = useState(true)
  const listRef = useRef<HTMLDivElement>(null)
  /** 向上翻页时保持视口位置：加载前「内容底部到视口底部的距离」 */
  const restoreRef = useRef<number | null>(null)
  const atBottomRef = useRef(true)
  const messagesRef = useRef<ChatMessage[]>([])
  const hasMoreRef = useRef(true)
  const loadingMoreRef = useRef(false)

  const accountId = currentAccount?.id ?? ''

  const syncMessagesRef = (next: ChatMessage[]): ChatMessage[] => {
    messagesRef.current = next
    return next
  }

  /** 按 id 去重合并（防增量拉取与本地消息重复） */
  const mergeAppend = (prev: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] => {
    const ids = new Set(prev.map((m) => m.id))
    return syncMessagesRef([...prev, ...incoming.filter((m) => !ids.has(m.id))])
  }

  /** 加载最新一页（首次进入） */
  const loadLatestPage = async (): Promise<void> => {
    const res = await window.daydream.chat.list(accountId, { limit: PAGE_SIZE })
    setHasMore(res.hasMore)
    hasMoreRef.current = res.hasMore
    setMessages(syncMessagesRef(res.messages))
  }

  /** 向上滚动加载更早一页（保持视口位置不跳动） */
  const loadMore = async (): Promise<void> => {
    if (!accountId || loadingMoreRef.current) return
    const first = messagesRef.current[0]
    if (!first) return
    const el = listRef.current
    restoreRef.current = el ? el.scrollHeight - el.scrollTop : null
    loadingMoreRef.current = true
    setLoadingMore(true)
    try {
      const res = await window.daydream.chat.list(accountId, {
        limit: PAGE_SIZE,
        before: { createdAt: first.createdAt, rowid: first.rowid }
      })
      setHasMore(res.hasMore)
      hasMoreRef.current = res.hasMore
      setMessages((prev) => {
        const ids = new Set(prev.map((m) => m.id))
        return syncMessagesRef([...res.messages.filter((m) => !ids.has(m.id)), ...prev])
      })
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      loadingMoreRef.current = false
      setLoadingMore(false)
    }
  }

  /** 事件驱动的增量刷新：追加新消息 + 刷新右栏数据 */
  const refresh = useCallback(async () => {
    if (!accountId) return
    const [sum, sigs, reps, als, stats] = await Promise.allSettled([
      window.daydream.trades.accountSummary(accountId),
      window.daydream.signals.list(accountId, 50),
      window.daydream.reports.list(accountId),
      window.daydream.alerts.list(accountId),
      window.daydream.data.getDataStats()
    ])
    if (sum.status === 'fulfilled') setSummary(sum.value)
    if (sigs.status === 'fulfilled') setSignals(sigs.value)
    if (reps.status === 'fulfilled') setReports(reps.value)
    if (als.status === 'fulfilled') setAlerts(als.value.slice(0, 5))
    if (stats.status === 'fulfilled') setDataStats(stats.value)

    // 对话流增量：已有消息则按最新游标拉取，否则加载最新一页
    try {
      const current = messagesRef.current
      if (current.length === 0) {
        await loadLatestPage()
        return
      }
      const last = current[current.length - 1]
      const res = await window.daydream.chat.list(accountId, { limit: 200, after: { createdAt: last.createdAt, rowid: last.rowid } })
      if (res.messages.length > 0) setMessages((prev) => mergeAppend(prev, res.messages))
    } catch (e) {
      message.error((e as Error).message)
    }
  }, [accountId])

  useEffect(() => {
    void refresh()
  }, [refresh, eventSeq])

  // 消息变化后处理滚动：向上翻页保持视口；在底部则自动滚到底
  useLayoutEffect(() => {
    const el = listRef.current
    if (!el) return
    if (restoreRef.current != null) {
      el.scrollTop = el.scrollHeight - restoreRef.current
      restoreRef.current = null
      return
    }
    if (atBottomRef.current) el.scrollTop = el.scrollHeight
  }, [messages])

  const onScroll = (): void => {
    const el = listRef.current
    if (!el) return
    const bottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 120
    atBottomRef.current = bottom
    setAtBottom(bottom)
    // 向上滚动接近顶部 → 加载更早消息
    if (el.scrollTop < 60 && hasMoreRef.current && !loadingMoreRef.current) void loadMore()
  }

  const scrollToBottom = (): void => {
    const el = listRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    atBottomRef.current = true
    setAtBottom(true)
  }

  const manualRefresh = async (): Promise<void> => {
    setRefreshing(true)
    try {
      await refresh()
    } finally {
      setRefreshing(false)
    }
  }

  const send = async (text: string): Promise<void> => {
    if (!text.trim() || !accountId) return
    setSending(true)
    setInput('')
    atBottomRef.current = true
    try {
      const res = await window.daydream.chat.send({ accountId, message: text.trim() })
      // 消息经 chat.message 事件回流刷新（不本地伪造，避免与持久化消息重复）
      if (res.accepted) {
        scrollToBottom()
        message.success('已发送给 Agent')
      } else {
        message.warning('Agent 已停止运行，请先点击顶部「启动」')
      }
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setSending(false)
    }
  }

  const respond = async (reportId: string, decision: 'approved' | 'rejected' | 'postponed'): Promise<void> => {
    try {
      await window.daydream.reports.respond({ reportId, decision })
      message.success(decision === 'approved' ? '已批准' : decision === 'rejected' ? '已驳回' : '已暂缓')
      void refresh()
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  const toggleGroup = (key: string): void => {
    setOpenGroups((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const copyMessage = async (content: string): Promise<void> => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(content)
      } else {
        // 兜底：非安全上下文时退回到临时文本域选中复制
        const ta = document.createElement('textarea')
        ta.value = content
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        document.execCommand('copy')
        document.body.removeChild(ta)
      }
      message.success('已复制')
    } catch {
      message.error('复制失败')
    }
  }

  const groups = useMemo(() => buildGroups(messages), [messages])

  const renderGroup = (g: Group, idx: number): React.ReactNode => {
    const m = g.main
    const { roleLabel, tags } = messageMeta(m)
    const isUser = m.role === 'user'
    const showDay = idx === 0 || groups[idx - 1].day !== g.day
    const isReport = m.kind === 'report'
    return (
      <div key={g.key}>
        {showDay ? (
          <div className="dd-chat-day">
            <span>{dayLabel(g.day)}</span>
          </div>
        ) : null}
        <div className="dd-chat-group">
          <Bubble
            placement={isUser ? 'end' : 'start'}
            variant={isUser ? 'filled' : 'outlined'}
            shape="corner"
            avatar={
              isUser ? (
                <Avatar size={28} style={{ background: token.colorPrimary, flex: 'none' }} icon={<UserOutlined />} />
              ) : (
                <Avatar
                  size={28}
                  style={{ background: m.kind === 'error' ? token.colorError : token.colorSuccess, flex: 'none' }}
                  icon={isReport ? <BellOutlined /> : <RobotOutlined />}
                />
              )
            }
            header={
              <div className="dd-msg-meta">
                <span className="dd-msg-role">{roleLabel}</span>
                <span className="dd-msg-time">{fmtTime(m.createdAt)}</span>
                {tags.map((t) => (
                  <Tag key={t.label} color={t.color} style={{ marginInlineEnd: 0 }}>
                    {t.label}
                  </Tag>
                ))}
                <Tooltip title="复制内容">
                  <button className="dd-msg-copy" onClick={() => void copyMessage(m.content)} aria-label="复制内容">
                    <CopyOutlined />
                  </button>
                </Tooltip>
              </div>
            }
            content={
              isReport ? (
                <div className="dd-markdown">
                  <ReactMarkdown>{m.content}</ReactMarkdown>
                </div>
              ) : (
                <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{m.content}</div>
              )
            }
            footer={
              isReport && m.reportLevel === 'need_decision' && (m.reportStatus === 'pending' || !m.reportStatus) ? (
                <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                  <Button size="small" type="primary" icon={<CheckOutlined />} onClick={() => respond(m.reportId!, 'approved')}>
                    批准
                  </Button>
                  <Button size="small" icon={<CloseOutlined />} onClick={() => respond(m.reportId!, 'rejected')}>
                    驳回
                  </Button>
                  <Button size="small" onClick={() => respond(m.reportId!, 'postponed')}>
                    暂缓
                  </Button>
                </div>
              ) : undefined
            }
          />
          {g.details.length > 0 && (
            <div className="dd-run-details">
              <button className="dd-details-toggle" onClick={() => toggleGroup(g.key)}>
                {openGroups.has(g.key) ? <DownOutlined /> : <RightOutlined />}
                {openGroups.has(g.key) ? '收起运行细节' : `运行细节 ${g.details.length} 条`}
              </button>
              {openGroups.has(g.key) && (
                <div className="dd-details-body">
                  {g.details.map((d) => (
                    <DetailRow key={d.id} msg={d} />
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    )
  }

  const pendingDecisions = reports.filter((r) => r.status === 'pending' && r.level === 'need_decision')
  const pendingSignals = signals.filter((s) => s.status === 'pending_execution' || s.status === 'pending_confirmation')
  const agentState = agentRunning ? { label: '运行中', color: token.colorSuccess } : agentActive ? { label: '待命', color: token.colorWarning } : { label: '已停止', color: token.colorTextTertiary }
  const openAlerts = alerts.filter((a) => a.status === 'open')

  return (
    <div className="dd-home">
      {/* 左列：Agent 对话流 */}
      <div className="dd-home-main">
        <div className="dd-chat">
          <div className="dd-chat-head">
            <div className="dd-toolbar">
              <span style={{ fontWeight: 600, fontSize: 13 }}>对话</span>
              <span className="dd-toolbar" style={{ gap: 5 }}>
                <span className="dd-dot" style={{ background: agentState.color }} />
                <span className="dd-muted">{agentState.label}</span>
              </span>
              <Tag style={{ marginInlineEnd: 0 }} color={runMode === 'auto' ? 'orange' : 'default'}>
                {runMode === 'auto' ? '自动模式' : '手动模式'}
              </Tag>
            </div>
            <div className="dd-toolbar">
              <span className="dd-muted">{messages.length} 条消息</span>
              <Button size="small" type="text" icon={<ReloadOutlined />} loading={refreshing} onClick={() => void manualRefresh()}>
                刷新
              </Button>
            </div>
          </div>

          <div className="dd-chat-list-wrap">
            <div className="dd-chat-list" ref={listRef} onScroll={onScroll}>
              {/* 顶部：加载更早消息指示 */}
              <div className="dd-chat-top">
                {loadingMore ? (
                  <>
                    <Spin size="small" /> <span>正在加载更早消息…</span>
                  </>
                ) : !hasMore && messages.length > 0 ? (
                  <span>已到最早消息</span>
                ) : null}
              </div>
              {groups.length === 0 && !loadingMore ? (
                <div className="dd-chat-empty">
                  <Empty description={false} image={Empty.PRESENTED_IMAGE_SIMPLE} />
                  <div style={{ fontSize: 13, fontWeight: 600 }}>还没有对话</div>
                  <div style={{ fontSize: 12 }}>向 Agent 下达指令、回答问题或响应决策</div>
                </div>
              ) : (
                groups.map(renderGroup)
              )}
            </div>
            {!atBottom && messages.length > 0 ? (
              <Tooltip title="回到底部">
                <Button className="dd-chat-jump" shape="circle" size="small" icon={<VerticalAlignBottomOutlined />} onClick={scrollToBottom} />
              </Tooltip>
            ) : null}
          </div>

          <div className="dd-chat-sender">
            {messages.length === 0 ? (
              <div className="dd-chip-row" style={{ marginBottom: 8 }}>
                {SUGGESTIONS.map((s) => (
                  <button key={s} className="dd-chip" onClick={() => setInput(s)}>
                    {s}
                  </button>
                ))}
              </div>
            ) : null}
            <Sender
              value={input}
              onChange={setInput}
              onSubmit={send}
              loading={sending}
              placeholder={agentRunning ? '向 Agent 下达指令或提问…' : 'Agent 未运行：可先发送，启动后处理'}
              disabled={!accountId}
            />
            <div className="dd-chat-hint">Enter 发送 · Shift + Enter 换行</div>
          </div>
        </div>
      </div>

      {/* 右列：账户与运行信息 */}
      <aside className="dd-rail">
        <Panel
          title="账户概览"
          extra={<span className="dd-card-sub">{summary ? `${summary.positionCount} 只持仓` : '—'}</span>}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginBottom: 10 }}>
            <span className="dd-kpi-label">总资产（元）</span>
            <span className="dd-kpi-value" style={{ fontSize: 25 }}>
              {summary ? fmtMoney(summary.totalAssets) : '—'}
            </span>
            <span className="dd-kpi-sub">
              今日 <span className={pnlClass(summary?.todayPnl)}>{fmtSigned(summary?.todayPnl)}</span>
              <span style={{ margin: '0 6px', color: token.colorBorder }}>|</span>
              总盈亏 <span className={pnlClass(summary?.totalPnl)}>{fmtSigned(summary?.totalPnl)}</span>
            </span>
          </div>
          <div className="dd-list">
            <div className="dd-row" style={{ padding: '3px 0' }}>
              <span className="dd-row-label">可用资金</span>
              <span className="dd-row-value">{summary ? fmtMoney(summary.cash) : '—'}</span>
            </div>
            <div className="dd-row" style={{ padding: '3px 0' }}>
              <span className="dd-row-label">持仓市值</span>
              <span className="dd-row-value">{summary ? fmtMoney(summary.marketValue) : '—'}</span>
            </div>
            <div className="dd-row" style={{ padding: '3px 0' }}>
              <span className="dd-row-label">持仓盈亏</span>
              <span className={`dd-row-value ${pnlClass(summary?.positionPnl)}`}>{summary ? fmtSigned(summary.positionPnl) : '—'}</span>
            </div>
          </div>
          <div style={{ marginTop: 10 }}>
            <div className="dd-row" style={{ marginBottom: 2 }}>
              <span className="dd-row-label">仓位占比</span>
              <span className="dd-row-value">{summary ? `${summary.positionPct.toFixed(1)}%` : '—'}</span>
            </div>
            <Progress percent={Math.min(100, summary?.positionPct ?? 0)} showInfo={false} size="small" />
          </div>
        </Panel>

        {pendingDecisions.length > 0 ? (
          <Panel
            title="待决策事项"
            extra={<Tag color="orange" style={{ marginInlineEnd: 0 }}>{pendingDecisions.length}</Tag>}
            bodyClassName="dd-card-body-tight"
          >
            <div className="dd-list">
              {pendingDecisions.slice(0, 3).map((r) => (
                <div key={r.id} className="dd-list-item">
                  <div style={{ fontWeight: 600, fontSize: 13 }}>{r.title}</div>
                  <div className="dd-muted" style={{ fontSize: 12, lineHeight: 1.6 }}>
                    {r.summary}
                  </div>
                  <div style={{ display: 'flex', gap: 6, marginTop: 2 }}>
                    <Button size="small" type="primary" onClick={() => respond(r.id, 'approved')}>
                      批准
                    </Button>
                    <Button size="small" onClick={() => respond(r.id, 'rejected')}>
                      驳回
                    </Button>
                    <Button size="small" onClick={() => respond(r.id, 'postponed')}>
                      暂缓
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </Panel>
        ) : null}

        <Panel title="Agent 状态" extra={<span className="dd-card-sub">{pendingSignals.length} 条待处理信号</span>}>
          <div className="dd-list">
            <div className="dd-row" style={{ padding: '3px 0' }}>
              <span className="dd-row-label">运行状态</span>
              <span className="dd-toolbar" style={{ gap: 5 }}>
                <span className={`dd-dot${agentRunning ? ' dd-pulse' : ''}`} style={{ background: agentState.color }} />
                <span className="dd-field-value">{agentState.label}</span>
              </span>
            </div>
            <div className="dd-row" style={{ padding: '3px 0' }}>
              <span className="dd-row-label">运行模式</span>
              <span className="dd-field-value">{runMode === 'auto' ? '自动' : '手动'}</span>
            </div>
            <div className="dd-row" style={{ padding: '3px 0' }}>
              <span className="dd-row-label">最近事件</span>
              <span className="dd-field-value" style={{ fontWeight: 500 }}>
                {lastEvent ? eventLabel(lastEvent.type) : '—'}
              </span>
            </div>
          </div>
        </Panel>

        <Panel
          title="最近信号"
          extra={<span className="dd-card-sub">{pendingSignals.length > 0 ? `${pendingSignals.length} 条待处理` : '全部已处理'}</span>}
          bodyClassName="dd-card-body-tight"
        >
          {signals.length === 0 ? (
            <div className="dd-empty" style={{ padding: '14px 0' }}>
              暂无信号
            </div>
          ) : (
            <div className="dd-list">
              {signals.slice(0, 5).map((s) => (
                <div key={s.id} className="dd-row" style={{ padding: '5px 0' }}>
                  <span className="dd-toolbar" style={{ gap: 6, minWidth: 0 }}>
                    <Tag color={s.side === 'buy' ? 'red' : 'green'} style={{ marginInlineEnd: 0 }}>
                      {s.side === 'buy' ? '买' : '卖'}
                    </Tag>
                    <span style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>{s.code}</span>
                    <span className="dd-muted" style={{ fontSize: 11 }}>
                      {s.qty} 股 @ {s.refPrice}
                    </span>
                  </span>
                  <Tag
                    style={{ marginInlineEnd: 0 }}
                    color={s.status === 'pending_execution' || s.status === 'pending_confirmation' ? 'blue' : 'default'}
                  >
                    {s.status === 'pending_confirmation' ? '待确认' : s.status === 'pending_execution' ? '待执行' : s.status === 'executed' ? '已执行' : s.status === 'ignored' ? '已忽略' : '已过期'}
                  </Tag>
                </div>
              ))}
            </div>
          )}
        </Panel>

        <Panel title="行情数据" extra={<span className="dd-card-sub">全局共享</span>}>
          <div className="dd-list">
            <div className="dd-row" style={{ padding: '3px 0' }}>
              <span className="dd-row-label">股票数</span>
              <span className="dd-row-value">{dataStats ? String(dataStats.stocks ?? '—') : '—'}</span>
            </div>
            <div className="dd-row" style={{ padding: '3px 0' }}>
              <span className="dd-row-label">K 线行数</span>
              <span className="dd-row-value">{dataStats ? String(dataStats.bars ?? '—') : '—'}</span>
            </div>
            <div className="dd-row" style={{ padding: '3px 0' }}>
              <span className="dd-row-label">日期范围</span>
              <span className="dd-row-value" style={{ fontSize: 12, fontWeight: 500 }}>
                {String(dataStats?.minDate ?? '—')} ~ {String(dataStats?.maxDate ?? '—')}
              </span>
            </div>
          </div>
        </Panel>

        <Panel
          title="最近预警"
          extra={
            openAlerts.length > 0 ? (
              <Tag color="orange" style={{ marginInlineEnd: 0 }}>
                {openAlerts.length} 待确认
              </Tag>
            ) : (
              <span className="dd-card-sub">无未处理</span>
            )
          }
          bodyClassName="dd-card-body-tight"
        >
          {alerts.length === 0 ? (
            <div className="dd-empty" style={{ padding: '14px 0' }}>
              暂无预警
            </div>
          ) : (
            <div className="dd-list">
              {alerts.map((a) => (
                <div key={a.id} className="dd-row" style={{ padding: '5px 0' }}>
                  <span style={{ minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                    <span style={{ fontSize: 12 }}>{a.type}</span>
                    <span className="dd-muted" style={{ fontSize: 11 }}>
                      {fmtTime(a.createdAt)}
                    </span>
                  </span>
                  <Tag style={{ marginInlineEnd: 0 }} color={a.level === 'critical' ? 'red' : a.level === 'warn' ? 'orange' : 'default'}>
                    {a.level === 'critical' ? '严重' : a.level === 'warn' ? '警告' : '提示'}
                  </Tag>
                </div>
              ))}
            </div>
          )}
        </Panel>
      </aside>
    </div>
  )
}
