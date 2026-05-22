import { createHash } from 'crypto'

export function extractDomain(rawUrl: string): string {
  try {
    const u = new URL(rawUrl)
    return u.hostname.replace(/^www\./, '')
  } catch {
    return rawUrl
  }
}

export function normalizeUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl.trim())
    // Strip trailing slash for consistent dedup
    u.pathname = u.pathname.replace(/\/$/, '') || '/'
    return u.toString()
  } catch {
    return rawUrl.trim()
  }
}

export function urlHash(url: string): string {
  return createHash('sha256').update(normalizeUrl(url)).digest('hex').slice(0, 16)
}

/** Build a paginated URL from a base URL and page number, detecting the existing pattern. */
export function buildPageUrl(baseUrl: string, page: number, detectedParam?: string): string {
  const u = new URL(baseUrl)

  if (detectedParam === 'path') {
    // /inventory/page/2 pattern
    u.pathname = u.pathname.replace(/\/page\/\d+/, '') + `/page/${page}`
    return u.toString()
  }

  const param = detectedParam ?? detectPageParam(u) ?? 'page'
  u.searchParams.set(param, String(page))
  return u.toString()
}

/** Detect the pagination query parameter used in a URL. */
export function detectPageParam(u: URL): string | undefined {
  const candidates = ['page', 'p', 'pg', 'pagenum', 'pageNumber', 'currentPage']
  for (const c of candidates) {
    if (u.searchParams.has(c)) return c
  }
  return undefined
}

/** Detect offset-based pagination parameters used in a URL. */
export function detectOffsetParam(u: URL): { param: string; value: number } | undefined {
  const candidates = ['start', 'offset', 'from', 'skip']
  for (const c of candidates) {
    const v = u.searchParams.get(c)
    if (v !== null && !isNaN(Number(v))) return { param: c, value: Number(v) }
  }
  return undefined
}

export function safeDirName(url: string): string {
  return extractDomain(url).replace(/[^a-zA-Z0-9.-]/g, '_').slice(0, 64)
}

export function isValidUrl(raw: string): boolean {
  try {
    const u = new URL(raw)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}
