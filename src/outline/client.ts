import type { Logger } from "../logger.js";
import { retryWithBackoff, HttpError } from "../utils/retry.js";

/** Retry-After as seconds or HTTP date → milliseconds. */
export function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

export class OutlineAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutlineAuthError";
  }
}

export class OutlineClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly logger: Logger;

  constructor(baseUrl: string, token: string, logger: Logger) {
    this.baseUrl = `${baseUrl.replace(/\/$/, "")}/api`;
    this.token = token;
    this.logger = logger;
  }

  async post<T>(endpoint: string, body: object): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;
    return retryWithBackoff(
      async () => {
        const res = await fetch(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        });

        if (res.status === 401) {
          const text = await res.text();
          throw new OutlineAuthError(`Outline authentication failed (401): ${text}`);
        }

        if (!res.ok) {
          const text = await res.text();
          throw new HttpError(
            res.status,
            text,
            `HTTP ${res.status} POST ${endpoint}: ${text}`,
            res.status === 429 ? parseRetryAfter(res.headers.get("retry-after")) : undefined,
          );
        }

        const json = (await res.json()) as Record<string, unknown>;
        if ("data" in json) {
          return json.data as T;
        }
        return json as T;
      },
      {
        // Outline's rate limiter answers 429 for a whole window: back off long
        // enough (honouring Retry-After) instead of hammering it again.
        retries: 6,
        maxMs: 60_000,
        shouldRetry: (err) => {
          if (err instanceof OutlineAuthError) return false;
          if (err instanceof HttpError) return err.status === 429 || err.status >= 500;
          return false;
        },
      },
    );
  }

}
