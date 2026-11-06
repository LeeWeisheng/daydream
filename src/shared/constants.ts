/**
 * 共享常量：A 股交易规则、涨跌停、费用、交易时段与交易日历。
 * 全部交易节律基于 Asia/Shanghai（北京时间），与机器本地时区无关。
 */

// ---------- 交易时段（北京时间） ----------
export const MARKET_OPEN = '09:30'
export const MARKET_CLOSE = '15:00'
export const MORNING_SESSION: [string, string] = ['09:30', '11:30']
export const AFTERNOON_SESSION: [string, string] = ['13:00', '15:00']

// ---------- 涨跌停规则 ----------
export const LIMIT_MAIN_BOARD = 0.1 // 主板 ±10%
export const LIMIT_GEM_STAR = 0.2 // 创业板/科创板 ±20%
export const LIMIT_BSE = 0.3 // 北交所 ±30%
export const LIMIT_ST_MAIN = 0.05 // 主板 ST ±5%

/** 按代码与名称判断涨跌停幅度（创业板/科创板 ST 维持板块涨跌幅） */
export function priceLimitRate(code: string, name: string): number {
  const isST = name.includes('ST')
  if (code.startsWith('30') || code.startsWith('68')) return LIMIT_GEM_STAR
  if (code.startsWith('8') || code.startsWith('4') || code.startsWith('92')) return LIMIT_BSE
  if (isST) return LIMIT_ST_MAIN
  return LIMIT_MAIN_BOARD
}

/** 涨停价/跌停价（四舍五入到分） */
export function limitPrices(code: string, name: string, prevClose: number): { up: number; down: number } {
  const rate = priceLimitRate(code, name)
  const round = (v: number): number => Math.round(v * 100) / 100
  return { up: round(prevClose * (1 + rate)), down: round(prevClose * (1 - rate)) }
}

// ---------- 交易费用默认值 ----------
export const DEFAULT_FEES = {
  commissionRate: 0.00025, // 佣金 万 2.5
  minCommission: 5, // 最低佣金 5 元
  stampTaxRate: 0.0005, // 印花税（仅卖出）0.05%
  transferFeeRate: 0.00001 // 过户费（沪深双向）0.001%
} as const

/** 费用参数（可配，默认值为 A 股现行标准） */
export interface FeeParams {
  commissionRate: number
  minCommission: number
  stampTaxRate: number
  transferFeeRate: number
}

/** 计算交易费用 */
export function calcFee(side: 'buy' | 'sell', amount: number, fees: FeeParams = DEFAULT_FEES): number {
  const commission = Math.max(amount * fees.commissionRate, fees.minCommission)
  const transfer = amount * fees.transferFeeRate
  const stamp = side === 'sell' ? amount * fees.stampTaxRate : 0
  return Math.round((commission + transfer + stamp) * 100) / 100
}

// ---------- 交易单位 ----------
export const LOT_SIZE = 100 // 一手 100 股

// ---------- 交易日历 ----------
// 内置节假日表（不含周末），覆盖 2025~2027 主要法定休市日。
// 官方安排可能调整：实际运行时由指数数据（index_daily）缺失日自动校正兜底。
export const HOLIDAYS: ReadonlySet<string> = new Set([
  // 2025
  '2025-01-01', '2025-01-28', '2025-01-29', '2025-01-30', '2025-01-31', '2025-02-03', '2025-02-04',
  '2025-04-04', '2025-05-01', '2025-05-02', '2025-05-05', '2025-06-02', '2025-10-01', '2025-10-02',
  '2025-10-03', '2025-10-06', '2025-10-07', '2025-10-08',
  // 2026（按国务院惯例预估，待官方公布后校正）
  '2026-01-01', '2026-01-02', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20', '2026-02-23',
  '2026-04-06', '2026-05-01', '2026-05-04', '2026-05-05', '2026-06-19', '2026-09-25', '2026-10-01',
  '2026-10-02', '2026-10-05', '2026-10-06', '2026-10-07',
  // 2027
  '2027-01-01', '2027-02-08', '2027-02-09', '2027-02-10', '2027-02-11', '2027-02-12', '2027-02-15',
  '2027-04-05', '2027-05-03', '2027-05-04', '2027-05-05', '2027-06-11', '2027-10-01', '2027-10-04',
  '2027-10-05', '2027-10-06', '2027-10-07'
])

