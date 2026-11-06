/**
 * 账户创建向导：无账户时必须先创建账户才能进入主界面。
 * 居中向导卡：品牌区 + 三项能力简介 + 账户名输入。
 */
import { useState } from 'react'
import { Button, Input, Space, Tag, Typography, message } from 'antd'
import { useAntdToken } from 'antd-style'
import { DatabaseOutlined, ExperimentOutlined, RobotOutlined, ArrowRightOutlined } from '@ant-design/icons'
import { useAppStore } from '../stores'

const FEATURES = [
  { icon: <DatabaseOutlined />, title: '行情数据', desc: '全市场日线增量入库' },
  { icon: <ExperimentOutlined />, title: '策略管理', desc: 'Markdown 策略文档注入 Agent' },
  { icon: <RobotOutlined />, title: 'AI 决策闭环', desc: '盘前规划 → 复盘纠正' }
]

export default function AccountSetup(): React.ReactNode {
  const { init } = useAppStore()
  const token = useAntdToken()
  const [name, setName] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const create = async (): Promise<void> => {
    if (!name.trim()) {
      message.warning('请输入账户名称')
      return
    }
    setSubmitting(true)
    try {
      await window.daydream.accounts.create({ name: name.trim() })
      message.success('账户已创建')
      await init()
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div
      style={{
        height: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        background: `radial-gradient(1000px 520px at 50% -10%, ${token.colorPrimaryBg}, transparent), ${token.colorBgLayout}`
      }}
    >
      <div
        className="dd-card"
        style={{
          width: '100%',
          maxWidth: 460,
          padding: '28px 28px 24px'
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
          <span
            style={{
              width: 30,
              height: 30,
              borderRadius: 9,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: `linear-gradient(135deg, ${token.colorPrimary}, ${token.colorPrimaryActive})`,
              color: '#fff',
              fontWeight: 700,
              fontSize: 15
            }}
          >
            D
          </span>
          <Typography.Title level={3} style={{ margin: 0, letterSpacing: 0.4 }}>
            Daydream
          </Typography.Title>
          <Tag color="blue" style={{ marginInlineStart: 'auto' }}>
            A 股 AI 量化
          </Tag>
        </div>
        <Typography.Paragraph type="secondary" style={{ fontSize: 12, lineHeight: 1.75, marginBottom: 18 }}>
          使用前需要先创建一个本地账户（无需登录）。账户用于隔离资金与持仓数据，每账户唯一一份策略；行情数据与模型配置为全局通用。
        </Typography.Paragraph>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginBottom: 20 }}>
          {FEATURES.map((f) => (
            <div
              key={f.title}
              style={{
                border: `1px solid ${token.colorBorderSecondary}`,
                borderRadius: 10,
                padding: '10px 10px 9px',
                display: 'flex',
                flexDirection: 'column',
                gap: 2,
                background: token.colorBgLayout
              }}
            >
              <span style={{ color: token.colorPrimary, fontSize: 15 }}>{f.icon}</span>
              <span style={{ fontSize: 12, fontWeight: 600 }}>{f.title}</span>
              <span style={{ fontSize: 11, color: token.colorTextTertiary, lineHeight: 1.5 }}>{f.desc}</span>
            </div>
          ))}
        </div>

        <Space.Compact style={{ width: '100%' }}>
          <Input
            placeholder="账户名称（如：实盘 A、研究账户）"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onPressEnter={create}
            size="large"
            maxLength={32}
            autoFocus
          />
          <Button type="primary" size="large" loading={submitting} onClick={create} icon={<ArrowRightOutlined />} iconPosition="end">
            创建账户
          </Button>
        </Space.Compact>
        <div style={{ marginTop: 10, fontSize: 11, color: token.colorTextTertiary, textAlign: 'center' }}>
          创建后可在顶部随时切换或新增账户；交易由人工在券商侧执行，本应用仅做决策辅助。
        </div>
      </div>
    </div>
  )
}
