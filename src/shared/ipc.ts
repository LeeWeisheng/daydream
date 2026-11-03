/**
 * IPC 通道与请求/响应类型声明（主进程 handler 与 preload API 共同引用）。
 * 命名规范：`域:动作`；主进程 → 渲染进程统一走 `daydream:event` 事件流。
 */
import type {
  Account,
  Alert,
  AutonomyLevel,
  BacktestRun,
  BacktestTrade,
  Bar,
  EventLogEntry,
  ModelConfig,
  Position,
  Quote,
  Report,
  ReviewReport,
  RunInstance,
  Signal,
  StockBasic,
  Strategy,
  TradeRecord,
  UiEvent,
  WorkItem
} from './types'

export const IPC = {
  // 账户
  accountList: 'account:list',
  accountCreate: 'account:create',
  accountSwitch: 'account:switch',
  accountDelete: 'account:delete',
  // 设置
  settingsGet: 'settings:get',
  settingsUpdate: 'settings:update',
  // 行情数据
  dataGetKline: 'data:getKline',
  dataGetQuote: 'data:getQuote',
  dataGetStockList: 'data:getStockList',
  dataGetDataStatus: 'data:getDataStatus',
  dataInitialSync: 'data:initialSync',
  dataDailyUpdate: 'data:dailyUpdate',
  // 策略
  strategyList: 'strategy:list',
  strategyGet: 'strategy:get',
  strategyCreate: 'strategy:create',
  strategyUpdate: 'strategy:update',
  strategyActivate: 'strategy:activate',
  strategyDeactivate: 'strategy:deactivate',
  // 回测
  backtestStart: 'backtest:start',
  backtestCancel: 'backtest:cancel',
  backtestList: 'backtest:list',
  backtestGetResult: 'backtest:getResult',
  backtestGetTrades: 'backtest:getTrades',
  // 信号
  signalList: 'signal:list',
  signalFeedback: 'signal:feedback',
  // 预警
  alertList: 'alert:list',
  alertAcknowledge: 'alert:acknowledge',
  // Agent
  agentGetWorkItems: 'agent:getWorkItems',
  agentRetryWorkItem: 'agent:retryWorkItem',
  agentCancelWorkItem: 'agent:cancelWorkItem',
  agentGetPlan: 'agent:getPlan',
  agentGetStatus: 'agent:getStatus',
  agentStart: 'agent:start',
  agentStop: 'agent:stop',
  // 汇报（待决策）
  reportList: 'report:list',
  reportRespond: 'report:respond',
  // 绩效
  perfGetSnapshot: 'perf:getSnapshot',
  perfGetCharts: 'perf:getCharts',
  // 复盘
  reviewList: 'review:list',
  reviewGetReport: 'review:getReport',
  // 持仓与成交
  positionList: 'position:list',
  positionUpsert: 'position:upsert',
  tradeList: 'trade:list',
  tradeCreate: 'trade:create',
  // 审计
  auditList: 'audit:list',
  eventList: 'event:list',
  // 对话
  chatSend: 'chat:send',
  // 统一事件流（主 → 渲染）
  uiEvent: 'daydream:event'
} as const

// ---------- 请求/响应载荷类型 ----------
export interface AccountCreateReq {
  name: string
}
export interface AccountSwitchReq {
  accountId: string
}

export interface SettingsPatch {
  modelConfig?: ModelConfig
  autonomyLevel?: AutonomyLevel
  monitorIntervalMinutes?: number
  dataSourcePreference?: string
  riskRules?: Record<string, unknown>
}

export interface StrategyCreateReq {
  accountId: string
  name: string
  dslJson: string
  rationale?: string
  createdBy: string
}

export interface BacktestStartReq {
  strategyVersionId: string
  start: string
  end: string
  sampleOutEnd?: string // 样本外分段起点（可选）
}

