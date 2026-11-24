// The use cases of the skills as library functions, built on the client: each composes its calls
// and carries the traps the skills document, so no caller (the CLI, the MCP server's use-case
// tools, a library user) has to know them.
// - getWaterLevels: the live level at named gauges, with its unit and a plain verdict from
//   stateMnwMhw (the water-level-check skill);
// - getLevelTrend: a measurement window reduced to direction, delta, rate and extremes (the trend
//   skill);
// - getRiverOverview: every gauge on one water, in flow order by river kilometre, the ones not
//   normal first (the river-overview skill);
// - getStationsMap: gauges as a GeoJSON FeatureCollection, optionally with their live levels (the
//   stations-geojson skill);
// - listWaters, listStations, getStationDetail and getMeasurements: the lists and details the use
//   cases summarise.
// The traps: the unit belongs to the series and is not always cm (canal gauges publish m+NN); the
// current reading lives inside the timeseries list; `commented` is a gauge fault, `out-dated` no
// current reading, `unknown` no flood reference, none of them "normal"; a reading hours old is
// stale; the placeholder 99999 is no value (the client maps it to null); a name may name several
// gauges (NEUSTADT), which is reported, never guessed; km counts differently on each river. No
// bare "not found": an empty answer says what was searched and what to change.

import type { PegelOnlineClient } from "./client.js";
import { PegelApiError, PegelValidationError } from "./errors.js";
import type { CurrentMeasurement, JsonObject, Measurement, Station, TimeseriesInfo, Water } from "./types.js";
import { assertValid, normalizeInput, normalizeToken, stationIdProblem, textProblem, tokenProblem, type Problem } from "./validate.js";

// ---- shared ---------------------------------------------------------------------------------

/** A reading older than this is stale: most gauges report every 15 minutes. */
export const STALE_AFTER_MINUTES = 120;

/** A reading stamped further ahead of the clock than this is in the future (clocks drift a little). */
export const AHEAD_TOLERANCE_MINUTES = 5;

/** The most station names one {@link getWaterLevels} call takes. */
export const MAX_STATIONS = 10;

/** The most candidates an ambiguous answer lists. */
const MAX_CANDIDATES = 10;

/**
 * What a reading means, from its state against the mean low and high water marks (stateMnwMhw):
 * - `high` (at or above MHW: flood-leaning), `low` (at or below MNW), `normal`;
 * - `gauge-fault`: the state is `commented`, a malfunction; the value may be wrong (see comment);
 * - `out-dated`: the API's own flag, the reading is older than 25 hours: no current reading;
 * - `no-reference`: no MNW/MHW mark to compare with (`unknown`, or no state at all, as on flow
 *   and temperature series and on canal levels in m+NN): no verdict, never "fine";
 * - `no-value`: the gauge sent its placeholder (99999, mapped to null);
 * - `no-reading`: the series has no current measurement;
 * - `no-series`: the station has no series of that name;
 * - `state-not-understood`: a state none of the six the API documents (low, normal, high,
 *   unknown, commented, out-dated), or none at all on a W series, where every reading carries one
 *   (checked live 2026-11-24): the answer changed, and the reading may be high; no verdict.
 */
export type LevelVerdict = "high" | "low" | "normal" | "gauge-fault" | "state-not-understood" | "out-dated" | "no-reference" | "no-value" | "no-reading" | "no-series";

/** The order verdicts are reported in: what needs attention first. */
const VERDICT_RANK: Readonly<Record<LevelVerdict, number>> = {
  high: 0,
  low: 1,
  "gauge-fault": 2,
  "state-not-understood": 3,
  "out-dated": 4,
  normal: 5,
  "no-reference": 6,
  "no-value": 7,
  "no-reading": 8,
  "no-series": 9,
};

/** The states of a reading the API documents (stateMnwMhw). */
const KNOWN_STATES: ReadonlySet<string> = new Set(["low", "normal", "high", "unknown", "commented", "out-dated"]);

/** A gauge, reduced to what names it and places it. */
export interface StationSummary {
  uuid: string;
  number?: string;
  shortname: string;
  longname?: string;
  water?: string;
  km?: number;
  agency?: string;
  longitude?: number;
  latitude?: number;
}

/** The current reading of one series, with its unit and what it means. */
export interface GaugeReading {
  /** The series' shortname: W water level, Q flow, WT water temperature, LT air temperature, … */
  timeseries: string;
  /** The unit of the value, from the series: cm on rivers, m+NN or m+PNP (metres) on canals and reservoirs. */
  unit?: string;
  /** In `unit`; null when the gauge sent no value. */
  value: number | null;
  /** When it was measured, with the German offset as sent (+01:00 in winter, +02:00 in summer). */
  timestamp?: string;
  /** How old the reading is, in minutes; unset for one stamped in the future. */
  ageMinutes?: number;
  /** Older than two hours: not the level now. */
  stale: boolean;
  /** How far ahead of now the reading is stamped, when more than a few minutes: a wrong clock, not the level now. */
  aheadMinutes?: number;
  /** stateMnwMhw as sent (low, normal, high, unknown, commented, out-dated). */
  state?: string;
  /** stateNswHsw as sent: against the lowest and highest navigable water (shipping bounds). */
  shippingState?: string;
  verdict: LevelVerdict;
  /** The operator's note while the gauge is disturbed ("Funktionsstörung, fehlerhafte Messwerte"). */
  comment?: string;
  /** The station's series names, when the asked one is missing. */
  available?: string[];
}

/** A name that names several gauges, with the gauges to choose from by number or uuid. */
export interface AmbiguousStation {
  station: string;
  total: number;
  candidates: StationSummary[];
}

/** The input every reading takes: the clock (tests); unset, the real one. */
export interface ClockInput {
  now?: Date | undefined;
}

/** `value`, folded the way the API's id lookup compares (`roßdorf` finds `ROSSDORF`). */
function fold(value: string): string {
  return normalizeInput(value).toUpperCase();
}

/** `s` without its series: what names and places it. */
export function summaryOf(s: Station): StationSummary {
  return {
    uuid: s.uuid,
    ...(typeof s.number === "string" ? { number: s.number } : {}),
    shortname: s.shortname,
    ...(typeof s.longname === "string" ? { longname: s.longname } : {}),
    ...(typeof s.water?.shortname === "string" ? { water: s.water.shortname } : {}),
    ...(typeof s.km === "number" ? { km: s.km } : {}),
    ...(typeof s.agency === "string" ? { agency: s.agency } : {}),
    ...(typeof s.longitude === "number" ? { longitude: s.longitude } : {}),
    ...(typeof s.latitude === "number" ? { latitude: s.latitude } : {}),
  };
}

/** The series named `name` (any case) of `station`, or undefined. */
function seriesOf(station: Station, name: string): TimeseriesInfo | undefined {
  const wanted = fold(name);
  return (station.timeseries ?? []).find((t) => typeof t.shortname === "string" && fold(t.shortname) === wanted);
}

/**
 * Minutes between `timestamp` and `now` (negative for a time ahead of `now`), or undefined for a
 * text that is no time.
 */
function minutesSince(timestamp: string | undefined, now: Date): number | undefined {
  if (timestamp === undefined) return undefined;
  const ms = Date.parse(timestamp);
  return Number.isFinite(ms) ? Math.round((now.getTime() - ms) / 60_000) : undefined;
}

/**
 * How old a reading stamped `timestamp` is (`ageMinutes`, 0 for one a few minutes ahead: a clock's
 * drift), or how far ahead of `now` it is stamped (`aheadMinutes`, beyond {@link AHEAD_TOLERANCE_MINUTES}).
 */
function ageOf(timestamp: string | undefined, now: Date): { ageMinutes?: number; aheadMinutes?: number } {
  const minutes = minutesSince(timestamp, now);
  if (minutes === undefined) return {};
  if (minutes < -AHEAD_TOLERANCE_MINUTES) return { aheadMinutes: -minutes };
  return { ageMinutes: Math.max(0, minutes) };
}

/** The verdict of a current measurement of the series `series`, from its state (see {@link LevelVerdict}). */
function verdictOf(current: CurrentMeasurement | undefined, series: string): LevelVerdict {
  if (current === undefined) return "no-reading";
  const state = current.stateMnwMhw;
  if (state === "commented") return "gauge-fault";
  if (state === "out-dated") return "out-dated";
  if (current.value === null) return "no-value";
  if (state === "high" || state === "low" || state === "normal") return state as LevelVerdict;
  if (state === undefined ? fold(series) === "W" : !KNOWN_STATES.has(state)) return "state-not-understood";
  return "no-reference";
}