/** 判断某日期（YYYY-MM-DD）是否交易日（不含调休补班日——补班日由指数数据校正） */
export function isTradingDay(dateStr: string): boolean {
  const d = new Date(`${dateStr}T00:00:00Z`)
  const day = d.getUTCDay()
  if (day === 0 || day === 6) return false
  return !HOLIDAYS.has(dateStr)
}

/** 判断当前北京时间是否处于盘中连续竞价时段 */
export function isMarketOpenNow(): boolean {
  const now = shanghaiNow()
  const hm = toHM(now)
  const inRange = ([start, end]: [string, string]): boolean => hm >= start && hm <= end
  return inRange(MORNING_SESSION) || inRange(AFTERNOON_SESSION)
}

// ---------- 北京时间工具（Asia/Shanghai = UTC+8，无夏令时） ----------
const SH_OFFSET_MS = 8 * 3600 * 1000

/** 当前北京时间对应的 Date（用 UTC 字段承载上海时间） */
export function shanghaiNow(): Date {
  return new Date(Date.now() + SH_OFFSET_MS)
}

/** 格式化为 YYYY-MM-DD（上海时间） */
export function shanghaiDateStr(d: Date = shanghaiNow()): string {
  return d.toISOString().slice(0, 10)
}

/** 格式化为 HH:mm（上海时间） */
export function toHM(d: Date): string {
  return d.toISOString().slice(11, 16)
}

/** 从 YYYY-MM-DD 解析为 UTC 基准日期 */
export function parseDateStr(s: string): Date {
  return new Date(`${s}T00:00:00Z`)
}

/** 日期字符串加减天数 */
export function addDays(dateStr: string, days: number): string {
  const d = parseDateStr(dateStr)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

// ---------- 默认调度时间（北京时间） ----------
export const SCHEDULE = {
  planTime: '08:30', // 每日盘前轻量规划
  planWeeklyTime: '08:30', // 每周五深度规划
  runnerTime: '15:05', // 盘后运行决策（用收盘实时快照）
  dataUpdateTime: '16:30', // 日线增量入库
  reviewDailyTime: '17:00', // 日复盘（数据入库后）
  reviewWeeklyTime: '17:30', // 周五周复盘
  monitorIntervalMinutes: 2 // 盘中盯盘间隔（可配）
} as const

// ---------- 账户资金 ----------
export const DEFAULT_INITIAL_CASH = 100_000 // 新账户默认可用资金

// ---------- 模型内置预设（选择后自动填充 baseURL / 模型名 / 上下文等） ----------
export const MODEL_PRESETS = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/anthropic',
    model: 'deepseek-chat',
    modelPro: 'deepseek-reasoner',
    contextWindow: 128000,
    maxCallsPerHour: 100
  },
  {
    id: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    modelPro: 'gpt-4o',
    contextWindow: 128000,
    maxCallsPerHour: 100
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-sonnet-4-20250514',
    modelPro: 'claude-opus-4-20250514',
    contextWindow: 200000,
    maxCallsPerHour: 100
  },
  {
    id: 'moonshot',
    name: 'Moonshot 月之暗面',
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'moonshot-v1-8k',
    modelPro: 'moonshot-v1-32k',
    contextWindow: 32768,
    maxCallsPerHour: 80
  },
  {
    id: 'qwen',
    name: '通义千问 Qwen',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
    modelPro: 'qwen-max',
    contextWindow: 131072,
    maxCallsPerHour: 100
  },
  {
    id: 'zhipu',
    name: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4-flash',
    modelPro: 'glm-4-plus',
    contextWindow: 128000,
    maxCallsPerHour: 80
  },
  {
    id: 'siliconflow',
    name: '硅基流动 SiliconFlow',
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'deepseek-ai/DeepSeek-V3',
    modelPro: 'deepseek-ai/DeepSeek-R1',
    contextWindow: 65536,
    maxCallsPerHour: 100
  }
] as const

