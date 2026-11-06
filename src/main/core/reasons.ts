/**
 * 决策原因（Reason）：核心记录的每个 Decision 以原因码解释「为什么」。
 * 码值由 code + values 组成；Agent 阅读英文文本（reasonText），界面按码文案化。
 * 与 dsh-superagent-prototype 的 src/core/reasons.ts 对齐。
 */

export interface Reason {
  code: string
  values?: Record<string, string>
}

interface ReasonDef {
  en: string
  zh: string
}

export const REASONS: Record<string, ReasonDef> = {
  // 准入与决策
  not_running: { en: 'The agent is not running', zh: 'Agent 未运行' },
  ui_only: { en: 'A UI-only event, which takes no evaluation', zh: '仅 UI 事件，不进入评估' },
  direct_request: { en: 'An explicit request accepted directly', zh: '明确请求直接接单' },
  assessment_accepted: { en: 'The assessment accepted the work', zh: '评估判定需要行动并接单' },
  assessment_ignored: { en: 'The assessment found no action needed', zh: '评估判定无需行动' },
  would_accept: { en: 'The assessment would accept, recorded in manual mode', zh: '评估判定可行动（手动模式留档）' },
  assessment_failed: { en: 'The assessment failed and fell back', zh: '评估失败，按降级策略处理' },
  eval_timeout: { en: 'The evaluation ran out of time', zh: '评估超时' },
  // 工作项生命周期
  policy_changed: { en: 'The policy changed under this evaluation', zh: '策略变更导致评估重排' },
  expired_retry: { en: 'Retried after an expired evaluation', zh: '评估过期后重试' },
  interrupted: { en: 'The work item was interrupted by a restart', zh: '应用中断导致工作项终止' },
  stopped_by_user: { en: 'Stopped by a person', zh: '人工取消' },
  retry_exhausted: { en: 'Retries exhausted', zh: '重试耗尽' },
  timeout: { en: 'The work item ran out of time', zh: '执行超时' },
  dispatch_error: { en: 'The work item failed during dispatch', zh: '执行失败' },
  handoff_approval: { en: 'Waiting for a person to decide', zh: '等待人工决定' }
}

/** Agent 可读的英文原因文本 */
export function reasonText(reason: Reason): string {
  const def = REASONS[reason.code]
  const base = def?.en ?? reason.code
  if (!reason.values) return base
  const extra = Object.entries(reason.values)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ')
  return `${base} (${extra})`
}
