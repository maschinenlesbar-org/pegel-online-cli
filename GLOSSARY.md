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

**Characteristic values (`characteristicValues`).** The gauge marks /
characteristic values published for a timeseries (see *Characteristic values*
below). There is no separate command or method for them: they are an embed on
the station request, `GET /stations/{station}.json?includeTimeseries=true&includeCharacteristicValues=true`,
and sit in each `timeseries[]` entry. CLI:
`stations get <station> --include-characteristic` (implies `--include-timeseries`).
Client: `client.stations.get(station, { includeCharacteristicValues: true })`.

---

## Stations and waters

**Pegel (station / gauge).** A measuring station on a waterway. Modelled by the
`Station` type. Key fields:

- **`uuid`** — the stable, globally unique identifier of the station.
- **`number`** — the station's official number (string).
- **`shortname`** — a short name, usually upper-case (e.g. `BONN`).
- **`longname`** — the full human-readable name.
- **`km`** — the river kilometre at which the station sits, on the waterway's
  own chainage. It does not always grow downstream: on the Danube (`DONAU`) it
  counts down towards the mouth, on the Mosel, Main, Neckar and Saar it counts
  up from the mouth, and the Weser has two chainages that each start near 0
  (above and below Bremen). A few stations have no `km`.
- **`agency`** — the responsible WSV agency (*Behörde*).
- **`longitude` / `latitude`** — WGS84 coordinates of the station. Absent for
  some stations (57 of 787 on 2026-09-15).
- **`water`** — the body of water the station measures (a `Water`).
- **`timeseries`** — the station's timeseries, present only when requested.

**Station selector (`<station>`).** Anywhere a station is addressed, the value
may be a **uuid**, **number**, **shortname** *or* **longname**. The API resolves
any of these forms. **Names are not unique:** `NEUSTADT` is the shortname of a gauge
on the LEINE (number 48800200) and one on the OSTSEE (9610080), and the API answers a
lookup by the name with one of them. So `stations get`, `timeseries`, `current` and
`measurements` look a name up first (one extra request, none for a number or uuid;
library: `stations.assertUnique`) and refuse one that names several stations — exit
`2`, `PegelAmbiguousStationError`, listing each with its number and uuid.
`stations list --ids NEUSTADT` or `--fuzzy-id` lists both and prints a note; use the
**number** or **uuid** of the one you mean. The
CLI rejects an empty selector and the path segments
`.` / `..` for both `<station>` and `[timeseries]` before building the request
URL (URL parsing would otherwise resolve them and query a different resource); the
client library refuses them too, with a `PegelValidationError` before any request.
Station and timeseries names, `--ids`, `--waters` and `--fuzzy-id` are sent trimmed
and in composed Unicode form (NFC), so a pasted trailing space or a decomposed umlaut
(`KÖLN` typed as `KO` + U+0308 + `LN`, common in text pasted from macOS file names or
PDFs) finds the same station.

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
and **`LT`** (air temperature) — availability varies per station — and the
forecast series **`WV`** (see *Forecast series* below). The code is
passed as the optional `[timeseries]` positional and defaults to `W` when
omitted; a blank value is rejected as a usage error.

**Unit (`unit`).** The physical unit of a timeseries' values, as published by the
API — e.g. `cm` for water level, `m³/s` for flow, `°C` for temperatures. The
client surfaces the API's string verbatim. The unit belongs to the series, not to the
code: **not every `W` is in cm.** On 5 October 2026, 668 of 737 `W` series were in `cm`,
but 67 canal gauges (Mittellandkanal, Wesel-Datteln-, Rhein-Herne-, Elbe-Seiten-,
Dortmund-Ems-, Datteln-Hamm-Kanal, Ruhr) published `m+NN` — metres above sea level, so
MÜNSTER OW reads 56.54 — and two reservoirs (EDERTALSPERRE, DIEMELTALSPERRE) `m+PNP`,
metres above the gauge zero. A current measurement carries no unit; read it from the
series (`pegel timeseries <station> <series>`, or `.timeseries[].unit` with
`--include-timeseries`) every time.

**Equidistance (`equidistance`).** The nominal spacing between consecutive
measurements of a timeseries, in minutes (e.g. `15` for a reading every quarter
hour).

**Measurement (`Measurement`).** One point of a measurements series: a
`timestamp` (ISO-8601) and a numeric `value` in the timeseries' unit — or `null`
for a point without a reading (see *No value* below). Points of a forecast series
also carry `initialized` and `type`.