/** The comment of a disturbed series as one text, or undefined. */
function commentOf(series: TimeseriesInfo | undefined): string | undefined {
  const c = series?.comment;
  if (c === undefined || c === null || typeof c.shortDescription !== "string") return undefined;
  const long = typeof c.longDescription === "string" && c.longDescription.trim() !== c.shortDescription.trim() ? c.longDescription.trim() : "";
  return long === "" ? c.shortDescription.trim() : `${c.shortDescription.trim()}: ${long}`;
}

/** True for a forecast series (WV): it has a window and no current reading; its comment names the forecast's source, no fault. */
function isForecast(series: TimeseriesInfo): boolean {
  return typeof series.start === "string" || /^WV$/i.test(series.shortname);
}

/**
 * The series `name` of `station`; a forecast series (WV), which the station lists only when asked
 * for, with one more request.
 */
async function seriesWithForecast(client: PegelOnlineClient, station: Station, name: string): Promise<TimeseriesInfo | undefined> {
  const listed = seriesOf(station, name);
  if (listed !== undefined || !/^WV$/i.test(name)) return listed;
  return seriesOf(await client.stations.get(station.uuid, { includeForecastTimeseries: true }), name);
}

/** The reading of `station`'s series `name`, as the station list embeds it. */
export function readingOf(station: Station, name: string, now: Date): GaugeReading {
  const series = seriesOf(station, name);
  if (series === undefined) {
    const available = (station.timeseries ?? []).map((t) => t.shortname).filter((n): n is string => typeof n === "string");
    return { timeseries: normalizeToken(name), value: null, stale: false, verdict: "no-series", available };
  }
  const current = series.currentMeasurement;
  const { ageMinutes, aheadMinutes } = ageOf(current?.timestamp, now);
  const comment = commentOf(series);
  return {
    timeseries: series.shortname,
    ...(typeof series.unit === "string" ? { unit: series.unit } : {}),
    value: current?.value ?? null,
    ...(current?.timestamp === undefined ? {} : { timestamp: current.timestamp }),
    ...(ageMinutes === undefined ? {} : { ageMinutes }),
    stale: ageMinutes !== undefined && ageMinutes > STALE_AFTER_MINUTES,
    ...(aheadMinutes === undefined ? {} : { aheadMinutes }),
    ...(current?.stateMnwMhw === undefined ? {} : { state: current.stateMnwMhw }),
    ...(current?.stateNswHsw === undefined ? {} : { shippingState: current.stateNswHsw }),
    verdict: verdictOf(current, series.shortname),
    ...(comment === undefined ? {} : { comment }),
  };
}

/** A reading as words: "182 cm, normal", "153 cm reported, gauge fault: …", "no value". */
function readingText(r: GaugeReading): string {
  const level = r.value === null ? "" : `${r.value}${r.unit === undefined ? "" : ` ${r.unit}`}`;
  const age =
    r.aheadMinutes !== undefined
      ? `, stamped ${hoursText(r.aheadMinutes)} ahead of now (a wrong clock at the gauge or here): not the level now`
      : r.stale && r.ageMinutes !== undefined
        ? `, last reading ${hoursText(r.ageMinutes)} old`
        : "";
  switch (r.verdict) {
    case "high":
      return `${level}, high (at or above mean high water)${age}`;
    case "low":
      return `${level}, low (at or below mean low water)${age}`;
    case "normal":
      return `${level}, normal${age}`;
    case "gauge-fault":
      return `gauge fault${r.comment === undefined ? "" : `: ${r.comment}`}${level === "" ? "" : ` (${level} reported, unreliable)`}`;
    case "out-dated":
      return `no current reading (out-dated${r.timestamp === undefined ? "" : `, last ${r.timestamp}`})`;
    case "state-not-understood":
      return `${level}, state ${r.state === undefined ? "missing," : JSON.stringify(r.state)} not understood by this server (PEGELONLINE's answer changed): no verdict, it may be high; check the states' flood services${age}`;
    case "no-reference":
      return `${level}, no flood reference published${age}`;
    case "no-value":
      return "no value (the gauge sent its placeholder)";
    case "no-reading":
      return `no current ${r.timeseries} reading`;
    case "no-series":
      return `no ${r.timeseries} series${r.available === undefined || r.available.length === 0 ? "" : ` (it has ${r.available.join(", ")})`}`;
  }
}

function hoursText(minutes: number): string {
  return minutes < 120 ? `${minutes} min` : `${Math.round(minutes / 6) / 10} h`;
}

/** Why `value` is not a whole number from `min` to `max`, or undefined. */
const within =
  (min: number, max: number): Problem<number> =>
  (value) =>
    Number.isSafeInteger(value) && value >= min && value <= max ? undefined : `Expected a whole number from ${min} to ${max}.`;

/** A series name (W, Q, WT, LT, WV, …), checked: one token, no "/", "." or "..". */
function seriesName(value: string | undefined): string {
  return normalizeToken(assertValid("timeseries", value ?? "W", tokenProblem));
}

/** A station name, number or uuid, checked as the client checks a station path segment. */
function stationName(value: string): string {
  return normalizeInput(assertValid("station", value, stationIdProblem));
}

/** The stations the API's id lookup returned that `selector` names (uuid, number, shortname, longname; any case). */
function named(stations: readonly Station[], selector: string): Station[] {
  const wanted = fold(selector);
  return stations.filter((s) => [s.uuid, s.number, s.shortname, s.longname].some((f) => typeof f === "string" && fold(f) === wanted));
}

/** What {@link lookupStations} found per name. */
interface Lookup {
  found: { selector: string; station: Station; matchedBy: "id" | "name part" }[];
  ambiguous: AmbiguousStation[];
  unmatched: string[];
  /** Names not looked up by a part of the name: `signal` aborted first (a deadline, a cancellation). */
  notRead: string[];
  /** Why `notRead` isn't empty: the error the aborted lookup failed with. */
  stopped?: unknown;
}

/**
 * The stations `selectors` name: one request by id (uuid, number, shortname or longname, any
 * case), then, for a name that matched none, one by a part of the name (the API's fuzzyId). A
 * name that names several stations (NEUSTADT: LEINE and OSTSEE) is `ambiguous`, never picked; a
 * part of a name matching several is too. `includeCurrent` embeds the series and their current
 * readings, `includeSeries` the series alone. Once `signal` has aborted (the caller's deadline or
 * cancellation), a lookup by a part of a name that fails, and those after it, are `notRead`: the
 * names already found are kept.
 */
async function lookupStations(client: PegelOnlineClient, selectors: readonly string[], embed: "current" | "series", signal?: AbortSignal): Promise<Lookup> {
  const includes = embed === "current" ? { includeCurrentMeasurement: true } : { includeTimeseries: true };
  const listed = await client.stations.list({ ids: [...selectors], ...includes });
  const lookup: Lookup = { found: [], ambiguous: [], unmatched: [], notRead: [] };
  for (const selector of selectors) {
    let matches = named(listed, selector);
    let matchedBy: "id" | "name part" = "id";
    if (matches.length === 0) {
      if (lookup.notRead.length > 0) {
        lookup.notRead.push(selector);
        continue;
      }
      try {
        matches = await client.stations.list({ fuzzyId: selector, ...includes });
      } catch (err) {
        if (signal?.aborted !== true) throw err;
        lookup.notRead.push(selector);
        lookup.stopped = err;
        continue;
      }
      matchedBy = "name part";
    }
    if (matches.length === 1) lookup.found.push({ selector, station: matches[0] as Station, matchedBy });
    else if (matches.length === 0) lookup.unmatched.push(selector);
    else lookup.ambiguous.push({ station: selector, total: matches.length, candidates: matches.slice(0, MAX_CANDIDATES).map(summaryOf) });
  }
  return lookup;
}

/** The reason for a name that names no gauge. */
function unmatchedReason(names: readonly string[]): string {
  return `No PEGELONLINE gauge has the id, number, name or a name containing ${names.map((n) => JSON.stringify(n)).join(", ")}. Use the German place name as the gauge is called (KÖLN, not Cologne; DRESDEN), a part of it, or the station's number; listStations finds gauges by water or name part. Not every place has a federal waterway gauge.`;
}

// ---- waters ---------------------------------------------------------------------------------

/** English and common names of waters, folded, to their PEGELONLINE shortname. */
const WATER_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  RHINE: "RHEIN",
  DANUBE: "DONAU",
  MOSELLE: "MOSEL",
  "LAKE CONSTANCE": "BODENSEE",
  "BALTIC SEA": "OSTSEE",
  BALTIC: "OSTSEE",
  "NORTH SEA": "NORDSEE",
  "KIEL CANAL": "NOK",
  "NORD-OSTSEE-KANAL": "NOK",
  MITTELLANDKANAL: "MLK",
  "MITTELLAND CANAL": "MLK",
  "DORTMUND-EMS-KANAL": "DEK",
  "DORTMUND-EMS CANAL": "DEK",
});

