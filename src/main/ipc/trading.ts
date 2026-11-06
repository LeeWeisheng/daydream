/**
 * IPC：交易域（trade:…signal:·/position:·）。
 * - 买入/卖出：人工录入，事务联动资金/持仓/成交记录（交易服务）；
 * - 信号：查询与人工反馈（executed → 自动联动资金/持仓）；
 * - 持仓：人工维护（增删改）。
 */
import { ipcMain } from 'electron'
import { IPC, type PositionUpsertReq, type SignalFeedbackReq, type TradeOrderReq } from '@shared/ipc'
import { buildAccountSummary, collectAccountSnapshot, executeTradeOrder, listPositions, listTradeRecords, setInitialCash, upsertPosition } from '../trading/service'
import { feedbackSignal, listSignals } from '../signals/service'
import { uiBus } from '../app/events'

export function registerTradingHandlers(): void {
  ipcMain.handle(IPC.tradeOrder, (_e, req: TradeOrderReq) => {
    executeTradeOrder(req)
    uiBus.broadcast('signal.updated', { accountId: req.accountId, kind: 'trade', code: req.code })
    collectAccountSnapshot(req.accountId)
  })
  ipcMain.handle(IPC.tradeList, (_e, accountId: string) => listTradeRecords(accountId))
  ipcMain.handle(IPC.tradeAccountSummary, (_e, accountId: string) => buildAccountSummary(accountId))
  ipcMain.handle(IPC.tradeSetInitialCash, (_e, req: { accountId: string; cash: number }) => setInitialCash(req.accountId, req.cash))

  // 信号
  ipcMain.handle(IPC.signalList, (_e, accountId: string, limit = 100) => listSignals(accountId, limit))
  ipcMain.handle(IPC.signalFeedback, (_e, req: SignalFeedbackReq) => {
    feedbackSignal(req.signalId, req.feedback, { price: req.tradedPrice, qty: req.tradedQty, fee: req.fee })
  })

  // 持仓
  ipcMain.handle(IPC.positionList, (_e, accountId: string) => listPositions(accountId))
  ipcMain.handle(IPC.positionUpsert, (_e, req: PositionUpsertReq) => {
    upsertPosition(req.accountId, req.code, req.qty, req.costPrice)
    collectAccountSnapshot(req.accountId)
  })
}
