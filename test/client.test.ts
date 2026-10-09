import { test } from "node:test";
import assert from "node:assert/strict";
import { PegelOnlineClient, isUnambiguousStationId } from "../src/client/client.js";
import { PegelAmbiguousStationError, PegelApiError, PegelError, PegelValidationError, describeStationChoice, describeStationChoices, MAX_LISTED_STATIONS, serverTextForMessage } from "../src/client/errors.js";
import { makeMockTransport, jsonResponse, constantJson, validFor } from "./helpers.js";
import type { MeasurementState, TimeseriesComment } from "../src/client/types.js";

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
  const mt = makeMockTransport(validFor);
  await clientWith(mt).stations.get("ST PAULI");
  assert.equal(new URL(mt.last().url).pathname, `${V2}/stations/ST%20PAULI.json`);
});

test("timeseries.currentMeasurement defaults the timeseries to W", async () => {
  const mt = makeMockTransport(validFor);
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
  const mt = makeMockTransport(validFor);
  await clientWith(mt).stations.get("BONN", { includeTimeseries: true });
  const url = new URL(mt.last().url);
  assert.equal(url.searchParams.get("includeTimeseries"), "true");
  assert.equal(url.searchParams.get("includeCurrentMeasurement"), null);
});

test("includeCurrentMeasurement / includeCharacteristicValues imply includeTimeseries on stations", async () => {
  const mt = makeMockTransport(validFor);
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
  const mt = makeMockTransport(validFor);
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
      PegelValidationError,
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

test("decomposed (NFD) umlauts in station, timeseries, waters, ids and fuzzyId are sent composed (NFC)", async () => {
  const mt = makeMockTransport(validFor);
  const c = clientWith(mt);
  await c.stations.get("KÖLN");
  assert.equal(new URL(mt.last().url).pathname, `${V2}/stations/K%C3%96LN.json`);
  await c.timeseries.currentMeasurement("KÖLN", "W");
  assert.equal(new URL(mt.last().url).pathname, `${V2}/stations/K%C3%96LN/W/currentmeasurement.json`);
  await c.stations.list({ ids: ["KÖLN", "BONN"], waters: "KÜSTENKANAL", fuzzyId: "münster" });
  const url = new URL(mt.last().url);
  assert.equal(url.searchParams.get("ids"), "KÖLN,BONN");
  assert.equal(url.searchParams.get("waters"), "KÜSTENKANAL");
  assert.equal(url.searchParams.get("fuzzyId"), "münster");
});

test("a 2xx body without the documented shape is a PegelParseError in every method (P9)", async () => {
  const bad: unknown[] = [null, {}, "text", 42, { error: "boom" }, [null], [{ shortname: 5 }]];
  for (const body of bad) {
    const c = clientWith(constantJson(body));
    const calls: Array<[string, () => Promise<unknown>]> = [
      ["waters", () => c.waters()],
      ["stations.list", () => c.stations.list()],
      ["stations.get", () => c.stations.get("BONN")],
      ["timeseries.get", () => c.timeseries.get("BONN")],
      ["currentMeasurement", () => c.timeseries.currentMeasurement("BONN")],
      ["measurements", () => c.timeseries.measurements("BONN")],
    ];
    for (const [name, call] of calls) {
      await assert.rejects(call, (err: unknown) =>
        err instanceof PegelError && err.name === "PegelParseError" && /^Unexpected response from \/webservices\/rest-api\/v2\/.*: expected /.test(err.message),
        `${name} ${JSON.stringify(body)}`);
    }
  }
  // A string value is not a reading.
  const c = clientWith(constantJson({ timestamp: "t", value: "68" }));
  await assert.rejects(() => c.timeseries.currentMeasurement("BONN"), /expected a measurement object/);
});

test("ids, names and filters are sent trimmed (P11): a pasted trailing space no longer empties the list", async () => {
  const mt = makeMockTransport(validFor);
  const c = clientWith(mt);
  await c.stations.get(" BONN ");
  assert.equal(new URL(mt.last().url).pathname, `${V2}/stations/BONN.json`);
  await c.timeseries.currentMeasurement("BONN ", " W");
  assert.equal(new URL(mt.last().url).pathname, `${V2}/stations/BONN/W/currentmeasurement.json`);
  await c.stations.list({ ids: ["BONN ", " KÖLN"], waters: "RHEIN ", fuzzyId: " bonn" });
  const url = new URL(mt.last().url);
  assert.equal(url.searchParams.get("ids"), "BONN,KÖLN");
  assert.equal(url.searchParams.get("waters"), "RHEIN");
  assert.equal(url.searchParams.get("fuzzyId"), "bonn");
  await c.timeseries.measurements("BONN", "W", { start: " P1D " });
  assert.equal(new URL(mt.last().url).searchParams.get("start"), "P1D");
  // A padded "." / ".." is still refused.
  await assert.rejects(() => c.stations.get(" .. "), PegelValidationError);
});

test("the no-value sentinel 99999 is a null reading wherever measurements appear (01#2)", async () => {
  const t = "2026-10-05T17:00:00+02:00";
  const c1 = clientWith(constantJson({ timestamp: t, value: 99999, stateMnwMhw: "out-dated" }));
  assert.deepEqual(await c1.timeseries.currentMeasurement("PANNERDENSE KOP"), { timestamp: t, value: null, stateMnwMhw: "out-dated" });
  const window = [{ timestamp: t, value: 99999 }, { timestamp: t, value: 576 }, { timestamp: t, value: 99999 }, { timestamp: t, value: 597 }];
  const c2 = clientWith(constantJson(window));
  assert.deepEqual((await c2.timeseries.measurements("PANNERDENSE KOP", "W", { start: "P10D" })).map((m) => m.value), [null, 576, null, 597]);
  const station = {
    uuid: "u", shortname: "PANNERDENSE KOP", longname: "PANNERDENSE KOP",
    timeseries: [{ shortname: "W", longname: "W", unit: "cm", currentMeasurement: { timestamp: t, value: 99999 } }, { shortname: "Q", longname: "Q", unit: "m³/s" }],
  };
  const c3 = clientWith(constantJson([station]));
  const [listed] = await c3.stations.list({ waters: "RHEIN", includeCurrentMeasurement: true });
  assert.equal(listed?.timeseries?.[0]?.currentMeasurement?.value, null);
  assert.equal(listed?.timeseries?.[1]?.currentMeasurement, undefined);
  const c4 = clientWith(constantJson(station));
  assert.equal((await c4.stations.get("PANNERDENSE KOP", { includeCurrentMeasurement: true })).timeseries?.[0]?.currentMeasurement?.value, null);
  const c5 = clientWith(constantJson(station.timeseries[0]));
  assert.equal((await c5.timeseries.get("PANNERDENSE KOP", "W", { includeCurrentMeasurement: true })).currentMeasurement?.value, null);
  // Real readings, 0 and negatives included, are untouched.
  const c6 = clientWith(constantJson([{ timestamp: t, value: 0 }, { timestamp: t, value: -12.5 }, { timestamp: t, value: 99998 }]));
  assert.deepEqual((await c6.timeseries.measurements("X")).map((m) => m.value), [0, -12.5, 99998]);
});

test("TimeseriesInfo types the operator's comment and the documented states (01#3)", async () => {
  const served = {
    shortname: "W", longname: "WASSERSTAND ROHDATEN", unit: "cm",
    comment: { shortDescription: "Funktionsstörung, fehlerhafte Messwerte", longDescription: "Funktionsstörung, fehlerhafte Messwerte" },
    currentMeasurement: { timestamp: "2026-10-05T17:00:00+02:00", value: 92, stateMnwMhw: "commented", stateNswHsw: "commented" },
  };
  const ts = await clientWith(constantJson(served)).timeseries.get("RINTELN", "W", { includeCurrentMeasurement: true });
  const state: MeasurementState | undefined = ts.currentMeasurement?.stateMnwMhw;
  const comment: TimeseriesComment | undefined = ts.comment;
  assert.equal(state, "commented");
  assert.equal(comment?.shortDescription, "Funktionsstörung, fehlerhafte Messwerte");
});

test("stations.assertUnique rejects a name two stations carry, listing them; accepts the rest", async () => {
  const a = { uuid: "u-1", number: "48800200", shortname: "NEUSTADT", longname: "NEUSTADT", water: { shortname: "LEINE", longname: "LEINE" } };
  const b = { uuid: "u-2", number: "9610080", shortname: "NEUSTADT", longname: "NEUSTADT" };
  // The comma-joined ids filter could return a station the name doesn't name: not counted.
  const other = { uuid: "u-3", number: "1", shortname: "ELSEWHERE", longname: "ELSEWHERE" };
  const mt = makeMockTransport((req) => {
    const id = new URL(req.url).searchParams.get("ids");
    return jsonResponse(id === "Neustadt " || id === "Neustadt" ? [a, b] : [a, other]);
  });
  const client = new PegelOnlineClient({ transport: mt.transport });
  await assert.rejects(client.stations.assertUnique("Neustadt "), (err: unknown) => {
    assert.ok(err instanceof PegelAmbiguousStationError);
    assert.ok(err instanceof PegelValidationError);
    assert.equal(err.station, "Neustadt");
    assert.deepEqual(err.stations, [
      { uuid: "u-1", number: "48800200", shortname: "NEUSTADT", longname: "NEUSTADT", water: "LEINE" },
      { uuid: "u-2", number: "9610080", shortname: "NEUSTADT", longname: "NEUSTADT" },
    ]);
    assert.equal(
      err.message,
      'Invalid station "Neustadt": it names 2 stations, NEUSTADT on LEINE (number 48800200, uuid u-1) and ' +
        "NEUSTADT (number 9610080, uuid u-2); use the number or uuid.",
    );
    return true;
  });
  assert.equal(new URL(mt.last().url).searchParams.get("ids"), "Neustadt");
  // A name the lookup returns once (plus an unrelated station) resolves.
  await client.stations.assertUnique("ELSEWHERE");
  const before = mt.calls.length;
  await client.stations.assertUnique("061000");
  await client.stations.assertUnique("DDA39817-21B8-4F68-9B21-0F7A1A1C9B42");
  assert.equal(mt.calls.length, before);
  await assert.rejects(client.stations.assertUnique(" "), PegelValidationError);
  assert.equal(mt.calls.length, before);
  assert.equal(isUnambiguousStationId("NEUSTADT"), false);
  assert.equal(isUnambiguousStationId(" 9610080 "), true);
});

test("includeForecastTimeseries lists the WV series on stations and implies includeTimeseries", async () => {
  // Trimmed from the live KÖLN (2730010) station with forecasts, 2026-10-06.
  const wv = {
    shortname: "WV",
    longname: "WASSERSTANDVORHERSAGE",
    unit: "cm",
    equidistance: 120,
    start: "2026-10-06T07:00:00+02:00",
    end: "2026-10-10T07:00:00+02:00",
    comment: { shortDescription: "nwv-bfg", longDescription: "Vorhersagen und Abschätzungen vom: 06.10.2026 um 07:00 Uhr, Quelle: Bundesanstalt für Gewässerkunde." },
  };
  const served = { uuid: "u", number: "2730010", shortname: "KÖLN", longname: "KÖLN", timeseries: [wv] };
  const mt = makeMockTransport((req) => jsonResponse(new URL(req.url).pathname.endsWith("stations.json") ? [served] : served));
  const c = clientWith(mt);
  const station = await c.stations.get("2730010", { includeForecastTimeseries: true });
  let params = new URL(mt.last().url).searchParams;
  assert.equal(params.get("includeForecastTimeseries"), "true");
  assert.equal(params.get("includeTimeseries"), "true");
  assert.deepEqual(station.timeseries?.[0], wv);
  assert.equal(station.timeseries?.[0]?.start, "2026-10-06T07:00:00+02:00");
  await c.stations.list({ waters: "RHEIN", includeForecastTimeseries: true });
  params = new URL(mt.last().url).searchParams;
  assert.equal(params.get("includeForecastTimeseries"), "true");
  assert.equal(params.get("includeTimeseries"), "true");
  const sent = mt.calls.length;
  // Not a boolean, or on the per-series request (where it means nothing): rejected, no request.
  await assert.rejects(c.stations.get("2730010", { includeForecastTimeseries: "yes" as unknown as boolean }), PegelValidationError);
  await assert.rejects(
    c.timeseries.get("2730010", "WV", { includeForecastTimeseries: true } as unknown as Record<string, never>),
    PegelValidationError,
  );
  assert.equal(mt.calls.length, sent);
});

/** What a message never carries from a server: C0 (line breaks and TAB included), DEL, C1, U+2028/2029, bidi controls. */
const RAW_IN_MESSAGE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/;

test("the ambiguous-station message quotes the server's station fields clean, on one line and cut (B01-1)", async () => {
  const forged = "LEINE\n2026-10-09T05:00:00.000Z ERROR [pegel.api] HTTP 500 forged record";
  const hostile = "NEU\u001b]0;pwned\u0007\u009b31m\u007f\u202eTDATSUEN X\u2028Y";
  const a = { uuid: "u-1\rall fine", number: "488\n00200", shortname: hostile, longname: "NEUSTADT", water: { shortname: forged, longname: "LEINE" } };
  const b = { uuid: "u-2", number: "9610080", shortname: hostile, longname: "NEUSTADT", water: { shortname: "W".repeat(1_000_000), longname: "X" } };
  const client = new PegelOnlineClient({ transport: async () => jsonResponse([a, b]) });
  await assert.rejects(client.stations.assertUnique("NEUSTADT"), (err: unknown) => {
    assert.ok(err instanceof PegelAmbiguousStationError);
    assert.doesNotMatch(err.message, RAW_IN_MESSAGE, JSON.stringify(err.message.slice(0, 300)));
    assert.ok(err.message.includes("NEU]0;pwned31mTDATSUEN X Y on LEINE 2026-10-09T05:00:00.000Z ERROR [pegel.api] HTTP 500 forged record (number 488 00200, uuid u-1 all fine)"), err.message.slice(0, 400));
    assert.ok(err.message.includes(`on ${"W".repeat(200)}… (number 9610080, uuid u-2)`), "the long water is cut at 200");
    assert.ok(err.message.length < 1000, `${err.message.length}`);
    // The stations themselves are data: kept as the server sent them.
    assert.equal(err.stations[0]?.water, forged);
    return true;
  });
  assert.equal(serverTextForMessage(" a\n\tb\u2029c\u202e \u0085"), "a b c");
  assert.equal(describeStationChoice({ uuid: "u\n", number: "1", shortname: "S\u001b", longname: "L" }), "S (number 1, uuid u)");
});

test("the ambiguous-station message lists at most MAX_LISTED_STATIONS stations and counts the rest (B01-2)", async () => {
  const many = Array.from({ length: 500 }, (_, i) => ({ uuid: `u-${i}`, number: `${i}`, shortname: "NEUSTADT", longname: "NEUSTADT", water: { shortname: "LEINE", longname: "LEINE" } }));
  const client = new PegelOnlineClient({ transport: async () => jsonResponse(many) });
  await assert.rejects(client.stations.assertUnique("NEUSTADT"), (err: unknown) => {
    assert.ok(err instanceof PegelAmbiguousStationError);
    assert.match(err.message, /^Invalid station "NEUSTADT": it names 500 stations, NEUSTADT on LEINE \(number 0, uuid u-0\) and /);
    assert.match(err.message, /\(number 9, uuid u-9\) and … \(490 more\); use the number or uuid\.$/);
    assert.ok(!err.message.includes("u-10)"), "the eleventh is not listed");
    assert.equal(err.stations.length, 500, "the error keeps them all");
    return true;
  });
  const two = many.slice(0, 2).map((s) => ({ ...s, water: s.water.shortname }));
  assert.equal(describeStationChoices(two), `${describeStationChoice(two[0]!)} and ${describeStationChoice(two[1]!)}`);
  assert.equal(MAX_LISTED_STATIONS, 10);
});

test("a station field of the wrong type is left out of the message, not printed as undefined or [object Object] (B01-3)", async () => {
  const stations = [
    { uuid: "u-1", shortname: "NEUSTADT", longname: "NEUSTADT" },
    { uuid: "u-2", number: "9610010", shortname: "NEUSTADT", longname: "NEUSTADT", water: { shortname: { x: 1 }, longname: "X" } },
    { uuid: "u-3", number: null, shortname: "neustadt", longname: "NEUSTADT", water: null },
    { uuid: "u-4", number: 42, shortname: "NEUSTADT", longname: "NEUSTADT", water: { shortname: "LEINE" } },
  ];
  const client = new PegelOnlineClient({ transport: async () => jsonResponse(stations) });
  await assert.rejects(client.stations.assertUnique("NEUSTADT"), (err: unknown) => {
    assert.ok(err instanceof PegelAmbiguousStationError);
    assert.equal(
      err.message,
      'Invalid station "NEUSTADT": it names 4 stations, NEUSTADT (uuid u-1) and NEUSTADT (number 9610010, uuid u-2) and ' +
        "neustadt (uuid u-3) and NEUSTADT on LEINE (uuid u-4); use the number or uuid.",
    );
    assert.doesNotMatch(err.message, /undefined|null|object Object|number 42/);
    assert.equal(err.stations[1]?.water, undefined, "a water shortname that is no string is no water");
    return true;
  });
});
