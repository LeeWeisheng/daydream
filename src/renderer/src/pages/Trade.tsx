/**
 * 交易页：资金概览（KPI + 曲线）/ 下单录入 / 持仓与仓位 / 交易建议 / 成交记录 / 预警。
 * 交易由人工执行：买入/卖出在应用内录入，联动可用资金与持仓（主进程事务）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Tabs,
  Table,
  Form,
  InputNumber,
  Button,
  Select,
  Modal,
  Tag,
  message,
  Space,
  Progress,
  Segmented,
  Popconfirm,
  Alert,
  Empty,
  Badge,
  Tooltip
} from 'antd'
import { useAntdToken } from 'antd-style'
import * as echarts from 'echarts'
import {
  DeleteOutlined,
  EditOutlined,
  PlusOutlined,
  ReloadOutlined,
  ThunderboltOutlined,
  CheckOutlined,
  StopOutlined,
  ArrowUpOutlined,
  ArrowDownOutlined
} from '@ant-design/icons'
import { calcFee, LOT_SIZE } from '@shared/constants'
import type { AccountSummary, Alert as AlertRecord, Position, Signal, TradeRecord } from '@shared/types'
import { useAppStore } from '../stores'
import PageHeader from '../components/PageHeader'
import Panel from '../components/Panel'
import StatCard from '../components/StatCard'
import { fmtDateTime, fmtMoney, fmtSigned, pnlClass } from '../lib/format'

const SIGNAL_STATUS: Record<string, { color: string; label: string }> = {
  pending_confirmation: { color: 'orange', label: '待确认' },
  pending_execution: { color: 'blue', label: '待执行' },
  executed: { color: 'green', label: '已执行' },
  ignored: { color: 'default', label: '已忽略' },
  expired: { color: 'default', label: '已过期' }
}

const ALERT_LEVEL: Record<string, { color: string; label: string }> = {
  critical: { color: 'red', label: '严重' },
  warn: { color: 'orange', label: '警告' },
  info: { color: 'default', label: '提示' }
}

/** 距离到期的可读描述 */
function expiryText(iso: string): { text: string; expired: boolean } {
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return { text: '—', expired: false }
  const diff = t - Date.now()
  if (diff <= 0) return { text: '已到期', expired: true }
  const hours = diff / 3600_000
  if (hours >= 24) return { text: `${Math.floor(hours / 24)} 天 ${Math.floor(hours % 24)} 小时`, expired: false }
  return { text: `${Math.floor(hours)} 小时 ${Math.floor((hours % 1) * 60)} 分`, expired: false }
}

function EquityCurve({ data }: { data: { date: string; totalAssets: number }[] }): React.ReactNode {
  const token = useAntdToken()
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!ref.current || data.length === 0) return
    const chart = echarts.init(ref.current, undefined, { renderer: 'svg' })
    chart.setOption({
      backgroundColor: 'transparent',
      tooltip: {
        trigger: 'axis',
        valueFormatter: (v: number) => fmtMoney(v as number)
      },
      grid: { left: 8, right: 12, top: 16, bottom: 4, containLabel: true },
      xAxis: {
        type: 'category',
        data: data.map((d) => d.date),
        axisLabel: { fontSize: 10, color: token.colorTextTertiary, hideOverlap: true },
        axisLine: { lineStyle: { color: token.colorBorderSecondary } },
        axisTick: { show: false }
      },
      yAxis: {
        type: 'value',
        scale: true,
        axisLabel: {
          fontSize: 10,
          color: token.colorTextTertiary,
          formatter: (v: number) => (Math.abs(v) >= 10000 ? `${(v / 10000).toFixed(1)}万` : String(v))
        },
        splitLine: { lineStyle: { color: token.colorBorderSecondary, type: 'dashed' } }
      },
      series: [
        {
          name: '总资产',
          type: 'line',
          data: data.map((d) => d.totalAssets),
          showSymbol: false,
          smooth: true,
          lineStyle: { color: token.colorPrimary, width: 1.6 },
          areaStyle: { color: 'rgba(22,119,255,0.10)' }
        }
      ]
    })
    const onResize = (): void => chart.resize()
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      chart.dispose()
    }
  }, [data, token])
  return <div ref={ref} style={{ width: '100%', height: 250 }} />
}

