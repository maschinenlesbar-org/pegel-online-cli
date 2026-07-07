// HTTP transport built on Node's built-in `http`/`https` modules — no axios,
// no fetch polyfill, no third-party HTTP client.
//
// The transport is a plain function so it can be trivially swapped out in tests
// (inject a `mock.fn()` returning a canned HttpResponse) without touching the
// network. The default implementation below is exercised against a real local
// `http.createServer` in the test-suite.

import http from "node:http";
import https from "node:https";
import { PegelNetworkError } from "./errors.js";

export interface HttpRequest {
  method: string;
  /** Fully-qualified absolute URL. */
  url: string;
  headers?: Record<string, string>;
  /** Optional request body (already serialised). */
  body?: string | Buffer;
  /** Per-request timeout in milliseconds. */
  timeoutMs?: number;
  /** Hard cap on the response body size in bytes; the request aborts if exceeded. */
  maxResponseBytes?: number;
}

export interface HttpResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

export type Transport = (request: HttpRequest) => Promise<HttpResponse>;

/**
 * Default transport. Resolves with the raw response (including non-2xx) — status
 * interpretation is the client's job. Rejects only on transport-level failures
 * (connection errors, timeouts, malformed URLs).
 */
/**
 * Multiplier applied to the per-request idle timeout to derive an overall
 * wall-clock deadline. `req.setTimeout` only fires on an *idle* socket — every
 * received byte resets it — so a hostile server can trickle one byte just under
 * the idle window forever and the request never times out. This bounds the total
 * time a single request may take before it is destroyed, regardless of trickle.
 */
const OVERALL_DEADLINE_FACTOR = 10;

export const nodeHttpTransport: Transport = (request) =>
  new Promise<HttpResponse>((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      reject(new PegelNetworkError(`Invalid URL: ${request.url}`));
      return;
    }

    // Only http/https are supported. Reject anything else up front with a clear,
    // typed error instead of letting Node throw an opaque ERR_INVALID_PROTOCOL
    // (and so this never reaches the file:/ftp:/etc. drivers).
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      reject(new PegelNetworkError(`Unsupported protocol "${url.protocol}" in URL: ${request.url}`));
      return;
    }

    const isHttps = url.protocol === "https:";
    const driver = isHttps ? https : http;
    const maxBytes = request.maxResponseBytes;

    // Overall wall-clock deadline (see OVERALL_DEADLINE_FACTOR). Cleared on the
    // first settle so it never leaks or keeps the event loop alive.
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const clearDeadline = (): void => {
      if (deadlineTimer !== undefined) {
        clearTimeout(deadlineTimer);
        deadlineTimer = undefined;
      }
    };
    const settleResolve = (value: HttpResponse): void => {
      clearDeadline();
      resolve(value);
    };
    const settleReject = (err: unknown): void => {
      clearDeadline();
      reject(err);
    };

    const req = driver.request(
      url,
      {
        method: request.method,
        headers: request.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let received = 0;
        let aborted = false;

        res.on("data", (chunk: Buffer) => {
          if (aborted) return;
          received += chunk.length;
          if (maxBytes !== undefined && received > maxBytes) {
            aborted = true;
            res.destroy();
            settleReject(new PegelNetworkError(`Response exceeded maxResponseBytes (${maxBytes})`));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          if (aborted) return;
          settleResolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          });
        });
        res.on("error", (err) => {
          if (aborted) return; // we already rejected with the size-cap error
          settleReject(new PegelNetworkError(`Response stream error: ${err.message}`, { cause: err }));
        });
      },
    );

    if (request.timeoutMs && request.timeoutMs > 0) {
      // Idle-socket timeout: fires when no bytes move for timeoutMs.
      req.setTimeout(request.timeoutMs, () => {
        req.destroy(new PegelNetworkError(`Request timed out after ${request.timeoutMs}ms`));
      });
      // Overall deadline: a hostile server can trickle bytes just under the idle
      // window forever, so cap total wall-clock time as well.
      const overallMs = request.timeoutMs * OVERALL_DEADLINE_FACTOR;
      deadlineTimer = setTimeout(() => {
        req.destroy(new PegelNetworkError(`Request exceeded overall deadline of ${overallMs}ms`));
      }, overallMs);
      // Do not let the deadline timer alone keep the process alive.
      deadlineTimer.unref?.();
    }

    req.on("error", (err) => {
      // A timeout destroy already passes an PegelNetworkError; don't double-wrap.
      settleReject(err instanceof PegelNetworkError ? err : new PegelNetworkError(err.message, { cause: err }));
    });

    if (request.body !== undefined) req.write(request.body);
    req.end();
  });
