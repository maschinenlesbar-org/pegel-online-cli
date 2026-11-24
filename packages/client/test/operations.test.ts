// The skills' use cases as library functions, against a mock of PEGELONLINE shaped like its live
// answers (fixtures.ts), with the traps the skills document as cases: the unit comes from the
// series (m+NN on canals), `commented` is a gauge fault and `out-dated` no current reading, neither
// normal; `unknown` is no flood reference; a reading hours old is stale; the 99999 placeholder is no
// value; a name several gauges carry is ambiguous, never picked; each river's km run their own way;
// gauges without coordinates are left off a map and named; an empty window says why.

import { test } from "node:test";
import assert from "node:assert/strict";
import { PegelOnlineClient } from "../src/client.js";
import { PegelApiError, PegelValidationError } from "../src/errors.js";
import {
  getLevelTrend,
  getMeasurements,
  getRiverOverview,
  getStationDetail,
  getStationsMap,
  getWaterLevels,
  listStations,
  listWaters,
  resolveWater,
} from "../src/operations.js";
import { gauges, hourly, NOW, pegelApi, pegelResponder, stamp } from "./fixtures.js";
import { jsonResponse, makeMockTransport } from "./helpers.js";

const clientOf = (api = pegelApi()) => ({ api, client: new PegelOnlineClient({ transport: api.transport }) });
const now = NOW;

test("getWaterLevels: unit from the series, high first, a plain verdict; one request for names given by id", async () => {
  const { api, client } = clientOf();
  const levels = await getWaterLevels(client, { stations: ["bonn", "Emmerich", "KÖLN"], now });
  assert.equal(levels.status, "ok");
  assert.deepEqual(levels.readings.map((r) => [r.station.shortname, r.reading.verdict, r.reading.value, r.reading.unit]), [
    ["EMMERICH", "high", 812, "cm"],
    ["BONN", "normal", 182, "cm"],
    ["KÖLN", "normal", 232, "cm"],
  ]);
  assert.equal(levels.readings[1]?.reading.timestamp, "2026-11-19T19:45:00+01:00");
  assert.equal(levels.readings[1]?.reading.ageMinutes, 15);
  assert.match(levels.verdict, /^EMMERICH: 812 cm, high \(at or above mean high water\); BONN: 182 cm, normal; KÖLN: 232 cm, normal\.$/);
  assert.equal(api.calls.length, 1);
  const url = new URL(api.last().url);
  assert.deepEqual([url.searchParams.get("ids"), url.searchParams.get("includeTimeseries"), url.searchParams.get("includeCurrentMeasurement")], ["bonn,Emmerich,KÖLN", "true", "true"]);
});

test("getWaterLevels: a canal level is m+NN, not cm, and has no flood reference, never 'normal'", async () => {
  const { client } = clientOf();
  const [r] = (await getWaterLevels(client, { stations: ["MÜNSTER OW"], now })).readings;
  assert.deepEqual([r?.reading.value, r?.reading.unit, r?.reading.verdict], [56.49, "m+NN", "no-reference"]);
  assert.match(r?.text ?? "", /56\.49 m\+NN, no flood reference published/);
});

