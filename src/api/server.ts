import Fastify from 'fastify'
import cors from '@fastify/cors'
import { config } from '../config'
import { logger } from '../utils/logger'
import { healthRoutes } from './routes/health'
import { jobRoutes } from './routes/jobs'
import { screenshotRoutes } from './routes/screenshots'
import { debugRoutes } from './routes/debug'
import { closePool } from '../db/client'
import { closeQueues } from '../queue/queues'

export async function buildServer() {
  const app = Fastify({
    logger: {
      level: config.env === 'production' ? 'info' : 'debug',
      ...(config.env !== 'production'
        ? { transport: { target: 'pino-pretty', options: { colorize: true } } }
        : {}),
    },
    trustProxy: true,
  })

  // Allow all origins — dashboard can be on any domain
  await app.register(cors, {
    origin: true,
    credentials: true,
  })

  // ── Request parsing limits ──────────────────────────────────────────────────
  // Batches of 1,000 URLs with CSV can be large
  app.addContentTypeParser('application/json', { parseAs: 'string', bodyLimit: 5 * 1024 * 1024 }, (req, body, done) => {
    try {
      done(null, JSON.parse(body as string))
    } catch (err) {
      done(err as Error, undefined)
    }
  })

  // ── Routes ──────────────────────────────────────────────────────────────────
  await app.register(healthRoutes)
  await app.register(jobRoutes, { prefix: '/api/v1' })
  await app.register(screenshotRoutes, { prefix: '/api/v1' })
  await app.register(debugRoutes, { prefix: '/api/v1' })

  // ── Global error handler ────────────────────────────────────────────────────
  app.setErrorHandler((err, req, reply) => {
    app.log.error({ err, url: req.url }, 'request error')
    reply.status(err.statusCode ?? 500).send({
      error: err.message,
      ...(config.env !== 'production' ? { stack: err.stack } : {}),
    })
  })

  return app
}

async function main() {
  const app = await buildServer()

  const address = await app.listen({ port: config.port, host: '0.0.0.0' })
  logger.info({ address }, 'API server listening')

  async function shutdown() {
    await app.close()
    await closeQueues()
    await closePool()
    process.exit(0)
  }

  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

if (require.main === module) {
  main().catch((err) => {
    logger.error({ err }, 'API server failed to start')
    process.exit(1)
  })
}
