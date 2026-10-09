import { test } from "node:test";
import assert from "node:assert/strict";
import { run } from "../src/cli/run.js";
import { PegelOnlineClient } from "../src/client/client.js";
import type { CliDeps } from "../src/cli/io.js";
import type { HttpRequest, HttpResponse } from "../src/client/http.js";
import { PegelValidationError, credentialsIn } from "../src/client/errors.js";
import { makeMockTransport, jsonResponse, untimed, validFor } from "./helpers.js";

const V2 = "/webservices/rest-api/v2";

function makeCli(responder: (req: HttpRequest) => HttpResponse) {
  const out: string[] = [];
  const err: string[] = [];
  const mt = makeMockTransport(responder);

  const deps: CliDeps = {
    io: {
      out: (s) => out.push(s),
      err: (s) => err.push(s),
    },
    createClient: (opts) => new PegelOnlineClient({ ...opts, transport: mt.transport }),
  };
  return { deps, out, err, mt };
}

test("stations list with filters builds the query", async () => {
  const cli = makeCli(() => jsonResponse([]));
  const code = await run(
    ["stations", "list", "--waters", "RHEIN", "--include-current"],
    cli.deps,
  );
  assert.equal(code, 0);
  const url = new URL(cli.mt.last().url);
  assert.equal(url.pathname, `${V2}/stations.json`);
  assert.equal(url.searchParams.get("waters"), "RHEIN");
  assert.equal(url.searchParams.get("includeCurrentMeasurement"), "true");
  // The API nests the current measurement inside the timeseries list and drops it
  // without includeTimeseries, so --include-current implies it (the README recipe).
  assert.equal(url.searchParams.get("includeTimeseries"), "true");
});

test("--include-current / --include-characteristic imply --include-timeseries on stations get", async () => {
  for (const flag of ["--include-current", "--include-characteristic", "--include-forecast"]) {
    const cli = makeCli(validFor);
    assert.equal(await run(["stations", "get", "BONN", flag], cli.deps), 0);
    assert.equal(new URL(cli.mt.last().url).searchParams.get("includeTimeseries"), "true", flag);
  }
  const plain = makeCli(validFor);
  assert.equal(await run(["stations", "get", "BONN"], plain.deps), 0);
  assert.equal(new URL(plain.mt.last().url).search, "");
});

test("stations list maps both include flags to API param names", async () => {
  const cli = makeCli(() => jsonResponse([]));
  const code = await run(
    ["stations", "list", "--include-current", "--include-characteristic", "--include-timeseries"],
    cli.deps,
  );
  assert.equal(code, 0);
  const url = new URL(cli.mt.last().url);
  assert.equal(url.searchParams.get("includeCurrentMeasurement"), "true");
  assert.equal(url.searchParams.get("includeCharacteristicValues"), "true");
  assert.equal(url.searchParams.get("includeTimeseries"), "true");
});

test("stations get exercises the per-station path with includes", async () => {
  const cli = makeCli(validFor);
  const code = await run(["stations", "get", "BONN", "--include-current"], cli.deps);
  assert.equal(code, 0);
  const url = new URL(cli.mt.last().url);
  assert.equal(url.pathname, `${V2}/stations/BONN.json`);
  assert.equal(url.searchParams.get("includeCurrentMeasurement"), "true");
});

test("timeseries command hits the timeseries metadata path", async () => {
  const cli = makeCli(validFor);
  const code = await run(["timeseries", "BONN", "W"], cli.deps);
  assert.equal(code, 0);
  assert.equal(new URL(cli.mt.last().url).pathname, `${V2}/stations/BONN/W.json`);
});

test("measurements passes --end", async () => {
  const cli = makeCli(() => jsonResponse([]));
  const code = await run(
    ["measurements", "BONN", "W", "--end", "2024-01-02T00:00:00Z"],
    cli.deps,
  );
  assert.equal(code, 0);
  assert.equal(new URL(cli.mt.last().url).searchParams.get("end"), "2024-01-02T00:00:00Z");
});

