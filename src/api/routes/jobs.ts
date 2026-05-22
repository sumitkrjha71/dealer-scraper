import { FastifyInstance } from 'fastify'
import { parse } from 'csv-parse/sync'
import { submitBatch } from '../../queue/producer'
import { query } from '../../db/client'
import { isValidUrl } from '../../utils/url'

export async function jobRoutes(app: FastifyInstance) {

  // ── Submit a batch of dealer URLs ────────────────────────────────────────────
  app.post<{ Body: { urls?: string[]; csv?: string; submittedBy?: string } }>(
    '/batches',
    async (req, reply) => {
      const { urls, csv, submittedBy } = req.body ?? {}
      let inputUrls: string[] = []

      if (urls && Array.isArray(urls)) {
        inputUrls = urls
      } else if (csv && typeof csv === 'string') {
        const records = parse(csv, { columns: false, skip_empty_lines: true })
        inputUrls = records.flat().map(String).filter(isValidUrl)
      } else {
        return reply.status(400).send({ error: 'Provide either "urls" array or "csv" string' })
      }

      if (inputUrls.length === 0) {
        return reply.status(400).send({ error: 'No valid URLs provided' })
      }

      const result = await submitBatch({ urls: inputUrls, submittedBy })

      return reply.status(202).send(result)
    },
  )

  // ── Get batch status + summary ───────────────────────────────────────────────
  app.get<{ Params: { batchId: string } }>('/batches/:batchId', async (req, reply) => {
    const { batchId } = req.params

    const [batch] = await query(
      `SELECT id, status, total_urls, created_at, completed_at FROM batches WHERE id = $1`,
      [batchId],
    )
    if (!batch) return reply.status(404).send({ error: 'Batch not found' })

    const counts = await query<{
      status: string
      count: string
      pages_detected: number | null
    }>(
      `SELECT status, COUNT(*)::int AS count, SUM(pages_detected)::int AS pages_detected
       FROM dealer_jobs WHERE batch_id = $1 GROUP BY status`,
      [batchId],
    )

    const [screenshotCount] = await query<{ count: string }>(
      `SELECT COUNT(*)::int AS count FROM screenshots WHERE batch_id = $1`,
      [batchId],
    )

    return {
      batch_id: batchId,
      status: batch.status,
      total_urls: batch.total_urls,
      created_at: batch.created_at,
      completed_at: batch.completed_at,
      dealer_summary: counts,
      total_screenshots: screenshotCount.count,
    }
  })

  // ── Get full results for a batch (all screenshots organized by dealer) ───────
  app.get<{ Params: { batchId: string }; Querystring: { page?: string; limit?: string } }>(
    '/batches/:batchId/results',
    async (req, reply) => {
      const { batchId } = req.params
      const page = Math.max(1, parseInt(req.query.page ?? '1', 10))
      const limit = Math.min(100, Math.max(1, parseInt(req.query.limit ?? '50', 10)))
      const offset = (page - 1) * limit

      const dealers = await query(
        `SELECT dj.id, dj.dealer_url, dj.dealer_domain, dj.pages_detected,
                dj.status, dj.error_message,
                COALESCE(
                  json_agg(
                    json_build_object(
                      'page_number', s.page_number,
                      'page_url', s.page_url,
                      'storage_path', s.storage_path,
                      'storage_url', s.storage_url,
                      'captured_at', s.captured_at
                    ) ORDER BY s.page_number
                  ) FILTER (WHERE s.id IS NOT NULL),
                  '[]'
                ) AS screenshots
         FROM dealer_jobs dj
         LEFT JOIN screenshots s ON s.dealer_job_id = dj.id
         WHERE dj.batch_id = $1
         GROUP BY dj.id
         ORDER BY dj.created_at
         LIMIT $2 OFFSET $3`,
        [batchId, limit, offset],
      )

      const [{ count }] = await query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM dealer_jobs WHERE batch_id = $1`,
        [batchId],
      )

      return {
        batch_id: batchId,
        page,
        limit,
        total: parseInt(count, 10),
        dealers,
      }
    },
  )

  // ── Get single dealer job detail ─────────────────────────────────────────────
  app.get<{ Params: { dealerJobId: string } }>('/jobs/dealer/:dealerJobId', async (req, reply) => {
    const { dealerJobId } = req.params

    const [dealer] = await query(
      `SELECT dj.*,
              COALESCE(json_agg(pj ORDER BY pj.page_number) FILTER (WHERE pj.id IS NOT NULL), '[]') AS page_jobs
       FROM dealer_jobs dj
       LEFT JOIN page_jobs pj ON pj.dealer_job_id = dj.id
       WHERE dj.id = $1
       GROUP BY dj.id`,
      [dealerJobId],
    )

    if (!dealer) return reply.status(404).send({ error: 'Dealer job not found' })

    const screenshots = await query(
      `SELECT * FROM screenshots WHERE dealer_job_id = $1 ORDER BY page_number`,
      [dealerJobId],
    )

    return { ...dealer, screenshots }
  })

  // ── Retry failed dealer jobs in a batch ──────────────────────────────────────
  app.post<{ Params: { batchId: string } }>(
    '/batches/:batchId/retry-failed',
    async (req, reply) => {
      const { batchId } = req.params

      const failed = await query(
        `SELECT id, dealer_url, dealer_domain FROM dealer_jobs
         WHERE batch_id = $1 AND status = 'failed'`,
        [batchId],
      )

      if (failed.length === 0) {
        return { retried: 0, message: 'No failed jobs found' }
      }

      const { submitBatch: submit } = await import('../../queue/producer')
      const resubmit = await submit({
        urls: failed.map((f) => f.dealer_url as string),
        submittedBy: 'retry',
      })

      return { retried: failed.length, newBatchId: resubmit.batchId }
    },
  )
}
