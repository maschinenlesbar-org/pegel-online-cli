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

/**
 * A station as a name refers to it: enough to tell same-named stations apart and to
 * pick one by its unambiguous `uuid` or `number`. `water` is the water's shortname.
 */
export type StationChoice = Pick<Station, "uuid" | "number" | "shortname" | "longname"> & { water?: string };

/**
 * The API's classification of a current water level (`stateMnwMhw`, `stateNswHsw`), as
 * documented upstream:
 * - `low` — at or below MNW (stateMnwMhw only);
 * - `normal` — between MNW and MHW, or between 0 and HSW;
 * - `high` — at or above MHW, or HSW;
 * - `unknown` — the series has no MNW/MHW (or HSW) mark to compare with;
 * - `commented` — **gauge malfunction or disruption** ("Fehlfunktion oder Störung"): the
 *   value may be wrong; the reason is in the series' `comment` (`TimeseriesInfo.comment`);
 * - `out-dated` — the reading is older than 25 hours.
 * Typed open (`string & {}`) so a value the API adds later still type-checks.
 */
export type MeasurementState = "low" | "normal" | "high" | "unknown" | "commented" | "out-dated" | (string & {});

/** A measurement value plus the API's state classifications. */
export interface CurrentMeasurement {
  timestamp: string;
  /**
   * The reading, in the unit of its timeseries (`TimeseriesInfo.unit` — not always `cm`
   * for `W`). `null` when the gauge reported no value: the client maps the sentinel
   * `99999` (`NO_VALUE_SENTINEL`) the API relays for that to `null`.
   */
  value: number | null;
  /** Classification vs. the mean low/high water marks (water levels only). */
  stateMnwMhw?: MeasurementState;
  /** Classification vs. the lowest/highest navigable water marks (water levels only). */
  stateNswHsw?: MeasurementState;
}

/** The datum a water-level series is measured from (Pegelnullpunkt). */
export interface GaugeZero {
  /** Height system, e.g. "m. ü. NHN". */
  unit: string;
  value: number;
  /** Date the datum applies from, e.g. "2019-11-01". */
  validFrom?: string;
}

/**
 * An operator's note on a timeseries, present while something is wrong with it — e.g.
 * "Funktionsstörung, fehlerhafte Messwerte" (malfunction, faulty readings) at RINTELN,
 * "Techn. Störung", "Behelfspegel - Messwerte können Fehler aufweisen" (temporary gauge,
 * values may be wrong), "vorübergehend außer Betrieb". A current measurement whose state
 * is `commented` points here.
 */
export interface TimeseriesComment {
  shortDescription: string;
  longDescription?: string;
}

/** Metadata for one timeseries of a station (e.g. "W" water level, "Q" flow). */
export interface TimeseriesInfo {
  shortname: string;
  longname: string;
  /**
   * The unit of every value of this series, as the API publishes it. Read it; never
   * assume it from the shortname: most `W` (water level) series are in `cm`, but canal
   * and reservoir gauges publish `W` in `m+NN` (metres above sea level) or `m+PNP`
   * (metres above the gauge zero) — 69 of 737 W series on 5 October 2026, e.g. MÜNSTER OW
   * at 56.54 m+NN. `Q` is usually `m³/s`, temperatures `°C`.
   */
  unit: string;
  equidistance?: number;
  /** Gauge zero of a water-level series (absent on e.g. flow series). */
  gaugeZero?: GaugeZero;
  /**
   * The operator's note while the series is disturbed (see {@link TimeseriesComment});
   * absent otherwise. Read it whenever a reading's state is `commented`.
   */
  comment?: TimeseriesComment;
  currentMeasurement?: CurrentMeasurement;
  /**
   * Start of the series' window — on a forecast series (`WV`, *Wasserstandsvorhersage*)
   * the instant the forecast was issued, e.g. "2026-10-06T07:00:00+02:00". Absent on
   * measured series. Forecast series are listed in a station's timeseries only with
   * `includeForecastTimeseries`; their values come from `timeseries.measurements(station,
   * "WV")` and have no current measurement (404).
   */
  start?: string;
  /** End of a forecast series' window: the last forecast instant (about four days ahead). */
  end?: string;
  /**
   * Characteristic values (gauge marks), present only when requested; an empty
   * array for a series without marks.
   */
  characteristicValues?: JsonObject[] | null;
}

/** One point of a measurements series. */
export interface Measurement {
  timestamp: string;
  /**
   * The reading in the timeseries' unit, or `null` for a point without a value (the
   * sentinel `99999`, mapped by the client). Skip `null` points before a minimum, maximum
   * or trend.
   */
  value: number | null;
  /**
   * Forecast series (`WV`) only: when the forecast run was issued — the same for every
   * point of one run.
   */
  initialized?: string;
  /**
   * Forecast series (`WV`) only: `forecast` (*Vorhersage*) for the nearer points, then
   * `estimate` (*Abschätzung*, a rougher outlook) for the later ones. Not a measured
   * value either way. Typed open so a value the API adds later still type-checks.
   */
  type?: ForecastType;
}

/** The kind of a forecast point (`Measurement.type`). */
export type ForecastType = "forecast" | "estimate" | (string & {});

/** Parameters for the stations listing. */
export interface StationListParams {
  /**
   * Station identifiers (uuid/number/shortname/longname); sent comma-separated.
   * At least one, none blank. A name may match more than one station (NEUSTADT: LEINE
   * and OSTSEE) and an unknown one matches none, silently: `stationListNotes` reports both.
   */
  ids?: string[];
  /** Water shortname filter; not blank. */
  waters?: string;
  /** Fuzzy id match; not blank. */
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
  /**
   * Also list the forecast series (`WV`, see {@link TimeseriesInfo.start}) in each
   * station's timeseries list; the API leaves them out otherwise. Implies
   * `includeTimeseries` like the above.
   */
  includeForecastTimeseries?: boolean;
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

/** {@link IncludeParams} for a single-station request (`stations.get`). */
export interface StationIncludeParams extends IncludeParams {
  /**
   * Also list the forecast series (`WV`) in the station's timeseries list; the API leaves
   * them out otherwise. Implies `includeTimeseries` unless that is set explicitly.
   */
  includeForecastTimeseries?: boolean;
}

/** Time window for a measurements request (ISO-8601 instants or periods, e.g. "P7D"); neither bound may be blank. */
export interface MeasurementsParams {
  start?: string;
  end?: string;
}
