---
name: pegel-trend
description: >
  Analyse the recent water-level (or flow/temperature) trend at a German gauge
  over a time window — rising or falling, by how much, and how fast — using the
  pegel-online-cli. Trigger when the user asks "is the Rhine at Bonn rising or
  falling?", "level trend over the last 7 days at Köln", "how fast is the Elbe
  dropping?", "plot the last 3 days for Dresden", "min/max/now this week", or
  wants a time-series summary instead of one instantaneous reading. Pulls the
  measurement window and reduces it to direction, delta, rate and extremes.
compatibility: >
  Requires the `pegel` CLI (npm package @maschinenlesbar.org/pegel-online-cli)
  on PATH, installed by the user; the skill never installs it. Uses jq for JSON
  filtering. Network access to www.pegelonline.wsv.de.
---

# Pegel Trend

Reduce a window of raw measurements into a useful trend: current vs. start, the
delta, the direction (rising / falling / steady), the rate, and the min/max over
the window — instead of dumping hundreds of timestamped points.

## Tooling

This skill drives the `pegel` command. **Before anything else, validate it is available** — run `command -v pegel` (or `pegel --version`). If it is not on your PATH, STOP and inform the user that the `pegel` CLI (`@maschinenlesbar.org/pegel-online-cli`) is not installed — installing it is their responsibility; never install it yourself, and do not fall back to `npx` or a local `node dist/...` build.

This skill also filters JSON with `jq`. **Validate it too** — run `command -v jq`. If it is missing, inform the user that `jq` is not installed — installing it is their responsibility; never install it yourself — and carry on without it: filter the CLI output with `node -e` instead (Node is already on your PATH, since the CLI runs on it).

Data is fetched from the open PEGELONLINE REST API — read-only, **no API key**. Always `--compact`. `<station>` may be a shortname (`BONN`), number, longname or uuid; `[timeseries]` defaults to **`W`** (water level). `Q` = flow, `WT`/`LT` = temperatures. **Read the unit from the series** (Step 2) — most `W` series are in cm, but canal and reservoir gauges publish `m+NN`/`m+PNP` (metres).

## Step 1 — Resolve the station (if needed)

