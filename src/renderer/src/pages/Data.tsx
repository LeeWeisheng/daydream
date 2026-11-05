/**
 * 数据页：行情数据总览 + 股票列表 / K 线数据（查询、图表、增删改）。
 * 布局：统计指标条 + 同步进度 + Tabs（股票列表 / K 线数据）；
 * 股票详情（K 线预览与维护入口）放入右侧 Drawer，避免页面下方堆叠。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Button,
  Drawer,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Progress,
  Segmented,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Tooltip,
  message
} from 'antd'
import {
  CloudDownloadOutlined,
  DeleteOutlined,
  EditOutlined,
  PlusOutlined,
  ReloadOutlined,
  SyncOutlined,
  DatabaseOutlined
} from '@ant-design/icons'
import type { Bar, StockBasic } from '@shared/types'
import KlineChart from '../components/KlineChart'
import PageHeader from '../components/PageHeader'
import Panel from '../components/Panel'
import StatCard from '../components/StatCard'
import { useAppStore } from '../stores'
import { fmtMoney, pnlClass } from '../lib/format'

const EXCHANGE_LABEL: Record<string, string> = { SH: '沪', SZ: '深', BJ: '北' }

interface StockForm {
  code: string
  name: string
  exchange: 'SH' | 'SZ' | 'BJ'
  industry?: string
}

interface KlineForm {
  code: string
  date: string
  open: number
  high: number
  low: number
  close: number
  volume: number
  amount: number
}

/** 最新一根 K 线的涨跌（与前一交易日收盘比较） */
function lastBarChange(bars: Bar[]): { close: number; pct: number; date: string } | null {
  if (bars.length === 0) return null
  const last = bars[bars.length - 1]
  const prev = bars.length > 1 ? bars[bars.length - 2] : null
  const pct = prev && prev.close > 0 ? (last.close - prev.close) / prev.close : 0
  return { close: last.close, pct, date: last.date }
}

