/**
 * Evals：账户线程的评估与决策（dsh src/core/evals.ts 的对应）。
 * 规则（docs/002-authorization.md / docs/003-execution.md 的 Daydream 对应）：
 * - 每账户一个 Thread，同一时刻至多一个 Eval（串行），期间到达的事件并入下一批；
 * - 两层评估：gate（确定性门槛）→ assessment（LLM 研判）；明确请求（用户消息）直接接单，
 *   不经研判（dsh「direct Decision for an explicit request」路径）；
 * - 超时重排：Eval 过期后重排两次，第三次记录 unavailable；
 * - 策略变更（运行模式/自主级别）作废进行中的 Eval，事件重排。
 */
import type { Decision, Evaluation, Trigger, Thread } from './model'
import { EnginePart } from './part'
import { keyOf } from './model'
import { Tickets } from './tickets'

export interface AssessmentAction {
  kind: 'create_workitem'
  workitemType: string
  refStrategyId?: string
  note?: string
}

export class Evals extends EnginePart {
  constructor(
    options: ConstructorParameters<typeof EnginePart>[0],
    private readonly tickets: Tickets
  ) {
    super(options)
  }

  /** 未送达候选不开始计时（dsh：候选送达主会话后 deadline 才起算） */
  private evalTimeoutMs = 5 * 60_000

  /** 启动到期线程的评估（每线程一批）；direct-accept 用户消息；重排过期 Eval。 */
  evaluateDue(now: string, threads: Map<string, Thread>): void {
    for (const thread of threads.values()) {
      if (thread.eval) {
        this.expireIfOverdue(thread, now)
        continue
      }
      if (thread.queued.length === 0) continue
      const batch = thread.queued.splice(0)
      // 明确请求（用户消息）：直接接单，不经研判（不消耗额外 LLM 轮次）
      const addressed = batch.filter((t) => {
        const g = this.policy.gate(t)
        return g.strength === 'explicit' && g.basis === 'addressed'
      })
      for (const trigger of addressed) {
        this.directAccept(trigger)
      }
      const rest = batch.filter((t) => !addressed.includes(t))
      if (rest.length === 0) continue
      thread.queued = [...thread.queued, ...rest]
      this.startEval(thread, rest, now)
    }
  }

  /** 一个 Eval 的候选（供评估器组装上下文） */
  candidate(evalId: string, threads: Map<string, Thread>): Evaluation | undefined {
    for (const thread of threads.values()) {
      if (thread.eval?.id === evalId) return thread.eval
    }
    return undefined
  }

  /** 候选已送达评估器：deadline 从此刻起算，状态进入 assessing */
  candidateDelivered(evalId: string, threads: Map<string, Thread>, now = this.now()): void {
    const evalItem = this.candidate(evalId, threads)
    if (!evalItem) return
    evalItem.status = 'assessing'
    evalItem.delivered = true
    evalItem.deadline = new Date(new Date(now).getTime() + this.evalTimeoutMs).toISOString()
  }

  /** 记录一个决策；accept 时按动作创建工作项（Tickets 部分） */
  decide(
    evalId: string,
    outcome: Decision['outcome'],
    reason: Decision['reason'],
    actions: AssessmentAction[],
    threads: Map<string, Thread>,
    output: unknown,
    inputSnapshot: unknown
  ): void {
    const evalItem = this.candidate(evalId, threads)
    if (!evalItem) return
    const accountId = evalItem.threadKey.replace(/^account:/, '')
    const workItemIds: string[] = []
    this.repo.atomic(() => {
      if (outcome === 'accept') {
        for (const action of actions) {
          if (action.kind !== 'create_workitem') continue
          const ticket = this.tickets.create({
            accountId,
            type: action.workitemType as never,
            priority: 'medium',
            context: {
              eventType: evalItem.triggers[0]?.type ?? '',
              note: action.note ?? '',
              ...(action.refStrategyId ? { strategyId: action.refStrategyId, __busKey: `strategy:${action.refStrategyId}` } : {}),
              // 用户消息的文本随上下文进入工作项
              ...(evalItem.triggers[0]?.payload.message != null ? { message: String(evalItem.triggers[0].payload.message) } : {})
            },
            trigger: evalItem.triggers[0]
          })
          workItemIds.push(ticket.id)
        }
      }
      const decision: Decision = {
        id: this.newId(),
        evalId,
        accountId,
        outcome,
        reason,
        workItemIds,
        inputSnapshot,
        output,
        createdAt: this.now()
      }
      this.repo.decisions.add(decision)
      // 批次内事件标记已决策（重启时仅 stored 事件重入评估队列）
      for (const trigger of evalItem.triggers) {
        this.repo.triggers.markDisposition(trigger.id, 'decided')
      }
      evalItem.status = outcome === 'unavailable' ? 'unavailable' : 'decided'
    })
    const thread = threads.get(evalItem.threadKey)
    if (thread?.eval?.id === evalItem.id) {
      thread.eval = undefined
      thread.expiryStreak = 0
    }
    this.emit({ name: 'decision.recorded', accountId, payload: { evalId, outcome, workItemIds }, at: this.now() })
  }

