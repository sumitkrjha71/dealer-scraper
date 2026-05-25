import { Page } from 'playwright'
import sharp from 'sharp'
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

/**
 * Navigate to a URL and capture a full-page screenshot.
 * Designed to always succeed — falls back to viewport if full-page fails.
 */
export async function captureFullPage(page: Page, opts: CaptureOptions): Promise<CaptureResult> {
  const log = logger.child({ url: opts.url, pageNumber: opts.pageNumber })

  log.info('navigating')

  // Use domcontentloaded — 'load' waits for every image on the page and always times out
  // on image-heavy dealer inventory sites
  try {
    await page.goto(opts.url, { waitUntil: 'domcontentloaded', timeout: 45000 })
  } catch (navErr) {
    log.warn({ err: (navErr as Error).message }, 'domcontentloaded navigation failed, retrying with commit')
    // 'commit' fires the moment the server starts responding — captures something in all cases
    await page.goto(opts.url, { waitUntil: 'commit', timeout: 20000 }).catch((e) => {
      log.warn({ err: (e as Error).message }, 'commit navigation also failed, screenshotting whatever is loaded')
    })
  }

  // Wait for JS frameworks (React/Vue/Angular) to finish rendering
  await sleep(3500)

  // Dismiss cookie banners, modals, location popups
  await dismissOverlays(page).catch(() => {})

  // Scroll through the page to trigger lazy-loaded images — 15 passes is enough
  await triggerLazyLoading(page).catch(() => {})

  // Short wait for lazy-loaded content to settle
  await Promise.race([
    page.waitForLoadState('networkidle').catch(() => {}),
    sleep(6000),
  ])

  // Scroll back to top before screenshot
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' })).catch(() => {})
  await sleep(400)

  log.info('taking screenshot')

  // Try full-page screenshot; fall back to viewport if the page is too heavy
  let rawBuffer: Buffer
  let usedFullPage = true
  try {
    rawBuffer = await page.screenshot({ fullPage: true, type: 'png', timeout: 30000 })
  } catch (screenshotErr) {
    log.warn({ err: (screenshotErr as Error).message }, 'full-page screenshot failed, falling back to viewport')
    usedFullPage = false
    rawBuffer = await page.screenshot({ fullPage: false, type: 'png', timeout: 15000 })
  }

  // Compress PNG → JPEG to reduce file size ~70%
  const compressed = await sharp(rawBuffer)
    .jpeg({ quality: 85, progressive: true })
    .toBuffer()

  const meta = await sharp(compressed).metadata()

  log.info({ bytes: compressed.length, fullPage: usedFullPage }, 'screenshot captured')

  return {
    buffer: compressed,
    width: meta.width ?? 0,
    height: meta.height ?? 0,
    fileSizeBytes: compressed.length,
    botBlocked: false,
  }
}

async function triggerLazyLoading(page: Page): Promise<void> {
  const viewportHeight = page.viewportSize()?.height ?? 768
  const step = Math.round(viewportHeight * 0.8)
  const maxPasses = 15  // enough to trigger lazy loaders without OOMing

  let scrollY = 0
  for (let i = 0; i < maxPasses; i++) {
    const pageHeight: number = await page.evaluate(
      () => document.documentElement.scrollHeight,
    ).catch(() => 0)
    if (scrollY >= pageHeight) break

    await page.evaluate((y: number) => window.scrollTo({ top: y, behavior: 'instant' }), scrollY).catch(() => {})
    await sleep(200)
    scrollY += step
  }
}
