// This server's tools against a mock of PEGELONLINE (the client's recorded answers), with the
// skills' traps as cases: each tool answers through the protocol (its structuredContent checked by
// the SDK against its output schema), the unit comes from the series, a gauge fault and an
// out-dated reading are never normal, a name several gauges carry is reported and never guessed, a
// river is in flow order, a page says where the next one starts, and every result carries the
// source of its request and the licence. The rules every server follows are the conformance tests
// (M1–M10).

import { test } from "node:test";
import assert from "node:assert/strict";
import { listTools } from "../src/mcp/server.js";
import { connect } from "./harness.js";
import { pegelApi, stamp } from "./helpers.js";

/** The mock, its readings timed against the real clock (the tools read it). */
const api = () => pegelApi({ now: new Date() });

test("eight tools: the four use cases first, then the generic ones", () => {
  assert.deepEqual(listTools().map((t) => t.name), ["getWaterLevels", "getLevelTrend", "getRiverOverview", "getStationsMap", "listWaters", "listStations", "getStation", "getMeasurements"]);
});

test("getWaterLevels: unit and verdict per gauge, high first; one request; the source is that request; the licence is DL-DE Zero", async () => {
  const upstream = api();
  const connection = await connect({ transport: upstream });
  const result = await connection.call("getWaterLevels", { stations: ["BONN", "EMMERICH", "MÜNSTER OW"] });
  const content = result.structuredContent ?? {};
  assert.equal(content["status"], "ok", result.content[0]?.text);
  const readings = content["readings"] as { station: { shortname: string }; reading: { verdict: string; unit: string } }[];
  assert.deepEqual(readings.map((r) => [r.station.shortname, r.reading.verdict, r.reading.unit]), [
    ["EMMERICH", "high", "cm"],
    ["BONN", "normal", "cm"],
    ["MÜNSTER OW", "no-reference", "m+NN"],
  ]);
  assert.equal(upstream.calls.length, 1);
  assert.match(String(content["source"]), /\/webservices\/rest-api\/v2\/stations\.json\?ids=BONN,EMMERICH,M%C3%9CNSTER\+OW&includeTimeseries=true&includeCurrentMeasurement=true$/);
  assert.match(String(content["licence"]), /Datenlizenz Deutschland – Zero – Version 2\.0/);
  await connection.close();
});

test("getWaterLevels: a gauge fault says its comment; a shared name is ambiguous with the gauges, never picked", async () => {
  const connection = await connect({ transport: api() });
  const fault = (await connection.call("getWaterLevels", { stations: ["RINTELN"] })).structuredContent ?? {};
  assert.match(String(fault["verdict"]), /RINTELN: gauge fault: Funktionsstörung, fehlerhafte Messwerte/);
  const two = (await connection.call("getWaterLevels", { stations: ["NEUSTADT"] })).structuredContent ?? {};
  assert.equal(two["status"], "ambiguous");
  assert.deepEqual((two["ambiguous"] as { candidates: { number: string }[] }[])[0]?.candidates.map((c) => c.number), ["48800200", "9610080"]);
  const none = (await connection.call("getWaterLevels", { stations: ["Cologne"] })).structuredContent ?? {};
  assert.equal(none["status"], "empty");
  assert.match(String(none["reason"]), /KÖLN, not Cologne/);
  await connection.close();
});

test("getLevelTrend: direction and delta, the source is the measurements of the gauge's uuid; a bad period is a tool error from the API", async () => {
  const connection = await connect({ transport: api() });
  const result = await connection.call("getLevelTrend", { station: "BONN", start: "P3D", points: 3 });
  const content = result.structuredContent ?? {};
  assert.equal(content["status"], "ok", result.content[0]?.text);
  assert.deepEqual([content["direction"], content["delta"]], ["falling", -14]);
  assert.equal((content["sample"] as unknown[]).length, 3);
  assert.match(String(content["source"]), /\/stations\/593647aa-9fea-43ec-a7d6-6476a76ae868\/W\/measurements\.json\?start=P3D$/);
  const bad = await connection.call("getLevelTrend", { station: "BONN", start: "7d" });
  assert.equal(bad.isError, true);
  assert.match(bad.content[0]?.text ?? "", /HTTP 400 .*neither a valid ISO date time, nor an ISO period/);
  await connection.close();
});

test("getRiverOverview: the Danube source to mouth (its km count down), paged; the source names the resolved water", async () => {
  const connection = await connect({ transport: api() });
  const first = (await connection.call("getRiverOverview", { water: "Danube", limit: 2 })).structuredContent ?? {};
  assert.equal(first["status"], "ok");
  assert.deepEqual((first["gauges"] as { km: number }[]).map((g) => g.km), [2458.3, 2226.7]);
  assert.deepEqual([first["total"], first["nextOffset"]], [4, 2]);
  assert.match(String(first["source"]), /\/stations\.json\?waters=DONAU&includeTimeseries=true&includeCurrentMeasurement=true$/);
  assert.match(String(first["order"]), /count down towards the mouth/);
  const ambiguous = (await connection.call("getRiverOverview", { water: "kanal" })).structuredContent ?? {};
  assert.equal(ambiguous["status"], "ambiguous");
  await connection.close();
});

