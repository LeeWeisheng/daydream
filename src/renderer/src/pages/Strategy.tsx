/**
 * 策略页：每账户唯一一份策略 = Markdown 纯文本（交易策略 + 用户偏好等全部信息）。
 * 布局：左右分栏——左侧策略版本列表（选择/设为生效），右侧策略详情（统计卡片 + 预览/编辑）。
 * 编辑使用 CodeMirror 代码编辑器；保存即产生新版本并立即生效（默认最新版本，用户可指定其它版本生效）。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Alert, Button, Input, Modal, Popconfirm, Segmented, Space, Tag, message } from 'antd'
import { CheckCircleOutlined, EditOutlined, EyeOutlined, SaveOutlined, ThunderboltOutlined } from '@ant-design/icons'
import ReactMarkdown from 'react-markdown'
import CodeMirror from '@uiw/react-codemirror'
import { markdown as markdownLang } from '@codemirror/lang-markdown'
import { useTheme } from 'antd-style'
import type { Strategy, StrategyStats, StrategyVersion } from '@shared/types'
import { DEFAULT_INITIAL_CASH } from '@shared/constants'
import { useAppStore } from '../stores'
import PageHeader from '../components/PageHeader'
import Panel from '../components/Panel'
import StatCard from '../components/StatCard'
import { fmtDateTime, fmtPct, fmtSigned } from '../lib/format'

/** 详情区编辑高度：随窗口高度伸缩，避免整页滚动 */
const EDITOR_HEIGHT = 'clamp(320px, calc(100vh - 430px), 660px)'

function parseStats(json: string): StrategyStats {
  try {
    const parsed = JSON.parse(json) as Partial<StrategyStats>
    return {
      principal: typeof parsed.principal === 'number' ? parsed.principal : DEFAULT_INITIAL_CASH,
      totalPnl: typeof parsed.totalPnl === 'number' ? parsed.totalPnl : 0,
      profitLossRatio: typeof parsed.profitLossRatio === 'number' ? parsed.profitLossRatio : 0,
      winRate: typeof parsed.winRate === 'number' ? parsed.winRate : 0,
      tradeCount: typeof parsed.tradeCount === 'number' ? parsed.tradeCount : 0,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : ''
    }
  } catch {
    return { principal: DEFAULT_INITIAL_CASH, totalPnl: 0, profitLossRatio: 0, winRate: 0, tradeCount: 0, updatedAt: '' }
  }
}

