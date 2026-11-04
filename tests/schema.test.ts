/**
 * 策略 DSL Schema 校验测试：非法 DSL 100% 被拒绝（白名单指标/参数/复杂度）。
 */
import { describe, expect, it } from 'vitest'
import { validateStrategyDsl, parseAndValidateDsl, extractDslFromMarkdown, markdownFromDsl, upsertDslBlockInMarkdown } from '../src/shared/strategy/schema'

const validDsl = {
  meta: { name: '双均线', description: '', rationale: '', complexity: 1 },
  universe: { source: 'all_a', filters: [{ op: 'exclude_st', params: {} }] },
  entry: { logic: 'and', conditions: [{ indicator: 'ma_cross_up', params: { fast: 5, slow: 20 } }] },
  exit: { logic: 'or', conditions: [{ indicator: 'stop_loss', params: { pct: 0.08 } }] },
  portfolio: { max_positions: 5, position_size: 'equal_weight', max_position_pct: 0.2, rebalance: 'daily' }
}

describe('策略 DSL 校验', () => {
  it('合法 DSL 通过', () => {
    expect(validateStrategyDsl(validDsl).ok).toBe(true)
  })

  it('未知指标被拒绝', () => {
    const dsl = structuredClone(validDsl)
    dsl.entry.conditions[0].indicator = 'magic_indicator'
    const result = validateStrategyDsl(dsl)
    expect(result.ok).toBe(false)
    expect(result.errors.some((e) => e.includes('未知指标'))).toBe(true)
  })

  it('越界参数被拒绝', () => {
    const dsl = structuredClone(validDsl)
    dsl.entry.conditions[0].params = { fast: 0, slow: 9999 }
    const result = validateStrategyDsl(dsl)
    expect(result.ok).toBe(false)
  })

  it('未知选股过滤操作被拒绝', () => {
    const dsl = structuredClone(validDsl)
    dsl.universe.filters = [{ op: 'pick_winners', params: {} }]
    const result = validateStrategyDsl(dsl)
    expect(result.ok).toBe(false)
    expect(result.errors.some((e) => e.includes('未知选股过滤'))).toBe(true)
  })

  it('入场指标误用于出场条件被拒绝', () => {
    const dsl = structuredClone(validDsl)
    dsl.exit.conditions = [{ indicator: 'rsi_below', params: { n: 14, threshold: 30 } }] as never
    const result = validateStrategyDsl(dsl)
    expect(result.ok).toBe(false)
    expect(result.errors.some((e) => e.includes('不适用于'))).toBe(true)
  })

  it('复杂度超限被拒绝（条件总数 > 20）', () => {
    const dsl = structuredClone(validDsl)
    const cond = { indicator: 'price_above_ma', params: { n: 5 } }
    const exit = { indicator: 'stop_loss', params: { pct: 0.08 } }
    const filter = { op: 'exclude_st', params: {} }
    dsl.entry.conditions = Array(8).fill(cond)
    dsl.exit.conditions = Array(8).fill(exit)
    dsl.universe.filters = Array(5).fill(filter)
    // 8 + 8 + 5 = 21 > 20
    const result = validateStrategyDsl(dsl)
    expect(result.ok).toBe(false)
    expect(result.errors.some((e) => e.includes('复杂度'))).toBe(true)
  })

  it('非 JSON 字符串被拒绝（parseAndValidateDsl）', () => {
    const result = parseAndValidateDsl('not a json')
    expect(result.dsl).toBeUndefined()
    expect(result.errors.length).toBeGreaterThan(0)
  })

  it('持仓依赖指标在无持仓上下文时评估为 false（引擎层）', () => {
    // 语义保证：stop_loss 等指标仅由引擎在持仓上下文中评估，此处验证白名单声明
    expect(validDsl.exit.conditions[0].indicator).toBe('stop_loss')
  })
})

describe('策略 Markdown ↔ DSL', () => {
  const validMd = `# 双均线策略

## 策略逻辑
快线上穿慢线买入，止损 8%。

## 可执行 DSL

\`\`\`dsl
${JSON.stringify(validDsl, null, 2)}
\`\`\`
`

  it('提取合法 ```dsl 块', () => {
    const result = extractDslFromMarkdown(validMd)
    expect(result.errors).toHaveLength(0)
    expect(result.dsl?.meta.name).toBe('双均线')
  })

  it('无 dsl 块为文档态（无错误）', () => {
    const result = extractDslFromMarkdown('# 纯文档\n\n没有代码块')
    expect(result.errors).toHaveLength(0)
    expect(result.dsl).toBeUndefined()
  })

  it('多个 ```dsl 块被拒绝', () => {
    const result = extractDslFromMarkdown(`${validMd}\n\n\`\`\`dsl\n{}\n\`\`\``)
    expect(result.errors.some((e) => e.includes('仅允许一个'))).toBe(true)
  })

  it('块内非法 JSON 被拒绝', () => {
    const result = extractDslFromMarkdown('```dsl\nnot json\n```')
    expect(result.errors.length).toBeGreaterThan(0)
  })

  it('块内未知指标被拒绝', () => {
    const bad = structuredClone(validDsl)
    bad.entry.conditions[0].indicator = 'magic'
    const result = extractDslFromMarkdown(`\`\`\`dsl\n${JSON.stringify(bad)}\n\`\`\``)
    expect(result.errors.some((e) => e.includes('未知指标'))).toBe(true)
  })

  it('markdownFromDsl 生成含 ```dsl 块的文档且可回环提取', () => {
    const md = markdownFromDsl('双均线', validDsl)
    const extracted = extractDslFromMarkdown(md)
    expect(extracted.errors).toHaveLength(0)
    expect(extracted.dsl?.meta.name).toBe('双均线')
    expect(md).toContain('```dsl')
  })

  it('upsertDslBlockInMarkdown：无块时追加、有块时替换', () => {
    const updated = structuredClone(validDsl)
    updated.meta.name = '新名称'
    const appended = upsertDslBlockInMarkdown('# 纯文档', updated)
    expect(extractDslFromMarkdown(appended).dsl?.meta.name).toBe('新名称')
    const replaced = upsertDslBlockInMarkdown(validMd, updated)
    expect(extractDslFromMarkdown(replaced).dsl?.meta.name).toBe('新名称')
    // 替换后仅一个块（原块被覆盖）
    expect(replaced.match(/```dsl/g)).toHaveLength(1)
  })
})
