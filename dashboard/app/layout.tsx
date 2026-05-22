import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Dealer Scraper',
  description: 'Capture full-page screenshots of dealer inventory pages at scale.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
