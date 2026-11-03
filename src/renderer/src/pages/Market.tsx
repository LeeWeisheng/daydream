/**
 * 行情页：股票搜索、实时行情列表、K 线图（前/后复权数据为原始+因子，展示不复权）。
 */
import { useEffect, useState } from 'react'
import { Card, Input, Table, Tag, message } from 'antd'
import type { Bar, StockBasic } from '@shared/types'
import KlineChart from '../components/KlineChart'

export default function Market(): React.ReactNode {
  const [stocks, setStocks] = useState<StockBasic[]>([])
  const [selected, setSelected] = useState<StockBasic | null>(null)
  const [bars, setBars] = useState<Bar[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    window.daydream.data
      .getStockList()
      .then((list) => setStocks(list.slice(0, 500)))
      .catch(() => message.error('股票列表加载失败（请先完成数据初始化）'))
  }, [])

  const selectStock = async (code: string): Promise<void> => {
    setLoading(true)
    try {
      const end = new Date().toISOString().slice(0, 10)
      const start = new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10)
      const klines = await window.daydream.data.getKline(code, start, end)
      setBars(klines)
      const stock = stocks.find((s) => s.code === code) ?? null
      setSelected(stock)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div>
      <Card title="行情" extra={<Input.Search placeholder="搜索代码/名称" style={{ width: 260 }} allowClear />}>
        <Table<StockBasic>
          size="small"
          rowKey="code"
          loading={loading}
          dataSource={stocks}
          pagination={{ pageSize: 20 }}
          scroll={{ y: 400 }}
          onRow={(record) => ({ onClick: () => selectStock(record.code), style: { cursor: 'pointer' } })}
          columns={[
            { title: '代码', dataIndex: 'code', width: 100 },
            { title: '名称', dataIndex: 'name', width: 160 },
            { title: '交易所', dataIndex: 'exchange', width: 90, render: (v: string) => <Tag>{v}</Tag> }
          ]}
        />
      </Card>
      {selected && (
        <Card title={`${selected.name}（${selected.code}）K 线（近一年日线）`} style={{ marginTop: 16 }}>
          {bars.length > 0 ? <KlineChart bars={bars} /> : <div style={{ color: '#8c93a3' }}>无 K 线数据（请先在设置页完成数据初始化）</div>}
        </Card>
      )}
    </div>
  )
}
