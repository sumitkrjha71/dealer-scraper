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
  // 'idle' | 'initializing' | 'ready' | 'failed'
  private state: 'idle' | 'initializing' | 'ready' | 'failed' = 'idle'
  private initPromise: Promise<void> | null = null
  private slotLock = false

  // Keep for backward-compat with debug endpoint
  get initialized() { return this.state === 'ready' }

  constructor() {
    const totalPages = config.browser.maxBrowsers * config.browser.maxPagesPerBrowser
    this.semaphore = new Semaphore(totalPages)
  }

  async initialize(): Promise<void> {
    if (this.state === 'ready') return
    // If already initializing, wait for that to finish rather than double-launching
    if (this.initPromise) return this.initPromise
    this.initPromise = this._doInit().finally(() => { this.initPromise = null })
    return this.initPromise
  }

  private async _doInit(): Promise<void> {
    this.state = 'initializing'
    logger.info({ maxBrowsers: config.browser.maxBrowsers }, 'initializing browser pool')
    try {
      for (let i = 0; i < config.browser.maxBrowsers; i++) {
        const slot = await this.spawnBrowser(i)
        this.slots.push(slot)
      }
      this.state = 'ready'
      logger.info('browser pool ready')
    } catch (err) {
      this.state = 'failed'
      this.slots = []
      throw err
    }
  }

  private async spawnBrowser(id: number): Promise<BrowserSlot> {
    const launchArgs = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-accelerated-2d-canvas',
      '--window-size=1366,768',
      // Memory / stability for constrained containers
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-default-apps',
      '--disable-sync',
      '--disable-translate',
      '--disable-hang-monitor',
      '--disable-ipc-flooding-protection',
      '--metrics-recording-only',
      '--no-first-run',
      '--safebrowsing-disable-auto-update',
      '--password-store=basic',
      '--use-mock-keychain',
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
    // Lazy-init: launch Chrome on first use rather than at startup
    if (this.state !== 'ready') await this.initialize()

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
    this.state = 'idle'
    this.initPromise = null
    logger.info('browser pool destroyed')
  }
}

// Module-level singleton — one pool per worker process
export const browserPool = new BrowserPool()
