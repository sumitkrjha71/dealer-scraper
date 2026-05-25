import { FastifyInstance } from 'fastify'
import { query } from '../../db/client'
import { dealerQueue, screenshotQueue } from '../../queue/queues'
import { browserPool } from '../../browser/pool'

export async function debugRoutes(app: FastifyInstance) {
  // Quick status dump — call this from browser to diagnose production issues
  app.get('/debug/status', async () => {
    const [pageJobStats] = await query<{
      pending: string; processing: string; completed: string; failed: string
    }>(
      `SELECT
        COUNT(*) FILTER (WHERE status = 'pending')    AS pending,
        COUNT(*) FILTER (WHERE status = 'processing') AS processing,
        COUNT(*) FILTER (WHERE status = 'completed')  AS completed,
        COUNT(*) FILTER (WHERE status = 'failed')     AS failed
       FROM page_jobs`,
    ).catch(() => [{ pending: '?', processing: '?', completed: '?', failed: '?' }])

    const recentErrors = await query<{ page_url: string; error_message: string; created_at: string }>(
      `SELECT page_url, error_message, created_at
       FROM page_jobs WHERE status = 'failed'
       ORDER BY created_at DESC LIMIT 10`,
    ).catch(() => [])

    const [dealerStats] = await query<{
      pending: string; processing: string; completed: string; failed: string
    }>(
      `SELECT
        COUNT(*) FILTER (WHERE status = 'pending')    AS pending,
        COUNT(*) FILTER (WHERE status = 'processing') AS processing,
        COUNT(*) FILTER (WHERE status = 'completed')  AS completed,
        COUNT(*) FILTER (WHERE status = 'failed')     AS failed
       FROM dealer_jobs`,
    ).catch(() => [{ pending: '?', processing: '?', completed: '?', failed: '?' }])

    let queueCounts = { dealer: {}, screenshot: {} }
    try {
      const [d, s] = await Promise.all([
        dealerQueue.getJobCounts(),
        screenshotQueue.getJobCounts(),
      ])
      queueCounts = { dealer: d, screenshot: s }
    } catch { /* redis might be unavailable */ }

    return {
      db: {
        dealer_jobs: dealerStats,
        page_jobs: pageJobStats,
      },
      queues: queueCounts,
      recent_errors: recentErrors,
      browser_pool: (browserPool as unknown as { initialized: boolean }).initialized ?? 'unknown',
    }
  })
}
