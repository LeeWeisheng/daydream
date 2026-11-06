/**
 * 核心引擎领域测试（dsh tests/core-engine.spec.ts 的对应）：
 * 用 MemoryRepositories 验证 Engine 的领域规则——
 * 接收、过滤、幂等、明确请求直接接单、评估决策、工作项生命周期、重试/取消、崩溃恢复。
 */
import { describe, expect, it, vi } from 'vitest'
import { Engine, MemoryRepositories, UserError } from '../src/main/core'
import type { Policy, PolicyGateResult } from '../src/main/core/ports'
import type { Trigger } from '../src/main/core/model'

function makePolicy(running = true): Policy {
  return {
    version: 'test:1',
    running,
    acceptMode: 'observe',
    gate(t: Pick<Trigger, 'type' | 'source'>): PolicyGateResult {
      if (!running) return { admitted: false, strength: 'inferred', basis: 'internal', reasonCode: 'not_running' }
      if (t.type === 'user.message') return { admitted: true, strength: 'explicit', basis: 'addressed' }
      if (t.type.startsWith('schedule.')) return { admitted: true, strength: 'inferred', basis: 'schedule' }
      return { admitted: true, strength: 'inferred', basis: 'internal' }
    },
    fallbackFor(type) {
      if (type.startsWith('schedule.')) return 'retry_later'
      if (type === 'user.message') return 'direct_accept'
      return 'no_action'
    }
  }
}

function makeTrigger(type: string, accountId = 'a1', payload: Record<string, unknown> = {}): Trigger {
  return { id: `t:${type}:${accountId}:${Math.random()}`, type, accountId, payload, source: 'test', occurredAt: new Date().toISOString() }
}

interface Harness {
  engine: Engine
  repo: MemoryRepositories
  assessor: { request: ReturnType<typeof vi.fn> }
  executor: { start: ReturnType<typeof vi.fn> }
  outbox: { messages: unknown[] }
}

function harness(running = true): Harness {
  const repo = new MemoryRepositories()
  const assessor = { request: vi.fn() }
  const executor = { start: vi.fn() }
  const outboxMessages: unknown[] = []
  const engine = new Engine({
    repo,
    policy: () => makePolicy(running),
    assessor: { request: assessor.request, release: vi.fn() },
    executor: { start: executor.start },
    outbox: { send: (m) => outboxMessages.push(m) },
    newId: () => `id:${Math.random().toString(36).slice(2, 10)}`
  })
  return { engine, repo, assessor, executor, outbox: { messages: outboxMessages } }
}

describe('Engine 接收（Intake）', () => {
  it('幂等：同一 Trigger 只入一次（duplicate）', () => {
    const h = harness()
    const trigger = makeTrigger('schedule.plan', 'a1')
    expect(h.engine.receive(trigger)).toBe('stored')
    expect(h.engine.receive({ ...trigger })).toBe('duplicate')
  })

  it('UI-only 事件：落库但不评估（不请求评估器）', () => {
    const h = harness()
    const result = h.engine.receive(makeTrigger('alert.triggered', 'a1'))
    expect(result).toBe('ui-only')
    h.engine.evaluateDue()
    expect(h.assessor.request).not.toHaveBeenCalled()
  })

  it('停止运行时事件被过滤（filtered，留痕）', () => {
    const h = harness(false)
    const result = h.engine.receive(makeTrigger('schedule.plan', 'a1'))
    expect(result).toBe('filtered')
    h.engine.evaluateDue()
    expect(h.assessor.request).not.toHaveBeenCalled()
  })
})

