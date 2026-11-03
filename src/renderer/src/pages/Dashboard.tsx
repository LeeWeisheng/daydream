/**
 * 仪表盘：Agent 运行状态、账户概览、今日信号、待决策事项、最近预警。
 */
import { useEffect, useState } from 'react'
import { Card, Col, Row, Statistic, Tag, List, Empty, Button, message } from 'antd'
import type { Alert, Position, Report, Signal } from '@shared/types'
import { useAppStore } from '../stores'

export default function Dashboard(): React.ReactNode {
  const { currentAccount, lastEvent } = useAppStore()
  const [signals, setSignals] = useState<Signal[]>([])
  const [positions, setPositions] = useState<Position[]>([])
  const [reports, setReports] = useState<Report[]>([])
  const [alerts, setAlerts] = useState<Alert[]>([])
  const [agentStatus, setAgentStatus] = useState<{ active: boolean }>({ active: false })

  const accountId = currentAccount?.id ?? ''

  useEffect(() => {
    if (!accountId) return
    const load = (): void => {
      window.daydream.signals.list(accountId, 10).then(setSignals).catch(() => undefined)
      window.daydream.positions.list(accountId).then(setPositions).catch(() => undefined)
      window.daydream.reports.list(accountId).then(setReports).catch(() => undefined)
      window.daydream.alerts.list(accountId).then(setAlerts).catch(() => undefined)
      window.daydream.agent.getStatus().then(setAgentStatus).catch(() => undefined)
    }
    load()
  }, [accountId, lastEvent])

  const pendingDecisions = reports.filter((r) => r.status === 'pending' && r.level === 'need_decision')
  const todaySignals = signals.filter((s) => s.createdAt.slice(0, 10) === new Date().toISOString().slice(0, 10))
  const marketValue = positions.reduce((sum, p) => sum + p.qty * p.costPrice, 0)

  return (
    <div>
      <Row gutter={16}>
        <Col span={6}>
          <Card>
            <Statistic title="持仓数量" value={positions.length} suffix="只" />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic title="持仓市值（成本）" value={marketValue.toFixed(0)} prefix="¥" />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic title="今日信号" value={todaySignals.length} suffix="条" />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic
              title="Agent 状态"
              value={agentStatus.active ? '运行中' : '待命'}
              valueStyle={{ color: agentStatus.active ? '#52c41a' : '#8c93a3' }}
            />
          </Card>
        </Col>
      </Row>

      <Row gutter={16} style={{ marginTop: 16 }}>
        <Col span={12}>
          <Card title="待决策事项" extra={<Button size="small" type="link" onClick={() => window.location.hash}>前往处理</Button>}>
            {pendingDecisions.length === 0 ? (
              <Empty description="暂无待决策事项" />
            ) : (
              <List
                size="small"
                dataSource={pendingDecisions.slice(0, 5)}
                renderItem={(r) => (
                  <List.Item>
                    <span>{r.title}</span>
                    <Tag color="orange">{r.level}</Tag>
                  </List.Item>
                )}
              />
            )}
          </Card>
        </Col>
        <Col span={12}>
          <Card title="最近预警">
            {alerts.length === 0 ? (
              <Empty description="暂无预警" />
            ) : (
              <List
                size="small"
                dataSource={alerts.slice(0, 5)}
                renderItem={(a) => (
                  <List.Item>
                    <span>{a.type}</span>
                    <Tag color={a.level === 'critical' ? 'red' : a.level === 'warn' ? 'orange' : 'blue'}>{a.level}</Tag>
                  </List.Item>
                )}
              />
            )}
          </Card>
        </Col>
      </Row>

      <Card title="今日信号" style={{ marginTop: 16 }}>
        {todaySignals.length === 0 ? (
          <Empty description="今日暂无信号" />
        ) : (
          <List
            size="small"
            dataSource={todaySignals}
            renderItem={(s) => (
              <List.Item
                actions={[
                  <Tag key="side" color={s.side === 'buy' ? 'red' : 'green'}>
                    {s.side === 'buy' ? '买入' : '卖出'}
                  </Tag>,
                  <Tag key="status">{s.status}</Tag>
                ]}
              >
                <span>
                  {s.code} × {s.qty} @ {s.refPrice}
                </span>
              </List.Item>
            )}
          />
        )}
      </Card>
    </div>
  )
}

// 消除未使用警告（message 保留给未来交互）
void message
