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
  /** Phone number of the station's voice announcement service, e.g. "+49228 286527 566". */
  voiceServiceNumber?: string;
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

/** The datum a water-level series is measured from (Pegelnullpunkt). */
export interface GaugeZero {
  /** Height system, e.g. "m. ü. NHN". */
  unit: string;
  value: number;
  /** Date the datum applies from, e.g. "2019-11-01". */
  validFrom?: string;
}

/** Metadata for one timeseries of a station (e.g. "W" water level, "Q" flow). */
export interface TimeseriesInfo {
  shortname: string;
  longname: string;
  unit: string;
  equidistance?: number;
  /** Gauge zero of a water-level series (absent on e.g. flow series). */
  gaugeZero?: GaugeZero;
  currentMeasurement?: CurrentMeasurement;
  /**
   * Characteristic values (gauge marks), present only when requested; an empty
   * array for a series without marks.
   */
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
  /** Water shortname filter. */
  waters?: string;
  fuzzyId?: string;
  /** Embed each station's timeseries list. */
  includeTimeseries?: boolean;
  /**
   * Embed the current measurement inside each timeseries. Implies
   * `includeTimeseries: true` unless that is set explicitly: the API drops the
   * measurement without the timeseries list.
   */
  includeCurrentMeasurement?: boolean;
  /** Embed the gauge marks inside each timeseries. Implies `includeTimeseries` like the above. */
  includeCharacteristicValues?: boolean;
}

/**
 * Optional includes for a single-station or single-timeseries request. On a
 * station request, `includeCurrentMeasurement` / `includeCharacteristicValues`
 * imply `includeTimeseries: true` unless that is set explicitly (the API nests
 * both inside the timeseries list and drops them without it).
 */
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