describe('Engine 评估（Evals）', () => {
  it('明确请求（用户消息）直接接单：创建 user_request 工作项，不请求评估器', () => {
    const h = harness()
    h.engine.receive(makeTrigger('user.message', 'a1', { message: '生成一个低波动策略' }))
    h.engine.evaluateDue()
    expect(h.assessor.request).not.toHaveBeenCalled()
    const tickets = h.engine.listTickets('a1')
    expect(tickets).toHaveLength(1)
    expect(tickets[0].type).toBe('user_request')
    expect(tickets[0].mandate.strength).toBe('explicit')
    expect(tickets[0].mandate.basis).toBe('addressed')
    // 决策留档
    expect(h.repo.decisions.list('a1')).toHaveLength(1)
  })

  it('推断事件（调度节律）启动评估：每账户一个 Eval，串行', () => {
    const h = harness()
    h.engine.receive(makeTrigger('schedule.plan', 'a1'))
    h.engine.evaluateDue()
    expect(h.assessor.request).toHaveBeenCalledTimes(1)
    const evalId = String(h.assessor.request.mock.calls[0][0])
    const candidate = h.engine.candidate(evalId)
    expect(candidate?.strength).toBe('inferred')
    expect(candidate?.basis).toBe('schedule')
    // 同一线程评估期间的事件并入下一批（不并发新 Eval）
    h.engine.receive(makeTrigger('schedule.review_daily', 'a1'))
    h.engine.evaluateDue()
    expect(h.assessor.request).toHaveBeenCalledTimes(1)
  })

  it('决策 accept：按建议动作创建工作项并结束 Eval', () => {
    const h = harness()
    h.engine.receive(makeTrigger('schedule.plan', 'a1'))
    h.engine.evaluateDue()
    const evalId = String(h.assessor.request.mock.calls[0][0])
    h.engine.candidateDelivered(evalId)
    h.engine.decide(
      evalId,
      'accept',
      { code: 'assessment_accepted' },
      [{ kind: 'create_workitem', workitemType: 'plan' }, { kind: 'create_workitem', workitemType: 'review_daily', note: '复盘' }],
      { event: 'schedule.plan' },
      { needsAction: true }
    )
    const tickets = h.engine.listTickets('a1')
    expect(tickets).toHaveLength(2)
    expect(h.engine.candidate(evalId)).toBeUndefined()
  })

  it('决策 ignore：不创建工作项', () => {
    const h = harness()
    h.engine.receive(makeTrigger('schedule.plan', 'a1'))
    h.engine.evaluateDue()
    const evalId = String(h.assessor.request.mock.calls[0][0])
    h.engine.decide(evalId, 'ignore', { code: 'assessment_ignored' }, [], { event: 'schedule.plan' }, { needsAction: false })
    expect(h.engine.listTickets('a1')).toHaveLength(0)
  })

  it('评估超时：重排两次后记录 unavailable', () => {
    const h = harness()
    let now = Date.parse('2026-01-01T00:00:00Z')
    const requested: string[] = []
    // 注入时钟
    const clocked = new Engine({
      repo: h.repo,
      policy: () => makePolicy(true),
      assessor: {
        request: (evalId) => requested.push(evalId),
        release: vi.fn()
      },
      executor: { start: vi.fn() },
      outbox: { send: () => undefined },
      now: () => new Date(now).toISOString(),
      newId: () => `id:${Math.random().toString(36).slice(2, 10)}`
    })
    clocked.receive(makeTrigger('schedule.plan', 'a1'))
    // 每轮：启动 Eval → 送达候选 → 前进 6 分钟 → 触发过期重排
    for (let round = 0; round < 3; round++) {
      clocked.evaluateDue()
      clocked.candidateDelivered(requested[requested.length - 1])
      now += 6 * 60_000
      clocked.evaluateDue() // 第 1/2 次：重排；第 3 次：记录 unavailable
      if (round < 2) {
        clocked.evaluateDue() // 重排后的新 Eval 在下一个 pass 启动
      }
    }
    expect(h.repo.decisions.list('a1').some((d) => d.outcome === 'unavailable')).toBe(true)
  })
})

