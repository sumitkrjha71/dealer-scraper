import { FastifyInstance } from 'fastify'
import { createReadStream, existsSync } from 'fs'
import { join, resolve } from 'path'
import archiver from 'archiver'
import { config } from '../../config'
import { query } from '../../db/client'

export async function screenshotRoutes(app: FastifyInstance) {

  // ── Serve a single screenshot from local storage ─────────────────────────
  // Used by the dashboard when STORAGE_PROVIDER=local (no S3 URL available)
  app.get<{ Querystring: { path?: string } }>('/screenshots/image', async (req, reply) => {
    const { path: relPath } = req.query
    if (!relPath) return reply.status(400).send({ error: 'path required' })

    const screenshotsRoot = resolve(config.storage.screenshotsDir)
    const fullPath = resolve(join(screenshotsRoot, relPath))

    // Prevent path traversal attacks
    if (!fullPath.startsWith(screenshotsRoot)) {
      return reply.status(403).send({ error: 'forbidden' })
    }

    if (!existsSync(fullPath)) {
      return reply.status(404).send({ error: 'screenshot not found' })
    }

    reply.header('Content-Type', 'image/jpeg')
    reply.header('Cache-Control', 'public, max-age=31536000, immutable')
    return reply.send(createReadStream(fullPath))
  })

  // ── Download all screenshots for a batch as a ZIP ────────────────────────
  app.get<{
    Params: { batchId: string }
    Querystring: { domain?: string }
  }>('/batches/:batchId/download', async (req, reply) => {
    const { batchId } = req.params
    const { domain } = req.query

    let screenshots: { storage_path: string; dealer_domain: string; page_number: number }[]

    if (domain) {
      screenshots = await query(
        `SELECT storage_path, dealer_domain, page_number
         FROM screenshots WHERE batch_id = $1 AND dealer_domain = $2
         ORDER BY page_number`,
        [batchId, domain],
      )
    } else {
      screenshots = await query(
        `SELECT storage_path, dealer_domain, page_number
         FROM screenshots WHERE batch_id = $1
         ORDER BY dealer_domain, page_number`,
        [batchId],
      )
    }

    if (screenshots.length === 0) {
      return reply.status(404).send({ error: 'No screenshots found for this batch' })
    }

    const filename = domain
      ? `${domain}-screenshots.zip`
      : `batch-${batchId.slice(0, 8)}-screenshots.zip`

    reply.raw.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Transfer-Encoding': 'chunked',
    })

    const archive = archiver('zip', { zlib: { level: 1 } }) // level 1 = fast, JPEGs don't compress further
    archive.pipe(reply.raw)

    const screenshotsRoot = resolve(config.storage.screenshotsDir)

    for (const shot of screenshots) {
      // Skip S3-backed shots (they have storage_url) — for S3 you'd fetch & stream
      const fullPath = resolve(join(screenshotsRoot, shot.storage_path))
      if (!fullPath.startsWith(screenshotsRoot) || !existsSync(fullPath)) continue

      const entryName = `${shot.dealer_domain}/page_${shot.page_number}.jpg`
      archive.file(fullPath, { name: entryName })
    }

    await archive.finalize()
  })
}
