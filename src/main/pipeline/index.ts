/**
 * 业务管线统一出口：七环节（规划/生成/回测/运行/盯盘/复盘/纠正）+ 数据补数。
 * 各环节 = 确定性动作 + LLM 智能判断组合（见《实现方案-Agent决策闭环设计》§7）。
 * PipelineHost 由执行器注入：管线经它入队后续工作项（Engine 唯一写者路径），
 * 不直接触碰工作项仓储（dsh 依赖规则「one writer per state」）。
 */
import type { Ticket } from '../core/model'
import type { CreateTicketOptions } from '../core/ports'

export interface PipelineHost {
  accountId: string
  /** 入队后续工作项（Engine.enqueueTicket） */
  enqueueTicket: (options: CreateTicketOptions) => Ticket
  /** 当前工作项上下文 */
  context: Record<string, unknown>
}

export * as planning from './planner'
export * as strategyGen from './strategist'
export * as backtestPipeline from './backtester'
export * as runnerPipeline from './runner'
export * as monitorPipeline from './monitor'
export * as reviewPipeline from './reviewer'
export * as correctionPipeline from './corrector'
export * as dataOps from './dataOps'
