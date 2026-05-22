-- Dealer Scraper Schema
-- All timestamps are UTC. Status enums use text check constraints for easy extension.

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ─── Batches ────────────────────────────────────────────────────────────────────
-- One row per submitted batch of dealer URLs
CREATE TABLE IF NOT EXISTS batches (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  submitted_by  TEXT,
  total_urls    INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at  TIMESTAMPTZ,
  status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'processing', 'completed', 'failed'))
);

-- ─── Dealer Jobs ────────────────────────────────────────────────────────────────
-- One row per dealer URL submitted. Represents the discovery phase (find all pages).
CREATE TABLE IF NOT EXISTS dealer_jobs (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  batch_id        UUID NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  dealer_url      TEXT NOT NULL,
  dealer_domain   TEXT NOT NULL,
  pages_detected  INTEGER,
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'skipped')),
  error_class     TEXT,
  error_message   TEXT,
  attempts        INTEGER NOT NULL DEFAULT 0,
  bull_job_id     TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_dealer_jobs_batch_id ON dealer_jobs(batch_id);
CREATE INDEX IF NOT EXISTS idx_dealer_jobs_status   ON dealer_jobs(status);
CREATE INDEX IF NOT EXISTS idx_dealer_jobs_domain   ON dealer_jobs(dealer_domain);

-- ─── Page Jobs ──────────────────────────────────────────────────────────────────
-- One row per individual inventory page to screenshot.
CREATE TABLE IF NOT EXISTS page_jobs (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  dealer_job_id   UUID NOT NULL REFERENCES dealer_jobs(id) ON DELETE CASCADE,
  batch_id        UUID NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  page_url        TEXT NOT NULL,
  page_number     INTEGER NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'skipped')),
  error_class     TEXT,
  error_message   TEXT,
  attempts        INTEGER NOT NULL DEFAULT 0,
  bull_job_id     TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_page_jobs_dealer_job_id ON page_jobs(dealer_job_id);
CREATE INDEX IF NOT EXISTS idx_page_jobs_batch_id      ON page_jobs(batch_id);
CREATE INDEX IF NOT EXISTS idx_page_jobs_status        ON page_jobs(status);

-- ─── Screenshots ────────────────────────────────────────────────────────────────
-- One row per completed screenshot.
CREATE TABLE IF NOT EXISTS screenshots (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  page_job_id     UUID NOT NULL REFERENCES page_jobs(id) ON DELETE CASCADE,
  dealer_job_id   UUID NOT NULL REFERENCES dealer_jobs(id) ON DELETE CASCADE,
  batch_id        UUID NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  dealer_domain   TEXT NOT NULL,
  page_url        TEXT NOT NULL,
  page_number     INTEGER NOT NULL,
  storage_path    TEXT NOT NULL,
  storage_url     TEXT,
  file_size_bytes INTEGER,
  width_px        INTEGER,
  height_px       INTEGER,
  bot_blocked     BOOLEAN NOT NULL DEFAULT FALSE,
  captured_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_screenshots_batch_id      ON screenshots(batch_id);
CREATE INDEX IF NOT EXISTS idx_screenshots_dealer_domain ON screenshots(dealer_domain);
CREATE INDEX IF NOT EXISTS idx_screenshots_page_job_id   ON screenshots(page_job_id);

-- ─── Rate Limit Tokens ──────────────────────────────────────────────────────────
-- Per-domain request counters for rate limiting (Redis handles real-time; this is audit log)
CREATE TABLE IF NOT EXISTS domain_request_log (
  id          BIGSERIAL PRIMARY KEY,
  domain      TEXT NOT NULL,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_domain_request_log_domain ON domain_request_log(domain, requested_at);
