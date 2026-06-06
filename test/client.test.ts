import { test } from "node:test";
import assert from "node:assert/strict";
import { PegelOnlineClient } from "../src/client/client.js";
import { PegelApiError } from "../src/client/errors.js";
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

test("stations.list sends a bounding box", async () => {
  const mt = constantJson([]);
  await clientWith(mt).stations.list({ latbottom: 50, lattop: 51, longleft: 6, longright: 7 });
  const url = new URL(mt.last().url);
  assert.equal(url.searchParams.get("latbottom"), "50");
  assert.equal(url.searchParams.get("longright"), "7");
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

test("prune keeps falsy-but-defined values (0 / false) and drops undefined", async () => {
  const mt = constantJson([]);
  // longleft 0 and includeCurrentMeasurement false are meaningful and must survive;
  // longname is undefined and must be dropped.
  await clientWith(mt).stations.list({
    latbottom: 0,
    lattop: 1,
    longleft: 0,
    longright: 0,
    includeCurrentMeasurement: false,
  });
  const url = new URL(mt.last().url);
  assert.equal(url.searchParams.get("latbottom"), "0");
  assert.equal(url.searchParams.get("longleft"), "0");
  assert.equal(url.searchParams.get("includeCurrentMeasurement"), "false");
  assert.equal(url.searchParams.get("longname"), null);
});

test("timeseries.get builds the metadata path and url-encodes both segments", async () => {
  const mt = constantJson({ shortname: "W" });
  await clientWith(mt).timeseries.get("ST PAULI", "W X");
  assert.equal(new URL(mt.last().url).pathname, `${V2}/stations/ST%20PAULI/W%20X.json`);
});

test("timeseries.characteristicValues builds the characteristicvalues path", async () => {
  const mt = constantJson([]);
  await clientWith(mt).timeseries.characteristicValues("BONN", "W");
  assert.equal(
    new URL(mt.last().url).pathname,
    `${V2}/stations/BONN/W/characteristicvalues.json`,
  );
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
