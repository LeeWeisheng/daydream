/**
 * 策略页：每账户唯一一份策略 = Markdown 策略文档 + 用户偏好。
 * 布局：左侧策略文档（预览/编辑，占主区域），右侧用户偏好（可滚动、即时生效），
 * 底部回测摘要与策略信息；版本历史收进 Drawer（预览 / 回滚）。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Button,
  Drawer,
  Empty,
  Form,
  Input,
  InputNumber,
  Popconfirm,
  Segmented,
  Select,
  Space,
  Switch,
  Tag,
  Tooltip,
  message,
  Modal
} from 'antd'
import {
  EditOutlined,
  EyeOutlined,
  HistoryOutlined,
  RocketOutlined,
  SaveOutlined,
  StopOutlined,
  UndoOutlined,
  BarChartOutlined
} from '@ant-design/icons'
import ReactMarkdown from 'react-markdown'
import { DEFAULT_PREFERENCES } from '@shared/constants'
import type { Strategy, StrategyPreferences, StrategyVersion } from '@shared/types'
import { useAppStore } from '../stores'
import PageHeader from '../components/PageHeader'
import Panel from '../components/Panel'
import StatCard from '../components/StatCard'
import EquityChart from '../components/EquityChart'
import { fmtDateTime, fmtPct } from '../lib/format'

const STATUS_LABEL: Record<string, { color: string; label: string }> = {
  draft: { color: 'default', label: '草稿' },
  backtesting: { color: 'processing', label: '回测中' },
  pending_approval: { color: 'orange', label: '待批准' },
  active: { color: 'success', label: '运行中' },
  paused: { color: 'warning', label: '已暂停' },
  deactivated: { color: 'default', label: '已停用' }
}

const BACKTEST_STATUS: Record<string, string> = {
  pending: '待运行',
  running: '运行中',
  succeeded: '成功',
  failed: '失败'
}

/** 编辑区高度：随窗口高度伸缩，避免整页滚动 */
const EDITOR_HEIGHT = 'clamp(340px, calc(100vh - 330px), 720px)'

function emptyPrefs(): StrategyPreferences {
  return JSON.parse(JSON.stringify(DEFAULT_PREFERENCES)) as StrategyPreferences
}

function toPercent(v: number): number {
  return Math.round(v * 1000) / 10
}

function fromPercent(v: number | null, fallback: number): number {
  if (v == null) return fallback
  return Math.round((v / 100) * 10000) / 10000
}

