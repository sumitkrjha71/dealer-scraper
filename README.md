# Dealer Inventory Scraper — Production Screenshot Pipeline

A production-grade, horizontally scalable pipeline that accepts batches of automotive dealer inventory URLs, automatically discovers all paginated inventory pages, captures full-page screenshots of every page, and stores them with structured metadata.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Folder Structure](#folder-structure)
3. [Technology Stack & Decisions](#technology-stack--decisions)
4. [Database Schema](#database-schema)
5. [Queue Design](#queue-design)
6. [Concurrency Strategy](#concurrency-strategy)
7. [Pagination Detection](#pagination-detection)
8. [Screenshot Pipeline](#screenshot-pipeline)
9. [Anti-Bot & Edge Case Handling](#anti-bot--edge-case-handling)
10. [Quick Start (Local Dev)](#quick-start-local-dev)
11. [API Reference](#api-reference)
12. [Deployment Strategy](#deployment-strategy)
13. [Scaling from 1K → 100K URLs/day](#scaling-from-1k--100k-urlsday)
14. [Cost Optimization](#cost-optimization)
15. [Monitoring & Logging](#monitoring--logging)
16. [Retry & Fault Tolerance](#retry--fault-tolerance)

---

## Architecture Overview

```
                        ┌─────────────────────────────────────────────┐
  CSV / JSON / URLs ───▶│          REST API  (Fastify)                 │
                        │  POST /api/v1/batches                        │
                        └────────────────┬────────────────────────────┘
                                         │ submitBatch()
                                         ▼
                        ┌─────────────────────────────────────────────┐
                        │   PostgreSQL                                 │
                        │   batches / dealer_jobs / page_jobs /        │
                        │   screenshots                                │
                        └────────────────┬────────────────────────────┘
                                         │
                    ┌────────────────────▼────────────────────────┐
                    │   Redis  (BullMQ)                            │
                    │                                              │
                    │  ┌──────────────────┐  ┌─────────────────┐  │
                    │  │ dealer-discovery │  │screenshot-capture│  │
                    │  │     queue        │  │     queue        │  │
                    │  └────────┬─────────┘  └────────┬────────┘  │
                    └───────────┼──────────────────────┼───────────┘
                                │                      │
               ┌────────────────▼──────┐   ┌───────────▼───────────────┐
               │   Dealer Workers (N)  │   │  Screenshot Workers (M)    │
               │                       │   │                            │
               │  1. Navigate URL      │   │  1. Navigate page URL      │
               │  2. Detect pagination │──▶│  2. Scroll for lazy load   │
               │  3. Enqueue N pages   │   │  3. Full-page screenshot   │
               │                       │   │  4. Compress (Sharp)       │
               └───────────────────────┘   │  5. Upload to S3/local     │
                                           └────────────────────────────┘
                                                        │
                                           ┌────────────▼────────────────┐
                                           │   Storage (S3 / Local FS)   │
                                           │  {batchId}/{domain}/        │
                                           │    page_1.jpg               │
                                           │    page_2.jpg ...           │
                                           └─────────────────────────────┘
```

### Key architectural decisions

| Decision | Chosen | Alternative | Why |
|----------|--------|-------------|-----|
| Browser engine | **Playwright** | Puppeteer | Better stealth support, cross-browser, superior network interception |
| Queue backend | **BullMQ + Redis** | SQS, RabbitMQ | Native retry scheduling, job visibility, rate limiting in-process |
| Two-tier queues | **Dealer + Screenshot** | Single queue | Independent concurrency tuning; discovery is light, screenshots are heavy |
| Database | **PostgreSQL** | MongoDB | ACID job state, rich JSON aggregation for results, easy resumability |
| Storage | **S3 / Local** | GCS, Azure Blob | Universal support; S3-compatible API works with MinIO, R2, Backblaze |
| Autoscaling | **KEDA (queue-depth)** | CPU HPA | Scales directly to queue backlog, not CPU — much more responsive |
| Image format | **JPEG 85%** | PNG | ~70% smaller files; sufficient quality for visual analysis |

---

## Folder Structure

```
Website Scraper/
├── src/
│   ├── config/
│   │   └── index.ts              # Validated env config (envalid)
│   ├── utils/
│   │   ├── logger.ts             # Pino structured logger
│   │   ├── retry.ts              # Error classification + exponential backoff
│   │   └── url.ts                # URL normalization, pagination param detection
│   ├── db/
│   │   ├── client.ts             # pg Pool, query helpers, transactions
│   │   ├── models.ts             # TypeScript types for all DB tables
│   │   └── migrations/
│   │       └── 001_init.sql      # Full schema (batches, jobs, screenshots)
│   ├── queue/
│   │   ├── queues.ts             # BullMQ Queue definitions
│   │   └── producer.ts           # Batch submission, job enqueueing
│   ├── browser/
│   │   ├── pool.ts               # Browser pool (borrow/release, recycling)
│   │   └── stealth.ts            # Anti-detection setup, overlay dismissal
│   ├── pagination/
│   │   ├── detector.ts           # Master strategy selector
│   │   └── strategies/
│   │       ├── numbered.ts       # Numbered paginators + offset-based
│   │       ├── next-button.ts    # Next-link walking + content dedup
│   │       ├── infinite-scroll.ts # Scroll-to-load detection
│   │       └── load-more.ts      # Click-to-expand button handling
│   ├── screenshot/
│   │   └── capture.ts            # Full-page capture with lazy-load triggering
│   ├── storage/
│   │   ├── index.ts              # Provider router (local vs S3)
│   │   ├── local.ts              # Local filesystem storage
│   │   └── s3.ts                 # AWS S3 / MinIO / R2 upload
│   ├── workers/
│   │   ├── dealer.worker.ts      # Dealer discovery worker
│   │   ├── screenshot.worker.ts  # Screenshot capture worker
│   │   └── worker-manager.ts     # Lifecycle + graceful shutdown
│   ├── api/
│   │   ├── server.ts             # Fastify server setup
│   │   └── routes/
│   │       ├── jobs.ts           # Batch CRUD + results
│   │       └── health.ts         # /healthz, /readyz, queue metrics
│   └── index.ts                  # Combined entry point (dev)
├── scripts/
│   ├── submit-batch.ts           # CLI batch submission
│   └── migrate.ts                # Run DB migrations
├── k8s/
│   ├── deployment.yml            # API + Worker deployments, Service, Secrets
│   └── hpa.yml                   # KEDA queue-depth autoscaler
├── docker-compose.yml            # Local dev stack (Postgres + Redis + services)
├── Dockerfile
├── .env.example
├── package.json
└── tsconfig.json
```

---

## Technology Stack & Decisions

### Core

| Package | Purpose |
|---------|---------|
| `playwright` + `playwright-extra` | Headless Chromium automation with plugin support |
| `puppeteer-extra-plugin-stealth` | Masks headless fingerprints (webdriver, plugins, chrome object) |
| `bullmq` | Redis-backed job queue with retry, priority, rate-limit support |
| `ioredis` | Redis client (BullMQ requirement) |
| `pg` | PostgreSQL driver |
| `fastify` | Low-overhead HTTP server for the submission API |
| `sharp` | High-speed image compression (JPEG conversion after PNG capture) |
| `pino` | Structured JSON logging — fast and ECS-compatible |

### Why Playwright over Puppeteer

- **Stealth**: `playwright-extra` + stealth plugin patches navigator.webdriver, plugins, languages
- **Network control**: `context.route()` allows blocking fonts/media to speed up page loads
- **Context isolation**: Each page gets its own BrowserContext — cookies, localStorage don't bleed
- **Auto-wait**: Playwright's locators auto-retry visibility checks, reducing flakiness

### Why BullMQ over SQS/Celery

- Redis is already required for rate limiting — no new dependency
- BullMQ provides job progress, delayed retry with backoff, priority queues, job deduplication
- At 100k+/day scale, swap to SQS + Lambda consumers for infinite elastic throughput (documented in Scaling section)

---

## Database Schema

```sql
batches        — one per submitted batch of URLs
dealer_jobs    — one per dealer URL (discovery phase)
page_jobs      — one per inventory page (screenshot phase)
screenshots    — completed screenshots with storage paths
```

Status flow:
```
dealer_jobs:   pending → processing → completed
                                    ↘ failed (retried via BullMQ)

page_jobs:     pending → processing → completed
                                    ↘ failed
```

Results are queryable via `GET /api/v1/batches/:batchId/results` which joins all tables and returns paginated dealer results with screenshot arrays.

---

## Queue Design

```
dealer-discovery queue
  ├── 1 job per dealer URL
  ├── concurrency = DEALER_WORKER_CONCURRENCY (default 10)
  ├── attempts = MAX_RETRIES (default 3)
  └── backoff = exponential starting at RETRY_DELAY_MS

screenshot-capture queue
  ├── 1 job per inventory page
  ├── concurrency = SCREENSHOT_WORKER_CONCURRENCY (default 20)
  ├── attempts = MAX_RETRIES
  └── backoff = exponential
```

The two-queue design means:
- **Discovery is fast** (just loads one page, detects pagination) — high concurrency
- **Screenshots are slow** (full page load + scroll + capture) — bounded by browser pool
- You can scale screenshot workers independently without affecting discovery workers

---

## Concurrency Strategy

```
Browser Pool (MAX_BROWSERS × MAX_PAGES_PER_BROWSER total page slots)
    │
    ├── Browser 0 ──── Page, Page, Page, Page, Page   (5 concurrent contexts)
    ├── Browser 1 ──── Page, Page, Page, Page, Page
    └── Browser 2 ──── Page, Page, Page, Page, Page
                                    ↑
                              Semaphore (15 total)
                              Worker concurrency must not exceed this

Browser recycling: after BROWSER_RECYCLE_AFTER (50) page uses,
the browser is closed and a fresh one is spawned to prevent memory leaks.
```

Per-domain rate limiting via `bottleneck` (configurable, default 10 req/min/domain) prevents aggressive scraping patterns that trigger bot detection.

---

## Pagination Detection

The detector tries 5 strategies in order, stopping at the first that succeeds:

```
1. Numbered pagination
   ├── Scans DOM for [class*="pagination"] containers
   ├── Extracts max page number from links
   ├── Detects URL pattern (?page=N, /page/N, ?p=N)
   └── Generates all page URLs upfront → most efficient

2. Offset-based pagination  
   ├── Detects ?start=0, ?offset=0, ?from=0 in URL
   ├── Reads total inventory count from "X vehicles" text
   └── Generates URLs: start=0, start=24, start=48...

3. Next-button walking
   ├── Finds "Next" anchor/button (15+ selector patterns)
   ├── Navigates page by page, collecting URLs
   └── Content-hashes each page to detect loops/duplicates

4. Infinite scroll
   ├── Detects IntersectionObserver sentinels in DOM
   ├── Scrolls to bottom incrementally
   └── Stops when page height stabilizes

5. Load-more button
   ├── Finds "Load More / Show More / View More" buttons
   ├── Clicks until button disappears or no new items appear
   └── Single-page result (all content loaded)

Fallback: single-page (screenshot the one URL)
```

The `MAX_PAGES_PER_DEALER` cap (default 50) prevents runaway crawls on sites with broken pagination.

---

## Screenshot Pipeline

```
1. page.goto(url, { waitUntil: 'domcontentloaded' })
2. dismissOverlays() — cookie banners, modals, location popups
3. triggerLazyLoading() — incremental scroll at 70% viewport steps
   └── 120ms pause per step for IntersectionObserver callbacks
4. waitForNetworkIdle() — race with 10s timeout (prevents hang on WS/polling)
5. waitForImages() — await all <img>.complete
6. scrollTo(0,0) — reset scroll position before screenshot
7. page.screenshot({ fullPage: true, type: 'png' })
8. sharp().jpeg({ quality: 85, progressive: true }) — ~70% size reduction
9. saveScreenshot() → S3 or local FS
```

**Why scroll before screenshot?**
Most automotive inventory sites use lazy loading (`loading="lazy"` or IntersectionObserver). Without scrolling, half the vehicle cards render as blank placeholders in the screenshot.

**Why JPEG over PNG?**
A typical inventory page screenshot is 6–15 MB as PNG. At JPEG 85%, it's 1–3 MB with no visible quality loss for vehicle card imagery. At 1,000 pages per batch this is the difference between 10 GB and 1.5 GB of storage.

---

## Anti-Bot & Edge Case Handling

| Threat | Mitigation |
|--------|-----------|
| Webdriver detection | `playwright-extra-plugin-stealth` patches navigator.webdriver, plugins, chrome object |
| User agent fingerprinting | Random rotation across 5 realistic Chrome/Firefox/Safari UAs |
| Viewport fingerprinting | Random viewport from 4 common desktop resolutions |
| Cloudflare / bot pages | Residential proxy (set `PROXY_URL`); stealth plugin handles JS challenges |
| Cookie consent banners | `dismissOverlays()` tries 10+ selector patterns |
| Location modals | Same overlay dismissal |
| Mobile redirects | Desktop viewport + UA prevents mobile redirect |
| Lazy loading | Full scroll-through before screenshot |
| Infinite scroll | Dedicated strategy with content hash dedup |
| Broken pagination | `MAX_PAGES_PER_DEALER` cap + content dedup prevents infinite loops |
| Page crashes | `context.close()` in finally block always runs; pool health check replaces dead browsers |
| Slow pages | Per-stage timeouts; network idle races with a hard cap |

---

## Quick Start (Local Dev)

```bash
# 1. Clone and install
cd "Website Scraper"
npm install
npm run install:browsers   # installs Playwright Chromium

# 2. Start infrastructure
docker-compose up postgres redis -d

# 3. Run migrations
npm run migrate

# 4. Copy and fill env
cp .env.example .env

# 5. Start everything (API + workers in one process)
npm run dev

# 6. Submit a test batch
npm run submit -- --json '["https://www.example-dealer.com/used-cars"]'

# Or from a file:
npm run submit -- --file my-dealers.txt

# 7. Check results
curl http://localhost:3001/api/v1/batches/<batchId>/results
```

---

## API Reference

### Submit a batch

```http
POST /api/v1/batches
Content-Type: application/json

{
  "urls": [
    "https://dealer1.com/used-cars",
    "https://dealer2.com/preowned-inventory"
  ],
  "submittedBy": "optional-label"
}

# Or submit CSV:
{
  "csv": "https://dealer1.com/used-cars\nhttps://dealer2.com/used"
}
```

Response `202 Accepted`:
```json
{
  "batchId": "uuid",
  "accepted": 2,
  "rejected": []
}
```

### Get batch status

```http
GET /api/v1/batches/:batchId
```

### Get full results

```http
GET /api/v1/batches/:batchId/results?page=1&limit=50
```

Response:
```json
{
  "batch_id": "...",
  "dealers": [
    {
      "dealer_url": "https://dealer1.com/used-cars",
      "dealer_domain": "dealer1.com",
      "pages_detected": 14,
      "status": "completed",
      "screenshots": [
        {
          "page_number": 1,
          "page_url": "https://dealer1.com/used-cars?page=1",
          "storage_path": "batch-id/dealer1.com/page_1.jpg",
          "storage_url": "https://bucket.s3.amazonaws.com/...",
          "captured_at": "2025-01-15T10:23:45Z"
        }
      ]
    }
  ]
}
```

### Retry failed jobs

```http
POST /api/v1/batches/:batchId/retry-failed
```

### Health & Metrics

```http
GET /healthz        → { status: "ok" }
GET /readyz         → 200 if DB + Redis reachable, 503 otherwise
GET /metrics/queues → BullMQ job counts per queue
```

---

## Deployment Strategy

### Option A — Vercel (Frontend) + Railway (Backend) ← Recommended for hosted production

This is the recommended setup for public-facing use. The dashboard lives on Vercel's global CDN; the backend (API + workers + Postgres + Redis) runs on Railway.

#### Step 1 — Push code to GitHub

```bash
cd "Website Scraper"
git init
git add .
git commit -m "feat: initial dealer scraper"
# Create a repo on GitHub (e.g. dealer-scraper), then:
git remote add origin https://github.com/YOUR_USERNAME/dealer-scraper.git
git push -u origin main
```

#### Step 2 — Deploy backend to Railway

1. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub repo
2. Select your repo — Railway auto-detects `railway.toml` and uses the `Dockerfile`
3. Add **Postgres** plugin: `+ New` → `Database` → `PostgreSQL`
4. Add **Redis** plugin: `+ New` → `Database` → `Redis`
5. Add a **Volume**: `+ New` → `Volume` → mount path `/data/screenshots` → min 20GB (handles 5,000+ screenshots)
6. Set environment variables in the Railway service settings:

```
NODE_ENV=production
PORT=3001
DATABASE_URL=<auto-filled by Railway Postgres plugin>
REDIS_URL=<auto-filled by Railway Redis plugin>
STORAGE_PROVIDER=local
SCREENSHOTS_DIR=/data/screenshots
DASHBOARD_URL=https://your-dashboard.vercel.app
```

7. After deploy, run the DB migration once:
   - Railway → your service → Shell tab → `node dist/db/migrate.js`
   - Or: open the Postgres plugin → Query tab → paste contents of `src/db/migrations/001_init.sql`

8. Copy your Railway backend URL (e.g. `https://dealer-scraper-production.up.railway.app`)

#### Step 3 — Deploy dashboard to Vercel

1. Go to [vercel.com](https://vercel.com) → New Project → Import your GitHub repo
2. Set **Root Directory** to `dashboard`
3. Framework: Next.js (auto-detected)
4. Add environment variable:
   ```
   NEXT_PUBLIC_API_URL=https://your-backend.up.railway.app
   ```
5. Deploy — Vercel gives you a URL like `https://dealer-scraper.vercel.app`
6. Back in Railway, update `DASHBOARD_URL=https://dealer-scraper.vercel.app` so CORS allows it

#### For 5,000+ screenshots storage

| Option | Cost | Setup |
|--------|------|-------|
| Railway Volume (local FS) | ~$0.25/GB/mo | Already configured — works out of the box |
| **Cloudflare R2** (recommended for scale) | Free up to 10GB, then $0.015/GB | Set `STORAGE_PROVIDER=s3`, fill `AWS_*` vars with R2 credentials |
| AWS S3 | $0.023/GB/mo | Set `STORAGE_PROVIDER=s3`, fill `AWS_*` vars |
| Backblaze B2 | $0.006/GB/mo | S3-compatible, cheapest paid option |

**Cloudflare R2 setup (10GB free = ~5,000 screenshots at 2MB avg):**
1. Cloudflare dashboard → R2 → Create bucket `dealer-screenshots`
2. R2 → Manage API tokens → Create token with `Object Read & Write`
3. Copy Account ID, Access Key ID, Secret Access Key
4. Set in Railway:
   ```
   STORAGE_PROVIDER=s3
   AWS_BUCKET=dealer-screenshots
   AWS_REGION=auto
   AWS_ACCESS_KEY_ID=<R2 access key>
   AWS_SECRET_ACCESS_KEY=<R2 secret>
   S3_ENDPOINT=https://<ACCOUNT_ID>.r2.cloudflarestorage.com
   ```

---

### Option B — Local / Small scale (< 5k URLs/day)

```bash
docker-compose up --scale workers=2
```

### Option C — Medium scale (5k–50k URLs/day)

Deploy to a single VM or ECS cluster:
- API: 2 replicas, 0.5 CPU, 512MB RAM
- Workers: 3–5 replicas, 2 CPU, 4GB RAM each
- Postgres: RDS db.t3.medium
- Redis: ElastiCache cache.t3.small

### Option D — Production scale (50k–500k URLs/day)

Kubernetes + KEDA autoscaling:
```bash
kubectl apply -f k8s/deployment.yml
kubectl apply -f k8s/hpa.yml
```
Workers scale from 1 to 20 pods based on screenshot queue depth.
Each 3-browser worker pod handles ~15 concurrent screenshots.
20 pods × 15 = 300 concurrent screenshots → ~1,080 screenshots/hour/pod-set.

---

## Scaling from 1K → 100K URLs/day

| Scale | Workers | Browsers/Worker | Screenshots/hr | Storage/day |
|-------|---------|-----------------|---------------|-------------|
| Dev (1K/batch) | 1 | 3 | ~180 | ~5 GB |
| 10K/day | 3 | 3 | ~540 | ~50 GB |
| 100K/day | 20 | 3 | ~3,600 | ~500 GB |

**At 100K URLs/day, recommended changes:**

1. **Switch to SQS + ECS Fargate workers** — SQS provides infinite elastic queue depth; Fargate auto-provisions containers without cluster management
2. **External screenshot service** (e.g., Browserless.io, Browserbase) — offloads Chromium management entirely; pay-per-screenshot; handles Cloudflare bypass natively
3. **Read replicas for PostgreSQL** — separate write (job state) from read (results API)
4. **S3 Intelligent Tiering** — auto-moves old screenshots to cheaper storage classes
5. **Redis Cluster** — shard queues across nodes for higher throughput

---

## Cost Optimization

| Lever | Saving |
|-------|--------|
| JPEG 85% vs PNG | ~70% storage cost reduction |
| S3 Intelligent Tiering | ~40% for screenshots > 30 days old |
| Spot/preemptible instances for workers | 70% compute cost reduction (workers are stateless, safe to preempt) |
| Resource blocking (fonts, media) | ~30% faster page loads → more screenshots per hour |
| Browser pool recycling | Prevents memory accumulation → avoids OOM restarts |
| Batch deduplication | Prevents re-processing duplicate URLs in the same batch |

---

## Monitoring & Logging

### Structured logs (Pino → CloudWatch / Datadog / ELK)

All logs are JSON with consistent fields:
```json
{
  "level": "info",
  "service": "dealer-scraper",
  "dealerJobId": "uuid",
  "batchId": "uuid",
  "dealerUrl": "https://...",
  "strategy": "numbered",
  "totalPages": 14
}
```

### Key metrics to alert on

| Metric | Query | Alert threshold |
|--------|-------|----------------|
| Screenshot failure rate | `failed / total` per batch | > 10% |
| Queue depth (screenshot) | `BullMQ waiting count` | > 500 |
| Bot block rate | `error_class = 'bot_blocked'` | > 5% of jobs |
| Worker stalled jobs | BullMQ stalled count | > 0 |
| P95 screenshot latency | `completed_at - started_at` | > 120s |

### Queue depth endpoint for Prometheus

```
GET /metrics/queues
→ exposes BullMQ counts for all queues
Scrape with prometheus-community/json-exporter
```

---

## Retry & Fault Tolerance

### Error classification

| Class | Retryable | Strategy |
|-------|-----------|---------|
| `timeout` | Yes | Exponential backoff |
| `network_error` | Yes | Exponential backoff |
| `bot_blocked` | No (raw) | Requires proxy rotation; re-submit manually |
| `not_found` | No | Mark failed, skip |
| `parse_error` | No | Log for investigation |

### BullMQ retry config

```
attempts: 3
backoff: exponential, starting at 2000ms
→ retry at 2s, 4s, 8s
```

### Resumable batches

Jobs are persisted in PostgreSQL before being enqueued. If Redis is lost, re-submit the batch — the `submitBatch` function deduplicates by URL within a batch. In-progress jobs can be re-queued via the retry-failed API endpoint.

### Browser crash recovery

If a browser disconnects mid-job, the `release()` callback catches the context-close error, marks the slot unhealthy, and spawns a replacement. The BullMQ job times out and retries on the next worker.

---

## Configuration Reference

See [.env.example](.env.example) for all available environment variables with descriptions.

Key variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `MAX_BROWSERS` | 3 | Playwright browser instances per worker process |
| `SCREENSHOT_WORKER_CONCURRENCY` | 20 | Concurrent screenshot jobs (must ≤ MAX_BROWSERS × MAX_PAGES_PER_BROWSER) |
| `MAX_PAGES_PER_DEALER` | 50 | Safety cap on pages per dealer |
| `STORAGE_PROVIDER` | `local` | `local` or `s3` |
| `PROXY_URL` | — | Residential proxy for Cloudflare-protected sites |
| `REQUESTS_PER_DOMAIN_PER_MINUTE` | 10 | Per-domain rate limit |
