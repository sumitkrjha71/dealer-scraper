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
 * Falls back to scanning ALL links on the page for page-number URL patterns.
 */
export async function detectNumberedPagination(
  page: Page,
  baseUrl: string,
): Promise<NumberedPaginationResult | null> {
  const result = await page.evaluate(() => {
    const containerSelectors = [
      // Class name fragments — covers most dealer platforms
      '[class*="pagination"]', '[class*="Pagination"]',
      '[class*="pager"]',     '[class*="Pager"]',
      '[class*="page-nav"]',  '[class*="pageNav"]',  '[class*="PageNav"]',
      '[class*="paginator"]', '[class*="Paginator"]',
      // ARIA / role
      '[aria-label*="pagination" i]',
      '[role="navigation"][aria-label*="page" i]',
      // IDs
      '#pagination', '#pager', '#page-nav',
      // Common class names used by dealer CMS platforms
      '.pages', '.paginator', '.page-numbers', '.wp-pagenavi',
      '.pagination-wrapper', '.inventory-pagination', '.search-pagination',
      '.srp-pagination', '.results-pagination',
      // Data attributes used by React/Angular dealer sites
      '[data-component*="pagination" i]', '[data-testid*="pagination" i]',
      '[data-cy*="pagination" i]',
      // List-based paginators
      'ul.pagination', 'nav.pagination', 'ol.pagination',
    ]

    const pageNumbers: number[] = []
    const hrefs: string[] = []

    // ── Strategy A: look inside a pagination container ───────────────────────
    let container: Element | null = null
    for (const sel of containerSelectors) {
      try { container = document.querySelector(sel) } catch { /* invalid selector */ }
      if (container) break
    }

    if (container) {
      container.querySelectorAll('a[href], button, [data-page]').forEach((el: Element) => {
        const text = (el.textContent ?? '').trim()
        const num = parseInt(text, 10)
        if (!isNaN(num) && num > 0 && num <= 10000) pageNumbers.push(num)

        // aria-label="Page 4" pattern
        const aria = el.getAttribute('aria-label') ?? ''
        const ariaMatch = aria.match(/^(?:page\s+|go to page\s+)(\d+)$/i)
        if (ariaMatch) pageNumbers.push(parseInt(ariaMatch[1], 10))

        // data-page="4"
        const dp = el.getAttribute('data-page') ?? ''
        if (dp && !isNaN(parseInt(dp, 10))) pageNumbers.push(parseInt(dp, 10))

        if (el.tagName === 'A') hrefs.push((el as HTMLAnchorElement).href)
      })
    }

    // ── Strategy B: scan ALL links for page-param URL patterns ───────────────
    if (pageNumbers.length === 0) {
      const pageParamRe = /[?&](page|p|pg|pagenum|pagenumber|pageNumber|currentPage|PageNumber|pno|pn)=(\d+)/i
      const pathPageRe = /\/page\/(\d+)/i

      document.querySelectorAll('a[href]').forEach((el: Element) => {
        const href = (el as HTMLAnchorElement).href ?? ''
        const paramMatch = href.match(pageParamRe)
        if (paramMatch) {
          const n = parseInt(paramMatch[2], 10)
          if (n > 0 && n <= 10000) { pageNumbers.push(n); hrefs.push(href) }
        }
        const pathMatch = href.match(pathPageRe)
        if (pathMatch) {
          const n = parseInt(pathMatch[1], 10)
          if (n > 0 && n <= 10000) { pageNumbers.push(n); hrefs.push(href) }
        }
      })
    }

    // ── Strategy C: text patterns in visible body ────────────────────────────
    if (pageNumbers.length === 0) {
      const body = (document.body as HTMLElement).innerText ?? ''
      const patterns = [
        /page\s+\d+\s+of\s+(\d+)/i,
        /(\d+)\s+pages/i,
        /of\s+(\d+)\s+pages?/i,
      ]
      for (const re of patterns) {
        const m = body.match(re)
        if (m) return { maxPage: parseInt(m[1], 10), hrefs: [] }
      }
      return null
    }

    const maxPage = Math.max(...pageNumbers)
    return { maxPage, hrefs: [...new Set(hrefs)] }
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
