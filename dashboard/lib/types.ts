export type JobStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'skipped'

export interface Screenshot {
  page_number: number
  page_url: string
  storage_path: string
  storage_url: string | null
  captured_at: string
  bot_blocked?: boolean
}

export interface DealerResult {
  id: string
  dealer_url: string
  dealer_domain: string
  pages_detected: number | null
  status: JobStatus
  error_message: string | null
  screenshots: Screenshot[]
}

export interface BatchStatus {
  batch_id: string
  status: string
  total_urls: number
  created_at: string
  completed_at: string | null
  dealer_summary: { status: JobStatus; count: number }[]
  total_screenshots: number
}

export interface BatchResults {
  batch_id: string
  page: number
  limit: number
  total: number
  dealers: DealerResult[]
}
