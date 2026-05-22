import { mkdir, writeFile } from 'fs/promises'
import { join, dirname } from 'path'
import { config } from '../config'
import { logger } from '../utils/logger'

export interface StorageResult {
  storagePath: string
  storageUrl: string | undefined
}

/**
 * Save screenshot buffer to local filesystem.
 * Path: {screenshotsDir}/{batchId}/{dealerDomain}/page_{pageNumber}.jpg
 */
export async function saveToLocal(
  buffer: Buffer,
  batchId: string,
  dealerDomain: string,
  pageNumber: number,
): Promise<StorageResult> {
  const relativePath = join(batchId, dealerDomain, `page_${pageNumber}.jpg`)
  const fullPath = join(config.storage.screenshotsDir, relativePath)

  await mkdir(dirname(fullPath), { recursive: true })
  await writeFile(fullPath, buffer)

  logger.debug({ path: fullPath }, 'screenshot saved locally')

  return {
    storagePath: relativePath,
    storageUrl: undefined,
  }
}
