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

test("stations list forwards a valid bbox through parseBbox to the query", async () => {
  const cli = makeCli(() => jsonResponse([]));
  const code = await run(
    ["stations", "list", "--bbox", "50.5,51.0,6.5,7.5"],
    cli.deps,
  );
  assert.equal(code, 0);
  const url = new URL(cli.mt.last().url);
  assert.equal(url.searchParams.get("latbottom"), "50.5");
  assert.equal(url.searchParams.get("lattop"), "51");
  assert.equal(url.searchParams.get("longleft"), "6.5");
  assert.equal(url.searchParams.get("longright"), "7.5");
});

for (const bad of ["1,2,3", "a,b,c,d", "1,,3,4", "51,50,6,7", "1,2,7,6", "100,2,3,4"]) {
  test(`stations list rejects a malformed bbox (${bad}) before any request`, async () => {
    const cli = makeCli(() => jsonResponse([]));
    const code = await run(["stations", "list", "--bbox", bad], cli.deps);
    assert.notEqual(code, 0);
    assert.equal(cli.mt.calls.length, 0);
  });
}

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

test("characteristic command hits the characteristicvalues path", async () => {
  const cli = makeCli(() => jsonResponse([]));
  const code = await run(["characteristic", "BONN"], cli.deps);
  assert.equal(code, 0);
  assert.equal(
    new URL(cli.mt.last().url).pathname,
    `${V2}/stations/BONN/W/characteristicvalues.json`,
  );
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
