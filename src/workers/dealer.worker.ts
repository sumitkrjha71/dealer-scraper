import { Worker, Job } from 'bullmq'
import { createRedisConnection, QUEUE_NAMES } from '../queue/queues'
import { enqueueScreenshotJob } from '../queue/producer'
import { DealerJobPayload, ScreenshotJobPayload } from '../db/models'
import { query } from '../db/client'
import { config } from '../config'
import { childLogger } from '../utils/logger'
import { classifyError } from '../utils/retry'

let worker: Worker<DealerJobPayload> | undefined

export function startDealerWorker(): Worker<DealerJobPayload> {
  worker = new Worker<DealerJobPayload>(
    QUEUE_NAMES.DEALER,
    async (job: Job<DealerJobPayload>) => {
      const { dealerJobId, batchId, dealerUrl, dealerDomain } = job.data
      const log = childLogger({ dealerJobId, batchId, dealerUrl })

      log.info('enqueuing screenshot job')

      await query(
        `UPDATE dealer_jobs SET status = 'processing', started_at = NOW(), attempts = attempts + 1 WHERE id = $1`,
        [dealerJobId],
      )

      try {
        // One URL → one screenshot. No pagination detection, no browser in this worker.
        const result = await query<{ id: string }>(
          `INSERT INTO page_jobs (dealer_job_id, batch_id, page_url, page_number, status)
           VALUES ($1, $2, $3, 1, 'pending') RETURNING id`,
          [dealerJobId, batchId, dealerUrl],
        )
        const pageJobId = result[0].id

        const payload: ScreenshotJobPayload = {
          pageJobId,
          dealerJobId,
          batchId,
          pageUrl: dealerUrl,
          pageNumber: 1,
          dealerDomain,
        }
        await enqueueScreenshotJob(payload)

        await query(
          `UPDATE dealer_jobs SET status = 'completed', pages_detected = 1, completed_at = NOW() WHERE id = $1`,
          [dealerJobId],
        )

        log.info('screenshot job enqueued')
      } catch (rawErr) {
        const err = classifyError(rawErr)
        log.error({ err: err.message, errorClass: err.errorClass }, 'dealer job failed')

        await query(
          `UPDATE dealer_jobs SET status = 'failed', error_class = $2, error_message = $3 WHERE id = $1`,
          [dealerJobId, err.errorClass, err.message.slice(0, 500)],
        )

        throw err
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

export async function stopDealerWorker(): Promise<void> {
  await worker?.close()
}
