// PegelOnlineClient — a typed client over the open (no-auth) PEGELONLINE REST
// API v2 (https://www.pegelonline.wsv.de/webservices/rest-api/v2).
//
//   client.stations.list({ waters: "RHEIN" })
//   client.stations.get("BONN", { includeCurrentMeasurement: true })
//   client.timeseries.currentMeasurement("BONN", "W")
//   client.timeseries.measurements("BONN", "W", { start: "P3D" })

import { RequestEngine, type EngineOptions } from "./engine.js";
import type { QueryParams } from "./query.js";
import { PegelError } from "./errors.js";
import { assertValid, idListProblem, nonEmptyProblem } from "./validate.js";
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
    throw new PegelError(`Invalid ${name}: expected a non-empty string, got ${JSON.stringify(value)}.`);
  }
  if (value === "." || value === "..") {
    throw new PegelError(`Invalid ${name} "${value}": "." and ".." cannot be used as an id.`);
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
    const query = prune({
      ids: params.ids === undefined ? undefined : assertValid("ids", params.ids, idListProblem).map(nfc).join(","),
      waters: optionalFilter("waters", params.waters),
      fuzzyId: optionalFilter("fuzzyId", params.fuzzyId),
      ...stationIncludes(params),
    });
    return this.e.getJson(`${API}/stations.json`, query);
  }

  async get(station: string, params: IncludeParams = {}): Promise<Station> {
    return this.e.getJson(`${API}/stations/${enc("station", station)}.json`, stationIncludes(params));
  }
}

/** Timeseries: metadata, the current measurement, a window of measurements, gauge marks. */
class TimeseriesResource {
  constructor(private readonly e: RequestEngine) {}

  /** Timeseries metadata (e.g. "W" = water level, "Q" = flow). */
  async get(station: string, timeseries = "W", params: IncludeParams = {}): Promise<TimeseriesInfo> {
    return this.e.getJson(
      `${API}/stations/${enc("station", station)}/${enc("timeseries", timeseries)}.json`,
      includeQuery(params),
    );
  }

  async currentMeasurement(station: string, timeseries = "W"): Promise<CurrentMeasurement> {
    return this.e.getJson(
      `${API}/stations/${enc("station", station)}/${enc("timeseries", timeseries)}/currentmeasurement.json`,
    );
  }

  /** Rejects (PegelValidationError, no request) a blank `start` or `end`. */
  async measurements(
    station: string,
    timeseries = "W",
    params: MeasurementsParams = {},
  ): Promise<Measurement[]> {
    return this.e.getJson(
      `${API}/stations/${enc("station", station)}/${enc("timeseries", timeseries)}/measurements.json`,
      prune({ start: optionalValue("start", params.start), end: optionalValue("end", params.end) }),
    );
  }
}

export class PegelOnlineClient {
  private readonly engine: RequestEngine;

  readonly stations: StationsResource;
  readonly timeseries: TimeseriesResource;

  constructor(options: EngineOptions = {}) {
    this.engine = new RequestEngine(options);
    this.stations = new StationsResource(this.engine);
    this.timeseries = new TimeseriesResource(this.engine);
  }

  /** List all bodies of water (Gewässer) covered by the service. */
  waters(): Promise<Water[]> {
    return this.engine.getJson(`${API}/waters.json`);
  }
}
