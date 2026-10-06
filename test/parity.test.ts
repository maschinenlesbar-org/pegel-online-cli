// CLI <-> library parity: the same input through run() and through the library
// call the CLI makes, on recording mock transports, must give the same outcome:
// both reject before any request, or both send the identical request.

import { test } from "node:test";
import assert from "node:assert/strict";
import { PegelOnlineClient } from "../src/client/client.js";
import { PegelNetworkError, PegelValidationError } from "../src/client/errors.js";
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
  for (const [argv, call, requests] of [
    [["--compact", "stations", "list", "--waters", "RHEIN", "--ids", "BONN", "--fuzzy-id", "KÖ"],
      (t: Transport) => client(t).stations.list({ waters: "RHEIN", ids: ["BONN"], fuzzyId: "KÖ" }), 1],
    [["--compact", "measurements", "2710080", "W", "--start", "P7D", "--end", "2026-10-01T00:00:00Z"],
      (t: Transport) => client(t).timeseries.measurements("2710080", "W", { start: "P7D", end: "2026-10-01T00:00:00Z" }), 1],
    // By name, the CLI first checks that the name names one station (assertUnique).
    [["--compact", "measurements", "BONN", "W", "--start", "P7D"],
      async (t: Transport) => {
        const c = client(t);
        await c.stations.assertUnique("BONN");
        return c.timeseries.measurements("BONN", "W", { start: "P7D" });
      }, 2],
  ] as const) {
    const { cli, lib } = await parity([...argv], call);
    assert.equal(cli.code, 0, cli.err);
    assert.equal(lib.ok, true);
    assert.deepEqual(cli.requests.map((r) => r.url), lib.requests.map((r) => r.url));
    assert.equal(cli.requests.length, requests);
  }
});

test("stations.list rejects an empty ids array instead of listing every station", async () => {
  const { lib } = await parity(["waters"], (t) => client(t).stations.list({ ids: [] }));
  assert.ok(lib.error instanceof PegelValidationError, String(lib.error));
  assert.equal((lib.error as Error).message, "Invalid ids: Expected at least one id.");
  assert.equal(lib.requests.length, 0);
});

// ---- Finding #2 (PAT-1): base URL with whitespace ----

const whitespaceBaseUrls = [
  " https://h.example",
  "https://h.example ",
  "https://h.example\n",
  "https://h.example\t",
  "\thttps://h.example/",
  "https://h.example/ ",
  "https://h.example/p\tq",
];

for (const baseUrl of whitespaceBaseUrls) {
  test(`parity: a base URL with whitespace is rejected by CLI and library alike (${JSON.stringify(baseUrl)})`, async () => {
    const { cli, lib } = await parity(["--base-url", baseUrl, "waters"], (t) =>
      new PegelOnlineClient({ baseUrl, transport: t }).waters(),
    );
    assert.equal(cli.code, 2);
    assert.equal(cli.requests.length, 0);
    assert.match(cli.err, /A base URL cannot (have surrounding whitespace|contain whitespace or control characters)\./);
    assert.ok(lib.error instanceof PegelValidationError, String(lib.error));
    assert.match((lib.error as Error).message, /^Invalid baseUrl: A base URL cannot /);
    assert.equal(lib.requests.length, 0);
  });
}

test("parity: a clean base URL with a path prefix sends the same request from CLI and library", async () => {
  const baseUrl = "https://h.example/proxy/";
  const { cli, lib } = await parity(["--compact", "--base-url", baseUrl, "waters"], (t) =>
    new PegelOnlineClient({ baseUrl, transport: t }).waters(),
  );
  assert.equal(cli.code, 0, cli.err);
  assert.equal(lib.ok, true);
  assert.deepEqual(cli.requests.map((r) => r.url), ["https://h.example/proxy/webservices/rest-api/v2/waters.json"]);
  assert.deepEqual(lib.requests.map((r) => r.url), cli.requests.map((r) => r.url));
});

// ---- Finding #4 (PAT-2): an invalid base URL is a validation error, with one rule set ----

const invalidBaseUrls: Array<[string, string]> = [
  ["ftp://x.example", "Only http and https URLs are supported."],
  ["file:///etc", "Only http and https URLs are supported."],
  ["", "Expected an absolute http(s) URL."],
  ["   ", "A base URL cannot have surrounding whitespace."],
  ["not-a-url", "Expected an absolute http(s) URL."],
  ["https://x.example/?q=1", "A base URL cannot have a query (?) or fragment (#)."],
  ["https://x.example/#f", "A base URL cannot have a query (?) or fragment (#)."],
];

for (const [baseUrl, reason] of invalidBaseUrls) {
  test(`parity: an invalid base URL gets one reason and a validation error on both sides (${JSON.stringify(baseUrl)})`, async () => {
    const { cli, lib } = await parity(["--base-url", baseUrl, "waters"], (t) =>
      new PegelOnlineClient({ baseUrl, transport: t }).waters(),
    );
    assert.equal(cli.code, 2);
    assert.equal(cli.requests.length, 0);
    assert.ok(cli.err.includes(`is invalid. ${reason}`), cli.err);
    assert.ok(lib.error instanceof PegelValidationError, String(lib.error));
    assert.ok(!(lib.error instanceof PegelNetworkError), "a config mistake is not a network error");
    assert.equal((lib.error as Error).message, `Invalid baseUrl: ${reason}`);
    assert.equal(lib.requests.length, 0);
  });
}

// ---- Finding #3 (PAT-4/PAT-5): User-Agent values ----

const badUserAgents: Array<[string, string]> = [
  ["", "Expected a non-empty value."],
  [" ", "Expected a non-empty value."],
  ["  ", "Expected a non-empty value."],
  ["\t", "Expected a non-empty value."],
  ["a\r\nb", "Value contains control characters."],
  ["a\u007fb", "Value contains control characters."],
  ["Pegel€", "Value contains characters outside Latin-1 (above U+00FF)."],
];

for (const [userAgent, reason] of badUserAgents) {
  test(`parity: a bad User-Agent is rejected by CLI and library alike (${JSON.stringify(userAgent)})`, async () => {
    const { cli, lib } = await parity(["--user-agent", userAgent, "waters"], (t) =>
      new PegelOnlineClient({ userAgent, transport: t }).waters(),
    );
    assert.equal(cli.code, 2);
    assert.equal(cli.requests.length, 0);
    assert.ok(cli.err.includes(`is invalid. ${reason}`), cli.err);
    assert.ok(lib.error instanceof PegelValidationError, String(lib.error));
    assert.equal((lib.error as Error).message, `Invalid User-Agent: ${reason}`);
    assert.equal(lib.requests.length, 0);
  });
}

test("parity: a valid User-Agent (tab and Latin-1 allowed) is sent the same by CLI and library", async () => {
  for (const userAgent of ["my-app/1.0", "a\tb", "Müller"]) {
    const { cli, lib } = await parity(["--compact", "--user-agent", userAgent, "waters"], (t) =>
      new PegelOnlineClient({ userAgent, transport: t }).waters(),
    );
    assert.equal(cli.code, 0, cli.err);
    assert.equal(lib.ok, true);
    assert.equal(cli.requests[0]?.headers?.["User-Agent"], userAgent);
    assert.equal(lib.requests[0]?.headers?.["User-Agent"], userAgent);
  }
});