export default function Data(): React.ReactNode {
  const { eventSeq } = useAppStore()
  const [stocks, setStocks] = useState<StockBasic[]>([])
  const [keyword, setKeyword] = useState('')
  const [exchange, setExchange] = useState<'all' | 'SH' | 'SZ' | 'BJ'>('all')
  const [selected, setSelected] = useState<StockBasic | null>(null)
  const [bars, setBars] = useState<Bar[]>([])
  const [barsLoading, setBarsLoading] = useState(false)
  const [stats, setStats] = useState<Record<string, unknown> | null>(null)
  const [progress, setProgress] = useState<{ done: number; total: number; message: string } | null>(null)
  const [tab, setTab] = useState('stocks')
  const [klineCode, setKlineCode] = useState<string>()
  const [klineList, setKlineList] = useState<Bar[]>([])
  const [loading, setLoading] = useState(true)
  const clearTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 股票 CRUD 弹窗
  const [stockModal, setStockModal] = useState(false)
  const [stockForm, setStockForm] = useState<StockForm>({ code: '', name: '', exchange: 'SH' })

  // K 线 CRUD 弹窗
  const [klineModal, setKlineModal] = useState(false)
  const [klineForm, setKlineForm] = useState<KlineForm>({
    code: '',
    date: '',
    open: 0,
    high: 0,
    low: 0,
    close: 0,
    volume: 0,
    amount: 0
  })

  const refreshStocks = useCallback(async () => {
    const [list, st] = await Promise.allSettled([window.daydream.data.getStockList(), window.daydream.data.getDataStats()])
    if (list.status === 'fulfilled') setStocks(list.value)
    if (st.status === 'fulfilled') setStats(st.value)
    setLoading(false)
  }, [])

  useEffect(() => {
    void refreshStocks()
  }, [refreshStocks, eventSeq])

  useEffect(() => {
    const off = window.daydream.onEvent((ev) => {
      if (ev.type === 'data.progress') {
        const p = ev.payload as { done: number; total: number; message: string }
        if (p.done >= p.total) {
          setProgress({ ...p, message: p.message || '同步完成' })
          if (clearTimer.current) clearTimeout(clearTimer.current)
          clearTimer.current = setTimeout(() => setProgress(null), 1800)
          void refreshStocks()
        } else {
          setProgress(p)
        }
      }
    })
    return () => {
      off()
      if (clearTimer.current) clearTimeout(clearTimer.current)
    }
  }, [refreshStocks])

  const stockOptions = useMemo(() => stocks.map((s) => ({ value: s.code, label: `${s.code} ${s.name}` })), [stocks])

  const filtered = useMemo(
    () => stocks.filter((s) => (!keyword || s.code.includes(keyword) || s.name.includes(keyword)) && (exchange === 'all' || s.exchange === exchange)),
    [stocks, keyword, exchange]
  )

  const openStock = async (s: StockBasic): Promise<void> => {
    setSelected(s)
    setBars([])
    setBarsLoading(true)
    try {
      const list = await window.daydream.data.getKline(s.code, '', '').catch(() => [] as Bar[])
      setBars(list)
    } finally {
      setBarsLoading(false)
    }
  }

  const loadKlineList = async (code?: string): Promise<void> => {
    const c = code ?? klineCode
    if (!c) return
    const list = await window.daydream.data.getKline(c, '', '').catch(() => [] as Bar[])
    setKlineList(list)
  }

  // 切换 K 线标的时自动查询
  useEffect(() => {
    if (tab === 'kline' && klineCode) void loadKlineList(klineCode)
  }, [tab, klineCode])

  const sync = async (kind: 'initial' | 'daily'): Promise<void> => {
    try {
      await (kind === 'initial' ? window.daydream.data.initialSync() : window.daydream.data.dailyUpdate())
      message.info(kind === 'initial' ? '已开始全量同步（后台渐进下载）' : '已开始增量更新')
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  const saveStock = async (): Promise<void> => {
    if (!stockForm.code || !stockForm.name) {
      message.warning('请填写代码与名称')
      return
    }
    try {
      await window.daydream.data.upsertStock(stockForm)
      message.success('股票已保存')
      setStockModal(false)
      void refreshStocks()
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  const removeStock = async (code: string): Promise<void> => {
    Modal.confirm({
      title: '删除股票',
      content: `将级联删除 ${code} 的 K 线与数据状态，确认删除？`,
      okButtonProps: { danger: true },
      onOk: async () => {
        await window.daydream.data.deleteStock(code)
        message.success('已删除')
        if (selected?.code === code) setSelected(null)
        if (klineCode === code) {
          setKlineCode(undefined)
          setKlineList([])
        }
        void refreshStocks()
      }
    })
  }

  const saveKline = async (): Promise<void> => {
    if (!klineForm.code || !klineForm.date) {
      message.warning('请填写代码与日期')
      return
    }
    try {
      await window.daydream.data.upsertKline({ ...klineForm, adjFactor: 1 })
      message.success('K 线已保存')
      setKlineModal(false)
      // 保存的标的可能是弹窗内新选的，切到该标的并刷新明细
      setKlineCode(klineForm.code)
      void loadKlineList(klineForm.code)
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  const removeKline = (b: Bar): void => {
    Modal.confirm({
      title: '删除 K 线',
      content: `确认删除 ${b.code} ${b.date} 的 K 线？`,
      okButtonProps: { danger: true },
      onOk: async () => {
        await window.daydream.data.deleteKline(b.code, b.date)
        message.success('已删除')
        void loadKlineList()
        if (selected?.code === b.code) void openStock(selected)
      }
    })
  }

  /** K 线表格数据：倒序（最新在上）+ 涨跌幅 */
  const klineRows = useMemo(() => {
    const asc = klineList.slice()
    return asc
      .map((b, i) => {
        const prev = i > 0 ? asc[i - 1] : null
        const pct = prev && prev.close > 0 ? (b.close - prev.close) / prev.close : null
        return { ...b, pct }
      })
      .reverse()
  }, [klineList])

  const lastChange = useMemo(() => lastBarChange(bars), [bars])

  return (
    <div className="dd-page">
      <PageHeader
        title="数据"
        description="行情数据全局共享（不随账户隔离）；列表、K 线与增删改对 Agent 同样可用。"
        extra={
          <Space size={8}>
            <Button size="small" icon={<SyncOutlined />} onClick={() => sync('daily')}>
              每日增量更新
            </Button>
            <Button size="small" type="primary" icon={<CloudDownloadOutlined />} onClick={() => sync('initial')}>
              一键全量同步
            </Button>
            <Button size="small" icon={<ReloadOutlined />} onClick={() => void refreshStocks()}>
              刷新
            </Button>
          </Space>
        }
      />

      <div className="dd-kpi-grid">
        <StatCard
          label="股票数"
          value={stats ? String(stats.stocks ?? '—') : '—'}
          sub="stock_basic"
          icon={<DatabaseOutlined />}
          tone="primary"
        />
        <StatCard label="K 线行数" value={stats ? fmtMoney(Number(stats.bars ?? 0), 0) : '—'} sub="日线复权数据" />
        <StatCard label="最早交易日" value={stats ? String(stats.minDate ?? '—') : '—'} />
        <StatCard label="最新交易日" value={stats ? String(stats.maxDate ?? '—') : '—'} />
      </div>

      {progress ? (
        <Panel bodyClassName="dd-card-body-tight">
          <div className="dd-row" style={{ marginBottom: 4 }}>
            <span className="dd-card-sub">
              同步中 · {progress.message || '处理进度'}
            </span>
            <span className="dd-field-value">
              {progress.done} / {progress.total}
            </span>
          </div>
          <Progress
            percent={Math.round((progress.done / Math.max(progress.total, 1)) * 100)}
            status={progress.done >= progress.total ? 'success' : 'active'}
            size="small"
            showInfo={false}
          />
        </Panel>
      ) : null}

      <Tabs
        activeKey={tab}
        onChange={setTab}
        items={[
          {
            key: 'stocks',
            label: `股票列表${stocks.length > 0 ? ` · ${stocks.length}` : ''}`,
            children: (
              <Panel
                title="股票列表"
                subtitle={`筛选结果 ${filtered.length} 条 · 点击行查看 K 线`}
                flush
                extra={
                  <Space size={8} wrap>
                    <Segmented
                      size="small"
                      value={exchange}
                      onChange={(v) => setExchange(v as 'all' | 'SH' | 'SZ' | 'BJ')}
                      options={[
                        { value: 'all', label: '全部' },
                        { value: 'SH', label: '沪' },
                        { value: 'SZ', label: '深' },
                        { value: 'BJ', label: '北' }
                      ]}
                    />
                    <Input.Search
                      size="small"
                      allowClear
                      placeholder="搜索代码 / 名称"
                      style={{ width: 200 }}
                      value={keyword}
                      onChange={(e) => setKeyword(e.target.value)}
                    />
                    <Button
                      size="small"
                      type="primary"
                      icon={<PlusOutlined />}
                      onClick={() => {
                        setStockForm({ code: '', name: '', exchange: 'SH' })
                        setStockModal(true)
                      }}
                    >
                      新增股票
                    </Button>
                  </Space>
                }
              >
                <Table
                  rowKey="code"
                  size="small"
                  loading={loading}
                  dataSource={filtered}
                  pagination={{ pageSize: 20, showSizeChanger: false, hideOnSinglePage: true }}
                  onRow={(s) => ({ onClick: () => void openStock(s), style: { cursor: 'pointer' } })}
                  locale={{ emptyText: <div className="dd-empty">没有匹配的股票，可调整筛选或「一键全量同步」</div> }}
                  columns={[
                    { title: '代码', dataIndex: 'code', key: 'code', width: 100 },
                    { title: '名称', dataIndex: 'name', key: 'name', width: 150 },
                    {
                      title: '板块',
                      dataIndex: 'exchange',
                      key: 'exchange',
                      width: 76,
                      render: (v: string) => (
                        <Tag style={{ marginInlineEnd: 0 }}>{EXCHANGE_LABEL[v] ?? v}</Tag>
                      )
                    },
                    { title: '行业', dataIndex: 'industry', key: 'industry', ellipsis: true, render: (v?: string) => v ?? <span className="dd-muted">—</span> },
                    {
                      title: '状态',
                      dataIndex: 'status',
                      key: 'status',
                      width: 84,
                      render: (v: string) => <span className={v === 'listed' ? undefined : 'dd-muted'}>{v === 'listed' ? '上市' : v}</span>
                    },
                    {
                      title: '操作',
                      key: 'op',
                      width: 132,
                      render: (_: unknown, s: StockBasic) => (
                        <Space size={4} onClick={(e) => e.stopPropagation()}>
                          <Button size="small" onClick={() => void openStock(s)}>
                            K 线
                          </Button>
                          <Tooltip title="编辑">
                            <Button
                              size="small"
                              icon={<EditOutlined />}
                              onClick={() => {
                                setStockForm({ code: s.code, name: s.name, exchange: s.exchange, industry: s.industry })
                                setStockModal(true)
                              }}
                            />
                          </Tooltip>
                          <Tooltip title="删除">
                            <Button size="small" danger icon={<DeleteOutlined />} onClick={() => void removeStock(s.code)} />
                          </Tooltip>
                        </Space>
                      )
                    }
                  ]}
                />
              </Panel>
            )
          },
          {
            key: 'kline',
            label: 'K 线数据',
            children: (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <Panel
                  title="K 线查询"
                  subtitle={klineList.length > 0 ? `${klineList.length} 根日线` : '选择标的后自动加载'}
                  extra={
                    <Space size={8} wrap>
                      <Select
                        showSearch
                        allowClear
                        size="small"
                        style={{ width: 220 }}
                        placeholder="搜索代码或名称"
                        options={stockOptions}
                        value={klineCode}
                        onChange={(v) => {
                          setKlineCode(v)
                          if (!v) setKlineList([])
                        }}
                      />
                      <Button
                        size="small"
                        icon={<PlusOutlined />}
                        disabled={!klineCode}
                        onClick={() => {
                          setKlineForm({
                            code: klineCode ?? '',
                            date: new Date().toISOString().slice(0, 10),
                            open: 0,
                            high: 0,
                            low: 0,
                            close: 0,
                            volume: 0,
                            amount: 0
                          })
                          setKlineModal(true)
                        }}
                      >
                        新增 K 线
                      </Button>
                    </Space>
                  }
                >
                  {klineList.length > 0 ? (
                    <KlineChart bars={klineList} height={320} />
                  ) : (
                    <div className="dd-empty">
                      <Empty description={false} image={Empty.PRESENTED_IMAGE_SIMPLE} />
                      {klineCode ? '该标的暂无 K 线数据（可点击「一键全量同步」拉取）' : '选择上方的标的以加载 K 线'}
                    </div>
                  )}
                </Panel>

                <Panel title="K 线明细" subtitle={`${klineRows.length} 条（最新在上）`} flush>
                  <Table
                    rowKey={(r) => `${r.code}-${r.date}`}
                    size="small"
                    dataSource={klineRows}
                    pagination={{ pageSize: 15, showSizeChanger: false, hideOnSinglePage: true }}
                    locale={{ emptyText: <div className="dd-empty">暂无 K 线数据</div> }}
                    columns={[
                      { title: '日期', dataIndex: 'date', key: 'date', width: 108 },
                      { title: '开盘', dataIndex: 'open', key: 'open', width: 88, align: 'right' as const, render: (v: number) => v.toFixed(2) },
                      { title: '最高', dataIndex: 'high', key: 'high', width: 88, align: 'right' as const, render: (v: number) => v.toFixed(2) },
                      { title: '最低', dataIndex: 'low', key: 'low', width: 88, align: 'right' as const, render: (v: number) => v.toFixed(2) },
                      { title: '收盘', dataIndex: 'close', key: 'close', width: 88, align: 'right' as const, render: (v: number) => v.toFixed(2) },
                      {
                        title: '涨跌幅',
                        dataIndex: 'pct',
                        key: 'pct',
                        width: 88,
                        align: 'right' as const,
                        render: (v: number | null) =>
                          v == null ? (
                            <span className="dd-muted">—</span>
                          ) : (
                            <span className={pnlClass(v)}>{`${v >= 0 ? '+' : ''}${(v * 100).toFixed(2)}%`}</span>
                          )
                      },
                      { title: '成交量', dataIndex: 'volume', key: 'volume', width: 108, align: 'right' as const, render: (v: number) => fmtMoney(v, 0) },
                      { title: '成交额', dataIndex: 'amount', key: 'amount', width: 118, align: 'right' as const, render: (v: number) => fmtMoney(v, 0) },
                      { title: '复权因子', dataIndex: 'adjFactor', key: 'adjFactor', width: 86, align: 'right' as const },
                      {
                        title: '操作',
                        key: 'op',
                        width: 118,
                        render: (_: unknown, b: Bar) => (
                          <Space size={4}>
                            <Button
                              size="small"
                              onClick={() => {
                                setKlineForm({ code: b.code, date: b.date, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume, amount: b.amount })
                                setKlineModal(true)
                              }}
                            >
                              编辑
                            </Button>
                            <Button size="small" danger onClick={() => removeKline(b)}>
                              删除
                            </Button>
                          </Space>
                        )
                      }
                    ]}
                  />
                </Panel>
              </div>
            )
          }
        ]}
      />

      {/* 股票详情抽屉：K 线 + 维护入口 */}
      <Drawer
        title={
          selected ? (
            <Space size={8} wrap>
              <span>
                {selected.code} {selected.name}
              </span>
              <Tag style={{ marginInlineEnd: 0 }}>{EXCHANGE_LABEL[selected.exchange] ?? selected.exchange}市</Tag>
              {selected.industry ? <Tag style={{ marginInlineEnd: 0 }}>{selected.industry}</Tag> : null}
            </Space>
          ) : (
            '股票详情'
          )
        }
        width={760}
        open={!!selected}
        onClose={() => setSelected(null)}
        extra={
          selected ? (
            <Space size={8}>
              <Button
                size="small"
                icon={<EditOutlined />}
                onClick={() => {
                  setStockForm({ code: selected.code, name: selected.name, exchange: selected.exchange, industry: selected.industry })
                  setStockModal(true)
                }}
              >
                编辑
              </Button>
              <Button size="small" danger icon={<DeleteOutlined />} onClick={() => void removeStock(selected.code)}>
                删除
              </Button>
            </Space>
          ) : null
        }
      >
        {selected ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div className="dd-kpi-grid">
              <StatCard label="最新收盘" value={lastChange ? lastChange.close.toFixed(2) : '—'} sub={lastChange?.date ?? '无数据'} />
              <StatCard
                label="日涨跌"
                value={lastChange ? `${lastChange.pct >= 0 ? '+' : ''}${(lastChange.pct * 100).toFixed(2)}%` : '—'}
                tone={lastChange && lastChange.pct < 0 ? 'down' : 'up'}
                sub="对前一交易日收盘"
              />
              <StatCard label="K 线根数" value={bars.length} sub={bars.length > 0 ? `${bars[0].date} ~ ${bars[bars.length - 1].date}` : '—'} />
            </div>
            <Panel title="日线走势" subtitle="MA5 / MA20" flush>
              <div style={{ padding: 12 }}>
                {barsLoading ? (
                  <div className="dd-empty" style={{ height: 320 }}>
                    加载中…
                  </div>
                ) : bars.length > 0 ? (
                  <KlineChart bars={bars} height={340} />
                ) : (
                  <div className="dd-empty" style={{ height: 300 }}>
                    <Empty description={false} image={Empty.PRESENTED_IMAGE_SIMPLE} />
                    该标的暂无 K 线数据（可点击「一键全量同步」拉取）
                  </div>
                )}
              </div>
            </Panel>
          </div>
        ) : null}
      </Drawer>

      {/* 股票 CRUD 弹窗 */}
      <Modal
        title={stockForm.code && stocks.some((s) => s.code === stockForm.code) ? '编辑股票' : '新增股票'}
        open={stockModal}
        onOk={saveStock}
        onCancel={() => setStockModal(false)}
        okText="保存"
        width={400}
      >
        <Form layout="vertical">
          <div className="dd-form-grid">
            <Form.Item label="股票代码" required>
              <Input value={stockForm.code} onChange={(e) => setStockForm({ ...stockForm, code: e.target.value })} placeholder="如 600519" />
            </Form.Item>
            <Form.Item label="名称" required>
              <Input value={stockForm.name} onChange={(e) => setStockForm({ ...stockForm, name: e.target.value })} placeholder="如 贵州茅台" />
            </Form.Item>
          </div>
          <div className="dd-form-grid">
            <Form.Item label="板块">
              <Select
                value={stockForm.exchange}
                onChange={(v) => setStockForm({ ...stockForm, exchange: v })}
                options={[
                  { value: 'SH', label: '沪市' },
                  { value: 'SZ', label: '深市' },
                  { value: 'BJ', label: '北交所' }
                ]}
              />
            </Form.Item>
            <Form.Item label="行业">
              <Input value={stockForm.industry} onChange={(e) => setStockForm({ ...stockForm, industry: e.target.value })} placeholder="可选" />
            </Form.Item>
          </div>
        </Form>
      </Modal>

      {/* K 线 CRUD 弹窗 */}
      <Modal title="K 线维护（补录 / 纠错）" open={klineModal} onOk={saveKline} onCancel={() => setKlineModal(false)} okText="保存" width={460}>
        <Form layout="vertical">
          <div className="dd-form-grid">
            <Form.Item label="代码" required>
              <Select
                showSearch
                options={stockOptions}
                value={klineForm.code || undefined}
                onChange={(v) => setKlineForm({ ...klineForm, code: v })}
                placeholder="搜索代码"
              />
            </Form.Item>
            <Form.Item label="日期" required>
              <Input value={klineForm.date} onChange={(e) => setKlineForm({ ...klineForm, date: e.target.value })} placeholder="YYYY-MM-DD" />
            </Form.Item>
          </div>
          <div className="dd-form-grid">
            {(
              [
                ['open', '开盘'],
                ['high', '最高'],
                ['low', '最低'],
                ['close', '收盘']
              ] as const
            ).map(([key, label]) => (
              <Form.Item key={key} label={label}>
                <InputNumber style={{ width: '100%' }} min={0} precision={3} value={klineForm[key]} onChange={(v) => setKlineForm({ ...klineForm, [key]: v ?? 0 })} />
              </Form.Item>
            ))}
          </div>
          <div className="dd-form-grid">
            <Form.Item label="成交量">
              <InputNumber style={{ width: '100%' }} min={0} precision={0} value={klineForm.volume} onChange={(v) => setKlineForm({ ...klineForm, volume: v ?? 0 })} />
            </Form.Item>
            <Form.Item label="成交额">
              <InputNumber style={{ width: '100%' }} min={0} precision={0} value={klineForm.amount} onChange={(v) => setKlineForm({ ...klineForm, amount: v ?? 0 })} />
            </Form.Item>
          </div>
          <div className="dd-form-hint">保存后立即生效；Agent 运行中同样可读写这批数据（复权因子默认 1）。</div>
        </Form>
      </Modal>
    </div>
  )
}
