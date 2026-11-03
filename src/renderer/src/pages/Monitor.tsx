/**
 * 盯盘页：盯盘池（持仓 ∪ 自选）、预警列表（分级）。
 */
import { useEffect, useState } from 'react'
import { Card, Table, Tag, Tabs, Input, Button, Space, message } from 'antd'
import type { Alert, Position, Quote } from '@shared/types'
import { useAppStore } from '../stores'

export default function Monitor(): React.ReactNode {
  const { currentAccount, lastEvent } = useAppStore()
  const [positions, setPositions] = useState<Position[]>([])
  const [quotes, setQuotes] = useState<Quote[]>([])
  const [alerts, setAlerts] = useState<Alert[]>([])
  const [watchCode, setWatchCode] = useState('')
  const accountId = currentAccount?.id ?? ''

  const load = (): void => {
    if (!accountId) return
    window.daydream.positions.list(accountId).then(async (positions) => {
      setPositions(positions)
      if (positions.length > 0) {
        const quotes = await window.daydream.data.getQuote(positions.map((p) => p.code))
        setQuotes(quotes)
      }
    })
    window.daydream.alerts.list(accountId).then(setAlerts).catch(() => undefined)
  }
  useEffect(load, [accountId, lastEvent])

  const addWatch = async (): Promise<void> => {
    if (!watchCode) return
    await window.daydream.positions.upsert({ accountId, code: watchCode.trim(), qty: 0, costPrice: 0 }).catch(() => undefined)
    message.success('已加入持仓列表（数量 0 表示仅盯盘）')
    setWatchCode('')
    load()
  }

  return (
    <Card title="盯盘">
      <Tabs
        items={[
          {
            key: 'pool',
            label: '盯盘池',
            children: (
              <>
                <Space style={{ marginBottom: 12 }}>
                  <Input placeholder="股票代码（加入盯盘）" value={watchCode} onChange={(e) => setWatchCode(e.target.value)} style={{ width: 200 }} />
                  <Button onClick={addWatch}>加入</Button>
                </Space>
                <Table<Position & { price?: number; pctChg?: number }>
                  size="small"
                  rowKey="code"
                  dataSource={positions.map((p) => {
                    const q = quotes.find((x) => x.code === p.code)
                    return { ...p, price: q?.price, pctChg: q?.pctChg }
                  })}
                  pagination={false}
                  columns={[
                    { title: '代码', dataIndex: 'code', width: 100 },
                    { title: '数量', dataIndex: 'qty', width: 100 },
                    { title: '成本价', dataIndex: 'costPrice', width: 100 },
                    { title: '最新价', dataIndex: 'price', width: 100, render: (v: number | undefined) => (v ? v.toFixed(2) : '—') },
                    {
                      title: '涨跌幅',
                      dataIndex: 'pctChg',
                      width: 100,
                      render: (v: number | undefined) =>
                        v == null ? '—' : <span style={{ color: v >= 0 ? '#e0564b' : '#2e9e63' }}>{(v * 100).toFixed(2)}%</span>
                    }
                  ]}
                />
              </>
            )
          },
          {
            key: 'alerts',
            label: `预警（${alerts.filter((a) => a.status === 'open').length}）`,
            children: (
              <Table<Alert>
                size="small"
                rowKey="id"
                dataSource={alerts}
                columns={[
                  { title: '时间', dataIndex: 'createdAt', width: 160, render: (v: string) => v.slice(0, 16).replace('T', ' ') },
                  {
                    title: '级别',
                    dataIndex: 'level',
                    width: 90,
                    render: (l: string) => <Tag color={l === 'critical' ? 'red' : l === 'warn' ? 'orange' : 'blue'}>{l}</Tag>
                  },
                  { title: '类型', dataIndex: 'type', width: 160 },
                  { title: '内容', dataIndex: 'contentJson', render: (v: string) => <pre style={{ margin: 0, fontSize: 12 }}>{v}</pre> },
                  {
                    title: '状态',
                    dataIndex: 'status',
                    width: 90,
                    render: (s: string) => <Tag color={s === 'open' ? 'red' : 'default'}>{s}</Tag>
                  }
                ]}
              />
            )
          }
        ]}
      />
    </Card>
  )
}