export default function Trade(): React.ReactNode {
  const { currentAccount, eventSeq } = useAppStore()
  const token = useAntdToken()
  const accountId = currentAccount?.id ?? ''
  const [summary, setSummary] = useState<AccountSummary | null>(null)
  const [positions, setPositions] = useState<Position[]>([])
  const [signals, setSignals] = useState<Signal[]>([])
  const [trades, setTrades] = useState<TradeRecord[]>([])
  const [alerts, setAlerts] = useState<AlertRecord[]>([])
  const [stockNames, setStockNames] = useState<Record<string, string>>({})
  const [tab, setTab] = useState('overview')
  const [refreshing, setRefreshing] = useState(false)

  // 买卖表单
  const [orderSide, setOrderSide] = useState<'buy' | 'sell'>('buy')
  const [orderCode, setOrderCode] = useState('')
  const [orderPrice, setOrderPrice] = useState<number | null>(null)
  const [orderQty, setOrderQty] = useState<number | null>(null)
  const [submitting, setSubmitting] = useState(false)

  // 持仓维护弹窗
  const [posModal, setPosModal] = useState(false)
  const [posEdit, setPosEdit] = useState<{ code: string; qty: number; costPrice: number }>({ code: '', qty: 0, costPrice: 0 })

  // 信号反馈弹窗
  const [sigModal, setSigModal] = useState<Signal | null>(null)
  const [sigPrice, setSigPrice] = useState<number | null>(null)
  const [sigQty, setSigQty] = useState<number | null>(null)

  // 列表筛选
  const [signalFilter, setSignalFilter] = useState<'all' | 'pending' | 'done'>('all')
  const [tradeFilter, setTradeFilter] = useState<'all' | 'buy' | 'sell'>('all')
  const [alertFilter, setAlertFilter] = useState<'open' | 'all'>('open')

  const refresh = useCallback(async () => {
    if (!accountId) return
    const [sum, pos, sig, trd, alr] = await Promise.allSettled([
      window.daydream.trades.accountSummary(accountId),
      window.daydream.positions.list(accountId),
      window.daydream.signals.list(accountId, 200),
      window.daydream.trades.list(accountId),
      window.daydream.alerts.list(accountId)
    ])
    if (sum.status === 'fulfilled') setSummary(sum.value)
    if (pos.status === 'fulfilled') setPositions(pos.value)
    if (sig.status === 'fulfilled') setSignals(sig.value)
    if (trd.status === 'fulfilled') setTrades(trd.value)
    if (alr.status === 'fulfilled') setAlerts(alr.value)
  }, [accountId])

  useEffect(() => {
    void refresh()
  }, [refresh, eventSeq])

  useEffect(() => {
    window.daydream.data
      .getStockList()
      .then((list) => setStockNames(Object.fromEntries(list.map((s) => [s.code, s.name]))))
      .catch(() => undefined)
  }, [])

  const manualRefresh = async (): Promise<void> => {
    setRefreshing(true)
    try {
      await refresh()
    } finally {
      setRefreshing(false)
    }
  }

  const stockOptions = useMemo(
    () => Object.entries(stockNames).map(([code, name]) => ({ value: code, label: `${code} ${name}` })),
    [stockNames]
  )

  // ---------- 派生数据 ----------
  const pendingSignals = signals.filter((s) => s.status === 'pending_execution' || s.status === 'pending_confirmation')
  const openAlerts = alerts.filter((a) => a.status === 'open')

  const filteredSignals = useMemo(() => {
    if (signalFilter === 'pending') return signals.filter((s) => s.status === 'pending_execution' || s.status === 'pending_confirmation')
    if (signalFilter === 'done') return signals.filter((s) => s.status === 'executed' || s.status === 'ignored' || s.status === 'expired')
    return signals
  }, [signals, signalFilter])

  const filteredTrades = useMemo(
    () => (tradeFilter === 'all' ? trades : trades.filter((t) => t.side === tradeFilter)),
    [trades, tradeFilter]
  )

  const filteredAlerts = useMemo(() => (alertFilter === 'open' ? openAlerts : alerts), [alerts, openAlerts, alertFilter])

  const heldQty = positions.find((p) => p.code === orderCode)?.qty ?? 0
  const orderAmount = (orderPrice ?? 0) * (orderQty ?? 0) * LOT_SIZE
  const orderFee = orderAmount > 0 ? calcFee(orderSide, orderAmount) : 0
  const buyTotal = orderAmount + orderFee
  const sellNet = orderAmount - orderFee
  const overCash = orderSide === 'buy' && summary != null && buyTotal > summary.cash
  const overHeld = orderSide === 'sell' && orderQty != null && orderQty * LOT_SIZE > heldQty

  /** 行业/名称展示：代码 + 名称 */
  const codeName = (code: string): React.ReactNode => (
    <span style={{ display: 'inline-flex', flexDirection: 'column', lineHeight: 1.35 }}>
      <span style={{ fontVariantNumeric: 'tabular-nums' }}>{code}</span>
      <span className="dd-muted" style={{ fontSize: 11 }}>
        {stockNames[code] ?? '—'}
      </span>
    </span>
  )

  const submitOrder = async (): Promise<void> => {
    if (!accountId || !orderCode || !orderPrice || !orderQty) {
      message.warning('请完整填写股票、价格与数量')
      return
    }
    if (overCash) {
      message.warning('可用资金不足，请调整数量或价格')
      return
    }
    if (overHeld) {
      message.warning(`卖出数量超过持仓（可卖 ${heldQty} 股）`)
      return
    }
    setSubmitting(true)
    try {
      await window.daydream.trades.order({ accountId, code: orderCode, side: orderSide, price: orderPrice, qty: orderQty * LOT_SIZE })
      message.success(`${orderSide === 'buy' ? '买入' : '卖出'}已录入，资金与持仓已联动更新`)
      setOrderCode('')
      setOrderPrice(null)
      setOrderQty(null)
      void refresh()
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setSubmitting(false)
    }
  }

  /** 选择标的后自动带出最新价（取不到则保持手填） */
  const selectCode = async (code: string): Promise<void> => {
    setOrderCode(code)
    try {
      const quote = await window.daydream.data.getQuote([code])
      const price = quote?.[0]?.price
      if (price && price > 0) setOrderPrice(Number(price.toFixed(2)))
    } catch {
      /* 忽略：允许手动填写 */
    }
  }

  const savePosition = async (): Promise<void> => {
    if (!accountId || !posEdit.code || posEdit.qty <= 0) {
      message.warning('请填写股票代码与数量（>0）')
      return
    }
    try {
      await window.daydream.positions.upsert({ accountId, code: posEdit.code, qty: posEdit.qty, costPrice: posEdit.costPrice })
      message.success('持仓已保存')
      setPosModal(false)
      void refresh()
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  const removePosition = async (code: string): Promise<void> => {
    try {
      await window.daydream.positions.upsert({ accountId, code, qty: 0, costPrice: 0 })
      message.success('已删除持仓')
      void refresh()
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  const feedback = async (feedback: 'executed' | 'ignored'): Promise<void> => {
    if (!sigModal) return
    try {
      await window.daydream.signals.feedback({
        signalId: sigModal.id,
        feedback,
        tradedPrice: feedback === 'executed' ? (sigPrice ?? sigModal.refPrice) : undefined,
        tradedQty: feedback === 'executed' ? (sigQty ?? sigModal.qty) : undefined
      })
      message.success(feedback === 'executed' ? '已标记执行（资金与持仓已联动）' : '已忽略')
      setSigModal(null)
      void refresh()
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  const ignoreSignal = (s: Signal): void => {
    window.daydream.signals
      .feedback({ signalId: s.id, feedback: 'ignored' })
      .then(() => {
        message.success('已忽略')
        void refresh()
      })
      .catch((e) => message.error((e as Error).message))
  }

  const acknowledgeAlert = (id: string): void => {
    window.daydream.alerts
      .acknowledge(id)
      .then(() => refresh())
      .catch((e) => message.error((e as Error).message))
  }

  const acknowledgeAll = async (): Promise<void> => {
    try {
      await Promise.all(openAlerts.map((a) => window.daydream.alerts.acknowledge(a.id)))
      message.success('已确认全部预警')
      void refresh()
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  // ---------- 表格列 ----------
  const positionColumns = [
    { title: '标的', dataIndex: 'code', key: 'code', width: 110, render: (c: string) => codeName(c) },
    { title: '数量（股）', dataIndex: 'qty', key: 'qty', width: 96, align: 'right' as const, render: (v: number) => fmtMoney(v, 0) },
    { title: '成本价', dataIndex: 'costPrice', key: 'costPrice', width: 90, align: 'right' as const, render: (v: number) => v.toFixed(2) },
    {
      title: '现价',
      key: 'price',
      width: 90,
      align: 'right' as const,
      render: (_: unknown, p: Position) => {
        const d = summary?.positions.find((x) => x.code === p.code)
        return d ? d.price.toFixed(2) : '—'
      }
    },
    {
      title: '市值',
      key: 'mv',
      width: 108,
      align: 'right' as const,
      sorter: (a: Position, b: Position) =>
        (summary?.positions.find((d) => d.code === a.code)?.marketValue ?? 0) -
        (summary?.positions.find((d) => d.code === b.code)?.marketValue ?? 0),
      render: (_: unknown, p: Position) => {
        const d = summary?.positions.find((x) => x.code === p.code)
        return d ? fmtMoney(d.marketValue) : '—'
      }
    },
    {
      title: '盈亏',
      key: 'pnl',
      width: 130,
      align: 'right' as const,
      sorter: (a: Position, b: Position) =>
        (summary?.positions.find((d) => d.code === a.code)?.pnl ?? 0) - (summary?.positions.find((d) => d.code === b.code)?.pnl ?? 0),
      render: (_: unknown, p: Position) => {
        const d = summary?.positions.find((x) => x.code === p.code)
        if (!d) return '—'
        return (
          <span style={{ display: 'inline-flex', flexDirection: 'column', lineHeight: 1.35 }} className={pnlClass(d.pnl)}>
            <span>{fmtSigned(d.pnl)}</span>
            <span style={{ fontSize: 11 }}>{fmtSigned(d.pnlPct)}%</span>
          </span>
        )
      }
    },
    {
      title: '仓位',
      key: 'pct',
      width: 110,
      render: (_: unknown, p: Position) => {
        const d = summary?.positions.find((x) => x.code === p.code)
        if (!d) return '—'
        return (
          <div>
            <div className="dd-muted" style={{ fontSize: 11, marginBottom: 2 }}>
              {d.positionPct.toFixed(1)}%
            </div>
            <Progress percent={Math.min(100, d.positionPct)} showInfo={false} size="small" />
          </div>
        )
      }
    },
    {
      title: '操作',
      key: 'op',
      width: 110,
      render: (_: unknown, p: Position) => (
        <Space size={4}>
          <Tooltip title="编辑持仓">
            <Button
              size="small"
              icon={<EditOutlined />}
              onClick={() => {
                setPosEdit({ code: p.code, qty: p.qty, costPrice: p.costPrice })
                setPosModal(true)
              }}
            />
          </Tooltip>
          <Popconfirm title="删除该持仓？" okText="删除" okButtonProps={{ danger: true }} onConfirm={() => void removePosition(p.code)}>
            <Button size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      )
    }
  ]

  const signalColumns = [
    { title: '时间', dataIndex: 'createdAt', key: 'createdAt', width: 150, render: (v: string) => fmtDateTime(v) },
    { title: '标的', dataIndex: 'code', key: 'code', width: 110, render: (c: string) => codeName(c) },
    {
      title: '方向',
      dataIndex: 'side',
      key: 'side',
      width: 72,
      render: (s: string) => (
        <Tag color={s === 'buy' ? 'red' : 'green'} style={{ marginInlineEnd: 0 }}>
          {s === 'buy' ? '买入' : '卖出'}
        </Tag>
      )
    },
    { title: '数量', dataIndex: 'qty', key: 'qty', width: 84, align: 'right' as const, render: (v: number) => fmtMoney(v, 0) },
    { title: '参考价', dataIndex: 'refPrice', key: 'refPrice', width: 84, align: 'right' as const, render: (v: number) => v.toFixed(2) },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 88,
      render: (s: string) => (
        <Tag color={SIGNAL_STATUS[s]?.color ?? 'default'} style={{ marginInlineEnd: 0 }}>
          {SIGNAL_STATUS[s]?.label ?? s}
        </Tag>
      )
    },
    {
      title: '剩余有效期',
      key: 'expires',
      width: 120,
      render: (_: unknown, s: Signal) => {
        const e = expiryText(s.expiresAt)
        return <span className={e.expired ? 'dd-muted' : undefined} style={{ fontSize: 12 }}>{e.text}</span>
      }
    },
    {
      title: '操作',
      key: 'op',
      width: 160,
      render: (_: unknown, s: Signal) =>
        s.status === 'pending_execution' || s.status === 'pending_confirmation' ? (
          <Space size={4}>
            <Button
              size="small"
              type="primary"
              onClick={() => {
                setSigModal(s)
                setSigPrice(s.refPrice)
                setSigQty(s.qty)
              }}
            >
              已执行
            </Button>
            <Button size="small" onClick={() => ignoreSignal(s)}>
              忽略
            </Button>
          </Space>
        ) : (
          <span className="dd-muted">—</span>
        )
    }
  ]

  const tradeColumns = [
    { title: '时间', dataIndex: 'tradedAt', key: 'tradedAt', width: 150, render: (v: string) => fmtDateTime(v) },
    { title: '标的', dataIndex: 'code', key: 'code', width: 110, render: (c: string) => codeName(c) },
    {
      title: '方向',
      dataIndex: 'side',
      key: 'side',
      width: 72,
      render: (s: string) => (
        <Tag color={s === 'buy' ? 'red' : 'green'} style={{ marginInlineEnd: 0 }}>
          {s === 'buy' ? '买入' : '卖出'}
        </Tag>
      )
    },
    { title: '价格', dataIndex: 'price', key: 'price', width: 84, align: 'right' as const, render: (v: number) => v.toFixed(2) },
    { title: '数量', dataIndex: 'qty', key: 'qty', width: 84, align: 'right' as const, render: (v: number) => fmtMoney(v, 0) },
    {
      title: '成交额',
      key: 'amount',
      width: 110,
      align: 'right' as const,
      render: (_: unknown, t: TradeRecord) => fmtMoney(t.price * t.qty)
    },
    { title: '费用', dataIndex: 'fee', key: 'fee', width: 84, align: 'right' as const, render: (v: number) => fmtMoney(v) },
    { title: '备注', dataIndex: 'note', key: 'note', ellipsis: true, render: (v?: string) => v ?? '—' }
  ]

  const alertColumns = [
    { title: '时间', dataIndex: 'createdAt', key: 'createdAt', width: 150, render: (v: string) => fmtDateTime(v) },
    {
      title: '级别',
      dataIndex: 'level',
      key: 'level',
      width: 80,
      render: (l: string) => (
        <Tag color={ALERT_LEVEL[l]?.color ?? 'default'} style={{ marginInlineEnd: 0 }}>
          {ALERT_LEVEL[l]?.label ?? l}
        </Tag>
      )
    },
    { title: '类型', dataIndex: 'type', key: 'type', width: 140 },
    {
      title: '内容',
      dataIndex: 'contentJson',
      key: 'contentJson',
      render: (v: string) => {
        try {
          return String((JSON.parse(v) as { content?: string }).content ?? '') || <span className="dd-muted">—</span>
        } catch {
          return v
        }
      }
    },
    {
      title: '状态',
      key: 'status',
      width: 90,
      render: (_: unknown, a: AlertRecord) =>
        a.status === 'open' ? <Tag color="processing" style={{ marginInlineEnd: 0 }}>待确认</Tag> : <span className="dd-muted">已确认</span>
    },
    {
      title: '操作',
      key: 'op',
      width: 90,
      render: (_: unknown, a: AlertRecord) =>
        a.status === 'open' ? (
          <Button size="small" onClick={() => acknowledgeAlert(a.id)}>
            确认
          </Button>
        ) : null
    }
  ]

  const posTotals = useMemo(() => {
    const list = summary?.positions ?? []
    return {
      marketValue: list.reduce((s, p) => s + p.marketValue, 0),
      pnl: list.reduce((s, p) => s + p.pnl, 0)
    }
  }, [summary])

  /** 持仓盈亏率：盈亏 / 持仓成本 */
  const positionPnlPct = useMemo(() => {
    if (!summary) return null
    const cost = summary.marketValue - summary.positionPnl
    if (cost <= 0) return null
    return summary.positionPnl / cost
  }, [summary])

  return (
    <div className="dd-page">
      <PageHeader
        title="交易"
        description="交易由人工在券商侧执行，此处录入真实成交用于统计；系统不接入券商通道。"
        extra={
          <Button size="small" icon={<ReloadOutlined />} loading={refreshing} onClick={() => void manualRefresh()}>
            刷新
          </Button>
        }
      />

      <div className="dd-kpi-grid">
        <StatCard label="总资产" value={summary ? fmtMoney(summary.totalAssets) : '—'} sub="可用资金 + 持仓市值" tone="primary" />
        <StatCard label="可用资金" value={summary ? fmtMoney(summary.cash) : '—'} sub={`初始 ${summary ? fmtMoney(summary.initialCash, 0) : '—'}`} />
        <StatCard label="持仓市值" value={summary ? fmtMoney(summary.marketValue) : '—'} sub={`${summary?.positionCount ?? 0} 只持仓`} />
        <StatCard
          label="持仓盈亏"
          value={summary ? fmtSigned(summary.positionPnl) : '—'}
          sub={positionPnlPct == null ? '盈亏率 —' : `盈亏率 ${fmtSigned(positionPnlPct * 100, 1)}%`}
          tone={(summary?.positionPnl ?? 0) >= 0 ? 'up' : 'down'}
        />
        <StatCard label="总盈亏" value={summary ? fmtSigned(summary.totalPnl) : '—'} sub="含已实现与浮动" tone={(summary?.totalPnl ?? 0) >= 0 ? 'up' : 'down'} />
        <StatCard label="仓位占比" value={summary ? `${summary.positionPct.toFixed(1)}%` : '—'} sub="持仓市值 / 总资产" />
      </div>

      <Tabs
        activeKey={tab}
        onChange={setTab}
        items={[
          {
            key: 'overview',
            label: '资金统计',
            children: (
              <div className="dd-grid-main-side">
                <Panel title="资金曲线" subtitle="每日收盘净值快照" flush>
                  <div style={{ padding: '10px 12px 4px' }}>
                    {summary && summary.equityCurve.length > 0 ? (
                      <EquityCurve data={summary.equityCurve} />
                    ) : (
                      <div className="dd-empty" style={{ padding: '60px 0' }}>
                        <Empty description={false} image={Empty.PRESENTED_IMAGE_SIMPLE} />
                        暂无净值快照：每日收盘后自动采集，交易录入后开始累积
                      </div>
                    )}
                  </div>
                </Panel>
                <Panel title="资金构成">
                  <div className="dd-list">
                    <div className="dd-row" style={{ padding: '4px 0' }}>
                      <span className="dd-row-label">初始资金</span>
                      <span className="dd-row-value">{summary ? fmtMoney(summary.initialCash) : '—'}</span>
                    </div>
                    <div className="dd-row" style={{ padding: '4px 0' }}>
                      <span className="dd-row-label">可用资金</span>
                      <span className="dd-row-value">{summary ? fmtMoney(summary.cash) : '—'}</span>
                    </div>
                    <div className="dd-row" style={{ padding: '4px 0' }}>
                      <span className="dd-row-label">持仓市值</span>
                      <span className="dd-row-value">{summary ? fmtMoney(summary.marketValue) : '—'}</span>
                    </div>
                    <div className="dd-row" style={{ padding: '4px 0' }}>
                      <span className="dd-row-label">今日盈亏</span>
                      <span className={`dd-row-value ${pnlClass(summary?.todayPnl)}`}>{summary ? fmtSigned(summary.todayPnl) : '—'}</span>
                    </div>
                    <div className="dd-row" style={{ padding: '4px 0' }}>
                      <span className="dd-row-label">总盈亏</span>
                      <span className={`dd-row-value ${pnlClass(summary?.totalPnl)}`}>{summary ? fmtSigned(summary.totalPnl) : '—'}</span>
                    </div>
                  </div>
                  <div style={{ marginTop: 10 }}>
                    <div className="dd-row" style={{ marginBottom: 2 }}>
                      <span className="dd-row-label">仓位占比</span>
                      <span className="dd-row-value">{summary ? `${summary.positionPct.toFixed(1)}%` : '—'}</span>
                    </div>
                    <Progress percent={Math.min(100, summary?.positionPct ?? 0)} showInfo={false} size="small" />
                  </div>
                  <div className="dd-form-hint" style={{ marginTop: 10 }}>
                    总资产 = 可用资金 + 持仓市值（现价）。买入/卖出在「下单」中录入，系统自动联动资金与持仓。
                  </div>
                </Panel>
              </div>
            )
          },
          {
            key: 'order',
            label: '下单',
            children: (
              <div className="dd-grid-form-side">
                <Panel title="买入 / 卖出录入" subtitle="费用按默认费率估算">
                  <Form layout="vertical" size="middle">
                    <Form.Item label="方向">
                      <Segmented
                        block
                        value={orderSide}
                        onChange={(v) => setOrderSide(v as 'buy' | 'sell')}
                        options={[
                          { value: 'buy', label: '买入', icon: <ArrowUpOutlined /> },
                          { value: 'sell', label: '卖出', icon: <ArrowDownOutlined /> }
                        ]}
                      />
                    </Form.Item>
                    <Form.Item label="标的">
                      <Select
                        showSearch
                        filterOption={(input, option) => String(option?.label ?? '').toLowerCase().includes(input.toLowerCase())}
                        options={stockOptions}
                        value={orderCode || undefined}
                        onChange={(v) => void selectCode(v)}
                        placeholder="搜索代码或名称"
                      />
                    </Form.Item>
                    <div className="dd-form-grid">
                      <Form.Item label={`价格（${orderSide === 'buy' ? '买入' : '卖出'}价）`}>
                        <InputNumber
                          style={{ width: '100%' }}
                          min={0.01}
                          step={0.01}
                          precision={2}
                          value={orderPrice}
                          onChange={setOrderPrice}
                          placeholder="成交价格"
                        />
                      </Form.Item>
                      <Form.Item label={`数量（手，1 手 = ${LOT_SIZE} 股）`}>
                        <InputNumber style={{ width: '100%' }} min={1} precision={0} value={orderQty} onChange={setOrderQty} placeholder="如 3" />
                      </Form.Item>
                    </div>
                    <div className="dd-chip-row" style={{ marginTop: -6, marginBottom: 12 }}>
                      {[1, 2, 5, 10].map((lots) => (
                        <button key={lots} className="dd-chip" onClick={() => setOrderQty(lots)}>
                          {lots} 手
                        </button>
                      ))}
                      {orderSide === 'sell' && heldQty > 0 ? (
                        <button className="dd-chip" onClick={() => setOrderQty(Math.floor(heldQty / LOT_SIZE))}>
                          全部（{Math.floor(heldQty / LOT_SIZE)} 手）
                        </button>
                      ) : null}
                    </div>
                    {overCash ? <Alert type="warning" showIcon message="可用资金不足" style={{ marginBottom: 12 }} /> : null}
                    {overHeld ? <Alert type="warning" showIcon message={`卖出数量超过持仓（可卖 ${heldQty} 股）`} style={{ marginBottom: 12 }} /> : null}
                    <Space>
                      <Button
                        type="primary"
                        danger={orderSide === 'buy'}
                        loading={submitting}
                        onClick={submitOrder}
                        disabled={overCash || overHeld}
                      >
                        确认{orderSide === 'buy' ? '买入' : '卖出'}
                      </Button>
                      <Button
                        onClick={() => {
                          setOrderCode('')
                          setOrderPrice(null)
                          setOrderQty(null)
                        }}
                      >
                        清空
                      </Button>
                    </Space>
                  </Form>
                </Panel>
                <Panel title="预估与额度">
                  <div className="dd-list">
                    <div className="dd-row" style={{ padding: '5px 0' }}>
                      <span className="dd-row-label">成交金额</span>
                      <span className="dd-row-value">{fmtMoney(orderAmount)}</span>
                    </div>
                    <div className="dd-row" style={{ padding: '5px 0' }}>
                      <span className="dd-row-label">预估费用（含印花税/过户费）</span>
                      <span className="dd-row-value">{fmtMoney(orderFee)}</span>
                    </div>
                    <div className="dd-row" style={{ padding: '5px 0' }}>
                      <span className="dd-row-label">{orderSide === 'buy' ? '需支出合计' : '预计回款'}</span>
                      <span className="dd-row-value" style={{ color: token.colorPrimary }}>
                        {fmtMoney(orderSide === 'buy' ? buyTotal : sellNet)}
                      </span>
                    </div>
                    <div className="dd-row" style={{ padding: '5px 0' }}>
                      <span className="dd-row-label">可用资金</span>
                      <span className="dd-row-value">{summary ? fmtMoney(summary.cash) : '—'}</span>
                    </div>
                    <div className="dd-row" style={{ padding: '5px 0' }}>
                      <span className="dd-row-label">{orderCode ? '当前持仓（股）' : '当前持仓'}</span>
                      <span className="dd-row-value">{orderCode ? fmtMoney(heldQty, 0) : '—'}</span>
                    </div>
                  </div>
                  <div className="dd-form-hint" style={{ marginTop: 12 }}>
                    <Tag>提示</Tag> 本应用不接入券商通道；此处录入您在券商侧的真实成交，用于资金与持仓统计。
                  </div>
                </Panel>
              </div>
            )
          },
          {
            key: 'positions',
            label: `持仓${positions.length > 0 ? ` · ${positions.length}` : ''}`,
            children: (
              <div className="dd-grid-main-side">
                <Panel
                  title="持仓明细"
                  subtitle={`市值合计 ${fmtMoney(posTotals.marketValue)} · 盈亏合计 ${fmtSigned(posTotals.pnl)}`}
                  flush
                  extra={
                    <Button
                      size="small"
                      type="primary"
                      icon={<PlusOutlined />}
                      onClick={() => {
                        setPosEdit({ code: '', qty: LOT_SIZE, costPrice: 0 })
                        setPosModal(true)
                      }}
                    >
                      新增持仓
                    </Button>
                  }
                >
                  <Table
                    rowKey="code"
                    size="small"
                    columns={positionColumns}
                    dataSource={positions}
                    pagination={false}
                    locale={{ emptyText: <div className="dd-empty">暂无持仓，可「新增持仓」或通过买入自动生成</div> }}
                  />
                </Panel>
                <Panel title="仓位分布" subtitle={summary ? `${summary.positionCount} 只` : undefined}>
                  {summary && summary.positions.length > 0 ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                      <div>
                        <div className="dd-row" style={{ marginBottom: 2 }}>
                          <span className="dd-row-label">总仓位</span>
                          <span className="dd-row-value">{summary.positionPct.toFixed(1)}%</span>
                        </div>
                        <Progress percent={Math.min(100, summary.positionPct)} showInfo={false} size="small" />
                      </div>
                      {summary.positions.map((d) => (
                        <div key={d.code}>
                          <div className="dd-row" style={{ marginBottom: 2 }}>
                            <span style={{ fontSize: 12, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {d.code} {d.name}{' '}
                              <span className="dd-muted" style={{ fontSize: 11 }}>
                                {d.qty} 股 × {d.price.toFixed(2)}
                              </span>
                            </span>
                            <span className="dd-row-value" style={{ fontSize: 12 }}>
                              {d.positionPct.toFixed(1)}%
                            </span>
                          </div>
                          <Progress
                            percent={Math.min(100, d.positionPct)}
                            showInfo={false}
                            size="small"
                            strokeColor={d.pnl >= 0 ? token.colorError : token.colorSuccess}
                          />
                        </div>
                      ))}
                      <div className="dd-form-hint">单票仓位过高时风险集中，建议结合策略偏好的单票上限控制。</div>
                    </div>
                  ) : (
                    <div className="dd-empty">暂无持仓</div>
                  )}
                </Panel>
              </div>
            )
          },
          {
            key: 'signals',
            label: (
              <span>
                交易建议
                {pendingSignals.length > 0 ? <Badge count={pendingSignals.length} size="small" style={{ marginLeft: 6 }} /> : null}
              </span>
            ),
            children: (
              <Panel
                title="交易建议（信号）"
                subtitle={`共 ${signals.length} 条 · ${pendingSignals.length} 条待处理`}
                flush
                extra={
                  <Segmented
                    size="small"
                    value={signalFilter}
                    onChange={(v) => setSignalFilter(v as 'all' | 'pending' | 'done')}
                    options={[
                      { value: 'all', label: '全部' },
                      { value: 'pending', label: '待处理' },
                      { value: 'done', label: '已处理' }
                    ]}
                  />
                }
              >
                <Table
                  rowKey="id"
                  size="small"
                  columns={signalColumns}
                  dataSource={filteredSignals}
                  pagination={{ pageSize: 20, showSizeChanger: false, hideOnSinglePage: true }}
                  locale={{ emptyText: <div className="dd-empty">暂无交易建议（由策略在收盘后运行产出）</div> }}
                />
              </Panel>
            )
          },
          {
            key: 'trades',
            label: `成交记录${trades.length > 0 ? ` · ${trades.length}` : ''}`,
            children: (
              <Panel
                title="成交记录"
                subtitle={`共 ${filteredTrades.length} 笔`}
                flush
                extra={
                  <Segmented
                    size="small"
                    value={tradeFilter}
                    onChange={(v) => setTradeFilter(v as 'all' | 'buy' | 'sell')}
                    options={[
                      { value: 'all', label: '全部' },
                      { value: 'buy', label: '买入' },
                      { value: 'sell', label: '卖出' }
                    ]}
                  />
                }
              >
                <Table
                  rowKey="id"
                  size="small"
                  columns={tradeColumns}
                  dataSource={filteredTrades}
                  pagination={{ pageSize: 20, showSizeChanger: false, hideOnSinglePage: true }}
                  locale={{ emptyText: <div className="dd-empty">暂无成交记录</div> }}
                />
              </Panel>
            )
          },
          {
            key: 'alerts',
            label: (
              <span>
                预警
                {openAlerts.length > 0 ? <Badge count={openAlerts.length} size="small" style={{ marginLeft: 6 }} /> : null}
              </span>
            ),
            children: (
              <Panel
                title="预警"
                subtitle={`${openAlerts.length} 条待确认`}
                flush
                extra={
                  <Space size={8}>
                    {openAlerts.length > 0 ? (
                      <Button size="small" icon={<CheckOutlined />} onClick={() => void acknowledgeAll()}>
                        全部确认
                      </Button>
                    ) : null}
                    <Segmented
                      size="small"
                      value={alertFilter}
                      onChange={(v) => setAlertFilter(v as 'open' | 'all')}
                      options={[
                        { value: 'open', label: '未处理' },
                        { value: 'all', label: '全部' }
                      ]}
                    />
                  </Space>
                }
              >
                <Table
                  rowKey="id"
                  size="small"
                  columns={alertColumns}
                  dataSource={filteredAlerts}
                  pagination={{ pageSize: 20, showSizeChanger: false, hideOnSinglePage: true }}
                  locale={{ emptyText: <div className="dd-empty">暂无预警</div> }}
                />
              </Panel>
            )
          }
        ]}
      />

      {/* 持仓维护弹窗 */}
      <Modal title="持仓维护" open={posModal} onOk={savePosition} onCancel={() => setPosModal(false)} okText="保存" width={380}>
        <Form layout="vertical">
          <Form.Item label="标的">
            <Select
              showSearch
              filterOption={(input, option) => String(option?.label ?? '').toLowerCase().includes(input.toLowerCase())}
              options={stockOptions}
              value={posEdit.code || undefined}
              onChange={(v) => setPosEdit({ ...posEdit, code: v })}
              placeholder="搜索代码或名称"
            />
          </Form.Item>
          <div className="dd-form-grid">
            <Form.Item label="数量（股）">
              <InputNumber style={{ width: '100%' }} min={1} precision={0} value={posEdit.qty} onChange={(v) => setPosEdit({ ...posEdit, qty: v ?? 0 })} />
            </Form.Item>
            <Form.Item label="成本价">
              <InputNumber style={{ width: '100%' }} min={0} precision={3} value={posEdit.costPrice} onChange={(v) => setPosEdit({ ...posEdit, costPrice: v ?? 0 })} />
            </Form.Item>
          </div>
          <div className="dd-form-hint">手动维护真实持仓，或由买入/卖出录入自动联动。数量置 0 视为清仓。</div>
        </Form>
      </Modal>

      {/* 信号执行反馈弹窗 */}
      <Modal
        title={sigModal ? `执行反馈：${sigModal.code} ${stockNames[sigModal.code] ?? ''} · ${sigModal.side === 'buy' ? '买入' : '卖出'}` : '执行反馈'}
        open={!!sigModal}
        onCancel={() => setSigModal(null)}
        width={420}
        footer={[
          <Button key="ignore" icon={<StopOutlined />} onClick={() => void feedback('ignored')}>
            忽略信号
          </Button>,
          <Button key="ok" type="primary" icon={<ThunderboltOutlined />} onClick={() => void feedback('executed')}>
            已执行（联动资金持仓）
          </Button>
        ]}
      >
        <Form layout="vertical">
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item label="实际成交价" style={{ flex: 1 }}>
              <InputNumber style={{ width: 150 }} min={0.01} step={0.01} precision={2} value={sigPrice} onChange={setSigPrice} />
            </Form.Item>
            <Form.Item label="实际成交数量（股）" style={{ flex: 1 }}>
              <InputNumber style={{ width: 150 }} min={1} precision={0} value={sigQty} onChange={setSigQty} />
            </Form.Item>
          </Space>
          <div className="dd-form-hint">按「已执行」后自动生成成交记录并联动资金与持仓；如未执行请点「忽略信号」。</div>
        </Form>
      </Modal>
    </div>
  )
}
