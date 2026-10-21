// Test helpers of the CLI: the log helpers and the CLI <-> library parity harness. The
// transport helpers (canned responses, the recording mock transport) live with the client,
// in packages/client/test/helpers.ts, and are re-exported here so every CLI test imports its
// helpers from one place.

import type { Transport, HttpRequest, HttpResponse } from "@maschinenlesbar.org/pegel-online-client/internal/http";
import { PegelOnlineClient } from "@maschinenlesbar.org/pegel-online-client/internal/client";
import { run } from "../src/cli/run.js";
import { jsonResponse, makeMockTransport } from "@maschinenlesbar.org/pegel-online-client/test/helpers";

export * from "@maschinenlesbar.org/pegel-online-client/test/helpers";

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

// ---- the log on stderr -------------------------------------------------------

/**
 * stderr with each text record's timestamp taken off: `ERROR [pegel.api] HTTP 404 …`.
 * The format itself — timestamp, level, topic — is the conformance test's
 * (conformance-p23-log-format); the other tests check what was said, at which level
 * and under which topic.
 */
export function untimed(text: string): string {
  return text.replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /gm, "");
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
  const cli: CliOutcome = { code, out: out.join("\n"), err: untimed(err.join("\n")), requests: cliTransport.calls };

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

/** What the library did, in the shape the kit's conformance tests (P24, P25) read: the error by name. */
export interface KitLibOutcome {
  ok: boolean;
  value?: unknown;
  error?: { name: string; message: string };
  requests: HttpRequest[];
}

/** {@link parity} with the library's error reduced to its class name and message, as P24 and P25 read it. */
export async function kitParity(
  argv: string[],
  call: (transport: Transport) => unknown,
  responder?: (req: HttpRequest) => HttpResponse | Promise<HttpResponse>,
): Promise<{ cli: CliOutcome; lib: KitLibOutcome }> {
  const r = await parity(argv, call, responder);
  if (r.lib.ok) return { cli: r.cli, lib: { ok: true, value: r.lib.value, requests: r.lib.requests } };
  const e = r.lib.error;
  const error = e instanceof Error ? { name: e.constructor.name, message: e.message } : { name: typeof e, message: String(e) };
  return { cli: r.cli, lib: { ok: false, error, requests: r.lib.requests } };
}
