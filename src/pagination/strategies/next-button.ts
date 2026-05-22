import { Page } from 'playwright'
import { createHash } from 'crypto'
import { config } from '../../config'
import { logger } from '../../utils/logger'
import { sleep } from '../../utils/retry'

export interface NextButtonResult {
  strategy: 'next-button'
  urls: string[]
  totalPages: number
}

// Selectors for "Next" buttons across common dealer platforms
const NEXT_SELECTORS = [
  'a[aria-label*="Next" i]',
  'a[rel="next"]',
  'a[class*="next"]:not([disabled])',
  'button[class*="next"]:not([disabled])',
  'li.next a',
  'li[class*="next"] a',
  '.pagination-next a',
  '[data-page="next"]',
  'a:has-text("Next")',
  'a:has-text("Next Page")',
  'button:has-text("Next")',
  'a:has-text("›")',
  'a:has-text("»")',
]

/**
 * Walk pagination by finding and following "Next" links.
 * Collects all page URLs and deduplicates by content hash to detect loops.
 */
export async function detectNextButtonPagination(
  page: Page,
  currentUrl: string,
): Promise<NextButtonResult | null> {
  const hasNext = await findNextButton(page)
  if (!hasNext) return null

  logger.debug({ url: currentUrl }, 'next-button pagination detected, walking pages')

  const urls: string[] = [currentUrl]
  const contentHashes = new Set<string>([await hashPageContent(page)])
  const visitedUrls = new Set<string>([currentUrl])

  const maxPages = config.limits.maxPagesPerDealer

  while (urls.length < maxPages) {
    const nextHref = await getNextHref(page)
    if (!nextHref) break

    // Absolute URL resolution
    let nextUrl: string
    try {
      nextUrl = new URL(nextHref, currentUrl).toString()
    } catch {
      break
    }

    if (visitedUrls.has(nextUrl)) {
      logger.debug({ nextUrl }, 'loop detected in next-button pagination')
      break
    }

    await page.goto(nextUrl, {
      waitUntil: 'domcontentloaded',
      timeout: config.timeouts.pageLoad,
    })
    await sleep(800) // Short stabilization pause

    const hash = await hashPageContent(page)
    if (contentHashes.has(hash)) {
      logger.debug({ nextUrl }, 'duplicate content detected, stopping next-button walk')
      break
    }

    contentHashes.add(hash)
    visitedUrls.add(nextUrl)
    urls.push(nextUrl)
    currentUrl = nextUrl
  }

  if (urls.length <= 1) return null

  return { strategy: 'next-button', urls, totalPages: urls.length }
}

async function findNextButton(page: Page): Promise<boolean> {
  for (const selector of NEXT_SELECTORS) {
    try {
      const el = page.locator(selector).first()
      if (await el.isVisible({ timeout: 500 })) return true
    } catch {
      // Selector not matched
    }
  }
  return false
}

async function getNextHref(page: Page): Promise<string | null> {
  for (const selector of NEXT_SELECTORS) {
    try {
      const el = page.locator(selector).first()
      if (!(await el.isVisible({ timeout: 500 }))) continue

      // Check disabled state
      const disabled =
        (await el.getAttribute('disabled')) !== null ||
        (await el.getAttribute('aria-disabled')) === 'true' ||
        (await el.getAttribute('class'))?.includes('disabled')
      if (disabled) return null

      const href = await el.getAttribute('href')
      if (href) return href

      // Button without href — try to get it from onclick or data attributes
      const dataHref = await el.getAttribute('data-href')
      if (dataHref) return dataHref
    } catch {
      // Continue to next selector
    }
  }
  return null
}

async function hashPageContent(page: Page): Promise<string> {
  const content = await page.evaluate(() => {
    // Hash the inventory item count and first few item titles, not the full DOM
    // This is resilient to minor DOM differences (ads, timestamps, etc.)
    const items = document.querySelectorAll(
      '[class*="inventory-item"], [class*="vehicle-card"], [class*="listing-card"], article',
    )
    const texts = Array.from(items)
      .slice(0, 10)
      .map((el: Element) => el.textContent?.trim().slice(0, 100) ?? '')
    return texts.join('|') + `|count:${items.length}`
  })
  return createHash('md5').update(content).digest('hex')
}
