#!/usr/bin/env tsx
/**
 * CLI tool: submit a batch of dealer URLs from a file or stdin.
 *
 * Usage:
 *   tsx scripts/submit-batch.ts --file urls.txt
 *   tsx scripts/submit-batch.ts --file inventory.csv
 *   tsx scripts/submit-batch.ts --json '["https://dealer.com/used"]'
 *   echo "https://dealer.com/used" | tsx scripts/submit-batch.ts
 *
 * The script prints the batchId and polls for completion.
 */
import { readFileSync } from 'fs'
import { parse } from 'csv-parse/sync'
import { submitBatch } from '../src/queue/producer'
import { query } from '../src/db/client'
import { closePool } from '../src/db/client'
import { isValidUrl } from '../src/utils/url'
import { logger } from '../src/utils/logger'
import { sleep } from '../src/utils/retry'

async function main() {
  const args = process.argv.slice(2)
  let urls: string[] = []

  const fileFlag = args.indexOf('--file')
  const jsonFlag = args.indexOf('--json')

  if (fileFlag !== -1 && args[fileFlag + 1]) {
    const content = readFileSync(args[fileFlag + 1], 'utf-8')
    if (args[fileFlag + 1].endsWith('.csv')) {
      const records = parse(content, { columns: false, skip_empty_lines: true })
      urls = records.flat().map(String)
    } else {
      urls = content.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    }
  } else if (jsonFlag !== -1 && args[jsonFlag + 1]) {
    urls = JSON.parse(args[jsonFlag + 1])
  } else if (!process.stdin.isTTY) {
    const stdin = readFileSync('/dev/stdin', 'utf-8')
    urls = stdin.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  } else {
    console.error('Usage: submit-batch.ts --file <path> | --json <array>')
    process.exit(1)
  }

  urls = urls.filter(isValidUrl)
  if (urls.length === 0) {
    console.error('No valid URLs found')
    process.exit(1)
  }

  console.log(`Submitting ${urls.length} dealer URLs...`)
  const result = await submitBatch({ urls, submittedBy: 'cli' })

  console.log(`\nBatch submitted:`)
  console.log(`  Batch ID : ${result.batchId}`)
  console.log(`  Accepted : ${result.accepted}`)
  console.log(`  Rejected : ${result.rejected.length}`)

  if (result.rejected.length > 0) {
    console.log('\nRejected:')
    result.rejected.forEach((r) => console.log(`  ${r.url} — ${r.reason}`))
  }

  // Poll for completion
  console.log('\nPolling for completion (Ctrl+C to stop)...\n')
  let lastLog = ''
  while (true) {
    await sleep(5000)
    const [row] = await query<{
      status: string
      completed: number
      failed: number
      pending: number
    }>(
      `SELECT
         b.status,
         COUNT(dj.id) FILTER (WHERE dj.status = 'completed') AS completed,
         COUNT(dj.id) FILTER (WHERE dj.status = 'failed') AS failed,
         COUNT(dj.id) FILTER (WHERE dj.status IN ('pending','processing')) AS pending
       FROM batches b
       LEFT JOIN dealer_jobs dj ON dj.batch_id = b.id
       WHERE b.id = $1
       GROUP BY b.status`,
      [result.batchId],
    )

    if (!row) continue
    const [{ count: shots }] = await query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM screenshots WHERE batch_id = $1`,
      [result.batchId],
    )

    const log = `Status: ${row.status} | Done: ${row.completed} | Failed: ${row.failed} | Pending: ${row.pending} | Screenshots: ${shots}`
    if (log !== lastLog) { console.log(log); lastLog = log }

    if (row.status === 'completed' || (Number(row.pending) === 0 && Number(row.completed) + Number(row.failed) > 0)) {
      console.log('\nBatch finished.')
      break
    }
  }

  await closePool()
}

main().catch((err) => {
  console.error('Error:', err.message)
  process.exit(1)
})
