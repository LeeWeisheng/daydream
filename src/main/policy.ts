/**
 * 策略（Policy）：授权与准入规则（dsh src/policy.ts 的对应）。
 * Daydream 的策略元素：
 * - 运行开关（running）：全局；停止后一切事件不评估（对话仍可用，仅不入 Agent）；
 * - 运行模式（run_mode）：manual（观察模式 observe）→ 审批类决策需人工批准；
 *   auto（自动模式 auto）→ 审批自动执行（策略验证场景，交易边界不变）；
 * - 自主级别（autonomy_level，账户偏好）：保守/标准/激进（纠正动作的证据门槛）；
 * - 门槛（gate）：确定性第一层——事件是否准入、以何强度与依据；
 * - 降级（fallback）：评估失败时按事件类型的默认策略。
 *
 * 策略版本 = run_mode + autonomy_level 的哈希；Mandate 记录它，
 * 版本变更作废进行中的 Eval（engine.policyChanged）。
 */
import { createHash } from 'node:crypto'
import type { PolicyGateResult, Policy as PolicyPort } from './core/ports'

export type RunMode = 'manual' | 'auto'
export type AutonomyLevel = 'conservative' | 'standard' | 'aggressive'

export interface PolicySettings {
  running: boolean
  runMode: RunMode
  autonomyLevel: AutonomyLevel
}

/** 用户消息：明确请求（addressed，explicit 强度） */
const EXPLICIT_TYPES = new Set(['user.message'])
/** 调度节律：推断强度（schedule 依据） */
const SCHEDULE_TYPES = new Set([
  'schedule.plan',
  'schedule.plan_weekly',
  'schedule.review_daily',
  'schedule.review_weekly',
  'market.open',
  'market.close',
  'data.updated'
])

/** 构建一个无状态的 Policy（每次使用取最新设置） */
export function makePolicy(settings: PolicySettings): PolicyPort {
  const version = policyVersion(settings)
  return {
    version,
    running: settings.running,
    acceptMode: settings.runMode === 'auto' ? 'auto' : 'observe',
    gate(trigger): PolicyGateResult {
      if (!settings.running) {
        return { admitted: false, strength: 'inferred', basis: 'internal', reasonCode: 'not_running' }
      }
      if (EXPLICIT_TYPES.has(trigger.type)) {
        return { admitted: true, strength: 'explicit', basis: 'addressed' }
      }
      if (SCHEDULE_TYPES.has(trigger.type)) {
        return { admitted: true, strength: 'inferred', basis: 'schedule' }
      }
      // 内部事件（工作项完成/回测完成/纠正完成等）：推断强度、internal 依据
      return { admitted: true, strength: 'inferred', basis: 'internal' }
    },
    fallbackFor(type) {
      // 评估失败降级：规划/复盘事件推迟重试；用户消息直接接单；其余不行动
      if (SCHEDULE_TYPES.has(type)) return 'retry_later'
      if (EXPLICIT_TYPES.has(type)) return 'direct_accept'
      return 'no_action'
    }
  }
}

/** 策略版本：运行模式 + 自主级别（规则集暂为空，保留扩展位） */
export function policyVersion(settings: { runMode: RunMode; autonomyLevel: AutonomyLevel }): string {
  return createHash('sha256').update(`${settings.runMode}:${settings.autonomyLevel}`).digest('hex').slice(0, 12)
}

/** 策略是否与给定版本一致（Mandate 重校验用） */
export function matchesVersion(settings: PolicySettings, version: string): boolean {
  return policyVersion(settings) === version
}
