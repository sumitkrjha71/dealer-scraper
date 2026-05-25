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

// Cap screenshot height to avoid OOM on massive pages (500+ car listings)
const MAX_SCREENSHOT_HEIGHT = 6000

export async function captureFullPage(page: Page, opts: CaptureOptions): Promise<CaptureResult> {
  const log = logger.child({ url: opts.url, pageNumber: opts.pageNumber })

  log.info('navigating')

  try {
    await page.goto(opts.url, { waitUntil: 'domcontentloaded', timeout: 45000 })
  } catch (navErr) {
    log.warn({ err: (navErr as Error).message }, 'domcontentloaded failed, retrying with commit')
    await page.goto(opts.url, { waitUntil: 'commit', timeout: 20000 }).catch((e) => {
      log.warn({ err: (e as Error).message }, 'commit navigation also failed, screenshotting whatever loaded')
    })
  }

  // Let JS frameworks render
  await sleep(2000)

  // Dismiss cookie banners, modals, location popups
  await dismissOverlays(page).catch(() => {})

  // Scroll to trigger lazy-loaded images
  await triggerLazyLoading(page).catch(() => {})

  // Wait for network to settle (max 4s)
  await Promise.race([
    page.waitForLoadState('networkidle').catch(() => {}),
    sleep(4000),
  ])

  // Scroll back to top
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' })).catch(() => {})
  await sleep(300)

  log.info('taking screenshot')

  // Check actual page height and cap it to avoid OOM with huge inventory pages
  const pageHeight = await page.evaluate(() => document.documentElement.scrollHeight).catch(() => 0)
  const viewport = page.viewportSize() ?? { width: 1366, height: 768 }

  let rawBuffer: Buffer

  if (pageHeight > MAX_SCREENSHOT_HEIGHT) {
    // Page is too tall for safe fullPage screenshot — clip to max height
    log.info({ pageHeight, cap: MAX_SCREENSHOT_HEIGHT }, 'page tall, using clipped screenshot')
    rawBuffer = await page.screenshot({
      clip: { x: 0, y: 0, width: viewport.width, height: MAX_SCREENSHOT_HEIGHT },
      type: 'png',
      timeout: 30000,
    })
  } else {
    // Normal full-page screenshot
    try {
      rawBuffer = await page.screenshot({ fullPage: true, type: 'png', timeout: 30000 })
    } catch (screenshotErr) {
      log.warn({ err: (screenshotErr as Error).message }, 'fullPage screenshot failed, falling back to viewport')
      rawBuffer = await page.screenshot({ fullPage: false, type: 'png', timeout: 15000 })
    }
  }

  // Compress PNG → JPEG
  const compressed = await sharp(rawBuffer)
    .jpeg({ quality: 85, progressive: true })
    .toBuffer()

  const meta = await sharp(compressed).metadata()

  log.info({ bytes: compressed.length, pageHeight }, 'screenshot captured')

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
  const scrollLimit = MAX_SCREENSHOT_HEIGHT // don't scroll past what we'll screenshot

  let scrollY = 0
  for (let i = 0; i < 12; i++) {
    const pageHeight: number = await page.evaluate(
      () => document.documentElement.scrollHeight,
    ).catch(() => 0)
    if (scrollY >= pageHeight || scrollY >= scrollLimit) break

    await page.evaluate((y: number) => window.scrollTo({ top: y, behavior: 'instant' }), scrollY).catch(() => {})
    await sleep(150)
    scrollY += step
  }
}
