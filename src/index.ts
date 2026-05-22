/**
 * Unified entry point — runs API server and workers in the same process.
 * For production: run API and workers as separate containers/processes.
 * For development: this combined mode is convenient.
 */
import { buildServer } from './api/server'
import { browserPool } from './browser/pool'
import { startDealerWorker, stopDealerWorker } from './workers/dealer.worker'
import { startScreenshotWorker, stopScreenshotWorker } from './workers/screenshot.worker'
import { closeQueues } from './queue/queues'
import { closePool } from './db/client'
import { config } from './config'
import { logger } from './utils/logger'

async function main() {
  logger.info({ env: config.env }, 'dealer scraper starting')

  await browserPool.initialize()

  const dealerWorker = startDealerWorker()
  const screenshotWorker = startScreenshotWorker()

  const app = await buildServer()
  await app.listen({ port: config.port, host: '0.0.0.0' })

  logger.info({ port: config.port }, 'dealer scraper ready')

  async function shutdown(signal: string) {
    logger.info({ signal }, 'shutting down')
    await Promise.allSettled([
      app.close(),
      dealerWorker.close(),
      screenshotWorker.close(),
    ])
    await browserPool.destroy()
    await closeQueues()
    await closePool()
    process.exit(0)
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('uncaughtException', (err) => {
    logger.error({ err }, 'uncaught exception')
    shutdown('uncaughtException').catch(() => process.exit(1))
  })
}

main().catch((err) => {
  logger.error({ err }, 'startup failed')
  process.exit(1)
})