test("current defaults the timeseries to W", async () => {
  const cli = makeCli(validFor);
  await run(["current", "BONN"], cli.deps);
  assert.equal(new URL(cli.mt.last().url).pathname, `${V2}/stations/BONN/W/currentmeasurement.json`);
});

test("measurements passes --start", async () => {
  const cli = makeCli(() => jsonResponse([]));
  await run(["measurements", "BONN", "W", "--start", "P3D"], cli.deps);
  assert.equal(new URL(cli.mt.last().url).searchParams.get("start"), "P3D");
});

test("waters hits waters.json", async () => {
  const cli = makeCli(() => jsonResponse([]));
  await run(["waters"], cli.deps);
  assert.equal(new URL(cli.mt.last().url).pathname, `${V2}/waters.json`);
});

test("DEL and C1 control characters in server data are escaped in the JSON output", async () => {
  const controls = String.fromCharCode(0x7f, 0x85, 0x9b) + "2J";
  const served = { uuid: "x", shortname: "BONN", longname: `BONN${controls}`, water: { longname: String.fromCharCode(0x1b) + "[31m" } };
  for (const format of [[], ["--compact"]]) {
    const cli = makeCli(() => jsonResponse(served));
    assert.equal(await run([...format, "stations", "get", "2710080"], cli.deps), 0);
    const text = cli.out.join("\n");
    const raw = [...text].filter((c) => c.charCodeAt(0) < 0x20 ? c !== "\n" : c.charCodeAt(0) >= 0x7f && c.charCodeAt(0) <= 0x9f);
    assert.deepEqual(raw, [], format.join(" "));
    assert.match(text, /BONN\\u007f\\u0085\\u009b2J/);
    assert.deepEqual(JSON.parse(text), served);
  }
});

test("a 404 from the API maps to exit code 4", async () => {
  const cli = makeCli(() => jsonResponse({}, 404));
  const code = await run(["stations", "get", "nope"], cli.deps);
  assert.equal(code, 4);
});

test("omitted [timeseries] positional defaults to W", async () => {
  const cli = makeCli(validFor);
  const code = await run(["timeseries", "BONN"], cli.deps);
  assert.equal(code, 0);
  assert.equal(new URL(cli.mt.last().url).pathname, `${V2}/stations/BONN/W.json`);
});

// A blank filter, id, timeseries or date (often an unset shell variable) must
// never be dropped or sent empty: that would run the command unfiltered, or over
// its default window, and exit 0. Each is a usage error before any request.
const blankCases: { name: string; argv: (blank: string) => string[] }[] = [
  { name: "stations list --ids", argv: (b) => ["stations", "list", "--ids", b] },
  { name: "stations list --ids (repeated)", argv: (b) => ["stations", "list", "--ids", "BONN", "--ids", b] },
  { name: "stations list --waters", argv: (b) => ["stations", "list", "--waters", b] },
  { name: "stations list --fuzzy-id", argv: (b) => ["stations", "list", "--fuzzy-id", b] },
  { name: "timeseries [timeseries]", argv: (b) => ["timeseries", "BONN", b] },
  { name: "current [timeseries]", argv: (b) => ["current", "BONN", b] },
  { name: "measurements [timeseries]", argv: (b) => ["measurements", "BONN", b] },
  { name: "measurements --start", argv: (b) => ["measurements", "BONN", "W", "--start", b] },
  { name: "measurements --end", argv: (b) => ["measurements", "BONN", "W", "--end", b] },
];

for (const { name, argv } of blankCases) {
  for (const blank of ["", "  "]) {
    test(`blank ${name} (${JSON.stringify(blank)}) is a usage error and makes no request`, async () => {
      const cli = makeCli(() => jsonResponse([]));
      const code = await run(argv(blank), cli.deps);
      assert.notEqual(code, 0);
      assert.equal(cli.mt.calls.length, 0);
    });
  }
}

const stationCommands = [["stations", "get"], ["timeseries"], ["current"], ["measurements"]];

