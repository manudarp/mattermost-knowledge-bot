import { logger } from "../logger.js";

export interface RetryOpts {
  retries?: number;
  baseMs?: number;
  maxMs?: number;
  shouldRetry?: (err: unknown) => boolean;
}

export function isNetworkError(err: unknown): boolean {
  if (err instanceof TypeError && err.message.includes("fetch")) return true;
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    if (msg.includes("network") || msg.includes("econnrefused") || msg.includes("enotfound")) return true;
  }
  return false;
}

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
    message: string,
    /** Server-requested wait (Retry-After), in milliseconds. */
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

function isRetryableError(err: unknown): boolean {
  if (isNetworkError(err)) return true;
  if (err instanceof HttpError) {
    return err.status === 429 || err.status >= 500;
  }
  return false;
}

export async function retryWithBackoff<T>(fn: () => Promise<T>, opts?: RetryOpts): Promise<T> {
  const retries = opts?.retries ?? 4;
  const baseMs = opts?.baseMs ?? 1000;
  const maxMs = opts?.maxMs ?? 8000;
  const shouldRetry = opts?.shouldRetry ?? isRetryableError;

  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === retries || !shouldRetry(err)) {
        throw err;
      }
      const backoff = Math.min(baseMs * Math.pow(2, attempt), maxMs);
      // Honour the server's Retry-After when it asks for longer (capped at 2 minutes).
      const requested = err instanceof HttpError && err.retryAfterMs !== undefined ? Math.min(err.retryAfterMs, 120_000) : 0;
      const delay = Math.max(backoff, requested);
      logger.warn({ attempt, delay_ms: delay, err }, "retry_backoff");
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  // Unreachable but TypeScript needs this
  throw lastErr;
}
