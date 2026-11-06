/**
 * 调度器：交易节律驱动（全部基于 Asia/Shanghai 北京时间）。
 * 盘前 8:30 规划（周五深度）、盘中每 N 分钟盯盘、15:05 运行决策、
 * 16:30 数据增量、17:00 日复盘、周五 17:30 周复盘。
 * 每 30 秒 tick 检查触发点；事件经 Engine.receive 进入评估（评估/调度由 Passes 驱动）。
 * 无账户时跳过交易节律（用户必须先创建账户）；停止运行时 Agent 节律不触发，数据更新照常。
 */
import { SCHEDULE, isMarketOpenNow, isTradingDay, shanghaiDateStr, shanghaiNow, toHM } from '@shared/constants'
import { logger } from './services/logger'
import { scheduleTrigger } from './app/triggers'
import { getEngine, isAgentRunning } from './runtime'
import * as pipelines from './pipeline'
import { dailyUpdate } from './market/pipeline'
import { providerManager } from './market/providers/base'
import { getActiveAccountId } from './accounts/service'
import { getDataPrefs } from './settings/service'

const fired = new Map<string, string>() // `${key}:${accountId}` -> 最后触发日期（防重复；账户间独立）

function shouldFire(key: string, accountId: string, time: string, now: Date, extra?: () => boolean): boolean {
  const date = shanghaiDateStr(now)
  const hm = toHM(now)
  if (hm !== time) return false
  const fullKey = `${key}:${accountId}`
  if (fired.get(fullKey) === date) return false
  if (!isTradingDay(date)) return false
  if (extra && !extra()) return false
  fired.set(fullKey, date)
  return true
}

export function startScheduler(): void {
  let lastMonitorTick = 0

  setInterval(async () => {
    const now = shanghaiNow()
    const date = shanghaiDateStr(now)
    const weekday = now.getUTCDay()
    // 无账户时跳过交易节律（用户必须先创建账户）
    const accountId = getActiveAccountId()
    if (!accountId) return
    // 运行开关：停止运行时 Agent 节律事件（规划/盯盘/运行决策/复盘）不触发；数据更新照常
    const running = isAgentRunning()
    const engine = getEngine()

    try {
      // 盘前规划（周五深度规划替代轻量规划）
      if (running && shouldFire('plan', accountId, SCHEDULE.planTime, now, () => weekday !== 5)) {
        engine.receive(scheduleTrigger('schedule.plan', accountId, date))
      }
      if (running && shouldFire('plan_weekly', accountId, SCHEDULE.planWeeklyTime, now, () => weekday === 5)) {
        engine.receive(scheduleTrigger('schedule.plan_weekly', accountId, date))
      }
      // 盘中盯盘：定时任务直跑确定性规则检查（不经 LLM 评估，节省 token；规则由 Agent 预先配置）
      const interval = getDataPrefs().monitorIntervalMinutes
      if (running && isMarketOpenNow() && Date.now() - lastMonitorTick > interval * 60_000) {
        lastMonitorTick = Date.now()
        pipelines.monitorPipeline.run(accountId).catch((e) => logger.error(`[scheduler] monitor failed: ${(e as Error).message}`))
      }
      // 收盘后运行决策（15:05，用收盘实时快照）
      if (running && shouldFire('runner', accountId, SCHEDULE.runnerTime, now)) {
        pipelines.runnerPipeline.runDailyDecision(accountId).catch((e) => logger.error(`[scheduler] runner failed: ${(e as Error).message}`))
      }
      // 数据增量（16:30）——不受运行开关限制（数据是全局基础设施）
      if (shouldFire('data_update', accountId, SCHEDULE.dataUpdateTime, now)) {
        dailyUpdate().catch((e) => logger.error(`[scheduler] daily update failed: ${(e as Error).message}`))
      }
      // 日复盘（17:00）/ 周复盘（周五 17:30）
      if (running && shouldFire('review_daily', accountId, SCHEDULE.reviewDailyTime, now, () => weekday !== 5)) {
        engine.receive(scheduleTrigger('schedule.review_daily', accountId, date))
      }
      if (running && shouldFire('review_weekly', accountId, SCHEDULE.reviewWeeklyTime, now, () => weekday === 5)) {
        engine.receive(scheduleTrigger('schedule.review_weekly', accountId, date))
      }
      // 数据源健康恢复
      providerManager.resetIfPossible()
    } catch (e) {
      logger.error(`[scheduler] tick failed: ${(e as Error).message}`)
    }
  }, 30_000)

  logger.info('[scheduler] started')
}
