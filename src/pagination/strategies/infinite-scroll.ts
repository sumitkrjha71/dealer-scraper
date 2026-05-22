import { Page } from 'playwright'
import { createHash } from 'crypto'
import { config } from '../../config'
import { logger } from '../../utils/logger'
import { sleep } from '../../utils/retry'

export interface InfiniteScrollResult {
  strategy: 'infinite-scroll'
  // Infinite scroll yields one URL with all content on a single page
  urls: string[]
  totalPages: number
  scrollPasses: number
}

/**
 * Handle infinite-scroll inventory pages.
 * Scrolls incrementally, waits for new content to appear, stops when stable.
 * Returns the single URL — screenshot worker will capture the fully-expanded page.
 */
export async function handleInfiniteScroll(
  page: Page,
  currentUrl: string,
): Promise<InfiniteScrollResult> {
  logger.debug({ url: currentUrl }, 'infinite-scroll strategy: scrolling to load all content')

  let previousHash = await inventoryHash(page)
  let scrollPasses = 0
  const maxPasses = Math.ceil(config.limits.maxPagesPerDealer * 1.5) // Safety cap

  while (scrollPasses < maxPasses) {
    const prevHeight = await page.evaluate(() => document.body.scrollHeight)

    // Scroll to bottom in increments
    await smoothScrollToBottom(page)

    // Wait for network / lazy loaders to trigger
    await Promise.race([
      page.waitForLoadState('networkidle').catch(() => {}),
      sleep(config.timeouts.infiniteScrollWait),
    ])

    const newHeight = await page.evaluate(() => document.body.scrollHeight)
    const newHash = await inventoryHash(page)

    scrollPasses++

    if (newHeight === prevHeight && newHash === previousHash) {
      // No new content after scroll — fully loaded
      logger.debug({ url: currentUrl, scrollPasses }, 'infinite scroll fully loaded')
      break
    }

    previousHash = newHash

    // Back to top between passes to trigger any sticky loaders
    await page.evaluate(() => window.scrollTo(0, 0))
    await sleep(200)
  }

  return {
    strategy: 'infinite-scroll',
    urls: [currentUrl],
    totalPages: 1,
    scrollPasses,
  }
}

/** Check whether the page appears to use infinite scroll (no paginator, but loads on scroll). */
export async function isInfiniteScroll(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    // If a pagination nav exists, it's not infinite scroll
    const hasPaginator =
      document.querySelector('[class*="pagination"]') !== null ||
      document.querySelector('[class*="pager"]') !== null ||
      document.querySelector('a[rel="next"]') !== null

    if (hasPaginator) return false

    // Heuristic: look for IntersectionObserver sentinels common in infinite scroll libs
    const hasSentinel =
      document.querySelector('[class*="sentinel"]') !== null ||
      document.querySelector('[class*="infinite"]') !== null ||
      document.querySelector('[class*="load-more-trigger"]') !== null

    return hasSentinel
  })
}

async function smoothScrollToBottom(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await new Promise<void>((resolve) => {
      const distance = 400
      const delay = 80 // ms between scroll steps

      const timer = setInterval(() => {
        window.scrollBy(0, distance)
        if (window.scrollY + window.innerHeight >= document.body.scrollHeight) {
          clearInterval(timer)
          resolve()
        }
      }, delay)

      // Safety timeout — resolve after 30s regardless
      setTimeout(() => { clearInterval(timer); resolve() }, 30_000)
    })
  })
}

async function inventoryHash(page: Page): Promise<string> {
  const text = await page.evaluate(() => {
    const items = document.querySelectorAll(
      '[class*="inventory"], [class*="vehicle"], [class*="listing"], article',
    )
    return `count:${items.length}|last:${items[items.length - 1]?.textContent?.trim().slice(0, 80) ?? ''}`
  })
  return createHash('md5').update(text).digest('hex')
}
