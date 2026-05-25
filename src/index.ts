/**
 * Unified entry point — runs API server and workers in the same process.
 * For production: run API and workers as separate containers/processes.
 * For development: this combined mode is convenient.
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import { buildServer } from './api/server'
import { browserPool } from './browser/pool'
import { startDealerWorker, stopDealerWorker } from './workers/dealer.worker'
import { startScreenshotWorker, stopScreenshotWorker } from './workers/screenshot.worker'
import { closeQueues } from './queue/queues'
import { pool, closePool } from './db/client'
import { config } from './config'
import { logger } from './utils/logger'

async function runMigrations() {
  const sql = readFileSync(join(__dirname, '../src/db/migrations/001_init.sql'), 'utf-8')
  await pool.query(sql)
  logger.info('database migrations applied')
}

async function main() {
  logger.info({ env: config.env }, 'dealer scraper starting')

  await runMigrations()

  // Start HTTP server first — Railway health check must pass before browser init
  const app = await buildServer()
  await app.listen({ port: config.port, host: '0.0.0.0' })
  logger.info({ port: config.port }, 'server listening')

  // Browser pool + workers start after server is up
  await browserPool.initialize()

  const dealerWorker = startDealerWorker()
  const screenshotWorker = startScreenshotWorker()

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