test("getStationsMap: a FeatureCollection with levels; gauges without coordinates left off; features paged", async () => {
  const connection = await connect({ transport: api() });
  const map = (await connection.call("getStationsMap", { water: "DONAU", levels: true })).structuredContent ?? {};
  assert.equal(map["type"], "FeatureCollection");
  assert.equal((map["features"] as unknown[]).length, 2);
  assert.deepEqual((map["leftOff"] as { shortname: string }[]).map((l) => l.shortname), ["WILDUNGSMAUER", "THEBNERSTRASSL"]);
  assert.match(String(map["source"]), /stations\.json\?waters=DONAU&includeTimeseries=true&includeCurrentMeasurement=true$/);
  const paged = (await connection.call("getStationsMap", { limit: 5 })).structuredContent ?? {};
  assert.deepEqual([(paged["features"] as unknown[]).length, paged["nextOffset"]], [5, 5]);
  const both = await connection.call("getStationsMap", { water: "RHEIN", name: "BONN" });
  assert.equal(both.isError, true);
  assert.match(both.content[0]?.text ?? "", /give one of water, stations or name/);
  await connection.close();
});

test("listWaters, listStations, getStation and getMeasurements: lists, the marks verbatim, raw points with nulls", async () => {
  const connection = await connect({ transport: api() });
  const canals = (await connection.call("listWaters", { name: "kanal" })).structuredContent ?? {};
  assert.equal(canals["total"], 4);
  const neustadt = (await connection.call("listStations", { name: "NEUSTADT" })).structuredContent ?? {};
  assert.match(String((neustadt["notes"] as string[]).join(" ")), /NEUSTADT/);
  const koeln = (await connection.call("getStation", { station: "KÖLN", marks: true })).structuredContent ?? {};
  const w = (koeln["series"] as { shortname: string; marks?: { shortname: string }[] }[]).find((s) => s.shortname === "W");
  assert.deepEqual(w?.marks?.map((m) => m.shortname), ["MNW", "HHW"]);
  assert.match(String(koeln["source"]), /\/stations\/a6ee8177-107b-47dd-bcfd-30960ccc6e9c\.json\?includeTimeseries=true&includeCurrentMeasurement=true&includeCharacteristicValues=true$/);
  const points = (await connection.call("getMeasurements", { station: "BONN", start: "P3D", offset: 5, limit: 10 })).structuredContent ?? {};
  assert.deepEqual([points["total"], points["missing"], points["nextOffset"], (points["measurements"] as { value: number | null }[])[5]?.value], [73, 1, 15, null]);
  await connection.close();
});

test("getLevelTrend after a crest answers peaked, with the fall since the peak, through the protocol", async () => {
  const now = new Date();
  const at = (h: number) => (h <= 120 ? 100 + (300 * h) / 120 : 400 - (100 * (h - 120)) / 48);
  const crest = Array.from({ length: 169 }, (_, i) => ({ timestamp: stamp(now, (168 - i) * 60), value: Math.round(at(i)) }));
  const connection = await connect({ transport: pegelApi({ now, measurements: { "593647aa-9fea-43ec-a7d6-6476a76ae868/W": crest } }) });
  const result = await connection.call("getLevelTrend", { station: "BONN" });
  const content = result.structuredContent ?? {};
  assert.equal(content["direction"], "peaked", result.content[0]?.text);
  assert.equal((content["since"] as { delta: number }).delta, -100);
  await connection.close();
});

test("getMeasurements pages through a week of a one-minute gauge to its end; the description says such gauges exist", async () => {
  const now = new Date();
  const minutes = Array.from({ length: 7 * 1440 + 1 }, (_, i) => ({ timestamp: stamp(now, 7 * 1440 - i), value: 500 + (i % 7) }));
  const connection = await connect({ transport: pegelApi({ now, measurements: { "593647aa-9fea-43ec-a7d6-6476a76ae868/W": minutes } }) });
  const late = await connection.call("getMeasurements", { station: "BONN", start: "P7D", offset: 5340, limit: 100 });
  assert.notEqual(late.isError, true, late.content[0]?.text);
  assert.deepEqual([late.structuredContent?.["total"], late.structuredContent?.["nextOffset"]], [10081, 5440]);
  const last = await connection.call("getMeasurements", { station: "BONN", start: "P7D", offset: 10000, limit: 100 });
  assert.equal((last.structuredContent?.["measurements"] as unknown[]).length, 81);
  await connection.close();
  const description = listTools().find((t) => t.name === "getMeasurements")?.description ?? "";
  assert.match(description, /1440 a day at one-minute gauges/);
});

test("a station id with a comma is refused with what this server takes for several gauges, not a CLI command", async () => {
  const connection = await connect({ transport: pegelApi() });
  for (const [tool, args] of [["getStation", { station: "BONN,KÖLN" }], ["listStations", { stations: ["NEUSTADT,"] }], ["getWaterLevels", { stations: ["BONN,KÖLN"] }]] as const) {
    const text = (await connection.call(tool, args)).content[0]?.text ?? "";
    assert.match(text, /cannot contain ","/, tool);
    assert.match(text, /several gauges as separate names in a list/, tool);
    assert.doesNotMatch(text, /--ids/, tool);
  }
  await connection.close();
});

test("a stations list too long for one request is refused with the reason; a name over 40 characters by the schema", async () => {
  const upstream = pegelApi();
  const connection = await connect({ transport: upstream });
  const long = await connection.call("listStations", { stations: Array.from({ length: 50 }, (_, i) => `${"Ä".repeat(38)}${i}`) });
  assert.equal(long.isError, true);
  assert.match(long.content[0]?.text ?? "", /characters in the request \(at most 4000\)/);
  const over = await connection.call("getStationsMap", { stations: ["X".repeat(41)] });
  assert.equal(over.isError, true);
  assert.equal(upstream.calls.length, 0);
  await connection.close();
});
