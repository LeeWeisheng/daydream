/**
 * Intake：事件的接收（dsh src/core/intake.ts 的对应）。
 * 规则：
 * - 幂等：同一 Trigger ID 只入一次（重复返回 duplicate）；
 * - 过滤：不满足准入门槛的事件记录为 filtered（落库留痕，不评估）；
 * - UI-only 事件（如预警、对话流推送）仅落库，不进评估（零 token）；
 * - 其余事件挂到账户线程排队评估（每账户一个 Thread，串行）。
 */
import type { Trigger } from './model'
import { EnginePart } from './part'
import type { Thread } from './model'

export type IntakeResult = 'stored' | 'duplicate' | 'filtered' | 'ui-only'

export class Intake extends EnginePart {
  /** 仅 UI/审计的事件：不进入 LLM 评估（节省 token）。规则由确定性管线预先配置。 */
  private static readonly UI_ONLY = new Set(['alert.triggered', 'chat.message', 'signal.new', 'data.progress'])

  /** 接收一个事件：落库 + 过滤 + 入队。 */
  receive(trigger: Trigger, thread: Thread): IntakeResult {
    if (this.repo.triggers.has(trigger.id)) return 'duplicate'
    if (Intake.UI_ONLY.has(trigger.type)) {
      trigger.disposition = 'ui-only'
      this.repo.triggers.add(trigger)
      this.emit({ name: 'trigger.received', accountId: trigger.accountId, triggerId: trigger.id, payload: { type: trigger.type, uiOnly: true }, at: trigger.occurredAt })
      return 'ui-only'
    }
    const gate = this.policy.gate(trigger)
    if (!gate.admitted) {
      trigger.disposition = 'filtered'
      this.repo.triggers.add(trigger)
      this.emit({
        name: 'trigger.filtered',
        accountId: trigger.accountId,
        triggerId: trigger.id,
        payload: { type: trigger.type, reason: gate.reasonCode ?? 'not_admitted' },
        at: trigger.occurredAt
      })
      return 'filtered'
    }
    trigger.disposition = 'stored'
    this.repo.triggers.add(trigger)
    thread.queued.push(trigger)
    thread.lastTriggerAt = trigger.occurredAt
    this.emit({ name: 'trigger.received', accountId: trigger.accountId, triggerId: trigger.id, payload: { type: trigger.type }, at: trigger.occurredAt })
    return 'stored'
  }
}