test("blank <station> is a usage error (exit 2) and makes no request", async () => {
  for (const cmd of stationCommands) {
    for (const blank of ["", "  "]) {
      const cli = makeCli(() => jsonResponse({}));
      const code = await run([...cmd, blank], cli.deps);
      assert.equal(code, 2, `${cmd.join(" ")} ${JSON.stringify(blank)}`);
      assert.equal(cli.mt.calls.length, 0);
      assert.match(cli.err.join("\n"), /Expected a non-empty value/);
    }
  }
});

test('"." / ".." <station> is a usage error (exit 2) before any request', async () => {
  for (const cmd of stationCommands) {
    for (const bad of [".", ".."]) {
      const cli = makeCli(() => jsonResponse({}));
      const code = await run([...cmd, bad], cli.deps);
      assert.equal(code, 2, `${cmd.join(" ")} ${bad}`);
      assert.equal(cli.mt.calls.length, 0);
      assert.match(cli.err.join("\n"), /"\." and "\.\." cannot be used as an id/);
    }
  }
});

test("--start is sent and an omitted --end is not", async () => {
  const cli = makeCli(() => jsonResponse([]));
  await run(["measurements", "BONN", "W", "--start", "P3D"], cli.deps);
  const url = new URL(cli.mt.last().url);
  assert.equal(url.searchParams.get("start"), "P3D");
  assert.equal(url.searchParams.has("end"), false);
});

test("blank / hex / scientific numeric flags are rejected with usage exit 2", async () => {
  for (const bad of ["", " ", "0x10", "1e3", "99999999999999999999"]) {
    const cli = makeCli(() => jsonResponse([]));
    const code = await run(["--timeout", bad, "waters"], cli.deps);
    assert.equal(code, 2);
    assert.equal(cli.mt.calls.length, 0);
  }
});

test("--timeout accepts up to the largest timer Node supports", async () => {
  const cli = makeCli(() => jsonResponse([]));
  assert.equal(await run(["--timeout", "2147483647", "waters"], cli.deps), 0);
  assert.equal(cli.mt.last().timeoutMs, 2_147_483_647);

  const over = makeCli(() => jsonResponse([]));
  assert.equal(await run(["--timeout", "2147483648", "waters"], over.deps), 2);
  assert.equal(over.mt.calls.length, 0);
  assert.match(over.err.join("\n"), /from 0 to 2147483647/);
});

test("a non-http(s) or malformed --base-url exits 2 at parse time (PEGEL-05)", async () => {
  for (const bad of ["file:///etc/passwd", "ftp://example.test", "not-a-url"]) {
    const cli = makeCli(() => jsonResponse([]));
    const code = await run(["--base-url", bad, "waters"], cli.deps);
    assert.equal(code, 2);
    assert.equal(cli.mt.calls.length, 0);
  }
});

test("a valid http(s) --base-url is accepted", async () => {
  const cli = makeCli(() => jsonResponse([]));
  const code = await run(["--base-url", "https://example.test", "waters"], cli.deps);
  assert.equal(code, 0);
  assert.equal(new URL(cli.mt.last().url).origin, "https://example.test");
});

test("usage/parse errors exit with code 2", async () => {
  for (const argv of [["frobnicate"], ["--nonsense", "waters"], ["timeseries"]]) {
    const cli = makeCli(() => jsonResponse([]));
    const code = await run(argv, cli.deps);
    assert.equal(code, 2);
  }
});

test("no arguments prints help to stdout and exits 0", async () => {
  const cli = makeCli(() => jsonResponse([]));
  const code = await run([], cli.deps);
  assert.equal(code, 0);
  assert.equal(cli.err.length, 0);
  assert.ok(cli.out.join("\n").includes("Usage: pegel"));
});

