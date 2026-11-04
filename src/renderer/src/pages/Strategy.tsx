/**
 * 策略页：每账户唯一一份策略 = Markdown 策略文档 + 用户偏好。
 * 文档可预览（渲染）与编辑（用户 / Agent 均可修改，新版本留档）；
 * 文档内嵌 ```dsl 代码块为可执行部分（同步执行层，供自动运行/回测消费）。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button, Form, Input, InputNumber, Select, Radio, Switch, Tag, Modal, message, Timeline, Space, Tooltip, Alert, Segmented } from 'antd'
import { SaveOutlined, RocketOutlined, StopOutlined, HistoryOutlined, EditOutlined, EyeOutlined } from '@ant-design/icons'
import ReactMarkdown from 'react-markdown'
import { DEFAULT_PREFERENCES } from '@shared/constants'
import type { Strategy, StrategyPreferences, StrategyVersion } from '@shared/types'
import { useAppStore } from '../stores'

const STATUS_LABEL: Record<string, { color: string; label: string }> = {
  draft: { color: 'default', label: '草稿' },
  backtesting: { color: 'processing', label: '回测中' },
  pending_approval: { color: 'orange', label: '待批准' },
  active: { color: 'success', label: '运行中' },
  paused: { color: 'warning', label: '已暂停' },
  deactivated: { color: 'default', label: '已停用' }
}

function emptyPrefs(): StrategyPreferences {
  return JSON.parse(JSON.stringify(DEFAULT_PREFERENCES)) as StrategyPreferences
}

export default function StrategyPage(): React.ReactNode {
  const { currentAccount, eventSeq } = useAppStore()
  const accountId = currentAccount?.id ?? ''
  const [strategy, setStrategy] = useState<Strategy | null>(null)
  const [prefs, setPrefs] = useState<StrategyPreferences>(emptyPrefs())
  const [versions, setVersions] = useState<StrategyVersion[]>([])
  const [backtest, setBacktest] = useState<Record<string, unknown> | null>(null)
  // 文档编辑状态
  const [mode, setMode] = useState<'preview' | 'edit'>('preview')
  const [mdDraft, setMdDraft] = useState('')
  const [nameDraft, setNameDraft] = useState('')
  const [saving, setSaving] = useState(false)
  // 版本预览弹窗
  const [previewVersion, setPreviewVersion] = useState<StrategyVersion | null>(null)

  const refresh = useCallback(async () => {
    if (!accountId) return
    const s = await window.daydream.strategy.getForAccount(accountId).catch(() => null)
    setStrategy(s)
    if (s) {
      try {
        setPrefs(JSON.parse(s.preferencesJson) as StrategyPreferences)
      } catch {
        setPrefs(emptyPrefs())
      }
      setMdDraft(s.markdown)
      setNameDraft(s.name)
      window.daydream.strategy.getVersions(s.id).then(setVersions).catch(() => undefined)
      window.daydream.strategy.getLatestBacktest(accountId).then(setBacktest).catch(() => undefined)
    }
  }, [accountId])

  useEffect(() => {
    void refresh()
  }, [refresh, eventSeq])

  /** 文档是否含可执行 ```dsl 块（由执行层 dsl_json 是否为空判断） */
  const executable = Boolean(strategy?.dslJson?.trim())

  const savePrefs = async (): Promise<void> => {
    if (!strategy) return
    try {
      await window.daydream.strategy.save({ accountId, preferencesJson: JSON.stringify(prefs), actor: 'user' })
      message.success('用户偏好已保存（即时生效）')
      void refresh()
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  const saveMarkdown = async (): Promise<void> => {
    if (!strategy) return
    if (!mdDraft.trim()) {
      message.warning('策略文档不能为空')
      return
    }
    setSaving(true)
    try {
      await window.daydream.strategy.save({ accountId, markdown: mdDraft, name: nameDraft.trim() || strategy.name, changeLog: '用户修改', actor: 'user' })
      message.success('策略文档已保存（生成新版本）')
      setMode('preview')
      void refresh()
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const toggleActive = async (): Promise<void> => {
    if (!strategy) return
    try {
      if (strategy.status === 'active' || strategy.status === 'paused') {
        await window.daydream.strategy.deactivate(accountId)
        message.success('已提交停用（按自主级别需人工批准）')
      } else {
        await window.daydream.strategy.activate(accountId)
        message.success('已提交上线（按自主级别需人工批准）')
      }
      void refresh()
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  const rollback = async (versionId: string): Promise<void> => {
    try {
      await window.daydream.strategy.rollback(accountId, versionId)
      message.success('已回滚到所选版本')
      setPreviewVersion(null)
      void refresh()
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  const backtestMetrics = useMemo(() => {
    try {
      return backtest?.metrics_json ? (JSON.parse(String(backtest.metrics_json)) as Record<string, number>) : null
    } catch {
      return null
    }
  }, [backtest])

  if (!strategy) {
    return (
      <Alert
        type="warning"
        showIcon
        message="当前账户尚无策略"
        description="正常情况下每个账户会自动播种一份默认策略；如缺失请重启应用恢复。"
      />
    )
  }

  return (
    <div className="dd-page">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <Space>
          <span className="dd-page-title" style={{ marginBottom: 0 }}>
            策略
          </span>
          <Tag color={STATUS_LABEL[strategy.status]?.color ?? 'default'}>{STATUS_LABEL[strategy.status]?.label ?? strategy.status}</Tag>
          <span className="dd-muted">v{strategy.version}</span>
        </Space>
        <Space>
          <Button
            size="small"
            icon={strategy.status === 'active' || strategy.status === 'paused' ? <StopOutlined /> : <RocketOutlined />}
            danger={strategy.status === 'active'}
            onClick={toggleActive}
          >
            {strategy.status === 'active' || strategy.status === 'paused' ? '停用' : '激活'}
          </Button>
          <Button size="small" icon={<HistoryOutlined />}>
            版本历史
          </Button>
        </Space>
      </div>

      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
        {/* 左：用户偏好 */}
        <div className="dd-panel" style={{ width: 360, flex: 'none' }}>
          <div className="dd-section-title" style={{ marginBottom: 10 }}>
            用户偏好（仅您可修改，即时生效）
          </div>
          <Form layout="vertical" size="small">
            <Form.Item label="风险偏好">
              <Select
                value={prefs.riskTolerance}
                onChange={(v) => setPrefs({ ...prefs, riskTolerance: v })}
                options={[
                  { value: 'conservative', label: '保守' },
                  { value: 'moderate', label: '稳健' },
                  { value: 'aggressive', label: '激进' }
                ]}
              />
            </Form.Item>
            <Form.Item label="投资风格">
              <Select
                value={prefs.investmentStyle}
                onChange={(v) => setPrefs({ ...prefs, investmentStyle: v })}
                options={[
                  { value: 'value', label: '价值投资' },
                  { value: 'growth', label: '成长投资' },
                  { value: 'trend', label: '趋势跟踪' },
                  { value: 'blend', label: '均衡配置' }
                ]}
              />
            </Form.Item>
            <Form.Item label="期望年化收益">
              <InputNumber style={{ width: '100%' }} min={0} max={10} step={0.01} value={prefs.expectedAnnualReturn} onChange={(v) => setPrefs({ ...prefs, expectedAnnualReturn: v ?? 0.15 })} />
            </Form.Item>
            <Form.Item label="最大可承受回撤">
              <InputNumber style={{ width: '100%' }} min={0.01} max={0.9} step={0.01} value={prefs.maxDrawdownTolerance} onChange={(v) => setPrefs({ ...prefs, maxDrawdownTolerance: v ?? 0.15 })} />
            </Form.Item>
            <Form.Item label="持股周期">
              <Radio.Group value={prefs.holdingPeriod} onChange={(e) => setPrefs({ ...prefs, holdingPeriod: e.target.value })}>
                <Radio.Button value="short">短线</Radio.Button>
                <Radio.Button value="swing">波段</Radio.Button>
                <Radio.Button value="long">中长线</Radio.Button>
              </Radio.Group>
            </Form.Item>
            <Form.Item label="偏好行业">
              <Select mode="tags" value={prefs.preferredIndustries} onChange={(v) => setPrefs({ ...prefs, preferredIndustries: v })} placeholder="输入后回车" open={false} suffixIcon={null} />
            </Form.Item>
            <Form.Item label="排除行业">
              <Select mode="tags" value={prefs.excludedIndustries} onChange={(v) => setPrefs({ ...prefs, excludedIndustries: v })} placeholder="输入后回车" open={false} suffixIcon={null} />
            </Form.Item>
            <Form.Item label="最大持仓数 / 单票仓位上限">
              <Space>
                <InputNumber style={{ width: 100 }} min={1} max={50} value={prefs.maxPositions} onChange={(v) => setPrefs({ ...prefs, maxPositions: v ?? 5 })} />
                <InputNumber style={{ width: 110 }} min={0.01} max={1} step={0.05} value={prefs.maxPositionPct} onChange={(v) => setPrefs({ ...prefs, maxPositionPct: v ?? 0.2 })} />
              </Space>
            </Form.Item>
            <Form.Item label="总仓位上限 / 交易频率">
              <Space>
                <InputNumber style={{ width: 100 }} min={0.01} max={1} step={0.05} value={prefs.maxTotalPositionPct} onChange={(v) => setPrefs({ ...prefs, maxTotalPositionPct: v ?? 0.8 })} />
                <Select
                  style={{ width: 110 }}
                  value={prefs.tradeFrequency}
                  onChange={(v) => setPrefs({ ...prefs, tradeFrequency: v })}
                  options={[
                    { value: 'low', label: '低频' },
                    { value: 'medium', label: '中频' },
                    { value: 'high', label: '高频' }
                  ]}
                />
              </Space>
            </Form.Item>
            <Form.Item label="自主级别">
              <Select
                value={prefs.autonomyLevel}
                onChange={(v) => setPrefs({ ...prefs, autonomyLevel: v })}
                options={[
                  { value: 'conservative', label: '保守（上线/淘汰需批准）' },
                  { value: 'standard', label: '标准（淘汰自动）' },
                  { value: 'aggressive', label: '激进（全自动）' }
                ]}
              />
            </Form.Item>
            <Form.Item label="通知偏好">
              <Space direction="vertical" size={4}>
                <Switch size="small" checked={prefs.notify.signals} onChange={(v) => setPrefs({ ...prefs, notify: { ...prefs.notify, signals: v } })} checkedChildren="信号通知" unCheckedChildren="信号通知" />
                <Switch size="small" checked={prefs.notify.alerts} onChange={(v) => setPrefs({ ...prefs, notify: { ...prefs.notify, alerts: v } })} checkedChildren="预警通知" unCheckedChildren="预警通知" />
                <Switch size="small" checked={prefs.notify.summaries} onChange={(v) => setPrefs({ ...prefs, notify: { ...prefs.notify, summaries: v } })} checkedChildren="摘要通知" unCheckedChildren="摘要通知" />
                <span className="dd-muted" style={{ fontSize: 12 }}>
                  静默时段 {prefs.notify.quietHours}
                </span>
              </Space>
            </Form.Item>
            <Button type="primary" block icon={<SaveOutlined />} onClick={savePrefs}>
              保存用户偏好
            </Button>
          </Form>
        </div>

        {/* 右：策略文档（Markdown 预览 / 编辑） */}
        <div className="dd-panel" style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, flexWrap: 'wrap', gap: 8 }}>
            <Space>
              <div className="dd-section-title" style={{ marginBottom: 0 }}>
                策略文档（Markdown）
              </div>
              <Tooltip title={executable ? '含 ```dsl 代码块，自动运行与回测按此执行' : '无 ```dsl 代码块，仅文档态，不参与自动运行'}>
                <Tag color={executable ? 'success' : 'default'} style={{ cursor: 'help' }}>
                  {executable ? '可执行' : '文档态'}
                </Tag>
              </Tooltip>
            </Space>
            <Space>
              <Segmented
                size="small"
                value={mode}
                onChange={(v) => setMode(v as 'preview' | 'edit')}
                options={[
                  { value: 'preview', label: '预览', icon: <EyeOutlined /> },
                  { value: 'edit', label: '编辑', icon: <EditOutlined /> }
                ]}
              />
              <Button size="small" type="primary" icon={<SaveOutlined />} loading={saving} onClick={saveMarkdown} disabled={mode === 'preview'}>
                保存（生成新版本）
              </Button>
            </Space>
          </div>

          {mode === 'preview' ? (
            <div className="dd-markdown" style={{ maxHeight: 'calc(100vh - 340px)', overflow: 'auto', paddingRight: 4 }}>
              <ReactMarkdown>{strategy.markdown || '（策略文档为空，点击「编辑」开始编写）'}</ReactMarkdown>
            </div>
          ) : (
            <>
              <Input
                size="small"
                style={{ marginBottom: 8, maxWidth: 320 }}
                addonBefore="名称"
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                placeholder="策略名称"
              />
              <Input.TextArea
                value={mdDraft}
                onChange={(e) => setMdDraft(e.target.value)}
                autoSize={{ minRows: 24, maxRows: 40 }}
                style={{ fontFamily: "'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace", fontSize: 12, lineHeight: 1.7 }}
                placeholder={'# 策略名称\n\n## 策略逻辑\n（自然语言描述策略思路）\n\n## 入场条件\n- ...\n\n## 出场条件\n- ...\n\n## 可执行 DSL\n```dsl\n{ ... }\n```'}
              />
              <div className="dd-muted" style={{ marginTop: 6, fontSize: 12 }}>
                保存时自动校验：文档中最多一个 ```dsl 代码块（白名单指标，确定性引擎执行）；无该块则保存为纯文档态（不参与自动运行与回测）。
              </div>
            </>
          )}
        </div>
      </div>

      {/* 版本历史 + 回测摘要 */}
      <div style={{ display: 'flex', gap: 16, marginTop: 16 }}>
        <div className="dd-panel" style={{ flex: 1 }}>
          <div className="dd-section-title">版本历史</div>
          {versions.length === 0 ? (
            <span className="dd-muted">暂无版本记录</span>
          ) : (
            <Timeline
              items={versions.map((v) => ({
                children: (
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 4 }}>
                    <span>
                      <Tag>v{v.version}</Tag>
                      {v.changeLog}
                      <span className="dd-muted" style={{ marginLeft: 8, fontSize: 12 }}>
                        {new Date(v.createdAt).toLocaleString('zh-CN', { hour12: false })}
                      </span>
                    </span>
                    <Space>
                      <Button size="small" onClick={() => setPreviewVersion(v)}>
                        预览
                      </Button>
                      {v.version !== strategy.version && (
                        <Button size="small" onClick={() => rollback(v.id)}>
                          回滚
                        </Button>
                      )}
                    </Space>
                  </div>
                )
              }))}
            />
          )}
        </div>
        <div className="dd-panel" style={{ flex: 1 }}>
          <div className="dd-section-title">最近回测摘要</div>
          {backtest ? (
            backtestMetrics ? (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', rowGap: 8 }}>
                {[
                  ['年化收益', backtestMetrics.annualReturn as number | string],
                  ['最大回撤', backtestMetrics.maxDrawdown as number | string],
                  ['夏普', backtestMetrics.sharpe as number | string],
                  ['胜率', backtestMetrics.winRate as number | string],
                  ['交易次数', backtestMetrics.tradeCount as number | string],
                  ['状态', String(backtest?.status ?? '—')]
                ].map(([label, v]) => (
                  <div key={String(label)}>
                    <div className="dd-stat-label">{label}</div>
                    <div className="dd-stat-value">
                      {typeof v === 'number' ? (Math.abs(v) < 1 ? `${(v * 100).toFixed(1)}%` : v.toLocaleString()) : v}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <span className="dd-muted">
                最近回测（{new Date(String(backtest.created_at)).toLocaleString('zh-CN', { hour12: false })}）暂无指标数据
              </span>
            )
          ) : (
            <span className="dd-muted">暂无回测记录（由 Agent 在策略生成/修改后自动执行）</span>
          )}
        </div>
      </div>

      {/* 版本预览弹窗 */}
      <Modal
        title={`策略文档预览 · v${previewVersion?.version ?? ''}`}
        open={previewVersion != null}
        onCancel={() => setPreviewVersion(null)}
        footer={
          previewVersion && previewVersion.version !== strategy.version ? (
            <>
              <Button onClick={() => setPreviewVersion(null)}>关闭</Button>
              <Button type="primary" onClick={() => rollback(previewVersion.id)}>
                回滚到此版本
              </Button>
            </>
          ) : (
            <Button onClick={() => setPreviewVersion(null)}>关闭</Button>
          )
        }
        width={720}
      >
        <div className="dd-markdown" style={{ maxHeight: '60vh', overflow: 'auto' }}>
          {previewVersion ? <ReactMarkdown>{previewVersion.markdown || '（该版本无文档内容）'}</ReactMarkdown> : null}
        </div>
      </Modal>
    </div>
  )
}
