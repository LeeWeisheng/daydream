/**
 * 数据页：股票数据（列表 / K 线 / 指数）、一键同步（全量/增量，进度可见）、
 * 数据增删改查（Agent 运行时同样可用）。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Table, Input, Button, Select, Modal, Form, InputNumber, message, Space, Progress, Tag, Tabs } from 'antd'
import { SyncOutlined, PlusOutlined, DeleteOutlined, EditOutlined, CloudDownloadOutlined } from '@ant-design/icons'
import type { Bar, StockBasic } from '@shared/types'
import KlineChart from '../components/KlineChart'
import { useAppStore } from '../stores'

const EXCHANGE_LABEL: Record<string, string> = { SH: '沪', SZ: '深', BJ: '北' }

export default function Data(): React.ReactNode {
  const { eventSeq } = useAppStore()
  const [stocks, setStocks] = useState<StockBasic[]>([])
  const [keyword, setKeyword] = useState('')
  const [exchange, setExchange] = useState<string>()
  const [selected, setSelected] = useState<StockBasic | null>(null)
  const [bars, setBars] = useState<Bar[]>([])
  const [stats, setStats] = useState<Record<string, unknown> | null>(null)
  const [progress, setProgress] = useState<{ done: number; total: number; message: string } | null>(null)
  const [tab, setTab] = useState('stocks')
  const [klineCode, setKlineCode] = useState('')
  const [klineList, setKlineList] = useState<Bar[]>([])

  // 股票 CRUD 弹窗
  const [stockModal, setStockModal] = useState(false)
  const [stockForm, setStockForm] = useState<{ code: string; name: string; exchange: 'SH' | 'SZ' | 'BJ'; industry?: string }>({ code: '', name: '', exchange: 'SH' })

  // K 线 CRUD 弹窗
  const [klineModal, setKlineModal] = useState(false)
  const [klineForm, setKlineForm] = useState<{ code: string; date: string; open: number; high: number; low: number; close: number; volume: number; amount: number }>({
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
  }, [])

  useEffect(() => {
    void refreshStocks()
  }, [refreshStocks, eventSeq])

  useEffect(() => {
    const off = window.daydream.onEvent((ev) => {
      if (ev.type === 'data.progress') {
        const p = ev.payload as { done: number; total: number; message: string }
        setProgress(p)
        if (p.done >= p.total) {
          setProgress(null)
          void refreshStocks()
        }
      }
    })
    return off
  }, [refreshStocks])

  const filtered = useMemo(
    () =>
      stocks.filter(
        (s) =>
          (!keyword || s.code.includes(keyword) || s.name.includes(keyword)) && (!exchange || s.exchange === exchange)
      ),
    [stocks, keyword, exchange]
  )

  const openKline = async (s: StockBasic): Promise<void> => {
    setSelected(s)
    const bars = await window.daydream.data.getKline(s.code, '', '').catch(() => [] as Bar[])
    setBars(bars)
  }

  const loadKlineList = async (): Promise<void> => {
    if (!klineCode) return
    const bars = await window.daydream.data.getKline(klineCode, '', '').catch(() => [] as Bar[])
    setKlineList(bars)
  }

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
      void loadKlineList()
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  return (
    <div className="dd-page">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <div className="dd-page-title" style={{ marginBottom: 0 }}>
          数据
        </div>
        <Space>
          {stats && (
            <span className="dd-muted">
              股票 {String(stats.stocks ?? '—')} · K 线 {String(stats.bars ?? '—')} 行 · {String(stats.minDate ?? '—')} ~ {String(stats.maxDate ?? '—')}
            </span>
          )}
          <Button size="small" icon={<SyncOutlined />} onClick={() => sync('daily')}>
            每日增量更新
          </Button>
          <Button size="small" type="primary" icon={<CloudDownloadOutlined />} onClick={() => sync('initial')}>
            一键全量同步
          </Button>
        </Space>
      </div>
      {progress && <Progress percent={Math.round((progress.done / Math.max(progress.total, 1)) * 100)} size="small" format={() => `${progress.done}/${progress.total} ${progress.message}`} style={{ marginBottom: 8 }} />}

      <Tabs
        activeKey={tab}
        onChange={setTab}
        items={[
          {
            key: 'stocks',
            label: '股票列表',
            children: (
              <div>
                <Space style={{ marginBottom: 8 }}>
                  <Input.Search placeholder="搜索代码/名称" value={keyword} onChange={(e) => setKeyword(e.target.value)} style={{ width: 240 }} size="small" />
                  <Select placeholder="板块" allowClear size="small" style={{ width: 110 }} value={exchange} onChange={setExchange} options={Object.entries(EXCHANGE_LABEL).map(([v, l]) => ({ value: v, label: `${l}市` }))} />
                  <Button size="small" icon={<PlusOutlined />} onClick={() => { setStockForm({ code: '', name: '', exchange: 'SH' }); setStockModal(true) }}>
                    新增股票
                  </Button>
                </Space>
                <Table
                  rowKey="code"
                  size="small"
                  dataSource={filtered}
                  pagination={{ pageSize: 20, showSizeChanger: false }}
                  columns={[
                    { title: '代码', dataIndex: 'code', key: 'code', width: 100 },
                    { title: '名称', dataIndex: 'name', key: 'name', width: 140 },
                    { title: '板块', dataIndex: 'exchange', key: 'exchange', width: 70, render: (v: string) => <Tag>{EXCHANGE_LABEL[v] ?? v}</Tag> },
                    { title: '行业', dataIndex: 'industry', key: 'industry', ellipsis: true, render: (v?: string) => v ?? '—' },
                    { title: '状态', dataIndex: 'status', key: 'status', width: 90, render: (v: string) => (v === 'listed' ? '上市' : v) },
                    {
                      title: '操作',
                      key: 'op',
                      width: 200,
                      render: (_: unknown, s: StockBasic) => (
                        <Space>
                          <Button size="small" onClick={() => openKline(s)}>
                            K 线
                          </Button>
                          <Button
                            size="small"
                            icon={<EditOutlined />}
                            onClick={() => {
                              setStockForm({ code: s.code, name: s.name, exchange: s.exchange, industry: s.industry })
                              setStockModal(true)
                            }}
                          />
                          <Button size="small" danger icon={<DeleteOutlined />} onClick={() => removeStock(s.code)} />
                        </Space>
                      )
                    }
                  ]}
                />
              </div>
            )
          },
          {
            key: 'kline',
            label: 'K 线数据',
            children: (
              <div>
                <Space style={{ marginBottom: 8 }}>
                  <Input placeholder="股票代码（如 600519）" value={klineCode} onChange={(e) => setKlineCode(e.target.value)} style={{ width: 160 }} size="small" />
                  <Button size="small" onClick={loadKlineList}>
                    查询
                  </Button>
                  <Button size="small" icon={<PlusOutlined />} onClick={() => { setKlineForm({ code: klineCode, date: new Date().toISOString().slice(0, 10), open: 0, high: 0, low: 0, close: 0, volume: 0, amount: 0 }); setKlineModal(true) }}>
                    新增 K 线
                  </Button>
                </Space>
                {klineList.length > 0 && <KlineChart bars={klineList} height={300} />}
                <Table
                  rowKey={(r) => `${r.code}-${r.date}`}
                  size="small"
                  dataSource={klineList.slice().reverse()}
                  pagination={{ pageSize: 15 }}
                  style={{ marginTop: 8 }}
                  columns={[
                    { title: '日期', dataIndex: 'date', key: 'date', width: 110 },
                    { title: '开盘', dataIndex: 'open', key: 'open', width: 90, align: 'right' as const },
                    { title: '最高', dataIndex: 'high', key: 'high', width: 90, align: 'right' as const },
                    { title: '最低', dataIndex: 'low', key: 'low', width: 90, align: 'right' as const },
                    { title: '收盘', dataIndex: 'close', key: 'close', width: 90, align: 'right' as const },
                    { title: '成交量', dataIndex: 'volume', key: 'volume', width: 110, align: 'right' as const },
                    { title: '成交额', dataIndex: 'amount', key: 'amount', width: 120, align: 'right' as const },
                    { title: '复权因子', dataIndex: 'adjFactor', key: 'adjFactor', width: 90, align: 'right' as const },
                    {
                      title: '操作',
                      key: 'op',
                      width: 130,
                      render: (_: unknown, b: Bar) => (
                        <Space>
                          <Button
                            size="small"
                            onClick={() => {
                              setKlineForm({ code: b.code, date: b.date, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume, amount: b.amount })
                              setKlineModal(true)
                            }}
                          >
                            编辑
                          </Button>
                          <Button
                            size="small"
                            danger
                            onClick={() =>
                              Modal.confirm({
                                title: '删除 K 线',
                                content: `确认删除 ${b.code} ${b.date} 的 K 线？`,
                                okButtonProps: { danger: true },
                                onOk: async () => {
                                  await window.daydream.data.deleteKline(b.code, b.date)
                                  void loadKlineList()
                                }
                              })
                            }
                          >
                            删除
                          </Button>
                        </Space>
                      )
                    }
                  ]}
                />
              </div>
            )
          }
        ]}
      />

      {/* 选中股票 K 线预览 */}
      {selected && (
        <div className="dd-panel" style={{ marginTop: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
            <b>
              {selected.code} {selected.name} 日线
            </b>
            <Button size="small" onClick={() => setSelected(null)}>
              关闭
            </Button>
          </div>
          {bars.length > 0 ? <KlineChart bars={bars} height={360} /> : <div className="dd-muted">该标的暂无 K 线数据（可点击「一键全量同步」拉取）</div>}
        </div>
      )}

      {/* 股票 CRUD 弹窗 */}
      <Modal title={stockForm.code && stocks.some((s) => s.code === stockForm.code) ? '编辑股票' : '新增股票'} open={stockModal} onOk={saveStock} onCancel={() => setStockModal(false)} okText="保存" width={380}>
        <Form layout="vertical">
          <Form.Item label="股票代码" required>
            <Input value={stockForm.code} onChange={(e) => setStockForm({ ...stockForm, code: e.target.value })} placeholder="如 600519" />
          </Form.Item>
          <Form.Item label="名称" required>
            <Input value={stockForm.name} onChange={(e) => setStockForm({ ...stockForm, name: e.target.value })} placeholder="如 贵州茅台" />
          </Form.Item>
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
        </Form>
      </Modal>

      {/* K 线 CRUD 弹窗 */}
      <Modal title="K 线维护（补录/纠错）" open={klineModal} onOk={saveKline} onCancel={() => setKlineModal(false)} okText="保存" width={420}>
        <Form layout="vertical">
          <Space>
            <Form.Item label="代码" required>
              <Input value={klineForm.code} onChange={(e) => setKlineForm({ ...klineForm, code: e.target.value })} style={{ width: 140 }} />
            </Form.Item>
            <Form.Item label="日期" required>
              <Input value={klineForm.date} onChange={(e) => setKlineForm({ ...klineForm, date: e.target.value })} style={{ width: 140 }} placeholder="YYYY-MM-DD" />
            </Form.Item>
          </Space>
          <Space wrap>
            {(
              [
                ['open', '开盘'],
                ['high', '最高'],
                ['low', '最低'],
                ['close', '收盘']
              ] as const
            ).map(([key, label]) => (
              <Form.Item key={key} label={label}>
                <InputNumber style={{ width: 90 }} min={0} precision={3} value={klineForm[key]} onChange={(v) => setKlineForm({ ...klineForm, [key]: v ?? 0 })} />
              </Form.Item>
            ))}
          </Space>
          <Space>
            <Form.Item label="成交量">
              <InputNumber style={{ width: 130 }} min={0} precision={0} value={klineForm.volume} onChange={(v) => setKlineForm({ ...klineForm, volume: v ?? 0 })} />
            </Form.Item>
            <Form.Item label="成交额">
              <InputNumber style={{ width: 130 }} min={0} precision={0} value={klineForm.amount} onChange={(v) => setKlineForm({ ...klineForm, amount: v ?? 0 })} />
            </Form.Item>
          </Space>
        </Form>
      </Modal>
    </div>
  )
}