describe('Engine 工作项生命周期（Tickets/Assignments）', () => {
  it('创建 → 启动 Assignment → 结束（域事件序列完整）', () => {
    const h = harness()
    const events: string[] = []
    const engine = new Engine({
      repo: h.repo,
      policy: () => makePolicy(true),
      assessor: { request: vi.fn(), release: vi.fn() },
      executor: { start: vi.fn() },
      outbox: { send: vi.fn() },
      emit: (e) => events.push(e.name),
      newId: () => `id:${Math.random().toString(36).slice(2, 10)}`
    })
    const ticket = engine.enqueueTicket({ accountId: 'a1', type: 'backtest' })
    expect(ticket.status).toBe('pending')
    const assignment = engine.assignmentStarted(ticket.id)
    expect(engine.getTicket(ticket.id).status).toBe('running')
    expect(engine.getTicket(ticket.id).attempts).toBe(1)
    engine.assignmentEnded(assignment.id, 'succeeded')
    engine.reportEnded(ticket.id, 'succeeded', { result: { runId: 'r1' } })
    expect(engine.getTicket(ticket.id).status).toBe('succeeded')
    expect(events).toContain('ticket.created')
    expect(events).toContain('assignment.started')
    expect(events).toContain('ticket.ended')
  })

  it('自动重试：attempts 保留；耗尽后 failed', () => {
    const h = harness()
    const ticket = h.engine.enqueueTicket({ accountId: 'a1', type: 'plan', maxAttempts: 2 })
    h.engine.assignmentStarted(ticket.id)
    h.engine.requeueTicket(ticket.id)
    expect(h.engine.getTicket(ticket.id).status).toBe('pending')
    expect(h.engine.getTicket(ticket.id).attempts).toBe(1)
    h.engine.assignmentStarted(ticket.id)
    expect(h.engine.getTicket(ticket.id).attempts).toBe(2)
  })

  it('人工重试：attempts 清零；不可重试状态拒绝', () => {
    const h = harness()
    const ticket = h.engine.enqueueTicket({ accountId: 'a1', type: 'plan' })
    h.engine.assignmentStarted(ticket.id)
    h.engine.reportEnded(ticket.id, 'failed', { error: 'x' })
    const retried = h.engine.retryTicket(ticket.id)
    expect(retried.status).toBe('pending')
    expect(retried.attempts).toBe(0)
    // pending 状态不可人工重试
    expect(() => h.engine.retryTicket(ticket.id)).toThrow(UserError)
  })

  it('取消：未结束的工作项可取消', () => {
    const h = harness()
    const ticket = h.engine.enqueueTicket({ accountId: 'a1', type: 'backtest' })
    h.engine.cancelTicket(ticket.id)
    expect(h.engine.getTicket(ticket.id).status).toBe('cancelled')
  })

  it('崩溃恢复：安全类型重置 pending，其余 failed', () => {
    const h = harness()
    const safe = h.engine.enqueueTicket({ accountId: 'a1', type: 'backtest' })
    const unsafe = h.engine.enqueueTicket({ accountId: 'a1', type: 'user_request' })
    h.engine.assignmentStarted(safe.id)
    h.engine.assignmentStarted(unsafe.id)
    const recovered = h.engine.recoverInterrupted()
    expect(recovered.map((t) => t.id)).toContain(safe.id)
    expect(h.engine.getTicket(safe.id).status).toBe('pending')
    expect(h.engine.getTicket(unsafe.id).status).toBe('failed')
  })

  it('结束幂等：已结束的工作项不被后续 reportEnded 覆盖终态', () => {
    const h = harness()
    const ticket = h.engine.enqueueTicket({ accountId: 'a1', type: 'plan' })
    h.engine.assignmentStarted(ticket.id)
    h.engine.reportEnded(ticket.id, 'failed', { error: '超时' })
    // 迟到的成功报告不覆盖 failed 终态
    h.engine.reportEnded(ticket.id, 'succeeded', { result: { done: true } })
    const final = h.engine.getTicket(ticket.id)
    expect(final.status).toBe('failed')
    expect(final.error).toContain('超时')
  })

  it('重启恢复：stored 事件重入评估队列（decided 事件不重入）', () => {
    const h = harness()
    // 已决策的事件不再重入
    h.engine.receive(makeTrigger('schedule.plan', 'a1'))
    h.engine.evaluateDue()
    const evalId = String(h.assessor.request.mock.calls[0][0])
    h.engine.decide(evalId, 'ignore', { code: 'assessment_ignored' }, [], {}, { needsAction: false })
    // 未决策的 stored 事件
    const pending = makeTrigger('schedule.review_daily', 'a2')
    h.engine.receive(pending)
    // 模拟重启：新 Engine 同一仓储
    const restartedAssessor = { request: vi.fn(), release: vi.fn() }
    const restarted = new Engine({
      repo: h.repo,
      policy: () => makePolicy(true),
      assessor: restartedAssessor,
      executor: { start: vi.fn() },
      outbox: { send: vi.fn() },
      newId: () => `id:${Math.random().toString(36).slice(2, 10)}`
    })
    expect(restarted.requeueStored()).toBe(1)
    restarted.evaluateDue()
    expect(restartedAssessor.request).toHaveBeenCalledTimes(1)
  })
})
