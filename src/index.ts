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

async function initWorkersInBackground(
  onReady: (dw: Worker, sw: Worker) => void,
) {
  // Retry browser init up to 3 times with 10s gaps before giving up
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      logger.info({ attempt }, 'initialising browser pool')
      await browserPool.initialize()
      const dw = startDealerWorker()
      const sw = startScreenshotWorker()
      logger.info('workers started')
      onReady(dw, sw)
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

  // 1. Start HTTP server FIRST — Railway health check must pass before anything else
  const app = await buildServer()
  await app.listen({ port: config.port, host: '0.0.0.0' })
  logger.info({ port: config.port }, 'server listening')

  // 2. Workers held here so shutdown() can close them
  let dealerWorker: Worker | undefined
  let screenshotWorker: Worker | undefined

  // 3. DB + migrations in background (don't block health check)
  ;(async () => {
    try {
      await waitForDb()
      await runMigrations()
    } catch (err) {
      logger.error({ err }, 'database setup failed')
      // Server stays up; DB-dependent endpoints will error naturally
      return
    }

    // 4. Browser pool + workers — completely non-blocking
    initWorkersInBackground((dw, sw) => {
      dealerWorker = dw
      screenshotWorker = sw
    }).catch((err) => logger.error({ err }, 'worker init crashed'))
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
