import type { Browser, BrowserContext, Page } from 'playwright'
import { chromium } from 'playwright-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'
import { config } from '../config'
import { logger } from '../utils/logger'
import { stealthContextOptions, applyStealthScripts } from './stealth'
import { sleep } from '../utils/retry'

// Attach stealth plugin once at module load
chromium.use(StealthPlugin() as never)

interface BrowserSlot {
  id: number
  browser: Browser
  useCount: number
  activePages: number
  healthy: boolean
}

export interface BrowserPage {
  context: BrowserContext
  page: Page
  release: () => Promise<void>
}

// Semaphore to limit total concurrently active pages across the pool
class Semaphore {
  private permits: number
  private waiters: Array<() => void> = []

  constructor(permits: number) {
    this.permits = permits
  }

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--
      return
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve))
  }

  release(): void {
    if (this.waiters.length > 0) {
      const next = this.waiters.shift()!
      next()
    } else {
      this.permits++
    }
  }
}

class BrowserPool {
  private slots: BrowserSlot[] = []
  private semaphore: Semaphore
  private initialized = false
  private slotLock = false

  constructor() {
    const totalPages = config.browser.maxBrowsers * config.browser.maxPagesPerBrowser
    this.semaphore = new Semaphore(totalPages)
  }

  async initialize(): Promise<void> {
    if (this.initialized) return
    this.initialized = true

    logger.info({ maxBrowsers: config.browser.maxBrowsers }, 'initializing browser pool')

    for (let i = 0; i < config.browser.maxBrowsers; i++) {
      const slot = await this.spawnBrowser(i)
      this.slots.push(slot)
    }

    logger.info('browser pool ready')
  }

  private async spawnBrowser(id: number): Promise<BrowserSlot> {
    const launchArgs = [
      '--disable-dev-shm-usage',       // critical for Docker — uses /tmp instead of /dev/shm
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-accelerated-2d-canvas',
      '--disable-gpu',
      '--window-size=1366,768',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-default-apps',
      '--disable-sync',
      '--disable-translate',
      '--mute-audio',
      '--no-first-run',
      '--single-process',              // run renderer inside browser process — saves ~150MB RAM
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      // NOTE: do NOT add --js-flags=--max-old-space-size=N — it crashes heavy JS sites
    ]

    const browser = await chromium.launch({
      headless: true,
      args: launchArgs,
      ...(config.proxy.url ? { proxy: { server: config.proxy.url } } : {}),
    })

    browser.on('disconnected', () => {
      logger.warn({ browserId: id }, 'browser disconnected unexpectedly')
      const slot = this.slots[id]
      if (slot) slot.healthy = false
    })

    return { id, browser, useCount: 0, activePages: 0, healthy: true }
  }

  async acquire(): Promise<BrowserPage> {
    await this.semaphore.acquire()

    const slot = await this.getAvailableSlot()

    const ctxOptions = stealthContextOptions(config.proxy.url)
    const context = await slot.browser.newContext(ctxOptions)
    const page = await context.newPage()

    await applyStealthScripts(page)

    // Block resource types that waste bandwidth and slow pages without adding content
    await context.route('**/*', (route: import('playwright').Route) => {
      const resourceType = route.request().resourceType()
      if (['font', 'media'].includes(resourceType)) {
        route.abort()
      } else {
        route.continue()
      }
    })

    slot.useCount++
    slot.activePages++

    const release = async () => {
      try {
        await context.close()
      } catch {
        // Context may already be closed if page crashed
      }
      slot.activePages--

      // Recycle browser after threshold to prevent memory accumulation
      if (slot.useCount >= config.browser.recycleAfter) {
        logger.debug({ browserId: slot.id, useCount: slot.useCount }, 'recycling browser')
        await this.recycleBrowser(slot)
      }

      this.semaphore.release()
    }

    return { context, page, release }
  }

  private async getAvailableSlot(): Promise<BrowserSlot> {
    // Spin-wait for a healthy slot with room; in practice resolved quickly because semaphore
    // already guarantees total page budget
    for (let i = 0; i < 100; i++) {
      for (const slot of this.slots) {
        if (slot.healthy && slot.activePages < config.browser.maxPagesPerBrowser) {
          return slot
        }
      }
      await sleep(50)
    }
    throw new Error('no healthy browser slot available after timeout')
  }

  private async recycleBrowser(slot: BrowserSlot): Promise<void> {
    try {
      await slot.browser.close()
    } catch {
      // Ignore close errors
    }
    slot.healthy = false

    try {
      const fresh = await this.spawnBrowser(slot.id)
      this.slots[slot.id] = fresh
    } catch (err) {
      logger.error({ err, browserId: slot.id }, 'failed to spawn replacement browser')
    }
  }

  async destroy(): Promise<void> {
    await Promise.allSettled(this.slots.map((s) => s.browser.close()))
    this.slots = []
    this.initialized = false
    logger.info('browser pool destroyed')
  }
}

// Module-level singleton — one pool per worker process
export const browserPool = new BrowserPool()
