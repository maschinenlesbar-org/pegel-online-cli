// Conformance test P24 (trend analysis 2026-10-21): an input is canonicalised or refused, never
// sent raw. One corpus of tricky values goes through every text filter and every id the repo
// declares, on the CLI and in the library. Either both refuse it before any request (exit 2,
// the validation error), or both send the same request with the value in canonical form: a
// text without surrounding whitespace, in composed Unicode, never blank; an id as the adapter
// canonicalises it, never empty, a dot segment or with a "/". Each value here was once sent raw
// by some *-cli and matched nothing, or the wrong thing, with exit 0. Shared across the *-cli
// repos; only the adapter differs.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { HttpRequest, HttpResponse } from "@maschinenlesbar.org/pegel-online-client/internal/http";

// ---- adapter (per repo) -------------------------------------------------------------
/**
 * `parity(argv, call, responder)`: argv through run() and `call` through the library, each on a
 * recording mock transport; resolves to `{ cli: { code, out, err, requests }, lib: { ok, value?,
 * error?: { name, message }, requests } }`. Map the repo's own helper to this shape if it differs.
 * pegel's `parity` keeps the library's error as thrown; `kitParity` names it by its class.
 */
import { kitParity as parity, validFor } from "./helpers.js";
/** The exit code of a usage error in this repo (commander's default is 1; most repos use 2). */
const USAGE_EXIT = 2;
import { PegelOnlineClient as Client } from "@maschinenlesbar.org/pegel-online-client/internal/client";
interface Input {
  name: string;
  /** CLI argv that sends `value`. */
  argv: (value: string) => string[];
  /** The same in the library. */
  lib: (client: Client, value: string) => Promise<unknown>;
  /** The value as it went out, read from the request URL (null when it wasn't sent). */
  sent: (url: URL) => string | null;
}
/** Every text filter (sent as a query parameter): a water name, a fuzzy name, a station name in --ids. */
const textInputs: Input[] = [
  { name: "stations list --waters", argv: (v) => ["stations", "list", "--waters", v], lib: (c, v) => c.stations.list({ waters: v }), sent: (u) => u.searchParams.get("waters") },
  { name: "stations list --fuzzy-id", argv: (v) => ["stations", "list", "--fuzzy-id", v], lib: (c, v) => c.stations.list({ fuzzyId: v }), sent: (u) => u.searchParams.get("fuzzyId") },
  { name: "stations list --ids", argv: (v) => ["stations", "list", "--ids", v], lib: (c, v) => c.stations.list({ ids: [v] }), sent: (u) => u.searchParams.get("ids") },
];
/** The segment before the last one of the path (`…/<timeseries>/currentmeasurement.json`). */
const segmentBeforeLast = (u: URL): string => decodeURIComponent(u.pathname.split("/").slice(-2, -1)[0] ?? "");
/**
 * Every id that goes into a request path. The `[timeseries]` positional, with the station given
 * by number (a number names one station and costs no lookup). The `<station>` positional is not
 * listed: a station *name* is first checked with a lookup (stations.assertUnique, one extra
 * request), which this test's one-request shape can't hold; it goes through the same `enc()` as
 * the timeseries id, and parity.test.ts covers the two-request form.
 */
const idInputs: Input[] = [
  { name: "current <station> [timeseries]", argv: (v) => ["current", "2710080", v], lib: (c, v) => c.timeseries.currentMeasurement("2710080", v), sent: segmentBeforeLast },
  { name: "timeseries <station> [timeseries]", argv: (v) => ["timeseries", "2710080", v], lib: (c, v) => c.timeseries.get("2710080", v), sent: (u) => decodeURIComponent(u.pathname.slice(u.pathname.lastIndexOf("/") + 1)).replace(/\.json$/, "") },
  { name: "measurements <station> [timeseries]", argv: (v) => ["measurements", "2710080", v], lib: (c, v) => c.timeseries.measurements("2710080", v), sent: segmentBeforeLast },
];
/** The id as the repo sends it: trimmed and composed (normalizeInput). */
const canonicalId = (value: string): string => value.trim().normalize("NFC");
/** A valid answer to any of these requests (validFor answers each endpoint in its documented shape). */
const respond = (req: HttpRequest): HttpResponse => validFor(req);
// --------------------------------------------------------------------------------------

const TEXT_CORPUS = [
  "Müller", "Müller", "  Müller  ", " Müller ", "Müller\n", "\tMüller", "a  b", "Å",
  "ﬁ", "x".repeat(5000), "", " ", " ", "\n\t", "　",
];
const ID_CORPUS = ["a1", " a1 ", "a1\n", " a1", ".", "..", " .. ", "a1/../a2", "a1/", "/a1", "", "  ", "%2e%2e", "a b"];

type Outcome = Awaited<ReturnType<typeof parity>>;

/** Both sides refused before any request, or both sent the same requests. Returns the one sent URL, if any. */
function sameOutcome(o: Outcome, label: string): URL | undefined {
  if (o.cli.code === USAGE_EXIT) {
    assert.deepEqual(o.cli.requests, [], `${label}: the CLI refused but sent a request`);
    assert.equal(o.lib.ok, false, `${label}: the CLI refused, the library resolved`);
    assert.deepEqual(o.lib.requests, [], `${label}: the library sent a request`);
    assert.match(o.lib.error?.name ?? "", /ValidationError$/, `${label}: ${String(o.lib.error)}`);
    return undefined;
  }
  assert.equal(o.cli.code, 0, `${label}: CLI exit ${o.cli.code}: ${o.cli.err}`);
  assert.equal(o.lib.ok, true, `${label}: the library rejected: ${String(o.lib.error)}`);
  assert.deepEqual(o.lib.requests.map((r) => r.url), o.cli.requests.map((r) => r.url), `${label}: different requests`);
  assert.equal(o.cli.requests.length, 1, label);
  return new URL(o.cli.requests[0]!.url);
}

test("P24: a text filter is sent trimmed and in composed Unicode, or refused; never blank", async () => {
  for (const input of textInputs) {
    for (const value of TEXT_CORPUS) {
      const label = `${input.name} ${JSON.stringify(value.length > 20 ? `${value.slice(0, 20)}…` : value)}`;
      const url = sameOutcome(await parity(input.argv(value), (t) => input.lib(new Client({ transport: t }), value), respond), label);
      if (value.trim() === "") {
        assert.equal(url, undefined, `${label}: a blank value was sent (it reads as "no filter")`);
        continue;
      }
      if (url === undefined) continue;
      const sent = input.sent(url);
      assert.ok(sent !== null && sent !== "", `${label}: not sent`);
      const canonical = [value.trim().normalize("NFC"), value.trim().normalize("NFKC")];
      assert.ok(canonical.includes(sent), `${label}: sent ${JSON.stringify(sent)}`);
    }
  }
});

test("P24: an id is sent in its canonical form, or refused; never empty, a dot segment or with a slash", async () => {
  for (const input of idInputs) {
    for (const value of ID_CORPUS) {
      const label = `${input.name} ${JSON.stringify(value)}`;
      const url = sameOutcome(await parity(input.argv(value), (t) => input.lib(new Client({ transport: t }), value), respond), label);
      const id = canonicalId(value);
      if (id === "" || id === "." || id === ".." || id.includes("/")) {
        assert.equal(url, undefined, `${label}: sent although it would re-target the request`);
        continue;
      }
      if (url === undefined) continue;
      assert.equal(input.sent(url), id, label);
    }
  }
});
