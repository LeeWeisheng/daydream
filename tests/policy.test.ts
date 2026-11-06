/**
 * 策略测试（dsh tests/policy.spec.ts 的对应）：
 * 门槛（gate）的强度与依据、接受模式、降级策略、策略版本。
 */
import { describe, expect, it } from 'vitest'
import { makePolicy, policyVersion, matchesVersion } from '../src/main/policy'

describe('Policy 门槛（gate）', () => {
  it('用户消息：明确强度 + addressed 依据', () => {
    const policy = makePolicy({ running: true, runMode: 'manual', autonomyLevel: 'conservative' })
    const gate = policy.gate({ type: 'user.message', source: 'user' })
    expect(gate.admitted).toBe(true)
    expect(gate.strength).toBe('explicit')
    expect(gate.basis).toBe('addressed')
  })

  it('调度节律：推断强度 + schedule 依据', () => {
    const policy = makePolicy({ running: true, runMode: 'manual', autonomyLevel: 'conservative' })
    const gate = policy.gate({ type: 'schedule.plan', source: 'scheduler' })
    expect(gate.admitted).toBe(true)
    expect(gate.strength).toBe('inferred')
    expect(gate.basis).toBe('schedule')
  })

  it('内部事件（工作项完成等）：推断强度 + internal 依据', () => {
    const policy = makePolicy({ running: true, runMode: 'manual', autonomyLevel: 'conservative' })
    const gate = policy.gate({ type: 'correction.completed', source: 'pipeline' })
    expect(gate.admitted).toBe(true)
    expect(gate.strength).toBe('inferred')
    expect(gate.basis).toBe('internal')
  })

  it('停止运行：一律拒绝（not_running）', () => {
    const policy = makePolicy({ running: false, runMode: 'manual', autonomyLevel: 'conservative' })
    expect(policy.gate({ type: 'user.message', source: 'user' }).admitted).toBe(false)
    expect(policy.gate({ type: 'schedule.plan', source: 'scheduler' }).admitted).toBe(false)
  })

  it('接受模式：manual → observe；auto → auto', () => {
    expect(makePolicy({ running: true, runMode: 'manual', autonomyLevel: 'conservative' }).acceptMode).toBe('observe')
    expect(makePolicy({ running: true, runMode: 'auto', autonomyLevel: 'conservative' }).acceptMode).toBe('auto')
  })
})

describe('Policy 降级策略（fallbackFor）', () => {
  it('调度节律失败推迟重试；用户消息直接接单；其余不行动', () => {
    const policy = makePolicy({ running: true, runMode: 'manual', autonomyLevel: 'conservative' })
    expect(policy.fallbackFor('schedule.plan')).toBe('retry_later')
    expect(policy.fallbackFor('schedule.review_weekly')).toBe('retry_later')
    expect(policy.fallbackFor('user.message')).toBe('direct_accept')
    expect(policy.fallbackFor('workitem.failed')).toBe('no_action')
  })
})

describe('策略版本', () => {
  it('运行模式/自主级别决定版本；一致性与否', () => {
    const a = { runMode: 'manual' as const, autonomyLevel: 'conservative' as const }
    const b = { runMode: 'auto' as const, autonomyLevel: 'conservative' as const }
    expect(policyVersion(a)).toBe(policyVersion(a))
    expect(policyVersion(a)).not.toBe(policyVersion(b))
    expect(matchesVersion({ running: true, runMode: 'manual', autonomyLevel: 'conservative' }, policyVersion(a))).toBe(true)
    expect(matchesVersion({ running: true, runMode: 'auto', autonomyLevel: 'conservative' }, policyVersion(a))).toBe(false)
  })
})
