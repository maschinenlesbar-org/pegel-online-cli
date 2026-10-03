// CLI <-> library parity: the same input through run() and through the library
// call the CLI makes, on recording mock transports, must give the same outcome:
// both reject before any request, or both send the identical request.

import { test } from "node:test";
import assert from "node:assert/strict";
import { PegelOnlineClient } from "../src/client/client.js";
import { PegelValidationError } from "../src/client/errors.js";
import type { Transport } from "../src/client/http.js";
import { parity } from "./helpers.js";

const client = (transport: Transport) => new PegelOnlineClient({ transport });

/** Both sides reject the input with a usage error and neither sends a request. */
async function assertBothReject(
  argv: string[],
  call: (transport: Transport) => unknown,
  message: RegExp,
): Promise<void> {
  const { cli, lib } = await parity(argv, call);
  const label = JSON.stringify(argv);
  assert.equal(cli.code, 2, `${label}: CLI exit code`);
  assert.equal(cli.requests.length, 0, `${label}: CLI sent a request`);
  assert.equal(lib.ok, false, `${label}: library accepted the input`);
  assert.ok(lib.error instanceof PegelValidationError, `${label}: ${String(lib.error)}`);
  assert.match((lib.error as Error).message, message, label);
  assert.equal(lib.requests.length, 0, `${label}: library sent a request`);
}

// ---- Finding #1 (PAT-9): blank query filters ----

const blankFilterCases: Array<[string[], (t: Transport) => unknown, RegExp]> = [
  [["stations", "list", "--waters", ""], (t) => client(t).stations.list({ waters: "" }), /^Invalid waters: Expected a non-empty value\.$/],
  [["stations", "list", "--waters", "  "], (t) => client(t).stations.list({ waters: "  " }), /^Invalid waters: /],
  [["stations", "list", "--fuzzy-id", ""], (t) => client(t).stations.list({ fuzzyId: "" }), /^Invalid fuzzyId: /],
  [["stations", "list", "--fuzzy-id", " "], (t) => client(t).stations.list({ fuzzyId: " " }), /^Invalid fuzzyId: /],
  [["stations", "list", "--ids", ""], (t) => client(t).stations.list({ ids: [""] }), /^Invalid ids: /],
  [["stations", "list", "--ids", "BONN", "--ids", " "], (t) => client(t).stations.list({ ids: ["BONN", " "] }), /^Invalid ids: /],
  [["measurements", "BONN", "W", "--start", ""], (t) => client(t).timeseries.measurements("BONN", "W", { start: "" }), /^Invalid start: /],
  [["measurements", "BONN", "W", "--end", " "], (t) => client(t).timeseries.measurements("BONN", "W", { end: " " }), /^Invalid end: /],
];

for (const [argv, call, message] of blankFilterCases) {
  test(`parity: a blank filter is rejected by CLI and library alike (${JSON.stringify(argv)})`, async () => {
    await assertBothReject(argv, call, message);
  });
}

test("parity: real filter values send the same request from CLI and library", async () => {
  for (const [argv, call] of [
    [["--compact", "stations", "list", "--waters", "RHEIN", "--ids", "BONN", "--fuzzy-id", "KÖ"],
      (t: Transport) => client(t).stations.list({ waters: "RHEIN", ids: ["BONN"], fuzzyId: "KÖ" })],
    [["--compact", "measurements", "BONN", "W", "--start", "P7D", "--end", "2026-10-01T00:00:00Z"],
      (t: Transport) => client(t).timeseries.measurements("BONN", "W", { start: "P7D", end: "2026-10-01T00:00:00Z" })],
  ] as const) {
    const { cli, lib } = await parity([...argv], call);
    assert.equal(cli.code, 0, cli.err);
    assert.equal(lib.ok, true);
    assert.deepEqual(cli.requests.map((r) => r.url), lib.requests.map((r) => r.url));
    assert.equal(cli.requests.length, 1);
  }
});

test("stations.list rejects an empty ids array instead of listing every station", async () => {
  const { lib } = await parity(["waters"], (t) => client(t).stations.list({ ids: [] }));
  assert.ok(lib.error instanceof PegelValidationError, String(lib.error));
  assert.equal((lib.error as Error).message, "Invalid ids: Expected at least one id.");
  assert.equal(lib.requests.length, 0);
});
