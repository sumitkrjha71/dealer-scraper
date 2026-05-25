import { Page } from 'playwright'
import { logger } from '../utils/logger'
import { sleep } from '../utils/retry'
import { config } from '../config'
import { detectNumberedPagination, detectOffsetPagination } from './strategies/numbered'
import { detectNextButtonPagination } from './strategies/next-button'
import { handleInfiniteScroll, isInfiniteScroll } from './strategies/infinite-scroll'
import { handleLoadMore } from './strategies/load-more'

export interface PaginationResult {
  strategy: 'numbered' | 'offset' | 'next-button' | 'infinite-scroll' | 'load-more' | 'single'
  urls: string[]
  totalPages: number
}

/**
 * Master pagination detector. Tries strategies in order of confidence:
 * 1. Numbered (DOM paginator with known max page) — most reliable, generates all URLs upfront
 * 2. Offset-based (start=0, start=24...) — reliable when total count is in DOM
 * 3. Next-button (walks pages one by one) — works for most conventional paginations
 * 4. Infinite scroll (scroll and wait) — single-page content loading
 * 5. Load-more button (click-to-expand) — single-page content loading
 * 6. Single page fallback — no pagination found
 */
export async function detectPagination(page: Page, url: string): Promise<PaginationResult> {
  const log = logger.child({ url })

  // Wait for SPA frameworks (React/Vue/Angular) to hydrate and render pagination
  await sleep(3000)

  // ── Strategy 1: Numbered pagination ─────────────────────────────────────────
  try {
    const numbered = await detectNumberedPagination(page, url)
    if (numbered && numbered.totalPages >= 2) {
      log.info({ strategy: 'numbered', totalPages: numbered.totalPages }, 'pagination resolved')
      return { strategy: 'numbered', urls: numbered.urls, totalPages: numbered.totalPages }
    }
  } catch (err) {
    log.debug({ err }, 'numbered pagination check failed')
  }

  // ── Strategy 2: Offset pagination ───────────────────────────────────────────
  try {
    const offset = await detectOffsetPagination(page, url)
    if (offset && offset.totalPages >= 2) {
      log.info({ strategy: 'offset', totalPages: offset.totalPages }, 'pagination resolved')
      return { strategy: 'offset', urls: offset.urls, totalPages: offset.totalPages }
    }
  } catch (err) {
    log.debug({ err }, 'offset pagination check failed')
  }

  // ── Strategy 3: Next-button walking ─────────────────────────────────────────
  try {
    const nextBtn = await detectNextButtonPagination(page, url)
    if (nextBtn && nextBtn.totalPages >= 2) {
      log.info({ strategy: 'next-button', totalPages: nextBtn.totalPages }, 'pagination resolved')
      return { strategy: 'next-button', urls: nextBtn.urls, totalPages: nextBtn.totalPages }
    }
  } catch (err) {
    log.debug({ err }, 'next-button pagination check failed')
  }

  // ── Strategy 4: Infinite scroll ─────────────────────────────────────────────
  try {
    const scrollDetected = await isInfiniteScroll(page)
    if (scrollDetected) {
      const scrollResult = await handleInfiniteScroll(page, url)
      log.info({ strategy: 'infinite-scroll', scrollPasses: scrollResult.scrollPasses }, 'pagination resolved')
      return { strategy: 'infinite-scroll', urls: [url], totalPages: 1 }
    }
  } catch (err) {
    log.debug({ err }, 'infinite-scroll check failed')
  }

  // ── Strategy 5: Load-more button ────────────────────────────────────────────
  try {
    const loadMore = await handleLoadMore(page, url)
    if (loadMore) {
      log.info({ strategy: 'load-more', clickCount: loadMore.clickCount }, 'pagination resolved')
      return { strategy: 'load-more', urls: [url], totalPages: 1 }
    }
  } catch (err) {
    log.debug({ err }, 'load-more check failed')
  }

  // ── Fallback A: total-count URL generator ───────────────────────────────────
  // If the page shows "X vehicles / listings / results", generate page URLs using
  // the most common dealer page param even though no pagination DOM was found.
  try {
    const totalCount = await page.evaluate(() => {
      const body = (document.body as HTMLElement).innerText ?? ''
      const patterns = [
        /(\d[\d,]*)\s+(?:new\s+|used\s+|certified\s+)?(?:vehicles?|listings?|results?|cars?|trucks?|suvs?|inventory)/i,
        /showing\s+\d+[–\-]\d+\s+of\s+(\d[\d,]*)/i,
        /(\d[\d,]*)\s+(?:total\s+)?(?:matches?|found)/i,
      ]
      for (const re of patterns) {
        const m = body.match(re)
        if (m) return parseInt(m[1].replace(/,/g, ''), 10)
      }
      return null
    })

    if (totalCount && totalCount > 1) {
      // Detect page size from the number of inventory items visible on this page
      const visibleItems = await page.evaluate(() => {
        const selectors = [
          '[class*="inventory-item"]', '[class*="vehicle-card"]',
          '[class*="listing-card"]',  '[class*="vehicle-tile"]',
          '[class*="srp-item"]',      '[class*="result-item"]',
          'article',
        ]
        for (const sel of selectors) {
          const count = document.querySelectorAll(sel).length
          if (count >= 3) return count
        }
        return 0
      })

      const pageSize = visibleItems >= 3 ? visibleItems : 24
      const totalPages = Math.min(Math.ceil(totalCount / pageSize), config.limits.maxPagesPerDealer)

      if (totalPages >= 2) {
        const { buildPageUrl } = await import('../utils/url')
        const urls: string[] = []
        for (let p = 1; p <= totalPages; p++) {
          urls.push(buildPageUrl(url, p, 'page'))
        }
        log.info({ strategy: 'total-count', totalPages, totalCount, pageSize }, 'pagination resolved via total count')
        return { strategy: 'numbered', urls, totalPages }
      }
    }
  } catch (err) {
    log.debug({ err }, 'total-count fallback check failed')
  }

  // ── Fallback B: single page ──────────────────────────────────────────────────
  log.info({ strategy: 'single' }, 'no pagination detected, treating as single page')
  return { strategy: 'single', urls: [url], totalPages: 1 }
}

/** Enforce the per-dealer page cap before returning paginated URLs. */
export function enforcePageCap(result: PaginationResult): PaginationResult {
  const cap = config.limits.maxPagesPerDealer
  if (result.urls.length <= cap) return result

  logger.warn(
    { detected: result.urls.length, cap, strategy: result.strategy },
    'dealer page count exceeds cap, truncating',
  )

  return {
    ...result,
    urls: result.urls.slice(0, cap),
    totalPages: cap,
  }
}
