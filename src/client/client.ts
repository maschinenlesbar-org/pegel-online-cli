// PegelOnlineClient — a typed client over the open (no-auth) PEGELONLINE REST
// API v2 (https://www.pegelonline.wsv.de/webservices/rest-api/v2).
//
//   client.stations.list({ waters: "RHEIN" })
//   client.stations.get("BONN", { includeCurrentMeasurement: true })
//   client.timeseries.currentMeasurement("BONN", "W")
//   client.timeseries.measurements("BONN", "W", { start: "P3D" })

import { RequestEngine, type EngineOptions } from "./engine.js";
import type { QueryParams } from "./query.js";
import type {
  Station,
  Water,
  TimeseriesInfo,
  CurrentMeasurement,
  Measurement,
  StationListParams,
  IncludeParams,
  MeasurementsParams,
  JsonObject,
} from "./types.js";

const API = "/webservices/rest-api/v2";
const enc = encodeURIComponent;

/** Drop undefined values so only the parameters the caller set are sent. */
function prune(params: Record<string, unknown>): QueryParams {
  const out: QueryParams = {};
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) out[k] = v as QueryParams[string];
  }
  return out;
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

  list(params: StationListParams = {}): Promise<Station[]> {
    const query = prune({
      ids: params.ids && params.ids.length > 0 ? params.ids.join(",") : undefined,
      longname: params.longname,
      agency: params.agency,
      waters: params.waters,
      fuzzyId: params.fuzzyId,
      latbottom: params.latbottom,
      lattop: params.lattop,
      longleft: params.longleft,
      longright: params.longright,
      includeTimeseries: params.includeTimeseries,
      includeCurrentMeasurement: params.includeCurrentMeasurement,
      includeCharacteristicValues: params.includeCharacteristicValues,
    });
    return this.e.getJson(`${API}/stations.json`, query);
  }

  get(station: string, params: IncludeParams = {}): Promise<Station> {
    return this.e.getJson(`${API}/stations/${enc(station)}.json`, includeQuery(params));
  }
}

/** Timeseries: metadata, the current measurement, a window of measurements, gauge marks. */
class TimeseriesResource {
  constructor(private readonly e: RequestEngine) {}

  /** Timeseries metadata (e.g. "W" = water level, "Q" = flow). */
  get(station: string, timeseries = "W", params: IncludeParams = {}): Promise<TimeseriesInfo> {
    return this.e.getJson(
      `${API}/stations/${enc(station)}/${enc(timeseries)}.json`,
      includeQuery(params),
    );
  }

  currentMeasurement(station: string, timeseries = "W"): Promise<CurrentMeasurement> {
    return this.e.getJson(
      `${API}/stations/${enc(station)}/${enc(timeseries)}/currentmeasurement.json`,
    );
  }

  measurements(
    station: string,
    timeseries = "W",
    params: MeasurementsParams = {},
  ): Promise<Measurement[]> {
    return this.e.getJson(
      `${API}/stations/${enc(station)}/${enc(timeseries)}/measurements.json`,
      prune({ start: params.start, end: params.end }),
    );
  }

  characteristicValues(station: string, timeseries = "W"): Promise<JsonObject[]> {
    return this.e.getJson(
      `${API}/stations/${enc(station)}/${enc(timeseries)}/characteristicvalues.json`,
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