/** The answer of {@link resolveWater}. */
export type WaterLookup =
  | { status: "ok"; water: Water; matchedBy: "shortname" | "longname" | "alias" | "name part" }
  | { status: "ambiguous"; total: number; candidates: Water[] }
  | { status: "empty"; reason: string };

/**
 * The water a name means: its shortname (RHEIN, MLK) or longname (MITTELLANDKANAL), an English
 * name (Rhine, Danube, Moselle), any case; else the waters whose name contains it: one is the
 * answer, several are `ambiguous`. `--waters` filters by the shortname only, so "Rhine" sent as it
 * stands gave an empty river.
 */
export async function resolveWater(client: PegelOnlineClient, name: string): Promise<WaterLookup> {
  const wanted = fold(assertValid("water", name, textProblem));
  const waters = await client.waters();
  if (waters.length === 0) return { status: "empty", reason: NO_WATERS };
  const by = (pick: (w: Water) => string): Water | undefined => waters.find((w) => fold(pick(w)) === wanted);
  const short = by((w) => w.shortname);
  if (short !== undefined) return { status: "ok", water: short, matchedBy: "shortname" };
  const long = by((w) => w.longname);
  if (long !== undefined) return { status: "ok", water: long, matchedBy: "longname" };
  const alias = WATER_ALIASES[wanted];
  const aliased = alias === undefined ? undefined : waters.find((w) => w.shortname === alias);
  if (aliased !== undefined) return { status: "ok", water: aliased, matchedBy: "alias" };
  const parts = waters.filter((w) => fold(w.shortname).includes(wanted) || fold(w.longname).includes(wanted));
  if (parts.length === 1) return { status: "ok", water: parts[0] as Water, matchedBy: "name part" };
  if (parts.length > 1) return { status: "ambiguous", total: parts.length, candidates: parts.slice(0, 25) };
  return {
    status: "empty",
    reason: `No PEGELONLINE water is called ${JSON.stringify(name)} or has it in its name. Waters go by their German names (RHEIN, DONAU, MOSEL, ELBE, WESER, MAIN; canals by short codes: MLK Mittellandkanal, DEK Dortmund-Ems-Kanal); listWaters lists all about 100.`,
  };
}

/** The reason when waters.json is an empty list. */
const NO_WATERS = "PEGELONLINE listed no waters at all: the service may be in trouble; try again later.";

/** The input of {@link listWaters}. */
export interface ListWatersInput {
  /** A part of the shortname or longname; unset, every water. */
  name?: string | undefined;
}

/** The answer of {@link listWaters}. */
export type WaterList =
  | { status: "ok"; searched: { name?: string }; total: number; waters: Water[] }
  | { status: "empty"; searched: { name?: string }; reason: string };

/** The waters PEGELONLINE covers (about 100), optionally those whose name contains `name`. */
export async function listWaters(client: PegelOnlineClient, input: ListWatersInput = {}): Promise<WaterList> {
  const name = input.name === undefined ? undefined : normalizeInput(assertValid("name", input.name, textProblem));
  const searched = name === undefined ? {} : { name };
  const all = await client.waters();
  if (all.length === 0) return { status: "empty", searched, reason: NO_WATERS };
  const waters = name === undefined ? all : all.filter((w) => fold(w.shortname).includes(fold(name)) || fold(w.longname).includes(fold(name)));
  if (waters.length === 0) return { status: "empty", searched, reason: `No water's name contains ${JSON.stringify(name)}. Waters go by their German names (RHEIN, not Rhine); list them all without a name.` };
  return { status: "ok", searched, total: waters.length, waters };
}

// ---- water levels ---------------------------------------------------------------------------

/** The input of {@link getWaterLevels}. */
export interface WaterLevelsInput extends ClockInput {
  /** 1–10 gauges: shortname (BONN, KÖLN), longname, number, uuid, or a part of the name. */
  stations: readonly string[];
  /** The series: W water level (default), Q flow, WT water temperature, LT air temperature. */
  timeseries?: string | undefined;
  /**
   * The caller's deadline or cancellation: once it aborts, the names not yet looked up are
   * answered as `notRead`, with the readings found so far.
   */
  signal?: AbortSignal | undefined;
}

/** One gauge's reading. */
export interface StationReading {
  /** The name as asked. */
  asked: string;
  /** How the name was found: by id (uuid, number, shortname, longname) or as a part of a name. */
  matchedBy: "id" | "name part";
  station: StationSummary;
  reading: GaugeReading;
  /** The reading in words. */
  text: string;
}

/** The answer of {@link getWaterLevels}. */
export interface WaterLevels {
  /** ok: at least one reading; ambiguous: no reading, a name names several gauges; empty: no name matched. */
  status: "ok" | "ambiguous" | "empty";
  searched: { stations: string[]; timeseries: string };
  verdict: string;
  /** What needs attention first (high, low, gauge fault, out-dated), then the rest, as asked. */
  readings: StationReading[];
  /** Names that name several gauges: ask which one, then call again with its number. */
  ambiguous: AmbiguousStation[];
  /** Names that name no gauge. */
  unmatched: string[];
  /** Names not looked up: the caller's deadline or cancellation came first (ask for them again). */
  notRead: string[];
  reason?: string;
}

/**
 * The live reading at named gauges, with the unit read from the series, the time, how old it is,
 * and a verdict from stateMnwMhw. One request for every name given by id, one more per name
 * matched only as a part of a name. A name naming several gauges is reported, never picked; a
 * gauge named in several forms is read once (`asked` is the first form).
 */
export async function getWaterLevels(client: PegelOnlineClient, input: WaterLevelsInput): Promise<WaterLevels> {
  if (!Array.isArray(input.stations) || input.stations.length === 0 || input.stations.length > MAX_STATIONS) {
    throw new PegelValidationError(`Invalid stations: expected 1 to ${MAX_STATIONS} gauge names, numbers or uuids.`);
  }
  const stations = [...new Set(input.stations.map(stationName))];
  const timeseries = seriesName(input.timeseries);
  const now = input.now ?? new Date();
  const searched = { stations, timeseries };
  const lookup = await lookupStations(client, stations, "current", input.signal);
  // Nothing read before the deadline: the deadline's error, not an empty answer.
  if (lookup.notRead.length > 0 && lookup.found.length === 0 && lookup.ambiguous.length === 0) throw lookup.stopped;
  // One gauge named in several forms (its number, its name in two cases, its uuid) is read once.
  const seen = new Set<string>();
  const readings = lookup.found
    .filter(({ station }) => {
      if (seen.has(station.uuid)) return false;
      seen.add(station.uuid);
      return true;
    })
    .map(({ selector, station, matchedBy }): StationReading => {
      const reading = readingOf(station, timeseries, now);
      return { asked: selector, matchedBy, station: summaryOf(station), reading, text: `${station.shortname}: ${readingText(reading)}` };
    })
    .sort((a, b) => VERDICT_RANK[a.reading.verdict] - VERDICT_RANK[b.reading.verdict]);
  const status = readings.length > 0 ? "ok" : lookup.ambiguous.length > 0 ? "ambiguous" : "empty";
  const parts: string[] = [];
  if (readings.length > 0) parts.push(readings.map((r) => r.text).join("; "));
  if (lookup.ambiguous.length > 0) parts.push(`${lookup.ambiguous.map((a) => `${JSON.stringify(a.station)} names ${a.total} gauges`).join(", ")}: ask which one, then use its number`);
  if (lookup.unmatched.length > 0) parts.push(`no gauge for ${lookup.unmatched.map((n) => JSON.stringify(n)).join(", ")}`);
  const stale = readings.filter((r) => r.reading.stale).length;
  if (lookup.notRead.length > 0) {
    const one = lookup.notRead.length === 1;
    parts.push(`${lookup.notRead.map((n) => JSON.stringify(n)).join(", ")} not looked up: the call's time ran out (or it was cancelled) first; ask for ${one ? "it" : "them"} again`);
  }
  if (stale > 0) parts.push(`${stale} reading${stale === 1 ? " is" : "s are"} more than two hours old: not the level now`);
  const future = readings.filter((r) => r.reading.aheadMinutes !== undefined).length;
  if (future > 0) parts.push(`${future} reading${future === 1 ? " is" : "s are"} stamped in the future: not the level now`);
  return {
    status,
    searched,
    verdict: `${parts.join(". ")}.`,
    readings,
    ambiguous: lookup.ambiguous,
    unmatched: lookup.unmatched,
    notRead: lookup.notRead,
    ...(status === "empty" ? { reason: unmatchedReason(lookup.unmatched) } : {}),
  };
}

// ---- trend ----------------------------------------------------------------------------------

/** The input of {@link getLevelTrend}. */
export interface LevelTrendInput extends ClockInput {
  /** One gauge: shortname, longname, number, uuid or a part of the name. */
  station: string;
  /** The series (default W). */
  timeseries?: string | undefined;
  /** An ISO-8601 period back from now (P7D, PT6H) or an instant; default P7D. */
  start?: string | undefined;
  /** An ISO-8601 instant; default now. */
  end?: string | undefined;
  /** How many evenly spaced points to return for a chart (0–200, default 0). */
  points?: number | undefined;
}

