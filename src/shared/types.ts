/**
 * 共享领域模型类型 —— 三端（main / preload / renderer）共用。
 * 枚举值以字符串存储，由联合类型约束（见《实现方案-数据模型与模块设计》§1.3）。
 */

// ---------- 账户 ----------
export type AutonomyLevel = 'conservative' | 'standard' | 'aggressive'

export interface Account {
  id: string
  name: string
  configJson: string
  autonomyLevel: AutonomyLevel
  createdAt: string
  updatedAt: string
}

// ---------- 行情 ----------
export interface StockBasic {
  code: string
  name: string
  exchange: 'SH' | 'SZ' | 'BJ'
  industry?: string
  status: string
}

export interface Bar {
  code: string
  date: string // YYYY-MM-DD
  open: number
  high: number
  low: number
  close: number
  volume: number
  amount: number
  adjFactor: number
}

export interface Quote {
  code: string
  name: string
  price: number
  pctChg: number
  open: number
  high: number
  low: number
  prevClose: number
  volume: number
  amount: number
  ts: string
}

export interface IndexDaily extends Omit<Bar, 'code' | 'adjFactor'> {
  indexCode: string
}

// ---------- 策略 ----------
export type StrategyStatus =
  | 'draft'
  | 'backtesting'
  | 'pending_approval'
  | 'active'
  | 'paused'
  | 'deactivated'

export interface Strategy {
  id: string
  accountId: string
  name: string
  version: number
  dslJson: string
  status: StrategyStatus
  createdBy: string
  rationale: string
  createdAt: string
  updatedAt: string
}

export interface StrategyVersion {
  id: string
  strategyId: string
  version: number
  dslJson: string
  changeLog: string
  createdAt: string
}

// ---------- 回测 ----------
export type BacktestStatus = 'pending' | 'running' | 'succeeded' | 'failed'

export interface BacktestRun {
  id: string
  strategyVersionId: string
  paramsJson: string
  status: BacktestStatus
  metricsJson?: string
  equityJson?: string
  reportJson?: string
  error?: string
  createdAt: string
  finishedAt?: string
}

export interface BacktestTrade {
  runId: string
  code: string
  side: 'buy' | 'sell'
  price: number
  qty: number
  fee: number
  tradedAt: string
  pnl?: number
  note?: string
}

// ---------- 运行与信号 ----------
export type RunInstanceStatus = 'active' | 'paused' | 'stopped'

export interface RunInstance {
  id: string
  strategyId: string
  strategyVersionId: string
  status: RunInstanceStatus
  startedAt: string
  stoppedAt?: string
}

export type SignalStatus =
  | 'pending_confirmation'
  | 'pending_execution'
  | 'executed'
  | 'ignored'
  | 'expired'

export interface Signal {
  id: string
  accountId: string
  runId: string
  strategyId: string
  code: string
  side: 'buy' | 'sell'
  qty: number
  refPrice: number
  basisJson: string
  riskJson: string
  status: SignalStatus
  expiresAt: string
  createdAt: string
  updatedAt: string
}

// ---------- 账户数据（人工维护） ----------
export interface Position {
  accountId: string
  code: string
  qty: number
  costPrice: number
  updatedAt: string
}

export interface TradeRecord {
  id: string
  accountId: string
  code: string
  side: 'buy' | 'sell'
  price: number
  qty: number
  fee: number
  tradedAt: string
  signalId?: string
  note?: string
}

// ---------- 盯盘 ----------
export type AlertLevel = 'info' | 'warn' | 'critical'

export interface Alert {
  id: string
  accountId: string
  level: AlertLevel
  type: string
  contentJson: string
  status: 'open' | 'acknowledged'
  createdAt: string
}

// ---------- 风控 ----------
export interface RiskCheck {
  rule: string
  result: 'ok' | 'reject' | 'degrade'
  message: string
}

export interface RiskCheckResult {
  refType: string
  refId: string
  passed: boolean
  checks: RiskCheck[]
  checkedAt: string
}