If you're unsure of the exact selector, resolve it first with
`pegel --compact stations list --fuzzy-id <name>` and take the `shortname` — unless two
results share it (`NEUSTADT`: LEINE and OSTSEE; the CLI prints a `Note: … names 2
stations` on stderr): a lookup by that name is refused (**exit code 2**, an `Invalid
station "NEUSTADT": it names 2 stations …` error listing each one's number and uuid), so
use the `number` (or `uuid`) of the station the user means. A wrong selector returns
**exit code 4**.

## Step 2 — Get the unit, then pull the measurement window

The measurements carry no unit. Read it from the series first (one call):

```bash
pegel --compact timeseries BONN W | jq '{unit, comment}'
```

If a `comment` comes back (e.g. `"Funktionsstörung, fehlerhafte Messwerte"`), the
gauge is disturbed and its readings may be wrong: say so first, with the comment, and
present any trend as unreliable.

Most `W` series answer `cm`, but canal and reservoir gauges answer **`m+NN`** (metres
above sea level, e.g. MÜNSTER OW ≈ 56.5) or **`m+PNP`** — there a change of `0.02` is
2 cm, not 0.02 cm. Use the unit as given in every number you report.

`--start` accepts an **ISO-8601 period** (relative, easiest) or an absolute
instant; `--end` is an absolute instant (defaults to now):

```bash
pegel --compact measurements BONN W --start P7D                 # last 7 days
pegel --compact measurements BONN W --start P3D                 # last 3 days
pegel --compact measurements BONN W \
  --start 2026-06-01T00:00:00Z --end 2026-06-07T00:00:00Z       # explicit window
```

The response is an **array of points**, oldest→newest, each `{ timestamp, value }`.
**`value` is `null` for a point without a reading** — the CLI turns the gauge's
placeholder `99999` into `null` (PANNERDENSE KOP sent hundreds of them, interleaved
with real readings, in October 2026). Drop the `null` points before reducing, and say
how many there were.
`value` is in the series' `unit` (from the call above). `timestamp` carries a **local German
offset** (`+02:00` in summer); even when you pass `Z` (UTC) bounds, the returned
timestamps are local. Default series sampling is ~15 min, so a week is ~670 points
— never enumerate them; reduce.

> **Trap: a bad `--start` is an error, an empty window is not.** An unparseable
> period/date (e.g. `7d`) makes the API return **HTTP 400**; the CLI prints
> `Error: HTTP 400 … Given start parameter is neither a valid ISO date time, nor an
> ISO period.` to stderr, leaves stdout empty and **exits 1**. Fix the period
> (`P7D`, not `7d`) and retry. A window that starts in the future is also an
> **HTTP 400 / exit 1** (`Start datetime … not before end datetime …`). A valid
> window outside the data kept (e.g. January when it is September) returns `[]`
> with **exit 0**, and the reduction below fails on an empty array — check
> `length > 0` first. A window longer than the data kept is
> clamped: on 2026-09-15, `--start P60D` returned only about the last month.

## Step 3 — Reduce to a trend

From the array, **without its `null` points** (call it `pts`, oldest→newest; if
nothing is left, there is no trend to report — say the gauge sent no readings in the
window):

- **start** = `pts[0].value`, **last** = `pts[last].value` — the latest reading, which
  is **not necessarily "now"**: some gauges lag by hours (on 2026-10-05 at 17:19 the
  Elbe gauge NEU DARCHAU's last point was 06:15, 11 h old). Check its age (`age_h`
  below).
- **delta** = `last − start`; **direction** = rising / falling / steady (treat a
  tiny delta relative to the window's range as steady).
- **rate** = `delta` over the window length (e.g. cm/day) — divide by the span
  between `pts[0].timestamp` and `pts[last].timestamp`.
- **min / max** with their timestamps; the **range** = max − min.

```bash
pegel --compact measurements BONN W --start P7D \
  | jq 'def epoch: (.[0:19] + "Z" | fromdateiso8601)
          - (if .[19:20] == "-" then -1 else 1 end)
            * ((.[20:22] | tonumber) * 3600 + (.[23:25] | tonumber) * 60);
        (map(select(.value != null))) as $p
        | {n:length, missing:(length - ($p|length))}
          + if ($p|length) == 0 then {} else
            {start:$p[0].value, last:$p[-1].value,
             delta:($p[-1].value - $p[0].value),
             min:($p|map(.value)|min), max:($p|map(.value)|max),
             from:$p[0].timestamp, to:$p[-1].timestamp,
             age_h:(((now - ($p[-1].timestamp | epoch)) / 360 | floor) / 10)} end'
```

Optionally hand the user a CSV they can chart:

```bash
pegel --compact measurements BONN W --start P3D | jq -r '.[] | select(.value != null) | [.timestamp, .value] | @csv'
```

## Step 4 — Report

A short narrative + the numbers that back it:

```
BONN (Rhine), water level — last 7 days
  182 cm at 11 Jun 00:00, was 196 cm  →  falling 14 cm (≈ 2 cm/day)
  range over window: 178–197 cm  (min 09 Jun 04:00, max 04 Jun 12:00)
  670 readings, 15-min spacing
```

Rules:
- Lead with **direction + delta** ("falling 14 cm over 7 days") — that's the
  answer; the extremes and rate are support.
- **Check the last reading's age** (`age_h`). Older than about two hours: say "last
  reading at <time>, <N> h ago — the gauge is lagging", and never call it the level
  "now" or the trend "current".
- Always state the **unit** (as read in Step 2 — never assumed) and the **window** you actually got back
  (`from`/`to`), since the API may clamp to available data.
- Offer the CSV/plot follow-up; don't paste hundreds of raw points inline.
- For "rising or falling *right now*" prefer a short window (`P1D`) so noise
  doesn't bury the recent move; for "this week" use `P7D`.
- Pair with `pegel-water-level-check` if the user also wants the flood/low-water
  verdict — the trend says *direction*, `stateMnwMhw` says *how serious*.
