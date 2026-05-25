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

async function waitForDb(maxAttempts = 10, delayMs = 3000): Promise<void> {
  for (let i = 1; i <= maxAttempts; i++) {
    try {
      await pool.query('SELECT 1')
      return
    } catch (err) {
      logger.warn({ attempt: i, maxAttempts }, 'database not ready, retrying...')
      if (i === maxAttempts) throw err
      await new Promise((r) => setTimeout(r, delayMs))
    }
  }
}

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

  // 1. HTTP server first — health check passes within seconds
  const app = await buildServer()
  await app.listen({ port: config.port, host: '0.0.0.0' })
  logger.info({ port: config.port }, 'server listening')

  let dealerWorker: Worker | undefined
  let screenshotWorker: Worker | undefined

  // 2. DB setup + both workers in background (non-blocking)
  //    Chrome is lazily initialized on the first screenshot job — no separate browser phase
  ;(async () => {
    try {
      await waitForDb()
      await runMigrations()
    } catch (err) {
      logger.error({ err }, 'database setup failed — workers not starting')
      return
    }

    dealerWorker = startDealerWorker()
    screenshotWorker = startScreenshotWorker()
    logger.info('both workers started — Chrome will launch on first screenshot job')
  })().catch((err) => logger.error({ err }, 'worker startup crashed'))

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
