import { Pool, PoolClient } from 'pg'
import { config } from '../config'
import { logger } from '../utils/logger'

export const pool = new Pool({
  connectionString: config.database.url,
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
})

pool.on('error', (err) => {
  logger.error({ err }, 'idle postgres client error')
})

export async function query<T extends Record<string, unknown> = Record<string, unknown>>(
  text: string,
  values?: unknown[],
): Promise<T[]> {
  const result = await pool.query<T>(text, values)
  return result.rows
}

export async function queryOne<T extends Record<string, unknown> = Record<string, unknown>>(
  text: string,
  values?: unknown[],
): Promise<T | undefined> {
  const rows = await query<T>(text, values)
  return rows[0]
}

export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

export async function closePool(): Promise<void> {
  await pool.end()
}
