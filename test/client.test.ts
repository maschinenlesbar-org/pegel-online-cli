import { test } from "node:test";
import assert from "node:assert/strict";
import { PegelOnlineClient } from "../src/client/client.js";
import { PegelApiError, PegelError, PegelNetworkError } from "../src/client/errors.js";
import { makeMockTransport, jsonResponse, constantJson } from "./helpers.js";

function clientWith(mt: ReturnType<typeof makeMockTransport>): PegelOnlineClient {
  return new PegelOnlineClient({ transport: mt.transport });
}

const V2 = "/webservices/rest-api/v2";

test("stations.list hits stations.json with joined ids and includes", async () => {
  const mt = constantJson([]);
  await clientWith(mt).stations.list({
    ids: ["BONN", "KOELN"],
    waters: "RHEIN",
    includeCurrentMeasurement: true,
  });
  const url = new URL(mt.last().url);
  assert.equal(url.pathname, `${V2}/stations.json`);
  assert.equal(url.searchParams.get("ids"), "BONN,KOELN");
  assert.equal(url.searchParams.get("waters"), "RHEIN");
  assert.equal(url.searchParams.get("includeCurrentMeasurement"), "true");
});

test("stations.get builds the per-station path and url-encodes the id", async () => {
  const mt = constantJson({ uuid: "x" });
  await clientWith(mt).stations.get("ST PAULI");
  assert.equal(new URL(mt.last().url).pathname, `${V2}/stations/ST%20PAULI.json`);
});

test("timeseries.currentMeasurement defaults the timeseries to W", async () => {
  const mt = constantJson({ timestamp: "t", value: 1 });
  await clientWith(mt).timeseries.currentMeasurement("BONN");
  assert.equal(new URL(mt.last().url).pathname, `${V2}/stations/BONN/W/currentmeasurement.json`);
});

test("timeseries.measurements passes start/end", async () => {
  const mt = constantJson([]);
  await clientWith(mt).timeseries.measurements("BONN", "W", { start: "P3D" });
  const url = new URL(mt.last().url);
  assert.equal(url.pathname, `${V2}/stations/BONN/W/measurements.json`);
  assert.equal(url.searchParams.get("start"), "P3D");
});

test("stations.get sends includes and prune keeps no key when all undefined", async () => {
  const mt = constantJson({ uuid: "x" });
  await clientWith(mt).stations.get("BONN", { includeTimeseries: true });
  const url = new URL(mt.last().url);
  assert.equal(url.searchParams.get("includeTimeseries"), "true");
  assert.equal(url.searchParams.get("includeCurrentMeasurement"), null);
});

test("includeCurrentMeasurement / includeCharacteristicValues imply includeTimeseries on stations", async () => {
  const mt = constantJson([]);
  const c = clientWith(mt);
  await c.stations.list({ waters: "RHEIN", includeCurrentMeasurement: true });
  assert.equal(new URL(mt.last().url).searchParams.get("includeTimeseries"), "true");
  await c.stations.get("BONN", { includeCharacteristicValues: true });
  assert.equal(new URL(mt.last().url).searchParams.get("includeTimeseries"), "true");
  // An explicit value is kept as given.
  await c.stations.get("BONN", { includeTimeseries: false, includeCurrentMeasurement: true });
  assert.equal(new URL(mt.last().url).searchParams.get("includeTimeseries"), "false");
  // Nothing requested, nothing implied.
  await c.stations.list({ waters: "RHEIN" });
  assert.equal(new URL(mt.last().url).searchParams.has("includeTimeseries"), false);
});

test("prune keeps falsy-but-defined values (false) and drops undefined", async () => {
  const mt = constantJson([]);
  // includeCurrentMeasurement false is meaningful and must survive;
  // waters is undefined and must be dropped.
  await clientWith(mt).stations.list({
    fuzzyId: "BON",
    includeCurrentMeasurement: false,
  });
  const url = new URL(mt.last().url);
  assert.equal(url.searchParams.get("fuzzyId"), "BON");
  assert.equal(url.searchParams.get("includeCurrentMeasurement"), "false");
  assert.equal(url.searchParams.get("waters"), null);
});

test("timeseries.get builds the metadata path and url-encodes both segments", async () => {
  const mt = constantJson({ shortname: "W" });
  await clientWith(mt).timeseries.get("ST PAULI", "W X");
  assert.equal(new URL(mt.last().url).pathname, `${V2}/stations/ST%20PAULI/W%20X.json`);
});

test("waters hits waters.json", async () => {
  const mt = constantJson([]);
  await clientWith(mt).waters();
  assert.equal(new URL(mt.last().url).pathname, `${V2}/waters.json`);
});

test("a 404 raises PegelApiError with status 404", async () => {
  const mt = makeMockTransport(() => jsonResponse({}, 404));
  await assert.rejects(
    () => clientWith(mt).stations.get("nope"),
    (err) => err instanceof PegelApiError && err.status === 404,
  );
});

test("the client rejects a non-http(s) base URL before any request, even with a custom transport", () => {
  for (const baseUrl of ["file:///etc/passwd", "ftp://example.org"]) {
    const mt = makeMockTransport(() => jsonResponse([]));
    assert.throws(
      () => new PegelOnlineClient({ baseUrl, transport: mt.transport }),
      PegelNetworkError,
    );
    assert.equal(mt.calls.length, 0);
  }
});

test('library: "." / ".." ids are rejected before any request, in every method', async () => {
  const mt = constantJson({});
  const c = clientWith(mt);
  const calls: Array<[string, () => Promise<unknown>]> = [
    ["timeseries.get", () => c.timeseries.get("..", "waters")],
    ["currentMeasurement", () => c.timeseries.currentMeasurement("..", "..")],
    ["measurements", () => c.timeseries.measurements("BONN", ".")],
    ["timeseries.get .", () => c.timeseries.get("BONN", ".")],
  ];
  for (const [name, call] of calls) {
    await assert.rejects(call, (err: unknown) =>
      err instanceof PegelError && /"\." and "\.\." cannot be used as an id/.test(err.message), name);
  }
  assert.equal(mt.calls.length, 0);
});

test("library: a blank station or timeseries is rejected before any request", async () => {
  const mt = constantJson({});
  const c = clientWith(mt);
  await assert.rejects(() => c.stations.get(""), /Invalid station: expected a non-empty string, got ""\./);
  await assert.rejects(() => c.timeseries.currentMeasurement("BONN", " "), /Invalid timeseries: expected a non-empty string, got " "\./);
  await assert.rejects(() => c.timeseries.measurements("", "W"), PegelError);
  assert.equal(mt.calls.length, 0);
});

test("the Station and TimeseriesInfo types carry voiceServiceNumber and gaugeZero", async () => {
  // Trimmed from the live `stations get BONN --include-characteristic` (2026-09-26).
  const served = {
    uuid: "593647aa", number: "2710080", shortname: "BONN", longname: "BONN",
    voiceServiceNumber: "+49228 286527 566",
    timeseries: [{
      shortname: "W", longname: "WASSERSTAND ROHDATEN", unit: "cm", equidistance: 15,
      gaugeZero: { unit: "m. ü. NHN", value: 42.713, validFrom: "2019-11-01" },
      characteristicValues: [],
    }],
  };
  const station = await clientWith(constantJson(served)).stations.get("BONN", { includeCharacteristicValues: true });
  const voice: string | undefined = station.voiceServiceNumber;
  const zero: number | undefined = station.timeseries?.[0]?.gaugeZero?.value;
  assert.equal(voice, "+49228 286527 566");
  assert.equal(zero, 42.713);
});