  // ---------- 内部 ----------
  /** 明确请求直接接单：为每个用户消息创建一个 user_request 工作项并记录决策 */
  private directAccept(trigger: Trigger): void {
    const reason = { code: 'direct_request' }
    const decision: Decision = {
      id: this.newId(),
      evalId: `direct:${trigger.id}`,
      accountId: trigger.accountId,
      outcome: 'accept',
      reason,
      workItemIds: [],
      inputSnapshot: { trigger: { type: trigger.type, payload: trigger.payload } },
      output: { needsAction: true, directRequest: true },
      createdAt: this.now()
    }
    this.repo.atomic(() => {
      const ticket = this.tickets.create({
        accountId: trigger.accountId,
        type: 'user_request',
        priority: 'high',
        context: { message: String(trigger.payload.message ?? ''), eventType: trigger.type },
        trigger
      })
      decision.workItemIds = [ticket.id]
      this.repo.decisions.add(decision)
      this.repo.triggers.markDisposition(trigger.id, 'decided')
    })
    this.emit({ name: 'decision.recorded', accountId: trigger.accountId, payload: { evalId: decision.evalId, outcome: 'accept', workItemIds: decision.workItemIds, direct: true }, at: this.now() })
  }

  /** 开始一个 Eval（批次取最强触发计算强度与依据） */
  private startEval(thread: Thread, batch: Trigger[], now: string): void {
    let strength: 'explicit' | 'inferred' = 'inferred'
    let basis: Evaluation['basis'] = 'internal'
    for (const trigger of batch) {
      const g = this.policy.gate(trigger)
      if (g.strength === 'explicit' && strength !== 'explicit') {
        strength = 'explicit'
        basis = g.basis
      }
      if (g.basis === 'schedule' && basis === 'internal') basis = 'schedule'
    }
    const evalItem: Evaluation = {
      id: keyOf('eval', thread.accountId, now, String(thread.expiryStreak)),
      threadKey: thread.key,
      triggers: batch,
      strength,
      basis,
      status: 'queued',
      delivered: false,
      deadline: now
    }
    thread.eval = evalItem
    // 注意：expiryStreak 不在新 Eval 启动时清零（连续过期计数跨 Eval 保持，
    // 决策成功或 unavailable 后由 decide 清零）
    this.emit({ name: 'eval.started', accountId: thread.accountId, payload: { evalId: evalItem.id, count: batch.length, strength, basis }, at: now })
    // 请求评估器（实现侧入队持久化副作用）
    this.options.assessor.request(evalItem.id)
  }

  /** 过期处理：未送达不超时；过期重排两次，第三次记录 unavailable */
  private expireIfOverdue(thread: Thread, now: string): void {
    const evalItem = thread.eval
    if (!evalItem || evalItem.status !== 'assessing' && evalItem.status !== 'queued') return
    if (!evalItem.delivered) return
    if (now <= evalItem.deadline) return
    const streaks = thread.expiryStreak + 1
    if (streaks < 3) {
      // 重排：事件回到队列，稍后新起 Eval
      thread.queued = [...thread.queued, ...evalItem.triggers]
      thread.eval = undefined
      thread.expiryStreak = streaks
      for (const trigger of evalItem.triggers) {
        this.emit({ name: 'trigger.requeued', accountId: thread.accountId, triggerId: trigger.id, payload: { type: trigger.type, streak: streaks }, at: now })
      }
      return
    }
    // 第三次过期：记录 unavailable 并释放
    this.decide(evalItem.id, 'unavailable', { code: 'eval_timeout' }, [], new Map([[thread.key, thread]]), undefined, { deadline: evalItem.deadline })
  }

  /** 策略变更：作废进行中的 Eval，事件重排（docs/002-authorization.md「Policy version」） */
  policyChanged(threads: Map<string, Thread>, now: string): void {
    for (const thread of threads.values()) {
      if (!thread.eval) continue
      const evalItem = thread.eval
      thread.queued = [...thread.queued, ...evalItem.triggers]
      thread.eval = undefined
      thread.expiryStreak = 0
      for (const trigger of evalItem.triggers) {
        this.emit({ name: 'trigger.requeued', accountId: thread.accountId, triggerId: trigger.id, payload: { type: trigger.type, reason: 'policy_changed' }, at: now })
      }
    }
  }
}
