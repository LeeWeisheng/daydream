/**
 * 首页：两列布局（左右实线分隔）。
 * 左列：与 Agent 的对话流（@ant-design/x Bubble + Sender，持久化于 chat_message）——
 *   适配 Claude Code 全部消息格式（text/thinking/tool_use/tool_result/system/result…），
 *   运行细节按工作项分组折叠，默认只展示主要结果；
 *   每条消息展示头像、角色、时间与来源/类型标签；向上滚动分页加载更早消息。
 * 右列：统计数据与重要内容（无卡片，虚线分隔区块）。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Bubble, Sender } from '@ant-design/x'
import { Avatar, Button, Empty, Spin, Tag, message } from 'antd'
import { useAntdToken } from 'antd-style'
import { CheckOutlined, CloseOutlined, DownOutlined, RightOutlined, RobotOutlined, UserOutlined, BellOutlined } from '@ant-design/icons'
import type { AccountSummary, Alert, ChatMessage, Report, Signal } from '@shared/types'
import { useAppStore } from '../stores'

const PAGE_SIZE = 100

/** 主要消息：渲染为主气泡（其余为运行细节，默认折叠） */
function isMainMessage(m: ChatMessage): boolean {
  if (m.role === 'user') return true
  return m.kind === 'result' || m.kind === 'error' || m.kind === 'report' || m.kind === 'text'
}

interface Group {
  key: string
  main: ChatMessage
  details: ChatMessage[]
}

/** 按时间顺序分组：细节消息归入其前最近的一个主消息组 */
function buildGroups(messages: ChatMessage[]): Group[] {
  const groups: Group[] = []
  for (const m of messages) {
    if (isMainMessage(m)) {
      groups.push({ key: m.id, main: m, details: [] })
    } else if (groups.length > 0) {
      groups[groups.length - 1].details.push(m)
    } else {
      // 孤儿细节（无前置主消息）：作为独立组渲染
      groups.push({ key: m.id, main: m, details: [] })
    }
  }
  return groups
}

/** 时间格式化：MM-DD HH:mm */
function fmtTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 消息来源/类型标签（尽可能展示多的信息：角色、时间、来源、类型） */
function messageMeta(m: ChatMessage): { roleLabel: string; tags: { label: string; color: string }[] } {
  const tags: { label: string; color: string }[] = []
  let roleLabel = m.role === 'user' ? '用户' : 'Agent'
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
      label = `工具调用 · ${String(meta?.toolName ?? '')}`
      color = 'blue'
      content = meta?.input !== undefined ? `入参：${JSON.stringify(meta.input)}` : content
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
      <Tag color={color} style={{ marginRight: 6 }}>
        {label}
      </Tag>
      <span className="dd-detail-time">{fmtTime(msg.createdAt)}</span>
      <span className="dd-detail-content">{content}</span>
    </div>
  )
}

