import { Queue } from 'bullmq'
import IORedis from 'ioredis'
import { config } from '../config'
import type { DealerJobPayload, ScreenshotJobPayload } from '../db/models'

export function createRedisConnection() {
  return new IORedis(config.redis.url, {
    maxRetriesPerRequest: null, // Required by BullMQ
    enableReadyCheck: false,
    lazyConnect: false,
  })
}

const baseJobOptions = {
  removeOnComplete: { count: 500 },
  removeOnFail: { count: 2000 },
}

// Third generic = job name type (string); second = result type (void)
export const dealerQueue = new Queue<DealerJobPayload, void, string>('dealer-discovery', {
  connection: createRedisConnection(),
  defaultJobOptions: {
    ...baseJobOptions,
    attempts: config.retry.maxAttempts,
    backoff: { type: 'exponential' as const, delay: config.retry.delayMs },
  },
})

export const screenshotQueue = new Queue<ScreenshotJobPayload, void, string>('screenshot-capture', {
  connection: createRedisConnection(),
  defaultJobOptions: {
    ...baseJobOptions,
    attempts: config.retry.maxAttempts,
    backoff: { type: 'exponential' as const, delay: config.retry.delayMs },
  },
})

export async function closeQueues(): Promise<void> {
  await Promise.all([dealerQueue.close(), screenshotQueue.close()])
}

export const QUEUE_NAMES = {
  DEALER: 'dealer-discovery',
  SCREENSHOT: 'screenshot-capture',
} as const