/** A value and when it was measured. */
export interface Point {
  timestamp: string;
  value: number;
}

/** The answer of {@link getLevelTrend}. */
export type LevelTrend =
  | {
      status: "ok";
      searched: { station: string; timeseries: string; start: string; end?: string };
      station: StationSummary;
      series: { shortname: string; longname?: string; unit?: string; comment?: string };
      verdict: string;
      /**
       * last against first: rising, falling or steady; `peaked` when the level rose to its maximum
       * and has fallen clearly since, `bottomed` when it fell to its minimum and has risen clearly
       * since (`since` says by how much): first against last alone said "rising" after a crest;
       * `oscillating` when it swings up and down again and again (a tide gauge, a regulated
       * water): first against last is then wherever the tide was (`swings` has the highs and lows).
       */
      direction: "rising" | "falling" | "steady" | "peaked" | "bottomed" | "oscillating";
      /** last − first, in the unit. */
      delta: number;
      /** After a turn (direction peaked or bottomed): the move since the peak or low. */
      since?: { direction: "rising" | "falling"; from: Point; delta: number; ratePerDay: number | null };
      /** When the level oscillates: how often it turned, and its first and last high and low waters. */
      swings?: Swings;
      /** delta per day over the span of the points; null for a single point. */
      ratePerDay: number | null;
      first: Point;
      last: Point & { ageMinutes: number | undefined; stale: boolean; aheadMinutes?: number };
      min: Point;
      max: Point;
      range: number;
      /** The window the API sent (it keeps about 31 days and clamps a longer one). */
      window: { from: string; to: string; points: number; missing: number };
      /** True while the series carries an operator's comment: the values may be wrong. */
      unreliable: boolean;
      /** Evenly spaced points for a chart, when asked for. */
      sample?: Point[];
      notes: string[];
    }
  | { status: "ambiguous"; searched: { station: string; timeseries: string; start: string; end?: string }; total: number; candidates: StationSummary[] }
  | { status: "empty"; searched: { station: string; timeseries: string; start: string; end?: string }; station?: StationSummary; reason: string };

/** A window that rose or fell by less than a tenth of its range is steady. */
const STEADY_SHARE = 0.1;

/** A move back from the window's latest extreme of at least this share of the range is a turn. */
const TURN_SHARE = 0.25;

/** The smallest move that counts as one at a level gauge, in its unit (cm, or metres: m+NN, m+PNP); 0 for other units. */
function levelFloor(unit: string, cm: number): number {
  if (unit === "cm") return cm;
  return /^m(\+|$)/.test(unit) ? cm / 100 : 0;
}

/**
 * The turn in `points` (oldest first) since the window's latest extreme: the last time it was at
 * its maximum or minimum, when that is not the last point and the level has moved back from it by
 * at least TURN_SHARE of the range (and a few cm at a level gauge: noise on a flat river is no
 * turn). Undefined without one.
 */
function turnOf(points: readonly Point[], range: number, unit: string): { extreme: "peak" | "low"; at: Point } | undefined {
  if (points.length < 3 || range === 0) return undefined;
  let hi = 0;
  let lo = 0;
  points.forEach((p, i) => {
    if (p.value >= (points[hi] as Point).value) hi = i;
    if (p.value <= (points[lo] as Point).value) lo = i;
  });
  const at = Math.max(hi, lo);
  if (at === points.length - 1) return undefined;
  const moved = Math.abs((points[points.length - 1] as Point).value - (points[at] as Point).value);
  if (moved < Math.max(TURN_SHARE * range, levelFloor(unit, 5))) return undefined;
  return { extreme: at === hi ? "peak" : "low", at: points[at] as Point };
}

/** The swings of an oscillating level: how often it turned, its first and last highs and lows. */
export interface Swings {
  turns: number;
  highs: { first: Point; last: Point };
  lows: { first: Point; last: Point };
}

/** A level that turns this often in a window, each swing a large share of the range, oscillates. */
const MIN_TURNS = 4;
/** A swing counts when it is at least this share of the range (and 20 cm at a level gauge). */
const SWING_SHARE = 0.3;

/**
 * The swings of `points` (oldest first) when the level oscillates: a zigzag over the points that
 * counts a high or a low once the level has moved back from it by SWING_SHARE of the range (and at
 * least 20 cm at a level gauge, so noise on a flat river doesn't count); MIN_TURNS of them or more
 * is a tide (the lower Elbe and Weser, the coasts: 300-400 cm twice a day) or a regulated water.
 * One linear pass. Undefined when the level doesn't oscillate.
 */
function swingsOf(points: readonly Point[], range: number, unit: string): Swings | undefined {
  const step = Math.max(SWING_SHARE * range, levelFloor(unit, 20));
  if (points.length < 3 || range < step) return undefined;
  const turns: { kind: "high" | "low"; at: Point }[] = [];
  let dir = 0;
  let hi = points[0] as Point;
  let lo = points[0] as Point;
  for (const p of points) {
    if (dir >= 0 && p.value >= hi.value) hi = p;
    if (dir <= 0 && p.value <= lo.value) lo = p;
    if (dir === 0) {
      if (hi.value - lo.value >= step) dir = Date.parse(hi.timestamp) > Date.parse(lo.timestamp) ? 1 : -1;
    } else if (dir === 1 && hi.value - p.value >= step) {
      turns.push({ kind: "high", at: hi });
      dir = -1;
      lo = p;
    } else if (dir === -1 && p.value - lo.value >= step) {
      turns.push({ kind: "low", at: lo });
      dir = 1;
      hi = p;
    }
  }
  const highs = turns.filter((t) => t.kind === "high").map((t) => t.at);
  const lows = turns.filter((t) => t.kind === "low").map((t) => t.at);
  if (turns.length < MIN_TURNS || highs.length === 0 || lows.length === 0) return undefined;
  const pick = (list: Point[]) => ({ first: { ...(list[0] as Point) }, last: { ...(list[list.length - 1] as Point) } });
  return { turns: turns.length, highs: pick(highs), lows: pick(lows) };
}

/** Days between two times, or NaN. */
function daysBetween(from: string, to: string): number {
  return (Date.parse(to) - Date.parse(from)) / 86_400_000;
}

/**
 * The trend at one gauge over a window: direction, delta, rate per day, extremes, the last
 * reading's age; the points without a value (the placeholder 99999) dropped and counted. The unit
 * and any operator comment come from the series (one request: the station with its series), the
 * points from a second. A window outside the ~31 days kept is `empty` with the reason; a period
 * the API can't read is its HTTP 400.
 */
