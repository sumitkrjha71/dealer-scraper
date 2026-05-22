import { PoolClient } from 'pg'
import { v4 as uuidv4 } from 'uuid'
import { withTransaction, query } from '../db/client'
import { dealerQueue } from './queues'
import { DealerJobPayload } from '../db/models'
import { extractDomain, isValidUrl, normalizeUrl } from '../utils/url'
import { logger } from '../utils/logger'

export interface BatchSubmission {
  urls: string[]
  submittedBy?: string
}

export interface BatchSubmissionResult {
  batchId: string
  accepted: number
  rejected: { url: string; reason: string }[]
}

export async function submitBatch(submission: BatchSubmission): Promise<BatchSubmissionResult> {
  const rejected: { url: string; reason: string }[] = []
  const validUrls: string[] = []

  // Validate and deduplicate
  const seen = new Set<string>()
  for (const raw of submission.urls) {
    const url = normalizeUrl(raw)
    if (!isValidUrl(url)) {
      rejected.push({ url: raw, reason: 'invalid URL format' })
      continue
    }
    if (seen.has(url)) {
      rejected.push({ url: raw, reason: 'duplicate in batch' })
      continue
    }
    seen.add(url)
    validUrls.push(url)
  }

  if (validUrls.length === 0) {
    throw new Error('No valid URLs in batch')
  }

  let batchId!: string

  await withTransaction(async (client: PoolClient) => {
    // Create batch record
    const batchResult = await client.query<{ id: string }>(
      `INSERT INTO batches (total_urls, submitted_by, status)
       VALUES ($1, $2, 'pending') RETURNING id`,
      [validUrls.length, submission.submittedBy ?? null],
    )
    batchId = batchResult.rows[0].id

    // Create dealer job records and enqueue
    for (const dealerUrl of validUrls) {
      const dealerDomain = extractDomain(dealerUrl)
      const jobResult = await client.query<{ id: string }>(
        `INSERT INTO dealer_jobs (batch_id, dealer_url, dealer_domain, status)
         VALUES ($1, $2, $3, 'pending') RETURNING id`,
        [batchId, dealerUrl, dealerDomain],
      )
      const dealerJobId = jobResult.rows[0].id

      const payload: DealerJobPayload = {
        dealerJobId,
        batchId,
        dealerUrl,
        dealerDomain,
      }

      // Enqueue. BullMQ job ID = dealerJobId for easy cross-reference.
      const bullJob = await dealerQueue.add('discover', payload, {
        jobId: `dealer_${dealerJobId}`,
        // Priority: process newest batches first to give user faster first results
        priority: 1,
      })

      await client.query(
        `UPDATE dealer_jobs SET bull_job_id = $1 WHERE id = $2`,
        [bullJob.id, dealerJobId],
      )
    }

    await client.query(`UPDATE batches SET status = 'processing' WHERE id = $1`, [batchId])
  })

  logger.info({ batchId, accepted: validUrls.length, rejected: rejected.length }, 'batch submitted')

  return { batchId, accepted: validUrls.length, rejected }
}

export async function enqueueScreenshotJob(payload: import('../db/models').ScreenshotJobPayload): Promise<void> {
  const { screenshotQueue } = await import('./queues')

  const bullJob = await screenshotQueue.add('capture', payload, {
    jobId: `screenshot_${payload.pageJobId}`,
  })

  await query(
    `UPDATE page_jobs SET bull_job_id = $1 WHERE id = $2`,
    [bullJob.id, payload.pageJobId],
  )
}
