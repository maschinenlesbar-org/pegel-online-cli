// PegelOnlineClient — a typed client over the open (no-auth) PEGELONLINE REST
// API v2 (https://www.pegelonline.wsv.de/webservices/rest-api/v2).
//
//   client.stations.list({ waters: "RHEIN" })
//   client.stations.get("BONN", { includeCurrentMeasurement: true })
//   client.timeseries.currentMeasurement("BONN", "W")
//   client.timeseries.measurements("BONN", "W", { start: "P3D" })

import { RequestEngine, type EngineOptions } from "./engine.js";
import type { QueryParams } from "./query.js";
import { PegelAmbiguousStationError, PegelParseError, PegelValidationError } from "./errors.js";
import {
  assertValid,
  idListProblem,
  knownKeysProblem,
  nonEmptyProblem,
  normalizeInput,
  optionalBooleanProblem,
} from "./validate.js";
import type {
  Station,
  Water,
  TimeseriesInfo,
  CurrentMeasurement,
  Measurement,
  StationChoice,
  StationListParams,
  IncludeParams,
  StationIncludeParams,
  MeasurementsParams,
} from "./types.js";

const API = "/webservices/rest-api/v2";


/**
 * One URL path segment from a caller-supplied station or timeseries id. A blank
 * value would build a different path (`stations/.json`, `stations//W.json`), and
 * "." / ".." pass encodeURIComponent unchanged and are resolved by URL parsing
 * (the engine's `buildUrl` refuses them as path segments too), so all are refused.
 */
function enc(name: string, value: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new PegelValidationError(
      `Invalid ${name}: expected a non-empty string, got ${typeof value === "string" ? JSON.stringify(value) : typeof value}.`,
    );
  }
  const id = normalizeInput(value);
  if (id === "." || id === "..") {
    throw new PegelValidationError(`Invalid ${name} "${id}": "." and ".." cannot be used as an id.`);
  }
  return encodeURIComponent(id);
}

/**
 * An optional query value: `undefined` means omitted; anything else must be a
 * non-blank string (nonEmptyProblem), or PegelValidationError is thrown.
 */
function optionalValue(name: string, value: string | undefined): string | undefined {
  return value === undefined ? undefined : normalizeInput(assertValid(name, value, nonEmptyProblem));
}

/**
 * The documented shapes of a 2xx answer. A proxy page, an error envelope (`{"error": …}`),
 * `null` or `{}` used to be printed as data with exit 0 — or, for a list, read as
 * "nothing found". Each check names what was expected; the payload itself is passed
 * through untouched apart from the sentinel mapping.
 */
type Shape = (value: unknown) => boolean;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const hasStrings =
  (...keys: string[]): Shape =>
  (v) =>
    isObject(v) && keys.every((k) => typeof v[k] === "string");
const arrayOf =
  (item: Shape): Shape =>
  (v) =>
    Array.isArray(v) && v.every(item);
const isWater = hasStrings("shortname", "longname");
const isStation = hasStrings("uuid", "shortname");
const isTimeseries = hasStrings("shortname", "unit");
const isMeasurement: Shape = (v) =>
  hasStrings("timestamp")(v) && (typeof (v as { value?: unknown }).value === "number" || (v as { value?: unknown }).value === null);

/** `value` when `shape(value)` holds; otherwise a PegelParseError naming the expectation. */
function expectShape<T>(path: string, value: unknown, shape: Shape, what: string): T {
  if (!shape(value)) throw new PegelParseError(`Unexpected response from ${path}: expected ${what}.`);
  return value as T;
}

const INCLUDE_KEYS = ["includeTimeseries", "includeCurrentMeasurement", "includeCharacteristicValues"] as const;
const STATION_INCLUDE_KEYS = [...INCLUDE_KEYS, "includeForecastTimeseries"] as const;
const LIST_KEYS = ["ids", "waters", "fuzzyId", ...STATION_INCLUDE_KEYS] as const;
const MEASUREMENT_KEYS = ["start", "end"] as const;

