// A mock of the PEGELONLINE REST API v2 over its own paths, with gauges recorded live on
// 2026-11-19 and cut down (uuids, numbers, km, agencies and coordinates as the API sent them; the
// readings set to cover the skills' traps): a high and a low gauge, a gauge fault with its comment
// (RINTELN), an out-dated and a lagging reading on the ELBE, a canal level in m+NN (MÜNSTER OW),
// the 99999 placeholder (PANNERDENSE KOP), two gauges named NEUSTADT, Austrian DONAU gauges without
// coordinates, a gauge without km (Prerow), the WESER's two chainages. Reading times are relative to
// a clock (`now`), so ages hold on any day.

import type { HttpRequest, HttpResponse } from "../src/http.js";
import { jsonResponse, makeMockTransport, type MockTransport } from "./helpers.js";

/** The clock the operations tests read at. */
export const NOW = new Date("2026-11-19T20:00:00+01:00");

/** `minutesAgo` before `now`, written as PEGELONLINE writes a time in winter (+01:00). */
export function stamp(now: Date, minutesAgo: number): string {
  return `${new Date(now.getTime() - minutesAgo * 60_000 + 3_600_000).toISOString().slice(0, 19)}+01:00`;
}

/** One series of a gauge, its current reading `minutesAgo` old. */
export interface SeriesFixture {
  shortname: string;
  longname?: string;
  unit: string;
  value?: number;
  state?: string;
  shipping?: string;
  minutesAgo?: number;
  comment?: { shortDescription: string; longDescription?: string };
  marks?: Record<string, unknown>[];
  /** A forecast series (WV): its window, no current reading. */
  forecast?: true;
}

export interface GaugeFixture {
  uuid: string;
  number: string;
  shortname: string;
  km?: number;
  agency: string;
  coordinates?: [number, number];
  water: string;
  series: SeriesFixture[];
}

const WATER_NAMES: Record<string, string> = {
  DONAU: "DONAU",
  DEK: "DORTMUND-EMS-KANAL",
  ELBE: "ELBE",
  EHK: "ELBE-HAVEL-KANAL",
  ELK: "ELBE-LÜBECK-KANAL",
  LEINE: "LEINE",
  MLK: "MITTELLANDKANAL",
  MOSEL: "MOSEL",
  OSTSEE: "OSTSEE",
  RHEIN: "RHEIN",
  WESER: "WESER",
};

/** The waters, as /waters.json lists them. */
export const WATERS = Object.entries(WATER_NAMES).map(([shortname, longname]) => ({ shortname, longname }));

const W = (value: number, state: string, minutesAgo = 15, extra: Partial<SeriesFixture> = {}): SeriesFixture => ({
  shortname: "W",
  longname: "WASSERSTAND ROHDATEN",
  unit: "cm",
  value,
  state,
  shipping: "unknown",
  minutesAgo,
  ...extra,
});
const Q = (value: number): SeriesFixture => ({ shortname: "Q", longname: "ABFLUSS_ROHDATEN", unit: "m³/s", value, minutesAgo: 30 });

