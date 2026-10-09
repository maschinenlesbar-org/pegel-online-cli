# Usage

Real, use-case-driven examples for the `pegel` CLI — a command-line client for the
open [PEGELONLINE REST API v2](https://www.pegelonline.wsv.de/webservice/dokuRestapi)
(`pegelonline.wsv.de`), the live water-level service of the German federal
waterway administration (WSV). Every command prints JSON to stdout, so it pipes
cleanly into `jq`.

## Install

```bash
npm i -g @maschinenlesbar.org/pegel-online-cli
```

This installs the **`pegel`** binary. Without a global install you can run the
same commands via `node dist/src/cli/index.js …` from a built checkout.

A `<station>` argument may be a **uuid**, **number**, **shortname** or
**longname**. Names are not unique (`NEUSTADT` is a LEINE and an OSTSEE gauge): given a
name, `stations get`, `timeseries`, `current` and `measurements` first look it up (one
extra request; none for a number or uuid) and refuse a name that names several stations
with exit `2` and an `ERROR [pegel.cli] Invalid station "NEUSTADT": it names 2 stations, NEUSTADT
on LEINE (number 48800200, uuid …) and NEUSTADT on OSTSEE (number 9610080, uuid …); use
the number or uuid.` record on stderr (it lists the first 10 such stations and counts the
rest, `… (N more)`). A `[timeseries]` argument defaults to **`W`** (water level); other
common series are `Q` (flow/discharge), `WT` (water temperature) and `LT` (air
temperature), depending on the station.

## Use cases

### 1. List all bodies of water (Gewässer)

Discover the water shortnames you can later filter stations by.

```bash
pegel waters
```

Returns every Gewässer with its `shortname` and `longname`. Grab just the
shortnames:

```bash
pegel waters | jq -r '.[].shortname'
```

### 2. List all stations on one water

You want every gauge along the Rhine.

```bash
pegel stations list --waters RHEIN
```

`--waters` takes a water *shortname* (see use case 1). Reduce the output to a
name + location table:

```bash
pegel stations list --waters RHEIN | jq -r '.[] | [.shortname, .longitude, .latitude] | @tsv'
```

### 3. Current water level at a station

The single most common question: what's the level right now at Bonn?

```bash
pegel current BONN
```

Defaults to the `W` (water level) series. For the current flow instead, name the
series explicitly:

```bash
pegel current BONN Q
```

Pull just the value and timestamp:

```bash
pegel current BONN | jq '{value, timestamp}'
```

The measurement carries no unit: it is the series' `unit` — `cm` for most water
levels, but `m+NN`/`m+PNP` (metres) on canal and reservoir gauges. Get both at once with
`pegel stations get BONN --include-current | jq '.timeseries[] | {shortname, unit,
comment, currentMeasurement}'`; `comment` is there while the gauge is disturbed (state
`commented`). A `value` of `null` means the gauge sent no reading (its placeholder
`99999`).

### 4. Last N days of measurements (time window)

Plot or analyse a recent trend. `--start` accepts an ISO-8601 duration like
`P7D` (last 7 days) or an absolute instant.

```bash
pegel measurements BONN W --start P7D
```

Use an explicit window with both ends as ISO-8601 instants:

```bash
pegel measurements BONN W --start 2026-06-01T00:00:00Z --end 2026-06-07T00:00:00Z
```

Extract a CSV-ish series for a spreadsheet:

```bash
pegel measurements BONN W --start P3D | jq -r '.[] | select(.value != null) | [.timestamp, .value] | @csv'
```

### 5. Stations inside a geographic bounding box

Find all gauges in a map viewport — e.g. the Bonn/Cologne stretch of the Rhine.
Every station carries its `latitude`/`longitude`, so filter the full list to a
box with `jq`:

```bash
pegel stations list | jq '[.[] | select(.latitude >= 50.5 and .latitude <= 51.0 and .longitude >= 6.5 and .longitude <= 7.5)]'
```

The four bounds are the min/max latitude and longitude (decimal degrees, WGS84)
of the box. Pull just the shortnames inside it:

```bash
pegel stations list | jq -r '.[] | select(.latitude >= 50.5 and .latitude <= 51.0 and .longitude >= 6.5 and .longitude <= 7.5) | .shortname'
```

### 6. One station with its level and timeseries embedded

Get a full snapshot of a single gauge in one call — metadata, the list of
available series, and the current reading.

```bash
pegel stations get BONN --include-timeseries --include-current
```

The same three embed flags exist on `stations list`
(`--include-timeseries`, `--include-current`, `--include-characteristic`), so you
can fetch a water plus live levels in one request:

```bash
pegel stations list --waters RHEIN --include-current
```

The API nests the current measurement (and the gauge marks) *inside* each
station's timeseries and drops them without the timeseries list, so
`--include-current` and `--include-characteristic` imply `--include-timeseries`.
The reading is at `.timeseries[] | select(.shortname == "W") | .currentMeasurement`.

### 7. Characteristic (gauge-mark) values for a station

Compare today's level against statistical marks such as MNW/MHW (mean low/high
water) to judge flood or low-water risk. These gauge marks are exposed on the
station's timeseries via the `--include-characteristic` embed:

