/**
 * 策略 DSL Schema（Zod）与指标白名单 —— 策略安全的核心约束。
 * AI 生成的策略是声明式 JSON，仅可引用白名单指标，由确定性解释引擎执行，
 * 无任意代码执行面（见《实现方案-数据模型与模块设计》§3）。
 */
import { z } from 'zod'

// ---------- 指标白名单 ----------
export interface IndicatorMeta {
  /** 指标名（DSL 中引用的键） */
  name: string
  /** 类别 */
  category: 'trend' | 'momentum' | 'volume' | 'volatility' | 'market' | 'risk'
  /** 适用位置 */
  usage: 'entry' | 'exit' | 'both'
  /** 参数 Schema */
  params: z.ZodObject<Record<string, z.ZodTypeAny>>
  /** 是否需要持仓上下文（建仓价/持有天数） */
  needsPosition?: boolean
  description: string
}

const pNum = (label: string, min: number, max: number): z.ZodNumber =>
  z.number({ invalid_type_error: `${label} 必须是数字` }).min(min).max(max)

export const INDICATOR_WHITELIST: IndicatorMeta[] = [
  // —— 趋势类 ——
  {
    name: 'ma_cross_up',
    category: 'trend',
    usage: 'both',
    params: z.object({ fast: pNum('fast', 1, 250), slow: pNum('slow', 2, 500) }).strict(),
    description: '快线上穿慢线（金叉）'
  },
  {
    name: 'ma_cross_down',
    category: 'trend',
    usage: 'both',
    params: z.object({ fast: pNum('fast', 1, 250), slow: pNum('slow', 2, 500) }).strict(),
    description: '快线下穿慢线（死叉）'
  },
  {
    name: 'price_above_ma',
    category: 'trend',
    usage: 'entry',
    params: z.object({ n: pNum('n', 1, 500) }).strict(),
    description: '收盘价位于 n 日均线上方'
  },
  {
    name: 'price_below_ma',
    category: 'trend',
    usage: 'entry',
    params: z.object({ n: pNum('n', 1, 500) }).strict(),
    description: '收盘价位于 n 日均线下方'
  },
  {
    name: 'boll_break_up',
    category: 'volatility',
    usage: 'entry',
    params: z.object({ n: pNum('n', 5, 250), k: pNum('k', 1, 5) }).strict(),
    description: '收盘价上穿布林上轨'
  },
  // —— 动量类 ——
  {
    name: 'rsi_below',
    category: 'momentum',
    usage: 'entry',
    params: z.object({ n: pNum('n', 2, 100), threshold: pNum('threshold', 0, 100) }).strict(),
    description: 'RSI 低于阈值（超卖）'
  },
  {
    name: 'rsi_above',
    category: 'momentum',
    usage: 'entry',
    params: z.object({ n: pNum('n', 2, 100), threshold: pNum('threshold', 0, 100) }).strict(),
    description: 'RSI 高于阈值（强势）'
  },
  {
    name: 'macd_golden_cross',
    category: 'momentum',
    usage: 'both',
    params: z.object({ fast: pNum('fast', 2, 100), slow: pNum('slow', 3, 200), signal: pNum('signal', 2, 100) }).strict(),
    description: 'MACD 金叉'
  },
  {
    name: 'macd_dead_cross',
    category: 'momentum',
    usage: 'both',
    params: z.object({ fast: pNum('fast', 2, 100), slow: pNum('slow', 3, 200), signal: pNum('signal', 2, 100) }).strict(),
    description: 'MACD 死叉'
  },
  {
    name: 'momentum_gt',
    category: 'momentum',
    usage: 'entry',
    params: z.object({ n: pNum('n', 1, 250), threshold: pNum('threshold', 0, 10) }).strict(),
    description: 'n 日动量（涨跌幅）超过阈值'
  },
  // —— 量价类 ——
  {
    name: 'volume_ratio_gt',
    category: 'volume',
    usage: 'entry',
    params: z.object({ ratio: pNum('ratio', 0.1, 100), n: pNum('n', 1, 250) }).strict(),
    description: '当日成交量超过 n 日均量的 ratio 倍'
  },
  {
    name: 'obv_trend_up',
    category: 'volume',
    usage: 'entry',
    params: z.object({ n: pNum('n', 2, 250) }).strict(),
    description: 'OBV 位于其 n 日均线上方（量能趋势向上）'
  },
  // —— 风控类（退出） ——
  {
    name: 'stop_loss',
    category: 'risk',
    usage: 'exit',
    needsPosition: true,
    params: z.object({ pct: pNum('pct', 0.01, 0.5) }).strict(),
    description: '止损：现价相对建仓价跌幅超过 pct'
  },
  {
    name: 'take_profit',
    category: 'risk',
    usage: 'exit',
    needsPosition: true,
    params: z.object({ pct: pNum('pct', 0.01, 5) }).strict(),
    description: '止盈：现价相对建仓价涨幅超过 pct'
  },
  {
    name: 'max_holding_days',
    category: 'risk',
    usage: 'exit',
    needsPosition: true,
    params: z.object({ days: pNum('days', 1, 500) }).strict(),
    description: '最长持有天数，到期离场'
  }
]