export default function StrategyPage(): React.ReactNode {
  const { currentAccount, eventSeq } = useAppStore()
  const { isDarkMode } = useTheme()
  const accountId = currentAccount?.id ?? ''
  const [strategy, setStrategy] = useState<Strategy | null>(null)
  const [versions, setVersions] = useState<StrategyVersion[]>([])
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  // 编辑状态
  const [mode, setMode] = useState<'preview' | 'edit'>('preview')
  const [mdDraft, setMdDraft] = useState('')
  const [titleDraft, setTitleDraft] = useState('')
  const [changeLogDraft, setChangeLogDraft] = useState('')
  const [saving, setSaving] = useState(false)

  /** 生效版本：用户指定优先，否则最新 */
  const effectiveVersionId = useMemo(() => {
    if (!strategy) return null
    if (strategy.activeVersionId && versions.some((v) => v.id === strategy.activeVersionId)) return strategy.activeVersionId
    return versions[0]?.id ?? null
  }, [strategy, versions])

  const latestVersion = versions[0]
  const selectedVersion = useMemo(() => {
    if (selectedVersionId) {
      const v = versions.find((x) => x.id === selectedVersionId)
      if (v) return v
    }
    return versions[0]
  }, [versions, selectedVersionId])
  const selectedStats = useMemo(() => (selectedVersion ? parseStats(selectedVersion.statsJson) : null), [selectedVersion])
  const effectiveSelected = Boolean(selectedVersion && selectedVersion.id === effectiveVersionId)
  const pinnedToHistory = Boolean(strategy?.activeVersionId)
  /** 编辑草稿是否有未保存修改 */
  const mdDirty = mode === 'edit' && mdDraft !== (selectedVersion?.markdown ?? '')
  /** CodeMirror 扩展（语言支持）memoize，避免每次渲染重建 */
  const cmExtensions = useMemo(() => [markdownLang()], [])

  const refresh = useCallback(async () => {
    if (!accountId) {
      setLoading(false)
      return
    }
    const s = await window.daydream.strategy.getForAccount(accountId).catch(() => null)
    setStrategy(s)
    if (s) {
      const vs = await window.daydream.strategy.getVersions(s.id).catch(() => [] as StrategyVersion[])
      setVersions(vs)
      setSelectedVersionId((prev) => {
        if (prev && vs.some((v) => v.id === prev)) return prev
        return null
      })
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

  const enterEdit = (): void => {
    if (!selectedVersion) return
    setTitleDraft(selectedVersion.title || strategy?.title || '')
    setChangeLogDraft('')
    setMdDraft(selectedVersion.markdown)
    setMode('edit')
  }

  /** 放弃编辑回预览（有未保存修改时二次确认） */
  const cancelEdit = (): void => {
    if (mdDirty) {
      Modal.confirm({
        title: '放弃未保存的修改？',
        okText: '放弃修改',
        cancelText: '继续编辑',
        okButtonProps: { danger: true },
        onOk: () => setMode('preview')
      })
      return
    }
    setMode('preview')
  }

  const switchMode = (next: 'preview' | 'edit'): void => {
    if (next === mode) return
    if (next === 'preview') {
      cancelEdit()
      return
    }
    enterEdit()
  }

  /** 点击版本卡片：编辑态下切换版本一律回预览（避免草稿与展示版本错配） */
  const selectVersion = (versionId: string): void => {
    if (versionId === selectedVersion?.id) return
    if (mode === 'edit') {
      const apply = (): void => {
        setMode('preview')
        setSelectedVersionId(versionId)
      }
      if (mdDirty) {
        Modal.confirm({
          title: '切换版本将丢弃未保存的编辑？',
          okText: '丢弃并切换',
          cancelText: '继续编辑',
          okButtonProps: { danger: true },
          onOk: apply
        })
        return
      }
      apply()
      return
    }
    setSelectedVersionId(versionId)
  }

  const save = async (): Promise<void> => {
    if (!strategy) return
    if (!mdDraft.trim()) {
      message.warning('策略文档不能为空')
      return
    }
    setSaving(true)
    try {
      await window.daydream.strategy.save({
        accountId,
        markdown: mdDraft,
        title: titleDraft.trim() || undefined,
        changeLog: changeLogDraft.trim() || '用户修改',
        actor: 'user'
      })
      message.success('策略已保存（新版本立即生效）')
      setMode('preview')
      setSelectedVersionId(null)
      await refresh()
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const pinVersion = async (versionId: string): Promise<void> => {
    try {
      await window.daydream.strategy.setActiveVersion(accountId, versionId)
      message.success('已设为生效版本')
      void refresh()
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  const useLatest = async (): Promise<void> => {
    try {
      await window.daydream.strategy.setActiveVersion(accountId, null)
      message.success('已恢复默认：使用最新版本')
      void refresh()
    } catch (e) {
      message.error((e as Error).message)
    }
  }

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

  return (
    <div className="dd-page">
      <PageHeader
        title="策略"
        badge={
          strategy ? (
            <Space size={6}>
              <span className="dd-muted">当前 v{strategy.version}</span>
              {pinnedToHistory ? <Tag color="orange" style={{ marginInlineEnd: 0 }}>使用历史版本</Tag> : null}
            </Space>
          ) : null
        }
        description="策略是纯 Markdown 文本（交易策略 + 用户偏好等全部信息），注入 Agent 系统提示词；保存即生效，默认使用最新版本，可指定其它版本。"
        extra={
          pinnedToHistory ? (
            <Button size="small" icon={<ThunderboltOutlined />} onClick={() => void useLatest()}>
              使用最新版本
            </Button>
          ) : null
        }
      />

      <div style={{ display: 'flex', gap: 14, alignItems: 'stretch', height: 'calc(100vh - 160px)', minHeight: 420 }}>
        {/* 左：版本列表 */}
        <div style={{ width: 330, flex: 'none', minHeight: 0 }}>
          <Panel title="策略版本" subtitle={`共 ${versions.length} 个版本`} flush style={{ height: '100%' }}>
            <div className="dd-scroll" style={{ height: 'calc(100vh - 250px)', padding: '10px 10px 4px', overflowY: 'auto' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {versions.length === 0 ? (
                <div className="dd-empty">暂无版本记录</div>
              ) : (
                versions.map((v) => {
                  const stats = parseStats(v.statsJson)
                  const effective = v.id === effectiveVersionId
                  const latest = v.id === latestVersion?.id
                  const selected = v.id === selectedVersion?.id
                  return (
                    <div
                      key={v.id}
                      className="dd-card"
                      style={{
                        cursor: 'pointer',
                        outline: selected ? '1px solid rgba(22,119,255,0.55)' : 'none',
                        background: selected ? 'rgba(22,119,255,0.06)' : undefined
                      }}
                      onClick={() => selectVersion(v.id)}
                    >
                      <div style={{ padding: '9px 12px' }}>
                        <Space size={6} wrap style={{ rowGap: 2 }}>
                          <Tag color={effective ? 'success' : undefined} style={{ marginInlineEnd: 0 }}>
                            v{v.version}
                          </Tag>
                          {latest ? (
                            <Tag color="blue" style={{ marginInlineEnd: 0 }}>
                              最新
                            </Tag>
                          ) : null}
                          {effective ? (
                            <span style={{ fontSize: 11, color: 'rgba(82,196,26,0.9)' }}>
                              <CheckCircleOutlined /> 生效中
                            </span>
                          ) : null}
                        </Space>
                        <div style={{ fontSize: 12, fontWeight: 600, margin: '5px 0 2px', lineHeight: 1.4 }}>{v.title || '（无标题）'}</div>
                        {v.changeLog ? <div className="dd-muted" style={{ fontSize: 11, lineHeight: 1.5 }}>{v.changeLog}</div> : null}
                        <div className="dd-muted" style={{ fontSize: 11, marginTop: 3 }}>{fmtDateTime(v.createdAt)}</div>
                        <div style={{ fontSize: 11, marginTop: 4, display: 'flex', gap: 8 }}>
                          <span>
                            盈亏 <span className={stats.totalPnl >= 0 ? 'dd-up' : 'dd-down'}>{fmtSigned(stats.totalPnl)}</span>
                          </span>
                          <span>胜率 {fmtPct(stats.winRate)}</span>
                          <span>盈亏比 {stats.profitLossRatio}</span>
                        </div>
                        {!effective ? (
                          <Popconfirm title="将该版本设为生效版本？" okText="设为生效" onConfirm={() => void pinVersion(v.id)}>
                            <Button size="small" style={{ marginTop: 6 }} onClick={(e) => e.stopPropagation()}>
                              设为生效
                            </Button>
                          </Popconfirm>
                        ) : null}
                      </div>
                    </div>
                  )
                })
              )}
            </div>
            </div>
          </Panel>
        </div>

        {/* 右：策略详情 */}
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <Panel
            title={
              <Space size={8} wrap>
                <span>{selectedVersion?.title || strategy?.title || '策略详情'}</span>
                {selectedVersion ? (
                  <Tag color="blue" style={{ marginInlineEnd: 0 }}>
                    v{selectedVersion.version}
                  </Tag>
                ) : null}
                {effectiveSelected ? (
                  <Tag color="success" style={{ marginInlineEnd: 0 }}>
                    生效中
                  </Tag>
                ) : selectedVersion ? (
                  <Tag style={{ marginInlineEnd: 0 }}>历史版本</Tag>
                ) : null}
              </Space>
            }
            flush
            extra={
              <Space size={8}>
                <Segmented
                  size="small"
                  value={mode}
                  onChange={(v) => (v === 'edit' ? enterEdit() : switchMode('preview'))}
                  options={[
                    { value: 'preview', label: '预览', icon: <EyeOutlined /> },
                    { value: 'edit', label: '编辑', icon: <EditOutlined /> }
                  ]}
                />
                {mode === 'edit' ? (
                  <>
                    <Button size="small" onClick={cancelEdit}>
                      取消
                    </Button>
                    <Button size="small" type="primary" icon={<SaveOutlined />} loading={saving} onClick={() => void save()}>
                      保存为新版本
                    </Button>
                  </>
                ) : null}
              </Space>
            }
          >
            <div style={{ padding: 12, display: 'flex', flexDirection: 'column' }}>
              {/* 版本统计 */}
              <div className="dd-kpi-grid" style={{ marginBottom: 12 }}>
                <StatCard label="本金" value={selectedStats ? selectedStats.principal.toLocaleString('zh-CN') : '—'} sub="账户初始资金" />
                <StatCard label="累计盈亏" value={selectedStats ? fmtSigned(selectedStats.totalPnl) : '—'} tone={selectedStats && selectedStats.totalPnl >= 0 ? 'up' : 'down'} sub="已平仓交易口径" />
                <StatCard label="盈亏比" value={selectedStats?.profitLossRatio ?? '—'} sub="平均盈利 / 平均亏损" />
                <StatCard label="胜率" value={selectedStats ? fmtPct(selectedStats.winRate) : '—'} sub={`成交记录 ${selectedStats?.tradeCount ?? 0} 条`} />
              </div>

              {mode === 'edit' ? (
                <>
                  <Space size={8} style={{ marginBottom: 8, display: 'flex' }}>
                    <Input size="small" style={{ width: 260 }} addonBefore="标题" value={titleDraft} onChange={(e) => setTitleDraft(e.target.value)} placeholder="简短标题（不超过 40 字）" maxLength={40} />
                    <Input
                      size="small"
                      style={{ flex: 1 }}
                      addonBefore="变更记录"
                      value={changeLogDraft}
                      onChange={(e) => setChangeLogDraft(e.target.value)}
                      placeholder="一句话描述本次修改（不超过 120 字）"
                      maxLength={120}
                    />
                  </Space>
                  <div style={{ border: '1px solid rgba(128,128,128,0.18)', borderRadius: 6, overflow: 'hidden', flex: 1, minHeight: 0 }}>
                    <CodeMirror
                      value={mdDraft}
                      onChange={(v) => setMdDraft(v)}
                      height="100%"
                      theme={isDarkMode ? 'dark' : 'light'}
                      extensions={cmExtensions}
                      basicSetup={{ lineNumbers: true, foldGutter: true, highlightActiveLine: true }}
                      style={{ height: EDITOR_HEIGHT, fontSize: 12.5 }}
                    />
                  </div>
                  <div className="dd-form-hint" style={{ marginTop: 6 }}>
                    策略为纯 Markdown 文本（交易策略 + 用户偏好等全部信息），是注入 Agent 的系统提示词；保存后生成新版本并立即生效。
                  </div>
                </>
              ) : (
                <div className="dd-markdown dd-scroll" style={{ height: EDITOR_HEIGHT }}>
                  <ReactMarkdown>{selectedVersion?.markdown || '（策略文档为空，点击「编辑」开始编写）'}</ReactMarkdown>
                </div>
              )}
            </div>
          </Panel>
        </div>
      </div>
    </div>
  )
}
