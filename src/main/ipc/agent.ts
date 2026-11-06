/**
 * IPC：Agent 域（agent:…）。
 * - 状态/工作项/计划查询经 Engine（唯一写者）与读查询；
 * - 开始运行前置校验：必须已配置模型（全局）；
 * - 停止运行：关闸 + 终止在途模型请求（运行时服务）。
 */
import { ipcMain } from 'electron'
import { IPC } from '@shared/ipc'
import { queryAll } from '../db/connection'
import { getEngine, getAgentStatus, startAgent, stopAgent } from '../runtime'
import { isModelConfigured } from '../settings/service'
import { UserError } from '../core/errors'

export function registerAgentHandlers(): void {
  ipcMain.handle(IPC.agentGetWorkItems, (_e, accountId: string) => toWireTickets(getEngine().listTickets(accountId)))
  ipcMain.handle(IPC.agentRetryWorkItem, (_e, id: string) => {
    getEngine().retryTicket(id)
  })
  ipcMain.handle(IPC.agentCancelWorkItem, (_e, id: string) => {
    getEngine().cancelTicket(id)
  })
  ipcMain.handle(IPC.agentGetPlan, (_e, accountId: string) => queryAll('SELECT * FROM plan WHERE account_id = ? ORDER BY created_at DESC LIMIT 20', [accountId]))
  ipcMain.handle(IPC.agentGetStatus, () => ({ active: getAgentStatus().active, running: getAgentStatus().running, lastTickAt: new Date().toISOString() }))
  ipcMain.handle(IPC.agentStart, () => {
    // 开始运行前置校验：必须已配置模型（全局）
    if (!isModelConfigured()) throw new UserError('model_not_configured')
    startAgent()
    return { running: true }
  })
  ipcMain.handle(IPC.agentStop, async () => {
    await stopAgent()
    return { running: false }
  })
}

/** 领域 Ticket → 界面 Wire 形状（与 @shared/types WorkItem 对齐） */
function toWireTickets(tickets: ReturnType<ReturnType<typeof getEngine>['listTickets']>): Record<string, unknown>[] {
  return tickets.map((t) => ({
    id: t.id,
    accountId: t.accountId,
    type: t.type,
    status: t.status,
    priority: t.priority,
    contextJson: JSON.stringify(t.context),
    sessionId: undefined,
    attempts: t.attempts,
    maxAttempts: t.maxAttempts,
    scheduledAt: t.scheduledAt,
    deadline: t.deadline,
    resultJson: t.result ? JSON.stringify(t.result) : undefined,
    error: t.error,
    createdAt: t.createdAt,
    startedAt: t.startedAt,
    finishedAt: t.finishedAt
  }))
}