/**
 * A method's parameter object, checked before any request: `undefined` (or `null` from
 * JavaScript) means none; otherwise only the documented keys (knownKeysProblem), and the
 * include flags only as booleans. Throws PegelValidationError.
 */
function checkParams<T extends object>(name: string, params: T | undefined | null, allowed: readonly string[]): T {
  if (params === undefined || params === null) return {} as T;
  assertValid(name, params, knownKeysProblem(allowed));
  for (const key of STATION_INCLUDE_KEYS) {
    if (allowed.includes(key)) assertValid(key, (params as Record<string, unknown>)[key], optionalBooleanProblem);
  }
  return params;
}

/**
 * The value PEGELONLINE relays for "no reading" on some gauges (seen on the
 * Rijkswaterstaat gauge PANNERDENSE KOP: `99999` cm, interleaved with real readings of
 * 576–597 cm in a measurement window). As a number it read as a 1 km water level and
 * broke every minimum, maximum, trend and map built on it.
 */
export const NO_VALUE_SENTINEL = 99999;

/** `m` with a sentinel `value` replaced by `null` (no reading at that time). */
function readingOf<T extends { value: number | null }>(m: T): T {
  return m.value === NO_VALUE_SENTINEL ? { ...m, value: null } : m;
}

/** A timeseries with the sentinel mapped in its embedded current measurement. */
function timeseriesOf(t: TimeseriesInfo): TimeseriesInfo {
  const current = t.currentMeasurement;
  return current !== undefined && isMeasurement(current) ? { ...t, currentMeasurement: readingOf(current) } : t;
}

/** A station with the sentinel mapped in every embedded current measurement. */
function stationOf(s: Station): Station {
  return Array.isArray(s.timeseries) ? { ...s, timeseries: s.timeseries.map((t) => (isObject(t) ? timeseriesOf(t) : t)) } : s;
}

/** Drop undefined values so only the parameters the caller set are sent. */
function prune(params: Record<string, unknown>): QueryParams {
  const out: QueryParams = {};
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) out[k] = v as QueryParams[string];
  }
  return out;
}

/**
 * The station include parameters. The API nests the current measurement and the
 * gauge marks *inside* each timeseries, and the forecast series are entries of the
 * timeseries list, so without `includeTimeseries=true` it silently drops all three.
 * Asking for any of them therefore implies `includeTimeseries` unless the caller set
 * it explicitly.
 */
function stationIncludes(p: StationIncludeParams): QueryParams {
  const nested =
    p.includeCurrentMeasurement === true || p.includeCharacteristicValues === true || p.includeForecastTimeseries === true;
  return prune({
    includeTimeseries: p.includeTimeseries ?? (nested ? true : undefined),
    includeCurrentMeasurement: p.includeCurrentMeasurement,
    includeCharacteristicValues: p.includeCharacteristicValues,
    includeForecastTimeseries: p.includeForecastTimeseries,
  });
}

function includeQuery(p: IncludeParams): QueryParams {
  return prune({
    includeTimeseries: p.includeTimeseries,
    includeCurrentMeasurement: p.includeCurrentMeasurement,
    includeCharacteristicValues: p.includeCharacteristicValues,
  });
}

/** Stations: list with filters, or fetch one by uuid/number/shortname/longname. */
class StationsResource {
  constructor(private readonly e: RequestEngine) {}

  /**
   * Rejects (PegelValidationError, no request) a blank `waters` or `fuzzyId`, a
   * blank `ids` entry and an empty `ids` array: the API reads an empty parameter as
   * no filter and would answer with every station.
   */
  async list(params: StationListParams = {}): Promise<Station[]> {
    params = checkParams("stations.list parameters", params, LIST_KEYS);
    const query = prune({
      ids:
        params.ids === undefined ? undefined : assertValid("ids", params.ids, idListProblem).map(normalizeInput).join(","),
      waters: optionalValue("waters", params.waters),
      fuzzyId: optionalValue("fuzzyId", params.fuzzyId),
      ...stationIncludes(params),
    });
    const path = `${API}/stations.json`;
    return expectShape<Station[]>(path, await this.e.getJson(path, query), arrayOf(isStation), "an array of stations").map(stationOf);
  }

