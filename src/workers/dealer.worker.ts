import { Worker, Job } from 'bullmq'
import { v4 as uuidv4 } from 'uuid'
import { createRedisConnection, QUEUE_NAMES } from '../queue/queues'
import { enqueueScreenshotJob } from '../queue/producer'
import { DealerJobPayload, ScreenshotJobPayload } from '../db/models'
import { browserPool } from '../browser/pool'
import { detectPagination, enforcePageCap } from '../pagination/detector'
import { query } from '../db/client'
import { config } from '../config'
import { childLogger } from '../utils/logger'
import { classifyError } from '../utils/retry'
import { sleep } from '../utils/retry'

let worker: Worker<DealerJobPayload> | undefined

export function startDealerWorker(): Worker<DealerJobPayload> {
  worker = new Worker<DealerJobPayload>(
    QUEUE_NAMES.DEALER,
    async (job: Job<DealerJobPayload>) => {
      const { dealerJobId, batchId, dealerUrl, dealerDomain } = job.data
      const log = childLogger({ dealerJobId, batchId, dealerUrl, jobAttempt: job.attemptsMade + 1 })

      log.info('starting dealer discovery')

      await query(
        `UPDATE dealer_jobs SET status = 'processing', started_at = NOW(), attempts = attempts + 1 WHERE id = $1`,
        [dealerJobId],
      )

      const { page, release } = await browserPool.acquire()

      try {
        await page.goto(dealerUrl, {
          waitUntil: 'domcontentloaded',
          timeout: config.timeouts.pageLoad,
        })

        // Brief wait for client-side pagination components to mount
        await sleep(1200)

        const raw = await detectPagination(page, dealerUrl)
        const pagination = enforcePageCap(raw)

        log.info(
          { strategy: pagination.strategy, totalPages: pagination.totalPages },
          'pagination detected, enqueuing screenshot jobs',
        )

        // Record all page jobs in DB in a single batch, then enqueue to BullMQ
        const pageJobIds = await createPageJobs(dealerJobId, batchId, pagination.urls)

        for (let i = 0; i < pagination.urls.length; i++) {
          const pageJobId = pageJobIds[i]
          const payload: ScreenshotJobPayload = {
            pageJobId,
            dealerJobId,
            batchId,
            pageUrl: pagination.urls[i],
            pageNumber: i + 1,
            dealerDomain,
          }
          await enqueueScreenshotJob(payload)
        }

        await query(
          `UPDATE dealer_jobs
           SET status = 'completed', pages_detected = $2, completed_at = NOW()
           WHERE id = $1`,
          [dealerJobId, pagination.totalPages],
        )

        log.info({ pagesEnqueued: pagination.urls.length }, 'dealer discovery complete')
      } catch (rawErr) {
        const err = classifyError(rawErr)
        log.error({ err: err.message, errorClass: err.errorClass }, 'dealer discovery failed')

        await query(
          `UPDATE dealer_jobs
           SET status = 'failed', error_class = $2, error_message = $3
           WHERE id = $1`,
          [dealerJobId, err.errorClass, err.message.slice(0, 500)],
        )

        throw err // BullMQ handles retry scheduling
      } finally {
        await release()
      }
    },
    {
      connection: createRedisConnection(),
      concurrency: config.concurrency.dealerWorkers,
    },
  )

  worker.on('failed', (job, err) => {
    childLogger({ dealerJobId: job?.data.dealerJobId }).warn(
      { err: err.message, attempts: job?.attemptsMade },
      'dealer job failed',
    )
  })

  return worker
}

async function createPageJobs(
  dealerJobId: string,
  batchId: string,
  urls: string[],
): Promise<string[]> {
  const ids: string[] = []
  for (let i = 0; i < urls.length; i++) {
    const result = await query<{ id: string }>(
      `INSERT INTO page_jobs (dealer_job_id, batch_id, page_url, page_number, status)
       VALUES ($1, $2, $3, $4, 'pending') RETURNING id`,
      [dealerJobId, batchId, urls[i], i + 1],
    )
    ids.push(result[0].id)
  }
  return ids
}

export async function stopDealerWorker(): Promise<void> {
  await worker?.close()
}
