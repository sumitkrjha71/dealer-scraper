import { readFileSync } from 'fs'
import { join } from 'path'
import { buildServer } from './api/server'
import { browserPool } from './browser/pool'
import { startDealerWorker } from './workers/dealer.worker'
import { startScreenshotWorker } from './workers/screenshot.worker'
import { closeQueues } from './queue/queues'
import { pool, closePool } from './db/client'
import { config } from './config'
import { logger } from './utils/logger'
import type { Worker } from 'bullmq'

async function runMigrations() {
  let sql: string
  try {
    sql = readFileSync(join(__dirname, 'db/migrations/001_init.sql'), 'utf-8')
  } catch {
    sql = readFileSync(join(__dirname, '../src/db/migrations/001_init.sql'), 'utf-8')
  }
  await pool.query(sql)
  logger.info('database migrations applied')
}

async function main() {
  logger.info({ env: config.env }, 'dealer scraper starting')

  await runMigrations()

  // Server starts first — Railway health check passes immediately
  const app = await buildServer()
  await app.listen({ port: config.port, host: '0.0.0.0' })
  logger.info({ port: config.port }, 'server listening')

  // Workers are initialised after server is up; kept in outer scope for shutdown
  let dealerWorker: Worker | undefined
  let screenshotWorker: Worker | undefined

  try {
    await browserPool.initialize()
    dealerWorker = startDealerWorker()
    screenshotWorker = startScreenshotWorker()
    logger.info('workers started')
  } catch (err) {
    logger.error({ err }, 'browser pool failed to initialise — restarting')
    process.exit(1)
  }

  async function shutdown(signal: string) {
    logger.info({ signal }, 'shutting down')
    await Promise.allSettled([
      app.close(),
      dealerWorker?.close(),
      screenshotWorker?.close(),
    ])
    await browserPool.destroy()
    await closeQueues()
    await closePool()
    process.exit(0)
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT',  () => shutdown('SIGINT'))
  process.on('uncaughtException', (err) => {
    logger.error({ err }, 'uncaught exception')
    shutdown('uncaughtException').catch(() => process.exit(1))
  })
}

main().catch((err) => {
  logger.error({ err }, 'startup failed')
  process.exit(1)
})