  /**
   * Refuse a station name that more than one station carries. The per-station methods
   * (`get`, `timeseries.*`) send a name as given, and for `NEUSTADT` — a LEINE and an
   * OSTSEE gauge — the API silently answers with one of them. This looks the name up
   * first (one `stations.list({ ids: [station] })` request) and rejects with
   * {@link PegelAmbiguousStationError}, listing the stations by number and uuid, when it
   * names two or more. A uuid or number (see {@link isUnambiguousStationId}) is accepted
   * without a request; a name that names one station, or none (the per-station call then
   * answers 404), resolves. The CLI calls this before every per-station command.
   */
  async assertUnique(station: string): Promise<void> {
    enc("station", station);
    if (isUnambiguousStationId(station)) return;
    const id = normalizeInput(station);
    const named = (await this.list({ ids: [id] })).filter((s) =>
      [s.uuid, s.number, s.shortname, s.longname].some((f) => typeof f === "string" && sameId(f, id)),
    );
    if (named.length > 1) throw new PegelAmbiguousStationError(id, named.map(choiceOf));
  }

  async get(station: string, params: StationIncludeParams = {}): Promise<Station> {
    params = checkParams("stations.get parameters", params, STATION_INCLUDE_KEYS);
    const path = `${API}/stations/${enc("station", station)}.json`;
    return stationOf(expectShape(path, await this.e.getJson(path, stationIncludes(params)), isStation, "a station object"));
  }
}

/** A station uuid (any case). */
const UUID_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A station number: digits only, leading zeros kept (`061000`). */
const NUMBER_ID = /^[0-9]+$/;

/**
 * True when `station` is a uuid or a station number — selectors that name exactly one
 * station — and false for a shortname or longname, which may name several (`NEUSTADT`).
 */
export function isUnambiguousStationId(station: string): boolean {
  const id = normalizeInput(station);
  return UUID_ID.test(id) || NUMBER_ID.test(id);
}

/** A station reduced to what tells it apart from same-named ones. */
function choiceOf(s: Station): StationChoice {
  return {
    uuid: s.uuid,
    number: s.number,
    shortname: s.shortname,
    longname: s.longname,
    ...(s.water?.shortname !== undefined ? { water: s.water.shortname } : {}),
  };
}

/** Timeseries: metadata, the current measurement, a window of measurements, gauge marks. */
class TimeseriesResource {
  constructor(private readonly e: RequestEngine) {}

  /** Timeseries metadata (e.g. "W" = water level, "Q" = flow). */
  async get(station: string, timeseries = "W", params: IncludeParams = {}): Promise<TimeseriesInfo> {
    params = checkParams("timeseries.get parameters", params, INCLUDE_KEYS);
    const path = `${API}/stations/${enc("station", station)}/${enc("timeseries", timeseries)}.json`;
    return timeseriesOf(expectShape(path, await this.e.getJson(path, includeQuery(params)), isTimeseries, "a timeseries object"));
  }

  async currentMeasurement(station: string, timeseries = "W"): Promise<CurrentMeasurement> {
    const path = `${API}/stations/${enc("station", station)}/${enc("timeseries", timeseries)}/currentmeasurement.json`;
    return readingOf(expectShape(path, await this.e.getJson(path), isMeasurement, "a measurement object"));
  }

  /** Rejects (PegelValidationError, no request) a blank `start` or `end`. */
  async measurements(
    station: string,
    timeseries = "W",
    params: MeasurementsParams = {},
  ): Promise<Measurement[]> {
    params = checkParams("timeseries.measurements parameters", params, MEASUREMENT_KEYS);
    const path = `${API}/stations/${enc("station", station)}/${enc("timeseries", timeseries)}/measurements.json`;
    const query = prune({ start: optionalValue("start", params.start), end: optionalValue("end", params.end) });
    return expectShape<Measurement[]>(path, await this.e.getJson(path, query), arrayOf(isMeasurement), "an array of measurements").map(readingOf);
  }
}