test("getWaterLevels: commented is a gauge fault with the operator's comment, out-dated no current reading, a lagging gauge stale", async () => {
  const { client } = clientOf();
  const levels = await getWaterLevels(client, { stations: ["SANDAU", "RINTELN", "NEU DARCHAU"], now });
  const by = Object.fromEntries(levels.readings.map((r) => [r.station.shortname, r]));
  assert.equal(by["RINTELN"]?.reading.verdict, "gauge-fault");
  assert.equal(by["RINTELN"]?.reading.comment, "Funktionsstörung, fehlerhafte Messwerte");
  assert.match(by["RINTELN"]?.text ?? "", /gauge fault: Funktionsstörung, fehlerhafte Messwerte \(153 cm reported, unreliable\)/);
  assert.equal(by["SANDAU"]?.reading.verdict, "out-dated");
  assert.match(by["SANDAU"]?.text ?? "", /^SANDAU: no current reading \(out-dated/);
  assert.deepEqual([by["NEU DARCHAU"]?.reading.verdict, by["NEU DARCHAU"]?.reading.stale, by["NEU DARCHAU"]?.reading.ageMinutes], ["low", true, 660]);
  assert.match(by["NEU DARCHAU"]?.text ?? "", /low \(at or below mean low water\), last reading 11 h old/);
  assert.deepEqual(levels.readings.map((r) => r.station.shortname), ["NEU DARCHAU", "RINTELN", "SANDAU"], "low, then fault, then out-dated");
  assert.match(levels.verdict, /2 readings are more than two hours old: not the level now/);
});

test("getWaterLevels: the 99999 placeholder is no value, never a level of a kilometre", async () => {
  const { client } = clientOf();
  const [r] = (await getWaterLevels(client, { stations: ["PANNERDENSE KOP"], now })).readings;
  assert.deepEqual([r?.reading.value, r?.reading.verdict], [null, "no-value"]);
});

test("getWaterLevels: a name two gauges carry is ambiguous with both, never picked; their numbers resolve", async () => {
  const { client } = clientOf();
  const two = await getWaterLevels(client, { stations: ["NEUSTADT"], now });
  assert.equal(two.status, "ambiguous");
  assert.deepEqual(two.readings, []);
  assert.deepEqual(two.ambiguous[0]?.candidates.map((c) => [c.number, c.water]), [["48800200", "LEINE"], ["9610080", "OSTSEE"]]);
  assert.match(two.verdict, /"NEUSTADT" names 2 gauges: ask which one, then use its number/);
  const one = await getWaterLevels(client, { stations: ["9610080", "NEUSTADT"], now });
  assert.equal(one.status, "ok");
  assert.deepEqual(one.readings.map((r) => r.station.water), ["OSTSEE"]);
  assert.equal(one.ambiguous.length, 1);
});

test("getWaterLevels: a part of a name is found by the fuzzy match; an unknown name is empty with what to give instead", async () => {
  const { api, client } = clientOf();
  const part = await getWaterLevels(client, { stations: ["DARCHAU"], now });
  assert.deepEqual([part.status, part.readings[0]?.station.shortname, part.readings[0]?.matchedBy], ["ok", "NEU DARCHAU", "name part"]);
  assert.equal(new URL(api.last().url).searchParams.get("fuzzyId"), "DARCHAU");
  const none = await getWaterLevels(client, { stations: ["Cologne"], now });
  assert.equal(none.status, "empty");
  assert.deepEqual(none.unmatched, ["Cologne"]);
  assert.match(none.reason ?? "", /German place name as the gauge is called \(KÖLN, not Cologne/);
});

test("getWaterLevels: another series is read with its own unit; a missing one names what the gauge has", async () => {
  const { client } = clientOf();
  const flow = await getWaterLevels(client, { stations: ["BONN", "EMMERICH"], timeseries: "Q", now });
  const by = Object.fromEntries(flow.readings.map((r) => [r.station.shortname, r.reading]));
  assert.deepEqual([by["BONN"]?.value, by["BONN"]?.unit, by["BONN"]?.verdict], [1460, "m³/s", "no-reference"]);
  assert.deepEqual([by["EMMERICH"]?.verdict, by["EMMERICH"]?.available], ["no-series", ["W"]]);
});

test("getWaterLevels refuses no gauge, more than ten and a blank name, before any request", async () => {
  const { api, client } = clientOf();
  await assert.rejects(getWaterLevels(client, { stations: [] }), PegelValidationError);
  await assert.rejects(getWaterLevels(client, { stations: Array.from({ length: 11 }, (_, i) => `G${i}`) }), PegelValidationError);
  await assert.rejects(getWaterLevels(client, { stations: [" "] }), PegelValidationError);
  assert.equal(api.calls.length, 0);
});

test("getLevelTrend: falling, by how much and how fast, extremes, the placeholder dropped and counted; the unit from the series", async () => {
  const { api, client } = clientOf();
  const trend = await getLevelTrend(client, { station: "BONN", start: "P3D", points: 4, now });
  assert.equal(trend.status, "ok");
  if (trend.status !== "ok") return;
  assert.deepEqual([trend.direction, trend.delta, trend.ratePerDay, trend.range], ["falling", -14, -4.67, 14]);
  assert.deepEqual([trend.first.value, trend.last.value, trend.min.value, trend.max.value], [196, 182, 182, 196]);
  assert.deepEqual(trend.window, { from: stamp(now, 72 * 60), to: stamp(now, 0), points: 73, missing: 1 });
  assert.equal(trend.series.unit, "cm");
  assert.equal(trend.sample?.length, 4);
  assert.equal(trend.last.stale, false);
  assert.match(trend.verdict, /^BONN \(RHEIN\) W: falling 14 cm from .* \(4\.67 cm\/day\); range 182–196 cm\.$/);
  assert.match(trend.notes.join(" "), /1 of 73 points had no value/);
  const measured = new URL(api.last().url);
  assert.match(measured.pathname, /\/stations\/593647aa-9fea-43ec-a7d6-6476a76ae868\/W\/measurements\.json$/, "by uuid: never a name two gauges carry");
  assert.equal(measured.searchParams.get("start"), "P3D");
});

test("getLevelTrend: a lagging gauge's last reading is stale; a disturbed gauge's trend is unreliable; a tiny change is steady", async () => {
  const lagging = hourly(now, 24, 100, 100.5);
  const api = pegelApi({ measurements: { "67d6e882-b60c-40d3-975c-a6d7a2b4e40a/W": lagging.slice(0, 13), "005dfdae-efcc-410a-bf1c-24096e0c2866/W": [{ timestamp: stamp(now, 60), value: 150 }, { timestamp: stamp(now, 0), value: 160 }] } });
  const { client } = clientOf(api);
  const late = await getLevelTrend(client, { station: "NEU DARCHAU", now });
  assert.equal(late.status === "ok" && late.last.stale, true);
  assert.match(late.status === "ok" ? late.verdict : "", /last reading 12 h old/);
  const steady = late.status === "ok" ? late.direction : undefined;
  assert.equal(steady, "steady");
  const faulty = await getLevelTrend(client, { station: "RINTELN", now });
  assert.equal(faulty.status === "ok" && faulty.unreliable, true);
  assert.match(faulty.status === "ok" ? faulty.notes.join(" ") : "", /fault: Funktionsstörung/);
});

test("getLevelTrend: a canal's m+NN unit is said; a window outside the ~31 days kept is empty with the reason; a bad period is the API's 400", async () => {
  const { client } = clientOf();
  const canal = await getLevelTrend(client, { station: "MÜNSTER OW", now });
  assert.match(canal.status === "ok" ? canal.notes.join(" ") : "", /The unit is m\+NN, not cm/);
  const old = await getLevelTrend(client, { station: "BONN", start: "2026-01-01T00:00:00Z", end: "2026-01-08T00:00:00Z", now });
  assert.equal(old.status, "empty");
  assert.match(old.status === "empty" ? old.reason : "", /keeps only about the last 31 days/);
  await assert.rejects(getLevelTrend(client, { station: "BONN", start: "7d", now }), (err: unknown) => err instanceof PegelApiError && err.status === 400 && /neither a valid ISO date time/.test(err.message));
});

test("getLevelTrend: a name two gauges carry is ambiguous; a missing series names the ones there; no value at all is no trend", async () => {
  const api = pegelApi({ measurements: { "3046493f-971f-4d22-9f29-7ef8e3b645a4/W": hourly(now, 3, 99999, 99999) } });
  const { client } = clientOf(api);
  const two = await getLevelTrend(client, { station: "Neustadt", now });
  assert.deepEqual([two.status, two.status === "ambiguous" ? two.total : 0], ["ambiguous", 2]);
  const none = await getLevelTrend(client, { station: "EMMERICH", timeseries: "Q", now });
  assert.match(none.status === "empty" ? none.reason : "", /EMMERICH has no Q series; it has W/);
  const blank = await getLevelTrend(client, { station: "PANNERDENSE KOP", now });
  assert.match(blank.status === "empty" ? blank.reason : "", /sent no value in the window \(4 points without one\)/);
});

test("resolveWater: shortname, longname, English name, a part; several parts are ambiguous; none says how waters are named", async () => {
  const { client } = clientOf();
  assert.deepEqual(await resolveWater(client, "rhein"), { status: "ok", water: { shortname: "RHEIN", longname: "RHEIN" }, matchedBy: "shortname" });
  assert.deepEqual(await resolveWater(client, "Rhine"), { status: "ok", water: { shortname: "RHEIN", longname: "RHEIN" }, matchedBy: "alias" });
  assert.deepEqual(await resolveWater(client, "Mittellandkanal"), { status: "ok", water: { shortname: "MLK", longname: "MITTELLANDKANAL" }, matchedBy: "longname" });
  assert.deepEqual(await resolveWater(client, "Dortmund"), { status: "ok", water: { shortname: "DEK", longname: "DORTMUND-EMS-KANAL" }, matchedBy: "name part" });
  const kanal = await resolveWater(client, "kanal");
  assert.equal(kanal.status, "ambiguous");
  assert.equal(kanal.status === "ambiguous" ? kanal.total : 0, 4);
  const none = await resolveWater(client, "Amazonas");
  assert.match(none.status === "empty" ? none.reason : "", /German names \(RHEIN, DONAU/);
});

test("getRiverOverview: the Rhine in flow order, high and low counted and named first, the placeholder no value", async () => {
  const { client } = clientOf();
  const rhein = await getRiverOverview(client, { water: "Rhine", now });
  assert.equal(rhein.status, "ok");
  if (rhein.status !== "ok") return;
  assert.deepEqual(rhein.gauges.map((g) => g.km), [0.5, 654.8, 688, 851.9, 867.3]);
  assert.equal(rhein.counts.high, 1);
  assert.equal(rhein.counts["no-value"], 1);
  assert.deepEqual(rhein.attention.map((a) => a.shortname), ["EMMERICH"]);
  assert.equal(rhein.verdict, "RHEIN: 5 gauges, 1 high (EMMERICH), 0 low, 2 without a verdict (no flood reference, series or value: never call them normal).");
  assert.match(rhein.order, /km grow downstream/);
  assert.equal(rhein.asOf, "2026-11-19T19:45:00+01:00");
});

test("getRiverOverview: the Danube's km count down, so the table runs from the largest; the Weser's two chainages are kept apart", async () => {
  const { client } = clientOf();
  const donau = await getRiverOverview(client, { water: "Danube", now });
  assert.deepEqual(donau.status === "ok" ? donau.gauges.map((g) => g.station.shortname) : [], ["INGOLSTADT LUITPOLDSTRASSE", "PASSAU DONAU", "WILDUNGSMAUER", "THEBNERSTRASSL"]);
  const weser = await getRiverOverview(client, { water: "WESER", now });
  assert.equal(weser.status, "ok");
  if (weser.status !== "ok") return;
  assert.deepEqual(weser.gauges.map((g) => [g.station.shortname, g.section]), [
    ["HANN.MUENDEN", "upper"],
    ["RINTELN", "upper"],
    ["DREYE", "upper"],
    ["GROSSE WESERBRÜCKE", "lower"],
    ["BRAKE", "lower"],
  ]);
  assert.deepEqual(weser.attention.map((a) => a.shortname), ["DREYE", "RINTELN"], "low first, then the gauge fault");
  assert.match(weser.verdict, /1 low \(DREYE\), 2 without a verdict \(.*\), 1 with a gauge fault/);
  assert.match(weser.order, /Two chainages/);
});

test("getRiverOverview: a gauge without km goes last and is named; an unknown direction is said; mixed units are warned of", async () => {
  const { client } = clientOf();
  const ostsee = await getRiverOverview(client, { water: "Baltic Sea", now });
  assert.equal(ostsee.status, "ok");
  if (ostsee.status !== "ok") return;
  assert.equal(ostsee.gauges.at(-1)?.station.shortname, "Prerow");
  assert.match(ostsee.notes.join(" "), /Without a river kilometre, at the end: Prerow/);
  assert.match(ostsee.order, /not known here: ordered by ascending km/);
  const amazon = await getRiverOverview(client, { water: "Amazonas", now });
  assert.equal(amazon.status, "empty");
});

test("getStationsMap: [longitude, latitude] points with the live levels; gauges without coordinates left off and named; mixed units warned", async () => {
  const { client } = clientOf();
  const map = await getStationsMap(client, { water: "DONAU", levels: true, now });
  assert.equal(map.status, "ok");
  if (map.status !== "ok") return;
  assert.equal(map.type, "FeatureCollection");
  assert.deepEqual(map.features.map((f) => f.geometry.coordinates), [[11.426054, 48.757414], [13.459076, 48.576133]]);
  assert.deepEqual([map.features[0]?.properties.level, map.features[0]?.properties.unit, map.features[0]?.properties.verdict], [160, "cm", "normal"]);
  assert.deepEqual(map.leftOff.map((l) => l.shortname), ["WILDUNGSMAUER", "THEBNERSTRASSL"]);
  const all = await getStationsMap(client, { levels: true, now });
  assert.match(all.status === "ok" ? all.notes.join(" ") : "", /Levels come in cm, m\+NN/);
});

test("getStationsMap: a bbox narrows to a viewport; an empty one says so; the filters are refused together and a bad box before any request", async () => {
  const { api, client } = clientOf();
  const cologne = await getStationsMap(client, { bbox: [6.5, 50.5, 7.5, 51.0], now });
  assert.deepEqual(cologne.status === "ok" ? cologne.features.map((f) => f.properties.shortname) : [], ["BONN", "KÖLN"]);
  assert.equal(cologne.status === "ok" ? cologne.features[0]?.properties.level : "x", undefined, "no levels unless asked");
  const sea = await getStationsMap(client, { bbox: [-30, 0, -20, 10], now });
  assert.match(sea.status === "empty" ? sea.reason : "", /None of the 20 gauges lies inside the bbox/);
  const before = api.calls.length;
  await assert.rejects(getStationsMap(client, { water: "RHEIN", name: "BONN" }), /give one of water, stations or name/);
  await assert.rejects(getStationsMap(client, { bbox: [51, 6, 50, 7] }), PegelValidationError);
  assert.equal(api.calls.length, before);
});

test("getStationsMap with stations: an unmatched name and a shared one are said in notes", async () => {
  const { client } = clientOf();
  const map = await getStationsMap(client, { stations: ["BONN", "NEUSTADT", "Atlantis"], now });
  assert.equal(map.status, "ok");
  const notes = map.status === "ok" ? map.notes.join(" ") : "";
  assert.match(notes, /No gauge has the id or name "Atlantis"/);
  assert.match(notes, /"NEUSTADT" names 2 gauges \(NEUSTADT on LEINE, number 48800200; NEUSTADT on OSTSEE, number 9610080\)/);
});

test("listWaters and listStations: all or a part of a name; same-named gauges said; an unknown water empty", async () => {
  const { client } = clientOf();
  assert.equal((await listWaters(client)).status === "ok", true);
  const canals = await listWaters(client, { name: "kanal" });
  assert.deepEqual(canals.status === "ok" ? canals.waters.map((w) => w.shortname) : [], ["DEK", "EHK", "ELK", "MLK"]);
  const leine = await listStations(client, { water: "leine" });
  assert.deepEqual(leine.status === "ok" ? leine.stations.map((s) => s.number) : [], ["48800200"]);
  const named = await listStations(client, { name: "neustadt" });
  assert.match(named.status === "ok" ? named.notes.join(" ") : "", /Names several gauges carry: NEUSTADT/);
  assert.equal((await listStations(client, { water: "Nil" })).status, "empty");
});

test("getStationDetail: every series with unit and reading, the marks verbatim, the forecast window; ambiguous for a shared name", async () => {
  const { api, client } = clientOf();
  const koeln = await getStationDetail(client, { station: "Köln", marks: true, forecast: true, now });
  assert.equal(koeln.status, "ok");
  if (koeln.status !== "ok") return;
  assert.deepEqual(koeln.series.map((s) => [s.shortname, s.unit, s.reading?.verdict]), [["Q", "m³/s", "no-reference"], ["W", "cm", "normal"], ["WV", "cm", undefined]]);
  assert.deepEqual(koeln.series[1]?.marks?.map((m) => m["shortname"]), ["MNW", "HHW"]);
  assert.equal(koeln.series[2]?.start, stamp(now, 13 * 60));
  assert.match(new URL(api.last().url).pathname, /\/stations\/a6ee8177-107b-47dd-bcfd-30960ccc6e9c\.json$/);
  assert.equal((await getStationDetail(client, { station: "NEUSTADT", now })).status, "ambiguous");
});

test("getMeasurements: the raw points with the unit, placeholders as null and counted; an unknown series empty with the ones there", async () => {
  const { client } = clientOf();
  const bonn = await getMeasurements(client, { station: "BONN", start: "P3D" });
  assert.equal(bonn.status, "ok");
  if (bonn.status !== "ok") return;
  assert.deepEqual([bonn.total, bonn.missing, bonn.series.unit, bonn.measurements[10]?.value], [73, 1, "cm", null]);
  const none = await getMeasurements(client, { station: "BONN", timeseries: "LT" });
  assert.match(none.status === "empty" ? none.reason : "", /BONN has no LT series; it has W, Q/);
  const forecast = await getMeasurements(client, { station: "KÖLN", timeseries: "WV" });
  assert.equal(forecast.status, "ok", "a forecast series is found though the station lists it only when asked");
});

test("a forecast series' comment says where the forecast comes from: it is no gauge fault", async () => {
  const api = pegelApi({ measurements: { "a6ee8177-107b-47dd-bcfd-30960ccc6e9c/WV": [{ timestamp: stamp(now, 0), value: 230, initialized: stamp(now, 60), type: "forecast" }, { timestamp: stamp(now, -120), value: 240, initialized: stamp(now, 60), type: "estimate" }] } });
  const { client } = clientOf(api);
  const points = await getMeasurements(client, { station: "KÖLN", timeseries: "WV" });
  assert.equal(points.status, "ok");
  const notes = points.status === "ok" ? points.notes.join(" ") : "";
  assert.doesNotMatch(notes, /fault/);
  assert.match(notes, /About the forecast: nwv-bfg: Vorhersagen und Abschätzungen/);
  assert.match(notes, /forecasts first, then rougher estimates/);
  const trend = await getLevelTrend(client, { station: "KÖLN", timeseries: "WV", now });
  assert.equal(trend.status, "ok", "the forecast series is found for a trend too");
  assert.equal(trend.status === "ok" && trend.unreliable, false);
  assert.doesNotMatch(trend.status === "ok" ? trend.verdict + trend.notes.join(" ") : "", /fault/);
  const detail = await getStationDetail(client, { station: "KÖLN", forecast: true, now });
  const wv = detail.status === "ok" ? detail.series.find((s) => s.shortname === "WV") : undefined;
  assert.match(wv?.comment ?? "", /^nwv-bfg/);
});

/** The mock, with the given station-list filters ignored (the whole network for any value). */
function ignoring(...filters: string[]) {
  const answer = pegelResponder();
  return makeMockTransport((req) => {
    const url = new URL(req.url);
    for (const f of filters) url.searchParams.delete(f);
    return answer({ ...req, url: url.toString() });
  });
}

test("a station-list filter PEGELONLINE ignores is an error, never the network taken for the water or name asked for", async () => {
  const waters = clientOf(ignoring("waters")).client;
  await assert.rejects(() => getRiverOverview(waters, { water: "MOSEL", now }), (err: unknown) => err instanceof Error && err.name === "PegelParseError" && /outside the filter waters="MOSEL"/.test(err.message));
  await assert.rejects(() => listStations(waters, { water: "DEK" }), /outside the filter waters="DEK"/);
  await assert.rejects(() => listStations(clientOf(ignoring("fuzzyId")).client, { name: "DARCHAU" }), /outside the filter fuzzyId="DARCHAU"/);
  // An ignored ids filter: the stations the ids name are kept, the rest dropped.
  const ids = await listStations(clientOf(ignoring("ids")).client, { stations: ["BONN", "2790020"] });
  assert.deepEqual(ids.status === "ok" ? ids.stations.map((s) => s.shortname) : [], ["BONN", "EMMERICH"]);
});

/** The mock, its W readings' state rewritten by `edit` (a key renamed, a value changed). */
function withStates(edit: (current: Record<string, unknown>) => void) {
  const answer = pegelResponder();
  return makeMockTransport((req) => {
    const res = answer(req);
    const body = JSON.parse(res.body.toString("utf8")) as unknown;
    const stations = (Array.isArray(body) ? body : [body]) as { timeseries?: { shortname: string; currentMeasurement?: Record<string, unknown> }[] }[];
    for (const s of stations) for (const t of s.timeseries ?? []) if (t.shortname === "W" && t.currentMeasurement !== undefined) edit(t.currentMeasurement);
    return { ...res, body: Buffer.from(JSON.stringify(body)) };
  });
}

test("a W reading whose state is missing or not one the API documents is not understood, never 'no flood reference'", async () => {
  const renamed = clientOf(
    withStates((c) => {
      c["zustandMnwMhw"] = c["stateMnwMhw"];
      delete c["stateMnwMhw"];
    }),
  ).client;
  const levels = await getWaterLevels(renamed, { stations: ["EMMERICH", "BONN"], now });
  assert.deepEqual(levels.readings.map((r) => r.reading.verdict), ["state-not-understood", "state-not-understood"]);
  assert.match(levels.verdict, /EMMERICH: 812 cm, state missing, not understood by this server/);
  const river = await getRiverOverview(renamed, { water: "RHEIN", now });
  assert.match(river.status === "ok" ? river.verdict : "", /4 with a state not understood/);
  assert.doesNotMatch(river.status === "ok" ? river.verdict : "", /no gauge at high or low water/);
  const odd = clientOf(withStates((c) => c["stateMnwMhw"] === "high" && (c["stateMnwMhw"] = "very-high"))).client;
  const [emmerich] = (await getWaterLevels(odd, { stations: ["EMMERICH"], now })).readings;
  assert.equal(emmerich?.reading.verdict, "state-not-understood");
  assert.match(emmerich?.text ?? "", /812 cm, state "very-high" not understood by this server/);
  // A flow series has no state: no flood reference, as before.
  const [flow] = (await getWaterLevels(clientOf().client, { stations: ["BONN"], timeseries: "Q", now })).readings;
  assert.equal(flow?.reading.verdict, "no-reference");
});

test("a reading stamped in the future is flagged, never the level now", async () => {
  const ahead = gauges().map((g) => (g.shortname === "BONN" ? { ...g, series: [{ ...g.series[0]!, minutesAgo: -180 }] } : g));
  const { client } = clientOf(pegelApi({ gauges: ahead }));
  const [bonn] = (await getWaterLevels(client, { stations: ["BONN"], now })).readings;
  assert.deepEqual([bonn?.reading.aheadMinutes, bonn?.reading.ageMinutes, bonn?.reading.stale], [180, undefined, false]);
  assert.match(bonn?.text ?? "", /182 cm, normal, stamped 3 h ahead of now \(a wrong clock at the gauge or here\): not the level now/);
  const levels = await getWaterLevels(client, { stations: ["BONN", "KÖLN"], now });
  assert.match(levels.verdict, /1 reading is stamped in the future: not the level now/);
  const river = await getRiverOverview(client, { water: "RHEIN", now });
  assert.equal(river.status === "ok" ? river.counts.future : -1, 1);
  assert.match(river.status === "ok" ? river.verdict : "", /1 stamped in the future/);
  // A few minutes ahead is a clock's drift, not flagged.
  const drift = gauges().map((g) => (g.shortname === "BONN" ? { ...g, series: [{ ...g.series[0]!, minutesAgo: -3 }] } : g));
  const [near] = (await getWaterLevels(clientOf(pegelApi({ gauges: drift })).client, { stations: ["BONN"], now })).readings;
  assert.deepEqual([near?.reading.aheadMinutes, near?.reading.ageMinutes], [undefined, 0]);
});

test("one gauge named in several forms is read once", async () => {
  const { client } = clientOf();
  const levels = await getWaterLevels(client, { stations: ["2710080", "BONN", "bonn", "593647aa-9fea-43ec-a7d6-6476a76ae868", "KÖLN"], now });
  assert.deepEqual(levels.readings.map((r) => [r.station.shortname, r.asked]), [["BONN", "2710080"], ["KÖLN", "KÖLN"]]);
  assert.equal(levels.verdict.match(/BONN:/g)?.length, 1);
});

test("the river verdict counts the gauges it can't judge: no flood reference, no series, no value", async () => {
  const { client } = clientOf();
  const rhein = await getRiverOverview(client, { water: "RHEIN", now });
  // KONSTANZ-RHEIN has no flood reference, PANNERDENSE KOP sent its placeholder.
  assert.match(rhein.status === "ok" ? rhein.verdict : "", /^RHEIN: 5 gauges, 1 high \(EMMERICH\), 0 low, 2 without a verdict \(no flood reference, series or value: never call them normal\)\.$/);
  const canal = gauges().filter((g) => g.water === "DEK");
  const dek = await getRiverOverview(clientOf(pegelApi({ gauges: canal })).client, { water: "DEK", now });
  assert.match(dek.status === "ok" ? dek.verdict : "", /^DEK: 1 gauge, 0 high, 0 low, 1 without a verdict \(.*\); none could be judged\.$/);
  const donau = await getRiverOverview(client, { water: "DONAU", now });
  assert.match(donau.status === "ok" ? donau.verdict : "", /0 high, 0 low, 2 without a verdict .*; no gauge at high or low water among the 2 judged\.$/);
});

/** Hourly points `hours` back from `now`, the value at each hour from `at(hour)`. */
function window(hours: number, at: (hour: number) => number): { timestamp: string; value: number }[] {
  return Array.from({ length: hours + 1 }, (_, i) => ({ timestamp: stamp(now, (hours - i) * 60), value: Math.round(at(i) * 100) / 100 }));
}

test("getLevelTrend after a crest: it peaked and is falling now, never 'rising' from first against last", async () => {
  const crest = window(168, (h) => (h <= 120 ? 100 + (300 * h) / 120 : 400 - (100 * (h - 120)) / 48));
  const { client } = clientOf(pegelApi({ measurements: { "593647aa-9fea-43ec-a7d6-6476a76ae868/W": crest } }));
  const trend = await getLevelTrend(client, { station: "BONN", now });
  assert.equal(trend.status, "ok");
  if (trend.status !== "ok") return;
  assert.equal(trend.direction, "peaked");
  assert.deepEqual([trend.since?.direction, trend.since?.delta, trend.since?.from.value, trend.since?.ratePerDay], ["falling", -100, 400, -50]);
  assert.match(trend.verdict, /^BONN \(RHEIN\) W: falling 100 cm since its peak of 400 cm at \S+ \(50 cm\/day\); over the window from \S+ to \S+ up 200 cm; range 100–400 cm\.$/);
  // The other way round: it bottomed out and is rising now.
  const trough = window(168, (h) => (h <= 120 ? 400 - (300 * h) / 120 : 100 + (100 * (h - 120)) / 48));
  const low = await getLevelTrend(clientOf(pegelApi({ measurements: { "593647aa-9fea-43ec-a7d6-6476a76ae868/W": trough } })).client, { station: "BONN", now });
  assert.equal(low.status === "ok" ? low.direction : "", "bottomed");
  assert.match(low.status === "ok" ? low.verdict : "", /rising 100 cm since its low of 100 cm/);
  // A small dip at the end is no turn: still rising.
  const dip = window(168, (h) => (h <= 160 ? 100 + (300 * h) / 160 : 400 - (h - 160)));
  const rising = await getLevelTrend(clientOf(pegelApi({ measurements: { "593647aa-9fea-43ec-a7d6-6476a76ae868/W": dip } })).client, { station: "BONN", now });
  assert.deepEqual(rising.status === "ok" ? [rising.direction, rising.since] : [], ["rising", undefined]);
});

test("getLevelTrend at a tide gauge: the level swings up and down, first against last is no trend", async () => {
  // Three days every 15 minutes, a tide of 400 cm range every 12.42 hours, the highs and lows sinking 20 cm.
  const points = Array.from({ length: 3 * 96 + 1 }, (_, i) => {
    const h = i / 4;
    return { timestamp: stamp(now, (72 - h) * 60), value: Math.round(530 + 200 * Math.sin((2 * Math.PI * h) / 12.42) - (20 * h) / 72) };
  });
  const { client } = clientOf(pegelApi({ measurements: { "593647aa-9fea-43ec-a7d6-6476a76ae868/W": points } }));
  const trend = await getLevelTrend(client, { station: "BONN", start: "P3D", now });
  assert.equal(trend.status, "ok");
  if (trend.status !== "ok") return;
  assert.equal(trend.direction, "oscillating");
  assert.equal(trend.since, undefined);
  assert.ok((trend.swings?.turns ?? 0) >= 10, JSON.stringify(trend.swings));
  assert.ok((trend.swings?.highs.last.value ?? 0) < (trend.swings?.highs.first.value ?? 0));
  assert.match(trend.verdict, /^BONN \(RHEIN\) W: swings up and down, \d+ turns from \S+ to \S+ \(a tide, or a regulated water\): high waters from \d+ to \d+ cm, low waters from \d+ to \d+ cm; first against last says nothing about a trend; range \d+–\d+ cm\.$/);
  assert.match(trend.notes.join(" "), /compare the high waters with each other, and the low waters/);
});

test("measurements answered 404 read the same in getLevelTrend as in getMeasurements: empty, with the reason", async () => {
  const answer = pegelResponder();
  const api = makeMockTransport((req) => (new URL(req.url).pathname.endsWith("/measurements.json") ? jsonResponse({ status: 404, message: "Not Found" }, 404) : answer(req)));
  const { client } = clientOf(api);
  const points = await getMeasurements(client, { station: "BONN" });
  const trend = await getLevelTrend(client, { station: "BONN", now });
  assert.equal(trend.status, "empty");
  assert.equal(trend.status === "empty" ? trend.reason : "", points.status === "empty" ? points.reason : "-");
  assert.match(trend.status === "empty" ? trend.reason : "", /BONN W has no measurements at the moment \(HTTP 404\)/);
});
