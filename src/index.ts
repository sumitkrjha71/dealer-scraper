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
      logger.warn({ attempt: i, maxAttempts }, 'database not ready yet, retrying...')
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

async function initBrowserWorker(onReady: (sw: Worker) => void): Promise<void> {
  // Retry Chrome launch up to 3 times — it can fail on first boot in constrained containers
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      logger.info({ attempt }, 'initialising browser pool')
      await browserPool.initialize()
      const sw = startScreenshotWorker()
      logger.info('screenshot worker started')
      onReady(sw)
      return
    } catch (err) {
      logger.error({ err, attempt }, 'browser pool init failed')
      if (attempt < 3) {
        await new Promise((r) => setTimeout(r, 10_000))
        try { await browserPool.destroy() } catch { /* ignore */ }
      }
    }
  }
  logger.error('all browser pool init attempts exhausted — screenshot jobs will fail')
}

async function main() {
  logger.info({ env: config.env }, 'dealer scraper starting')

  // 1. HTTP server first — Railway health check passes before anything else
  const app = await buildServer()
  await app.listen({ port: config.port, host: '0.0.0.0' })
  logger.info({ port: config.port }, 'server listening')

  // Outer-scope refs so shutdown() can close them
  let dealerWorker: Worker | undefined
  let screenshotWorker: Worker | undefined

  // 2. DB → migrations → workers, all in background (never blocks health check)
  ;(async () => {
    try {
      await waitForDb()
      await runMigrations()
    } catch (err) {
      logger.error({ err }, 'database setup failed — workers not starting')
      return
    }

    // 3. Dealer worker starts immediately — it only uses DB + Redis, no browser
    dealerWorker = startDealerWorker()
    logger.info('dealer worker started')

    // 4. Screenshot worker starts after browser pool is ready (Chrome may take a moment)
    initBrowserWorker((sw) => {
      screenshotWorker = sw
    }).catch((err) => logger.error({ err }, 'browser worker init crashed'))
  })()

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
