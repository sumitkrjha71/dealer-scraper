import { Worker, Job } from 'bullmq'
import { createRedisConnection, QUEUE_NAMES } from '../queue/queues'
import { ScreenshotJobPayload } from '../db/models'
import { browserPool } from '../browser/pool'
import { captureFullPage } from '../screenshot/capture'
import { saveScreenshot } from '../storage'
import { query } from '../db/client'
import { config } from '../config'
import { childLogger } from '../utils/logger'
import { classifyError } from '../utils/retry'

let worker: Worker<ScreenshotJobPayload> | undefined

export function startScreenshotWorker(): Worker<ScreenshotJobPayload> {
  worker = new Worker<ScreenshotJobPayload>(
    QUEUE_NAMES.SCREENSHOT,
    async (job: Job<ScreenshotJobPayload>) => {
      const { pageJobId, dealerJobId, batchId, pageUrl, pageNumber, dealerDomain } = job.data
      const log = childLogger({ pageJobId, dealerDomain, pageUrl, pageNumber })

      log.debug('starting screenshot capture')

      await query(
        `UPDATE page_jobs SET status = 'processing', started_at = NOW(), attempts = attempts + 1 WHERE id = $1`,
        [pageJobId],
      )

      const { page, release } = await browserPool.acquire()

      try {
        const result = await captureFullPage(page, { url: pageUrl, pageNumber, dealerDomain })

        const storage = await saveScreenshot(result.buffer, batchId, dealerDomain, pageNumber)

        await query(
          `INSERT INTO screenshots
             (page_job_id, dealer_job_id, batch_id, dealer_domain, page_url, page_number,
              storage_path, storage_url, file_size_bytes, width_px, height_px, bot_blocked)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [
            pageJobId,
            dealerJobId,
            batchId,
            dealerDomain,
            pageUrl,
            pageNumber,
            storage.storagePath,
            storage.storageUrl ?? null,
            result.fileSizeBytes,
            result.width,
            result.height,
            result.botBlocked,
          ],
        )

        await query(
          `UPDATE page_jobs SET status = 'completed', completed_at = NOW() WHERE id = $1`,
          [pageJobId],
        )

        log.info(
          { storagePath: storage.storagePath, bytes: result.fileSizeBytes, botBlocked: result.botBlocked },
          'screenshot captured and stored',
        )
      } catch (rawErr) {
        const err = classifyError(rawErr)
        log.error({ err: err.message, errorClass: err.errorClass }, 'screenshot capture failed')

        await query(
          `UPDATE page_jobs
           SET status = 'failed', error_class = $2, error_message = $3
           WHERE id = $1`,
          [pageJobId, err.errorClass, err.message.slice(0, 500)],
        )

        throw err // Let BullMQ handle retry scheduling
      } finally {
        await release()
      }
    },
    {
      connection: createRedisConnection(),
      concurrency: config.concurrency.screenshotWorkers,
    },
  )

  worker.on('failed', (job, err) => {
    childLogger({ pageJobId: job?.data.pageJobId }).warn(
      { err: err.message, attempts: job?.attemptsMade },
      'screenshot job failed',
    )
  })

  return worker
}

export async function stopScreenshotWorker(): Promise<void> {
  await worker?.close()
}