// ---------- Agent ----------
export type WorkItemStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'blocked'
  | 'cancelled'

export type WorkItemType =
  | 'plan'
  | 'generate_strategy'
  | 'backtest'
  | 'activate'
  | 'monitor_review'
  | 'review_daily'
  | 'review_weekly'
  | 'correct'
  | 'data_backfill'
  | 'user_request'

export interface WorkItem {
  id: string
  accountId: string
  type: WorkItemType
  status: WorkItemStatus
  priority: 'low' | 'medium' | 'high'
  contextJson: string
  sessionId?: string
  attempts: number
  maxAttempts: number
  scheduledAt?: string
  deadline?: string
  resultJson?: string
  error?: string
  createdAt: string
  startedAt?: string
  finishedAt?: string
}

export interface AgentMessage {
  id: string
  sessionId: string
  workItemId?: string
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  toolCallsJson?: string
  toolResultsJson?: string
  createdAt: string
}

export interface DecisionRecord {
  id: string
  accountId: string
  workItemId?: string
  eventId?: string
  inputSnapshotJson: string
  outputJson: string
  createdAt: string
}

export interface EventLogEntry {
  id: string
  accountId: string
  type: string
  payloadJson: string
  source: string
  correlationId?: string
  occurredAt: string
}

// ---------- 汇报 ----------
export type ReportLevel = 'silent' | 'summary' | 'result' | 'need_decision'

export interface Report {
  id: string
  accountId: string
  level: ReportLevel
  title: string
  summary: string
  decisionJson?: string
  status: 'pending' | 'approved' | 'rejected' | 'postponed' | 'closed'
  workItemId?: string
  artifactsJson?: string
  createdAt: string
  updatedAt: string
}

// ---------- 复盘与绩效 ----------
export interface ReviewReport {
  id: string
  accountId: string
  period: 'daily' | 'weekly'
  contentJson: string
  metricsJson?: string
  createdBy: string
  createdAt: string
}

export interface AccountSnapshot {
  accountId: string
  date: string
  totalAssets: number
  cash: number
  positionsJson: string
}

// ---------- 回测引擎输入输出 ----------
export interface BacktestParams {
  start: string
  end: string
  initialCash: number
  commissionRate: number // 默认 0.00025
  minCommission: number // 默认 5
  stampTaxRate: number // 卖出印花税 0.0005
  transferFeeRate: number // 过户费 0.00001
  slippage: number // 0.001
}

export interface BacktestEquityPoint {
  date: string
  equity: number
  benchmark: number
}

export interface BacktestMetrics {
  totalReturn: number
  annualReturn: number
  maxDrawdown: number
  annualVolatility: number
  sharpe: number
  sortino: number
  calmar: number
  tradeCount: number
  winRate: number
  profitLossRatio: number
  avgHoldingDays: number
  turnover: number
  benchmarkReturn: number
  excessReturn: number
  alpha: number
  beta: number
  informationRatio: number
  monthlyReturns: Record<string, number>
}

export interface BacktestResult {
  params: BacktestParams
  equity: BacktestEquityPoint[]
  trades: BacktestTrade[]
  metrics: BacktestMetrics
  sampleMetrics?: BacktestMetrics // 样本外分段指标（若指定）
}

// ---------- 模型配置 ----------
export interface ModelConfig {
  baseUrl: string
  apiKey: string
  model: string
  /** 重型任务模型（策略生成/复盘/纠正），可选；未配置时复用 model */
  modelPro?: string
  contextWindow: number
  maxCallsPerHour: number
}

// ---------- 事件推送（主 → 渲染统一事件流） ----------
export type UiEventType =
  | 'signal.new'
  | 'signal.updated'
  | 'agent.report'
  | 'alert.triggered'
  | 'data.progress'
  | 'workitem.updated'
  | 'backtest.finished'
  | 'strategy.updated'
  | 'agent.status'

export interface UiEvent {
  type: UiEventType | string
  payload: unknown
}
