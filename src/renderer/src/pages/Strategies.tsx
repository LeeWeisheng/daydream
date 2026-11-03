/**
 * 策略中心：策略列表（状态/版本）、详情（DSL JSON + 设计理由）、
 * 上线/停用操作、手动创建策略（DSL 粘贴）。
 */
import { useEffect, useState } from 'react'
import { Card, Table, Tag, Button, Drawer, Descriptions, Input, Modal, Space, message } from 'antd'
import type { Strategy } from '@shared/types'
import { useAppStore } from '../stores'

const STATUS_COLORS: Record<string, string> = {
  draft: 'default',
  backtesting: 'processing',
  pending_approval: 'orange',
  active: 'green',
  paused: 'gold',
  deactivated: 'red'
}

export default function Strategies(): React.ReactNode {
  const { currentAccount, lastEvent } = useAppStore()
  const [strategies, setStrategies] = useState<Strategy[]>([])
  const [detail, setDetail] = useState<Strategy | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [name, setName] = useState('')
  const [dslText, setDslText] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const accountId = currentAccount?.id ?? ''

  const load = (): void => {
    if (!accountId) return
    window.daydream.strategies.list(accountId).then(setStrategies).catch(() => message.error('加载失败'))
  }
  useEffect(load, [accountId, lastEvent])

  const createStrategy = async (): Promise<void> => {
    setSubmitting(true)
    try {
      await window.daydream.strategies.create({ accountId, name, dslJson: dslText, createdBy: 'user' })
      message.success('策略已创建（draft）')
      setCreateOpen(false)
      setName('')
      setDslText('')
      load()
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Card
      title="策略中心"
      extra={
        <Space>
          <Button onClick={load}>刷新</Button>
          <Button type="primary" onClick={() => setCreateOpen(true)}>
            手动创建策略
          </Button>
        </Space>
      }
    >
      <Table<Strategy>
        size="small"
        rowKey="id"
        dataSource={strategies}
        onRow={(record) => ({ onClick: () => setDetail(record), style: { cursor: 'pointer' } })}
        columns={[
          { title: '名称', dataIndex: 'name', width: 200 },
          { title: '版本', dataIndex: 'version', width: 70 },
          { title: '状态', dataIndex: 'status', width: 130, render: (s: string) => <Tag color={STATUS_COLORS[s]}>{s}</Tag> },
          { title: '来源', dataIndex: 'createdBy', width: 90 },
          { title: '创建时间', dataIndex: 'createdAt', width: 170, render: (v: string) => v.slice(0, 16).replace('T', ' ') }
        ]}
      />

      <Drawer title="策略详情" width={560} open={!!detail} onClose={() => setDetail(null)}>
        {detail && (
          <>
            <Descriptions column={2} size="small" bordered>
              <Descriptions.Item label="名称">{detail.name}</Descriptions.Item>
              <Descriptions.Item label="版本">v{detail.version}</Descriptions.Item>
              <Descriptions.Item label="状态">
                <Tag color={STATUS_COLORS[detail.status]}>{detail.status}</Tag>
              </Descriptions.Item>
              <Descriptions.Item label="来源">{detail.createdBy}</Descriptions.Item>
              <Descriptions.Item label="设计理由" span={2}>
                {detail.rationale || '—'}
              </Descriptions.Item>
            </Descriptions>
            <pre style={{ background: '#1a1e26', padding: 12, borderRadius: 6, overflow: 'auto', maxHeight: 360, fontSize: 12 }}>
              {JSON.stringify(JSON.parse(detail.dslJson || '{}'), null, 2)}
            </pre>
            <Space style={{ marginTop: 16 }}>
              {(detail.status === 'pending_approval' || detail.status === 'paused') && (
                <Button
                  type="primary"
                  onClick={async () => {
                    await window.daydream.strategies.activate(detail.id)
                    message.success('已激活')
                    setDetail(null)
                    load()
                  }}
                >
                  上线运行
                </Button>
              )}
              {detail.status === 'active' && (
                <Button
                  danger
                  onClick={async () => {
                    await window.daydream.strategies.deactivate(detail.id)
                    message.success('已停用')
                    setDetail(null)
                    load()
                  }}
                >
                  停用
                </Button>
              )}
            </Space>
          </>
        )}
      </Drawer>

      <Modal title="手动创建策略" open={createOpen} onOk={createStrategy} onCancel={() => setCreateOpen(false)} confirmLoading={submitting} width={640}>
        <Input placeholder="策略名称" value={name} onChange={(e) => setName(e.target.value)} style={{ marginBottom: 12 }} />
        <Input.TextArea
          rows={16}
          placeholder={'粘贴策略 DSL JSON（声明式：meta/universe/entry/exit/portfolio）\n指标必须来自白名单，校验通过才可创建'}
          value={dslText}
          onChange={(e) => setDslText(e.target.value)}
          style={{ fontFamily: 'monospace', fontSize: 12 }}
        />
      </Modal>
    </Card>
  )
}
