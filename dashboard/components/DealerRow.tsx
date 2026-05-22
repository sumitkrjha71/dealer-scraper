'use client'
import { useState } from 'react'
import type { DealerResult } from '@/lib/types'
import { imageUrl, downloadUrl } from '@/lib/api'

interface Props {
  dealer: DealerResult
  batchId: string
  index: number
}

const STATUS_CONFIG = {
  pending:    { label: 'Queued',      dot: 'var(--muted)',  text: 'var(--muted)' },
  processing: { label: 'Processing',  dot: 'var(--amber)',  text: 'var(--amber)' },
  completed:  { label: 'Done',        dot: 'var(--green)',  text: 'var(--green)' },
  failed:     { label: 'Failed',      dot: 'var(--red)',    text: 'var(--red)'   },
  skipped:    { label: 'Skipped',     dot: 'var(--muted)',  text: 'var(--muted)' },
}

export default function DealerRow({ dealer, batchId, index }: Props) {
  const [expanded, setExpanded] = useState(false)
  const [imgErrors, setImgErrors] = useState<Set<number>>(new Set())

  const cfg = STATUS_CONFIG[dealer.status] ?? STATUS_CONFIG.pending
  const shots = dealer.screenshots ?? []
  const pagesDetected = dealer.pages_detected ?? 0
  const pagesCapt = shots.length

  return (
    <div
      className="fade-up"
      style={{
        borderBottom: '1px solid var(--border)',
        animationDelay: `${index * 0.03}s`,
      }}>

      {/* ── Main row ── */}
      <div
        className="flex items-center gap-3 px-5 py-3.5 cursor-pointer select-none transition-colors"
        style={{ background: expanded ? 'var(--surface)' : 'transparent' }}
        onClick={() => shots.length > 0 && setExpanded((v) => !v)}>

        {/* Favicon */}
        <img
          src={`https://www.google.com/s2/favicons?sz=32&domain=${dealer.dealer_domain}`}
          alt=""
          width={16} height={16}
          className="rounded-sm opacity-60 flex-shrink-0"
          onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
        />

        {/* Domain */}
        <span className="font-medium text-sm flex-shrink-0" style={{ minWidth: '180px', color: 'var(--text)' }}>
          {dealer.dealer_domain}
        </span>

        {/* URL — truncated */}
        <span className="text-xs flex-1 truncate hidden sm:block"
              style={{ color: 'var(--muted)', fontFamily: 'monospace' }}>
          {dealer.dealer_url}
        </span>

        {/* Page progress */}
        <div className="flex items-center gap-2 flex-shrink-0">
          {dealer.status === 'processing' && pagesDetected > 0 && (
            <div className="flex items-center gap-1.5">
              <div className="h-1 w-20 rounded-full overflow-hidden" style={{ background: 'var(--border-2)' }}>
                <div
                  className="h-full rounded-full transition-all duration-500"
                  style={{
                    width: `${Math.round((pagesCapt / pagesDetected) * 100)}%`,
                    background: 'var(--amber)',
                  }} />
              </div>
              <span className="text-xs" style={{ color: 'var(--amber)' }}>
                {pagesCapt}/{pagesDetected}
              </span>
            </div>
          )}

          {dealer.status === 'completed' && (
            <span className="text-xs" style={{ color: 'var(--muted)' }}>
              {pagesCapt} page{pagesCapt !== 1 ? 's' : ''}
            </span>
          )}
        </div>

        {/* Status pill */}
        <div className="flex items-center gap-1.5 flex-shrink-0" style={{ minWidth: '90px' }}>
          {dealer.status === 'processing' ? (
            <span className="spin inline-block w-3 h-3 rounded-full flex-shrink-0"
                  style={{ border: '1.5px solid #f59e0b30', borderTopColor: 'var(--amber)' }} />
          ) : (
            <span className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                  style={{ background: cfg.dot }} />
          )}
          <span className="text-xs" style={{ color: cfg.text }}>{cfg.label}</span>
        </div>

        {/* Expand chevron */}
        {shots.length > 0 && (
          <svg
            width="14" height="14" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="2"
            className="flex-shrink-0 transition-transform duration-200"
            style={{
              color: 'var(--muted)',
              transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)',
            }}>
            <path d="M6 9l6 6 6-6"/>
          </svg>
        )}
      </div>

      {/* ── Expanded screenshot strip ── */}
      {expanded && shots.length > 0 && (
        <div style={{ background: 'var(--surface)', borderTop: '1px solid var(--border)' }}>

          {/* Controls */}
          <div className="flex items-center justify-between px-5 py-2.5"
               style={{ borderBottom: '1px solid var(--border)' }}>
            <span className="text-xs" style={{ color: 'var(--muted)' }}>
              {shots.length} screenshot{shots.length !== 1 ? 's' : ''} captured
            </span>
            <a
              href={`${downloadUrl(batchId)}?domain=${encodeURIComponent(dealer.dealer_domain)}`}
              className="flex items-center gap-1.5 text-xs px-3 py-1 rounded-md transition-colors"
              style={{ color: 'var(--brand)', border: '1px solid #4f8ef730' }}
              onClick={(e) => e.stopPropagation()}>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none"
                   stroke="currentColor" strokeWidth="2.5">
                <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"/>
              </svg>
              Download
            </a>
          </div>

          {/* Thumbnail strip */}
          <div className="flex gap-3 px-5 py-4 overflow-x-auto">
            {shots
              .sort((a, b) => a.page_number - b.page_number)
              .map((shot) => (
                <ScreenshotThumb
                  key={shot.page_number}
                  shot={shot}
                  hasError={imgErrors.has(shot.page_number)}
                  onError={() => setImgErrors((s) => new Set(s).add(shot.page_number))}
                />
              ))}
          </div>
        </div>
      )}

      {/* Failed state */}
      {dealer.status === 'failed' && dealer.error_message && (
        <div className="px-5 py-2.5" style={{ background: '#ef444408', borderTop: '1px solid var(--border)' }}>
          <p className="text-xs font-mono" style={{ color: 'var(--red)', opacity: 0.8 }}>
            {dealer.error_message.slice(0, 200)}
          </p>
        </div>
      )}
    </div>
  )
}

