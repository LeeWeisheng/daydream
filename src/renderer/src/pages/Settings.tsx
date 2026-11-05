/**
 * 设置页：账户信息（改名/删除）、模型信息（内置预设：baseURL/模型名/上下文等默认内置，
 * 仅需填 API Key）、外观与运行偏好。
 * 布局：账户 / 外观 双列，模型配置整行；危险操作单独成卡。
 */
import { useEffect, useMemo, useState } from 'react'
import { Alert, Button, Form, Input, InputNumber, Modal, Segmented, Select, Slider, Space, Switch, Tag, message } from 'antd'
import { useAntdToken } from 'antd-style'
import { DesktopOutlined, MoonOutlined, SaveOutlined, SunOutlined, DeleteOutlined, SettingOutlined } from '@ant-design/icons'
import type { ModelConfig, ModelPreset, ThemeMode } from '@shared/types'
import { useAppStore } from '../stores'
import AccountAvatar from '../components/AccountAvatar'
import PageHeader from '../components/PageHeader'
import Panel from '../components/Panel'
import { fmtDateTime } from '../lib/format'

interface SettingsData {
  modelConfig?: ModelConfig
  presets: ModelPreset[]
  theme: ThemeMode
  modelConfigured: boolean
  monitorIntervalMinutes?: number
  dataSourcePreference?: string
}

const THEME_OPTIONS = [
  { value: 'light', label: '亮色', icon: <SunOutlined /> },
  { value: 'dark', label: '暗色', icon: <MoonOutlined /> },
  { value: 'system', label: '跟随系统', icon: <DesktopOutlined /> }
]

