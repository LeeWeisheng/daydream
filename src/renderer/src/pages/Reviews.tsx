/**
 * 复盘页：复盘报告列表与详情、绩效分析图表（策略对比/归因）、执行偏差统计。
 */
import { useEffect, useState } from 'react'
import { Card, Table, Tag, Drawer, Descriptions, Tabs, message } from 'antd'
import type { ReviewReport } from '@shared/types'
import { useAppStore } from '../stores'

export default function Reviews(): React.ReactNode {
  const { currentAccount, lastEvent } = useAppStore()
  const [reports, setReports] = useState<ReviewReport[]>([])
  const [detail, setDetail] = useState<ReviewReport | null>(null)
  const [charts, setCharts] = useState<Record<string, unknown>>({})
  const accountId = currentAccount?.id ?? ''

  useEffect(() => {
    if (!accountId) return
    window.daydream.reviews.list(accountId).then(setReports).catch(() => undefined)
    window.daydream.perf.getCharts(accountId).then(setCharts).catch(() => undefined)
  }, [accountId, lastEvent])

  const openDetail = async (report: ReviewReport): Promise<void> => {
    setDetail(report)
    void message
  }

  const content = detail?.contentJson ? (JSON.parse(detail.contentJson) as Record<string, unknown>) : null
  const metrics = detail?.metricsJson ? (JSON.parse(detail.metricsJson) as Record<string, unknown>) : null
  const deviation = (charts.deviation ?? {}) as { total?: number; executed?: number; ignored?: number; expired?: number; hitRate?: number }

  return (
    <div>
      <Card title="复盘报告">
        <Table<ReviewReport>
          size="small"
          rowKey="id"
          dataSource={reports}
          onRow={(record) => ({ onClick: () => openDetail(record), style: { cursor: 'pointer' } })}
          columns={[
            { title: '周期', dataIndex: 'period', width: 90, render: (v: string) => <Tag color={v === 'daily' ? 'blue' : 'purple'}>{v === 'daily' ? '日' : '周'}</Tag> },
            { title: '摘要', dataIndex: 'contentJson', ellipsis: true, render: (v: string) => {
              try {
                return (JSON.parse(v) as { summary?: string }).summary ?? v
              } catch {
                return v
              }
            } },
            { title: '时间', dataIndex: 'createdAt', width: 170, render: (v: string) => v.slice(0, 16).replace('T', ' ') }
          ]}
        />
      </Card>
      <Card title="绩效分析" style={{ marginTop: 16 }}>
        <Tabs
          items={[
            {
              key: 'deviation',
              label: '执行偏差',
              children: (
                <Descriptions column={4} size="small" bordered>
                  <Descriptions.Item label="信号总数">{deviation.total ?? 0}</Descriptions.Item>
                  <Descriptions.Item label="已执行">{deviation.executed ?? 0}</Descriptions.Item>
                  <Descriptions.Item label="忽略/过期">{`${deviation.ignored ?? 0}/${deviation.expired ?? 0}`}</Descriptions.Item>
                  <Descriptions.Item label="命中率">{deviation.hitRate != null ? `${(deviation.hitRate * 100).toFixed(1)}%` : '—'}</Descriptions.Item>
                </Descriptions>
              )
            },
            {
              key: 'metrics',
              label: '指标',
              children: (
                <Descriptions column={3} size="small" bordered>
                  {metrics
                    ? Object.entries(metrics).map(([k, v]) => (
                        <Descriptions.Item key={k} label={k}>
                          {typeof v === 'number' ? v.toFixed(4) : JSON.stringify(v)}
                        </Descriptions.Item>
                      ))
                    : null}
                </Descriptions>
              )
            }
          ]}
        />
      </Card>
      <Drawer title="复盘报告详情" width={720} open={!!detail} onClose={() => setDetail(null)}>
        {content && (
          <>
            <h4>总结</h4>
            <p>{String(content.summary ?? '')}</p>
            <h4>市场回顾</h4>
            <p>{String(content.marketReview ?? '')}</p>
            <h4>问题归因</h4>
            <pre style={{ background: '#1a1e26', padding: 12, borderRadius: 6, fontSize: 12, overflow: 'auto' }}>
              {JSON.stringify(content.problemAttribution ?? [], null, 2)}
            </pre>
            <h4>纠正建议</h4>
            <pre style={{ background: '#1a1e26', padding: 12, borderRadius: 6, fontSize: 12, overflow: 'auto' }}>
              {JSON.stringify(content.corrections ?? [], null, 2)}
            </pre>
          </>
        )}
      </Drawer>
    </div>
  )
}
