/**
 * 账户创建向导：无账户时必须先创建账户才能进入主界面。
 */
import { useState } from 'react'
import { Card, Input, Button, Typography, message } from 'antd'
import { useAppStore } from '../stores'

export default function AccountSetup(): React.ReactNode {
  const { init } = useAppStore()
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
        background: '#0f1115'
      }}
    >
      <Card style={{ width: 420 }} title="欢迎使用 Daydream">
        <Typography.Paragraph type="secondary">
          使用前需要先创建一个本地账户（无需登录）。账户用于隔离资金与持仓数据；行情数据、策略与模型配置为全局通用。
        </Typography.Paragraph>
        <Input
          placeholder="账户名称（如：实盘 A、研究账户）"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onPressEnter={create}
          size="large"
          maxLength={32}
        />
        <Button
          type="primary"
          size="large"
          block
          style={{ marginTop: 16 }}
          onClick={create}
          loading={submitting}
        >
          创建账户并进入
        </Button>
      </Card>
    </div>
  )
}
