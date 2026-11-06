/**
 * 固定拒绝（UserError）：一个人或 Agent 可以触发的拒绝，均以错误码表达。
 * 管理面（IPC）对不存在（missing）返回 404，其余返回 400；
 * 界面按错误码文案化。与 dsh-superagent-prototype 的 src/core/errors.ts 对齐。
 */

export interface UserErrorCode {
  code: string
  /** 面向日志 / Agent 的英文说明 */
  en: string
  /** 面向界面的中文说明 */
  zh: string
}

export const USER_ERRORS: Record<string, UserErrorCode> = {
  missing_account: { code: 'missing_account', en: 'The account does not exist', zh: '账户不存在' },
  missing_workitem: { code: 'missing_workitem', en: 'The work item does not exist', zh: '工作项不存在' },
  missing_strategy: { code: 'missing_strategy', en: 'The strategy does not exist', zh: '策略不存在' },
  missing_strategy_version: { code: 'missing_strategy_version', en: 'The strategy version does not exist', zh: '策略版本不存在' },
  missing_report: { code: 'missing_report', en: 'The report does not exist', zh: '汇报不存在' },
  missing_signal: { code: 'missing_signal', en: 'The signal does not exist', zh: '信号不存在' },
  invalid_input: { code: 'invalid_input', en: 'The input is invalid', zh: '输入不合法' },
  not_ready: { code: 'not_ready', en: 'The work item is not ready for this command', zh: '工作项当前状态不支持该操作' },
  model_not_configured: { code: 'model_not_configured', en: 'The model is not configured', zh: '请先配置模型再开始运行' },
  agent_not_running: { code: 'agent_not_running', en: 'The agent is not running', zh: 'Agent 已停止运行' },
  not_retryable: { code: 'not_retryable', en: 'The work item cannot be retried', zh: '该工作项当前状态不可重试' },
  not_cancellable: { code: 'not_cancellable', en: 'The work item cannot be cancelled', zh: '该工作项当前状态不可取消' },
  insufficient_cash: { code: 'insufficient_cash', en: 'Insufficient available cash', zh: '可用资金不足' },
  insufficient_position: { code: 'insufficient_position', en: 'Insufficient position', zh: '持仓不足' },
  risk_rejected: { code: 'risk_rejected', en: 'The signal was rejected by risk control', zh: '风控拒绝该信号' },
  trade_conflict: { code: 'trade_conflict', en: 'The trade conflicts with current state', zh: '交易与当前状态冲突' }
}

export class UserError extends Error {
  readonly code: string
  readonly values: Record<string, string>

  constructor(code: keyof typeof USER_ERRORS | string, values: Record<string, string> = {}) {
    const def = USER_ERRORS[code]
    super(def ? def.zh : code)
    this.name = 'UserError'
    this.code = code
    this.values = values
  }
}

/** 断言助手：条件为假时抛固定拒绝 */
export function assertUser(condition: unknown, code: keyof typeof USER_ERRORS, values?: Record<string, string>): asserts condition {
  if (!condition) throw new UserError(code, values)
}
