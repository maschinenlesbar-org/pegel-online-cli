# pegel-online-cli

Check live water levels and gauge readings for any German federal waterway station
from your terminal. `pegel` is a command-line tool over the open
[PEGELONLINE REST API v2](https://www.pegelonline.wsv.de/webservice/dokuRestapi)
(`pegelonline.wsv.de`) operated by the WSV — find stations, query current readings,
pull measurement histories, and get the full picture on any gauge — as clean JSON
you can pipe straight into [`jq`](https://jqlang.github.io/jq/).

- **Works out of the box** — no account, no API key, no configuration. Install and query.
- **Clean JSON output** — pretty-printed by default, `--compact` for one-line/scripting.
- **Covers the full hierarchy** — bodies of water, stations, timeseries, current readings, measurement windows, and gauge marks.
- **Live data** — readings update continuously from hundreds of federal gauges across Germany's rivers and canals.

> Want to use this as a TypeScript library or understand how it's built?
> See **[DEVELOPING.md](DEVELOPING.md)**.

## Install

```bash
npm i -g @maschinenlesbar.org/pegel-online-cli
```

This installs the **`pegel`** command. Requires **Node.js 20+**.

Check it works:

```bash
pegel --help
```

## Quickstart

No setup needed — the API is public and requires no key. Your first command:

```bash
pegel waters
```

This lists every body of water (*Gewässer*) in the network. Grab just the shortnames
with `jq`:

```bash
pegel waters | jq -r '.[].shortname'
```

Pick one — say `RHEIN` — and get the current water level at Bonn:

```bash
pegel current BONN
```

Pull just the value and timestamp:

```bash
pegel current BONN | jq '{value, timestamp}'
```

## Commands

```text
stations list  [filters…]                 list / filter stations
stations get   <station> [includes…]      full details for one station
timeseries     <station> [timeseries]     metadata for a timeseries
current        <station> [timeseries]     the current measurement
measurements   <station> [timeseries]     a window of measurements
waters                                    list all bodies of water (Gewässer)
```

A `<station>` may be a **uuid**, **number**, **shortname** or **longname** — e.g.
`BONN`, `6302010`, or a full UUID. A `[timeseries]` defaults to **`W`** (water
level); other codes include `Q` (flow/discharge), `WT` (water temperature), and
`LT` (air temperature) depending on the station.

### `stations list` filters

| Flag | Meaning |
| --- | --- |
| `--ids <id>` | station id (uuid/number/shortname/longname); repeatable |
| `--waters <shortname>` | filter by water shortname (see `waters`) |
| `--fuzzy-id <id>` | fuzzy match against short/long name |
| `--include-timeseries` | embed each station's timeseries list |
| `--include-current` | embed the current measurement |
| `--include-characteristic` | embed characteristic (gauge-mark) values |

### `stations get` options

| Flag | Meaning |
| --- | --- |
| `--include-timeseries` | embed the station's timeseries list |
| `--include-current` | embed the current measurement |
| `--include-characteristic` | embed characteristic (gauge-mark) values |

### `measurements` options

| Flag | Meaning |
| --- | --- |
| `--start <iso>` | window start — ISO-8601 instant *or* a period like `P7D` |
| `--end <iso>` | window end — ISO-8601 instant |

The **[Glossary](GLOSSARY.md)** explains every domain term and timeseries code.

## Common tasks

A few recipes to get going — see **[Usage.md](Usage.md)** for the full,
use-case-driven set.

```bash
# All stations on the Rhine, with their current water level
pegel stations list --waters RHEIN --include-current

# One station — metadata + timeseries list + current reading
pegel stations get BONN --include-timeseries --include-current

# Current water level at Bonn (default timeseries W)
pegel current BONN

# Current flow at Bonn (timeseries Q)
pegel current BONN Q

# Last 7 days of measurements
pegel measurements BONN W --start P7D

# Explicit date window
pegel measurements BONN W --start 2026-06-01T00:00:00Z --end 2026-06-07T00:00:00Z

# Gauge marks (MNW/MHW/NSW/HSW) for Cologne
pegel stations get KÖLN --include-timeseries --include-characteristic

# Timeseries metadata — discover which series a station exposes
pegel timeseries BONN

# Multiple specific stations in one call
pegel stations list --ids BONN --ids KÖLN --ids EMMERICH --include-current
```

## Output & scripting

Every command prints **pretty JSON to stdout**. Errors and diagnostics go to
stderr, so piping stdout into `jq` stays clean.

```bash
# Water shortnames, one per line
pegel waters | jq -r '.[].shortname'

# Reshape a current measurement
pegel current BONN | jq '{value, timestamp}'

# CSV-ish series for a spreadsheet
pegel measurements BONN W --start P3D | jq -r '.[] | [.timestamp, .value] | @csv'

# Station names and coordinates on the Rhine (tab-separated)
pegel stations list --waters RHEIN | jq -r '.[] | [.shortname, .longitude, .latitude] | @tsv'

# Gauge marks for the W series at Cologne
pegel stations get KÖLN --include-timeseries --include-characteristic \
  | jq '.timeseries[] | select(.shortname == "W") | .characteristicValues'
```

Use `--compact` for single-line JSON in pipelines and logs:

```bash
pegel --compact current BONN | jq '.value'
```

`--compact` (and every global option) works **before or after** the command —
both `pegel --compact waters` and `pegel waters --compact` do the same thing.

**Exit codes** make the CLI easy to use in scripts:

| Code | Meaning |
| --- | --- |
| `0` | success (also `--help` / `--version`) |
| `2` | bad usage / invalid argument (nothing was sent) |
| `4` | station or resource not found (`404`) |
| `1` | any other error (network, timeout, unexpected response) |

## Troubleshooting

- **`command not found: pegel`** — the global npm bin directory isn't on your
  `PATH`. Run `npm bin -g` to find it and add it, or run via
  `npx @maschinenlesbar.org/pegel-online-cli …`.
- **Exit `2` / "invalid argument"** — check the command syntax: a `<station>`
  argument is required, and `--start` / `--end` must be valid ISO-8601 instants or
  periods (e.g. `P7D`). Run `pegel <command> --help` for the exact signature.
- **Exit `4` / "not found"** — the station shortname or id doesn't exist. Run
  `pegel stations list --fuzzy-id <name>` or `pegel waters` to find the right
  shortname.
- **Exit `1` / network error** — connectivity, DNS, or a timeout. Try again, or
  raise the limit with `--timeout 60000`.
- **Empty `timeseries` array** — the station doesn't publish the requested series.
  Run `pegel timeseries <station>` to see which codes it actually exposes.

## Global options

These apply to every command and may be given before *or* after it:

| Option | Description |
| --- | --- |
| `-V, --version` | Print the version number |
| `-h, --help` | Show help for the program or a command |
| `--compact` | Print JSON on a single line instead of pretty-printed |
| `--base-url <url>` | API base URL (default `https://www.pegelonline.wsv.de`) |
| `--timeout <ms>` | Per-request timeout in milliseconds (default `30000`) |
| `--user-agent <ua>` | `User-Agent` header value |
| `--max-retries <n>` | Retries for transient `429`/`503` responses (default `2`) |
| `--max-response-bytes <n>` | Cap response body size in bytes (`0` = unlimited; default 100 MiB) |

## Learn more

- **[Usage.md](Usage.md)** — full use-case-driven cookbook.
- **[GLOSSARY.md](GLOSSARY.md)** — every domain term, timeseries code, and state classification explained.
- **[DEVELOPING.md](DEVELOPING.md)** — TypeScript library usage, architecture, testing, CI.

## License

**Dual-licensed** — use it under **either**:

- **[AGPL-3.0-or-later](LICENSE)** (default, free). Note the AGPL's §13 network
  clause: if you run a modified version as a network service, you must offer that
  modified source to the service's users.
- **Commercial license** (paid), for closed-source / proprietary or SaaS use
  without the AGPL's obligations.

See **[LICENSING.md](LICENSING.md)** for details, and **[CONTRIBUTING.md](CONTRIBUTING.md)**
for the contribution policy (this project does not accept external code
contributions). Commercial enquiries: **sebs@2xs.org**.