/** The gauges of the mock, recorded on 2026-11-19 (readings adapted). */
export function gauges(): GaugeFixture[] {
  return [
    { uuid: "e020e651-e422-46d3-ae28-34887c5a4a8e", number: "3329", shortname: "KONSTANZ-RHEIN", km: 0.5, agency: "REGIERUNGSPRÄSIDIUM FREIBURG", coordinates: [9.172858, 47.667889], water: "RHEIN", series: [W(260, "unknown")] },
    { uuid: "593647aa-9fea-43ec-a7d6-6476a76ae868", number: "2710080", shortname: "BONN", km: 654.8, agency: "STANDORT KÖLN", coordinates: [7.108045, 50.736398], water: "RHEIN", series: [W(182, "normal"), Q(1460)] },
    {
      uuid: "a6ee8177-107b-47dd-bcfd-30960ccc6e9c",
      number: "2730010",
      shortname: "KÖLN",
      km: 688,
      agency: "STANDORT KÖLN",
      coordinates: [6.9633, 50.936949],
      water: "RHEIN",
      series: [
        Q(1450),
        W(232, "normal", 15, {
          shipping: "normal",
          marks: [
            { shortname: "MNW", longname: "Mittel der Niedrigwasserstände ", unit: "cm", value: 114, timespanStart: "2010-11-01", timespanEnd: "2020-10-31" },
            { shortname: "HHW", longname: "Höchster Hochwasserstand", unit: "cm", value: 1069, occurrences: ["1926-01-01"] },
          ],
        }),
        { shortname: "WV", longname: "WASSERSTANDVORHERSAGE", unit: "cm", forecast: true },
      ],
    },
    { uuid: "9598e4cb-0849-401e-bba0-689234b27644", number: "2790020", shortname: "EMMERICH", km: 851.9, agency: "STANDORT DUISBURG", coordinates: [6.245594, 51.829252], water: "RHEIN", series: [W(812, "high")] },
    { uuid: "3046493f-971f-4d22-9f29-7ef8e3b645a4", number: "2790060", shortname: "PANNERDENSE KOP", km: 867.3, agency: "RIJKSWATERSTAAT", coordinates: [6.040078, 51.869724], water: "RHEIN", series: [W(99999, "unknown")] },
    { uuid: "f4c55f77-ab80-4e00-bed3-aa6631aba074", number: "502430", shortname: "SANDAU", km: 416.06, agency: "STANDORT MAGDEBURG", coordinates: [12.031305, 52.78477], water: "ELBE", series: [W(140, "out-dated", 30 * 60)] },
    { uuid: "67d6e882-b60c-40d3-975c-a6d7a2b4e40a", number: "5930010", shortname: "NEU DARCHAU", km: 536.385, agency: "STANDORT LAUENBURG", coordinates: [10.888819, 53.232258], water: "ELBE", series: [W(95, "low", 11 * 60)] },
    { uuid: "824a046b-9ca3-4db8-993d-e755122854e0", number: "10046105", shortname: "INGOLSTADT LUITPOLDSTRASSE", km: 2458.3, agency: "WASSERWIRTSCHAFTSAMT INGOLSTADT", coordinates: [11.426054, 48.757414], water: "DONAU", series: [W(160, "normal")] },
    { uuid: "9f12c405-35ac-4d90-9b7b-023be355867e", number: "10091008", shortname: "PASSAU DONAU", km: 2226.7, agency: "STANDORT REGENSBURG", coordinates: [13.459076, 48.576133], water: "DONAU", series: [W(450, "normal")] },
    { uuid: "35846b8b-e589-4654-9eb5-a650048f8468", number: "42014", shortname: "WILDUNGSMAUER", km: 1894.7, agency: "VIA DONAU", water: "DONAU", series: [W(310, "unknown")] },
    { uuid: "f7b5c3d3-33f6-4ba4-a509-cf2b1a9d7297", number: "42015", shortname: "THEBNERSTRASSL", km: 1879.2, agency: "VIA DONAU", water: "DONAU", series: [W(290, "unknown")] },
    { uuid: "b26bfc88-eb8a-45b9-9dd0-0e41949a2648", number: "4910050", shortname: "GROSSE WESERBRÜCKE", km: 0.04, agency: "BREMEN", coordinates: [8.803636, 53.073097], water: "WESER", series: [W(410, "unknown")] },
    { uuid: "227e53ca-4dd9-482b-be62-52fdc62a4b4e", number: "43100109", shortname: "HANN.MUENDEN", km: 0.65, agency: "HANN-MÜNDEN", coordinates: [9.640917, 51.425789], water: "WESER", series: [W(150, "normal")] },
    { uuid: "7febef93-09ce-49e9-9643-ecb3076ce9a7", number: "4970020", shortname: "BRAKE", km: 39.2, agency: "BREMEN", coordinates: [8.486546, 53.315979], water: "WESER", series: [W(520, "unknown")] },
    {
      uuid: "005dfdae-efcc-410a-bf1c-24096e0c2866",
      number: "45900109",
      shortname: "RINTELN",
      km: 163.2,
      agency: "HANN-MÜNDEN",
      coordinates: [9.081705, 52.189747],
      water: "WESER",
      series: [W(153, "commented", 120, { shipping: "commented", comment: { shortDescription: "Funktionsstörung, fehlerhafte Messwerte", longDescription: "Funktionsstörung, fehlerhafte Messwerte" } })],
    },
    { uuid: "cbfdddd1-9e32-4de2-adca-7b32241c265d", number: "4910020", shortname: "DREYE", km: 355.8, agency: "BREMEN", coordinates: [8.891252, 53.014359], water: "WESER", series: [W(380, "low")] },
    { uuid: "dda39817-d01d-467f-a6a3-7487011a45d1", number: "48800200", shortname: "NEUSTADT", km: 66.4, agency: "VERDEN", coordinates: [9.466717, 52.509593], water: "LEINE", series: [W(199, "normal")] },
    { uuid: "3f0b6b74-80a9-4576-a3cb-ea967dfc349f", number: "9610080", shortname: "NEUSTADT", km: 263, agency: "STANDORT LÜBECK", coordinates: [10.804988, 54.096523], water: "OSTSEE", series: [W(522, "normal", 3)] },
    { uuid: "7d50c68c-3558-481d-bbe3-830f6f534a05", number: "9650027", shortname: "Prerow", agency: "STANDORT STRALSUND", coordinates: [12.57182, 54.458995], water: "OSTSEE", series: [W(498, "unknown")] },
    { uuid: "ccd3e8f1-39e9-4e09-aa41-625afda84460", number: "27800040", shortname: "MÜNSTER OW", km: 70.315, agency: "RHEINE", coordinates: [7.664374, 51.968942], water: "DEK", series: [{ ...W(56.49, "unknown", 105), unit: "m+NN" }] },
  ];
}

