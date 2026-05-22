import { browserPool } from '../browser/pool'
import { startDealerWorker, stopDealerWorker } from './dealer.worker'
import { startScreenshotWorker, stopScreenshotWorker } from './screenshot.worker'
import { closeQueues } from '../queue/queues'
import { closePool } from '../db/client'
import { logger } from '../utils/logger'

async function main() {
  logger.info('starting worker process')

  // Initialize browser pool before accepting any jobs
  await browserPool.initialize()

  // Start both worker types — they consume from independent queues
  const dealerWorker = startDealerWorker()
  const screenshotWorker = startScreenshotWorker()

  logger.info('all workers running')

  // ── Graceful shutdown ────────────────────────────────────────────────────────
  // On SIGTERM (K8s pod eviction, docker stop): drain current jobs then exit cleanly
  async function gracefulShutdown(signal: string) {
    logger.info({ signal }, 'shutdown signal received, draining workers...')

    // Stop accepting new jobs
    await Promise.allSettled([
      dealerWorker.close(),
      screenshotWorker.close(),
    ])

    // Destroy browser pool (closes all browser processes)
    await browserPool.destroy()

    // Close queue connections
    await closeQueues()

    // Close database pool
    await closePool()

    logger.info('graceful shutdown complete')
    process.exit(0)
  }

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
  process.on('SIGINT', () => gracefulShutdown('SIGINT'))

  // Keep process alive — workers are event-driven via Redis
  process.on('uncaughtException', (err) => {
    logger.error({ err }, 'uncaught exception')
    gracefulShutdown('uncaughtException').catch(() => process.exit(1))
  })

  process.on('unhandledRejection', (reason) => {
    logger.error({ reason }, 'unhandled rejection')
  })
}

main().catch((err) => {
  logger.error({ err }, 'worker manager failed to start')
  process.exit(1)
})
