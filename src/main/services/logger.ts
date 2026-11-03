/**
 * 日志服务：electron-log 分级落盘（错误/警告/信息/调试）。
 * 主进程唯一实例，业务代码通过 log 工具函数使用。
 */
import log from 'electron-log'
import { app } from 'electron'

export function initLogger(): void {
  log.transports.file.level = 'info'
  log.transports.console.level = 'debug'
  log.transports.file.maxSize = 10 * 1024 * 1024 // 10MB 滚动
  log.transports.file.resolvePathFn = () => {
    const dir = app.getPath('userData')
    return `${dir}/logs/daydream.log`
  }
}

export const logger = {
  error: (...args: unknown[]): void => log.error(...args),
  warn: (...args: unknown[]): void => log.warn(...args),
  info: (...args: unknown[]): void => log.info(...args),
  debug: (...args: unknown[]): void => log.debug(...args)
}
