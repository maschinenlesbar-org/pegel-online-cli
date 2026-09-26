import { test } from "node:test";
import assert from "node:assert/strict";
import { run } from "../src/cli/run.js";
import { PegelOnlineClient } from "../src/client/client.js";
import type { CliDeps } from "../src/cli/io.js";
import type { HttpRequest, HttpResponse } from "../src/client/http.js";
import { makeMockTransport, jsonResponse } from "./helpers.js";

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
  for (const flag of ["--include-current", "--include-characteristic"]) {
    const cli = makeCli(() => jsonResponse({ uuid: "x" }));
    assert.equal(await run(["stations", "get", "BONN", flag], cli.deps), 0);
    assert.equal(new URL(cli.mt.last().url).searchParams.get("includeTimeseries"), "true", flag);
  }
  const plain = makeCli(() => jsonResponse({ uuid: "x" }));
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
  const cli = makeCli(() => jsonResponse({ uuid: "x" }));
  const code = await run(["stations", "get", "BONN", "--include-current"], cli.deps);
  assert.equal(code, 0);
  const url = new URL(cli.mt.last().url);
  assert.equal(url.pathname, `${V2}/stations/BONN.json`);
  assert.equal(url.searchParams.get("includeCurrentMeasurement"), "true");
});

test("timeseries command hits the timeseries metadata path", async () => {
  const cli = makeCli(() => jsonResponse({ shortname: "W" }));
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
  const cli = makeCli(() => jsonResponse({ timestamp: "t", value: 1 }));
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
  const served = { uuid: "x", longname: `BONN${controls}`, water: { longname: String.fromCharCode(0x1b) + "[31m" } };
  for (const format of [[], ["--compact"]]) {
    const cli = makeCli(() => jsonResponse(served));
    assert.equal(await run([...format, "stations", "get", "BONN"], cli.deps), 0);
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
  const cli = makeCli(() => jsonResponse({ shortname: "W" }));
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
  const ok = makeCli(() => jsonResponse({}));
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
