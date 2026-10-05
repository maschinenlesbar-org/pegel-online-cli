// Conformance test P8 + P9 + P13 (fix plan 2026-10-06): a body is decoded by its declared
// charset (P8); a 2xx body without the documented shape is a parse error, never data or
// "nothing found" (P9); every rejected input is the library's validation error, never a raw
// TypeError or RangeError (P13). Shared across the *-cli repos; only the adapter differs.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { HttpResponse } from "../src/client/http.js";

// ---- adapter (per repo) -------------------------------------------------------------
import { PegelOnlineClient as Client } from "../src/client/client.js";
import {
  PegelError as BaseError,
  PegelParseError as ParseError,
  PegelValidationError as ValidationError,
} from "../src/client/errors.js";
/** A call whose answer contains a text field, and how to read that field from the result. */
const textCall = (client: Client): Promise<unknown> => client.waters();
const textBody = (text: string): unknown => [{ shortname: text, longname: text }];
const readText = (result: unknown): string => (result as Array<{ shortname: string }>)[0]!.shortname;
/** 2xx bodies the call must reject (error envelopes, empty or wrong shapes). */
const malformedBodies: unknown[] = [null, {}, "text", 42, { error: "boom" }, [null], [{ shortname: 5 }], { waters: [] }];
/** Library calls with wrong-typed or out-of-range input. */
const badCalls: Array<[string, () => unknown]> = [
  ["stations.get(5)", () => new Client().stations.get(5 as unknown as string)],
  ["stations.get(null)", () => new Client().stations.get(null as unknown as string)],
  ["timeseries.currentMeasurement({})", () => new Client().timeseries.currentMeasurement({} as unknown as string)],
  ["timeseries.get('BONN', '..')", () => new Client().timeseries.get("BONN", "..")],
  ["stations.list({ waters: 5 })", () => new Client().stations.list({ waters: 5 as unknown as string })],
  ["stations.list({ ids: 'BONN' })", () => new Client().stations.list({ ids: "BONN" as unknown as string[] })],
  ["measurements start: 5", () => new Client().timeseries.measurements("BONN", "W", { start: 5 as unknown as string })],
  ["timeoutMs: 'x'", () => new Client({ timeoutMs: "x" as unknown as number })],
  ["timeoutMs: -1", () => new Client({ timeoutMs: -1 })],
  ["maxRetries: 1.5", () => new Client({ maxRetries: 1.5 })],
  ["baseUrl: 5", () => new Client({ baseUrl: 5 as unknown as string })],
  ["userAgent: {}", () => new Client({ userAgent: {} as unknown as string })],
  ["transport: 'x'", () => new Client({ transport: "x" as unknown as never })],
  ["sleep: 5", () => new Client({ sleep: 5 as unknown as never })],
  ["headers: []", () => new Client({ headers: [] as unknown as Record<string, string> })],
  ["headers: { X: 5 }", () => new Client({ headers: { X: 5 } as unknown as Record<string, string> })],
];
// --------------------------------------------------------------------------------------

const respond = (body: Buffer, contentType: string) => async (): Promise<HttpResponse> => ({
  status: 200,
  headers: { "content-type": contentType },
  body,
});

test("P8: a body is decoded by its declared charset", async () => {
  const text = "Müller µg/l";
  for (const [charset, encoding] of [["iso-8859-1", "latin1"], ["utf-8", "utf8"]] as const) {
    const body = Buffer.from(JSON.stringify(textBody(text)), encoding);
    const client = new Client({ transport: respond(body, `application/json; charset=${charset}`) });
    assert.equal(readText(await textCall(client)), text, charset);
  }
});

test("P9: a 2xx body without the documented shape is a parse error", async () => {
  for (const body of malformedBodies) {
    const client = new Client({ transport: respond(Buffer.from(JSON.stringify(body)), "application/json"), maxRetries: 0 });
    await assert.rejects(textCall(client), ParseError, `body ${JSON.stringify(body)}`);
  }
  for (const raw of ["", "<html>maintenance</html>"]) {
    const client = new Client({ transport: respond(Buffer.from(raw), "text/html"), maxRetries: 0 });
    await assert.rejects(textCall(client), BaseError, `raw ${JSON.stringify(raw)}`);
  }
});

test("P13: every rejected input is the validation error, never a raw TypeError", async () => {
  for (const [label, fn] of badCalls) {
    await assert.rejects(async () => fn(), (e: unknown) => e instanceof ValidationError, label);
  }
});
