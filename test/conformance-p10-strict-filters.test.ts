// Conformance test P10 (fix plan 2026-10-06): a filter the API would ignore never turns into
// the whole, unfiltered set with exit 0. Unknown, misspelled and prototype keys and
// wrong-typed values are the library's validation error before any request; a repeated
// single-value flag is a usage error; a filter value that matched nothing is reported.
// The pilot (marktstammdatenregister-cli) wasn't written when pegel-online-cli got this, so
// the cases follow the pattern design; only the adapter block differs per repo.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { CliDeps } from "../src/cli/io.js";
import type { HttpRequest, HttpResponse } from "../src/client/http.js";

// ---- adapter (per repo) -------------------------------------------------------------
import { run } from "../src/cli/run.js";
import { PegelOnlineClient as Client } from "../src/client/client.js";
import { PegelValidationError as ValidationError } from "../src/client/errors.js";
type Params = Record<string, unknown>;
/** The filtered library call. */
const listCall = (client: Client, params: Params): Promise<unknown> =>
  client.stations.list(params as Parameters<Client["stations"]["list"]>[0]);
/** A valid filter, and parameter objects that must be rejected before any request. */
const validParams: Params = { waters: "RHEIN" };
const badParams: Array<[string, Params]> = [
  ["unknown key", { water: "RHEIN" }],
  ["misspelled key", { fuzzyID: "bonn" }],
  ["__proto__", JSON.parse('{"__proto__": {"waters": "RHEIN"}}') as Params],
  ["constructor", JSON.parse('{"constructor": "x"}') as Params],
  ["array where one value belongs", { waters: ["RHEIN", "ELBE"] }],
  ["NaN", { waters: Number.NaN }],
  ["object", { fuzzyId: { a: 1 } }],
  ["non-boolean flag", { includeTimeseries: "yes" }],
  ["ids not an array", { ids: "BONN" }],
];
/** CLI argv with a single-value flag given twice. */
const repeatedFlags: string[][] = [
  ["stations", "list", "--waters", "ELBE", "--waters", "RHEIN"],
  ["stations", "list", "--fuzzy-id", "a", "--fuzzy-id", "b"],
  ["measurements", "BONN", "--start", "P7D", "--start", "P1D"],
  ["--timeout", "1000", "--timeout", "2000", "waters"],
];
const USAGE_EXIT = 2;
/** A filter value the server matches nothing for, the answer it gives, and what stderr must name. */
const unmatched: Array<{ argv: string[]; answer: unknown; names: RegExp }> = [
  {
    argv: ["stations", "list", "--ids", "BONN", "--ids", "KOELN"],
    answer: [{ uuid: "u1", number: "1", shortname: "BONN", longname: "BONN" }],
    names: /--ids "KOELN" matched no station/,
  },
  { argv: ["stations", "list", "--waters", "Rhine"], answer: [], names: /--waters "Rhine" matched no station/ },
  { argv: ["stations", "list", "--fuzzy-id", "koeln"], answer: [], names: /--fuzzy-id "koeln" matched no station/ },
];
// --------------------------------------------------------------------------------------

function recorder(answer: unknown = []) {
  const calls: HttpRequest[] = [];
  const transport = async (req: HttpRequest): Promise<HttpResponse> => {
    calls.push(req);
    return { status: 200, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify(answer)) };
  };
  return { calls, transport };
}

function cli(answer: unknown = []) {
  const out: string[] = [];
  const err: string[] = [];
  const r = recorder(answer);
  const deps: CliDeps = {
    io: { out: (s) => out.push(s), err: (s) => err.push(s) },
    createClient: (opts) => new Client({ ...opts, transport: r.transport }),
  };
  return { deps, out, err, calls: r.calls };
}

test("P10: unknown keys and wrong-typed values are rejected before any request", async () => {
  const ok = recorder();
  await listCall(new Client({ transport: ok.transport }), validParams);
  assert.equal(ok.calls.length, 1);
  for (const [label, params] of badParams) {
    const r = recorder();
    await assert.rejects(listCall(new Client({ transport: r.transport }), params), ValidationError, label);
    assert.equal(r.calls.length, 0, label);
  }
});

test("P10: a repeated single-value flag is a usage error", async () => {
  for (const argv of repeatedFlags) {
    const c = cli();
    assert.equal(await run(argv, c.deps), USAGE_EXIT, argv.join(" "));
    assert.equal(c.calls.length, 0, argv.join(" "));
    assert.match(c.err.join("\n"), /may be given only once/);
  }
});

test("P10: a filter value that matched nothing is reported on stderr", async () => {
  for (const { argv, answer, names } of unmatched) {
    const c = cli(answer);
    assert.equal(await run(argv, c.deps), 0, argv.join(" "));
    assert.match(c.err.join("\n"), names, argv.join(" "));
  }
  // Every value matched: nothing on stderr.
  const c = cli([{ uuid: "u1", number: "1", shortname: "BONN", longname: "BONN" }]);
  assert.equal(await run(["stations", "list", "--ids", "bonn"], c.deps), 0);
  assert.deepEqual(c.err, []);
});