export const INDICATOR_NAMES: ReadonlySet<string> = new Set(INDICATOR_WHITELIST.map((m) => m.name))

// ---------- 选股域过滤白名单 ----------
export const UNIVERSE_FILTERS: ReadonlySet<string> = new Set([
  'exclude_st', // 排除 ST/*ST
  'exclude_stop', // 排除近期停牌
  'liquidity_min' // 成交额下限（n 日均额）
])

// ---------- Zod Schema ----------
const conditionSchema = z
  .object({
    indicator: z.string(),
    params: z.record(z.union([z.number(), z.string(), z.boolean()]))
  })
  .strict()

const filterSchema = z
  .object({
    op: z.string(),
    params: z.record(z.union([z.number(), z.string(), z.boolean()])).default({})
  })
  .strict()

export const strategyDslSchema = z
  .object({
    meta: z
      .object({
        name: z.string().min(1).max(64),
        description: z.string().max(500).default(''),
        rationale: z.string().max(2000).default(''),
        complexity: z.number().int().min(1).max(10).default(1)
      })
      .strict(),
    universe: z
      .object({
        source: z.enum(['all_a']).default('all_a'),
        filters: z.array(filterSchema).max(10).default([])
      })
      .strict(),
    entry: z
      .object({
        logic: z.enum(['and', 'or']).default('and'),
        conditions: z.array(conditionSchema).min(0).max(8)
      })
      .strict(),
    exit: z
      .object({
        logic: z.enum(['and', 'or']).default('or'),
        conditions: z.array(conditionSchema).min(0).max(8)
      })
      .strict(),
    portfolio: z
      .object({
        max_positions: z.number().int().min(1).max(50),
        position_size: z.enum(['equal_weight', 'equal_cash']).default('equal_weight'),
        max_position_pct: z.number().min(0.01).max(1),
        rebalance: z.enum(['daily', 'weekly']).default('daily')
      })
      .strict()
  })
  .strict()

export type StrategyDSL = z.infer<typeof strategyDslSchema>
export type DslCondition = z.infer<typeof conditionSchema>
export type DslFilter = z.infer<typeof filterSchema>

// ---------- 校验器 ----------
export interface DslValidationResult {
  ok: boolean
  errors: string[]
}

/**
 * 校验策略 DSL：结构合法 + 指标在白名单 + 参数通过指标参数 Schema +
 * 过滤操作在白名单 + 复杂度惩罚（条件总数上限）。
 */
