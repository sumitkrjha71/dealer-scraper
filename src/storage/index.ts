import { config } from '../config'
import { saveToLocal } from './local'
import { saveToS3 } from './s3'

export interface StorageResult {
  storagePath: string
  storageUrl: string | undefined
}

export async function saveScreenshot(
  buffer: Buffer,
  batchId: string,
  dealerDomain: string,
  pageNumber: number,
): Promise<StorageResult> {
  if (config.storage.provider === 's3') {
    return saveToS3(buffer, batchId, dealerDomain, pageNumber)
  }
  return saveToLocal(buffer, batchId, dealerDomain, pageNumber)
}