/** A measurement window: hourly points `hours` back from `now`, falling from `from` to `to`; the given indices sent as 99999. */
export function hourly(now: Date, hours: number, from: number, to: number, placeholders: number[] = []): { timestamp: string; value: number }[] {
  return Array.from({ length: hours + 1 }, (_, i) => ({
    timestamp: stamp(now, (hours - i) * 60),
    value: placeholders.includes(i) ? 99999 : Math.round(from + ((to - from) * i) / hours),
  }));
}

/** The station `gauge` as the API sends it, with what the query asks to embed. */
function stationJson(g: GaugeFixture, query: URLSearchParams, now: Date): Record<string, unknown> {
  const flag = (name: string) => query.get(name) === "true";
  const station: Record<string, unknown> = {
    uuid: g.uuid,
    number: g.number,
    shortname: g.shortname,
    longname: g.shortname,
    ...(g.km === undefined ? {} : { km: g.km }),
    agency: g.agency,
    ...(g.coordinates === undefined ? {} : { longitude: g.coordinates[0], latitude: g.coordinates[1] }),
    water: { shortname: g.water, longname: WATER_NAMES[g.water] ?? g.water },
  };
  if (flag("includeTimeseries")) {
    station["timeseries"] = g.series
      .filter((s) => s.forecast !== true || flag("includeForecastTimeseries"))
      .map((s) => ({
        shortname: s.shortname,
        longname: s.longname ?? s.shortname,
        unit: s.unit,
        equidistance: 15,
        ...(s.forecast === true ? { start: stamp(now, 13 * 60), end: stamp(now, -83 * 60) } : {}),
        ...(s.comment === undefined ? {} : { comment: s.comment }),
        ...(s.shortname === "W" && s.unit === "cm" ? { gaugeZero: { unit: "m. ü. NHN", value: 35.038, validFrom: "2019-11-01" } } : {}),
        ...(flag("includeCurrentMeasurement") && s.value !== undefined
          ? {
              currentMeasurement: {
                timestamp: stamp(now, s.minutesAgo ?? 15),
                value: s.value,
                ...(s.state === undefined ? {} : { stateMnwMhw: s.state }),
                ...(s.shipping === undefined ? {} : { stateNswHsw: s.shipping }),
              },
            }
          : {}),
        ...(flag("includeCharacteristicValues") ? { characteristicValues: s.marks ?? [] } : {}),
      }));
  }
  return station;
}

