import { Page } from 'playwright'
import { buildPageUrl, detectPageParam, detectOffsetParam } from '../../utils/url'
import { logger } from '../../utils/logger'

export interface NumberedPaginationResult {
  strategy: 'numbered'
  urls: string[]
  totalPages: number
}

/**
 * Detect numbered pagination by scanning the DOM for page number links or
 * "Page X of Y" text, then deriving all page URLs from the pattern.
 */
export async function detectNumberedPagination(
  page: Page,
  baseUrl: string,
): Promise<NumberedPaginationResult | null> {
  const result = await page.evaluate(() => {
    // Common pagination container selectors across dealer platforms
    const paginationSelectors = [
      '[class*="pagination"]',
      '[class*="pager"]',
      '[class*="page-nav"]',
      '[class*="pageNav"]',
      '[aria-label*="pagination"]',
      '[role="navigation"][aria-label*="page"]',
      '.pages',
      '#pagination',
    ]

    let container: Element | null = null
    for (const sel of paginationSelectors) {
      container = document.querySelector(sel)
      if (container) break
    }

    if (!container) return null

    // Collect all numeric page links
    const pageNumbers: number[] = []
    const anchors = container.querySelectorAll('a[href], button')
    anchors.forEach((el: Element) => {
      const text = el.textContent?.trim() ?? ''
      const num = parseInt(text, 10)
      if (!isNaN(num) && num > 0 && num <= 10000) {
        pageNumbers.push(num)
      }
    })

    if (pageNumbers.length === 0) {
      // Try "Page X of Y" pattern in body text
      const bodyText = (document.body as HTMLElement).innerText
      const match = bodyText.match(/page\s+\d+\s+of\s+(\d+)/i)
      if (match) {
        return { maxPage: parseInt(match[1], 10), hrefs: [] }
      }
      return null
    }

    const maxPage = Math.max(...pageNumbers)

    // Also capture the href of the highest-numbered link to extract URL pattern
    const hrefs: string[] = []
    anchors.forEach((el: Element) => {
      const text = el.textContent?.trim() ?? ''
      if (!isNaN(parseInt(text, 10)) && el.tagName === 'A') {
        hrefs.push((el as HTMLAnchorElement).href)
      }
    })

    return { maxPage, hrefs }
  })

  if (!result || result.maxPage < 2) return null

  logger.debug({ baseUrl, maxPage: result.maxPage }, 'numbered pagination detected')

  const u = new URL(baseUrl)
  let pageParam: string | undefined
  let usePathPattern = false

  // Try to detect pattern from collected hrefs
  for (const href of result.hrefs || []) {
    try {
      const hu = new URL(href)
      // Check path pattern: /page/N
      if (/\/page\/\d+/.test(hu.pathname)) {
        usePathPattern = true
        break
      }
      // Check query param
      const param = detectPageParam(hu)
      if (param) {
        pageParam = param
        break
      }
    } catch {
      // Ignore malformed hrefs
    }
  }

  // Fall back to detecting from the base URL itself or common defaults
  if (!pageParam && !usePathPattern) {
    pageParam = detectPageParam(u) ?? 'page'
  }

  const urls: string[] = []
  for (let p = 1; p <= result.maxPage; p++) {
    urls.push(buildPageUrl(baseUrl, p, usePathPattern ? 'path' : pageParam))
  }

  return { strategy: 'numbered', urls, totalPages: result.maxPage }
}

/** Detect offset-based pagination (start=0, start=24, start=48...) */
export async function detectOffsetPagination(
  page: Page,
  baseUrl: string,
  pageSize = 24,
): Promise<NumberedPaginationResult | null> {
  const u = new URL(baseUrl)
  const offsetInfo = detectOffsetParam(u)
  if (!offsetInfo) return null

  // Read total count from common DOM patterns
  const totalCount = await page.evaluate(() => {
    const patterns = [
      /(\d[\d,]*)\s+(?:vehicles?|listings?|results?|cars?)/i,
      /showing\s+\d+[–-]\d+\s+of\s+(\d[\d,]*)/i,
    ]
    const text = document.body.innerText
    for (const re of patterns) {
      const m = text.match(re)
      if (m) return parseInt(m[1].replace(/,/g, ''), 10)
    }
    return null
  })

  if (!totalCount) return null

  const totalPages = Math.ceil(totalCount / pageSize)
  logger.debug({ baseUrl, totalCount, totalPages, pageSize }, 'offset pagination detected')

  const urls: string[] = []
  for (let p = 0; p < totalPages; p++) {
    const pu = new URL(baseUrl)
    pu.searchParams.set(offsetInfo.param, String(p * pageSize))
    urls.push(pu.toString())
  }

  return { strategy: 'numbered', urls, totalPages }
}
