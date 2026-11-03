/**
 * 待决策中心：全部 need_decision 汇报流（批准/驳回/暂缓）、历史决策记录。
 * 用户决策经 user.message 事件语义回流闭环（report.respond 驱动工作项继续/终止）。
 */
import { useEffect, useState } from 'react'
import { Card, List, Tag, Button, Space, Empty, Input, Modal, message } from 'antd'
import type { Report } from '@shared/types'
import { useAppStore } from '../stores'

const LEVEL_TAG: Record<string, { color: string; label: string }> = {
  need_decision: { color: 'orange', label: '待决策' },
  result: { color: 'blue', label: '结果' },
  summary: { color: 'default', label: '摘要' },
  silent: { color: 'default', label: '静默' }
}

export default function Decisions(): React.ReactNode {
  const { currentAccount, lastEvent } = useAppStore()
  const [reports, setReports] = useState<Report[]>([])
  const [note, setNote] = useState('')
  const [modalReport, setModalReport] = useState<Report | null>(null)
  const accountId = currentAccount?.id ?? ''

  useEffect(() => {
    if (!accountId) return
    window.daydream.reports.list(accountId).then(setReports).catch(() => undefined)
  }, [accountId, lastEvent])

  const respond = async (report: Report, decision: 'approved' | 'rejected' | 'postponed'): Promise<void> => {
    try {
      await window.daydream.reports.respond({ reportId: report.id, decision, note })
      message.success('已提交决策')
      setModalReport(null)
      setNote('')
      window.daydream.reports.list(accountId).then(setReports).catch(() => undefined)
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  const pending = reports.filter((r) => r.status === 'pending' && r.level === 'need_decision')
  const history = reports.filter((r) => !(r.status === 'pending' && r.level === 'need_decision'))

  return (
    <div>
      <Card title="待决策事项">
        {pending.length === 0 ? (
          <Empty description="暂无待决策事项" />
        ) : (
          <List
            dataSource={pending}
            renderItem={(r) => (
              <List.Item
                actions={[
                  <Button key="approve" size="small" type="primary" onClick={() => respond(r, 'approved')}>
                    批准
                  </Button>,
                  <Button key="postpone" size="small" onClick={() => setModalReport(r)}>
                    暂缓/备注
                  </Button>,
                  <Button key="reject" size="small" danger onClick={() => respond(r, 'rejected')}>
                    驳回
                  </Button>
                ]}
              >
                <List.Item.Meta
                  title={
                    <span>
                      {r.title} <Tag color={LEVEL_TAG[r.level]?.color}>{LEVEL_TAG[r.level]?.label}</Tag>
                    </span>
                  }
                  description={r.summary}
                />
              </List.Item>
            )}
          />
        )}
      </Card>
      <Card title="历史决策记录" style={{ marginTop: 16 }}>
        <List
          size="small"
          dataSource={history.slice(0, 100)}
          renderItem={(r) => (
            <List.Item
              actions={[
                <Tag key="status" color={r.status === 'approved' ? 'green' : r.status === 'rejected' ? 'red' : 'default'}>
                  {r.status}
                </Tag>
              ]}
            >
              <span>
                {r.title} <span style={{ color: '#8c93a3', fontSize: 12 }}>{r.createdAt.slice(0, 16).replace('T', ' ')}</span>
              </span>
            </List.Item>
          )}
        />
      </Card>
      <Modal
        title="暂缓并备注"
        open={!!modalReport}
        onOk={() => modalReport && respond(modalReport, 'postponed')}
        onCancel={() => setModalReport(null)}
      >
        <Input.TextArea rows={3} placeholder="备注（可选）" value={note} onChange={(e) => setNote(e.target.value)} />
      </Modal>
    </div>
  )
}

void Space
