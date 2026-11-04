/**
 * 交易页：资金统计（概览）/ 买入卖出 / 持仓管理 / 仓位管理 / 交易建议 / 成交记录 / 预警。
 * 交易由人工执行：买入/卖出在应用内录入，联动可用资金与持仓（主进程事务）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Tabs, Table, Form, InputNumber, Button, Radio, Select, Modal, Tag, message, Input, Space, Progress } from 'antd'
import { useAntdToken } from 'antd-style'
import * as echarts from 'echarts'
import type { AccountSummary, Alert, Position, Signal, TradeRecord } from '@shared/types'
import { useAppStore } from '../stores'

const SIGNAL_STATUS: Record<string, { color: string; label: string }> = {
  pending_confirmation: { color: 'orange', label: '待确认' },
  pending_execution: { color: 'blue', label: '待执行' },
  executed: { color: 'green', label: '已执行' },
  ignored: { color: 'default', label: '已忽略' },
  expired: { color: 'default', label: '已过期' }
}

function EquityCurve({ data }: { data: { date: string; totalAssets: number }[] }): React.ReactNode {
  const token = useAntdToken()
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!ref.current || data.length === 0) return
    const chart = echarts.init(ref.current, undefined, { renderer: 'svg' })
    chart.setOption({
      backgroundColor: 'transparent',
      tooltip: { trigger: 'axis' },
      grid: { left: 60, right: 16, top: 16, bottom: 28 },
      xAxis: { type: 'category', data: data.map((d) => d.date), axisLabel: { fontSize: 10 } },
      yAxis: { type: 'value', scale: true, axisLabel: { fontSize: 10 } },
      series: [
        {
          name: '总资产',
          type: 'line',
          data: data.map((d) => d.totalAssets),
          showSymbol: false,
          lineStyle: { color: token.colorPrimary, width: 1.5 },
          areaStyle: { color: 'rgba(22,119,255,0.08)' }
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
  return <div ref={ref} style={{ width: '100%', height: 220 }} />
}

export default function Trade(): React.ReactNode {
  const { currentAccount, eventSeq } = useAppStore()
  const token = useAntdToken()
  const accountId = currentAccount?.id ?? ''
  const [summary, setSummary] = useState<AccountSummary | null>(null)
  const [positions, setPositions] = useState<Position[]>([])
  const [signals, setSignals] = useState<Signal[]>([])
  const [trades, setTrades] = useState<TradeRecord[]>([])
  const [alerts, setAlerts] = useState<Alert[]>([])
  const [stockNames, setStockNames] = useState<Record<string, string>>({})
  const [tab, setTab] = useState('overview')

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

  const stockOptions = useMemo(() => Object.entries(stockNames).map(([code, name]) => ({ value: code, label: `${code} ${name}` })), [stockNames])

  const submitOrder = async (): Promise<void> => {
    if (!accountId || !orderCode || !orderPrice || !orderQty) {
      message.warning('请完整填写股票、价格与数量')
      return
    }
    setSubmitting(true)
    try {
      await window.daydream.trades.order({ accountId, code: orderCode, side: orderSide, price: orderPrice, qty: orderQty * 100 })
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

  const pnlColor = (v: number): string => (v >= 0 ? token.colorError : token.colorSuccess)

  const positionColumns = [
    { title: '代码', dataIndex: 'code', key: 'code', width: 90, render: (c: string) => `${c} ${stockNames[c] ?? ''}` },
    { title: '数量', dataIndex: 'qty', key: 'qty', width: 90, align: 'right' as const },
    { title: '成本价', dataIndex: 'costPrice', key: 'costPrice', width: 90, align: 'right' as const },
    { title: '市值', key: 'mv', width: 110, align: 'right' as const, render: (_: unknown, p: Position) => ((summary?.positions.find((d) => d.code === p.code)?.marketValue ?? 0) as number).toLocaleString() },
    { title: '盈亏', key: 'pnl', width: 110, align: 'right' as const, render: (_: unknown, p: Position) => {
      const d = summary?.positions.find((x) => x.code === p.code)
      return d ? <span style={{ color: pnlColor(d.pnl) }}>{d.pnl >= 0 ? '+' : ''}{d.pnl.toLocaleString()}</span> : '—'
    } },
    {
      title: '操作',
      key: 'op',
      width: 120,
      render: (_: unknown, p: Position) => (
        <Space>
          <Button size="small" onClick={() => { setPosEdit({ code: p.code, qty: p.qty, costPrice: p.costPrice }); setPosModal(true) }}>
            编辑
          </Button>
          <Button size="small" danger onClick={() => window.daydream.positions.upsert({ accountId, code: p.code, qty: 0, costPrice: p.costPrice }).then(() => refresh()).catch((e) => message.error((e as Error).message))}>
            删除
          </Button>
        </Space>
      )
    }
  ]

  const signalColumns = [
    { title: '时间', dataIndex: 'createdAt', key: 'createdAt', width: 160, render: (v: string) => new Date(v).toLocaleString('zh-CN', { hour12: false }) },
    { title: '代码', dataIndex: 'code', key: 'code', width: 100, render: (c: string) => `${c} ${stockNames[c] ?? ''}` },
    { title: '方向', dataIndex: 'side', key: 'side', width: 70, render: (s: string) => <Tag color={s === 'buy' ? 'red' : 'green'}>{s === 'buy' ? '买入' : '卖出'}</Tag> },
    { title: '数量', dataIndex: 'qty', key: 'qty', width: 80, align: 'right' as const },
    { title: '参考价', dataIndex: 'refPrice', key: 'refPrice', width: 90, align: 'right' as const },
    { title: '状态', dataIndex: 'status', key: 'status', width: 90, render: (s: string) => <Tag color={SIGNAL_STATUS[s]?.color ?? 'default'}>{SIGNAL_STATUS[s]?.label ?? s}</Tag> },
    {
      title: '操作',
      key: 'op',
      width: 170,
      render: (_: unknown, s: Signal) =>
        s.status === 'pending_execution' || s.status === 'pending_confirmation' ? (
          <Space>
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
            <Button size="small" onClick={() => feedbackFromRow(s, 'ignored')}>
              忽略
            </Button>
          </Space>
        ) : (
          <span className="dd-muted">—</span>
        )
    }
  ]

  const feedbackFromRow = (s: Signal, f: 'ignored'): void => {
    window.daydream.signals.feedback({ signalId: s.id, feedback: f }).then(() => refresh()).catch((e) => message.error((e as Error).message))
  }

  const tradeColumns = [
    { title: '时间', dataIndex: 'tradedAt', key: 'tradedAt', width: 160, render: (v: string) => new Date(v).toLocaleString('zh-CN', { hour12: false }) },
    { title: '代码', dataIndex: 'code', key: 'code', width: 100, render: (c: string) => `${c} ${stockNames[c] ?? ''}` },
    { title: '方向', dataIndex: 'side', key: 'side', width: 70, render: (s: string) => <Tag color={s === 'buy' ? 'red' : 'green'}>{s === 'buy' ? '买入' : '卖出'}</Tag> },
    { title: '价格', dataIndex: 'price', key: 'price', width: 90, align: 'right' as const },
    { title: '数量', dataIndex: 'qty', key: 'qty', width: 80, align: 'right' as const },
    { title: '费用', dataIndex: 'fee', key: 'fee', width: 90, align: 'right' as const },
    { title: '备注', dataIndex: 'note', key: 'note', ellipsis: true }
  ]

  const stat = (label: string, value: React.ReactNode): React.ReactNode => (
    <div className="dd-section" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
      <span className="dd-stat-label">{label}</span>
      <span className="dd-stat-value" style={{ fontSize: 16 }}>
        {value}
      </span>
    </div>
  )

  return (
    <div className="dd-page">
      <Tabs
        activeKey={tab}
        onChange={setTab}
        items={[
          {
            key: 'overview',
            label: '资金统计',
            children: (
              <div style={{ display: 'flex', gap: 24 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 0 }}>
                    {stat('总资产', summary ? summary.totalAssets.toLocaleString() : '—')}
                    {stat('可用资金', summary ? summary.cash.toLocaleString() : '—')}
                    {stat('持仓市值', summary ? summary.marketValue.toLocaleString() : '—')}
                    {stat(
                      '持仓盈亏',
                      summary ? (
                        <span style={{ color: pnlColor(summary.positionPnl) }}>
                          {summary.positionPnl >= 0 ? '+' : ''}
                          {summary.positionPnl.toLocaleString()}
                        </span>
                      ) : (
                        '—'
                      )
                    )}
                    {stat(
                      '总盈亏',
                      summary ? (
                        <span style={{ color: pnlColor(summary.totalPnl) }}>
                          {summary.totalPnl >= 0 ? '+' : ''}
                          {summary.totalPnl.toLocaleString()}
                        </span>
                      ) : (
                        '—'
                      )
                    )}
                    {stat('仓位占比', summary ? `${summary.positionPct}%` : '—')}
                  </div>
                  <div className="dd-section-title" style={{ marginTop: 12 }}>
                    资金曲线
                  </div>
                  <EquityCurve data={summary?.equityCurve ?? []} />
                </div>
                <div className="dd-split-left" style={{ width: 260, paddingLeft: 16 }}>
                  <div className="dd-section-title">说明</div>
                  <div className="dd-muted" style={{ lineHeight: 1.8 }}>
                    总资产 = 可用资金 + 持仓市值（现价）。买入/卖出在「买入卖出」页录入，系统自动联动资金与持仓；每日收盘后自动采集净值快照用于资金曲线。
                  </div>
                </div>
              </div>
            )
          },
          {
            key: 'order',
            label: '买入卖出',
            children: (
              <div style={{ maxWidth: 480 }}>
                <Form layout="vertical">
                  <Form.Item label="方向">
                    <Radio.Group value={orderSide} onChange={(e) => setOrderSide(e.target.value)}>
                      <Radio.Button value="buy">买入</Radio.Button>
                      <Radio.Button value="sell">卖出</Radio.Button>
                    </Radio.Group>
                  </Form.Item>
                  <Form.Item label="股票">
                    <Select
                      showSearch
                      filterOption={(input, option) => String(option?.label ?? '').toLowerCase().includes(input.toLowerCase())}
                      options={stockOptions}
                      value={orderCode || undefined}
                      onChange={setOrderCode}
                      placeholder="搜索代码或名称"
                    />
                  </Form.Item>
                  <Form.Item label={`价格（${orderSide === 'buy' ? '买入' : '卖出'}价）`}>
                    <InputNumber style={{ width: '100%' }} min={0.01} precision={2} value={orderPrice} onChange={setOrderPrice} placeholder="成交价格" />
                  </Form.Item>
                  <Form.Item label="数量（手，1 手 = 100 股）">
                    <InputNumber style={{ width: '100%' }} min={1} precision={0} value={orderQty} onChange={setOrderQty} placeholder="如：3 手" />
                  </Form.Item>
                  <Form.Item>
                    <Space>
                      <Button type="primary" danger={orderSide === 'buy'} loading={submitting} onClick={submitOrder}>
                        确认{orderSide === 'buy' ? '买入' : '卖出'}
                      </Button>
                      <span className="dd-muted">
                        金额约 {(orderPrice ?? 0) * (orderQty ?? 0) * 100} 元（费用自动按默认费率估算）
                      </span>
                    </Space>
                  </Form.Item>
                </Form>
                <div className="dd-muted" style={{ borderTop: '1px dashed', borderTopColor: token.colorBorderSecondary, paddingTop: 8 }}>
                  注意：本应用不接入券商通道；此处录入您在券商侧的真实成交，用于资金与持仓统计。
                </div>
              </div>
            )
          },
          {
            key: 'positions',
            label: '持仓管理',
            children: (
              <div>
                <div style={{ marginBottom: 8, display: 'flex', justifyContent: 'space-between' }}>
                  <span className="dd-muted">持仓数量：{positions.length}；手动维护真实持仓或由买入/卖出自动联动</span>
                  <Button size="small" type="primary" onClick={() => { setPosEdit({ code: '', qty: 100, costPrice: 0 }); setPosModal(true) }}>
                    新增持仓
                  </Button>
                </div>
                <Table rowKey="code" size="small" columns={positionColumns} dataSource={positions} pagination={false} />
              </div>
            )
          },
          {
            key: 'allocation',
            label: '仓位管理',
            children: (
              <div>
                <div className="dd-stat-row" style={{ marginBottom: 8 }}>
                  <span className="dd-stat-label">总仓位</span>
                  <span className="dd-stat-value">{summary ? `${summary.positionPct}%` : '—'}</span>
                </div>
                {summary?.positions.map((d) => (
                  <div key={d.code} style={{ marginBottom: 10 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                      <span>
                        {d.code} {d.name} <span className="dd-muted">（{d.qty} 股 × {d.price.toFixed(2)}）</span>
                      </span>
                      <span>
                        {d.marketValue.toLocaleString()} 元 · {d.positionPct}%
                      </span>
                    </div>
                    <Progress percent={Math.min(100, Math.round(d.positionPct * 4))} size="small" showInfo={false} strokeColor="#1677ff" />
                  </div>
                ))}
                {(!summary || summary.positions.length === 0) && <div className="dd-muted">暂无持仓</div>}
              </div>
            )
          },
          {
            key: 'signals',
            label: '交易建议',
            children: <Table rowKey="id" size="small" columns={signalColumns} dataSource={signals} pagination={{ pageSize: 20 }} />
          },
          {
            key: 'trades',
            label: '成交记录',
            children: <Table rowKey="id" size="small" columns={tradeColumns} dataSource={trades} pagination={{ pageSize: 20 }} />
          },
          {
            key: 'alerts',
            label: '预警',
            children: (
              <Table
                rowKey="id"
                size="small"
                dataSource={alerts}
                pagination={false}
                columns={[
                  { title: '时间', dataIndex: 'createdAt', key: 'createdAt', width: 160, render: (v: string) => new Date(v).toLocaleString('zh-CN', { hour12: false }) },
                  { title: '级别', dataIndex: 'level', key: 'level', width: 90, render: (l: string) => <Tag color={l === 'critical' ? 'red' : l === 'warn' ? 'orange' : 'default'}>{l}</Tag> },
                  { title: '类型', dataIndex: 'type', key: 'type', width: 140 },
                  { title: '内容', dataIndex: 'contentJson', key: 'contentJson', render: (v: string) => { try { return String((JSON.parse(v) as { content?: string }).content ?? '') } catch { return v } } },
                  {
                    title: '操作',
                    key: 'op',
                    width: 100,
                    render: (_: unknown, a: Alert) =>
                      a.status === 'open' ? (
                        <Button size="small" onClick={() => window.daydream.alerts.acknowledge(a.id).then(() => refresh()).catch((e) => message.error((e as Error).message))}>
                          确认
                        </Button>
                      ) : (
                        <span className="dd-muted">已确认</span>
                      )
                  }
                ]}
              />
            )
          }
        ]}
      />

      {/* 持仓维护弹窗 */}
      <Modal title="持仓维护" open={posModal} onOk={savePosition} onCancel={() => setPosModal(false)} okText="保存" width={360}>
        <Form layout="vertical">
          <Form.Item label="股票代码">
            <Select
              showSearch
              filterOption={(input, option) => String(option?.label ?? '').toLowerCase().includes(input.toLowerCase())}
              options={stockOptions}
              value={posEdit.code || undefined}
              onChange={(v) => setPosEdit({ ...posEdit, code: v })}
              placeholder="搜索代码或名称"
            />
          </Form.Item>
          <Form.Item label="数量（股）">
            <InputNumber style={{ width: '100%' }} min={1} precision={0} value={posEdit.qty} onChange={(v) => setPosEdit({ ...posEdit, qty: v ?? 0 })} />
          </Form.Item>
          <Form.Item label="成本价">
            <InputNumber style={{ width: '100%' }} min={0} precision={3} value={posEdit.costPrice} onChange={(v) => setPosEdit({ ...posEdit, costPrice: v ?? 0 })} />
          </Form.Item>
        </Form>
      </Modal>

      {/* 信号执行反馈弹窗 */}
      <Modal
        title={`信号执行反馈：${sigModal?.code ?? ''} ${sigModal?.side === 'buy' ? '买入' : '卖出'}`}
        open={!!sigModal}
        onOk={() => feedback('executed')}
        onCancel={() => setSigModal(null)}
        okText="已执行（联动资金持仓）"
        width={380}
      >
        <Form layout="vertical">
          <Form.Item label="实际成交价">
            <InputNumber style={{ width: '100%' }} min={0.01} precision={2} value={sigPrice} onChange={setSigPrice} />
          </Form.Item>
          <Form.Item label="实际成交数量（股）">
            <InputNumber style={{ width: '100%' }} min={1} precision={0} value={sigQty} onChange={setSigQty} />
          </Form.Item>
        </Form>
        <div className="dd-muted">按「已执行」后自动生成成交记录并联动资金与持仓；如未执行请关闭后点「忽略」。</div>
      </Modal>
    </div>
  )
}