export async function getLevelTrend(client: PegelOnlineClient, input: LevelTrendInput): Promise<LevelTrend> {
  const station = stationName(input.station);
  const timeseries = seriesName(input.timeseries);
  const start = normalizeInput(assertValid("start", input.start ?? "P7D", tokenProblem));
  const end = input.end === undefined ? undefined : normalizeInput(assertValid("end", input.end, tokenProblem));
  const points = assertValid("points", input.points ?? 0, within(0, 200));
  const now = input.now ?? new Date();
  const searched = { station, timeseries, start, ...(end === undefined ? {} : { end }) };
  const lookup = await lookupStations(client, [station], "series");
  const hit = lookup.found[0];
  if (hit === undefined) {
    const many = lookup.ambiguous[0];
    if (many !== undefined) return { status: "ambiguous", searched, total: many.total, candidates: many.candidates };
    return { status: "empty", searched, reason: unmatchedReason([station]) };
  }
  const summary = summaryOf(hit.station);
  const series = await seriesWithForecast(client, hit.station, timeseries);
  if (series === undefined) {
    const has = (hit.station.timeseries ?? []).map((t) => t.shortname).join(", ");
    return { status: "empty", searched, station: summary, reason: `${hit.station.shortname} has no ${timeseries} series${has === "" ? "" : `; it has ${has}`}.` };
  }
  const all = await windowOf(client, hit.station, series.shortname, start, end);
  if (typeof all === "string") return { status: "empty", searched, station: summary, reason: all };
  const valued = all.filter((m): m is Measurement & { value: number } => typeof m.value === "number");
  const missing = all.length - valued.length;
  if (valued.length === 0) {
    const reason =
      all.length === 0
        ? `No measurement of ${hit.station.shortname} ${series.shortname} in the window from ${start}${end === undefined ? "" : ` to ${end}`}. PEGELONLINE keeps only about the last 31 days; ask for a recent period such as P7D.`
        : `${hit.station.shortname} ${series.shortname} sent no value in the window (${missing} points without one): no trend to report.`;
    return { status: "empty", searched, station: summary, reason };
  }
  const first = valued[0] as Point;
  const lastPoint = valued[valued.length - 1] as Point;
  let min = first;
  let max = first;
  for (const p of valued) {
    if (p.value < min.value) min = p;
    if (p.value > max.value) max = p;
  }
  const delta = round(lastPoint.value - first.value);
  const range = round(max.value - min.value);
  const overall = delta === 0 || Math.abs(delta) <= STEADY_SHARE * range ? "steady" : delta > 0 ? "rising" : "falling";
  const days = daysBetween(first.timestamp, lastPoint.timestamp);
  const ratePerDay = Number.isFinite(days) && days > 0 ? round(delta / days) : null;
  const unit = typeof series.unit === "string" ? series.unit : "";
  // A turn against the overall direction (a crest after a rise, a low after a fall, or either in a
  // window that came back to where it began) is what the level does now.
  const swings = swingsOf(valued, range, unit);
  const turn = swings === undefined ? turnOf(valued, range, unit) : undefined;
  const turned = turn !== undefined && (turn.extreme === "peak" ? overall !== "falling" : overall !== "rising") ? turn : undefined;
  const direction = swings !== undefined ? "oscillating" : turned === undefined ? overall : turned.extreme === "peak" ? "peaked" : "bottomed";
  const since =
    turned === undefined
      ? undefined
      : (() => {
          const moved = round(lastPoint.value - turned.at.value);
          const span = daysBetween(turned.at.timestamp, lastPoint.timestamp);
          return { direction: moved > 0 ? ("rising" as const) : ("falling" as const), from: { timestamp: turned.at.timestamp, value: turned.at.value }, delta: moved, ratePerDay: Number.isFinite(span) && span > 0 ? round(moved / span) : null };
        })();
  const { ageMinutes, aheadMinutes } = ageOf(lastPoint.timestamp, now);
  const stale = ageMinutes !== undefined && ageMinutes > STALE_AFTER_MINUTES;
  const comment = commentOf(series);
  const forecast = isForecast(series);
  const fault = comment !== undefined && !forecast;
  const notes: string[] = [];
  if (fault) notes.push(`The gauge reports a fault: ${comment}. The values may be wrong; present the trend as unreliable.`);
  if (forecast && comment !== undefined) notes.push(`About the forecast: ${comment}`);
  if (missing > 0) notes.push(`${missing} of ${all.length} points had no value (the gauge's placeholder) and were left out.`);
  if (stale && ageMinutes !== undefined && !forecast) notes.push(`The last reading is ${hoursText(ageMinutes)} old: the gauge is lagging; this is not the level now.`);
  if (aheadMinutes !== undefined && !forecast) notes.push(`The last reading is stamped ${hoursText(aheadMinutes)} ahead of now: a wrong clock at the gauge or here; the window's times are not to be trusted.`);
  if (unit !== "" && unit !== "cm") notes.push(`The unit is ${unit}, not cm: a change of 0.02 is 2 cm.`);
  if (forecast) notes.push("WV is a forecast series: its points are forecasts and estimates, not measurements.");
  if (swings !== undefined) notes.push(`The level turned ${swings.turns} times in the window (a tide, or a regulated water): the first and the last point are wherever it was in a swing. For a trend, compare the high waters with each other, and the low waters (swings), not first and last.`);
  const u = unit === "" ? "" : ` ${unit}`;
  const by = `${Math.abs(delta)}${u}`;
  const head =
    swings !== undefined
      ? `swings up and down, ${swings.turns} turns from ${first.timestamp} to ${lastPoint.timestamp} (a tide, or a regulated water): ` +
        `high waters from ${swings.highs.first.value} to ${swings.highs.last.value}${u}, low waters from ${swings.lows.first.value} to ${swings.lows.last.value}${u}; first against last says nothing about a trend`
      : since !== undefined
      ? `${since.direction} ${Math.abs(since.delta)}${u} since its ${direction === "peaked" ? "peak" : "low"} of ${since.from.value}${u} at ${since.from.timestamp}` +
        `${since.ratePerDay === null ? "" : ` (${Math.abs(since.ratePerDay)}${u}/day)`}; over the window from ${first.timestamp} to ${lastPoint.timestamp} ` +
        (overall === "steady" ? `back where it began (${delta >= 0 ? "+" : "-"}${by})` : `${overall === "rising" ? "up" : "down"} ${by}`)
      : (direction === "steady" ? `steady (${delta >= 0 ? "+" : "-"}${by})` : `${direction} ${by}`) +
        ` from ${first.timestamp} to ${lastPoint.timestamp}` +
        `${ratePerDay === null || direction === "steady" ? "" : ` (${Math.abs(ratePerDay)}${u}/day)`}`;
  const verdict =
    `${hit.station.shortname}${summary.water === undefined ? "" : ` (${summary.water})`} ${series.shortname}: ` +
    head +
    `; range ${min.value}–${max.value}${u}` +
    `${stale && ageMinutes !== undefined && !forecast ? `; last reading ${hoursText(ageMinutes)} old` : ""}${fault ? "; gauge fault, unreliable" : ""}.`;
  return {
    status: "ok",
    searched,
    station: summary,
    series: { shortname: series.shortname, ...(typeof series.longname === "string" ? { longname: series.longname } : {}), ...(unit === "" ? {} : { unit }), ...(comment === undefined ? {} : { comment }) },
    verdict,
    direction,
    delta,
    ratePerDay,
    ...(since === undefined ? {} : { since }),
    ...(swings === undefined ? {} : { swings }),
    first: { timestamp: first.timestamp, value: first.value },
    last: { timestamp: lastPoint.timestamp, value: lastPoint.value, ageMinutes, stale, ...(aheadMinutes === undefined || forecast ? {} : { aheadMinutes }) },
    min: { timestamp: min.timestamp, value: min.value },
    max: { timestamp: max.timestamp, value: max.value },
    range,
    window: { from: (all[0] as Measurement).timestamp, to: (all[all.length - 1] as Measurement).timestamp, points: all.length, missing },
    unreliable: fault,
    ...(points > 0 ? { sample: sampleOf(valued, points) } : {}),
    notes,
  };
}

/** Values to a hundredth: 0.1 + 0.2 is 0.3, not 0.30000000000000004. */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/** `count` points spread evenly over `points`, the first and the last among them. */
function sampleOf(points: readonly Point[], count: number): Point[] {
  if (points.length <= count) return points.map((p) => ({ timestamp: p.timestamp, value: p.value }));
  if (count === 1) {
    const last = points[points.length - 1] as Point;
    return [{ timestamp: last.timestamp, value: last.value }];
  }
  return Array.from({ length: count }, (_, i) => {
    const p = points[Math.round((i * (points.length - 1)) / (count - 1))] as Point;
    return { timestamp: p.timestamp, value: p.value };
  });
}

// ---- river overview -------------------------------------------------------------------------

/**
 * How each water's km run (checked 2026-09-15): 1 grows downstream (source to mouth ascending), -1
 * counts down towards the mouth or up from it (source to mouth descending), "weser" two chainages.
 */
const FLOW: Readonly<Record<string, 1 | -1 | "weser">> = Object.freeze({
  RHEIN: 1,
  ELBE: 1,
  DONAU: -1,
  MOSEL: -1,
  MAIN: -1,
  NECKAR: -1,
  SAAR: -1,
  WESER: "weser",
});

/** What the order of a river's table means. */
function flowNote(water: string): string {
  const flow = FLOW[water];
  if (flow === 1) return `Ordered source to mouth: ${water}'s km grow downstream.`;
  if (flow === -1) return `Ordered source to mouth: ${water}'s km count ${water === "DONAU" ? "down towards the mouth" : "up from the mouth"}, so the km fall down the table.`;
  if (flow === "weser") return "Two chainages: the upper Weser (Hann. Münden to the Bremen weir, km 0.65–362.8) first, then the lower Weser below the weir (km 0–115), each downstream.";
  return `The direction of ${water}'s km is not known here: ordered by ascending km, which may run upstream.`;
}

/** A gauge of the WESER on the upper chainage: the offices of Hann. Münden and Verden, and Bremen's gauges at km 355 and above. */
function upperWeser(s: Station): boolean {
  return /M(Ü|UE)NDEN|VERDEN/i.test(s.agency ?? "") || (typeof s.km === "number" && s.km >= 355);
}

/** One gauge of a river overview. */
export interface RiverGauge {
  km?: number;
  /** WESER only: the chainage (upper above the Bremen weir, lower below it). */
  section?: "upper" | "lower";
  station: StationSummary;
  reading: GaugeReading;
}

/** The input of {@link getRiverOverview}. */
export interface RiverOverviewInput extends ClockInput {
  /** The water: shortname (RHEIN), longname, English name (Rhine) or a part of the name. */
  water: string;
  /** The series (default W). */
  timeseries?: string | undefined;
}

