# Glossary

A reference for the domain concepts and project-specific terms used throughout
`pegel-online-cli`. The PEGELONLINE domain is German; this glossary gives the
English term used in the CLI/API alongside the original German where one exists.

> **Quick orientation.** PEGELONLINE publishes near-real-time **water levels**
> (and a few other measured quantities) for the German federal waterway network.
> The hierarchy is: a **body of water** (*Gewässer*) carries **stations**
> (*Pegel*/gauges); each station carries one or more **timeseries** (e.g. `W`
> water level, `Q` flow); each timeseries has a **current measurement** and a
> history of **measurements**, and may publish **characteristic values**
> (gauge marks). The CLI mirrors that hierarchy.

---

## The PEGELONLINE service

**PEGELONLINE.** The open water-level web service at
[`pegelonline.wsv.de`](https://www.pegelonline.wsv.de/webservice/dokuRestapi).
It serves near-real-time and historical gauge readings for German federal
waterways as a public, read-only REST API. No API key or authentication is
required.

**WSV — Wasserstraßen- und Schifffahrtsverwaltung des Bundes.** The German
Federal Waterways and Shipping Administration, which operates the gauges and
publishes PEGELONLINE.

**REST API v2.** The version of the API this client targets. The base path is
`/webservices/rest-api/v2`, rooted at the default base URL
`https://www.pegelonline.wsv.de`. Every endpoint returns JSON (the client
requests the `.json` representation of each resource).

---

## Resources and endpoints

**Stations (`stations`).** The collection of measuring stations.
`GET /stations.json` lists/filters them; `GET /stations/{station}.json` fetches
one. CLI: `stations list`, `stations get`. Client: `client.stations.list()`,
`client.stations.get()`.

**Waters (`waters`).** The list of all bodies of water (*Gewässer*) covered by
the service. `GET /waters.json`. CLI: `waters`. Client: `client.waters()`.

**Timeseries (`{timeseries}`).** A single measured quantity at a station.
`GET /stations/{station}/{timeseries}.json` returns its metadata. CLI:
`timeseries <station> [timeseries]`. Client: `client.timeseries.get()`.

**Current measurement (`currentmeasurement`).** The most recent reading of a
timeseries. `GET /stations/{station}/{timeseries}/currentmeasurement.json`.
CLI: `current <station> [timeseries]`. Client:
`client.timeseries.currentMeasurement()`.

**Measurements (`measurements`).** A time window of readings of a timeseries.
`GET /stations/{station}/{timeseries}/measurements.json`. CLI:
`measurements <station> [timeseries] [--start] [--end]`. Client:
`client.timeseries.measurements()`.

**Characteristic values (`characteristicvalues`).** The gauge marks /
characteristic values published for a timeseries (see *Characteristic values*
below). `GET /stations/{station}/{timeseries}/characteristicvalues.json`.
CLI: `characteristic <station> [timeseries]`. Client:
`client.timeseries.characteristicValues()`.

---

## Stations and waters

**Pegel (station / gauge).** A measuring station on a waterway. Modelled by the
`Station` type. Key fields:

- **`uuid`** — the stable, globally unique identifier of the station.
- **`number`** — the station's official number (string).
- **`shortname`** — a short name, usually upper-case (e.g. `BONN`).
- **`longname`** — the full human-readable name.
- **`km`** — the river kilometre at which the station sits.
- **`agency`** — the responsible WSV agency (*Behörde*).
- **`longitude` / `latitude`** — WGS84 coordinates of the station.
- **`water`** — the body of water the station measures (a `Water`).
- **`timeseries`** — the station's timeseries, present only when requested.

**Station selector (`<station>`).** Anywhere a station is addressed, the value
may be a **uuid**, **number**, **shortname** *or* **longname**. The API resolves
any of these forms. The CLI rejects an empty selector and the path segments
`.` / `..` before building the request URL.

**Gewässer (water / body of water).** A waterway in the network, modelled by the
`Water` type with a `shortname` (e.g. `RHEIN`) and a `longname`. The `waters`
filter on `stations list` matches a water's `shortname`.

---

## Timeseries, measurements and units

**Timeseries (`TimeseriesInfo`).** Metadata describing one measured quantity at a
station: its `shortname`, `longname`, `unit`, optional `equidistance`, an
optional embedded `currentMeasurement`, and optional `characteristicValues`.

**Timeseries shortname.** A short code identifying the quantity. The CLI default
is **`W`** (water level / *Wasserstand*). Other codes a station may expose
include **`Q`** (flow / discharge, *Durchfluss*), **`WT`** (water temperature),
and **`LT`** (air temperature) — availability varies per station. The code is
passed as the optional `[timeseries]` positional and defaults to `W` when
omitted or blank.

**Unit (`unit`).** The physical unit of a timeseries' values, as published by the
API — e.g. `cm` for water level, `m³/s` for flow, `°C` for temperatures. The
client surfaces the API's string verbatim.

**Equidistance (`equidistance`).** The nominal spacing between consecutive
measurements of a timeseries, in minutes (e.g. `15` for a reading every quarter
hour).

**Measurement (`Measurement`).** One point of a measurements series: a
`timestamp` (ISO-8601) and a numeric `value` in the timeseries' unit.

**Current measurement (`CurrentMeasurement`).** The latest reading of a
timeseries: a `timestamp`, a `value`, and up to two state classifications
(`stateMnwMhw`, `stateNswHsw`; see below).

---

## State classifications

These string fields on a current measurement classify the reading against
standard reference marks. The client surfaces the API's value verbatim.

**`stateMnwMhw`.** Classification of the current value relative to the
**mean low water (MNW, *Mittlerer Niedrigwasserstand*)** and **mean high water
(MHW, *Mittlerer Hochwasserstand*)** marks.

**`stateNswHsw`.** Classification of the current value relative to the
**lowest navigable water (NSW, *Niedrigster Schifffahrtswasserstand*)** and
**highest navigable water (HSW, *Höchster Schifffahrtswasserstand*)** marks —
the bounds within which shipping is permitted.

**Characteristic values (gauge marks).** The set of reference marks published
for a timeseries (e.g. the MNW/MHW/NSW/HSW levels above). Returned by the
`characteristic` command / `characteristicValues()` method, and embeddable via
`--include-characteristic`. The exact shape is standard-specific, so the client
returns it as a faithful raw JSON object (`JsonObject`) rather than a guessed
type.

---

## Filtering, includes and the time window

**`ids`.** A list of station identifiers (uuid/number/shortname/longname) to
restrict a listing to. Sent to the API comma-separated. CLI: repeatable
`--ids <id>`.

**`longname` / `agency` / `waters` / `fuzzyId` filters.** Narrow a `stations
list` by (a substring of) longname, by responsible agency, by water shortname,
or by a fuzzy id match (`--fuzzy-id`).

**Bounding box (`bbox`).** A geographic filter expressed as four numbers
`latbottom,lattop,longleft,longright`. The CLI parses and validates them
(four finite decimals; latitudes in `[-90, 90]`, longitudes in `[-180, 180]`;
`latbottom <= lattop`, `longleft <= longright`) and forwards them as the four
separate API parameters. CLI: `--bbox`.

**Include flags.** Optional expansions that embed extra data in a station /
timeseries response, off by default:

- **`includeTimeseries`** (`--include-timeseries`) — embed each station's
  timeseries list.
- **`includeCurrentMeasurement`** (`--include-current`) — embed the current
  measurement.
- **`includeCharacteristicValues`** (`--include-characteristic`) — embed the
  characteristic (gauge-mark) values.

**Time window (`start` / `end`).** The bounds of a `measurements` request, as
ISO-8601 instants. `start` may instead be an **ISO-8601 period/duration** such
as `P7D` ("the last 7 days") or `P3D`. CLI: `--start`, `--end`. An empty value
is treated as omitted rather than sent blank.

---

## Reliability and limits

**Retry / backoff.** Transient **`429`** (Too Many Requests) and **`503`**
(Service Unavailable) responses are retried automatically with linear backoff,
up to `maxRetries` times (default `2`). CLI: `--max-retries`. `PegelApiError`
exposes `isRetryable` for exactly these statuses.

**Redirects.** The engine follows up to `maxRedirects` (default `5`) HTTP
redirects (301/302/303/307/308), resolving `Location` relative to the current
URL, and strips any credential-bearing headers when crossing origins.

**Timeout (`timeoutMs`).** Per-request timeout in milliseconds (default
`30000`; `0` disables). CLI: `--timeout`.

**Response size cap (`maxResponseBytes`).** A hard cap on response body size to
defend against memory exhaustion (default 100 MiB; `0` = unlimited). CLI:
`--max-response-bytes`.

**User-Agent (`userAgent`).** The `User-Agent` header value (default
`pegel-online-cli`). Control characters are rejected up front to close
header-injection. CLI: `--user-agent`.

---

## Output and error handling

**JSON output.** Every command prints JSON to stdout — pretty-printed by default,
or on a single line with `--compact`.

**Exit codes.** `0` success; `2` for usage/parse errors (unknown command/option,
missing argument, invalid flag value); `4` on a `404` from the API; `1` for any
other (runtime/network) error.

---

> **Library & internals.** Terms for the TypeScript client and its internals —
> `PegelOnlineClient`, the request engine, transport, retry/backoff, error
> types, query builder — live in **[DEVELOPING.md](DEVELOPING.md)**.
