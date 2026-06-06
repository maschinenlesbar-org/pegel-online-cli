// Domain types for the PEGELONLINE REST API v2 (pegelonline.wsv.de), the
// Wasserstraßen- und Schifffahrtsverwaltung's water-level web service.

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

/** A body of water (Gewässer). */
export interface Water {
  shortname: string;
  longname: string;
}

/** A measuring station. Timeseries/current measurement appear only when requested. */
export interface Station {
  uuid: string;
  number: string;
  shortname: string;
  longname: string;
  km?: number;
  agency?: string;
  longitude?: number;
  latitude?: number;
  water?: Water;
  timeseries?: TimeseriesInfo[];
}

/** A measurement value plus the API's state classifications. */
export interface CurrentMeasurement {
  timestamp: string;
  value: number;
  /** Classification vs. the mean low/high water marks. */
  stateMnwMhw?: string;
  /** Classification vs. the lowest/highest navigable water marks. */
  stateNswHsw?: string;
}

/** Metadata for one timeseries of a station (e.g. "W" water level, "Q" flow). */
export interface TimeseriesInfo {
  shortname: string;
  longname: string;
  unit: string;
  equidistance?: number;
  currentMeasurement?: CurrentMeasurement;
  /** Characteristic values (gauge marks), present only when requested. */
  characteristicValues?: JsonObject[] | null;
}

/** One point of a measurements series. */
export interface Measurement {
  timestamp: string;
  value: number;
}

/** Parameters for the stations listing. */
export interface StationListParams {
  /** Station identifiers (uuid/number/shortname/longname); sent comma-separated. */
  ids?: string[];
  longname?: string;
  agency?: string;
  /** Water shortname filter. */
  waters?: string;
  fuzzyId?: string;
  /** Bounding box. */
  latbottom?: number;
  lattop?: number;
  longleft?: number;
  longright?: number;
  includeTimeseries?: boolean;
  includeCurrentMeasurement?: boolean;
  includeCharacteristicValues?: boolean;
}

/** Optional includes for a single-station or single-timeseries request. */
export interface IncludeParams {
  includeTimeseries?: boolean;
  includeCurrentMeasurement?: boolean;
  includeCharacteristicValues?: boolean;
}

/** Time window for a measurements request (ISO-8601 instants or periods, e.g. "P7D"). */
export interface MeasurementsParams {
  start?: string;
  end?: string;
}
