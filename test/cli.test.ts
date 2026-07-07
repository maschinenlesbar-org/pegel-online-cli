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

test("a 404 from the API maps to exit code 4", async () => {
  const cli = makeCli(() => jsonResponse({}, 404));
  const code = await run(["stations", "get", "nope"], cli.deps);
  assert.equal(code, 4);
});

test("empty [timeseries] positional defaults to W", async () => {
  const cli = makeCli(() => jsonResponse({ shortname: "W" }));
  const code = await run(["timeseries", "BONN", ""], cli.deps);
  assert.equal(code, 0);
  assert.equal(new URL(cli.mt.last().url).pathname, `${V2}/stations/BONN/W.json`);
});

test("empty <station> is a usage-style error and makes no request", async () => {
  const cli = makeCli(() => jsonResponse({}));
  const code = await run(["current", ""], cli.deps);
  assert.notEqual(code, 0);
  assert.equal(cli.mt.calls.length, 0);
});

test('"." / ".." station is rejected before any request', async () => {
  for (const bad of [".", ".."]) {
    const cli = makeCli(() => jsonResponse({}));
    const code = await run(["current", bad], cli.deps);
    assert.notEqual(code, 0);
    assert.equal(cli.mt.calls.length, 0);
  }
});

test("empty --start / --end are omitted, not sent blank", async () => {
  const cli = makeCli(() => jsonResponse([]));
  await run(["measurements", "BONN", "W", "--start", "P3D", "--end", ""], cli.deps);
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

test("a control character in --user-agent is a typed error, not 'Unexpected error'", async () => {
  const cli = makeCli(() => jsonResponse([]));
  const code = await run(["--user-agent", "x\r\nX-Inject: 1", "waters"], cli.deps);
  assert.equal(code, 1);
  assert.ok(cli.err.join("\n").startsWith("Error:"));
});