**Forecast series (`WV`, *Wasserstandsvorhersage*).** A water-level **forecast**, not
a measurement: the Bundesanstalt für Gewässerkunde (BfG) predicts the level of some
gauges — on 6 October 2026 seven on the Rhine (OESTRICH, KAUB, KOBLENZ, KÖLN,
DÜSSELDORF, DUISBURG-RUHRORT, EMMERICH) — about four days ahead in two-hour steps
(`equidistance` `120`). Values are in the series' `unit` (`cm` there, like the gauge's
`W`). The API lists `WV` in a station's timeseries only with
`includeForecastTimeseries` (`--include-forecast`, which implies
`--include-timeseries`); the series' `start`/`end` give the forecast window and its
`comment` the issuing run and source ("Vorhersagen und Abschätzungen vom: 06.10.2026
um 07:00 Uhr, Quelle: Bundesanstalt für Gewässerkunde"). The values come from
`pegel measurements <station> WV`; each point carries `initialized` (when the run was
issued) and `type`: **`forecast`** (*Vorhersage*) for the nearer points, then
**`estimate`** (*Abschätzung*, a rougher outlook) for the later ones. `pegel current
<station> WV` is a 404 — a forecast has no current measurement.

**No value (`99999` → `null`).** Some gauges report the placeholder `99999` instead
of a reading — the Rhine gauge PANNERDENSE KOP (Rijkswaterstaat) did, interleaved
with real readings of 576–597 cm, on 5 October 2026. Read as a number it would be a
water level of 1 km. The client and the CLI turn it into `null` wherever a reading
appears (`current`, `measurements`, and the current measurement embedded by
`--include-current`; constant `NO_VALUE_SENTINEL`), so a `null` `value` means "no
reading at this time". Skip such points before computing a minimum, maximum or trend.

**Current measurement (`CurrentMeasurement`).** The latest reading of a
timeseries: a `timestamp`, a `value`, and up to two state classifications
(`stateMnwMhw`, `stateNswHsw`; see below). "Latest" is not always recent: a
gauge that stops reporting keeps its last reading and state, sometimes for
hours, so check the `timestamp`.

---

## State classifications

These string fields on a current measurement classify the reading against
standard reference marks. They appear on water-level series only (not on `Q` or
temperatures). The client surfaces the API's value verbatim; the API documents six:

| Value | Meaning |
| --- | --- |
| `low` | at or below MNW (`stateMnwMhw` only) |
| `normal` | between MNW and MHW (or between 0 and HSW) |
| `high` | at or above MHW (or HSW) |
| `unknown` | the series publishes no MNW/MHW (or HSW) mark to compare with |
| `commented` | **gauge malfunction or disruption** — the value may be wrong; the reason is in the series' `comment` |
| `out-dated` | the reading is older than 25 hours |

A `commented` reading is not a level to judge: on 5 October 2026 RINTELN showed 92 cm,
below its MNW, with the comment "Funktionsstörung, fehlerhafte Messwerte" (malfunction,
faulty readings).

**Comment (`comment`).** The operator's note on a disturbed timeseries —
`{ shortDescription, longDescription }`, e.g. "Techn. Störung" or "Behelfspegel -
Messwerte können Fehler aufweisen" (temporary gauge, values may be wrong). It is part
of the timeseries (`pegel timeseries <station> <series>`, or `--include-timeseries` on
`stations get` / `stations list`), not of the measurement; `current` alone doesn't show
it.

**`stateMnwMhw`.** Classification of the current value relative to the
**mean low water (MNW, *Mittlerer Niedrigwasserstand*)** and **mean high water
(MHW, *Mittlerer Hochwasserstand*)** marks.

**`stateNswHsw`.** Classification of the current value relative to the
**lowest navigable water (NSW, *Niedrigster Schifffahrtswasserstand*)** and
**highest navigable water (HSW, *Höchster Schifffahrtswasserstand*)** marks —
the bounds within which shipping is permitted.

**Characteristic values (gauge marks).** The set of reference marks published
for a timeseries (e.g. the MNW/MHW/NSW/HSW levels above). Embedded in each
timeseries via `--include-characteristic` (client: `includeCharacteristicValues`)
on `stations get` / `stations list`; there is no separate command. The exact shape is standard-specific, so the client
returns it as a faithful raw JSON object (`JsonObject`) rather than a guessed
type.

---

## Filtering, includes and the time window

**`ids`.** A list of station identifiers (uuid/number/shortname/longname) to
restrict a listing to. Sent to the API comma-separated. CLI: repeatable
`--ids <id>`.

**`ids` / `waters` / `fuzzyId` filters.** Narrow a `stations list` by station
id (`--ids`, repeatable), by water shortname (`--waters`) or by a fuzzy id match
(`--fuzzy-id`). The CLI has no filter by agency or by area; filter the JSON
output instead (e.g. with `jq` on `agency`, `latitude`, `longitude`). The API
reads an empty parameter as no filter, so a blank value (and, in the client, an
empty `ids` list) is rejected before any request: a usage error in the CLI,
`PegelValidationError` in the client.

**Include flags.** Optional expansions that embed extra data in a station /
timeseries response, off by default:

- **`includeTimeseries`** (`--include-timeseries`) — embed each station's
  timeseries list.
- **`includeCurrentMeasurement`** (`--include-current`) — embed the current
  measurement inside each timeseries.
- **`includeCharacteristicValues`** (`--include-characteristic`) — embed the
  characteristic (gauge-mark) values inside each timeseries.
- **`includeForecastTimeseries`** (`--include-forecast`, station requests only) — also
  list the forecast series (`WV`) in the timeseries list.

The API nests all three inside the timeseries list and silently drops them without
`includeTimeseries`, so on a station request each one implies
`includeTimeseries` (CLI and client) unless that is set explicitly.

**Time window (`start` / `end`).** The bounds of a `measurements` request, as
ISO-8601 instants. `start` may instead be an **ISO-8601 period/duration** such
as `P7D` ("the last 7 days") or `P3D`. CLI: `--start`, `--end`. A blank value
is rejected (a usage error in the CLI, `PegelValidationError` in the client)
rather than silently falling back to the default window.

---

## Reliability and limits

**Retry / backoff.** Transient **`429`** (Too Many Requests) and **`503`**
(Service Unavailable) responses, and connections the server reset, are retried
automatically, up to `maxRetries` times (default `2`; the CLI's `--max-retries` takes
`0`–`10`); a timeout is not. Each retry waits 200 ms × attempt, or longer when the
response's `Retry-After` (seconds or an HTTP date) asks — never shorter, so
`Retry-After: 0` doesn't make a burst. A `Retry-After` above 30 s
(`MAX_RETRY_AFTER_MS`) is not retried: the error surfaces at once and names the wait
the server asked for. `PegelApiError` exposes `isRetryable` for these statuses.

**Redirects.** The engine follows up to `maxRedirects` (default `5`) HTTP
redirects (301/302/303/307/308), resolving `Location` relative to the current
URL. Credentials — the userinfo of the base URL and any credential-bearing header —
stay on the same origin and are dropped when a redirect crosses to another one (a
401/403 after such a hop says so). Any other
3xx (300, 304, 305), a missing or malformed `Location`, and a hop past the limit
are an error (exit 1) that names the target: `redirect to <url> not followed`
(with `(stopped after 5 redirects)` at the limit) or `redirect not followed (no
Location header)`.

**Unencrypted base URL (`cleartextProblem`).** A base URL on plain `http:` sends every
request — and the base URL's userinfo, if any — unencrypted. The engine accepts it (a
local mirror may need it), but the CLI warns once per run on stderr, with a `WARN` record
of `pegel.http`: `WARN  [pegel.http] requests to <host> are sent unencrypted (http:, not
https:)`, or `… the base URL's credentials are sent unencrypted to <host> …` with userinfo
(never the password itself). Loopback hosts
(`localhost`, `127.x.x.x`, `::1`) are exempt; stdout and the exit code are unchanged.

