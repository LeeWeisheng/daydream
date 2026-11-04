/**
 * 设置页：账户信息（改名/删除）、模型信息（内置预设：baseURL/模型名/上下文等默认内置，
 * 仅需填 API Key）、主题、通知偏好。
 */
import { useEffect, useState } from 'react'
import { Button, Form, Input, InputNumber, Select, Switch, Space, Modal, Divider, message, Alert, Tag } from 'antd'
import { SaveOutlined, DeleteOutlined } from '@ant-design/icons'
import type { ModelConfig, ModelPreset, ThemeMode } from '@shared/types'
import { useAppStore } from '../stores'

interface SettingsData {
  modelConfig?: ModelConfig
  presets: ModelPreset[]
  theme: ThemeMode
  modelConfigured: boolean
  monitorIntervalMinutes?: number
  dataSourcePreference?: string
}

export default function Settings(): React.ReactNode {
  const { currentAccount, accounts, theme, setTheme, refreshAccounts } = useAppStore()
  const accountId = currentAccount?.id ?? ''
  const [data, setData] = useState<SettingsData | null>(null)
  const [modelForm, setModelForm] = useState<Partial<ModelConfig>>({})
  const [presetId, setPresetId] = useState<string>()
  const [customBaseUrl, setCustomBaseUrl] = useState(false)
  const [name, setName] = useState(currentAccount?.name ?? '')
  const [savingModel, setSavingModel] = useState(false)

  useEffect(() => {
    window.daydream.settings.get(accountId).then((s) => {
      setData(s)
      if (s.modelConfig) setModelForm(s.modelConfig)
    }).catch(() => undefined)
  }, [accountId])

  useEffect(() => {
    setName(currentAccount?.name ?? '')
  }, [currentAccount])

  const applyPreset = (id: string): void => {
    setPresetId(id)
    if (id === 'custom') {
      setCustomBaseUrl(true)
      return
    }
    setCustomBaseUrl(false)
    const p = data?.presets.find((x) => x.id === id)
    if (p) {
      setModelForm({
        ...modelForm,
        baseUrl: p.baseUrl,
        model: p.model,
        modelPro: p.modelPro,
        contextWindow: p.contextWindow,
        maxCallsPerHour: p.maxCallsPerHour
      })
    }
  }

  const saveModel = async (): Promise<void> => {
    if (!modelForm.baseUrl || !modelForm.apiKey || !modelForm.model) {
      message.warning('请填写 API 地址、API Key 与主模型')
      return
    }
    setSavingModel(true)
    try {
      await window.daydream.settings.update({
        modelConfig: {
          baseUrl: modelForm.baseUrl,
          apiKey: modelForm.apiKey,
          model: modelForm.model,
          modelPro: modelForm.modelPro,
          contextWindow: modelForm.contextWindow ?? 128000,
          maxCallsPerHour: modelForm.maxCallsPerHour ?? 100
        }
      })
      message.success('模型配置已保存（全局通用，加密存储）')
      const s = await window.daydream.settings.get(accountId)
      setData(s)
      if (s.modelConfig) setModelForm(s.modelConfig)
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setSavingModel(false)
    }
  }

  const renameAccount = async (): Promise<void> => {
    if (!name.trim()) {
      message.warning('账户名称不能为空')
      return
    }
    try {
      await window.daydream.accounts.rename({ accountId, name: name.trim() })
      message.success('账户名称已更新')
      void refreshAccounts()
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  const removeAccount = (): void => {
    Modal.confirm({
      title: '删除账户',
      content: `确认删除账户「${currentAccount?.name}」？其策略、资金、持仓、对话流将一并删除（行情数据全局共享不受影响）。`,
      okButtonProps: { danger: true },
      onOk: async () => {
        await window.daydream.accounts.remove(accountId)
        message.success('账户已删除')
        void refreshAccounts()
      }
    })
  }

  return (
    <div className="dd-page" style={{ maxWidth: 640 }}>
      <div className="dd-page-title">设置</div>

      {/* 账户信息 */}
      <div className="dd-panel" style={{ marginBottom: 16 }}>
        <div className="dd-section-title">账户信息</div>
        <Space>
          <Input value={name} onChange={(e) => setName(e.target.value)} style={{ width: 220 }} placeholder="账户名称" maxLength={32} />
          <Button onClick={renameAccount}>保存名称</Button>
          {accounts.length > 1 && (
            <Button danger icon={<DeleteOutlined />} onClick={removeAccount}>
              删除账户
            </Button>
          )}
        </Space>
        <div className="dd-muted" style={{ fontSize: 12, marginTop: 6 }}>
          本地账户（无需登录）：资金、持仓、信号、对话流按账户隔离；每账户唯一一份策略；模型与行情数据全局通用。
        </div>
      </div>

      {/* 模型信息 */}
      <div className="dd-panel" style={{ marginBottom: 16 }}>
        <div className="dd-section-title">模型信息（baseURL / 模型名 / 上下文等内置预设）</div>
        {data?.modelConfigured ? (
          <Alert type="success" showIcon message="模型已配置（全局通用）" style={{ marginBottom: 10 }} />
        ) : (
          <Alert type="warning" showIcon message="模型未配置：Agent 决策闭环不运行（数据/回测/资金功能不受影响）" style={{ marginBottom: 10 }} />
        )}
        <Form layout="vertical" size="small">
          <Form.Item label="服务商预设">
            <Select
              placeholder="选择预设（自动填充 baseURL / 模型名 / 上下文等）"
              value={presetId}
              onChange={applyPreset}
              options={[
                ...(data?.presets ?? []).map((p) => ({ value: p.id, label: `${p.name}（${p.model}）` })),
                { value: 'custom', label: '自定义（OpenAI/Anthropic 兼容）' }
              ]}
            />
          </Form.Item>
          <Form.Item label="API 地址（baseURL）" required>
            <Input value={modelForm.baseUrl} onChange={(e) => setModelForm({ ...modelForm, baseUrl: e.target.value })} disabled={!customBaseUrl} placeholder="https://api.deepseek.com/anthropic" />
          </Form.Item>
          <Form.Item label="API Key / Token" required>
            <Input.Password value={modelForm.apiKey} onChange={(e) => setModelForm({ ...modelForm, apiKey: e.target.value })} placeholder="加密存储，仅本机使用" />
          </Form.Item>
          <Space>
            <Form.Item label="主模型（评估/常规任务）" required>
              <Input value={modelForm.model} onChange={(e) => setModelForm({ ...modelForm, model: e.target.value })} style={{ width: 260 }} disabled={!customBaseUrl} />
            </Form.Item>
            <Form.Item label="重型任务模型（策略生成/复盘/纠正，可选）">
              <Input value={modelForm.modelPro} onChange={(e) => setModelForm({ ...modelForm, modelPro: e.target.value })} style={{ width: 260 }} disabled={!customBaseUrl} placeholder="留空则复用主模型" />
            </Form.Item>
          </Space>
          <Space>
            <Form.Item label="上下文长度">
              <InputNumber style={{ width: 120 }} min={1024} step={1024} value={modelForm.contextWindow} onChange={(v) => setModelForm({ ...modelForm, contextWindow: v ?? 128000 })} />
            </Form.Item>
            <Form.Item label="每小时调用上限">
              <InputNumber style={{ width: 100 }} min={1} value={modelForm.maxCallsPerHour} onChange={(v) => setModelForm({ ...modelForm, maxCallsPerHour: v ?? 100 })} />
            </Form.Item>
          </Space>
          <Button type="primary" icon={<SaveOutlined />} loading={savingModel} onClick={saveModel}>
            保存模型配置
          </Button>
        </Form>
        <div className="dd-muted" style={{ fontSize: 12, marginTop: 6 }}>
          内置预设：DeepSeek / OpenAI / Anthropic / Moonshot / 通义千问 / 智谱 / 硅基流动；选择后 baseURL 与模型名自动填充，仅需填写 API Key。
        </div>
      </div>

      {/* 主题与通知 */}
      <div className="dd-panel">
        <div className="dd-section-title">外观与偏好</div>
        <Form layout="vertical" size="small">
          <Form.Item label="主题">
            <Select
              style={{ width: 180 }}
              value={theme}
              onChange={(v) => setTheme(v)}
              options={[
                { value: 'light', label: '亮色' },
                { value: 'dark', label: '暗色' },
                { value: 'system', label: '系统' }
              ]}
            />
          </Form.Item>
          <Form.Item label="盯盘间隔（分钟）">
            <InputNumber style={{ width: 120 }} min={1} max={30} value={data?.monitorIntervalMinutes ?? 2} onChange={(v) => setData((d) => (d ? { ...d, monitorIntervalMinutes: v ?? 2 } : d))} />
          </Form.Item>
          <Button onClick={() => window.daydream.settings.update({ monitorIntervalMinutes: data?.monitorIntervalMinutes }).then(() => message.success('已保存')).catch((e) => message.error((e as Error).message))}>
            保存偏好
          </Button>
        </Form>
        <Divider style={{ margin: '12px 0' }} />
        <div className="dd-muted" style={{ fontSize: 12 }}>
          <Tag>提示</Tag>
          通知开关（信号/预警/摘要）在「策略 → 用户偏好 → 通知偏好」中配置。
        </div>
      </div>
    </div>
  )
}
