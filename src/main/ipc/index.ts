/**
 * IPC Handler 注册入口：按域拆分（账户/设置/行情/策略/交易/预警/Agent/对话），
 * 每个域一个注册函数；事件推送统一走 `daydream:event`（UiBus）。
 */
import { registerAccountHandlers } from './accounts'
import { registerSettingsHandlers } from './settings'
import { registerMarketHandlers } from './market'
import { registerStrategyHandlers } from './strategy'
import { registerTradingHandlers } from './trading'
import { registerAlertHandlers } from './alerts'
import { registerAgentHandlers } from './agent'
import { registerChatHandlers } from './chat'
import { providerManager } from '../market/providers/base'
import { EastmoneyProvider } from '../market/providers/eastmoney'
import { TencentProvider } from '../market/providers/tencent'
import { logger } from '../services/logger'

export function registerIpcHandlers(): void {
  // 数据源注册（首选东财，次选腾讯，自动降级）
  providerManager.register(new EastmoneyProvider())
  providerManager.register(new TencentProvider())

  registerAccountHandlers()
  registerSettingsHandlers()
  registerMarketHandlers()
  registerStrategyHandlers()
  registerTradingHandlers()
  registerAlertHandlers()
  registerAgentHandlers()
  registerChatHandlers()

  logger.info('[ipc] handlers registered')
}
