export type JobStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'skipped'
export type BatchStatus = 'pending' | 'processing' | 'completed' | 'failed'

export interface Batch {
  id: string
  submitted_by?: string
  total_urls: number
  created_at: Date
  completed_at?: Date
  status: BatchStatus
}

export interface DealerJob {
  id: string
  batch_id: string
  dealer_url: string
  dealer_domain: string
  pages_detected?: number
  status: JobStatus
  error_class?: string
  error_message?: string
  attempts: number
  bull_job_id?: string
  created_at: Date
  started_at?: Date
  completed_at?: Date
}

export interface PageJob {
  id: string
  dealer_job_id: string
  batch_id: string
  page_url: string
  page_number: number
  status: JobStatus
  error_class?: string
  error_message?: string
  attempts: number
  bull_job_id?: string
  created_at: Date
  started_at?: Date
  completed_at?: Date
}

export interface Screenshot {
  id: string
  page_job_id: string
  dealer_job_id: string
  batch_id: string
  dealer_domain: string
  page_url: string
  page_number: number
  storage_path: string
  storage_url?: string
  file_size_bytes?: number
  width_px?: number
  height_px?: number
  captured_at: Date
}

// ─── Queue job payloads ─────────────────────────────────────────────────────────

export interface DealerJobPayload {
  dealerJobId: string
  batchId: string
  dealerUrl: string
  dealerDomain: string
}

export interface ScreenshotJobPayload {
  pageJobId: string
  dealerJobId: string
  batchId: string
  pageUrl: string
  pageNumber: number
  dealerDomain: string
}

// ─── API response shapes ────────────────────────────────────────────────────────

export interface BatchResult {
  batch_id: string
  total_dealers: number
  completed: number
  failed: number
  pending: number
  total_screenshots: number
  dealers: DealerResult[]
}

export interface DealerResult {
  dealer_url: string
  dealer_domain: string
  pages_detected: number
  status: JobStatus
  screenshots: ScreenshotSummary[]
  error?: string
}

export interface ScreenshotSummary {
  page_number: number
  page_url: string
  storage_path: string
  storage_url?: string
  captured_at: string
}
