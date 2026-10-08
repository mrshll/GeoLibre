// ECMWF range requests can fail as either 503 or a browser network error when
// the upstream error response lacks CORS headers. Retry both per virtual store.
import type { FetchClient } from "icechunk-js";

export interface RetryInfo {
  url: string;
  attempt: number;
  reason: string;
}

export interface RetryFetchOptions {
  maxAttempts?: number;
  baseMs?: number;
  fetchImpl?: FetchClient["fetch"];
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  onRetry?: (info: RetryInfo) => void;
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(signal?.reason ?? new DOMException("The operation was aborted.", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

/**
 * Create an Icechunk FetchClient with abort-aware, jittered exponential retries.
 *
 * @param options Total attempts (default 6), base wait (250 ms), and injectable callbacks.
 * @returns A client whose stats accumulate attempts and retries across requests.
 */
export function retryingFetchClient({
  maxAttempts = 6,
  baseMs = 250,
  fetchImpl = (url, init) => globalThis.fetch(url, init),
  sleep = abortableSleep,
  onRetry,
}: RetryFetchOptions = {}): FetchClient & { stats: { attempts: number; retries: number } } {
  const stats = { attempts: 0, retries: 0 };
  return {
    stats,
    async fetch(url, init) {
      for (let attempt = 1; ; attempt++) {
        init?.signal?.throwIfAborted();
        stats.attempts++;
        let reason: string;
        try {
          const response = await fetchImpl(url, init);
          if (response.status !== 429 && response.status < 500) return response;
          if (attempt >= maxAttempts) return response;
          reason = `HTTP ${response.status}`;
          void response.body?.cancel().catch(() => {});
        } catch (error: unknown) {
          if (init?.signal?.aborted || attempt >= maxAttempts) throw error;
          reason = error instanceof Error ? error.message : String(error);
        }
        stats.retries++;
        onRetry?.({ url, attempt, reason });
        await sleep(baseMs * 2 ** (attempt - 1) * (0.5 + Math.random()), init?.signal ?? undefined);
        init?.signal?.throwIfAborted();
      }
    },
  };
}