// ---------- 默认用户偏好（账户创建时写入默认策略文档的「用户偏好」段落） ----------
export const DEFAULT_PREFERENCES = {
  riskTolerance: 'moderate',
  investmentStyle: 'trend',
  expectedAnnualReturn: 0.15,
  maxDrawdownTolerance: 0.15,
  holdingPeriod: 'swing',
  preferredIndustries: [],
  excludedIndustries: [],
  maxPositions: 5,
  maxPositionPct: 0.2,
  maxTotalPositionPct: 0.8,
  tradeFrequency: 'medium',
  autonomyLevel: 'conservative',
  notify: { signals: true, alerts: true, summaries: true, quietHours: '22:00-08:00' }
} as const

/** 默认用户偏好 → Markdown 段落（策略文档的组成部分） */
export function defaultPreferencesMarkdown(): string {
  const labels = {
    conservative: '保守',
    moderate: '稳健',
    aggressive: '激进',
    value: '价值投资',
    growth: '成长投资',
    trend: '趋势跟踪',
    blend: '均衡配置',
    short: '短线',
    swing: '波段',
    long: '中长线',
    low: '低频',
    medium: '中频',
    high: '高频'
  } as const
  const p = DEFAULT_PREFERENCES
  return [
    `- 风险偏好：${labels[p.riskTolerance]}`,
    `- 投资风格：${labels[p.investmentStyle]}`,
    `- 期望年化收益：${Math.round(p.expectedAnnualReturn * 100)}%`,
    `- 最大可承受回撤：${Math.round(p.maxDrawdownTolerance * 100)}%`,
    `- 持股周期：${labels[p.holdingPeriod]}`,
    `- 偏好行业：${p.preferredIndustries.length ? p.preferredIndustries.join('、') : '（不限）'}`,
    `- 排除行业：${p.excludedIndustries.length ? p.excludedIndustries.join('、') : '（无）'}`,
    `- 最大持仓数：${p.maxPositions}`,
    `- 单票仓位上限：${Math.round(p.maxPositionPct * 100)}%`,
    `- 总仓位上限：${Math.round(p.maxTotalPositionPct * 100)}%`,
    `- 交易频率：${labels[p.tradeFrequency]}`
  ].join('\n')
}

/**
 * 默认策略文档模板（账户创建时播种，纯 Markdown 文本，无任何 DSL）。
 * 文档 = 交易策略 + 用户偏好 + 风控纪律 + 信号标准，是注入 Agent 的系统提示词主体。
 */
export function buildDefaultStrategyMarkdown(accountName: string): string {
  return [
    `# ${accountName} 的投资策略`,
    '',
    '> 本文档是 Agent 的核心工作依据：既包含交易策略，也包含用户偏好、风控纪律与信号标准。',
    '> 由 Agent 或用户在需要时迭代更新（每次更新产生新版本）。',
    '',
    '## 策略概述',
    '',
    '（待补充：一句话概括策略思路，如「基于均线趋势跟随，控制回撤，波段操作」。）',
    '',
    '## 市场判断框架',
    '',
    '- 指数环境：关注沪深 300 与全市场涨跌家数，单边急跌时降仓或空仓。',
    '- 风格与板块：结合政策与资金流向选择方向，不追高、不抄底。',
    '',
    '## 选股域',
    '',
    '- 排除 ST/*ST 与长期停牌标的。',
    '- 优先流动性充足的标的（近 20 日均成交额充足）。',
    '',
    '## 入场条件',
    '',
    '- （待补充：明确可量化的入场信号，如均线金叉、放量突破、回踩支撑等。）',
    '',
    '## 出场条件',
    '',
    '- （待补充：止盈、止损、持有期限与卖出信号。）',
    '',
    '## 组合约束',
    '',
    '- 最大持仓数：5',
    '- 单票仓位上限：20%',
    '- 总仓位上限：80%',
    '',
    '## 用户偏好',
    '',
    defaultPreferencesMarkdown(),
    '',
    '## 风控与执行纪律',
    '',
    '- 所有交易建议必须通过风控检查（涨跌停、仓位上限、单日信号数等）。',
    '- 单票止损与止盈目标在信号说明（basis）中写明。',
    '- 不确定时宁可不出信号；一切结论基于真实行情数据。',
    '',
    '## 信号标准',
    '',
    '- 仅在满足入场/出场条件、且风控通过时产出交易建议（信号）。',
    '- 每个信号附带触发依据（basis）与参考价格。'
  ].join('\n')
}