test("--user-agent: blank, control characters and non-Latin-1 are usage errors before any request", async () => {
  const cases: Array<[string, RegExp]> = [
    ["", /Expected a non-empty value/],
    ["  ", /Expected a non-empty value/],
    ["x\r\nX-Inject: 1", /Value contains control characters/],
    ["a\u007fb", /Value contains control characters/],
    ["Pegel\u20ac", /outside Latin-1/],
  ];
  for (const [ua, message] of cases) {
    const cli = makeCli(() => jsonResponse([]));
    const code = await run(["--user-agent", ua, "waters"], cli.deps);
    assert.equal(code, 2, JSON.stringify(ua));
    assert.equal(cli.mt.calls.length, 0);
    assert.match(cli.err.join("\n"), message);
  }
  for (const ua of ["a\tb", "M\u00fcller/1.0"]) {
    const cli = makeCli(() => jsonResponse([]));
    assert.equal(await run(["--user-agent", ua, "waters"], cli.deps), 0, JSON.stringify(ua));
    assert.equal(cli.mt.last().headers?.["User-Agent"], ua);
  }
});

test('"." / ".." [timeseries] is a usage error and makes no request', async () => {
  for (const cmd of ["timeseries", "current", "measurements"]) {
    for (const bad of [".", ".."]) {
      const cli = makeCli(() => jsonResponse({}));
      const code = await run([cmd, "BONN", bad], cli.deps);
      assert.equal(code, 2, `${cmd} ${bad}`);
      assert.equal(cli.mt.calls.length, 0);
      assert.match(cli.err.join("\n"), /"\." and "\.\." cannot be used as an id/);
    }
  }
  // Names that merely contain dots still pass.
  const ok = makeCli(validFor);
  assert.equal(await run(["current", "BONN", "..."], ok.deps), 0);
  assert.equal(new URL(ok.mt.last().url).pathname, `${V2}/stations/BONN/.../currentmeasurement.json`);
});

test("--max-retries is bounded to 0..10", async () => {
  for (const bad of ["11", "9007199254740991"]) {
    const cli = makeCli(() => jsonResponse([]));
    assert.equal(await run(["--max-retries", bad, "waters"], cli.deps), 2, bad);
    assert.equal(cli.mt.calls.length, 0);
    assert.match(cli.err.join("\n"), /from 0 to 10/);
  }
  const ok = makeCli(() => jsonResponse([]));
  assert.equal(await run(["--max-retries", "10", "waters"], ok.deps), 0);
});

