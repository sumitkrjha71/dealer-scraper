import { cleanEnv, str, num, url, bool } from 'envalid'
import dotenv from 'dotenv'

dotenv.config()

const env = cleanEnv(process.env, {
  NODE_ENV: str({ choices: ['development', 'production', 'test'], default: 'development' }),
  PORT: num({ default: 3001 }),

  REDIS_URL: str({ default: 'redis://localhost:6379' }),
  DATABASE_URL: str({ default: 'postgresql://postgres:postgres@localhost:5432/dealer_scraper' }),

  MAX_BROWSERS: num({ default: 1 }),
  MAX_PAGES_PER_BROWSER: num({ default: 2 }),
  BROWSER_RECYCLE_AFTER: num({ default: 20 }),

  DEALER_WORKER_CONCURRENCY: num({ default: 10 }),
  SCREENSHOT_WORKER_CONCURRENCY: num({ default: 2 }),

  PAGE_LOAD_TIMEOUT: num({ default: 60000 }),
  NETWORK_IDLE_TIMEOUT: num({ default: 10000 }),
  SCREENSHOT_TIMEOUT: num({ default: 60000 }),
  INFINITE_SCROLL_WAIT_MS: num({ default: 3000 }),
  MAX_PAGES_PER_DEALER: num({ default: 50 }),

  MAX_RETRIES: num({ default: 3 }),
  RETRY_DELAY_MS: num({ default: 2000 }),

  STORAGE_PROVIDER: str({ choices: ['local', 's3'], default: 'local' }),
  SCREENSHOTS_DIR: str({ default: './screenshots' }),

  AWS_REGION: str({ default: 'us-east-1' }),
  AWS_BUCKET: str({ default: '' }),
  AWS_ACCESS_KEY_ID: str({ default: '' }),
  AWS_SECRET_ACCESS_KEY: str({ default: '' }),
  S3_ENDPOINT: str({ default: '' }),

  PROXY_URL: str({ default: '' }),
  REQUESTS_PER_DOMAIN_PER_MINUTE: num({ default: 10 }),
})

export const config = {
  env: env.NODE_ENV,
  port: env.PORT,

  redis: {
    url: env.REDIS_URL,
  },

  database: {
    url: env.DATABASE_URL,
  },

  browser: {
    maxBrowsers: env.MAX_BROWSERS,
    maxPagesPerBrowser: env.MAX_PAGES_PER_BROWSER,
    recycleAfter: env.BROWSER_RECYCLE_AFTER,
  },

  concurrency: {
    dealerWorkers: env.DEALER_WORKER_CONCURRENCY,
    screenshotWorkers: env.SCREENSHOT_WORKER_CONCURRENCY,
  },

  timeouts: {
    pageLoad: env.PAGE_LOAD_TIMEOUT,
    networkIdle: env.NETWORK_IDLE_TIMEOUT,
    screenshot: env.SCREENSHOT_TIMEOUT,
    infiniteScrollWait: env.INFINITE_SCROLL_WAIT_MS,
  },

  limits: {
    maxPagesPerDealer: env.MAX_PAGES_PER_DEALER,
  },

  retry: {
    maxAttempts: env.MAX_RETRIES,
    delayMs: env.RETRY_DELAY_MS,
  },

  storage: {
    provider: env.STORAGE_PROVIDER as 'local' | 's3',
    screenshotsDir: env.SCREENSHOTS_DIR,
    s3: {
      region: env.AWS_REGION,
      bucket: env.AWS_BUCKET,
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
      endpoint: env.S3_ENDPOINT || undefined,
    },
  },

  proxy: {
    url: env.PROXY_URL || undefined,
  },

  rateLimit: {
    requestsPerDomainPerMinute: env.REQUESTS_PER_DOMAIN_PER_MINUTE,
  },
} as const
