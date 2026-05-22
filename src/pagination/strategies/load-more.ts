import { Page } from 'playwright'
import { config } from '../../config'
import { logger } from '../../utils/logger'
import { sleep } from '../../utils/retry'

export interface LoadMoreResult {
  strategy: 'load-more'
  urls: string[]
  totalPages: number
  clickCount: number
}

const LOAD_MORE_SELECTORS = [
  'button:has-text("Load More")',
  'button:has-text("Show More")',
  'button:has-text("View More")',
  'button:has-text("See More")',
  'button:has-text("Load more vehicles")',
  'a:has-text("Load More")',
  'a:has-text("Show More")',
  '[class*="load-more"]:not([disabled])',
  '[class*="loadmore"]:not([disabled])',
  '[class*="show-more"]:not([disabled])',
  '[data-action="load-more"]',
]

/**
 * Click "Load More" repeatedly until no more button exists or we reach the page cap.
 * All content ends up on one fully-expanded page for a single screenshot.
 */
export async function handleLoadMore(
  page: Page,
  currentUrl: string,
): Promise<LoadMoreResult | null> {
  const hasButton = await findLoadMoreButton(page)
  if (!hasButton) return null

  logger.debug({ url: currentUrl }, 'load-more strategy detected')

  let clickCount = 0
  // Each "load more" typically adds one virtual page worth of inventory
  const maxClicks = config.limits.maxPagesPerDealer

  while (clickCount < maxClicks) {
    const button = await getLoadMoreButton(page)
    if (!button) break

    const prevCount = await inventoryItemCount(page)

    try {
      await button.scrollIntoViewIfNeeded()
      await sleep(300)
      await button.click()
    } catch {
      break
    }

    // Wait for new items to appear
    const appeared = await waitForNewItems(page, prevCount, 8000)
    clickCount++

    if (!appeared) {
      logger.debug({ url: currentUrl, clickCount }, 'no new items after load-more click, stopping')
      break
    }
  }

  if (clickCount === 0) return null

  logger.debug({ url: currentUrl, clickCount }, 'load-more finished')

  return {
    strategy: 'load-more',
    urls: [currentUrl],
    totalPages: 1,
    clickCount,
  }
}

async function findLoadMoreButton(page: Page): Promise<boolean> {
  for (const selector of LOAD_MORE_SELECTORS) {
    try {
      const el = page.locator(selector).first()
      if (await el.isVisible({ timeout: 800 })) return true
    } catch {
      // Not present
    }
  }
  return false
}

async function getLoadMoreButton(page: Page) {
  for (const selector of LOAD_MORE_SELECTORS) {
    try {
      const el = page.locator(selector).first()
      if (!(await el.isVisible({ timeout: 500 }))) continue
      const disabled =
        (await el.getAttribute('disabled')) !== null ||
        (await el.getAttribute('aria-disabled')) === 'true'
      if (disabled) return null
      return el
    } catch {
      // Continue
    }
  }
  return null
}

async function inventoryItemCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const selectors = [
      '[class*="inventory-item"]',
      '[class*="vehicle-card"]',
      '[class*="listing-card"]',
      'article',
    ]
    for (const sel of selectors) {
      const count = document.querySelectorAll(sel).length
      if (count > 0) return count
    }
    return 0
  })
}

async function waitForNewItems(page: Page, prevCount: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const count = await inventoryItemCount(page)
    if (count > prevCount) return true
    await sleep(300)
  }
  return false
}
