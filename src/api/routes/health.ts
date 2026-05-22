import { FastifyInstance } from 'fastify'
import { pool } from '../../db/client'
import { dealerQueue, screenshotQueue } from '../../queue/queues'

export async function healthRoutes(app: FastifyInstance) {
  // Kubernetes liveness probe — process is alive
  app.get('/healthz', async () => ({ status: 'ok' }))

  // Kubernetes readiness probe — can serve traffic (DB + Redis reachable)
  app.get('/readyz', async (req, reply) => {
    const checks = await Promise.allSettled([
      pool.query('SELECT 1'),
      dealerQueue.getJobCounts(),
      screenshotQueue.getJobCounts(),
    ])

    const [db, dealer, screenshot] = checks.map((c) => c.status === 'fulfilled')
    const ready = db && dealer && screenshot

    reply.status(ready ? 200 : 503).send({
      status: ready ? 'ready' : 'not_ready',
      checks: { database: db, dealerQueue: dealer, screenshotQueue: screenshot },
    })
  })

  // Queue depth — useful for Prometheus scraping or manual inspection
  app.get('/metrics/queues', async () => {
    const [dealerCounts, screenshotCounts] = await Promise.all([
      dealerQueue.getJobCounts(),
      screenshotQueue.getJobCounts(),
    ])
    return {
      dealer: dealerCounts,
      screenshot: screenshotCounts,
    }
  })
}
