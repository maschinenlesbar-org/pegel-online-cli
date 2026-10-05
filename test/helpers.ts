// Test helpers: build canned HTTP responses and a recording mock transport based
// on Node's built-in `node:test` mock facility. No real network is ever touched
// in the unit suite.

import { mock } from "node:test";
import type { Transport, HttpRequest, HttpResponse } from "../src/client/http.js";
import { PegelOnlineClient } from "../src/client/client.js";
import { run } from "../src/cli/run.js";

export function jsonResponse(body: unknown, status = 200): HttpResponse {
  return {
    status,
    headers: { "content-type": "application/json" },
    body: Buffer.from(JSON.stringify(body)),
  };
}

export function rawResponse(
  data: string | Buffer,
  contentType: string,
  status = 200,
): HttpResponse {
  return {
    status,
    headers: { "content-type": contentType },
    body: Buffer.isBuffer(data) ? data : Buffer.from(data),
  };
}

export interface MockTransport {
  transport: Transport;
  /** All requests the transport has received, in order. */
  readonly calls: HttpRequest[];
  /** The most recent request. */
  last(): HttpRequest;
}

/**
 * Build a mock transport from a responder function. The returned object records
 * every request so tests can assert on method/url/headers.
 */
export function makeMockTransport(
  responder: (req: HttpRequest) => HttpResponse | Promise<HttpResponse>,
): MockTransport {
  const calls: HttpRequest[] = [];
  const fn = mock.fn(async (req: HttpRequest): Promise<HttpResponse> => {
    calls.push(req);
    return responder(req);
  });
  return {
    transport: fn as unknown as Transport,
    calls,
    last: () => {
      const c = calls[calls.length - 1];
      if (!c) throw new Error("mock transport has not been called");
      return c;
    },
  };
}

/** A transport that always returns the same JSON body. */
export function constantJson(body: unknown, status = 200): MockTransport {
  return makeMockTransport(() => jsonResponse(body, status));
}

/** What the CLI did with one input: exit code, captured output, requests sent. */
export interface CliOutcome {
  code: number;
  out: string;
  err: string;
  requests: HttpRequest[];
}

/** What the library did with the same input: its value or error, requests sent. */
export interface LibOutcome {
  ok: boolean;
  value?: unknown;
  error?: unknown;
  requests: HttpRequest[];
}

/**
 * Send one input through the CLI (`run(argv)`, its client built on a recording mock
 * transport) and through the library (`call(transport)`, typically
 * `new PegelOnlineClient({ transport, ... }).method(...)`) on a second recorder with
 * the same responder, and return both outcomes. A synchronous throw from the library
 * call (constructor validation) is captured like a rejection. A parity test asserts
 * that both reject without a request, or both send the same requests.
 */
export async function parity(
  argv: string[],
  call: (transport: Transport) => unknown,
  responder: (req: HttpRequest) => HttpResponse | Promise<HttpResponse> = () => jsonResponse([]),
): Promise<{ cli: CliOutcome; lib: LibOutcome }> {
  const cliTransport = makeMockTransport(responder);
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, {
    io: { out: (s) => out.push(s), err: (s) => err.push(s) },
    createClient: (options) => new PegelOnlineClient({ ...options, transport: cliTransport.transport }),
  });
  const cli: CliOutcome = { code, out: out.join("\n"), err: err.join("\n"), requests: cliTransport.calls };

  const libTransport = makeMockTransport(responder);
  let lib: LibOutcome;
  try {
    const value = await call(libTransport.transport);
    lib = { ok: true, value, requests: libTransport.calls };
  } catch (error) {
    lib = { ok: false, error, requests: libTransport.calls };
  }
  return { cli, lib };
}

/**
 * A 2xx answer of the documented shape for whatever endpoint `req` asks for (the client
 * checks the shape since P9): the waters and station lists, one station, one timeseries,
 * the current measurement or a measurement window.
 */
export function validFor(req: HttpRequest): HttpResponse {
  const path = new URL(req.url).pathname.replace(/^.*\/rest-api\/v2/, "");
  if (path === "/waters.json" || path === "/stations.json" || path.endsWith("/measurements.json")) return jsonResponse([]);
  if (path.endsWith("/currentmeasurement.json")) return jsonResponse({ timestamp: "2026-10-05T17:00:00+02:00", value: 1 });
  const parts = path.split("/").filter((p) => p !== "");
  if (parts.length === 3) return jsonResponse({ shortname: decodeURIComponent(parts[2]!.replace(/\.json$/, "")), longname: "X", unit: "cm" });
  return jsonResponse({ uuid: "x", shortname: "X", longname: "X" });
}
