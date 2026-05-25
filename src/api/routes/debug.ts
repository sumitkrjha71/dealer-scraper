import { FastifyInstance } from 'fastify'
import { query } from '../../db/client'
import { dealerQueue, screenshotQueue } from '../../queue/queues'
import { browserPool } from '../../browser/pool'

export async function debugRoutes(app: FastifyInstance) {
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

    const [screenshotCount] = await query<{ total: string }>(
      `SELECT COUNT(*) AS total FROM screenshots`,
    ).catch(() => [{ total: '?' }])

    const recentErrors = await query<{ page_url: string; error_message: string; error_class: string; created_at: string }>(
      `SELECT page_url, error_message, error_class, created_at
       FROM page_jobs WHERE status = 'failed' AND error_message IS NOT NULL
       ORDER BY created_at DESC LIMIT 10`,
    ).catch(() => [])

    let queueCounts = { dealer: {} as Record<string, number>, screenshot: {} as Record<string, number> }
    try {
      const [d, s] = await Promise.all([
        dealerQueue.getJobCounts(),
        screenshotQueue.getJobCounts(),
      ])
      queueCounts = { dealer: d, screenshot: s }
    } catch { /* redis unavailable */ }

    return {
      browser_pool_state: (browserPool as unknown as { state: string }).state ?? 'unknown',
      db: {
        dealer_jobs: dealerStats,
        page_jobs: pageJobStats,
        screenshots_total: screenshotCount.total,
      },
      redis_queues: queueCounts,
      recent_page_job_errors: recentErrors,
    }
  })
}
