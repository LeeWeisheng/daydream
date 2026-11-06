/**
 * 工作项阶段（Stage）：按「等待谁」划分，界面据此显示状态标签。
 * 与 dsh-superagent-prototype 的 src/core/stage.ts（docs/003-execution.md 阶段表）对齐：
 * 从上到下读，首个匹配行生效。
 */
import type { Ticket } from './model'

export type TicketStage =
  | 'person/blocked' // 受阻，等待人工消息或重试
  | 'working/queued' // 待启动（无执行实例或等待调度）
  | 'working' // 执行中
  | 'ended' // 已结束（成功/失败/取消）
  | 'idle' // 空闲（Daydream 无此状态，保留枚举）

/**
 * 阶段表（docs/003-execution.md 的 Daydream 对应）：
 * | 阶段           | 条件                       | 界面标签   |
 * | person/blocked | status = blocked           | 受阻待处理 |
 * | working/queued | status = pending           | 排队中     |
 * | working        | status = running           | 执行中     |
 * | ended          | succeeded/failed/cancelled | 已结束     |
 */
export function ticketStage(t: Ticket): TicketStage {
  if (t.status === 'blocked') return 'person/blocked'
  if (t.status === 'pending') return 'working/queued'
  if (t.status === 'running') return 'working'
  return 'ended'
}

/** 是否可重试：失败的或人工取消的工作项可重新入队 */
export function canRetry(t: Ticket): boolean {
  return t.status === 'failed' || t.status === 'cancelled'
}

/** 是否可取消：未结束的工作项（含受阻中） */
export function canCancel(t: Ticket): boolean {
  return t.status === 'pending' || t.status === 'running' || t.status === 'blocked'
}
