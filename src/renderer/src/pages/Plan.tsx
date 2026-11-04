/**
 * 规划页：Agent loop 执行规划可视化。
 * - 执行节律时间轴（执行时间点 + 执行内容）
 * - 闭环流程（触发→评估→决策→工作项→执行→汇报）
 * - 当前行动计划 / 工作项队列 / 最近事件流水
 */
import { useCallback, useEffect, useState } from 'react'
import { Timeline, Steps, Table, Tag, Button, message, Space } from 'antd'
import { useAntdToken } from 'antd-style'
import type { WorkItem } from '@shared/types'
import { useAppStore } from '../stores'
import { SCHEDULE } from '@shared/constants'

const RHYTHM = [
  { time: SCHEDULE.planTime, title: '盘前规划（周五为深度规划）', content: '评估市场与历史表现，制定/调整当日行动计划', kind: 'agent' },
  { time: '盘中（每 2~5 分钟）', title: '盘中盯盘', content: '监控持仓/候选池：涨跌停接近、量能异动、止损止盈线触及', kind: 'agent' },
  { time: SCHEDULE.runnerTime, title: '收盘运行决策', content: '运行中策略按收盘快照评估入场/出场条件，产出次日交易建议（信号）', kind: 'agent' },
  { time: SCHEDULE.dataUpdateTime, title: '数据增量更新', content: '拉取当日全市场日线并入库（不受运行开关限制）', kind: 'data' },
  { time: SCHEDULE.reviewDailyTime, title: '日复盘（周五 17:30 周复盘）', content: '回顾信号执行与策略表现，归因分析，必要时产出纠正工作项', kind: 'agent' }
]

const WORKITEM_STATUS: Record<string, { color: string; label: string }> = {
  pending: { color: 'default', label: '待执行' },
  running: { color: 'processing', label: '执行中' },
  succeeded: { color: 'success', label: '成功' },
  failed: { color: 'error', label: '失败' },
  blocked: { color: 'orange', label: '待决策' },
  cancelled: { color: 'default', label: '已取消' }
}

const WORKITEM_TYPE: Record<string, string> = {
  plan: '规划',
  generate_strategy: '生成策略',
  backtest: '回测',
  activate: '上线评审',
  monitor_review: '盯盘检查',
  review_daily: '日复盘',
  review_weekly: '周复盘',
  correct: '纠正',
  data_backfill: '数据补数',
  user_request: '用户请求'
}

