/**
 * 审计页：事件流水、Agent 决策记录、LLM 调用统计、操作审计。
 * 支持按时间/对象筛选，回放"系统为什么这么做"。
 */
import { useEffect, useState } from 'react'
import { Card, Table, Tabs, Tag, Input } from 'antd'
import type { EventLogEntry, WorkItem } from '@shared/types'
import { useAppStore } from '../stores'

interface AuditRow {
  id: number
  actor: string
  action: string
  target: string | null
  detail_json: string
  created_at: string
}

export default function Audit(): React.ReactNode {
  const { currentAccount, lastEvent } = useAppStore()
  const [events, setEvents] = useState<EventLogEntry[]>([])
  const [audits, setAudits] = useState<AuditRow[]>([])
  const [workItems, setWorkItems] = useState<WorkItem[]>([])
  const [filter, setFilter] = useState('')
  const accountId = currentAccount?.id ?? ''

  useEffect(() => {
    if (!accountId) return
    window.daydream.audit.events(accountId, 300).then(setEvents).catch(() => undefined)
    window.daydream.audit
      .list(accountId, 300)
      .then((rows) => setAudits(rows as unknown as AuditRow[]))
      .catch(() => undefined)
    window.daydream.agent.getWorkItems(accountId).then(setWorkItems).catch(() => undefined)
  }, [accountId, lastEvent])

  const filteredEvents = filter ? events.filter((e) => e.type.includes(filter) || e.payloadJson.includes(filter)) : events
  const filteredAudits = filter ? audits.filter((a) => a.action.includes(filter) || (a.target ?? '').includes(filter)) : audits

  return (
    <Card title="审计" extra={<Input placeholder="筛选（类型/动作/对象）" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ width: 260 }} allowClear />}>
      <Tabs
        items={[
          {
            key: 'events',
            label: `事件流水（${events.length}）`,
            children: (
              <Table<EventLogEntry>
                size="small"
                rowKey="id"
                dataSource={filteredEvents.slice(0, 300)}
                pagination={{ pageSize: 30 }}
                columns={[
                  { title: '时间', dataIndex: 'occurredAt', width: 170, render: (v: string) => v.slice(0, 16).replace('T', ' ') },
                  { title: '类型', dataIndex: 'type', width: 180, render: (v: string) => <Tag>{v}</Tag> },
                  { title: '来源', dataIndex: 'source', width: 100 },
                  { title: '载荷', dataIndex: 'payloadJson', ellipsis: true }
                ]}
              />
            )
          },
          {
            key: 'audits',
            label: `操作审计（${audits.length}）`,
            children: (
              <Table<AuditRow>
                size="small"
                rowKey="id"
                dataSource={filteredAudits.slice(0, 300)}
                pagination={{ pageSize: 30 }}
                columns={[
                  { title: '时间', dataIndex: 'created_at', width: 170, render: (v: string) => v.slice(0, 16).replace('T', ' ') },
                  { title: '角色', dataIndex: 'actor', width: 100, render: (v: string) => <Tag color={v === 'user' ? 'blue' : v === 'agent' ? 'green' : 'default'}>{v}</Tag> },
                  { title: '动作', dataIndex: 'action', width: 220 },
                  { title: '对象', dataIndex: 'target', width: 200, ellipsis: true },
                  { title: '详情', dataIndex: 'detail_json', ellipsis: true }
                ]}
              />
            )
          },
          {
            key: 'workitems',
            label: `工作项（${workItems.length}）`,
            children: (
              <Table<WorkItem>
                size="small"
                rowKey="id"
                dataSource={workItems.slice(0, 300)}
                pagination={{ pageSize: 30 }}
                columns={[
                  { title: '类型', dataIndex: 'type', width: 160 },
                  { title: '状态', dataIndex: 'status', width: 110 },
                  { title: '优先级', dataIndex: 'priority', width: 90 },
                  { title: '尝试', dataIndex: 'attempts', width: 70 },
                  { title: '创建时间', dataIndex: 'createdAt', width: 170, render: (v: string) => String(v).slice(0, 16).replace('T', ' ') },
                  { title: '结果/错误', dataIndex: 'resultJson', ellipsis: true }
                ]}
              />
            )
          }
        ]}
      />
    </Card>
  )
}
