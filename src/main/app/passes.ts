/**
 * Passes：调度循环（dsh src/app/passes.ts 的对应）。
 * 每次 pass：先处理到期副作用（Effects），再 engine.evaluateDue()；
 * 到期的工作项经 executor.start 入队 launch 副作用（launch 处理器按槽位执行）。
 * 一次只跑一个 pass；pass 期间收到的触发并入下一批（评估串行由 Engine 保证）。
 */
import type { Engine } from '../core/engine'
import type { WorkItemExecutor } from './executor'
import { effects } from './effects'
import { store } from './store'
import { getAgentRunning } from '../settings/service'
import { logger } from '../services/logger'

const EVAL_INTERVAL_MS = 5_000
const LAUNCH_INTERVAL_MS = 5_000

export class Passes {
  private running = false
  private evalTimer: ReturnType<typeof setInterval> | null = null
  private launchTimer: ReturnType<typeof setInterval> | null = null
  private passing = false

  constructor(
    private readonly engine: Engine,
    private readonly executor: WorkItemExecutor
  ) {}

  /** 启动周期 pass（幂等） */
  start(): void {
    if (this.running) return
    this.running = true
    void this.pass()
    this.evalTimer = setInterval(() => void this.pass(), EVAL_INTERVAL_MS)
    this.launchTimer = setInterval(() => this.scheduleDueTickets(), LAUNCH_INTERVAL_MS)
    this.evalTimer.unref?.()
    this.launchTimer.unref?.()
  }

  /** 停止 pass（应用退出时） */
  drain(): void {
    this.running = false
    if (this.evalTimer) clearInterval(this.evalTimer)
    if (this.launchTimer) clearInterval(this.launchTimer)
    this.evalTimer = null
    this.launchTimer = null
  }

  /** 一次 pass：副作用 + 评估（一次只跑一个） */
  async pass(): Promise<void> {
    if (this.passing) return
    this.passing = true
    try {
      await effects.processAll()
      this.engine.evaluateDue()
    } catch (e) {
      logger.error(`[passes] pass failed: ${(e as Error).message}`)
    } finally {
      this.passing = false
    }
  }

  /** 调度到期的工作项（停止运行时不调度——闸门已关，运行开关是全局策略的一部分） */
  private scheduleDueTickets(): void {
    if (!getAgentRunning()) return
    for (const ticket of store.tickets.due(new Date().toISOString())) {
      this.executor.start(ticket.id)
    }
  }
}