export default function StrategyPage(): React.ReactNode {
  const { currentAccount, eventSeq } = useAppStore()
  const accountId = currentAccount?.id ?? ''
  const [strategy, setStrategy] = useState<Strategy | null>(null)
  const [prefs, setPrefs] = useState<StrategyPreferences>(emptyPrefs())
  const [prefsSnapshot, setPrefsSnapshot] = useState('')
  const [versions, setVersions] = useState<StrategyVersion[]>([])
  const [backtest, setBacktest] = useState<Record<string, unknown> | null>(null)
  const [loading, setLoading] = useState(true)
  // 文档编辑状态
  const [mode, setMode] = useState<'preview' | 'edit'>('preview')
  const [mdDraft, setMdDraft] = useState('')
  const [nameDraft, setNameDraft] = useState('')
  const [saving, setSaving] = useState(false)
  // 版本历史抽屉
  const [versionOpen, setVersionOpen] = useState(false)
  const [expandedVersion, setExpandedVersion] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!accountId) return
    const s = await window.daydream.strategy.getForAccount(accountId).catch(() => null)
    setStrategy(s)
    if (s) {
      let parsed: StrategyPreferences
      try {
        parsed = JSON.parse(s.preferencesJson) as StrategyPreferences
      } catch {
        parsed = emptyPrefs()
      }
      setPrefs(parsed)
      setPrefsSnapshot(JSON.stringify(parsed))
      setMdDraft(s.markdown)
      setNameDraft(s.name)
      window.daydream.strategy.getVersions(s.id).then(setVersions).catch(() => undefined)
      window.daydream.strategy.getLatestBacktest(accountId).then(setBacktest).catch(() => undefined)
    }
    setLoading(false)
  }, [accountId])

  useEffect(() => {
    void refresh()
  }, [refresh, eventSeq])

  // 切换账户时回到预览，避免沿用上一个账户的编辑态
  useEffect(() => {
    setMode('preview')
  }, [accountId])

  /** 文档是否含可执行 ```dsl 块（由执行层 dsl_json 是否为空判断） */
  const executable = Boolean(strategy?.dslJson?.trim())

  /** Markdown 草稿是否有未保存修改 */
  const mdDirty = Boolean(strategy && mode === 'edit' && (mdDraft !== strategy.markdown || nameDraft !== strategy.name))
  /** 用户偏好是否有未保存修改 */
  const prefsDirty = useMemo(() => JSON.stringify(prefs) !== prefsSnapshot, [prefs, prefsSnapshot])

  const savePrefs = async (): Promise<void> => {
    if (!strategy) return
    try {
      await window.daydream.strategy.save({ accountId, preferencesJson: JSON.stringify(prefs), actor: 'user' })
      message.success('用户偏好已保存（即时生效）')
      setPrefsSnapshot(JSON.stringify(prefs))
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

  /** 切换预览/编辑：有未保存修改时二次确认，避免丢失 */
  const switchMode = (next: 'preview' | 'edit'): void => {
    if (next === mode) return
    if (next === 'preview' && mdDirty) {
      Modal.confirm({
        title: '放弃未保存的修改？',
        content: '切回预览将丢弃当前的文档编辑内容。',
        okText: '放弃修改',
        cancelText: '继续编辑',
        okButtonProps: { danger: true },
        onOk: () => {
          if (strategy) {
            setMdDraft(strategy.markdown)
            setNameDraft(strategy.name)
          }
          setMode('preview')
        }
      })
      return
    }
    setMode(next)
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
      setExpandedVersion(null)
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

  const backtestEquity = useMemo(() => {
    try {
      const raw = backtest?.equity_json
      if (!raw) return []
      return JSON.parse(String(raw)) as { date: string; equity: number; benchmark: number }[]
    } catch {
      return []
    }
  }, [backtest])

  if (!loading && !strategy) {
    return (
      <div className="dd-page">
        <Alert
          type="warning"
          showIcon
          message="当前账户尚无策略"
          description="正常情况下每个账户会自动播种一份默认策略；如缺失请重启应用恢复。"
        />
      </div>
    )
  }

  const isRunning = strategy?.status === 'active' || strategy?.status === 'paused'

  return (
    <div className="dd-page">
      <PageHeader
        title="策略"
        badge={
          strategy ? (
            <Space size={6}>
              <Tag color={STATUS_LABEL[strategy.status]?.color ?? 'default'} style={{ marginInlineEnd: 0 }}>
                {STATUS_LABEL[strategy.status]?.label ?? strategy.status}
              </Tag>
              <span className="dd-muted">v{strategy.version}</span>
            </Space>
          ) : null
        }
        description="策略文档为 Markdown 主载体，其中 ```dsl 代码块为可执行部分；用户偏好仅您可修改，即时生效。"
        extra={
          <Space size={8}>
            <Button size="small" icon={<HistoryOutlined />} onClick={() => setVersionOpen(true)}>
              版本历史
            </Button>
            <Button
              size="small"
              type={isRunning ? 'default' : 'primary'}
              icon={isRunning ? <StopOutlined /> : <RocketOutlined />}
              danger={isRunning}
              onClick={toggleActive}
            >
              {isRunning ? '停用' : '激活'}
            </Button>
          </Space>
        }
      />

      <div className="dd-grid-main-side-wide">
        {/* 策略文档 */}
        <Panel
          title="策略文档"
          subtitle={
            <Tooltip title={executable ? '含 ```dsl 代码块，自动运行与回测按此执行' : '无 ```dsl 代码块，仅文档态，不参与自动运行'}>
              <Tag color={executable ? 'success' : 'default'} style={{ cursor: 'help', marginInlineEnd: 0 }}>
                {executable ? '可执行' : '文档态'}
              </Tag>
            </Tooltip>
          }
          flush
          extra={
            <Space size={8}>
              {mdDirty ? <Tag color="orange" style={{ marginInlineEnd: 0 }}>未保存</Tag> : null}
              <Segmented
                size="small"
                value={mode}
                onChange={(v) => switchMode(v as 'preview' | 'edit')}
                options={[
                  { value: 'preview', label: '预览', icon: <EyeOutlined /> },
                  { value: 'edit', label: '编辑', icon: <EditOutlined /> }
                ]}
              />
              {mode === 'edit' ? (
                <Button size="small" type="primary" icon={<SaveOutlined />} loading={saving} onClick={saveMarkdown}>
                  保存
                </Button>
              ) : null}
            </Space>
          }
        >
          <div style={{ padding: mode === 'edit' ? 12 : '8px 18px 18px' }}>
            {mode === 'preview' ? (
              <div className="dd-markdown dd-scroll" style={{ height: EDITOR_HEIGHT }}>
                <ReactMarkdown>{strategy?.markdown || '（策略文档为空，点击「编辑」开始编写）'}</ReactMarkdown>
              </div>
            ) : (
              <>
                <Input
                  size="small"
                  style={{ marginBottom: 8 }}
                  addonBefore="名称"
                  value={nameDraft}
                  onChange={(e) => setNameDraft(e.target.value)}
                  placeholder="策略名称"
                />
                <Input.TextArea
                  value={mdDraft}
                  onChange={(e) => setMdDraft(e.target.value)}
                  style={{
                    height: EDITOR_HEIGHT,
                    resize: 'none',
                    fontFamily: "'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace",
                    fontSize: 12,
                    lineHeight: 1.7
                  }}
                  placeholder={'# 策略名称\n\n## 策略逻辑\n（自然语言描述策略思路）\n\n## 入场条件\n- ...\n\n## 出场条件\n- ...\n\n## 可执行 DSL\n```dsl\n{ ... }\n```'}
                />
                <div className="dd-form-hint" style={{ marginTop: 6 }}>
                  保存时自动校验：文档中最多一个 ```dsl 代码块（白名单指标，确定性引擎执行）；无该块则保存为纯文档态（不参与自动运行与回测）。
                </div>
              </>
            )}
          </div>
        </Panel>

        {/* 用户偏好 */}
        <Panel
          title="用户偏好"
          subtitle="仅您可修改"
          extra={prefsDirty ? <Tag color="orange" style={{ marginInlineEnd: 0 }}>未保存</Tag> : null}
          flush
        >
          <div style={{ padding: '10px 14px 0' }}>
            <div className="dd-scroll" style={{ maxHeight: 'calc(100vh - 320px)', paddingRight: 4 }}>
              <Form layout="vertical" size="small">
                <div className="dd-form-grid">
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
                    <InputNumber
                      style={{ width: '100%' }}
                      min={0}
                      max={100}
                      step={1}
                      precision={1}
                      addonAfter="%"
                      value={toPercent(prefs.expectedAnnualReturn)}
                      onChange={(v) => setPrefs({ ...prefs, expectedAnnualReturn: fromPercent(v, 0.15) })}
                    />
                  </Form.Item>
                  <Form.Item label="最大可承受回撤">
                    <InputNumber
                      style={{ width: '100%' }}
                      min={1}
                      max={90}
                      step={1}
                      precision={1}
                      addonAfter="%"
                      value={toPercent(prefs.maxDrawdownTolerance)}
                      onChange={(v) => setPrefs({ ...prefs, maxDrawdownTolerance: fromPercent(v, 0.15) })}
                    />
                  </Form.Item>
                  <Form.Item label="最大持仓数">
                    <InputNumber
                      style={{ width: '100%' }}
                      min={1}
                      max={50}
                      precision={0}
                      value={prefs.maxPositions}
                      onChange={(v) => setPrefs({ ...prefs, maxPositions: v ?? 5 })}
                    />
                  </Form.Item>
                  <Form.Item label="交易频率">
                    <Select
                      value={prefs.tradeFrequency}
                      onChange={(v) => setPrefs({ ...prefs, tradeFrequency: v })}
                      options={[
                        { value: 'low', label: '低频' },
                        { value: 'medium', label: '中频' },
                        { value: 'high', label: '高频' }
                      ]}
                    />
                  </Form.Item>
                  <Form.Item label="单票仓位上限">
                    <InputNumber
                      style={{ width: '100%' }}
                      min={1}
                      max={100}
                      step={1}
                      precision={1}
                      addonAfter="%"
                      value={toPercent(prefs.maxPositionPct)}
                      onChange={(v) => setPrefs({ ...prefs, maxPositionPct: fromPercent(v, 0.2) })}
                    />
                  </Form.Item>
                  <Form.Item label="总仓位上限">
                    <InputNumber
                      style={{ width: '100%' }}
                      min={1}
                      max={100}
                      step={1}
                      precision={1}
                      addonAfter="%"
                      value={toPercent(prefs.maxTotalPositionPct)}
                      onChange={(v) => setPrefs({ ...prefs, maxTotalPositionPct: fromPercent(v, 0.8) })}
                    />
                  </Form.Item>
                </div>
                <Form.Item label="持股周期">
                  <Segmented
                    block
                    value={prefs.holdingPeriod}
                    onChange={(v) => setPrefs({ ...prefs, holdingPeriod: v as StrategyPreferences['holdingPeriod'] })}
                    options={[
                      { value: 'short', label: '短线' },
                      { value: 'swing', label: '波段' },
                      { value: 'long', label: '中长线' }
                    ]}
                  />
                </Form.Item>
                <Form.Item label="偏好行业">
                  <Select mode="tags" value={prefs.preferredIndustries} onChange={(v) => setPrefs({ ...prefs, preferredIndustries: v })} placeholder="输入后回车" open={false} suffixIcon={null} />
                </Form.Item>
                <Form.Item label="排除行业">
                  <Select mode="tags" value={prefs.excludedIndustries} onChange={(v) => setPrefs({ ...prefs, excludedIndustries: v })} placeholder="输入后回车" open={false} suffixIcon={null} />
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
                  <div className="dd-list">
                    {(
                      [
                        ['signals', '信号通知'],
                        ['alerts', '预警通知'],
                        ['summaries', '摘要通知']
                      ] as const
                    ).map(([key, label]) => (
                      <div key={key} className="dd-row" style={{ padding: '4px 0', borderBottom: 'none' }}>
                        <span className="dd-row-label">{label}</span>
                        <Switch
                          size="small"
                          checked={prefs.notify[key]}
                          onChange={(v) => setPrefs({ ...prefs, notify: { ...prefs.notify, [key]: v } })}
                        />
                      </div>
                    ))}
                  </div>
                  <div className="dd-form-hint" style={{ marginTop: 4 }}>
                    静默时段 {prefs.notify.quietHours}
                  </div>
                </Form.Item>
              </Form>
            </div>
            <div style={{ borderTop: '1px solid rgba(128,128,128,0.16)', padding: '10px 0 12px', marginTop: 8 }}>
              <Button type="primary" block icon={<SaveOutlined />} onClick={savePrefs} disabled={!prefsDirty}>
                保存用户偏好
              </Button>
            </div>
          </div>
        </Panel>
      </div>

      {/* 回测摘要 + 策略信息 */}
      <div className="dd-grid-main-side-wide">
        <Panel
          title="最近回测"
          subtitle={backtest ? fmtDateTime(String(backtest.created_at)) : '由 Agent 在策略生成/修改后自动执行'}
          extra={
            backtest ? <Tag style={{ marginInlineEnd: 0 }}>{BACKTEST_STATUS[String(backtest.status)] ?? String(backtest.status)}</Tag> : null
          }
        >
          {backtest ? (
            backtestMetrics ? (
              <>
                <div className="dd-kpi-grid" style={{ marginBottom: 12 }}>
                  <StatCard label="年化收益" value={fmtPct(backtestMetrics.annualReturn)} tone={backtestMetrics.annualReturn >= 0 ? 'up' : 'down'} />
                  <StatCard label="最大回撤" value={fmtPct(backtestMetrics.maxDrawdown)} tone="down" />
                  <StatCard label="夏普比率" value={backtestMetrics.sharpe?.toFixed(2) ?? '—'} />
                  <StatCard label="胜率" value={fmtPct(backtestMetrics.winRate)} />
                  <StatCard label="交易次数" value={String(backtestMetrics.tradeCount ?? '—')} />
                  <StatCard label="基准收益" value={fmtPct(backtestMetrics.benchmarkReturn)} tone={backtestMetrics.benchmarkReturn >= 0 ? 'up' : 'down'} />
                </div>
                {backtestEquity.length > 0 ? (
                  <EquityChart points={backtestEquity} height={200} />
                ) : (
                  <div className="dd-form-hint">暂无净值曲线数据</div>
                )}
              </>
            ) : (
              <div className="dd-empty">
                <Empty description={false} image={Empty.PRESENTED_IMAGE_SIMPLE} />
                最近回测暂无指标数据（可能仍在运行或失败）
                {backtest.error ? <div className="dd-form-hint">{String(backtest.error)}</div> : null}
              </div>
            )
          ) : (
            <div className="dd-empty">
              <BarChartOutlined style={{ fontSize: 22, opacity: 0.5 }} />
              暂无回测记录：Agent 在策略生成/修改后自动回测，也可在对话中要求回测
            </div>
          )}
        </Panel>

        <Panel title="策略信息">
          <div className="dd-list">
            <div className="dd-row" style={{ padding: '4px 0' }}>
              <span className="dd-row-label">名称</span>
              <span className="dd-row-value" style={{ fontWeight: 500 }}>
                {strategy?.name ?? '—'}
              </span>
            </div>
            <div className="dd-row" style={{ padding: '4px 0' }}>
              <span className="dd-row-label">当前版本</span>
              <span className="dd-row-value">v{strategy?.version ?? '—'}（共 {versions.length} 个版本）</span>
            </div>
            <div className="dd-row" style={{ padding: '4px 0' }}>
              <span className="dd-row-label">创建者</span>
              <span className="dd-row-value" style={{ fontWeight: 500 }}>
                {strategy?.createdBy === 'agent' ? 'Agent' : '用户'}
              </span>
            </div>
            <div className="dd-row" style={{ padding: '4px 0' }}>
              <span className="dd-row-label">更新时间</span>
              <span className="dd-row-value" style={{ fontWeight: 500, fontSize: 12 }}>
                {fmtDateTime(strategy?.updatedAt)}
              </span>
            </div>
          </div>
          {strategy?.rationale ? (
            <div className="dd-panel-dashed" style={{ marginTop: 10, fontSize: 12, lineHeight: 1.7, color: 'inherit' }}>
              {strategy.rationale}
            </div>
          ) : null}
        </Panel>
      </div>

      {/* 版本历史抽屉 */}
      <Drawer title="版本历史" width={620} open={versionOpen} onClose={() => setVersionOpen(false)}>
        {versions.length === 0 ? (
          <div className="dd-empty">暂无版本记录</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {versions.map((v) => {
              const current = v.version === strategy?.version
              const expanded = expandedVersion === v.id
              return (
                <div key={v.id} className="dd-card">
                  <div style={{ padding: '10px 12px', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                    <div style={{ minWidth: 0 }}>
                      <Space size={6} wrap>
                        <Tag color={current ? 'blue' : undefined} style={{ marginInlineEnd: 0 }}>
                          v{v.version}
                        </Tag>
                        {current ? (
                          <Tag color="success" style={{ marginInlineEnd: 0 }}>
                            当前
                          </Tag>
                        ) : null}
                        <span style={{ fontSize: 12 }}>{v.changeLog}</span>
                      </Space>
                      <div className="dd-muted" style={{ fontSize: 11, marginTop: 4 }}>
                        {fmtDateTime(v.createdAt)}
                      </div>
                    </div>
                    <Space size={6} style={{ flex: 'none' }}>
                      <Button size="small" onClick={() => setExpandedVersion(expanded ? null : v.id)}>
                        {expanded ? '收起' : '预览'}
                      </Button>
                      {!current ? (
                        <Popconfirm
                          title="回滚到该版本？"
                          description="将以该版本文档生成新的当前版本。"
                          okText="回滚"
                          onConfirm={() => void rollback(v.id)}
                        >
                          <Button size="small" icon={<UndoOutlined />}>
                            回滚
                          </Button>
                        </Popconfirm>
                      ) : null}
                    </Space>
                  </div>
                  {expanded ? (
                    <div className="dd-markdown dd-scroll" style={{ borderTop: '1px solid rgba(128,128,128,0.16)', padding: 12, maxHeight: 360 }}>
                      <ReactMarkdown>{v.markdown || '（该版本无文档内容）'}</ReactMarkdown>
                    </div>
                  ) : null}
                </div>
              )
            })}
          </div>
        )}
      </Drawer>
    </div>
  )
}