export interface SignalFeedbackReq {
  signalId: string
  feedback: 'executed' | 'ignored'
  tradedPrice?: number
  tradedQty?: number
  fee?: number
}

export interface ReportRespondReq {
  reportId: string
  decision: 'approved' | 'rejected' | 'postponed'
  note?: string
}

export interface PositionUpsertReq {
  accountId: string
  code: string
  qty: number
  costPrice: number
}

export interface TradeCreateReq {
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

export interface ChatSendReq {
  accountId: string
  message: string
}

// ---------- preload 暴露的 API 形状 ----------
export interface DaydreamApi {
  accounts: {
    list(): Promise<Account[]>
    create(req: AccountCreateReq): Promise<Account>
    switchTo(req: AccountSwitchReq): Promise<Account>
    remove(accountId: string): Promise<void>
  }
  settings: {
    get(accountId: string): Promise<{ modelConfig?: ModelConfig; autonomyLevel?: AutonomyLevel; monitorIntervalMinutes?: number; modelConfigured: boolean }>
    update(accountId: string, patch: SettingsPatch): Promise<void>
  }
  data: {
    getStockList(): Promise<StockBasic[]>
    getQuote(codes: string[]): Promise<Quote[]>
    getKline(code: string, start: string, end: string): Promise<Bar[]>
    getDataStatus(): Promise<Record<string, unknown>[]>
    initialSync(): Promise<{ started: boolean }>
    dailyUpdate(): Promise<{ started: boolean }>
  }
  strategies: {
    list(accountId: string): Promise<Strategy[]>
    get(id: string): Promise<Strategy>
    create(req: StrategyCreateReq): Promise<Strategy>
    update(id: string, dslJson: string, changeLog: string): Promise<Strategy>
    activate(id: string): Promise<void>
    deactivate(id: string): Promise<void>
  }
  backtests: {
    start(req: BacktestStartReq): Promise<{ runId: string }>
    cancel(runId: string): Promise<void>
    list(accountId: string): Promise<BacktestRun[]>
    getResult(runId: string): Promise<BacktestRun>
    getTrades(runId: string): Promise<BacktestTrade[]>
  }
  signals: {
    list(accountId: string, limit?: number): Promise<Signal[]>
    feedback(req: SignalFeedbackReq): Promise<void>
  }
  alerts: {
    list(accountId: string): Promise<Alert[]>
    acknowledge(alertId: string): Promise<void>
  }
  agent: {
    getWorkItems(accountId: string): Promise<WorkItem[]>
    retryWorkItem(id: string): Promise<void>
    cancelWorkItem(id: string): Promise<void>
    getPlan(accountId: string): Promise<unknown[]>
    getStatus(): Promise<{ active: boolean; running: boolean; lastTickAt?: string }>
    start(): Promise<void>
    stop(): Promise<void>
  }
  reports: {
    list(accountId: string): Promise<Report[]>
    respond(req: ReportRespondReq): Promise<void>
  }
  perf: {
    getSnapshot(accountId: string): Promise<Record<string, unknown>[]>
    getCharts(accountId: string): Promise<Record<string, unknown>>
  }
  reviews: {
    list(accountId: string): Promise<ReviewReport[]>
    getReport(id: string): Promise<ReviewReport>
  }
  positions: {
    list(accountId: string): Promise<Position[]>
    upsert(req: PositionUpsertReq): Promise<void>
  }
  trades: {
    list(accountId: string): Promise<TradeRecord[]>
    create(req: TradeCreateReq): Promise<void>
  }
  audit: {
    list(accountId: string, limit?: number): Promise<Record<string, unknown>[]>
    events(accountId: string, limit?: number): Promise<EventLogEntry[]>
  }
  chat: {
    send(req: ChatSendReq): Promise<{ accepted: boolean }>
  }
  runs: {
    list(accountId: string): Promise<RunInstance[]>
  }
  onEvent(cb: (ev: UiEvent) => void): () => void
}