export default function Plan(): React.ReactNode {
  const { currentAccount, eventSeq, agentRunning } = useAppStore()
  const token = useAntdToken()
  const accountId = currentAccount?.id ?? ''
  const [workItems, setWorkItems] = useState<WorkItem[]>([])
  const [plan, setPlan] = useState<Record<string, unknown>[]>([])
  const [events, setEvents] = useState<{ id: number; type: string; payloadJson: string; occurredAt: string }[]>([])

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

  const latestPlan = plan[0] as { content_json?: string; period?: string; created_at?: string } | undefined
  let planContent: Record<string, unknown> | null = null
  if (latestPlan?.content_json) {
    try {
      planContent = JSON.parse(latestPlan.content_json) as Record<string, unknown>
    } catch {
      planContent = { raw: latestPlan.content_json }
    }
  }

  return (
    <div className="dd-page">
      <div className="dd-page-title">Agent 执行规划</div>

      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
        {/* 执行节律时间轴 */}
        <div className="dd-panel" style={{ flex: 1 }}>
          <div className="dd-section-title">执行节律（北京时间，与机器时区无关）</div>
          <Timeline
            items={RHYTHM.map((r) => ({
              color: r.kind === 'agent' ? 'blue' : 'gray',
              children: (
                <div>
                  <Space>
                    <b>{r.time}</b>
                    <Tag color={r.kind === 'agent' ? (agentRunning ? 'blue' : 'default') : 'default'}>{r.kind === 'agent' ? (agentRunning ? 'Agent' : 'Agent（停止中）') : '数据'}</Tag>
                  </Space>
                  <div style={{ fontWeight: 600 }}>{r.title}</div>
                  <div className="dd-muted" style={{ fontSize: 12 }}>
                    {r.content}
                  </div>
                </div>
              )
            }))}
          />
        </div>

        {/* 闭环流程 */}
        <div className="dd-panel" style={{ flex: 1 }}>
          <div className="dd-section-title">Agent 闭环流程</div>
          <Steps
            direction="vertical"
            size="small"
            current={agentRunning ? 2 : -1}
            items={['触发 Trigger', '评估 Evaluate', '决策 Decide', '工作项 WorkItem', '执行 Execute', '汇报 Report'].map((t) => ({ title: t }))}
          />
        </div>
      </div>

      {/* 当前行动计划 */}
      <div className="dd-panel" style={{ marginTop: 16 }}>
        <div className="dd-section-title">当前行动计划（{latestPlan ? `${latestPlan.period ?? ''} · ${new Date(latestPlan.created_at ?? '').toLocaleString('zh-CN', { hour12: false })}` : '暂无'})</div>
        {planContent ? (
          <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontSize: 12, color: token.colorText, fontFamily: 'inherit' }}>
            {JSON.stringify(planContent, null, 2)}
          </pre>
        ) : (
          <span className="dd-muted">暂无行动计划（Agent 运行后将由盘前规划产出）</span>
        )}
      </div>

      {/* 工作项队列 */}
      <div className="dd-panel" style={{ marginTop: 16 }}>
        <div className="dd-section-title">工作项队列</div>
        <Table
          rowKey="id"
          size="small"
          dataSource={workItems}
          pagination={{ pageSize: 10 }}
          columns={[
            { title: '类型', dataIndex: 'type', key: 'type', width: 120, render: (t: string) => WORKITEM_TYPE[t] ?? t },
            { title: '状态', dataIndex: 'status', key: 'status', width: 90, render: (s: string) => <Tag color={WORKITEM_STATUS[s]?.color ?? 'default'}>{WORKITEM_STATUS[s]?.label ?? s}</Tag> },
            { title: '优先级', dataIndex: 'priority', key: 'priority', width: 80 },
            { title: '创建时间', dataIndex: 'createdAt', key: 'createdAt', width: 160, render: (v: string) => new Date(v).toLocaleString('zh-CN', { hour12: false }) },
            { title: '计划时间', dataIndex: 'scheduledAt', key: 'scheduledAt', width: 160, render: (v?: string) => (v ? new Date(v).toLocaleString('zh-CN', { hour12: false }) : '—') },
            { title: '错误', dataIndex: 'error', key: 'error', ellipsis: true, render: (v?: string) => v ?? '—' },
            {
              title: '操作',
              key: 'op',
              width: 130,
              render: (_: unknown, wi: WorkItem) => (
                <Space>
                  {(wi.status === 'failed' || wi.status === 'cancelled') && (
                    <Button size="small" onClick={() => window.daydream.agent.retryWorkItem(wi.id).then(() => refresh()).catch((e) => message.error((e as Error).message))}>
                      重试
                    </Button>
                  )}
                  {(wi.status === 'pending' || wi.status === 'running' || wi.status === 'blocked') && (
                    <Button size="small" danger onClick={() => window.daydream.agent.cancelWorkItem(wi.id).then(() => refresh()).catch((e) => message.error((e as Error).message))}>
                      取消
                    </Button>
                  )}
                </Space>
              )
            }
          ]}
        />
      </div>

      {/* 最近事件 */}
      <div className="dd-panel" style={{ marginTop: 16 }}>
        <div className="dd-section-title">最近事件流水</div>
        <Table
          rowKey="id"
          size="small"
          dataSource={events}
          pagination={{ pageSize: 10 }}
          columns={[
            { title: '时间', dataIndex: 'occurredAt', key: 'occurredAt', width: 180, render: (v: string) => new Date(v).toLocaleString('zh-CN', { hour12: false }) },
            { title: '事件类型', dataIndex: 'type', key: 'type', width: 200 },
            { title: '载荷', dataIndex: 'payloadJson', key: 'payloadJson', ellipsis: true, render: (v: string) => v.slice(0, 200) }
          ]}
        />
      </div>
    </div>
  )
}
