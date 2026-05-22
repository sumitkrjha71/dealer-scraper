'use client'
import { useState, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { submitBatch } from '@/lib/api'

export default function HomePage() {
  const [raw, setRaw] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const router = useRouter()
  const fileRef = useRef<HTMLInputElement>(null)

  const urls = raw
    .split(/[\n,]+/)
    .map((u) => u.trim())
    .filter((u) => {
      try { new URL(u); return true } catch { return false }
    })

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (urls.length === 0) { setError('Add at least one valid URL.'); return }
    setError('')
    setLoading(true)
    try {
      const res = await submitBatch(urls)
      router.push(`/batch/${res.batchId}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Submission failed')
      setLoading(false)
    }
  }

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = (ev) => setRaw(ev.target?.result as string ?? '')
    reader.readAsText(file)
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-4 py-16"
         style={{ background: 'var(--bg)' }}>

      {/* Logo */}
      <div className="mb-10 text-center fade-up">
        <div className="flex items-center justify-center gap-2 mb-3">
          <div className="w-7 h-7 rounded-lg flex items-center justify-center"
               style={{ background: 'var(--brand)' }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5">
              <rect x="3" y="3" width="18" height="18" rx="2"/>
              <path d="M3 9h18M9 21V9"/>
            </svg>
          </div>
          <span className="font-semibold tracking-tight text-base" style={{ color: 'var(--text)' }}>
            Dealer Scraper
          </span>
        </div>
        <h1 className="text-3xl font-bold tracking-tight mb-2" style={{ color: 'var(--text)' }}>
          Screenshot inventory at scale
        </h1>
        <p style={{ color: 'var(--text-2)', fontSize: '14px' }}>
          Paste dealer URLs · auto-detect pagination · capture every page
        </p>
      </div>

      {/* Form */}
      <form onSubmit={handleSubmit}
            className="w-full max-w-2xl fade-up"
            style={{ animationDelay: '0.05s' }}>

        <div className="rounded-xl overflow-hidden"
             style={{ border: '1px solid var(--border)', background: 'var(--surface)' }}>

          {/* URL count badge */}
          <div className="flex items-center justify-between px-4 py-2.5"
               style={{ borderBottom: '1px solid var(--border)' }}>
            <span style={{ color: 'var(--muted)', fontSize: '11px', letterSpacing: '0.05em', textTransform: 'uppercase' }}>
              Dealer URLs
            </span>
            {urls.length > 0 && (
              <span className="text-xs px-2 py-0.5 rounded-full font-medium"
                    style={{ background: '#4f8ef715', color: 'var(--brand)' }}>
                {urls.length} URL{urls.length !== 1 ? 's' : ''} detected
              </span>
            )}
          </div>

          <textarea
            rows={12}
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            placeholder={"https://dealer1.com/used-cars\nhttps://dealer2.com/preowned-inventory\nhttps://dealer3.com/inventory/used\n\nOne URL per line, or paste comma-separated."}
            className="w-full px-4 py-3"
            style={{ borderRadius: 0, border: 'none', minHeight: '260px' }}
          />

          {/* Footer bar */}
          <div className="flex items-center justify-between px-4 py-3"
               style={{ borderTop: '1px solid var(--border)' }}>
            <label className="flex items-center gap-2 cursor-pointer"
                   style={{ color: 'var(--text-2)', fontSize: '12px' }}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
                   stroke="currentColor" strokeWidth="2">
                <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12"/>
              </svg>
              Upload CSV
              <input ref={fileRef} type="file" accept=".csv,.txt"
                     className="hidden" onChange={handleFile} />
            </label>

            <button
              type="submit"
              disabled={loading || urls.length === 0}
              className="flex items-center gap-2 px-5 py-2 rounded-lg text-sm font-medium transition-all"
              style={{
                background: urls.length > 0 && !loading ? 'var(--brand)' : 'var(--border-2)',
                color: urls.length > 0 && !loading ? 'white' : 'var(--muted)',
                cursor: urls.length === 0 || loading ? 'not-allowed' : 'pointer',
              }}>
              {loading ? (
                <>
                  <span className="spin inline-block w-3.5 h-3.5 rounded-full"
                        style={{ border: '2px solid #fff3', borderTopColor: 'white' }} />
                  Submitting…
                </>
              ) : (
                <>
                  Start Scraping
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
                       stroke="currentColor" strokeWidth="2">
                    <path d="M5 12h14M12 5l7 7-7 7"/>
                  </svg>
                </>
              )}
            </button>
          </div>
        </div>

        {error && (
          <p className="mt-3 text-xs text-center" style={{ color: 'var(--red)' }}>{error}</p>
        )}
      </form>

      {/* Hints */}
      <div className="mt-8 flex gap-6 fade-up" style={{ animationDelay: '0.1s' }}>
        {[
          { icon: '⚡', text: 'Concurrent processing' },
          { icon: '🔄', text: 'Auto pagination detection' },
          { icon: '📸', text: 'Full-page screenshots' },
        ].map((h) => (
          <div key={h.text} className="flex items-center gap-1.5"
               style={{ color: 'var(--muted)', fontSize: '12px' }}>
            <span>{h.icon}</span>
            <span>{h.text}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
