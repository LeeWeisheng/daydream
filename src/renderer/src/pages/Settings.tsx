/**
 * 设置页：账户管理（新增/切换/删除）、模型配置、数据源配置、
 * 风控规则、Agent 自主级别、通知偏好、数据初始化与日志导出。
 */
import { useEffect, useState } from 'react'
import { Card, Form, Input, Select, Button, Space, Divider, message, Progress, Modal, Popconfirm, Alert, Table, Tag } from 'antd'
import type { ModelConfig } from '@shared/types'
import { useAppStore } from '../stores'

const DS = `{
  "meta": { "name": "双均线动量", "description": "示例策略", "rationale": "5 日线上穿 20 日线且放量买入", "complexity": 2 },
  "universe": { "source": "all_a", "filters": [
    { "op": "exclude_st" },
    { "op": "liquidity_min", "params": { "amount": 100000000, "days": 20 } }
  ]},
  "entry": { "logic": "and", "conditions": [
    { "indicator": "ma_cross_up", "params": { "fast": 5, "slow": 20 } },
    { "indicator": "volume_ratio_gt", "params": { "ratio": 1.5, "n": 20 } }
  ]},
  "exit": { "logic": "or", "conditions": [
    { "indicator": "ma_cross_down", "params": { "fast": 5, "slow": 20 } },
    { "indicator": "stop_loss", "params": { "pct": 0.08 } }
  ]},
  "portfolio": { "max_positions": 5, "position_size": "equal_weight", "max_position_pct": 0.2, "rebalance": "daily" }
}`

export default function Settings(): React.ReactNode {
  const { accounts, currentAccount, init, switchAccount } = useAppStore()
  const [modelForm] = Form.useForm<ModelConfig>()
  const [autonomy, setAutonomy] = useState<string>('conservative')
  const [progress, setProgress] = useState<{ done: number; total: number; message: string } | null>(null)
  const [syncing, setSyncing] = useState(false)
  const accountId = currentAccount?.id ?? ''

  useEffect(() => {
    if (!accountId) return
    window.daydream.settings.get(accountId).then((s) => {
      if (s.modelConfig) modelForm.setFieldsValue(s.modelConfig)
      setAutonomy(s.autonomyLevel ?? 'conservative')
    })
    window.daydream.onEvent((ev) => {
      if (ev.type === 'data.progress') setProgress(ev.payload as { done: number; total: number; message: string })
    })
  }, [accountId, modelForm])

  const saveModel = async (values: ModelConfig): Promise<void> => {
    if (!accountId) return
    await window.daydream.settings.update(accountId, { modelConfig: values })
    message.success('模型配置已保存（加密存储）')
  }

  const saveAutonomy = async (level: string): Promise<void> => {
    if (!accountId) return
    await window.daydream.settings.update(accountId, { autonomyLevel: level as never })
    setAutonomy(level)
    message.success('自主级别已更新')
  }

  const startSync = async (): Promise<void> => {
    setSyncing(true)
    try {
      await window.daydream.data.initialSync()
      message.success('数据初始化已启动（约 30~60 分钟，可最小化窗口）')
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setSyncing(false)
    }
  }

  const createAccount = async (): Promise<void> => {
    const account = await window.daydream.accounts.create({ name: '新账户' })
    message.success('账户已创建')
    await init()
    await switchAccount(account.id)
  }

  return (
    <div style={{ maxWidth: 860 }}>
      <Card title="数据源与初始化">
        <Alert type="info" showIcon message="行情数据来自公开接口（东方财富/腾讯，自动降级），仅供个人研究使用。首次使用请先初始化数据。" style={{ marginBottom: 12 }} />
        <Space>
          <Button type="primary" onClick={startSync} loading={syncing}>
            初始化全市场数据（近 3 年日线）
          </Button>
          <Button
            onClick={async () => {
              await window.daydream.data.dailyUpdate()
              message.success('增量更新已启动')
            }}
          >
            立即增量更新
          </Button>
        </Space>
        {progress && (
          <Progress
            style={{ marginTop: 12 }}
            percent={progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0}
            status="active"
            format={() => `${progress.message} ${progress.done}/${progress.total}`}
          />
        )}
      </Card>

      <Card title="模型配置（Anthropic 兼容接口 · 全局通用）" style={{ marginTop: 16 }}>
        <Form form={modelForm} layout="vertical" onFinish={saveModel} initialValues={{ baseUrl: 'https://api.deepseek.com/anthropic', model: 'deepseek-chat' }}>
          <Form.Item name="baseUrl" label="API 地址" rules={[{ required: true }]}>
            <Input placeholder="https://api.deepseek.com/anthropic" />
          </Form.Item>
          <Form.Item name="apiKey" label="API Key" rules={[{ required: true }]}>
            <Input.Password placeholder="sk-…（加密存储，仅本机使用）" />
          </Form.Item>
          <Form.Item name="model" label="主模型" rules={[{ required: true }]}>
            <Input placeholder="deepseek-flash" />
          </Form.Item>
          <Form.Item name="modelPro" label="重型任务模型（策略生成/复盘/纠正，可选）">
            <Input placeholder="deepseek-v4-pro（留空则复用主模型）" />
          </Form.Item>
          <Button type="primary" htmlType="submit">
            保存模型配置
          </Button>
        </Form>
        <Divider />
        <div>
          说明：模型配置为全局通用（所有账户共用），兼容 DeepSeek Anthropic 端点 / Claude 等；所有调用统计入审计，密钥加密存储不回传。
        </div>
      </Card>

      <Card title="Agent 自主级别" style={{ marginTop: 16 }}>
        <Select value={autonomy} onChange={saveAutonomy} style={{ width: 300 }}>
          <Select.Option value="conservative">保守（默认）：上线/淘汰均需批准，信号需确认</Select.Option>
          <Select.Option value="standard">标准：上线需批准，淘汰自动，信号自动推送</Select.Option>
          <Select.Option value="aggressive">激进：上线/淘汰全自动，仅异常时汇报</Select.Option>
        </Select>
        <div style={{ color: '#8c93a3', fontSize: 12, marginTop: 8 }}>任何级别下系统都不执行真实交易，级别只影响建议的产出与流转效率。</div>
      </Card>

      <Card title="账户管理（本地工作区，无登录）" style={{ marginTop: 16 }}>
        <Space style={{ marginBottom: 12 }}>
          <Button onClick={createAccount}>新增账户</Button>
        </Space>
        <Table
          size="small"
          rowKey="id"
          dataSource={accounts}
          pagination={false}
          columns={[
            { title: '名称', dataIndex: 'name' },
            {
              title: '自主级别',
              dataIndex: 'autonomyLevel',
              render: (v: string) => <Tag>{v}</Tag>
            },
            {
              title: '操作',
              render: (_, record) => (
                <Space>
                  {currentAccount?.id !== record.id && <Button size="small" onClick={() => switchAccount(record.id)}>切换</Button>}
                  {accounts.length > 1 && (
                    <Popconfirm title="删除账户将移除其全部配置与数据，确认？" onConfirm={async () => {
                      await window.daydream.accounts.remove(record.id)
                      await init()
                      message.success('已删除')
                    }}>
                      <Button size="small" danger>删除</Button>
                    </Popconfirm>
                  )}
                </Space>
              )
            }
          ]}
        />
      </Card>
    </div>
  )
}