export default function Settings(): React.ReactNode {
  const { currentAccount, accounts, theme, setTheme, refreshAccounts } = useAppStore()
  const token = useAntdToken()
  const accountId = currentAccount?.id ?? ''
  const [data, setData] = useState<SettingsData | null>(null)
  const [modelForm, setModelForm] = useState<Partial<ModelConfig>>({})
  const [modelSnapshot, setModelSnapshot] = useState('{}')
  const [presetId, setPresetId] = useState<string>()
  const [customBaseUrl, setCustomBaseUrl] = useState(false)
  const [name, setName] = useState(currentAccount?.name ?? '')
  const [savingModel, setSavingModel] = useState(false)
  const [monitorInterval, setMonitorInterval] = useState(2)
  const [monitorSnapshot, setMonitorSnapshot] = useState(2)
  const [savingMonitor, setSavingMonitor] = useState(false)

  const loadSettings = (): void => {
    window.daydream.settings
      .get(accountId)
      .then((s) => {
        setData(s)
        if (s.modelConfig) {
          setModelForm(s.modelConfig)
          // 反查内置预设：baseURL 一致即视为预设，避免重新选择
          const matched = s.presets.find((p) => p.baseUrl === s.modelConfig?.baseUrl)
          setPresetId(matched?.id ?? 'custom')
          setCustomBaseUrl(!matched)
        }
        // 快照始终对齐后端值，避免未编辑就提示“未保存”
        setModelSnapshot(JSON.stringify(s.modelConfig ?? {}))
        const interval = s.monitorIntervalMinutes ?? 2
        setMonitorInterval(interval)
        setMonitorSnapshot(interval)
      })
      .catch(() => undefined)
  }

  useEffect(() => {
    loadSettings()
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      loadSettings()
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
      okText: '删除',
      onOk: async () => {
        await window.daydream.accounts.remove(accountId)
        message.success('账户已删除')
        void refreshAccounts()
      }
    })
  }

  const saveMonitor = async (): Promise<void> => {
    setSavingMonitor(true)
    try {
      await window.daydream.settings.update({ monitorIntervalMinutes: monitorInterval })
      setMonitorSnapshot(monitorInterval)
      message.success('盯盘间隔已保存')
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setSavingMonitor(false)
    }
  }

  const modelDirty = useMemo(() => JSON.stringify(modelForm) !== modelSnapshot, [modelForm, modelSnapshot])
  const nameDirty = name.trim() !== (currentAccount?.name ?? '')
  const monitorDirty = monitorInterval !== monitorSnapshot

  return (
    <div className="dd-page">
      <PageHeader
        title="设置"
        description="账户数据按账户隔离；模型配置与行情数据全局通用，所有账户共用。"
      />

      <div className="dd-grid-2">
        {/* 账户信息 */}
        <Panel
          title="账户信息"
          subtitle={nameDirty ? '有未保存的修改' : undefined}
          extra={nameDirty ? <Tag color="orange" style={{ marginInlineEnd: 0 }}>未保存</Tag> : null}
        >
          <div className="dd-toolbar" style={{ marginBottom: 10 }}>
            <AccountAvatar name={currentAccount?.name ?? '账户'} size={40} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
              <span style={{ fontWeight: 600 }}>{currentAccount?.name ?? '—'}</span>
              <span className="dd-muted" style={{ fontSize: 12 }}>
                创建于 {fmtDateTime(currentAccount?.createdAt)}
              </span>
            </div>
          </div>
          <Space.Compact style={{ width: '100%' }}>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="账户名称" maxLength={32} onPressEnter={() => void renameAccount()} />
            <Button type="primary" disabled={!nameDirty} onClick={renameAccount}>
              保存名称
            </Button>
          </Space.Compact>
          <div className="dd-form-hint" style={{ marginTop: 8 }}>
            本地账户（无需登录）：资金、持仓、信号、对话流按账户隔离；每账户唯一一份策略。
          </div>
        </Panel>

        {/* 外观与运行偏好 */}
        <Panel title="外观与运行偏好" extra={<SettingOutlined style={{ color: token.colorTextTertiary }} />}>
          <Form layout="vertical" size="small">
            <Form.Item label="主题" style={{ marginBottom: 12 }}>
              <Segmented
                block
                value={theme}
                onChange={(v) => void setTheme(v as ThemeMode)}
                options={THEME_OPTIONS}
              />
            </Form.Item>
            <Form.Item label={`盘中盯盘间隔：${monitorInterval} 分钟`} style={{ marginBottom: 8 }}>
              <div className="dd-toolbar" style={{ gap: 12 }}>
                <Slider
                  style={{ flex: 1, minWidth: 120 }}
                  min={1}
                  max={30}
                  value={monitorInterval}
                  onChange={(v) => setMonitorInterval(v)}
                  marks={{ 1: '1', 5: '5', 15: '15', 30: '30' }}
                />
                <InputNumber min={1} max={30} value={monitorInterval} onChange={(v) => setMonitorInterval(v ?? 2)} style={{ width: 80 }} />
              </div>
            </Form.Item>
            <Button size="small" icon={<SaveOutlined />} loading={savingMonitor} disabled={!monitorDirty} onClick={saveMonitor}>
              保存运行偏好
            </Button>
          </Form>
          <div className="dd-form-hint" style={{ marginTop: 10 }}>
            <Tag>提示</Tag> 通知开关（信号 / 预警 / 摘要）在「策略 → 用户偏好 → 通知偏好」中配置。
          </div>
        </Panel>
      </div>

      {/* 模型信息 */}
      <Panel
        title="模型配置"
        subtitle="全局通用 · API Key 加密存储"
        extra={
          data?.modelConfigured ? (
            <Tag color="success" style={{ marginInlineEnd: 0 }}>
              已配置
            </Tag>
          ) : (
            <Tag color="warning" style={{ marginInlineEnd: 0 }}>
              未配置
            </Tag>
          )
        }
      >
        {data?.modelConfigured ? (
          <Alert type="success" showIcon message="模型已配置：Agent 决策闭环可正常运行。" style={{ marginBottom: 12 }} />
        ) : (
          <Alert type="warning" showIcon message="模型未配置：Agent 决策闭环不运行（数据 / 回测 / 资金功能不受影响）。" style={{ marginBottom: 12 }} />
        )}
        <Form layout="vertical" size="small">
          <div className="dd-form-grid">
            <Form.Item label="服务商预设" style={{ gridColumn: '1 / -1' }}>
              <Select
                placeholder="选择预设（自动填充 baseURL / 模型名 / 上下文等）"
                value={presetId}
                onChange={applyPreset}
                options={[
                  ...(data?.presets ?? []).map((p) => ({ value: p.id, label: `${p.name}（${p.model}）` })),
                  { value: 'custom', label: '自定义（OpenAI / Anthropic 兼容）' }
                ]}
              />
            </Form.Item>
            <Form.Item label="API 地址（baseURL）" required style={{ gridColumn: '1 / -1' }}>
              <Input
                value={modelForm.baseUrl}
                onChange={(e) => setModelForm({ ...modelForm, baseUrl: e.target.value })}
                disabled={!customBaseUrl}
                placeholder="https://api.deepseek.com/anthropic"
              />
            </Form.Item>
            <Form.Item label="API Key / Token" required>
              <Input.Password value={modelForm.apiKey} onChange={(e) => setModelForm({ ...modelForm, apiKey: e.target.value })} placeholder="加密存储，仅本机使用" />
            </Form.Item>
            <Form.Item label="主模型（评估 / 常规任务）" required>
              <Input value={modelForm.model} onChange={(e) => setModelForm({ ...modelForm, model: e.target.value })} disabled={!customBaseUrl} />
            </Form.Item>
            <Form.Item label="重型任务模型（策略生成 / 复盘 / 纠正）">
              <Input
                value={modelForm.modelPro}
                onChange={(e) => setModelForm({ ...modelForm, modelPro: e.target.value })}
                disabled={!customBaseUrl}
                placeholder="留空则复用主模型"
              />
            </Form.Item>
            <Form.Item label="上下文长度">
              <InputNumber
                style={{ width: '100%' }}
                min={1024}
                step={1024}
                value={modelForm.contextWindow}
                onChange={(v) => setModelForm({ ...modelForm, contextWindow: v ?? 128000 })}
              />
            </Form.Item>
            <Form.Item label="每小时调用上限">
              <InputNumber
                style={{ width: '100%' }}
                min={1}
                value={modelForm.maxCallsPerHour}
                onChange={(v) => setModelForm({ ...modelForm, maxCallsPerHour: v ?? 100 })}
              />
            </Form.Item>
            <Form.Item label="自定义 baseURL（非预设地址）">
              <Switch checked={customBaseUrl} onChange={(v) => setCustomBaseUrl(v)} checkedChildren="自定义" unCheckedChildren="预设" />
            </Form.Item>
          </div>
          <div className="dd-toolbar">
            <Button type="primary" icon={<SaveOutlined />} loading={savingModel} onClick={saveModel}>
              保存模型配置
            </Button>
            <Button onClick={loadSettings}>重置</Button>
            {modelDirty ? <Tag color="orange" style={{ marginInlineEnd: 0 }}>未保存</Tag> : null}
          </div>
        </Form>
        <div className="dd-form-hint" style={{ marginTop: 10 }}>
          内置预设：DeepSeek / OpenAI / Anthropic / Moonshot / 通义千问 / 智谱 / 硅基流动；选择后 baseURL 与模型名自动填充，仅需填写 API Key。
        </div>
      </Panel>

      {/* 危险操作 */}
      {accounts.length > 1 ? (
        <Panel title="危险操作" subtitle="不可撤销">
          <div className="dd-row">
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: 13 }}>删除当前账户</div>
              <div className="dd-form-hint">删除后该账户的策略、资金、持仓、信号与对话流一并移除，行情数据不受影响。</div>
            </div>
            <Button danger icon={<DeleteOutlined />} onClick={removeAccount}>
              删除账户
            </Button>
          </div>
        </Panel>
      ) : null}
    </div>
  )
}
