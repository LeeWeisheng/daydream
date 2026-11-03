/**
 * 回测页：任务列表、回测报告（指标卡、净值/回撤曲线、成交明细、样本内外对比）。
 */
import { useEffect, useState } from 'react'
import { Card, Table, Tag, Drawer, Row, Col, Statistic, Tabs } from 'antd'
import type { BacktestRun, BacktestTrade } from '@shared/types'
import EquityChart from '../components/EquityChart'
import { useAppStore } from '../stores'

interface BacktestRow extends BacktestRun {
  id: string
  metricsJson?: string
  equityJson?: string
  reportJson?: string
  createdAt: string
}

export default function Backtests(): React.ReactNode {
  const { currentAccount, lastEvent } = useAppStore()
  const [runs, setRuns] = useState<BacktestRow[]>([])
  const [detail, setDetail] = useState<BacktestRow | null>(null)
  const [trades, setTrades] = useState<BacktestTrade[]>([])
  const accountId = currentAccount?.id ?? ''

  useEffect(() => {
    if (!accountId) return
    window.daydream.backtests
      .list(accountId)
      .then((rows) => setRuns(rows as unknown as BacktestRow[]))
      .catch(() => undefined)
  }, [accountId, lastEvent])

  const openDetail = async (run: BacktestRow): Promise<void> => {
    setDetail(run)
    const t = await window.daydream.backtests.getTrades(run.id)
    setTrades(t)
  }

  const metrics = detail?.metricsJson ? (JSON.parse(detail.metricsJson) as Record<string, number>) : null
  const equity = detail?.equityJson ? (JSON.parse(detail.equityJson) as { date: string; equity: number; benchmark: number }[]) : []
  const report = detail?.reportJson ? (JSON.parse(detail.reportJson) as { evaluation?: { verdict: string; summary: string } }) : null

  return (
    <Card title="回测">
      <Table<BacktestRow>
        size="small"
        rowKey="id"
        dataSource={runs}
        onRow={(record) => ({ onClick: () => openDetail(record), style: { cursor: 'pointer' } })}
        columns={[
          { title: '回测 ID', dataIndex: 'id', width: 220, ellipsis: true },
          { title: '状态', dataIndex: 'status', width: 110, render: (s: string) => <Tag color={s === 'succeeded' ? 'green' : s === 'failed' ? 'red' : 'processing'}>{s}</Tag> },
          { title: '创建时间', dataIndex: 'createdAt', width: 170, render: (v: string) => v.slice(0, 16).replace('T', ' ') }
        ]}
      />
      <div style={{ color: '#8c93a3', fontSize: 12, marginTop: 8 }}>
        回测由 Agent 自动发起（策略生成后）；手动发起可通过 Agent 对话或策略详情页操作。
      </div>

      <Drawer title="回测报告" width={860} open={!!detail} onClose={() => setDetail(null)}>
        {detail && metrics && (
          <>
            <Row gutter={12}>
              {[
                ['总收益率', metrics.totalReturn, '%'],
                ['年化收益', metrics.annualReturn, '%'],
                ['最大回撤', metrics.maxDrawdown, '%'],
                ['夏普比率', metrics.sharpe, ''],
                ['交易次数', metrics.tradeCount, ''],
                ['胜率', metrics.winRate, '%']
              ].map(([label, value, suffix]) => (
                <Col span={4} key={label as string}>
                  <Card size="small">
                    <Statistic
                      title={label}
                      value={typeof value === 'number' ? (Math.abs(value) < 1 && suffix === '%' ? (value * 100).toFixed(2) : Number(value).toFixed(2)) : value}
                      suffix={suffix}
                    />
                  </Card>
                </Col>
              ))}
            </Row>
            {report?.evaluation && (
              <Card size="small" style={{ marginTop: 12 }}>
                <Tag color={report.evaluation.verdict === 'pass' ? 'green' : report.evaluation.verdict === 'adjust' ? 'orange' : 'red'}>
                  评估结论：{report.evaluation.verdict}
                </Tag>
                <span style={{ marginLeft: 8 }}>{report.evaluation.summary}</span>
              </Card>
            )}
            <Tabs
              style={{ marginTop: 12 }}
              items={[
                { key: 'equity', label: '净值曲线', children: <EquityChart points={equity} /> },
                {
                  key: 'trades',
                  label: '成交明细',
                  children: (
                    <Table<BacktestTrade>
                      size="small"
                      rowKey={(r) => `${r.tradedAt}-${r.code}-${r.side}`}
                      dataSource={trades}
                      pagination={{ pageSize: 20 }}
                      columns={[
                        { title: '日期', dataIndex: 'tradedAt', width: 110 },
                        { title: '代码', dataIndex: 'code', width: 90 },
                        { title: '方向', dataIndex: 'side', width: 70, render: (s: string) => <Tag color={s === 'buy' ? 'red' : 'green'}>{s}</Tag> },
                        { title: '价格', dataIndex: 'price', width: 90 },
                        { title: '数量', dataIndex: 'qty', width: 90 },
                        { title: '费用', dataIndex: 'fee', width: 80 },
                        { title: '盈亏', dataIndex: 'pnl', width: 100, render: (v: number | null) => (v == null ? '—' : v.toFixed(2)) }
                      ]}
                    />
                  )
                }
              ]}
            />
          </>
        )}
      </Drawer>
    </Card>
  )
}
