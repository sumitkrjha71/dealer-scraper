'use client'
import { useEffect, useState, useCallback } from 'react'
import Link from 'next/link'
import type { BatchResults, BatchStatus } from '@/lib/types'
import { getBatchStatus, getBatchResults, downloadUrl } from '@/lib/api'
import DealerRow from './DealerRow'

export default function BatchView({ batchId }: { batchId: string }) {
  const [status, setStatus]   = useState<BatchStatus | null>(null)
  const [results, setResults] = useState<BatchResults | null>(null)
  const [error, setError]     = useState('')
  const isDone = status?.status === 'completed' || status?.status === 'failed'

  const poll = useCallback(async () => {
    try {
      const [s, r] = await Promise.all([
        getBatchStatus(batchId),
        getBatchResults(batchId),
      ])
      setStatus(s)
      setResults(r)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load batch')
    }
  }, [batchId])

  useEffect(() => {
    poll()
    const id = setInterval(() => { if (!isDone) poll() }, 2500)
    return () => clearInterval(id)
  }, [poll, isDone])

  // ── Derived stats ──────────────────────────────────────────────────────────
  const summary = status?.dealer_summary ?? []
  const done    = summary.find((s) => s.status === 'completed')?.count ?? 0
  const failed  = summary.find((s) => s.status === 'failed')?.count ?? 0
  const active  = summary.find((s) => s.status === 'processing')?.count ?? 0
  const pending = summary.find((s) => s.status === 'pending')?.count ?? 0
  const total   = status?.total_urls ?? 0
  const shots   = status?.total_screenshots ?? 0
  const pct     = total > 0 ? Math.round(((done + failed) / total) * 100) : 0

  const elapsed = status
    ? formatElapsed(new Date(status.created_at))
    : '—'

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p style={{ color: 'var(--red)' }}>{error}</p>
      </div>
    )
  }

  if (!status) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <span className="spin inline-block w-5 h-5 rounded-full"
              style={{ border: '2px solid var(--border-2)', borderTopColor: 'var(--brand)' }} />
      </div>
    )
  }

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg)' }}>

      {/* ── Top bar ── */}
      <div className="sticky top-0 z-10" style={{ borderBottom: '1px solid var(--border)', background: 'var(--bg)' }}>
        <div className="max-w-5xl mx-auto px-5 py-3 flex items-center justify-between">

          <div className="flex items-center gap-4">
            <Link href="/" className="flex items-center gap-1.5 text-xs transition-colors"
                  style={{ color: 'var(--muted)' }}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
                   stroke="currentColor" strokeWidth="2">
                <path d="M19 12H5M12 5l-7 7 7 7"/>
              </svg>
              New batch
            </Link>

            <div style={{ width: '1px', height: '14px', background: 'var(--border)' }} />

            <div className="flex items-center gap-2">
              <span className="text-xs font-mono" style={{ color: 'var(--muted)' }}>
                {batchId.slice(0, 8)}
              </span>
              <StatusBadge status={status.status} />
            </div>
          </div>

          <div className="flex items-center gap-3">
            <span className="text-xs" style={{ color: 'var(--muted)' }}>
              {elapsed}
            </span>
            {shots > 0 && (
              <a
                href={downloadUrl(batchId)}
                className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg transition-colors"
                style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--text)' }}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
                     stroke="currentColor" strokeWidth="2.5">
                  <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"/>
                </svg>
                Download all
              </a>
            )}
          </div>
        </div>
      </div>

      <div className="max-w-5xl mx-auto px-5 py-8">

        {/* ── Stats row ── */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6 fade-up">
          <StatCard label="Done"        value={done}    color="var(--green)" />
          <StatCard label="Processing"  value={active}  color="var(--amber)" />
          <StatCard label="Queued"      value={pending} color="var(--muted)" />
          <StatCard label="Screenshots" value={shots}   color="var(--brand)" />
        </div>

        {/* ── Progress bar ── */}
        <div className="mb-6 fade-up" style={{ animationDelay: '0.04s' }}>
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs" style={{ color: 'var(--muted)' }}>
              {done + failed} / {total} dealers
            </span>
            <span className="text-xs font-medium tabular-nums" style={{ color: 'var(--text)' }}>
              {pct}%
            </span>
          </div>
          <div className="h-1 rounded-full overflow-hidden" style={{ background: 'var(--border-2)' }}>
            <div
              className="h-full rounded-full progress-bar"
              style={{
                width: `${pct}%`,
                background: failed > 0 && done === 0
                  ? 'var(--red)'
                  : isDone && failed > 0
                    ? 'linear-gradient(90deg, var(--green), var(--red))'
                    : 'var(--brand)',
                transition: 'width 0.6s ease',
              }} />
          </div>
          {failed > 0 && (
            <p className="mt-1.5 text-xs" style={{ color: 'var(--muted)' }}>
              {failed} dealer{failed !== 1 ? 's' : ''} failed
            </p>
          )}
        </div>

        {/* ── Dealer list ── */}
        <div className="rounded-xl overflow-hidden fade-up"
             style={{ border: '1px solid var(--border)', animationDelay: '0.08s' }}>

          {/* List header */}
          <div className="flex items-center gap-3 px-5 py-2.5 hidden sm:flex"
               style={{ borderBottom: '1px solid var(--border)', background: 'var(--surface)' }}>
            <span className="text-xs w-4" />
            <span className="text-xs" style={{ color: 'var(--muted)', minWidth: '180px' }}>Domain</span>
            <span className="text-xs flex-1" style={{ color: 'var(--muted)' }}>URL</span>
            <span className="text-xs w-28" style={{ color: 'var(--muted)', textAlign: 'right' }}>Progress</span>
            <span className="text-xs w-24" style={{ color: 'var(--muted)', textAlign: 'right' }}>Status</span>
            <span className="text-xs w-4" />
          </div>

          {results?.dealers.length === 0 && (
            <div className="py-12 text-center">
              <span className="spin inline-block w-5 h-5 rounded-full"
                    style={{ border: '2px solid var(--border-2)', borderTopColor: 'var(--brand)' }} />
              <p className="mt-3 text-sm" style={{ color: 'var(--muted)' }}>Starting workers…</p>
            </div>
          )}

          {results?.dealers
            .sort((a, b) => {
              // Sort: processing first, then completed, then pending, then failed
              const order = { processing: 0, completed: 1, pending: 2, failed: 3, skipped: 4 }
              return (order[a.status] ?? 5) - (order[b.status] ?? 5)
            })
            .map((dealer, i) => (
              <DealerRow
                key={dealer.id}
                dealer={dealer}
                batchId={batchId}
                index={i}
              />
            ))}
        </div>

        {/* ── Footer ── */}
        {isDone && (
          <p className="mt-6 text-center text-xs fade-up" style={{ color: 'var(--muted)' }}>
            Batch completed · {shots} screenshot{shots !== 1 ? 's' : ''} captured
          </p>
        )}
      </div>
    </div>
  )
}

// ── Small components ────────────────────────────────────────────────────────

function StatCard({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="rounded-lg px-4 py-3"
         style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
      <div className="text-xl font-semibold tabular-nums" style={{ color }}>{value}</div>
      <div className="text-xs mt-0.5" style={{ color: 'var(--muted)' }}>{label}</div>
    </div>
  )
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; color: string; bg: string }> = {
    processing: { label: 'Running',   color: 'var(--amber)', bg: '#f59e0b15' },
    completed:  { label: 'Completed', color: 'var(--green)', bg: '#22c55e15' },
    failed:     { label: 'Failed',    color: 'var(--red)',   bg: '#ef444415' },
    pending:    { label: 'Pending',   color: 'var(--muted)', bg: 'var(--border)' },
  }
  const cfg = map[status] ?? map.pending
  return (
    <span className="text-xs px-2 py-0.5 rounded-full"
          style={{ color: cfg.color, background: cfg.bg }}>
      {cfg.label}
    </span>
  )
}

function formatElapsed(from: Date): string {
  const s = Math.floor((Date.now() - from.getTime()) / 1000)
  if (s < 60)  return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
}
