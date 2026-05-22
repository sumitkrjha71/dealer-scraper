#!/usr/bin/env tsx
/** Run database migrations */
import { readFileSync } from 'fs'
import { join } from 'path'
import { pool } from '../src/db/client'

async function migrate() {
  const sql = readFileSync(join(__dirname, '../src/db/migrations/001_init.sql'), 'utf-8')
  console.log('Running migrations...')
  await pool.query(sql)
  console.log('Migrations complete.')
  await pool.end()
}

migrate().catch((err) => {
  console.error('Migration failed:', err.message)
  process.exit(1)
})