test("--base-url with a query, fragment or surrounding whitespace is a usage error", async () => {
  const cases: Array<[string, RegExp]> = [
    ["http://127.0.0.1:1?x=1", /query \(\?\) or fragment \(#\)/],
    ["http://127.0.0.1:1#frag", /query \(\?\) or fragment \(#\)/],
    [" https://example.test", /surrounding whitespace/],
    ["https://example.test ", /surrounding whitespace/],
  ];
  for (const [url, message] of cases) {
    const cli = makeCli(() => jsonResponse([]));
    assert.equal(await run(["--base-url", url, "waters"], cli.deps), 2, url);
    assert.equal(cli.mt.calls.length, 0);
    assert.match(cli.err.join("\n"), message);
  }
  const prefix = makeCli(() => jsonResponse([]));
  assert.equal(await run(["--base-url", "https://mirror.test/pegel/", "waters"], prefix.deps), 0);
  assert.equal(prefix.mt.last().url, `https://mirror.test/pegel${V2}/waters.json`);
});

test("userinfo in --base-url is sent but redacted in error messages", async () => {
  const cli = makeCli(() => jsonResponse({ message: "Station not found" }, 404));
  const code = await run(["--base-url", "http://user:s3cret@127.0.0.1:1", "stations", "get", "S404"], cli.deps);
  assert.equal(code, 4);
  assert.ok(cli.mt.last().url.includes("user:s3cret@"));
  const text = cli.err.join("\n");
  assert.doesNotMatch(text, /s3cret/);
  assert.match(text, /http:\/\/\*\*\*@127\.0\.0\.1:1\/webservices/);
});

test("a deeply nested response is a clear error, not a stack overflow", async () => {
  // Deep inside a field of a well-shaped station, so the shape check (P9) passes.
  const deep = '{"uuid":"x","shortname":"X","d":' + "[".repeat(200_000) + "]".repeat(200_000) + "}";
  const respond = () => ({ status: 200, headers: { "content-type": "application/json" }, body: Buffer.from(deep) });
  const pretty = makeCli(respond);
  assert.equal(await run(["stations", "get", "2710080"], pretty.deps), 1);
  assert.deepEqual(pretty.err.map(untimed), ["ERROR [pegel.cli] The response is nested too deeply to pretty-print; try --compact."]);
  const compact = makeCli(respond);
  const code = await run(["--compact", "stations", "get", "2710080"], compact.deps);
  if (code !== 0) {
    assert.equal(code, 1);
    assert.deepEqual(compact.err.map(untimed), ["ERROR [pegel.cli] The response is nested too deeply to print."]);
  }
});

test("an NFD-typed station name is sent composed", async () => {
  const cli = makeCli(validFor);
  assert.equal(await run(["stations", "get", "KÖLN"], cli.deps), 0);
  assert.equal(new URL(cli.mt.last().url).pathname, `${V2}/stations/K%C3%96LN.json`);
});

test("a PegelValidationError raised in an action is a usage error: exit 2 and an ERROR record", async () => {
  const out: string[] = [];
  const err: string[] = [];
  const client = new PegelOnlineClient({ transport: makeMockTransport(() => jsonResponse([])).transport });
  client.waters = async () => {
    throw new PegelValidationError("Invalid waters: Expected a non-empty value.");
  };
  const code = await run(["waters"], {
    io: { out: (s) => out.push(s), err: (s) => err.push(s) },
    createClient: () => client,
  });
  assert.equal(code, 2);
  assert.deepEqual(out, []);
  assert.deepEqual(err.map(untimed), ["ERROR [pegel.cli] Invalid waters: Expected a non-empty value."]);
});

test("a shortname that names two stations is reported on stations list (02#1)", async () => {
  const two = [
    { uuid: "dda39817", number: "48800200", shortname: "NEUSTADT", longname: "NEUSTADT", water: { shortname: "LEINE", longname: "LEINE" } },
    { uuid: "3f0b6b74", number: "9610080", shortname: "NEUSTADT", longname: "NEUSTADT", water: { shortname: "OSTSEE", longname: "OSTSEE" } },
  ];
  for (const argv of [["stations", "list", "--ids", "NEUSTADT"], ["stations", "list", "--fuzzy-id", "neustadt"]]) {
    const cli = makeCli(() => jsonResponse(two));
    assert.equal(await run(argv, cli.deps), 0);
    const err = untimed(cli.err.join("\n"));
    assert.match(err, /^INFO  \[pegel\.api\] "NEUSTADT" names 2 stations: NEUSTADT on LEINE \(number 48800200, uuid dda39817\) and NEUSTADT on OSTSEE \(number 9610080, uuid 3f0b6b74\)/);
    assert.match(err, /use the number or uuid/);
  }
  // Unique names, or a listing without a name filter: no note.
  const one = makeCli(() => jsonResponse([two[0]]));
  assert.equal(await run(["stations", "list", "--ids", "NEUSTADT"], one.deps), 0);
  assert.deepEqual(one.err, []);
  const all = makeCli(() => jsonResponse(two));
  assert.equal(await run(["stations", "list"], all.deps), 0);
  assert.deepEqual(all.err, []);
});

// ---- An ambiguous station name is refused (follow-up round 2026-10-06, item 1) ----

const NEUSTADT_LEINE = { uuid: "dda39817-0000-4000-8000-000000000001", number: "48800200", shortname: "NEUSTADT", longname: "NEUSTADT", water: { shortname: "LEINE", longname: "LEINE" } };
const NEUSTADT_OSTSEE = { uuid: "3f0b6b74-0000-4000-8000-000000000002", number: "9610080", shortname: "NEUSTADT", longname: "NEUSTADT", water: { shortname: "OSTSEE", longname: "OSTSEE" } };

/** The API as far as these tests need it: `ids=NEUSTADT` lists both gauges. */
function neustadtApi(req: HttpRequest): HttpResponse {
  const url = new URL(req.url);
  if (url.pathname === `${V2}/stations.json`) {
    const id = (url.searchParams.get("ids") ?? "").toUpperCase();
    return jsonResponse(id === "NEUSTADT" ? [NEUSTADT_LEINE, NEUSTADT_OSTSEE] : id === "BONN" ? [{ uuid: "b", number: "2710080", shortname: "BONN", longname: "BONN" }] : []);
  }
  return validFor(req);
}

for (const argv of [["stations", "get", "NEUSTADT"], ["timeseries", "NEUSTADT"], ["current", "neustadt"], ["measurements", "NEUSTADT", "W", "--start", "P1D"]]) {
  test(`an ambiguous station name is refused: ${argv.join(" ")}`, async () => {
    const cli = makeCli(neustadtApi);
    assert.equal(await run(argv, cli.deps), 2);
    assert.deepEqual(cli.out, []);
    assert.equal(cli.err.length, 1, cli.err.join("\n"));
    const msg = untimed(cli.err[0]!);
    assert.match(msg, /^ERROR \[pegel\.cli\] Invalid station "(NEUSTADT|neustadt)": it names 2 stations, /);
    for (const s of [NEUSTADT_LEINE, NEUSTADT_OSTSEE]) {
      assert.ok(msg.includes(`on ${s.water.shortname} (number ${s.number}, uuid ${s.uuid})`), msg);
    }
    assert.match(msg, /use the number or uuid\.$/);
    // Only the lookup was sent; the per-station request never was.
    assert.equal(cli.mt.calls.length, 1);
    assert.equal(new URL(cli.mt.last().url).pathname, `${V2}/stations.json`);
  });
}

test("a number or uuid needs no lookup; a unique name costs one extra request", async () => {
  for (const [station, requests] of [["9610080", 1], ["3F0B6B74-0000-4000-8000-000000000002", 1], ["BONN", 2], ["NOWHERE", 2]] as const) {
    const cli = makeCli(neustadtApi);
    assert.equal(await run(["current", station], cli.deps), 0, cli.err.join("\n"));
    assert.equal(cli.mt.calls.length, requests, station);
    assert.match(new URL(cli.mt.last().url).pathname, /currentmeasurement\.json$/);
  }
});

// ---- Forecast series (follow-up round 2026-10-06, item 2) ----

test("--include-forecast asks for the forecast series on stations list and get", async () => {
  for (const argv of [["stations", "list", "--waters", "RHEIN", "--include-forecast"], ["stations", "get", "2730010", "--include-forecast"]]) {
    const cli = makeCli(validFor);
    assert.equal(await run(argv, cli.deps), 0, cli.err.join("\n"));
    const params = new URL(cli.mt.last().url).searchParams;
    assert.equal(params.get("includeForecastTimeseries"), "true", argv.join(" "));
    assert.equal(params.get("includeTimeseries"), "true", argv.join(" "));
  }
});

test("measurements of WV print the forecast points with initialized and type", async () => {
  // Trimmed from the live KÖLN (2730010) WV measurements of 2026-10-06.
  const served = [
    { initialized: "2026-10-06T07:00:00+02:00", timestamp: "2026-10-06T07:00:00+02:00", value: 50.0, type: "forecast" },
    { initialized: "2026-10-06T07:00:00+02:00", timestamp: "2026-10-10T07:00:00+02:00", value: 73, type: "estimate" },
  ];
  const cli = makeCli(() => jsonResponse(served));
  assert.equal(await run(["--compact", "measurements", "2730010", "WV"], cli.deps), 0);
  assert.equal(new URL(cli.mt.last().url).pathname, `${V2}/stations/2730010/WV/measurements.json`);
  assert.deepEqual(JSON.parse(cli.out.join("")), served);
});

test("a note quotes the value you typed at most 200 characters long (L3)", async () => {
  const cli = makeCli(() => jsonResponse([]));
  const long = "K".repeat(5000);
  assert.equal(await run(["stations", "list", "--ids", long], cli.deps), 0);
  const note = cli.err.find((line) => line.includes("matched no station")) ?? "";
  assert.match(note, /--ids "K+…" matched no station/);
  assert.ok(note.length < 500, `${note.length}`);
});

test("the ambiguous-station note and refusal quote the server's station fields clean (B01-1)", async () => {
  const forged = "LEINE\n2026-10-09T05:00:00.000Z ERROR [pegel.api] HTTP 500 forged record";
  const hostile = "NEUSTADT\u001b]0;pwned\u0007\u009b31m\u007f\u202e";
  const two = [
    { uuid: "dda39817\rall fine", number: "48800200", shortname: hostile, longname: "NEUSTADT", water: { shortname: forged, longname: "LEINE" } },
    { uuid: "3f0b6b74", number: "96\n10080", shortname: hostile, longname: "NEUSTADT", water: { shortname: "OSTSEE", longname: "OSTSEE" } },
  ];
  for (const argv of [["stations", "list", "--ids", "NEUSTADT"], ["current", "NEUSTADT"]]) {
    for (const format of ["text", "jsonl"]) {
      const cli = makeCli(() => jsonResponse(two));
      await run(["--log-format", format, ...argv], cli.deps);
      assert.equal(cli.err.length, 1, cli.err.join("\n"));
      const msg = format === "jsonl" ? (JSON.parse(cli.err[0]!) as { msg: string }).msg : untimed(cli.err[0]!);
      // Nothing for the record to escape: the library dropped it at the source.
      assert.doesNotMatch(msg, /[\u0000-\u001f\u007f-\u009f\u202e]|\\[nr]|\\u00/, msg);
      assert.ok(msg.includes("on LEINE 2026-10-09T05:00:00.000Z ERROR [pegel.api] HTTP 500 forged record (number 48800200, uuid dda39817 all fine)"), msg);
      assert.ok(msg.includes("(number 96 10080, uuid 3f0b6b74)"), msg);
    }
  }
});

test("the ambiguous-station note lists at most 10 stations and counts the rest (B01-2)", async () => {
  const many = Array.from({ length: 500 }, (_, i) => ({ uuid: `u-${i}`, number: `${i}`, shortname: "NEUSTADT", longname: "NEUSTADT", water: { shortname: "LEINE", longname: "LEINE" } }));
  const cli = makeCli(() => jsonResponse(many));
  assert.equal(await run(["stations", "list", "--fuzzy-id", "NEU"], cli.deps), 0);
  assert.equal(cli.err.length, 1, cli.err.join("\n"));
  const note = untimed(cli.err[0]!);
  assert.match(note, /^INFO  \[pegel\.api\] "NEUSTADT" names 500 stations: .*\(number 9, uuid u-9\) and … \(490 more\)\. A lookup/);
  assert.ok(note.length < 1500, `${note.length}`);
});

test("an a:b@c argument (a station id, a User-Agent) is neither a credential in the log nor rewritten in the JSON on stdout (L14)", async () => {
  const station = { uuid: "u-1", number: "1", shortname: "X", longname: "run:2026-10-09@x" };
  const ids = makeCli(() => jsonResponse([station]));
  assert.equal(await run(["stations", "list", "--ids", "run:2026-10-09@x", "--ids", "nowhere:1@y"], ids.deps), 0);
  assert.match(ids.out.join("\n"), /"longname": "run:2026-10-09@x"/);
  assert.ok(ids.err.some((line) => line.includes('--ids "nowhere:1@y" matched no station')), ids.err.join("\n"));
  const ua = makeCli(() => jsonResponse([station]));
  assert.equal(await run(["--user-agent", "run:2026-10-09@x", "stations", "list"], ua.deps), 0);
  assert.match(ua.out.join("\n"), /"longname": "run:2026-10-09@x"/);
  assert.deepEqual(credentialsIn("run:2026-10-09@x"), []);
  assert.deepEqual(credentialsIn("https://alice:pw@host"), ["alice:pw"]);
  // A base URL typed without its scheme is still read as one: its password is never echoed.
  const bare = makeCli(() => jsonResponse([]));
  assert.equal(await run(["--base-url", "alice:hunter2-pw@mirror.example", "waters"], bare.deps), 2);
  assert.ok(!bare.err.join("\n").includes("hunter2-pw"), bare.err.join("\n"));
});
