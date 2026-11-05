/**
 * 模型配置模态框：进入主界面后强制配置模型（全局通用，所有账户共用）。
 * 未配置时不可关闭（closable=false, maskClosable=false）。
 * 内置服务商预设：选择后 baseURL / 模型名 / 上下文等自动填充，仅需填 API Key。
 */
import { useEffect, useState } from 'react'
import { Modal, Form, Input, InputNumber, Select, Alert, message } from 'antd'
import type { ModelConfig, ModelPreset } from '@shared/types'

interface FormValues {
  baseUrl: string
  apiKey: string
  model: string
  modelPro?: string
  contextWindow: number
  maxCallsPerHour: number
}

export default function ModelConfigModal(): React.ReactNode {
  const [open, setOpen] = useState(false)
  const [presets, setPresets] = useState<ModelPreset[]>([])
  const [presetId, setPresetId] = useState<string>()
  const [custom, setCustom] = useState(false)
  const [form] = Form.useForm<FormValues>()
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    const check = (): void => {
      window.daydream.settings
        .get('global')
        .then((s) => {
          setPresets(s.presets)
          if (!s.modelConfigured) {
            setOpen(true)
            const cfg = s.modelConfig
            form.setFieldsValue({
              baseUrl: cfg?.baseUrl ?? s.presets[0]?.baseUrl ?? '',
              apiKey: cfg?.apiKey ?? '',
              model: cfg?.model ?? s.presets[0]?.model ?? '',
              modelPro: cfg?.modelPro ?? s.presets[0]?.modelPro ?? '',
              contextWindow: cfg?.contextWindow ?? s.presets[0]?.contextWindow ?? 128000,
              maxCallsPerHour: cfg?.maxCallsPerHour ?? s.presets[0]?.maxCallsPerHour ?? 100
            })
          }
        })
        .catch(() => undefined)
    }
    check()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form])

  const applyPreset = (id: string): void => {
    setPresetId(id)
    if (id === 'custom') {
      setCustom(true)
      return
    }
    setCustom(false)
    const p = presets.find((x) => x.id === id)
    if (p) {
      form.setFieldsValue({
        baseUrl: p.baseUrl,
        model: p.model,
        modelPro: p.modelPro,
        contextWindow: p.contextWindow,
        maxCallsPerHour: p.maxCallsPerHour
      })
    }
  }

  const save = async (values: FormValues): Promise<void> => {
    setSubmitting(true)
    try {
      await window.daydream.settings.update({
        modelConfig: {
          baseUrl: values.baseUrl,
          apiKey: values.apiKey,
          model: values.model,
          modelPro: values.modelPro,
          contextWindow: values.contextWindow,
          maxCallsPerHour: values.maxCallsPerHour
        }
      })
      message.success('模型配置已保存（全局通用，加密存储）')
      setOpen(false)
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
      width={560}
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 14 }}
        message="模型配置为全局通用（所有账户共用）；内置服务商预设（DeepSeek / OpenAI / Anthropic 等），baseURL 与模型名自动填充，仅需填写 API Key。"
      />
      <Form form={form} layout="vertical" onFinish={save}>
        <Form.Item label="服务商预设" style={{ marginBottom: 12 }}>
          <Select
            placeholder="选择预设（自动填充 baseURL / 模型名 / 上下文等）"
            value={presetId}
            onChange={applyPreset}
            options={[...presets.map((p) => ({ value: p.id, label: `${p.name}（${p.model}）` })), { value: 'custom', label: '自定义（OpenAI / Anthropic 兼容）' }]}
          />
        </Form.Item>
        <div className="dd-form-grid" style={{ rowGap: 0 }}>
          <Form.Item name="baseUrl" label="API 地址（baseURL）" rules={[{ required: true, message: '请填写 API 地址' }]} style={{ gridColumn: '1 / -1' }}>
            <Input placeholder="https://api.deepseek.com/anthropic" disabled={!custom} />
          </Form.Item>
          <Form.Item name="apiKey" label="API Key / Token" rules={[{ required: true, message: '请填写 API Key' }]} style={{ gridColumn: '1 / -1' }}>
            <Input.Password placeholder="加密存储，仅本机使用" />
          </Form.Item>
          <Form.Item name="model" label="主模型（评估 / 常规任务）" rules={[{ required: true, message: '请填写模型名' }]}>
            <Input placeholder="deepseek-chat" disabled={!custom} />
          </Form.Item>
          <Form.Item name="modelPro" label="重型任务模型（可选）">
            <Input placeholder="留空则复用主模型" disabled={!custom} />
          </Form.Item>
          <Form.Item name="contextWindow" label="上下文长度">
            <InputNumber style={{ width: '100%' }} min={1024} step={1024} />
          </Form.Item>
          <Form.Item name="maxCallsPerHour" label="每小时调用上限">
            <InputNumber style={{ width: '100%' }} min={1} />
          </Form.Item>
        </div>
      </Form>
      <div className="dd-form-hint">
        说明：模型未配置时 Agent 决策闭环不运行（数据 / 回测 / 资金功能不受影响）；API Key 加密存储，调用统计入审计。选择预设后也可直接微调上下文与限流参数。
      </div>
    </Modal>
  )
}