export default function Home(): React.ReactNode {
  const { currentAccount, agentRunning, agentActive, lastEvent, eventSeq } = useAppStore()
  const token = useAntdToken()
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [hasMore, setHasMore] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [summary, setSummary] = useState<AccountSummary | null>(null)
  const [signals, setSignals] = useState<Signal[]>([])
  const [reports, setReports] = useState<Report[]>([])
  const [alerts, setAlerts] = useState<Alert[]>([])
  const [dataStats, setDataStats] = useState<Record<string, unknown> | null>(null)
  /** 展开的运行细节组（默认全部收起，只展示主要结果） */
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set())
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

  /** 事件驱动的增量刷新：追加新消息 + 刷新右列数据 */
  const refresh = useCallback(async () => {
    if (!accountId) return
    const [sum, sigs, reps, als, stats] = await Promise.allSettled([
      window.daydream.trades.accountSummary(accountId),
      window.daydream.signals.list(accountId, 5),
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
    atBottomRef.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 120
    // 向上滚动接近顶部 → 加载更早消息
    if (el.scrollTop < 60 && hasMoreRef.current && !loadingMoreRef.current) void loadMore()
  }

  const send = async (text: string): Promise<void> => {
    if (!text.trim() || !accountId) return
    setSending(true)
    setInput('')
    atBottomRef.current = true
    try {
      await window.daydream.chat.send({ accountId, message: text.trim() })
      // 消息经 chat.message 事件回流刷新（不本地伪造，避免与持久化消息重复）
      message.success('已发送给 Agent')
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

  const groups = useMemo(() => buildGroups(messages), [messages])

  const renderBubble = (g: Group): React.ReactNode => {
    const m = g.main
    const { roleLabel, tags } = messageMeta(m)
    return (
      <div key={g.key} className="dd-chat-group">
        <Bubble
          placement={m.role === 'user' ? 'end' : 'start'}
          variant={m.role === 'user' ? 'filled' : 'outlined'}
          shape="corner"
          avatar={
            m.role === 'user' ? (
              <Avatar size={30} style={{ background: token.colorPrimary, flex: 'none' }} icon={<UserOutlined />} />
            ) : (
              <Avatar size={30} style={{ background: m.kind === 'error' ? token.colorError : token.colorSuccess, flex: 'none' }} icon={m.kind === 'report' ? <BellOutlined /> : <RobotOutlined />} />
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
            </div>
          }
          content={<div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{m.content}</div>}
          footer={
            m.kind === 'report' && m.reportLevel === 'need_decision' && (m.reportStatus === 'pending' || !m.reportStatus) ? (
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
              {openGroups.has(g.key) ? '收起运行细节' : `运行细节（${g.details.length}）`}
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
    )
  }

  const pendingDecisions = reports.filter((r) => r.status === 'pending' && r.level === 'need_decision')
  const pendingSignals = signals.filter((s) => s.status === 'pending_execution' || s.status === 'pending_confirmation')

  return (
    <div className="dd-home">
      {/* 左列：Agent 对话流 */}
      <div className="dd-home-left">
        <div className="dd-chat">
          <div className="dd-chat-list" ref={listRef} onScroll={onScroll}>
            {/* 顶部：加载更早消息指示 */}
            <div className="dd-chat-top">
              {loadingMore && <Spin size="small" />}
              {!hasMore && messages.length > 0 && !loadingMore && <span className="dd-muted">已到最早消息</span>}
            </div>
            {groups.length === 0 && !loadingMore ? (
              <div className="dd-chat-empty">
                <Empty description={false} image={Empty.PRESENTED_IMAGE_SIMPLE} />
                <div>与 Agent 对话：下达指令、回答问题、响应决策</div>
              </div>
            ) : (
              groups.map(renderBubble)
            )}
          </div>
          <div className="dd-chat-sender">
            <Sender
              value={input}
              onChange={setInput}
              onSubmit={send}
              loading={sending}
              placeholder="向 Agent 下达指令或提问…"
              disabled={!accountId}
            />
          </div>
        </div>
      </div>

      {/* 右列：统计与重要内容（虚线分区块，无卡片） */}
      <div className="dd-home-right">
        <div className="dd-section">
          <div className="dd-section-title">Agent 状态</div>
          <div className="dd-stat-row">
            <span className="dd-stat-label">运行状态</span>
            <Tag color={agentRunning ? 'success' : 'default'}>{agentRunning ? '运行中' : agentActive ? '待命' : '已停止'}</Tag>
          </div>
          <div className="dd-stat-row">
            <span className="dd-stat-label">最近事件</span>
            <span className="dd-stat-value">{lastEvent ? String(lastEvent.type) : '—'}</span>
          </div>
        </div>

        <div className="dd-section">
          <div className="dd-section-title">账户概览</div>
          <div className="dd-stat-row">
            <span className="dd-stat-label">总资产</span>
            <span className="dd-stat-value">{summary ? summary.totalAssets.toLocaleString() : '—'}</span>
          </div>
          <div className="dd-stat-row">
            <span className="dd-stat-label">可用资金</span>
            <span className="dd-stat-value">{summary ? summary.cash.toLocaleString() : '—'}</span>
          </div>
          <div className="dd-stat-row">
            <span className="dd-stat-label">持仓市值</span>
            <span className="dd-stat-value">{summary ? summary.marketValue.toLocaleString() : '—'}</span>
          </div>
          <div className="dd-stat-row">
            <span className="dd-stat-label">持仓盈亏</span>
            <span className={`dd-stat-value ${(summary?.positionPnl ?? 0) >= 0 ? 'dd-up' : 'dd-down'}`}>
              {summary ? `${summary.positionPnl >= 0 ? '+' : ''}${summary.positionPnl.toLocaleString()}` : '—'}
            </span>
          </div>
          <div className="dd-stat-row">
            <span className="dd-stat-label">仓位占比</span>
            <span className="dd-stat-value">{summary ? `${summary.positionPct}%` : '—'}</span>
          </div>
        </div>

        <div className="dd-section">
          <div className="dd-section-title">最近信号（{pendingSignals.length} 条待处理）</div>
          {signals.length === 0 ? (
            <div className="dd-muted">暂无信号</div>
          ) : (
            signals.slice(0, 5).map((s) => (
              <div key={s.id} className="dd-stat-row">
                <span className="dd-stat-label">
                  {s.code} {s.side === 'buy' ? '买入' : '卖出'} {s.qty} 股
                </span>
                <Tag color={s.side === 'buy' ? 'red' : 'green'}>{s.status}</Tag>
              </div>
            ))
          )}
        </div>

        <div className="dd-section">
          <div className="dd-section-title">待决策事项（{pendingDecisions.length}）</div>
          {pendingDecisions.length === 0 ? (
            <div className="dd-muted">暂无待决策事项</div>
          ) : (
            pendingDecisions.slice(0, 5).map((r) => (
              <div key={r.id} className="dd-dashed-line" style={{ padding: '4px 0' }}>
                <div style={{ fontWeight: 600, marginBottom: 4 }}>{r.title}</div>
                <div className="dd-muted" style={{ fontSize: 12, marginBottom: 6 }}>
                  {r.summary}
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
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
            ))
          )}
        </div>

        <div className="dd-section">
          <div className="dd-section-title">数据状态</div>
          {dataStats ? (
            <>
              <div className="dd-stat-row">
                <span className="dd-stat-label">股票数</span>
                <span className="dd-stat-value">{String(dataStats.stocks ?? '—')}</span>
              </div>
              <div className="dd-stat-row">
                <span className="dd-stat-label">K 线行数</span>
                <span className="dd-stat-value">{String(dataStats.bars ?? '—')}</span>
              </div>
              <div className="dd-stat-row">
                <span className="dd-stat-label">日期范围</span>
                <span className="dd-stat-value" style={{ fontSize: 12 }}>
                  {String(dataStats.minDate ?? '—')} ~ {String(dataStats.maxDate ?? '—')}
                </span>
              </div>
            </>
          ) : (
            <div className="dd-muted">—</div>
          )}
        </div>

        <div className="dd-section">
          <div className="dd-section-title">最近预警</div>
          {alerts.length === 0 ? (
            <div className="dd-muted">暂无预警</div>
          ) : (
            alerts.map((a) => (
              <div key={a.id} className="dd-stat-row">
                <span className="dd-stat-label">{a.type}</span>
                <Tag color={a.level === 'critical' ? 'red' : a.level === 'warn' ? 'orange' : 'default'}>{a.level}</Tag>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
