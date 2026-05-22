import type { BatchStatus, BatchResults } from './types'

const API = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001').replace(/\/$/, '')

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`API ${path} → ${res.status}: ${body}`)
  }
  return res.json() as Promise<T>
}

export async function submitBatch(urls: string[]): Promise<{ batchId: string; accepted: number; rejected: { url: string; reason: string }[] }> {
  return apiFetch('/api/v1/batches', {
    method: 'POST',
    body: JSON.stringify({ urls }),
  })
}

export async function getBatchStatus(id: string): Promise<BatchStatus> {
  return apiFetch(`/api/v1/batches/${id}`)
}

export async function getBatchResults(id: string): Promise<BatchResults> {
  return apiFetch(`/api/v1/batches/${id}/results?limit=200`)
}

/** Returns the correct image URL — direct S3 URL if available, otherwise proxied through backend */
export function imageUrl(storagePath: string, storageUrl?: string | null): string {
  if (storageUrl) return storageUrl
  return `${API}/api/v1/screenshots/image?path=${encodeURIComponent(storagePath)}`
}

export function downloadUrl(batchId: string): string {
  return `${API}/api/v1/batches/${batchId}/download`
}