function ScreenshotThumb({
  shot,
  hasError,
  onError,
}: {
  shot: DealerResult['screenshots'][number]
  hasError: boolean
  onError: () => void
}) {
  const [hovering, setHovering] = useState(false)
  const src = imageUrl(shot.storage_path, shot.storage_url)

  return (
    <a
      href={src}
      target="_blank"
      rel="noopener noreferrer"
      className="flex-shrink-0 relative block rounded-lg overflow-hidden transition-all"
      style={{
        width: '120px',
        height: '80px',
        border: hovering ? '1px solid var(--brand)' : '1px solid var(--border-2)',
        transform: hovering ? 'scale(1.02)' : 'scale(1)',
        transition: 'border 0.15s, transform 0.15s',
      }}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}>

      {hasError ? (
        <div className="w-full h-full flex items-center justify-center"
             style={{ background: 'var(--border)', color: 'var(--muted)', fontSize: '10px' }}>
          Failed
        </div>
      ) : (
        <img
          src={src}
          alt={`Page ${shot.page_number}`}
          className="w-full h-full object-cover object-top"
          loading="lazy"
          onError={onError}
        />
      )}

      {/* Page number badge */}
      <div className="absolute bottom-1 right-1 px-1.5 py-0.5 rounded text-xs"
           style={{ background: '#00000090', color: 'white', fontSize: '10px', lineHeight: 1.4 }}>
        p{shot.page_number}
      </div>

      {/* Bot blocked badge */}
      {shot.bot_blocked && (
        <div className="absolute top-1 left-1 px-1.5 py-0.5 rounded text-xs"
             style={{ background: '#ef444490', color: 'white', fontSize: '9px' }}>
          blocked
        </div>
      )}
    </a>
  )
}
