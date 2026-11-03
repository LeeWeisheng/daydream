/**
 * 模型配置模态框：进入主界面后强制配置模型（全局通用，所有账户共用）。
 * 未配置时不可关闭（closable=false, maskClosable=false）。
 */
import { useEffect, useState } from 'react'
import { Modal, Form, Input, Alert, message } from 'antd'
import type { ModelConfig } from '@shared/types'

export default function ModelConfigModal(): React.ReactNode {
  const [open, setOpen] = useState(false)
  const [modelConfigured, setModelConfigured] = useState(true)
  const [form] = Form.useForm<ModelConfig>()
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    const check = (): void => {
      window.daydream.settings
        .get('global')
        .then((s) => {
          setModelConfigured(s.modelConfigured)
          if (!s.modelConfigured) {
            setOpen(true)
            if (s.modelConfig) form.setFieldsValue(s.modelConfig)
          }
        })
        .catch(() => undefined)
    }
    check()
    // 保存后由父级刷新触发重查；这里仅初始检查一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form])

  const save = async (values: ModelConfig): Promise<void> => {
    setSubmitting(true)
    try {
      await window.daydream.settings.update('global', { modelConfig: values })
      message.success('模型配置已保存（全局通用，加密存储）')
      setOpen(false)
      setModelConfigured(true)
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal
      title="配置模型（必填）"
      open={open}
      closable={false}
      maskClosable={false}
      keyboard={false}
      okText="保存并开始"
      cancelButtonProps={{ style: { display: 'none' } }}
      onOk={() => form.submit()}
      confirmLoading={submitting}
      width={520}
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="模型配置为全局通用（所有账户共用）；支持 Anthropic 兼容 API（Claude / DeepSeek anthropic 端点等）。"
      />
      <Form form={form} layout="vertical" onFinish={save} initialValues={{ baseUrl: 'https://api.deepseek.com/anthropic', model: 'deepseek-flash', modelPro: '', contextWindow: 128000, maxCallsPerHour: 100 }}>
        <Form.Item name="baseUrl" label="API 地址（Anthropic 兼容）" rules={[{ required: true, message: '请填写 API 地址' }]}>
          <Input placeholder="https://api.deepseek.com/anthropic" />
        </Form.Item>
        <Form.Item name="apiKey" label="API Key" rules={[{ required: true, message: '请填写 API Key' }]}>
          <Input.Password placeholder="sk-…（加密存储，仅本机使用）" />
        </Form.Item>
        <Form.Item name="model" label="主模型（评估/常规任务）" rules={[{ required: true, message: '请填写模型名' }]}>
          <Input placeholder="deepseek-flash" />
        </Form.Item>
        <Form.Item name="modelPro" label="重型任务模型（策略生成/复盘/纠正，可选）">
          <Input placeholder="deepseek-v4-pro（留空则复用主模型）" />
        </Form.Item>
      </Form>
      <div style={{ color: '#8c93a3', fontSize: 12 }}>
        说明：模型未配置时 Agent 决策闭环不运行（数据与回测功能不受影响）；API Key 加密存储，调用统计入审计。
      </div>
    </Modal>
  )
}
