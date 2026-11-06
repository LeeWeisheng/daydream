/**
 * IPC 通道与请求/响应类型声明（主进程 handler 与 preload API 共同引用）。
 * 命名规范：`域:动作`；主进程 → 渲染进程统一走 `daydream:event` 事件流。
 */
import type {
  Account,
  AccountSummary,
  Alert,
  Bar,
  ChatMessage,
  ModelConfig,
  ModelPreset,
  Position,
  Report,
  RunMode,
  Signal,
  StockBasic,
  Strategy,
  StrategyStats,
  StrategyVersion,
  ThemeMode,
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
  accountRename: 'account:rename',
  // 设置
  settingsGet: 'settings:get',
  settingsUpdate: 'settings:update',
  // 主题
  themeGet: 'theme:get',
  themeSet: 'theme:set',
  // 运行模式（manual 手动 / auto 自动：自动处理审批与信号，用于策略验证）
  runModeGet: 'runMode:get',
  runModeSet: 'runMode:set',
  // 窗口控制（自绘标题栏）
  windowMinimize: 'window:minimize',
  windowToggleMaximize: 'window:toggleMaximize',
  windowClose: 'window:close',
  windowIsMaximized: 'window:isMaximized',
  windowIsFullScreen: 'window:isFullScreen',
  // 行情数据
  dataGetKline: 'data:getKline',
  dataGetQuote: 'data:getQuote',
  dataGetStockList: 'data:getStockList',
  dataGetIndexDaily: 'data:getIndexDaily',
  dataGetDataStatus: 'data:getDataStatus',
  dataGetDataStats: 'data:getDataStats',
  dataInitialSync: 'data:initialSync',
  dataDailyUpdate: 'data:dailyUpdate',
  // 数据 CRUD（Agent 运行时可用）
  dataUpsertStock: 'data:upsertStock',
  dataDeleteStock: 'data:deleteStock',
  dataUpsertKline: 'data:upsertKline',
  dataDeleteKline: 'data:deleteKline',
  // 策略（每账户唯一一份：Markdown 纯文本 = 交易策略 + 用户偏好，注入 Agent 系统提示词）
  strategyGetForAccount: 'strategy:getForAccount',
  strategySave: 'strategy:save',
  strategyGetVersions: 'strategy:getVersions',
  strategySetActiveVersion: 'strategy:setActiveVersion',
  // 交易（人工录入，联动资金与持仓）
  tradeOrder: 'trade:order',
  tradeList: 'trade:list',
  tradeAccountSummary: 'trade:accountSummary',
  tradeSetInitialCash: 'trade:setInitialCash',
  // 信号
  signalList: 'signal:list',
  signalFeedback: 'signal:feedback',
  // 持仓
  positionList: 'position:list',
  positionUpsert: 'position:upsert',
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
  // 对话流
  chatSend: 'chat:send',
  chatList: 'chat:list',
  // 审计事件（规划页事件流水）
  eventList: 'event:list',
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
export interface AccountRenameReq {
  accountId: string
  name: string
}

export interface SettingsPatch {
  modelConfig?: ModelConfig
  monitorIntervalMinutes?: number
  dataSourcePreference?: string
  initYears?: number
}

export interface StrategySaveReq {
  accountId: string
  /** 完整策略文档（Markdown 纯文本：交易策略 + 用户偏好等全部信息；新版本立即生效） */
  markdown: string
  /** 简短标题（Agent 更新时由大模型生成；用户编辑可选，缺省保留现有标题） */
  title?: string
  /** 一句话变更记录（Agent 更新必填） */
  changeLog?: string
  actor: 'user' | 'agent'
}

export interface TradeOrderReq {
  accountId: string
  code: string
  side: 'buy' | 'sell'
  price: number
  qty: number
  fee?: number
  tradedAt?: string
  signalId?: string
  note?: string
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

export interface ChatSendReq {
  accountId: string
  message: string
}

export interface ChatListOpts {
  limit?: number
  /** 向上翻页游标：拉取比该消息更早的一页 */
  before?: { createdAt: string; rowid: number }
  /** 增量拉取：比该消息更新的消息 */
  after?: { createdAt: string; rowid: number }
}

export interface StockUpsertReq {
  code: string
  name: string
  exchange: 'SH' | 'SZ' | 'BJ'
  industry?: string
  status?: string
}

export interface KlineUpsertReq {
  code: string
  date: string
  open: number
  high: number
  low: number
  close: number
  volume: number
  amount: number
  adjFactor?: number
}

// ---------- preload 暴露的 API 形状 ----------
export interface DaydreamApi {
  accounts: {
    list(): Promise<Account[]>
    create(req: AccountCreateReq): Promise<Account>
    switchTo(req: AccountSwitchReq): Promise<Account>
    rename(req: AccountRenameReq): Promise<Account>
    remove(accountId: string): Promise<void>
  }
  settings: {
    get(accountId: string): Promise<{
      modelConfig?: ModelConfig
      presets: ModelPreset[]
      theme: ThemeMode
      modelConfigured: boolean
      monitorIntervalMinutes?: number
      dataSourcePreference?: string
    }>
    update(patch: SettingsPatch): Promise<void>
  }
  theme: {
    get(): Promise<ThemeMode>
    set(mode: ThemeMode): Promise<ThemeMode>
  }
  runMode: {
    get(): Promise<RunMode>
    set(mode: RunMode): Promise<RunMode>
  }
  window: {
    minimize(): Promise<void>
    toggleMaximize(): Promise<boolean>
    close(): Promise<void>
    isMaximized(): Promise<boolean>
    isFullScreen(): Promise<boolean>
  }
  data: {
    getStockList(): Promise<StockBasic[]>
    getQuote(codes: string[]): Promise<{ code: string; name: string; price: number; pctChg: number; ts: string }[]>
    getKline(code: string, start: string, end: string): Promise<Bar[]>
    getIndexDaily(code: string, start: string, end: string): Promise<Bar[]>
    getDataStatus(): Promise<Record<string, unknown>[]>
    getDataStats(): Promise<Record<string, unknown>>
    initialSync(): Promise<{ started: boolean }>
    dailyUpdate(): Promise<{ started: boolean }>
    upsertStock(req: StockUpsertReq): Promise<void>
    deleteStock(code: string): Promise<void>
    upsertKline(req: KlineUpsertReq): Promise<void>
    deleteKline(code: string, date: string): Promise<void>
  }
  strategy: {
    getForAccount(accountId: string): Promise<Strategy | null>
    save(req: StrategySaveReq): Promise<Strategy>
    getVersions(strategyId: string): Promise<StrategyVersion[]>
    /** 设置生效版本：versionId 为 null 表示恢复默认（使用最新版本） */
    setActiveVersion(accountId: string, versionId: string | null): Promise<Strategy>
  }
  trades: {
    order(req: TradeOrderReq): Promise<void>
    list(accountId: string): Promise<TradeRecord[]>
    accountSummary(accountId: string): Promise<AccountSummary>
    setInitialCash(accountId: string, cash: number): Promise<void>
  }
  signals: {
    list(accountId: string, limit?: number): Promise<Signal[]>
    feedback(req: SignalFeedbackReq): Promise<void>
  }
  positions: {
    list(accountId: string): Promise<Position[]>
    upsert(req: PositionUpsertReq): Promise<void>
  }
  alerts: {
    list(accountId: string): Promise<Alert[]>
    acknowledge(alertId: string): Promise<void>
  }
  agent: {
    getWorkItems(accountId: string): Promise<WorkItem[]>
    retryWorkItem(id: string): Promise<void>
    cancelWorkItem(id: string): Promise<void>
    getPlan(accountId: string): Promise<Record<string, unknown>[]>
    getStatus(): Promise<{ active: boolean; running: boolean; lastTickAt?: string }>
    start(): Promise<void>
    stop(): Promise<void>
  }
  reports: {
    list(accountId: string): Promise<Report[]>
    respond(req: ReportRespondReq): Promise<void>
  }
  chat: {
    send(req: ChatSendReq): Promise<{ accepted: boolean }>
    list(accountId: string, opts?: ChatListOpts): Promise<{ messages: ChatMessage[]; hasMore: boolean }>
  }
  events: {
    list(accountId: string, limit?: number): Promise<{ id: number; type: string; payloadJson: string; occurredAt: string }[]>
  }
  onEvent(cb: (ev: UiEvent) => void): () => void
}

export type { StrategyStats }