/** How many gauges have each verdict, how many readings are stale, and how many are stamped in the future. */
export type VerdictCounts = Record<LevelVerdict, number> & { stale: number; future: number };

/** The answer of {@link getRiverOverview}. */
export type RiverOverview =
  | {
      status: "ok";
      searched: { water: string; timeseries: string };
      water: Water;
      verdict: string;
      order: string;
      total: number;
      counts: VerdictCounts;
      /** The time most readings share. */
      asOf?: string;
      /** The gauges not normal: high, then low, then faults and out-dated ones. */
      attention: { shortname: string; km?: number; text: string }[];
      gauges: RiverGauge[];
      notes: string[];
    }
  | { status: "ambiguous"; searched: { water: string; timeseries: string }; total: number; candidates: Water[] }
  | { status: "empty"; searched: { water: string; timeseries: string }; water?: Water; reason: string };

/**
 * Every gauge on one water with its live reading, in flow order by river kilometre (each river's
 * km run their own way; the WESER has two chainages), the ones needing attention counted and listed
 * first. Two requests: the waters (to resolve the name) and the stations with their readings.
 */
export async function getRiverOverview(client: PegelOnlineClient, input: RiverOverviewInput): Promise<RiverOverview> {
  const timeseries = seriesName(input.timeseries);
  const searched = { water: normalizeInput(assertValid("water", input.water, textProblem)), timeseries };
  const now = input.now ?? new Date();
  const found = await resolveWater(client, searched.water);
  if (found.status === "ambiguous") return { status: "ambiguous", searched, total: found.total, candidates: found.candidates };
  if (found.status === "empty") return { status: "empty", searched, reason: found.reason };
  const water = found.water;
  const stations = await client.stations.list({ waters: water.shortname, includeCurrentMeasurement: true });
  if (stations.length === 0) return { status: "empty", searched, water, reason: `PEGELONLINE lists no gauge on ${water.shortname} (${water.longname}).` };
  const gauges = orderAlong(water.shortname, stations).map((s): RiverGauge => ({
    ...(typeof s.km === "number" ? { km: s.km } : {}),
    ...(water.shortname === "WESER" ? { section: upperWeser(s) ? "upper" : "lower" } : {}),
    station: summaryOf(s),
    reading: readingOf(s, timeseries, now),
  }));
  const counts = countVerdicts(gauges.map((g) => g.reading));
  const attention = gauges
    .filter((g) => VERDICT_RANK[g.reading.verdict] < VERDICT_RANK.normal)
    .sort((a, b) => VERDICT_RANK[a.reading.verdict] - VERDICT_RANK[b.reading.verdict])
    .map((g) => ({ shortname: g.station.shortname, ...(g.km === undefined ? {} : { km: g.km }), text: readingText(g.reading) }));
  const asOf = mostCommon(gauges.map((g) => g.reading.timestamp));
  const notes: string[] = [];
  const noKm = gauges.filter((g) => g.km === undefined).map((g) => g.station.shortname);
  if (noKm.length > 0) notes.push(`Without a river kilometre, at the end: ${noKm.join(", ")}.`);
  const units = [...new Set(gauges.map((g) => g.reading.unit).filter((u): u is string => u !== undefined))];
  if (units.length > 1) notes.push(`The readings come in ${units.join(", ")}: never compare values across units (m+NN is a height above sea level in metres, not a depth).`);
  const named_ = (verdict: LevelVerdict): string => gauges.filter((g) => g.reading.verdict === verdict).map((g) => g.station.shortname).join(", ");
  // The gauges without a verdict are counted too: "no gauge at high or low water" for a river where
  // a third have no flood reference (or a canal where none has) read as all normal.
  const unjudged = counts["no-reference"] + counts["no-series"] + counts["no-value"] + counts["no-reading"];
  const judged = counts.high + counts.low + counts.normal;
  const none = counts.high + counts.low === 0 && counts["state-not-understood"] === 0;
  const verdict =
    `${water.shortname}: ${gauges.length} gauge${gauges.length === 1 ? "" : "s"}, ${counts.high} high${counts.high > 0 ? ` (${named_("high")})` : ""}, ${counts.low} low${counts.low > 0 ? ` (${named_("low")})` : ""}` +
    `${unjudged > 0 ? `, ${unjudged} without a verdict (no flood reference, series or value: never call them normal)` : ""}` +
    `${counts["gauge-fault"] > 0 ? `, ${counts["gauge-fault"]} with a gauge fault` : ""}${counts["state-not-understood"] > 0 ? `, ${counts["state-not-understood"]} with a state not understood (no verdict)` : ""}` +
    `${counts["out-dated"] > 0 ? `, ${counts["out-dated"]} without a current reading` : ""}` +
    `${counts.stale > 0 ? `, ${counts.stale} stale (over two hours old)` : ""}${counts.future > 0 ? `, ${counts.future} stamped in the future (a wrong clock)` : ""}` +
    `${!none ? "" : judged === 0 ? "; none could be judged" : unjudged > 0 ? `; no gauge at high or low water among the ${judged} judged` : "; no gauge at high or low water"}.`;
  return { status: "ok", searched, water, verdict, order: flowNote(water.shortname), total: gauges.length, counts, ...(asOf === undefined ? {} : { asOf }), attention, gauges, notes };
}

/** `stations` in flow order (see {@link FLOW}); those without km at the end. */
function orderAlong(water: string, stations: readonly Station[]): Station[] {
  const flow = FLOW[water];
  const km = (s: Station): number => (typeof s.km === "number" ? s.km : Number.NaN);
  const byKm = (dir: 1 | -1) => (a: Station, b: Station) => {
    const [x, y] = [km(a), km(b)];
    if (Number.isNaN(x) || Number.isNaN(y)) return Number.isNaN(x) ? (Number.isNaN(y) ? 0 : 1) : -1;
    return (x - y) * dir;
  };
  if (flow === "weser") {
    const upper = stations.filter((s) => upperWeser(s) || typeof s.km !== "number");
    const lower = stations.filter((s) => !upper.includes(s));
    const withKm = (list: Station[]) => list.filter((s) => typeof s.km === "number").sort(byKm(1));
    return [...withKm(upper), ...withKm(lower), ...stations.filter((s) => typeof s.km !== "number")];
  }
  return [...stations].sort(byKm(flow === -1 ? -1 : 1));
}

function countVerdicts(readings: readonly GaugeReading[]): VerdictCounts {
  const counts = Object.fromEntries(Object.keys(VERDICT_RANK).map((k) => [k, 0])) as Record<LevelVerdict, number>;
  for (const r of readings) counts[r.verdict] += 1;
  return { ...counts, stale: readings.filter((r) => r.stale).length, future: readings.filter((r) => r.aheadMinutes !== undefined).length };
}

function mostCommon(values: readonly (string | undefined)[]): string | undefined {
  const seen = new Map<string, number>();
  for (const v of values) if (v !== undefined) seen.set(v, (seen.get(v) ?? 0) + 1);
  let best: string | undefined;
  for (const [v, n] of seen) if (best === undefined || n > (seen.get(best) ?? 0)) best = v;
  return best;
}

// ---- stations, as a list and as a map ---------------------------------------------------------

/** How a station list is narrowed: one of water, stations or name. */
export interface StationFilter {
  /** A water: shortname, longname, English name or a part of the name. */
  water?: string | undefined;
  /** Gauges by shortname, longname, number or uuid (1–50). */
  stations?: readonly string[] | undefined;
  /** A part of the gauge's name (the API's fuzzy match). */
  name?: string | undefined;
}

/** What a station list was asked for, as the answers report it. */
export interface StationSearch {
  water?: string;
  stations?: string[];
  name?: string;
}

/** The stations a filter selects, or why there are none. */
type Selection =
  | { status: "ok"; searched: StationSearch; water?: Water; stations: Station[]; notes: string[] }
  | { status: "ambiguous"; searched: StationSearch; total: number; candidates: Water[] }
  | { status: "empty"; searched: StationSearch; reason: string };

/**
 * The stations `filter` selects, with the series and current readings when `current`. More than
 * one filter at a time is refused (the API's combination of them is undocumented). A name in
 * `stations` that matches none, or that several gauges carry, is said in `notes`.
 */
