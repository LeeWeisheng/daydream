/**
 * 渲染层文案字典：事件类型、工作项类型/状态/优先级等枚举 → 中文标签与配色。
 */

/** 统一事件流类型 */
export const EVENT_LABEL: Record<string, string> = {
  'signal.new': '新信号',
  'signal.updated': '信号更新',
  'agent.report': 'Agent 汇报',
  'alert.triggered': '触发预警',
  'data.progress': '数据同步',
  'workitem.updated': '工作项更新',
  'backtest.finished': '回测完成',
  'strategy.updated': '策略更新',
  'agent.status': 'Agent 状态',
  'chat.message': '对话消息',
  'plan.completed': '规划完成',
  'report.created': '汇报生成'
}

export function eventLabel(type: string): string {
  return EVENT_LABEL[type] ?? type
}

/** 工作项状态 */
export const WORKITEM_STATUS: Record<string, { color: string; label: string }> = {
  pending: { color: 'default', label: '待执行' },
  running: { color: 'processing', label: '执行中' },
  succeeded: { color: 'success', label: '成功' },
  failed: { color: 'error', label: '失败' },
  blocked: { color: 'orange', label: '待决策' },
  cancelled: { color: 'default', label: '已取消' }
}

/** 工作项类型 */
export const WORKITEM_TYPE: Record<string, string> = {
  plan: '规划',
  generate_strategy: '生成策略',
  backtest: '回测',
  activate: '上线评审',
  monitor_review: '盯盘检查',
  review_daily: '日复盘',
  review_weekly: '周复盘',
  correct: '纠正',
  data_backfill: '数据补数',
  user_request: '用户请求'
}

/** 工作项优先级 */
export const WORKITEM_PRIORITY: Record<string, { color: string; label: string }> = {
  high: { color: 'red', label: '高' },
  medium: { color: 'orange', label: '中' },
  low: { color: 'default', label: '低' }
}

/** 简报/事件 payload 的格式化缩进（解析失败时原样返回） */
export function prettyJson(raw: string | null | undefined): string {
  if (!raw) return '—'
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return raw
  }
}