/** True when `id` names `g` as the API's id lookup does: uuid, number, shortname or longname, any case. */
function names(g: GaugeFixture, id: string): boolean {
  const wanted = id.normalize("NFC").toUpperCase();
  return [g.uuid, g.number, g.shortname].some((f) => f.toUpperCase() === wanted);
}

/** The mock's options: the gauges, the clock, the measurement windows by `<uuid>/<series>`. */
export interface PegelApiOptions {
  gauges?: GaugeFixture[];
  now?: Date;
  measurements?: Record<string, unknown[]>;
}

/**
 * A mock of the API by path: /waters.json; /stations.json with ids, waters, fuzzyId and the
 * include flags; /stations/<id>.json (the first station the id names, as the API silently picks
 * one); /stations/<id>/<series>.json and its measurements.json, whose start the API reads as an
 * ISO period or instant (anything else is its HTTP 400, an instant over 31 days back an empty
 * window). Anything else is a 404.
 */
export function pegelApi(options: PegelApiOptions = {}): MockTransport {
  const all = options.gauges ?? gauges();
  const now = options.now ?? NOW;
  const windows = options.measurements ?? { "593647aa-9fea-43ec-a7d6-6476a76ae868/W": hourly(now, 72, 196, 182, [10]) };
  return makeMockTransport((request: HttpRequest): HttpResponse => {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^.*\/webservices\/rest-api\/v2/, "");
    const query = url.searchParams;
    if (path === "/waters.json") return jsonResponse(WATERS);
    if (path === "/stations.json") {
      const ids = query.get("ids")?.split(",");
      const water = query.get("waters");
      const fuzzy = query.get("fuzzyId")?.toUpperCase();
      const hits = all.filter(
        (g) =>
          (ids === undefined || ids.some((id) => names(g, id))) &&
          (water === null || g.water === water) &&
          (fuzzy === undefined || g.shortname.toUpperCase().includes(fuzzy)),
      );
      return jsonResponse(hits.map((g) => stationJson(g, query, now)));
    }
    const parts = path.split("/").filter((p) => p !== "").map((p) => decodeURIComponent(p.replace(/\.json$/, "")));
    if (parts[0] !== "stations" || parts[1] === undefined) return jsonResponse({ status: 404, message: "Not found" }, 404);
    const gauge = all.find((g) => names(g, parts[1] as string));
    if (gauge === undefined) return jsonResponse({ status: 404, message: `Station ${parts[1]} not found` }, 404);
    if (parts.length === 2) return jsonResponse(stationJson(gauge, query, now));
    const series = gauge.series.find((s) => s.shortname === parts[2]);
    if (series === undefined) return jsonResponse({ status: 404, message: `Timeseries ${parts[2]} not found` }, 404);
    if (parts.length === 3) return jsonResponse({ shortname: series.shortname, longname: series.longname ?? series.shortname, unit: series.unit, ...(series.comment === undefined ? {} : { comment: series.comment }) });
    if (parts[3] === "measurements") {
      const start = query.get("start") ?? "P1D";
      if (!/^-?P/.test(start) && !Number.isFinite(Date.parse(start))) {
        return jsonResponse({ status: 400, message: "Given start parameter is neither a valid ISO date time, nor an ISO period." }, 400);
      }
      if (!start.startsWith("P") && Date.parse(start) < now.getTime() - 31 * 86_400_000) return jsonResponse([]);
      return jsonResponse(windows[`${gauge.uuid}/${series.shortname}`] ?? hourly(now, 24, series.value ?? 100, series.value ?? 100));
    }
    return jsonResponse({ status: 404, message: "Not found" }, 404);
  });
}
