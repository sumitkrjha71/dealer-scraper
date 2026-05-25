import { BrowserContextOptions } from 'playwright'

// Rotated realistic user agents — keep current; old UAs trigger bot heuristics
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15',
]

// Common screen resolutions to appear human
const VIEWPORTS = [
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
  { width: 1280, height: 800 },
]

export function randomUserAgent(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]
}

export function randomViewport() {
  return VIEWPORTS[Math.floor(Math.random() * VIEWPORTS.length)]
}

export function stealthContextOptions(proxyUrl?: string): BrowserContextOptions {
  const viewport = randomViewport()
  return {
    viewport,
    userAgent: randomUserAgent(),
    locale: 'en-US',
    timezoneId: 'America/New_York',
    geolocation: { longitude: -73.935242, latitude: 40.73061 }, // NY default
    permissions: ['geolocation'],
    extraHTTPHeaders: {
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
    },
    proxy: proxyUrl ? { server: proxyUrl } : undefined,
    // Don't record video/trace by default; enable via env for debugging
  }
}

/** Inject JS that masks headless browser indicators before any page code runs. */
export async function applyStealthScripts(page: import('playwright').Page): Promise<void> {
  await page.addInitScript(() => {
    // Remove webdriver property
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined })

    // Spoof plugins length (headless has 0)
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] })

    // Spoof languages
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] })

    // Override chrome object present in real Chrome
    ;(window as unknown as Record<string, unknown>).chrome = {
      runtime: {},
      loadTimes: () => {},
      csi: () => {},
      app: {},
    }

    // Prevent iframe/window detection of automation
    const originalQuery = window.navigator.permissions.query.bind(window.navigator.permissions)
    window.navigator.permissions.query = (parameters: PermissionDescriptor) =>
      parameters.name === 'notifications'
        ? Promise.resolve({ state: 'denied' } as PermissionStatus)
        : originalQuery(parameters)
  })
}

/** Handle common blocking overlays that prevent scrolling/screenshots. */
export async function dismissOverlays(page: import('playwright').Page): Promise<void> {
  const overlaySelectors = [
    // Cookie consent
    'button[id*="accept"]',
    'button[class*="accept"]',
    'button[class*="cookie"]',
    '[aria-label*="Accept"]',
    // Location modals
    'button[class*="location-close"]',
    'button[class*="close-modal"]',
    '.modal button.close',
    // Generic close buttons
    '[data-dismiss="modal"]',
    '.modal-close',
    '.popup-close',
  ]

  for (const selector of overlaySelectors) {
    try {
      const el = page.locator(selector).first()
      if (await el.isVisible({ timeout: 1000 })) {
        await el.click({ timeout: 2000 })
        await page.waitForTimeout(500)
      }
    } catch {
      // Overlay not present — continue
    }
  }
}
