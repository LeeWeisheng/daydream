/**
 * UiBus：主进程 → 渲染进程的统一事件流（`daydream:event` 通道）。
 * 域事件（Engine 发出）在此翻译为 UI 事件并广播 + 审计；
 * 业务事件（信号/预警/汇报/进度等）由各服务直接调用 broadcast。
 */
import { BrowserWindow } from 'electron'
import { IPC } from '@shared/ipc'
import type { DomainEvent } from '../core/model'
import { audit } from '../services/audit'
import { logger } from '../services/logger'

export interface UiEvent {
  type: string
  payload: Record<string, unknown>
}

class UiBus {
  broadcast(type: string, payload: Record<string, unknown> = {}): void {
    for (const win of BrowserWindow.getAllWindows()) {
      try {
        win.webContents.send(IPC.uiEvent, { type, payload } satisfies UiEvent)
      } catch (e) {
        logger.debug(`[ui] broadcast failed: ${(e as Error).message}`)
      }
    }
  }

  /** 域事件 → UI 事件翻译表（dsh notices 的简化对应） */
  onDomainEvent(event: DomainEvent): void {
    switch (event.name) {
      case 'trigger.received': {
        const type = (event.payload?.type as string) ?? ''
        if (type === 'workitem.failed') {
          this.broadcast('workitem.updated', { ...event.payload, accountId: event.accountId })
        }
        if (type === 'backtest.completed') {
          this.broadcast('strategy.updated', { ...event.payload, accountId: event.accountId })
        }
        break
      }
      case 'ticket.created':
        this.broadcast('workitem.updated', { ...event.payload, accountId: event.accountId, ticketId: event.ticketId })
        break
      case 'ticket.ended':
        this.broadcast('workitem.updated', { ...event.payload, accountId: event.accountId, ticketId: event.ticketId })
        break
      case 'ticket.resumed':
        this.broadcast('workitem.updated', { ...event.payload, accountId: event.accountId, ticketId: event.ticketId })
        break
      case 'decision.recorded':
        audit({
          accountId: event.accountId,
          actor: 'agent',
          action: 'decision.recorded',
          detail: { evalId: event.payload?.evalId, outcome: event.payload?.outcome, workItems: event.payload?.workItemIds }
        })
        break
      case 'trigger.filtered':
        audit({
          accountId: event.accountId,
          actor: 'agent',
          action: 'trigger.filtered',
          target: event.payload?.type != null ? String(event.payload.type) : undefined,
          detail: { reason: event.payload?.reason }
        })
        break
      case 'trigger.requeued':
        audit({ accountId: event.accountId, actor: 'agent', action: 'trigger.requeued', target: event.payload?.type != null ? String(event.payload.type) : undefined, detail: event.payload ?? {} })
        break
      case 'policy.changed':
        this.broadcast('agent.status', { policyChanged: true })
        break
      default:
        break
    }
  }
}

/** 全局 UI 事件总线单例 */
export const uiBus = new UiBus()
