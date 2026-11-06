/**
 * Engine：领域核心的入口（dsh src/core/engine.ts 的对应）。
 * 规则：
 * - Engine 是 Trigger / Eval / Decision / Ticket / Assignment 的唯一写入者；
 * - 所有命令同步执行，聚合变更在一个事务内；端口在事务内入队外部工作，提交后执行；
 * - 无效请求抛 UserError；调用方只拿到其角色的 Pick 接口；
 * - 命令用祈使命名（retryTicket），事实用过去式命名（assignmentStarted）。
 */
import type { Thread, Trigger } from './model'
import { keyOf } from './model'
import { Intake } from './intake'
import { Evals, type AssessmentAction } from './evals'
import { Tickets } from './tickets'
import { Assignments } from './assignments'
import { Replies } from './replies'
import type { EngineDeps, CreateTicketOptions } from './ports'

export class Engine {
  private readonly intake: Intake
  private readonly evals: Evals
  private readonly tickets: Tickets
  private readonly assignments: Assignments
  private readonly replies: Replies
  /** 账户事件流（Thread）：每账户一个，评估串行 */
  private readonly threads = new Map<string, Thread>()

  constructor(private readonly deps: EngineDeps) {
    this.intake = new Intake(deps)
    this.tickets = new Tickets(deps)
    this.evals = new Evals(deps, this.tickets)
    this.assignments = new Assignments(deps)
    this.replies = new Replies(deps)
  }

  // ---------- 触发源（Sources）角色：接收事件 ----------
  receive(trigger: Trigger): 'stored' | 'duplicate' | 'filtered' | 'ui-only' {
    const thread = this.threadFor(trigger.accountId)
    return this.intake.receive(trigger, thread)
  }

  // ---------- 管线（Pipeline）角色：确定性环节直接入队工作项 ----------
  enqueueTicket(options: CreateTicketOptions): ReturnType<Tickets['create']> {
    return this.tickets.create(options)
  }

  // ---------- 主会话（Main Session）角色：评估器 ----------
  /** 取一个 Eval 的候选（评估器组装上下文用） */
  candidate(evalId: string): ReturnType<Evals['candidate']> {
    return this.evals.candidate(evalId, this.threads)
  }

  /** 候选已送达：deadline 起算 */
  candidateDelivered(evalId: string): void {
    this.evals.candidateDelivered(evalId, this.threads, this.deps.now?.() ?? new Date().toISOString())
  }

  /** 记录决策（评估器提交结论；accept 时创建工作项） */
  decide(evalId: string, outcome: 'accept' | 'stop' | 'ignore' | 'unavailable', reason: { code: string; values?: Record<string, string> }, actions: AssessmentAction[], inputSnapshot: unknown, output: unknown): void {
    this.evals.decide(evalId, outcome, reason, actions, this.threads, output, inputSnapshot)
  }

  // ---------- 人员（People）角色：人工干预 ----------
  retryTicket(id: string): ReturnType<Tickets['retry']> {
    return this.tickets.retry(id)
  }

  cancelTicket(id: string): ReturnType<Tickets['cancel']> {
    return this.tickets.cancel(id)
  }

  // ---------- 执行器（Executor）角色：执行事实 ----------
  assignmentStarted(ticketId: string): ReturnType<Assignments['assignmentStarted']> {
    return this.assignments.assignmentStarted(ticketId)
  }

  assignmentEnded(assignmentId: string, outcome: 'succeeded' | 'failed' | 'cancelled', error?: string): void {
    this.assignments.assignmentEnded(assignmentId, outcome, error)
  }

  /** 执行器自动重试：attempts 保留，重置为 pending */
  requeueTicket(id: string): ReturnType<Tickets['requeueAfterFailure']> {
    return this.tickets.requeueAfterFailure(id)
  }

  /** 执行器报告工作项终态（成功/失败/取消）并写入对话流消息 */
  reportEnded(ticketId: string, outcome: 'succeeded' | 'failed' | 'cancelled', detail?: { result?: Record<string, unknown>; error?: string }): void {
    const ticket = this.tickets.getOrThrow(ticketId)
    this.tickets.end(ticketId, outcome, detail)
    this.replies.ticketFinished(ticket.accountId, ticket.id, ticket.type, outcome, detail)
  }

  // ---------- 通道（Replies）：对话流消息 ----------
  reply(message: Parameters<Replies['send']>[0]): void {
    this.replies.send(message)
  }

  // ---------- 调度（Passes）角色 ----------
  evaluateDue(now = this.deps.now?.() ?? new Date().toISOString()): void {
    this.evals.evaluateDue(now, this.threads)
  }

  // ---------- 设置（Settings）角色 ----------
  /** 策略变更：作废进行中的 Eval（事件重排），并通知（docs/002 §Policy version） */
  policyChanged(): void {
    const now = this.deps.now?.() ?? new Date().toISOString()
    this.evals.policyChanged(this.threads, now)
    this.deps.emit?.({ name: 'policy.changed', accountId: 'global', at: now })
  }

  /** 崩溃恢复：可安全重跑的工作项重置为 pending，其余标记 failed */
  recoverInterrupted(): ReturnType<Tickets['recoverInterrupted']> {
    return this.tickets.recoverInterrupted()
  }

  /** 重启恢复：把已入库但未决策的事件（disposition=stored）重入评估队列 */
  requeueStored(): number {
    const stored = this.deps.repo.triggers.stored()
    for (const trigger of stored) {
      const thread = this.threadFor(trigger.accountId)
      thread.queued.push(trigger)
      thread.lastTriggerAt = trigger.occurredAt
    }
    return stored.length
  }

  // ---------- 查询 ----------
  listTickets(accountId: string, limit?: number): ReturnType<Tickets['getOrThrow']>[] {
    return this.deps.repo.tickets.list({ accountId, limit: limit ?? 200 })
  }

  getTicket(id: string): ReturnType<Tickets['getOrThrow']> {
    return this.tickets.getOrThrow(id)
  }

  // ---------- 内部 ----------
  private threadFor(accountId: string): Thread {
    const key = keyOf('account', accountId)
    let thread = this.threads.get(key)
    if (!thread) {
      thread = { key, accountId, queued: [], expiryStreak: 0, lastTriggerAt: '' }
      this.threads.set(key, thread)
    }
    return thread
  }
}

/** 各调用方只拿到其角色的 Engine 子集（窄接口，dsh 依赖规则） */
export type EngineForSources = Pick<Engine, 'receive'>
export type EngineForPipeline = Pick<Engine, 'enqueueTicket' | 'reply'>
export type EngineForMainSession = Pick<Engine, 'candidate' | 'candidateDelivered' | 'decide'>
export type EngineForPeople = Pick<Engine, 'retryTicket' | 'cancelTicket' | 'listTickets' | 'getTicket'>
export type EngineForExecutor = Pick<Engine, 'assignmentStarted' | 'assignmentEnded' | 'reportEnded'>
export type EngineForSettings = Pick<Engine, 'policyChanged' | 'recoverInterrupted'>
export type EngineForPasses = Pick<Engine, 'evaluateDue'>
