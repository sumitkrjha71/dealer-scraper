import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
import { config } from '../config'
import { logger } from '../utils/logger'
import type { StorageResult } from './local'

let _s3: S3Client | undefined

function getS3Client(): S3Client {
  if (!_s3) {
    _s3 = new S3Client({
      region: config.storage.s3.region,
      credentials: config.storage.s3.accessKeyId
        ? {
            accessKeyId: config.storage.s3.accessKeyId,
            secretAccessKey: config.storage.s3.secretAccessKey,
          }
        : undefined, // Falls back to IAM instance role in production
      endpoint: config.storage.s3.endpoint || undefined,
      forcePathStyle: !!config.storage.s3.endpoint, // Required for MinIO
    })
  }
  return _s3
}

/**
 * Upload screenshot buffer to S3.
 * Key: {batchId}/{dealerDomain}/page_{pageNumber}.jpg
 */
export async function saveToS3(
  buffer: Buffer,
  batchId: string,
  dealerDomain: string,
  pageNumber: number,
): Promise<StorageResult> {
  const key = `${batchId}/${dealerDomain}/page_${pageNumber}.jpg`
  const bucket = config.storage.s3.bucket

  if (!bucket) throw new Error('AWS_BUCKET not configured')

  await getS3Client().send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: buffer,
      ContentType: 'image/jpeg',
      // Tag for lifecycle policy — auto-delete raw screenshots after 90 days
      Tagging: `batch=${batchId}&domain=${dealerDomain}`,
      // Server-side encryption
      ServerSideEncryption: 'AES256',
    }),
  )

  const endpoint = config.storage.s3.endpoint
  const storageUrl = endpoint
    ? `${endpoint}/${bucket}/${key}` // MinIO / R2 custom endpoint
    : `https://${bucket}.s3.${config.storage.s3.region}.amazonaws.com/${key}`

  logger.debug({ key, bucket }, 'screenshot uploaded to S3')

  return { storagePath: key, storageUrl }
}
