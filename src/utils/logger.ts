import pino from 'pino'
import { config } from '../config'

export const logger = pino({
  level: config.env === 'production' ? 'info' : 'debug',
  transport:
    config.env !== 'production'
      ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:standard' } }
      : undefined,
  base: { service: 'dealer-scraper' },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level(label) {
      return { level: label }
    },
  },
})

export function childLogger(context: Record<string, unknown>) {
  return logger.child(context)
}

export type Logger = typeof logger