```bash
pegel stations get KÖLN --include-timeseries --include-characteristic
```

Pull just the marks for the `W` (water level) series:

```bash
pegel stations get KÖLN --include-timeseries --include-characteristic | jq '.timeseries[] | select(.shortname == "W") | .characteristicValues'
```

Not every series has characteristic values; one without marks comes back with an
empty `"characteristicValues": []` (at BONN, `Q` does; `W` has seven marks).

### 8. Timeseries metadata for a station

Discover which series a station actually offers and their units before querying
measurements.

```bash
pegel timeseries BONN
```

List every series shortname available at a station:

```bash
pegel stations get BONN --include-timeseries | jq -r '.timeseries[].shortname'
```

### 9. Look up several specific stations at once

Fetch a fixed set of gauges by id — uuids, numbers, shortnames or longnames —
using the repeatable `--ids` flag.

```bash
pegel stations list --ids BONN --ids KÖLN --ids EMMERICH --include-current
```

`--ids` is repeatable; supply it once per station. For an inexact name match use
`--fuzzy-id` instead. The API drops an id it doesn't know without saying so; the CLI
logs `INFO  [pegel.api] --ids "KOELN" matched no station; …` on stderr for each such id (exit 0, the
others are listed), and the same kind of note when `--waters` or `--fuzzy-id` matched
nothing. `--waters`, `--fuzzy-id`, `--start`, `--end` and the global options take one
value: giving one twice is a usage error (exit 2).

### 10. Filter stations by operating agency

Narrow a list to gauges run by a particular WSV office. Each station carries its
`agency`, so combine a `--waters` filter with `jq` to pick one office's gauges:

```bash
pegel stations list --waters RHEIN | jq '[.[] | select(.agency == "STANDORT KÖLN")]'
```

To find a station by (part of) its name instead, use the `--fuzzy-id` flag, which
matches the short/long name:

```bash
pegel stations list --fuzzy-id bonn
```

### 11. Water-level forecast (`WV`)

Some gauges carry a **forecast** series `WV` (*Wasserstandsvorhersage*) from the
Bundesanstalt für Gewässerkunde: predicted levels, not measurements, about four days
ahead in two-hour steps, in the series' `unit` (`cm` on the Rhine gauges). The API lists
it only on request — `--include-forecast` (implies `--include-timeseries`) shows which
gauges of a water have one:

```bash
pegel stations list --waters RHEIN --include-forecast \
  | jq -r '.[] | select(any(.timeseries[]; .shortname == "WV")) | "\(.shortname)\t\(.number)"'
```

The series' `start`/`end` are the forecast window and its `comment` names the run and
the source. The values come from `measurements`; each point carries `initialized` (when
the forecast was issued) and `type` — `forecast` for the nearer points, then
`estimate` (a rougher outlook) for the later ones:

```bash
pegel measurements 2730010 WV | jq -r '.[] | [.timestamp, .value, .type] | @tsv'   # KÖLN
```

A forecast has no current measurement: `pegel current <station> WV` exits `4`.

## Global options

These apply to every command and may be placed before or after it (before is
clearer):

| Option | Description |
| --- | --- |
| `-V, --version` | Print the version and exit |
| `--base-url <url>` | API base URL (default `https://www.pegelonline.wsv.de`); http(s) only, a path prefix is fine, no query (`?`), fragment (`#`), whitespace or control characters; userinfo is sent as Basic auth but shown as `***` in messages (write a literal `%` in it as `%25`). A plain `http:` URL to a host other than `localhost`, `127.x.x.x` or `::1` logs one warning on stderr, `WARN  [pegel.http] requests to <host> are sent unencrypted (http:, not https:)` (naming the base URL's credentials when it has userinfo, never printing them); stdout and the exit code are unchanged |
| `--timeout <ms>` | Time limit per request in milliseconds, reading the whole response included |
| `--user-agent <ua>` | `User-Agent` header value (not blank; Latin-1, no control characters) |
| `--max-retries <n>` | Retries for transient `429`/`503` responses and reset connections, `0`–`10` (default `2`); each waits 200 ms × attempt, or longer if the server's `Retry-After` asks (up to 30 s; a longer one is not retried, and the error names the wait). A timeout is not retried |
| `--max-response-bytes <n>` | Cap response body size in bytes (`0` = unlimited; default 100 MiB) |
| `--compact` | Print JSON on a single line instead of pretty-printed |
| `--log-format <format>` | How errors, warnings and notes are written to stderr: `text` (default; log4j style, `2026-10-09T14:03:12.481Z WARN  [pegel.http] …`) or `jsonl` (one JSON object per line: `ts`, `level`, `topic`, `msg`). stdout is not affected |
| `-h, --help` | Show help for the program or a command |

Example combining a global option with a command:

```bash
pegel --compact current BONN | jq '.value'
```

Exit codes: `0` success, `2` usage/parse errors (unknown command/option, missing
argument, invalid flag value, a station name that names several stations), `4` on a `404` from the API, `1` for any other
runtime/network error.