async function selectStations(client: PegelOnlineClient, filter: StationFilter, current: boolean): Promise<Selection> {
  const given = (["water", "stations", "name"] as const).filter((k) => filter[k] !== undefined);
  if (given.length > 1) throw new PegelValidationError(`Invalid filter: give one of water, stations or name, not ${given.join(" and ")}.`);
  const includes = current ? { includeCurrentMeasurement: true } : {};
  if (filter.water !== undefined) {
    const searched = { water: normalizeInput(assertValid("water", filter.water, textProblem)) };
    const found = await resolveWater(client, searched.water);
    if (found.status === "ambiguous") return { status: "ambiguous", searched, total: found.total, candidates: found.candidates };
    if (found.status === "empty") return { status: "empty", searched, reason: found.reason };
    const stations = await client.stations.list({ waters: found.water.shortname, ...includes });
    if (stations.length === 0) return { status: "empty", searched, reason: `PEGELONLINE lists no gauge on ${found.water.shortname} (${found.water.longname}).` };
    const notes = found.matchedBy === "shortname" ? [] : [`${JSON.stringify(searched.water)} is the water ${found.water.shortname} (${found.water.longname}).`];
    return { status: "ok", searched, water: found.water, stations, notes };
  }
  if (filter.stations !== undefined) {
    if (!Array.isArray(filter.stations) || filter.stations.length === 0 || filter.stations.length > 50) throw new PegelValidationError("Invalid stations: expected 1 to 50 gauge names, numbers or uuids.");
    const ids = [...new Set(filter.stations.map(stationName))];
    const searched = { stations: ids };
    // Only the stations an id names: an upstream that ignored the filter sent the whole network.
    const stations = (await client.stations.list({ ids, ...includes })).filter((s) => ids.some((id) => named([s], id).length > 0));
    const notes: string[] = [];
    const unmatched = ids.filter((id) => named(stations, id).length === 0);
    if (unmatched.length > 0) notes.push(`No gauge has the id or name ${unmatched.map((n) => JSON.stringify(n)).join(", ")} (left out; a part of a name works with name).`);
    for (const id of ids) {
      const same = named(stations, id);
      if (same.length > 1) notes.push(`${JSON.stringify(id)} names ${same.length} gauges (${same.map((s) => `${s.shortname} on ${s.water?.shortname ?? "?"}, number ${s.number}`).join("; ")}); all are listed.`);
    }
    if (stations.length === 0) return { status: "empty", searched, reason: unmatchedReason(ids) };
    return { status: "ok", searched, stations, notes };
  }
  if (filter.name !== undefined) {
    const searched = { name: normalizeInput(assertValid("name", filter.name, textProblem)) };
    const stations = await client.stations.list({ fuzzyId: searched.name, ...includes });
    if (stations.length === 0) return { status: "empty", searched, reason: unmatchedReason([searched.name]) };
    return { status: "ok", searched, stations, notes: [] };
  }
  const stations = await client.stations.list(includes);
  if (stations.length === 0) return { status: "empty", searched: {}, reason: "PEGELONLINE listed no gauges at all: the service may be in trouble; try again later." };
  return { status: "ok", searched: {}, stations, notes: [] };
}

/** The input of {@link listStations}. */
export type ListStationsInput = StationFilter;

/** The answer of {@link listStations}. */
export type StationList =
  | { status: "ok"; searched: StationSearch; water?: Water; total: number; stations: StationSummary[]; notes: string[] }
  | { status: "ambiguous"; searched: StationSearch; total: number; candidates: Water[] }
  | { status: "empty"; searched: StationSearch; reason: string };

/**
 * The gauges on a water, by name or by a part of a name, or all of them (about 790), with what
 * names and places each (no readings). Same-named gauges are all listed, with their numbers.
 */
export async function listStations(client: PegelOnlineClient, input: ListStationsInput = {}): Promise<StationList> {
  const selection = await selectStations(client, input, false);
  if (selection.status !== "ok") return selection;
  const stations = selection.stations.map(summaryOf);
  const shared = sharedNames(selection.stations);
  const notes = [...selection.notes, ...(shared.length > 0 ? [`Names several gauges carry: ${shared.join(", ")}. Use the number to pick one.`] : [])];
  return { status: "ok", searched: selection.searched, ...(selection.water === undefined ? {} : { water: selection.water }), total: stations.length, stations, notes };
}

/** The shortnames two or more of `stations` share. */
function sharedNames(stations: readonly Station[]): string[] {
  const count = new Map<string, number>();
  for (const s of stations) count.set(fold(s.shortname), (count.get(fold(s.shortname)) ?? 0) + 1);
  return [...count].filter(([, n]) => n > 1).map(([name]) => name);
}

/** A GeoJSON point feature of a gauge. */
export interface GaugeFeature {
  type: "Feature";
  id: string;
  /** [longitude, latitude], WGS84. */
  geometry: { type: "Point"; coordinates: [number, number] };
  properties: StationSummary & {
    level?: number | null;
    unit?: string;
    state?: string;
    verdict?: LevelVerdict;
    comment?: string;
    measuredAt?: string;
    stale?: boolean;
    aheadMinutes?: number;
  };
}

/** The input of {@link getStationsMap}. */
export interface StationsMapInput extends StationFilter, ClockInput {
  /** Bake the live reading of `timeseries` into each point (default false). */
  levels?: boolean | undefined;
  /** The series for the levels (default W). */
  timeseries?: string | undefined;
  /** Only gauges inside [west, south, east, north] (decimal degrees, WGS84). */
  bbox?: readonly number[] | undefined;
}

/** The answer of {@link getStationsMap}. */
export type StationsMap =
  | {
      status: "ok";
      type: "FeatureCollection";
      searched: StationSearch & { bbox?: number[]; levels: boolean };
      /** The water the filter named, as resolved. */
      water?: Water;
      features: GaugeFeature[];
      /** Gauges left off the map: no coordinates. */
      leftOff: { shortname: string; number?: string; reason: string }[];
      /** The units the levels come in: never one colour scale across them. */
      units?: string[];
      notes: string[];
    }
  | { status: "ambiguous"; searched: StationSearch; total: number; candidates: Water[] }
  | { status: "empty"; searched: StationSearch & { bbox?: number[]; levels?: boolean }; reason: string };

/** Why `bbox` is no [west, south, east, north] box, or undefined. */
const bboxProblem: Problem<readonly number[]> = (box) => {
  if (!Array.isArray(box) || box.length !== 4 || !box.every((n) => typeof n === "number" && Number.isFinite(n))) return "Expected [west, south, east, north] in decimal degrees.";
  const [w, s, e, n] = box as [number, number, number, number];
  if (w < -180 || e > 180 || s < -90 || n > 90 || w > e || s > n) return "Expected [west, south, east, north] with west ≤ east and south ≤ north, in decimal degrees (longitude −180..180, latitude −90..90).";
  return undefined;
};

/**
 * Gauges as a GeoJSON FeatureCollection, [longitude, latitude] order, optionally with the live
 * reading of each (level, unit, state, verdict, comment, time). Gauges without coordinates (about
 * 7 % of the network) are left off and named; a bbox narrows to a viewport (the API has none).
 */
export async function getStationsMap(client: PegelOnlineClient, input: StationsMapInput = {}): Promise<StationsMap> {
  const levels = input.levels === true;
  const timeseries = seriesName(input.timeseries);
  const bbox = input.bbox === undefined ? undefined : [...assertValid("bbox", input.bbox, bboxProblem)];
  const now = input.now ?? new Date();
  const selection = await selectStations(client, input, levels);
  const extra = { ...(bbox === undefined ? {} : { bbox }), levels };
  if (selection.status === "ambiguous") return selection;
  if (selection.status === "empty") return { status: "empty", searched: { ...selection.searched, ...extra }, reason: selection.reason };
  const searched = { ...selection.searched, ...extra };
  const leftOff: { shortname: string; number?: string; reason: string }[] = [];
  const features: GaugeFeature[] = [];
  for (const s of selection.stations) {
    if (typeof s.longitude !== "number" || typeof s.latitude !== "number") {
      leftOff.push({ shortname: s.shortname, ...(typeof s.number === "string" ? { number: s.number } : {}), reason: "no coordinates" });
      continue;
    }
    if (bbox !== undefined) {
      const [w, so, e, n] = bbox as [number, number, number, number];
      if (s.longitude < w || s.longitude > e || s.latitude < so || s.latitude > n) continue;
    }
    const properties: GaugeFeature["properties"] = summaryOf(s);
    if (levels) {
      const r = readingOf(s, timeseries, now);
      Object.assign(properties, {
        level: r.value,
        ...(r.unit === undefined ? {} : { unit: r.unit }),
        ...(r.state === undefined ? {} : { state: r.state }),
        verdict: r.verdict,
        ...(r.comment === undefined ? {} : { comment: r.comment }),
        ...(r.timestamp === undefined ? {} : { measuredAt: r.timestamp }),
        stale: r.stale,
        ...(r.aheadMinutes === undefined ? {} : { aheadMinutes: r.aheadMinutes }),
      });
    }
    features.push({ type: "Feature", id: s.uuid, geometry: { type: "Point", coordinates: [s.longitude, s.latitude] }, properties });
  }
  const notes = [...selection.notes];
  if (leftOff.length > 0) notes.push(`${leftOff.length} gauge${leftOff.length === 1 ? " has" : "s have"} no coordinates and ${leftOff.length === 1 ? "is" : "are"} left off (leftOff).`);
  const units = levels ? [...new Set(features.map((f) => f.properties.unit).filter((u): u is string => u !== undefined))] : undefined;
  if (units !== undefined && units.length > 1) notes.push(`Levels come in ${units.join(", ")}: colour or size points by verdict, never by level across units.`);
  if (features.length === 0) {
    return { status: "empty", searched, reason: bbox === undefined ? "None of the gauges has coordinates." : `None of the ${selection.stations.length} gauges lies inside the bbox [west, south, east, north] = [${bbox.join(", ")}]. Check the order of the numbers.` };
  }
  return { status: "ok", type: "FeatureCollection", searched, ...(selection.water === undefined ? {} : { water: selection.water }), features, leftOff, ...(units === undefined ? {} : { units }), notes };
}