export function validateStrategyDsl(dsl: unknown): DslValidationResult {
  const errors: string[] = []
  const parsed = strategyDslSchema.safeParse(dsl)
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`)
    }
  }
  const v = parsed.data

  const checkConditions = (conds: DslCondition[], usage: 'entry' | 'exit'): void => {
    for (const c of conds) {
      const meta = INDICATOR_WHITELIST.find((m) => m.name === c.indicator)
      if (!meta) {
        errors.push(`未知指标「${c.indicator}」（不在白名单内）`)
        continue
      }
      if (meta.usage !== 'both' && meta.usage !== usage) {
        errors.push(`指标「${c.indicator}」不适用于 ${usage === 'entry' ? '入场' : '出场'}条件`)
      }
      const paramsResult = meta.params.safeParse(c.params)
      if (!paramsResult.success) {
        errors.push(`指标「${c.indicator}」参数非法: ${paramsResult.error.issues.map((i) => i.message).join('; ')}`)
      }
    }
  }
  checkConditions(v.entry.conditions, 'entry')
  checkConditions(v.exit.conditions, 'exit')

  for (const f of v.universe.filters) {
    if (!UNIVERSE_FILTERS.has(f.op)) {
      errors.push(`未知选股过滤操作「${f.op}」`)
    }
  }

  const totalConditions = v.entry.conditions.length + v.exit.conditions.length + v.universe.filters.length
  if (totalConditions > 20) {
    errors.push(`复杂度超限：条件总数 ${totalConditions} > 20（复杂度惩罚）`)
  }

  return { ok: errors.length === 0, errors }
}

/** 解析 DSL JSON 字符串并校验，返回 DSL 或错误信息 */
export function parseAndValidateDsl(dslJson: string): { dsl?: StrategyDSL; errors: string[] } {
  let parsed: unknown
  try {
    parsed = JSON.parse(dslJson)
  } catch (e) {
    return { errors: [`DSL 不是合法 JSON: ${(e as Error).message}`] }
  }
  const result = validateStrategyDsl(parsed)
  if (!result.ok) return { errors: result.errors }
  return { dsl: parsed as StrategyDSL, errors: [] }
}

// ---------- 策略 Markdown（文档主载体，内嵌 ```dsl 代码块作为可执行部分） ----------

/** ```dsl 代码块（唯一允许一个） */
const DSL_BLOCK_RE = /```dsl\s*\n([\s\S]*?)\n```/g

/**
 * 从策略 Markdown 提取可执行 DSL：
 * - 无 dsl 代码块 → 返回空 dsl（纯文档态，不参与确定性执行），无错误；
 * - 存在多个块或块内 JSON 非法/未通过白名单校验 → 返回错误。
 */
export function extractDslFromMarkdown(markdown: string): { dsl?: StrategyDSL; errors: string[] } {
  const matches = Array.from(markdown.matchAll(DSL_BLOCK_RE))
  if (matches.length === 0) return { errors: [] }
  if (matches.length > 1) return { errors: ['策略文档中存在多个 ```dsl 代码块，仅允许一个'] }
  const code = matches[0][1] ?? ''
  let parsed: unknown
  try {
    parsed = JSON.parse(code)
  } catch (e) {
    return { errors: [`dsl 代码块不是合法 JSON: ${(e as Error).message}`] }
  }
  const result = validateStrategyDsl(parsed)
  if (!result.ok) return { errors: result.errors }
  return { dsl: parsed as StrategyDSL, errors: [] }
}

/** 条件列表 → markdown 列表行 */
function conditionsToMarkdown(conds: DslCondition[]): string {
  if (conds.length === 0) return '- （暂无）'
  return conds
    .map((c) => {
      const params = Object.entries(c.params)
        .map(([k, v]) => `${k}=${String(v)}`)
        .join('，')
      return `- ${c.indicator}${params ? `（${params}）` : ''}`
    })
    .join('\n')
}

/** 由 DSL 生成策略 Markdown（默认模板播种 / 需要重建文档的场景） */
export function markdownFromDsl(name: string, dsl: StrategyDSL, rationale = ''): string {
  const filters = dsl.universe.filters.length
    ? dsl.universe.filters.map((f) => `- ${f.op}${Object.keys(f.params).length ? `（${Object.entries(f.params).map(([k, v]) => `${k}=${String(v)}`).join('，')}）` : ''}`).join('\n')
    : '- （无）'
  return [
    `# ${name}`,
    '',
    '> 本策略文档为 Markdown 文本，可自由编辑；```dsl 代码块是可执行部分（由确定性引擎解释执行，仅支持白名单指标）。',
    '',
    '## 策略逻辑',
    '',
    dsl.meta.description || '（待补充：策略思路与逻辑说明）',
    '',
    `理由：${dsl.meta.rationale || rationale || '（待补充）'} `,
    '',
    '## 选股域',
    '',
    filters,
    '',
    '## 入场条件',
    '',
    `逻辑：${dsl.entry.logic === 'and' ? '且（AND）' : '或（OR）'}`,
    '',
    conditionsToMarkdown(dsl.entry.conditions),
    '',
    '## 出场条件',
    '',
    `逻辑：${dsl.exit.logic === 'and' ? '且（AND）' : '或（OR）'}`,
    '',
    conditionsToMarkdown(dsl.exit.conditions),
    '',
    '## 组合约束',
    '',
    `- 最大持仓数：${dsl.portfolio.max_positions}`,
    `- 仓位方式：${dsl.portfolio.position_size === 'equal_weight' ? '等权' : '等额资金'}`,
    `- 单票仓位上限：${dsl.portfolio.max_position_pct}`,
    `- 再平衡：${dsl.portfolio.rebalance === 'daily' ? '每日' : '每周'}`,
    '',
    '## 可执行 DSL',
    '',
    '```dsl',
    JSON.stringify(dsl, null, 2),
    '```',
    ''
  ].join('\n')
}

/** 替换/追加文档中的 ```dsl 代码块（用于纠正等只改执行层的场景，保留手写内容） */
export function upsertDslBlockInMarkdown(markdown: string, dsl: StrategyDSL): string {
  const block = ['```dsl', JSON.stringify(dsl, null, 2), '```'].join('\n')
  if (!DSL_BLOCK_RE.test(markdown)) {
    const trailer = markdown.endsWith('\n') ? '' : '\n'
    return `${markdown}${trailer}\n## 可执行 DSL\n\n${block}\n`
  }
  return markdown.replace(DSL_BLOCK_RE, block)
}

// ---------- 用户偏好 Schema（仅用户可改） ----------
export const notifyPrefsSchema = z
  .object({
    signals: z.boolean(),
    alerts: z.boolean(),
    summaries: z.boolean(),
    quietHours: z.string().regex(/^\d{2}:\d{2}-\d{2}:\d{2}$/).default('22:00-08:00')
  })
  .strict()

export const preferencesSchema = z
  .object({
    riskTolerance: z.enum(['conservative', 'moderate', 'aggressive']),
    investmentStyle: z.enum(['value', 'growth', 'trend', 'blend']),
    expectedAnnualReturn: z.number().min(0).max(10),
    maxDrawdownTolerance: z.number().min(0.01).max(0.9),
    holdingPeriod: z.enum(['short', 'swing', 'long']),
    preferredIndustries: z.array(z.string().max(50)).max(20),
    excludedIndustries: z.array(z.string().max(50)).max(20),
    maxPositions: z.number().int().min(1).max(50),
    maxPositionPct: z.number().min(0.01).max(1),
    maxTotalPositionPct: z.number().min(0.01).max(1),
    tradeFrequency: z.enum(['low', 'medium', 'high']),
    autonomyLevel: z.enum(['conservative', 'standard', 'aggressive']),
    notify: notifyPrefsSchema
  })
  .strict()

export type StrategyPreferences = z.infer<typeof preferencesSchema>

/** 校验用户偏好（返回错误列表，空数组即合法） */
export function validatePreferences(prefs: unknown): string[] {
  const parsed = preferencesSchema.safeParse(prefs)
  if (parsed.success) return []
  return parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`)
}
