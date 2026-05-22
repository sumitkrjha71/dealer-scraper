import { logger } from './logger'

export type ErrorClass =
  | 'timeout'
  | 'bot_blocked'
  | 'not_found'
  | 'network_error'
  | 'parse_error'
  | 'unknown'

export interface RetryableError extends Error {
  errorClass: ErrorClass
  retryable: boolean
  statusCode?: number
}

export function classifyError(err: unknown): RetryableError {
  const message = err instanceof Error ? err.message.toLowerCase() : String(err)
  const base = err instanceof Error ? err : new Error(String(err))

  let errorClass: ErrorClass = 'unknown'
  let retryable = true
  let statusCode: number | undefined

  if (message.includes('timeout') || message.includes('timed out')) {
    errorClass = 'timeout'
    retryable = true
  } else if (
    message.includes('cloudflare') ||
    message.includes('403') ||
    message.includes('access denied') ||
    message.includes('bot') ||
    message.includes('captcha') ||
    message.includes('challenge')
  ) {
    errorClass = 'bot_blocked'
    // Bot blocks are retryable with proxy rotation, not raw retries
    retryable = false
  } else if (message.includes('404') || message.includes('not found')) {
    errorClass = 'not_found'
    retryable = false
  } else if (
    message.includes('net::err') ||
    message.includes('econnrefused') ||
    message.includes('enotfound') ||
    message.includes('socket hang up')
  ) {
    errorClass = 'network_error'
    retryable = true
  } else if (message.includes('parse') || message.includes('syntax')) {
    errorClass = 'parse_error'
    retryable = false
  }

  const retryableErr = base as RetryableError
  retryableErr.errorClass = errorClass
  retryableErr.retryable = retryable
  retryableErr.statusCode = statusCode
  return retryableErr
}

export interface RetryOptions {
  maxAttempts: number
  baseDelayMs: number
  maxDelayMs?: number
  onRetry?: (attempt: number, err: RetryableError) => void
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions,
  context?: Record<string, unknown>,
): Promise<T> {
  const maxDelay = opts.maxDelayMs ?? 30_000
  let lastErr: RetryableError | undefined

  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      return await fn()
    } catch (rawErr) {
      lastErr = classifyError(rawErr)

      if (!lastErr.retryable || attempt === opts.maxAttempts) {
        logger.warn({ ...context, attempt, errorClass: lastErr.errorClass, err: lastErr.message }, 'giving up after retries')
        throw lastErr
      }

      // Exponential backoff with jitter
      const exp = Math.pow(2, attempt - 1)
      const jitter = Math.random() * opts.baseDelayMs
      const delay = Math.min(exp * opts.baseDelayMs + jitter, maxDelay)

      logger.debug(
        { ...context, attempt, nextIn: Math.round(delay), errorClass: lastErr.errorClass },
        'retrying after error',
      )

      if (opts.onRetry) opts.onRetry(attempt, lastErr)
      await sleep(delay)
    }
  }

  throw lastErr!
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