// ---- one station, its measurements ------------------------------------------------------------

/** The input of {@link getStationDetail}. */
export interface StationDetailInput extends ClockInput {
  /** One gauge: shortname, longname, number, uuid or a part of the name. */
  station: string;
  /** Add the gauge marks (characteristic values: MNW, MW, MHW, HSW, HHW, …) as published (default false). */
  marks?: boolean | undefined;
  /** Add the forecast series (WV) with their window (default false). */
  forecast?: boolean | undefined;
}

/** One series of a station, with its reading. */
export interface SeriesDetail {
  shortname: string;
  longname?: string;
  unit?: string;
  /** The operator's note: on a measured series while it is disturbed, on a forecast where it comes from. */
  comment?: string;
  /** The datum a water level is measured from (Pegelnullpunkt). */
  gaugeZero?: JsonObject;
  reading?: GaugeReading;
  /** A forecast series' window: issued at start, last forecast at end. */
  start?: string;
  end?: string;
  /** The gauge marks as published; which ones differ from gauge to gauge. */
  marks?: JsonObject[];
}

/** The answer of {@link getStationDetail}. */
export type StationDetail =
  | { status: "ok"; searched: { station: string }; matchedBy: "id" | "name part"; station: StationSummary; series: SeriesDetail[]; notes: string[] }
  | { status: "ambiguous"; searched: { station: string }; total: number; candidates: StationSummary[] }
  | { status: "empty"; searched: { station: string }; reason: string };

/**
 * One gauge with every series it publishes, each with its unit and current reading (and its verdict),
 * optionally the gauge marks and the forecast series. A name several gauges carry is `ambiguous`.
 */
export async function getStationDetail(client: PegelOnlineClient, input: StationDetailInput): Promise<StationDetail> {
  const station = stationName(input.station);
  const searched = { station };
  const now = input.now ?? new Date();
  const lookup = await lookupStations(client, [station], "series");
  const hit = lookup.found[0];
  if (hit === undefined) {
    const many = lookup.ambiguous[0];
    if (many !== undefined) return { status: "ambiguous", searched, total: many.total, candidates: many.candidates };
    return { status: "empty", searched, reason: unmatchedReason([station]) };
  }
  const full = await client.stations.get(hit.station.uuid, {
    includeCurrentMeasurement: true,
    ...(input.marks === true ? { includeCharacteristicValues: true } : {}),
    ...(input.forecast === true ? { includeForecastTimeseries: true } : {}),
  });
  const series = (full.timeseries ?? []).map((t): SeriesDetail => {
    const forecast = typeof t.start === "string" && t.currentMeasurement === undefined;
    const comment = commentOf(t);
    return {
      shortname: t.shortname,
      ...(typeof t.longname === "string" ? { longname: t.longname } : {}),
      ...(typeof t.unit === "string" ? { unit: t.unit } : {}),
      ...(comment === undefined ? {} : { comment }),
      ...(t.gaugeZero === undefined ? {} : { gaugeZero: t.gaugeZero as unknown as JsonObject }),
      ...(forecast ? { start: t.start as string, ...(typeof t.end === "string" ? { end: t.end } : {}) } : { reading: readingOf(full, t.shortname, now) }),
      ...(input.marks === true && Array.isArray(t.characteristicValues) ? { marks: t.characteristicValues } : {}),
    };
  });
  const notes: string[] = [];
  if (input.marks === true) notes.push("Which marks a gauge publishes differs from gauge to gauge; present those there, verbatim, and invent none. The flood verdict is the reading's state, not a mark.");
  if (series.some((s) => s.start !== undefined)) notes.push("Forecast series (WV): their points come from getMeasurements with that series; forecasts first, then rougher estimates (type).");
  return { status: "ok", searched, matchedBy: hit.matchedBy, station: summaryOf(full), series, notes };
}

/**
 * The measurements of `station`'s series in a window, or why there are none: the API answers 404
 * for a series without measurements at the moment, which getMeasurements and getLevelTrend read
 * the same way.
 */
async function windowOf(client: PegelOnlineClient, station: Station, series: string, start: string, end: string | undefined): Promise<Measurement[] | string> {
  try {
    return await client.timeseries.measurements(station.uuid, series, { start, ...(end === undefined ? {} : { end }) });
  } catch (err) {
    if (err instanceof PegelApiError && err.status === 404) return `${station.shortname} ${series} has no measurements at the moment (HTTP 404).`;
    throw err;
  }
}

/** The input of {@link getMeasurements}. */
export interface MeasurementsInput {
  station: string;
  timeseries?: string | undefined;
  /** An ISO-8601 period back from now (P1D) or an instant; default P1D. */
  start?: string | undefined;
  end?: string | undefined;
}

/** The answer of {@link getMeasurements}. */
export type MeasurementWindow =
  | {
      status: "ok";
      searched: { station: string; timeseries: string; start: string; end?: string };
      station: StationSummary;
      series: { shortname: string; unit?: string; comment?: string };
      total: number;
      missing: number;
      /** Oldest first; value null where the gauge sent no value. Forecast points carry type and initialized. */
      measurements: Measurement[];
      notes: string[];
    }
  | { status: "ambiguous"; searched: { station: string; timeseries: string; start: string; end?: string }; total: number; candidates: StationSummary[] }
  | { status: "empty"; searched: { station: string; timeseries: string; start: string; end?: string }; reason: string };

/**
 * The raw points of one series in a window, oldest first, with the series' unit; a placeholder
 * point is null. A series the station lacks, or a window outside the ~31 days kept, is `empty` with
 * the reason.
 */
export async function getMeasurements(client: PegelOnlineClient, input: MeasurementsInput): Promise<MeasurementWindow> {
  const station = stationName(input.station);
  const timeseries = seriesName(input.timeseries);
  const start = normalizeInput(assertValid("start", input.start ?? "P1D", tokenProblem));
  const end = input.end === undefined ? undefined : normalizeInput(assertValid("end", input.end, tokenProblem));
  const searched = { station, timeseries, start, ...(end === undefined ? {} : { end }) };
  const lookup = await lookupStations(client, [station], "series");
  const hit = lookup.found[0];
  if (hit === undefined) {
    const many = lookup.ambiguous[0];
    if (many !== undefined) return { status: "ambiguous", searched, total: many.total, candidates: many.candidates };
    return { status: "empty", searched, reason: unmatchedReason([station]) };
  }
  const series = await seriesWithForecast(client, hit.station, timeseries);
  if (series === undefined) {
    const has = (hit.station.timeseries ?? []).map((t) => t.shortname).join(", ");
    return { status: "empty", searched, reason: `${hit.station.shortname} has no ${timeseries} series${has === "" ? "" : `; it has ${has}`}.` };
  }
  const measurements = await windowOf(client, hit.station, series.shortname, start, end);
  if (typeof measurements === "string") return { status: "empty", searched, reason: measurements };
  if (measurements.length === 0) {
    return { status: "empty", searched, reason: `No measurement of ${hit.station.shortname} ${series.shortname} in the window from ${start}${end === undefined ? "" : ` to ${end}`}. PEGELONLINE keeps only about the last 31 days.` };
  }
  const comment = commentOf(series);
  const missing = measurements.filter((m) => m.value === null).length;
  const notes: string[] = [];
  if (isForecast(series)) {
    notes.push("A forecast series: forecasts first, then rougher estimates (type); no measurements.");
    if (comment !== undefined) notes.push(`About the forecast: ${comment}`);
  } else if (comment !== undefined) notes.push(`The gauge reports a fault: ${comment}. The values may be wrong.`);
  if (missing > 0) notes.push(`${missing} points have no value (null: the gauge's placeholder); leave them out of a minimum, maximum or trend.`);
  return {
    status: "ok",
    searched,
    station: summaryOf(hit.station),
    series: { shortname: series.shortname, ...(typeof series.unit === "string" ? { unit: series.unit } : {}), ...(comment === undefined ? {} : { comment }) },
    total: measurements.length,
    missing,
    measurements,
    notes,
  };
}
