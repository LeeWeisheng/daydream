/**
 * IPC：对话域（chat:·/report:·/event:·）。
 * - 发送：用户消息落对话流 → 经 Engine.receive 进入评估（明确请求直接接单 → user_request 工作项）；
 *   停止运行时拒绝（闸门策略的一部分），并在对话流说明；
 * - 汇报：待决策事项列表与响应（批准/驳回/暂缓）；
 * - 事件：Agent 事件流水（规划页）。
 */
import { ipcMain } from 'electron'
import { IPC, type ChatListOpts, type ReportRespondReq } from '@shared/ipc'
import { addChatMessage, listChatMessages } from '../chat/service'
import { applyReportDecision, getReport, listReports } from '../reports/service'
import { getEngine, isAgentRunning } from '../runtime'
import { userMessageTrigger } from '../app/triggers'
import { audit } from '../services/audit'
import { uiBus } from '../app/events'
import { queryAll, newId } from '../db/connection'
import { UserError } from '../core/errors'

export function registerChatHandlers(): void {
  // 对话流
  ipcMain.handle(IPC.chatSend, (_e, req: { accountId: string; message: string }) => {
    const message = req.message?.trim()
    if (!message) throw new UserError('invalid_input', { detail: '消息不能为空' })
    // 用户消息写入对话流（经 Outbox，先存后发）
    const messageId = newId()
    addChatMessage({ accountId: req.accountId, role: 'user', content: message, id: messageId })
    // 停止运行：拒绝处理（闸门策略：不运行即不评估），仅在对话流说明
    if (!isAgentRunning()) {
      addChatMessage({
        accountId: req.accountId,
        role: 'assistant',
        kind: 'error',
        content: 'Agent 已停止运行，本次消息未处理（未发起任何模型请求）。如需继续，请先点击「开始运行」。'
      })
      audit({ accountId: req.accountId, actor: 'user', action: 'chat.rejected', detail: { reason: 'agent_not_running' } })
      return { accepted: false, reason: 'agent_not_running' }
    }
    // 用户消息 → 明确请求触发 → 直接接单（user_request 工作项）
    const trigger = userMessageTrigger(req.accountId, messageId, message)
    getEngine().receive(trigger)
    audit({ accountId: req.accountId, actor: 'user', action: 'chat.send', detail: { message: message.slice(0, 200) } })
    return { accepted: true }
  })
  ipcMain.handle(IPC.chatList, (_e, req: { accountId: string; limit?: number; before?: ChatListOpts['before']; after?: ChatListOpts['after'] }) =>
    listChatMessages(req.accountId, { limit: req.limit ?? 100, before: req.before, after: req.after })
  )

  // 汇报（待决策，首页右列）
  ipcMain.handle(IPC.reportList, (_e, accountId: string) => listReports(accountId))
  ipcMain.handle(IPC.reportRespond, (_e, req: ReportRespondReq) => {
    const report = getReport(req.reportId)
    if (!report) throw new UserError('missing_report', { id: req.reportId })
    const decision = req.decision === 'approved' ? 'approved' : req.decision === 'postponed' ? 'postponed' : 'rejected'
    applyReportDecision({ reportId: req.reportId, accountId: report.accountId, decisionJson: report.decisionJson ?? null, decision, actor: 'user', note: req.note })
    uiBus.broadcast('agent.report', { reportId: req.reportId, decision })
  })

  // 事件流水（规划页）
  ipcMain.handle(IPC.eventList, (_e, accountId: string, limit = 200) =>
    queryAll('SELECT id, type, payload_json as payloadJson, occurred_at as occurredAt FROM event_log WHERE account_id = ? ORDER BY id DESC LIMIT ?', [accountId, limit])
  )
}
