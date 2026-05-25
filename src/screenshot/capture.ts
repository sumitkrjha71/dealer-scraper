import { Page } from 'playwright'
import sharp from 'sharp'
import { config } from '../config'
import { logger } from '../utils/logger'
import { sleep } from '../utils/retry'
import { dismissOverlays } from '../browser/stealth'

export interface CaptureOptions {
  url: string
  pageNumber: number
  dealerDomain: string
}

export interface CaptureResult {
  buffer: Buffer
  width: number
  height: number
  fileSizeBytes: number
  botBlocked: boolean
}

type MinLogger = { debug(obj: object, msg?: string): void; warn(obj: object, msg?: string): void }

/**
 * Navigate to a URL, fully load all lazy content, and capture a full-page screenshot.
 * Handles Cloudflare / bot-verification pages by waiting up to 20s for them to clear.
 */
export async function captureFullPage(page: Page, opts: CaptureOptions): Promise<CaptureResult> {
  const log = logger.child({ url: opts.url, pageNumber: opts.pageNumber })

  log.debug({}, 'navigating to page')

  // Try to wait for full load; fall back to domcontentloaded on heavy sites
  try {
    await page.goto(opts.url, { waitUntil: 'load', timeout: config.timeouts.pageLoad })
  } catch {
    try {
      await page.goto(opts.url, { waitUntil: 'domcontentloaded', timeout: config.timeouts.pageLoad })
    } catch (navErr) {
      // If navigation itself fails completely, try a bare goto and screenshot whatever loaded
      log.warn({ err: (navErr as Error).message }, 'navigation failed, attempting bare goto')
      await page.goto(opts.url, { waitUntil: 'commit', timeout: 15000 }).catch(() => {})
    }
  }

  // Extra wait for SPAs (React/Vue/Angular) to finish rendering after navigation
  await sleep(2500)

  // Wait for Cloudflare / bot-verification challenge to auto-resolve before anything else
  const botBlocked = await waitForBotChallenge(page, log)

  // Dismiss cookie banners, location modals, etc.
  await dismissOverlays(page)

  // Scroll through the page to trigger all lazy loaders
  await triggerLazyLoading(page, log)

  // Wait for network to settle after lazy loading triggers
  await waitForNetworkQuiet(page)

  // Wait for images to finish decoding
  await waitForImages(page)

  // Scroll back to top so the screenshot starts from position 0
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }))
  await sleep(500)

  log.debug({}, 'capturing full-page screenshot')

  // Try full-page first; fall back to viewport if it OOMs or crashes (common on Railway)
  let rawBuffer: Buffer
  try {
    rawBuffer = await page.screenshot({
      fullPage: true,
      type: 'png',
      timeout: config.timeouts.screenshot,
    })
  } catch (fullPageErr) {
    log.warn({ err: (fullPageErr as Error).message }, 'full-page screenshot failed, falling back to viewport')
    rawBuffer = await page.screenshot({
      fullPage: false,
      type: 'png',
      timeout: 20000,
    })
  }

  // Compress: convert to high-quality JPEG to reduce file size ~70%
  const compressed = await sharp(rawBuffer)
    .jpeg({ quality: 85, progressive: true })
    .toBuffer()

  const meta = await sharp(compressed).metadata()

  log.debug({ width: meta.width, height: meta.height, bytes: compressed.length }, 'screenshot captured')

  return {
    buffer: compressed,
    width: meta.width ?? 0,
    height: meta.height ?? 0,
    fileSizeBytes: compressed.length,
    botBlocked,
  }
}

// ─── Bot challenge detection & wait ─────────────────────────────────────────────

const CF_CHALLENGE_SIGNALS = [
  'just a moment',
  'verifying you are human',
  'performing security verification',
  'checking your browser',
  'please wait while we verify',
  'ddos protection by cloudflare',
  'enable javascript and cookies to continue',
]

/**
 * Detect Cloudflare / DataDome / PerimeterX challenge pages and wait up to 20s
 * for them to auto-resolve. Real Chromium with stealth patches often passes
 * JS-only challenges automatically — we just need to give it time.
 *
 * Returns true if a challenge was detected (even if it eventually cleared).
 */
async function waitForBotChallenge(page: Page, log: MinLogger): Promise<boolean> {
  const detected = await isBotChallengePage(page)
  if (!detected) return false

  log.warn({}, 'bot challenge detected — waiting up to 20s for auto-resolution')

  // Poll every 500ms for up to 20s to see if the challenge clears
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    await sleep(500)

    const stillBlocked = await isBotChallengePage(page)
    if (!stillBlocked) {
      log.warn({}, 'bot challenge cleared — proceeding with screenshot')
      // Give the real page a moment to finish rendering after the redirect
      await sleep(2000)
      await waitForNetworkQuiet(page)
      return true
    }
  }

  // Challenge did not clear — screenshot the block page as-is so the batch
  // result still records what was found (useful for debugging proxy needs)
  log.warn({}, 'bot challenge did not clear after 20s — screenshotting block page')
  return true
}

async function isBotChallengePage(page: Page): Promise<boolean> {
  return page.evaluate((signals: string[]) => {
    const title = document.title.toLowerCase()
    const body  = (document.body?.innerText ?? '').toLowerCase().slice(0, 500)
    return signals.some((s) => title.includes(s) || body.includes(s))
  }, CF_CHALLENGE_SIGNALS).catch(() => false)
}

// ─── Lazy loading scroll ────────────────────────────────────────────────────────

/**
 * Scroll the page from top to bottom in increments so that images and cards
 * behind IntersectionObserver lazy loaders are triggered.
 */
async function triggerLazyLoading(page: Page, log: MinLogger): Promise<void> {
  const viewportHeight = page.viewportSize()?.height ?? 768
  const step = Math.round(viewportHeight * 0.7)

  let scrollY = 0
  let passes = 0
  const maxPasses = 100

  while (passes < maxPasses) {
    const pageHeight: number = await page.evaluate(() => document.documentElement.scrollHeight)
    if (scrollY >= pageHeight) break

    await page.evaluate((y) => window.scrollTo({ top: y, behavior: 'instant' }), scrollY)
    await sleep(120)

    scrollY += step
    passes++
  }

  log.debug({ passes, finalScrollY: scrollY }, 'lazy loading scroll complete')
}

// ─── Network quiet ──────────────────────────────────────────────────────────────

async function waitForNetworkQuiet(page: Page): Promise<void> {
  await Promise.race([
    page.waitForLoadState('networkidle').catch(() => {}),
    sleep(config.timeouts.networkIdle),
  ])
}

// ─── Image completion ───────────────────────────────────────────────────────────

async function waitForImages(page: Page): Promise<void> {
  // Cap at 8s — broken/slow image URLs must not block the screenshot indefinitely
  await Promise.race([
    page.evaluate(async () => {
      const imgs = Array.from(document.querySelectorAll('img'))
      const pending = imgs.filter((img) => !img.complete).map(
        (img) =>
          new Promise<void>((resolve) => {
            img.addEventListener('load', () => resolve(), { once: true })
            img.addEventListener('error', () => resolve(), { once: true })
            if (img.complete) resolve()
          }),
      )
      await Promise.all(pending)
    }).catch(() => {}),
    sleep(8000),
  ])
}