/**
 * What {@link stationListNotes} reports about a `stations.list` result: a filter value
 * that matched no station, or a name that more than one returned station carries.
 */
export type StationListNote =
  | { kind: "unmatched"; filter: "ids" | "waters" | "fuzzyId"; value: string }
  | {
      kind: "ambiguous";
      /** The shortname two or more returned stations share (e.g. "NEUSTADT"). */
      name: string;
      /** Those stations, to pick one by its unambiguous uuid or number. */
      stations: StationChoice[];
    };

/** Case-insensitive equality the way the API's id lookup behaves (`roßdorf` finds `ROSSDORF`). */
function sameId(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase() || a.toUpperCase() === b.toUpperCase();
}

/**
 * The filter values of a `stations.list` call that matched nothing in its result. The
 * API drops an `ids` entry it doesn't know and answers an unknown `waters` or `fuzzyId`
 * with `[]`, both with HTTP 200, so `ids: ["BONN", "KOELN", "EMMERICH"]` silently gave two
 * stations and `waters: "Rhine"` an empty river. This reports each `ids` entry that names
 * none of the returned stations (by uuid, number, shortname or longname, ignoring case),
 * and a `waters` or `fuzzyId` filter whose result is empty. An empty array means every
 * filter matched.
 *
 * When the call looked stations up by name (`ids` or `fuzzyId`), it also reports every
 * shortname that two or more returned stations share: NEUSTADT names a gauge on the
 * LEINE and one on the OSTSEE, and a lookup by that name (`stations.get("NEUSTADT")`,
 * `timeseries.currentMeasurement("NEUSTADT")`) silently returns one of them — the uuid
 * or number picks the right one, and `stations.assertUnique` refuses such a name before
 * the lookup. The CLI prints all notes on stderr.
 */
export function stationListNotes(params: StationListParams, stations: readonly Station[]): StationListNote[] {
  const notes: StationListNote[] = [];
  for (const raw of params.ids ?? []) {
    const id = normalizeInput(raw);
    const found = stations.some((s) =>
      [s.uuid, s.number, s.shortname, s.longname].some((f) => typeof f === "string" && sameId(f, id)),
    );
    if (!found) notes.push({ kind: "unmatched", filter: "ids", value: raw });
  }
  if (stations.length === 0) {
    if (params.waters !== undefined) notes.push({ kind: "unmatched", filter: "waters", value: params.waters });
    if (params.fuzzyId !== undefined) notes.push({ kind: "unmatched", filter: "fuzzyId", value: params.fuzzyId });
  }
  if (params.ids !== undefined || params.fuzzyId !== undefined) {
    const byName = new Map<string, Station[]>();
    for (const s of stations) {
      const key = s.shortname.toUpperCase();
      byName.set(key, [...(byName.get(key) ?? []), s]);
    }
    for (const same of byName.values()) {
      if (same.length < 2) continue;
      notes.push({
        kind: "ambiguous",
        name: same[0]!.shortname,
        stations: same.map(choiceOf),
      });
    }
  }
  return notes;
}

export class PegelOnlineClient {
  private readonly engine: RequestEngine;

  readonly stations: StationsResource;
  readonly timeseries: TimeseriesResource;

  constructor(options: EngineOptions = {}) {
    // A JavaScript caller may pass null for "no options"; treat it like undefined.
    this.engine = new RequestEngine(options ?? {});
    this.stations = new StationsResource(this.engine);
    this.timeseries = new TimeseriesResource(this.engine);
  }

  /** List all bodies of water (Gewässer) covered by the service. */
  async waters(): Promise<Water[]> {
    const path = `${API}/waters.json`;
    return expectShape(path, await this.engine.getJson(path), arrayOf(isWater), "an array of waters");
  }
}
