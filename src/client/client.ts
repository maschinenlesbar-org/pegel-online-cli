// PegelOnlineClient — a typed client over the open (no-auth) PEGELONLINE REST
// API v2 (https://www.pegelonline.wsv.de/webservices/rest-api/v2).
//
//   client.stations.list({ waters: "RHEIN" })
//   client.stations.get("BONN", { includeCurrentMeasurement: true })
//   client.timeseries.currentMeasurement("BONN", "W")
//   client.timeseries.measurements("BONN", "W", { start: "P3D" })

import { RequestEngine, type EngineOptions } from "./engine.js";
import type { QueryParams } from "./query.js";
import { PegelParseError, PegelValidationError } from "./errors.js";
import {
  assertValid,
  idListProblem,
  knownKeysProblem,
  nonEmptyProblem,
  optionalBooleanProblem,
} from "./validate.js";
import type {
  Station,
  Water,
  TimeseriesInfo,
  CurrentMeasurement,
  Measurement,
  StationListParams,
  IncludeParams,
  MeasurementsParams,
} from "./types.js";

const API = "/webservices/rest-api/v2";

/**
 * Station names, waters and ids are matched exactly by the API, which stores them
 * composed (NFC): a decomposed umlaut ("KO" + U+0308 + "LN", as pasted from macOS
 * file names or some PDFs) is a 404 / an empty list. Compose every such input.
 * NFC, not NFKC: an id lookup must not rewrite compatibility characters.
 */
function nfc(value: string): string {
  return value.normalize("NFC");
}

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
  if (value === "." || value === "..") {
    throw new PegelValidationError(`Invalid ${name} "${value}": "." and ".." cannot be used as an id.`);
  }
  return encodeURIComponent(nfc(value));
}

/**
 * An optional query value: `undefined` means omitted; anything else must be a
 * non-blank string (nonEmptyProblem), or PegelValidationError is thrown.
 */
function optionalValue(name: string, value: string | undefined): string | undefined {
  return value === undefined ? undefined : assertValid(name, value, nonEmptyProblem);
}

/** An optional filter value (optionalValue), composed to NFC like every name the API matches. */
function optionalFilter(name: string, value: string | undefined): string | undefined {
  const checked = optionalValue(name, value);
  return checked === undefined ? undefined : nfc(checked);
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
const LIST_KEYS = ["ids", "waters", "fuzzyId", ...INCLUDE_KEYS] as const;
const MEASUREMENT_KEYS = ["start", "end"] as const;

/**
 * A method's parameter object, checked before any request: `undefined` (or `null` from
 * JavaScript) means none; otherwise only the documented keys (knownKeysProblem), and the
 * include flags only as booleans. Throws PegelValidationError.
 */
function checkParams<T extends object>(name: string, params: T | undefined | null, allowed: readonly string[]): T {
  if (params === undefined || params === null) return {} as T;
  assertValid(name, params, knownKeysProblem(allowed));
  for (const key of INCLUDE_KEYS) {
    if (allowed.includes(key)) assertValid(key, (params as Record<string, unknown>)[key], optionalBooleanProblem);
  }
  return params;
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
 * gauge marks *inside* each timeseries, so without `includeTimeseries=true` it
 * silently drops both. Asking for either therefore implies `includeTimeseries`
 * unless the caller set it explicitly.
 */
function stationIncludes(p: IncludeParams): QueryParams {
  const nested = p.includeCurrentMeasurement === true || p.includeCharacteristicValues === true;
  return prune({
    includeTimeseries: p.includeTimeseries ?? (nested ? true : undefined),
    includeCurrentMeasurement: p.includeCurrentMeasurement,
    includeCharacteristicValues: p.includeCharacteristicValues,
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
      ids: params.ids === undefined ? undefined : assertValid("ids", params.ids, idListProblem).map(nfc).join(","),
      waters: optionalFilter("waters", params.waters),
      fuzzyId: optionalFilter("fuzzyId", params.fuzzyId),
      ...stationIncludes(params),
    });
    const path = `${API}/stations.json`;
    return expectShape(path, await this.e.getJson(path, query), arrayOf(isStation), "an array of stations");
  }

  async get(station: string, params: IncludeParams = {}): Promise<Station> {
    params = checkParams("stations.get parameters", params, INCLUDE_KEYS);
    const path = `${API}/stations/${enc("station", station)}.json`;
    return expectShape(path, await this.e.getJson(path, stationIncludes(params)), isStation, "a station object");
  }
}

/** Timeseries: metadata, the current measurement, a window of measurements, gauge marks. */
class TimeseriesResource {
  constructor(private readonly e: RequestEngine) {}

  /** Timeseries metadata (e.g. "W" = water level, "Q" = flow). */
  async get(station: string, timeseries = "W", params: IncludeParams = {}): Promise<TimeseriesInfo> {
    params = checkParams("timeseries.get parameters", params, INCLUDE_KEYS);
    const path = `${API}/stations/${enc("station", station)}/${enc("timeseries", timeseries)}.json`;
    return expectShape(path, await this.e.getJson(path, includeQuery(params)), isTimeseries, "a timeseries object");
  }

  async currentMeasurement(station: string, timeseries = "W"): Promise<CurrentMeasurement> {
    const path = `${API}/stations/${enc("station", station)}/${enc("timeseries", timeseries)}/currentmeasurement.json`;
    return expectShape(path, await this.e.getJson(path), isMeasurement, "a measurement object");
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
    return expectShape(path, await this.e.getJson(path, query), arrayOf(isMeasurement), "an array of measurements");
  }
}

/** A `stations.list` filter value that matched no station (see {@link stationListNotes}). */
export interface StationListNote {
  kind: "unmatched";
  filter: "ids" | "waters" | "fuzzyId";
  value: string;
}

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
 * filter matched. The CLI prints these as notes on stderr.
 */
export function stationListNotes(params: StationListParams, stations: readonly Station[]): StationListNote[] {
  const notes: StationListNote[] = [];
  for (const raw of params.ids ?? []) {
    const id = nfc(raw.trim());
    const found = stations.some((s) =>
      [s.uuid, s.number, s.shortname, s.longname].some((f) => typeof f === "string" && sameId(f, id)),
    );
    if (!found) notes.push({ kind: "unmatched", filter: "ids", value: raw });
  }
  if (stations.length === 0) {
    if (params.waters !== undefined) notes.push({ kind: "unmatched", filter: "waters", value: params.waters });
    if (params.fuzzyId !== undefined) notes.push({ kind: "unmatched", filter: "fuzzyId", value: params.fuzzyId });
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