**Timeout (`timeoutMs`).** Time limit per request in milliseconds, covering the
whole response body, not only idle gaps (default `30000`; `0` disables). CLI:
`--timeout`. The client enforces it for every transport, a custom one included.

**Response size cap (`maxResponseBytes`).** A hard cap on response body size to
defend against memory exhaustion (default 100 MiB; `0` = unlimited). CLI:
`--max-response-bytes`; the error names that flag.

**User-Agent (`userAgent`).** The `User-Agent` header value (default
`pegel-online-cli`, used only when the option is omitted). A blank value, control
characters (tab excepted) and characters above U+00FF, which an HTTP header cannot
carry, are rejected up front, which also closes header injection: the client throws
`PegelValidationError`, and the CLI's `--user-agent` reports a usage error (exit 2).

---

## Output and error handling

**JSON output.** Every command prints JSON to stdout — pretty-printed by default,
or on a single line with `--compact`.

**Exit codes.** `0` success; `2` for usage/parse errors (unknown command/option,
missing argument, invalid flag value, a single-value option given twice, a station
name that names several stations); `4` on a
`404` from the API; `1` for any other (runtime/network) error, an answer without the
documented shape included. A failed run keeps its code even when nothing reads stderr.

**Log record.** Every diagnostic line the CLI writes to stderr: a timestamp, a level
(`ERROR`, `WARN`, `INFO`) and a topic `pegel.<area>`, as text (log4j style) or with
`--log-format jsonl` as one JSON object per line. The areas: `cli` (usage errors,
commander's messages, an ambiguous station name, unexpected errors), `api` (the API's
answers: an error status, a malformed answer — bad JSON, the wrong shape, an unknown
charset —, and the notes below), `http` (the connection, the cleartext warning) and
`output` (a failed write to stdout). A record is always one line; control characters in
it are escaped.

**Notes.** `stations list` logs `INFO` records of `pegel.api` on stderr — still with exit
`0` — when an `--ids` entry, `--waters` or `--fuzzy-id` matched no station
(`INFO  [pegel.api] --ids "KOELN" matched no station; …`), and when two listed stations
share a name (`INFO  [pegel.api] "NEUSTADT" names 2 stations: …`).

---

> **Library & internals.** Terms for the TypeScript client and its internals —
> `PegelOnlineClient`, the request engine, transport, retry/backoff, error
> types, query builder — live in **[DEVELOPING.md](DEVELOPING.md)**.
