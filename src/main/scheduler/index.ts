/**
 * 调度器：交易节律驱动（全部基于 Asia/Shanghai 北京时间）。
 * 盘前 8:30 规划（周五深度）、盘中每 2 分钟盯盘、15:05 运行决策、
 * 16:30 数据增量、17:00 日复盘、周五 17:30 周复盘。
 * 每 30 秒 tick 检查触发点；Agent 工作项队列每 10 秒 tick 一次。
 */
import { SCHEDULE, isMarketOpenNow, isTradingDay, shanghaiDateStr, shanghaiNow, toHM } from '@shared/constants'
import { logger } from '../services/logger'
import { agentEventBus } from '../agent/events'
import { tickWorkItems, isAgentRunning } from '../agent/loop'
import * as pipelines from '../pipeline'
import { dailyUpdate } from '../data/pipeline'
import { providerManager } from '../data/providers/base'
import { getActiveAccountId } from '../ipc/handlers'

const fired = new Map<string, string>() // key -> 最后触发日期（防重复）

function shouldFire(key: string, time: string, now: Date, extra?: () => boolean): boolean {
  const date = shanghaiDateStr(now)
  const hm = toHM(now)
  if (hm !== time) return false
  if (fired.get(key) === date) return false
  if (!isTradingDay(date)) return false
  if (extra && !extra()) return false
  fired.set(key, date)
  return true
}

export function startScheduler(): void {
  let lastWorkItemTick = 0
  let lastMonitorTick = 0

  setInterval(async () => {
    const now = shanghaiNow()
    const date = shanghaiDateStr(now)
    const weekday = now.getUTCDay()
    // 无账户时跳过交易节律（用户必须先创建账户）
    const accountId = getActiveAccountId()
    if (!accountId) return
    const account = { id: accountId }
    // 运行开关：停止运行时 Agent 节律事件（规划/盯盘/运行决策/复盘）不触发；数据更新照常
    const running = isAgentRunning()

    try {
      // 盘前规划（周五深度规划替代轻量规划）
      if (running && shouldFire('plan', SCHEDULE.planTime, now, () => weekday !== 5)) {
        agentEventBus.emitAgentEvent('schedule.plan', account.id, { date }, { debounceMs: 0 })
      }
      if (running && shouldFire('plan_weekly', SCHEDULE.planWeeklyTime, now, () => weekday === 5)) {
        agentEventBus.emitAgentEvent('schedule.plan_weekly', account.id, { date }, { debounceMs: 0 })
      }
      // 盘中盯盘
      if (running && isMarketOpenNow() && Date.now() - lastMonitorTick > SCHEDULE.monitorIntervalMinutes * 60_000) {
        lastMonitorTick = Date.now()
        agentEventBus.emitAgentEvent('schedule.monitor_tick', account.id, { date }, { debounceMs: 0 })
      }
      // 收盘后运行决策（15:05，用收盘实时快照）
      if (running && shouldFire('runner', SCHEDULE.runnerTime, now)) {
        pipelines.runnerPipeline.runDailyDecision(account.id).catch((e) => logger.error(`[scheduler] runner failed: ${(e as Error).message}`))
      }
      // 数据增量（16:30）——不受运行开关限制（数据是全局基础设施）
      if (shouldFire('data_update', SCHEDULE.dataUpdateTime, now)) {
        dailyUpdate().catch((e) => logger.error(`[scheduler] daily update failed: ${(e as Error).message}`))
      }
      // 日复盘（17:00）/ 周复盘（周五 17:30）
      if (running && shouldFire('review_daily', SCHEDULE.reviewDailyTime, now, () => weekday !== 5)) {
        agentEventBus.emitAgentEvent('schedule.review_daily', account.id, { date }, { debounceMs: 0 })
      }
      if (running && shouldFire('review_weekly', SCHEDULE.reviewWeeklyTime, now, () => weekday === 5)) {
        agentEventBus.emitAgentEvent('schedule.review_weekly', account.id, { date }, { debounceMs: 0 })
      }
      // 数据源健康恢复
      providerManager.resetIfPossible()
    } catch (e) {
      logger.error(`[scheduler] tick failed: ${(e as Error).message}`)
    }
  }, 30_000)

  // 工作项队列 tick（每 10 秒）
  setInterval(() => {
    if (Date.now() - lastWorkItemTick < 10_000) return
    lastWorkItemTick = Date.now()
    tickWorkItems().catch((e) => logger.error(`[scheduler] workitem tick failed: ${(e as Error).message}`))
  }, 10_000)

  logger.info('[scheduler] started')
}
