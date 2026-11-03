/**
 * 运行与信号：运行中策略、信号流（实时推送）、信号详情（依据/风控/快照）
 * 与「已执行/已忽略」反馈闭环。
 */
import { useEffect, useState } from 'react'
import { Card, Table, Tag, Button, Space, Drawer, Descriptions, message, Popconfirm } from 'antd'
import type { RunInstance, Signal } from '@shared/types'
import { useAppStore } from '../stores'

const STATUS_TAG: Record<string, { color: string; label: string }> = {
  pending_confirmation: { color: 'orange', label: '待确认' },
  pending_execution: { color: 'processing', label: '待执行' },
  executed: { color: 'green', label: '已执行' },
  ignored: { color: 'default', label: '已忽略' },
  expired: { color: 'default', label: '已过期' }
}

export default function Signals(): React.ReactNode {
  const { currentAccount, lastEvent } = useAppStore()
  const [signals, setSignals] = useState<Signal[]>([])
  const [runs, setRuns] = useState<(RunInstance & { strategy_name?: string })[]>([])
  const [detail, setDetail] = useState<Signal | null>(null)
  const accountId = currentAccount?.id ?? ''

  const load = (): void => {
    if (!accountId) return
    window.daydream.signals.list(accountId, 200).then(setSignals).catch(() => undefined)
    window.daydream.runs.list(accountId).then(setRuns).catch(() => undefined)
  }
  useEffect(load, [accountId, lastEvent])

  const feedback = async (signal: Signal, fb: 'executed' | 'ignored'): Promise<void> => {
    try {
      await window.daydream.signals.feedback({ signalId: signal.id, feedback: fb })
      message.success('已反馈')
      load()
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  return (
    <div>
      <Card title="运行中策略">
        <Table<RunInstance & { strategy_name?: string }>
          size="small"
          rowKey="id"
          dataSource={runs}
          pagination={false}
          columns={[
            { title: '策略', dataIndex: 'strategy_name', width: 240 },
            { title: '状态', dataIndex: 'status', width: 100, render: (s: string) => <Tag color={s === 'active' ? 'green' : 'default'}>{s}</Tag> },
            { title: '开始时间', dataIndex: 'started_at', width: 180, render: (v: string) => v?.slice(0, 16).replace('T', ' ') }
          ]}
        />
      </Card>
      <Card title="信号流" style={{ marginTop: 16 }}>
        <Table<Signal>
          size="small"
          rowKey="id"
          dataSource={signals}
          onRow={(record) => ({ onClick: () => setDetail(record), style: { cursor: 'pointer' } })}
          columns={[
            { title: '时间', dataIndex: 'createdAt', width: 160, render: (v: string) => v.slice(0, 16).replace('T', ' ') },
            { title: '代码', dataIndex: 'code', width: 90 },
            { title: '方向', dataIndex: 'side', width: 70, render: (s: string) => <Tag color={s === 'buy' ? 'red' : 'green'}>{s === 'buy' ? '买入' : '卖出'}</Tag> },
            { title: '数量', dataIndex: 'qty', width: 80 },
            { title: '参考价', dataIndex: 'refPrice', width: 90 },
            {
              title: '状态',
              dataIndex: 'status',
              width: 100,
              render: (s: string) => <Tag color={STATUS_TAG[s]?.color}>{STATUS_TAG[s]?.label ?? s}</Tag>
            },
            {
              title: '操作',
              width: 180,
              render: (_, record) =>
                record.status === 'pending_execution' || record.status === 'pending_confirmation' ? (
                  <Space onClick={(e) => e.stopPropagation()}>
                    <Popconfirm title="确认已执行（将生成成交记录）" onConfirm={() => feedback(record, 'executed')}>
                      <Button size="small" type="primary">
                        已执行
                      </Button>
                    </Popconfirm>
                    <Button size="small" onClick={() => feedback(record, 'ignored')}>
                      忽略
                    </Button>
                  </Space>
                ) : null
            }
          ]}
        />
      </Card>
      <Drawer title="信号详情" width={560} open={!!detail} onClose={() => setDetail(null)}>
        {detail && (
          <>
            <Descriptions column={2} size="small" bordered>
              <Descriptions.Item label="代码">{detail.code}</Descriptions.Item>
              <Descriptions.Item label="方向">{detail.side === 'buy' ? '买入' : '卖出'}</Descriptions.Item>
              <Descriptions.Item label="数量">{detail.qty}</Descriptions.Item>
              <Descriptions.Item label="参考价">{detail.refPrice}</Descriptions.Item>
              <Descriptions.Item label="有效期至">{detail.expiresAt.slice(0, 16).replace('T', ' ')}</Descriptions.Item>
              <Descriptions.Item label="状态">{detail.status}</Descriptions.Item>
            </Descriptions>
            <h4>触发依据</h4>
            <pre style={{ background: '#1a1e26', padding: 12, borderRadius: 6, fontSize: 12 }}>{JSON.stringify(JSON.parse(detail.basisJson || '{}'), null, 2)}</pre>
            <h4>风控结论</h4>
            <pre style={{ background: '#1a1e26', padding: 12, borderRadius: 6, fontSize: 12 }}>{JSON.stringify(JSON.parse(detail.riskJson || '{}'), null, 2)}</pre>
          </>
        )}
      </Drawer>
    </div>
  )
}
