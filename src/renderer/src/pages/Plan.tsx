/**
 * 规划页：Agent loop 执行规划可视化。
 * - 顶部：工作项队列的关键计数
 * - 执行节律时间轴 / 闭环流程
 * - 当前行动计划（结构化渲染，可查看原始 JSON）
 * - 工作项队列（可筛选、可展开上下文与结果）/ 最近事件流水
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button, Collapse, Empty, Input, message, Segmented, Space, Steps, Table, Tag, Timeline, Tooltip } from 'antd'
import { ReloadOutlined, RightOutlined } from '@ant-design/icons'
import type { WorkItem } from '@shared/types'
import { SCHEDULE } from '@shared/constants'
import { useAppStore } from '../stores'
import PageHeader from '../components/PageHeader'
import Panel from '../components/Panel'
import StatCard from '../components/StatCard'
import { eventLabel, prettyJson, WORKITEM_PRIORITY, WORKITEM_STATUS, WORKITEM_TYPE } from '../lib/labels'
import { fmtDateTime, fmtTime } from '../lib/format'

const RHYTHM = [
  { time: SCHEDULE.planTime, title: '盘前规划（周五为深度规划）', content: '评估市场与历史表现，制定/调整当日行动计划', kind: 'agent' },
  { time: '盘中（每 2~5 分钟）', title: '盘中盯盘', content: '监控持仓/候选池：涨跌停接近、量能异动、止损止盈线触及', kind: 'agent' },
  { time: SCHEDULE.runnerTime, title: '收盘运行决策', content: 'Agent 基于策略文档（系统提示词）按收盘快照产出交易建议（信号）', kind: 'agent' },
  { time: SCHEDULE.dataUpdateTime, title: '数据增量更新', content: '拉取当日全市场日线并入库（不受运行开关限制）', kind: 'data' },
  { time: SCHEDULE.reviewDailyTime, title: '日复盘（周五 17:30 周复盘）', content: '回顾信号执行与策略表现，归因分析，必要时产出纠正工作项', kind: 'agent' }
]

const CLOSED_LOOP = [
  { title: '触发 Trigger', description: '定时节律 / 用户指令 / 市场异动' },
  { title: '评估 Evaluate', description: '拼接上下文，模型评估必要性与优先级' },
  { title: '决策 Decide', description: '产出结论与需要人工确认的决策点' },
  { title: '工作项 WorkItem', description: '落库排队，按优先级与重试策略执行' },
  { title: '执行 Execute', description: '调用工具完成生成 / 回测 / 复盘 / 补数' },
  { title: '汇报 Report', description: '按级别归档，重要事项进入待决策' }
]

interface EventRow {
  id: number
  type: string
  payloadJson: string
  occurredAt: string
}

interface PlanView {
  goal?: string
  marketView?: string
  directions?: { title: string; description: string; priority: 'high' | 'medium' | 'low' }[]
  schedule?: string
}

export default function Plan(): React.ReactNode {
  const { currentAccount, eventSeq, agentRunning } = useAppStore()
  const accountId = currentAccount?.id ?? ''
  const [workItems, setWorkItems] = useState<WorkItem[]>([])
  const [plan, setPlan] = useState<Record<string, unknown>[]>([])
  const [events, setEvents] = useState<EventRow[]>([])
  const [wiFilter, setWiFilter] = useState<'all' | 'active' | 'failed'>('all')
  const [eventKeyword, setEventKeyword] = useState('')
  const [refreshing, setRefreshing] = useState(false)

  const refresh = useCallback(async () => {
    if (!accountId) return
    const [wi, p, ev] = await Promise.allSettled([
      window.daydream.agent.getWorkItems(accountId),
      window.daydream.agent.getPlan(accountId),
      window.daydream.events.list(accountId, 100)
    ])
    if (wi.status === 'fulfilled') setWorkItems(wi.value)
    if (p.status === 'fulfilled') setPlan(p.value)
    if (ev.status === 'fulfilled') setEvents(ev.value)
  }, [accountId])

  useEffect(() => {
    void refresh()
  }, [refresh, eventSeq])

  const manualRefresh = async (): Promise<void> => {
    setRefreshing(true)
    try {
      await refresh()
    } finally {
      setRefreshing(false)
    }
  }

  const latestPlan = plan[0] as { content_json?: string; period?: string; created_at?: string } | undefined

  const planContent = useMemo<PlanView | null>(() => {
    if (!latestPlan?.content_json) return null
    try {
      return JSON.parse(latestPlan.content_json) as PlanView
    } catch {
      return null
    }
  }, [latestPlan])

  /** 解析失败时的原始内容（用于兜底展示） */
  const planRaw = useMemo(() => {
    if (!latestPlan?.content_json) return ''
    try {
      return JSON.stringify(JSON.parse(latestPlan.content_json), null, 2)
    } catch {
      return latestPlan.content_json
    }
  }, [latestPlan])

  const counts = useMemo(() => {
    const by = (s: string): number => workItems.filter((w) => w.status === s).length
    return {
      total: workItems.length,
      pending: by('pending'),
      running: by('running'),
      failed: by('failed'),
      blocked: by('blocked'),
      succeeded: by('succeeded')
    }
  }, [workItems])

  const filteredWorkItems = useMemo(() => {
    if (wiFilter === 'active') return workItems.filter((w) => w.status === 'pending' || w.status === 'running' || w.status === 'blocked')
    if (wiFilter === 'failed') return workItems.filter((w) => w.status === 'failed' || w.status === 'cancelled')
    return workItems
  }, [workItems, wiFilter])

  const filteredEvents = useMemo(() => {
    if (!eventKeyword.trim()) return events
    const k = eventKeyword.trim().toLowerCase()
    return events.filter((e) => e.type.toLowerCase().includes(k) || e.payloadJson.toLowerCase().includes(k))
  }, [events, eventKeyword])

  const retry = (wi: WorkItem): void => {
    window.daydream.agent
      .retryWorkItem(wi.id)
      .then(() => {
        message.success('已重新入队')
        void refresh()
      })
      .catch((e) => message.error((e as Error).message))
  }

  const cancel = (wi: WorkItem): void => {
    window.daydream.agent
      .cancelWorkItem(wi.id)
      .then(() => {
        message.success('已取消')
        void refresh()
      })
      .catch((e) => message.error((e as Error).message))
  }

  return (
    <div className="dd-page">
      <PageHeader
        title="规划"
        badge={
          <Tag color={agentRunning ? 'success' : 'default'} style={{ marginInlineEnd: 0 }}>
            {agentRunning ? 'Agent 运行中' : 'Agent 已停止'}
          </Tag>
        }
        description="Agent 的每日节律、闭环流程与工作项队列；所有调度按北京时间执行，与机器时区无关。"
        extra={
          <Space size={8}>
            <Tooltip title="事件变化会自动刷新">
              <Tag color="processing" style={{ marginInlineEnd: 0 }}>
                实时
              </Tag>
            </Tooltip>
            <Button size="small" icon={<ReloadOutlined />} loading={refreshing} onClick={() => void manualRefresh()}>
              刷新
            </Button>
          </Space>
        }
      />

      <div className="dd-kpi-grid">
        <StatCard label="工作项总数" value={counts.total} sub={`成功 ${counts.succeeded}`} tone="primary" />
        <StatCard label="待执行" value={counts.pending} sub="排队等待调度" />
        <StatCard label="执行中" value={counts.running} sub="正在调用工具" tone="warning" />
        <StatCard label="待决策" value={counts.blocked} sub="需要人工确认" tone="warning" />
        <StatCard label="失败 / 取消" value={counts.failed} sub="可重试" tone={counts.failed > 0 ? 'down' : 'default'} />
        <StatCard label="事件流水" value={events.length} sub="最近 100 条" />
      </div>

      <div className="dd-grid-2">
        {/* 执行节律 */}
        <Panel title="执行节律" subtitle="北京时间">
          <Timeline
            items={RHYTHM.map((r) => ({
              color: r.kind === 'agent' ? (agentRunning ? 'blue' : 'gray') : 'gray',
              children: (
                <div>
                  <Space size={6} wrap>
                    <b style={{ fontVariantNumeric: 'tabular-nums' }}>{r.time}</b>
                    <Tag color={r.kind === 'agent' ? (agentRunning ? 'blue' : 'default') : 'default'} style={{ marginInlineEnd: 0 }}>
                      {r.kind === 'agent' ? (agentRunning ? 'Agent' : 'Agent（停止中）') : '数据'}
                    </Tag>
                  </Space>
                  <div style={{ fontWeight: 600, marginTop: 2 }}>{r.title}</div>
                  <div className="dd-muted" style={{ lineHeight: 1.6 }}>
                    {r.content}
                  </div>
                </div>
              )
            }))}
          />
        </Panel>

        {/* 闭环流程 */}
        <Panel title="Agent 闭环流程" subtitle={agentRunning ? '运行中' : '未运行'}>
          <Steps
            direction="vertical"
            size="small"
            current={agentRunning ? 2 : -1}
            items={CLOSED_LOOP.map((s) => ({ title: s.title, description: s.description }))}
          />
        </Panel>
      </div>

      {/* 当前行动计划 */}
      <Panel
        title="当前行动计划"
        subtitle={
          latestPlan
            ? `${latestPlan.period === 'weekly' ? '周度' : '每日'} · ${fmtDateTime(latestPlan.created_at)}`
            : '暂无'
        }
      >
        {planContent ? (
          <div className="dd-grid-main-side">
            <div>
              <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 6 }}>{planContent.goal ?? '（未命名计划）'}</div>
              {planContent.marketView ? (
                <div style={{ fontSize: 13, lineHeight: 1.75, marginBottom: 12 }}>{planContent.marketView}</div>
              ) : null}
              <div className="dd-card-sub" style={{ marginBottom: 4 }}>
                策略方向（{planContent.directions?.length ?? 0}）
              </div>
              {planContent.directions && planContent.directions.length > 0 ? (
                <div className="dd-list">
                  {planContent.directions.map((d, i) => (
                    <div key={`${d.title}-${i}`} className="dd-list-item">
                      <div className="dd-toolbar" style={{ gap: 6 }}>
                        <Tag color={WORKITEM_PRIORITY[d.priority]?.color ?? 'default'} style={{ marginInlineEnd: 0 }}>
                          {WORKITEM_PRIORITY[d.priority]?.label ?? d.priority}
                        </Tag>
                        <b style={{ fontSize: 13 }}>{d.title}</b>
                      </div>
                      <div className="dd-muted" style={{ lineHeight: 1.65 }}>
                        {d.description}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="dd-muted">本次计划未给出策略方向</div>
              )}
            </div>
            <div>
              <div className="dd-card-sub" style={{ marginBottom: 4 }}>
                时间安排
              </div>
              <div className="dd-panel-dashed" style={{ fontSize: 12, lineHeight: 1.7, marginBottom: 10 }}>
                {planContent.schedule || '—'}
              </div>
              <Collapse
                ghost
                size="small"
                items={[
                  {
                    key: 'raw',
                    label: '查看原始 JSON',
                    children: (
                      <pre className="dd-mono dd-scroll" style={{ margin: 0, maxHeight: 240 }}>
                        {planRaw}
                      </pre>
                    )
                  }
                ]}
              />
            </div>
          </div>
        ) : (
          <div className="dd-empty">
            <Empty description={false} image={Empty.PRESENTED_IMAGE_SIMPLE} />
            {latestPlan ? '计划内容解析失败，可展开原始内容查看' : '暂无行动计划：Agent 运行后由盘前规划产出'}
            {latestPlan ? (
              <pre className="dd-mono dd-scroll" style={{ margin: '8px 0 0', maxWidth: '100%', maxHeight: 220, textAlign: 'left' }}>
                {planRaw}
              </pre>
            ) : null}
          </div>
        )}
      </Panel>

      {/* 工作项队列 */}
      <Panel
        title="工作项队列"
        subtitle={`共 ${workItems.length} 项 · 进行中 ${counts.pending + counts.running}`}
        flush
        extra={
          <Segmented
            size="small"
            value={wiFilter}
            onChange={(v) => setWiFilter(v as 'all' | 'active' | 'failed')}
            options={[
              { value: 'all', label: '全部' },
              { value: 'active', label: '进行中' },
              { value: 'failed', label: '失败' }
            ]}
          />
        }
      >
        <Table
          rowKey="id"
          size="small"
          dataSource={filteredWorkItems}
          pagination={{ pageSize: 10, showSizeChanger: false, hideOnSinglePage: true }}
          locale={{ emptyText: <div className="dd-empty">暂无工作项</div> }}
          expandable={{
            rowExpandable: (wi) => Boolean(wi.contextJson || wi.resultJson || wi.error),
            expandIcon: ({ expanded, onExpand, record }) =>
              record.contextJson || record.resultJson || record.error ? (
                <Button
                  size="small"
                  type="text"
                  icon={<RightOutlined rotate={expanded ? 90 : 0} style={{ fontSize: 10 }} />}
                  onClick={(e) => onExpand(record, e)}
                />
              ) : null,
            expandedRowRender: (wi) => (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 12 }}>
                <div>
                  <div className="dd-card-sub" style={{ marginBottom: 4 }}>
                    上下文
                  </div>
                  <pre className="dd-mono dd-scroll" style={{ margin: 0, maxHeight: 200 }}>
                    {prettyJson(wi.contextJson)}
                  </pre>
                </div>
                <div>
                  <div className="dd-card-sub" style={{ marginBottom: 4 }}>
                    结果 / 错误
                  </div>
                  <pre className="dd-mono dd-scroll" style={{ margin: 0, maxHeight: 200 }}>
                    {wi.error ? wi.error : prettyJson(wi.resultJson)}
                  </pre>
                </div>
              </div>
            )
          }}
          columns={[
            { title: '类型', dataIndex: 'type', key: 'type', width: 120, render: (t: string) => WORKITEM_TYPE[t] ?? t },
            {
              title: '状态',
              dataIndex: 'status',
              key: 'status',
              width: 92,
              render: (s: string) => (
                <Tag color={WORKITEM_STATUS[s]?.color ?? 'default'} style={{ marginInlineEnd: 0 }}>
                  {WORKITEM_STATUS[s]?.label ?? s}
                </Tag>
              )
            },
            {
              title: '优先级',
              dataIndex: 'priority',
              key: 'priority',
              width: 78,
              render: (p: string) => (
                <Tag color={WORKITEM_PRIORITY[p]?.color ?? 'default'} style={{ marginInlineEnd: 0 }}>
                  {WORKITEM_PRIORITY[p]?.label ?? p}
                </Tag>
              )
            },
            {
              title: '计划时间',
              dataIndex: 'scheduledAt',
              key: 'scheduledAt',
              width: 150,
              render: (v?: string) => (v ? fmtDateTime(v) : <span className="dd-muted">—</span>)
            },
            { title: '创建时间', dataIndex: 'createdAt', key: 'createdAt', width: 130, render: (v: string) => fmtTime(v) },
            {
              title: '尝试',
              key: 'attempts',
              width: 70,
              align: 'right' as const,
              render: (_: unknown, wi: WorkItem) => `${wi.attempts}/${wi.maxAttempts}`
            },
            { title: '错误', dataIndex: 'error', key: 'error', ellipsis: true, render: (v?: string) => v ?? <span className="dd-muted">—</span> },
            {
              title: '操作',
              key: 'op',
              width: 120,
              render: (_: unknown, wi: WorkItem) => (
                <Space size={4}>
                  {(wi.status === 'failed' || wi.status === 'cancelled') && (
                    <Button size="small" onClick={() => retry(wi)}>
                      重试
                    </Button>
                  )}
                  {(wi.status === 'pending' || wi.status === 'running' || wi.status === 'blocked') && (
                    <Button size="small" danger onClick={() => cancel(wi)}>
                      取消
                    </Button>
                  )}
                </Space>
              )
            }
          ]}
        />
      </Panel>

      {/* 最近事件 */}
      <Panel
        title="最近事件流水"
        subtitle={`最近 ${filteredEvents.length} 条`}
        flush
        extra={
          <Input.Search
            size="small"
            allowClear
            placeholder="搜索类型或载荷"
            style={{ width: 220 }}
            value={eventKeyword}
            onChange={(e) => setEventKeyword(e.target.value)}
          />
        }
      >
        <Table
          rowKey="id"
          size="small"
          dataSource={filteredEvents}
          pagination={{ pageSize: 10, showSizeChanger: false, hideOnSinglePage: true }}
          locale={{ emptyText: <div className="dd-empty">暂无事件</div> }}
          expandable={{
            expandedRowRender: (ev) => (
              <pre className="dd-mono dd-scroll" style={{ margin: 0, maxHeight: 220 }}>
                {prettyJson(ev.payloadJson)}
              </pre>
            ),
            rowExpandable: (ev) => Boolean(ev.payloadJson)
          }}
          columns={[
            { title: '时间', dataIndex: 'occurredAt', key: 'occurredAt', width: 160, render: (v: string) => fmtDateTime(v) },
            {
              title: '事件类型',
              dataIndex: 'type',
              key: 'type',
              width: 180,
              render: (t: string) => (
                <Space size={6}>
                  <Tag style={{ marginInlineEnd: 0 }}>{eventLabel(t)}</Tag>
                  <span className="dd-muted" style={{ fontSize: 11 }}>
                    {t}
                  </span>
                </Space>
              )
            },
            {
              title: '载荷摘要',
              dataIndex: 'payloadJson',
              key: 'payloadJson',
              ellipsis: true,
              render: (v: string) => (
                <span className="dd-muted" style={{ fontSize: 12 }}>
                  {v.slice(0, 160)}
                </span>
              )
            }
          ]}
        />
      </Panel>
    </div>
  )
}
