---
name: pegel-river-overview
description: >
  Give a whole-river snapshot of every gauge on a German waterway, ordered
  downstream by river kilometre, with live water levels and flood/low-water flags
  ranked, using the pegel-online-cli. Trigger when the user asks "show all gauges
  on the Rhine", "water levels along the Elbe", "any flooding on the Mosel right
  now?", "rank Danube stations by level", "which stations on the Weser are high?",
  or wants the state of a river end-to-end rather than one spot. Does the
  cross-station merge, km-ordering and flood ranking the bare CLI doesn't.
version: 1.0.0
userInvocable: true
---

# Pegel River Overview

Turn the per-station API into a **single ranked picture of a whole river** — every
gauge along it, ordered downstream by river kilometre, each with its live level and
a normal / high / low flag, leading with anything in flood or low water.

## Tooling

This skill drives the `pegel` command. **Before anything else, validate it is available** — run `command -v pegel` (or `pegel --version`). If it is not on your PATH, STOP and inform the user that the `pegel` CLI (`@maschinenlesbar.org/pegel-online-cli`) is not installed — installing it is their responsibility; never install it yourself, and do not fall back to `npx` or a local `node dist/...` build.

Data is fetched from the open PEGELONLINE REST API — read-only, **no API key**. Always `--compact`. The whole job of this skill is the cross-station merge, ordering and ranking the CLI deliberately leaves to you.

## Step 1 — Resolve the water shortname

`--waters` filters by a water **shortname**, not a free-text river name. Look it up:

```bash
pegel --compact waters | jq -r '.[] | [.shortname, .longname] | @tsv'
```

Pick the shortname (`RHEIN`, `ELBE`, `MOSEL`, `DONAU`, `WESER`, `MAIN`, …). "the
Rhine" → `RHEIN`, "the Danube" → `DONAU`. There are ~100 waters; if the match is
ambiguous, show the candidates and ask.

## Step 2 — Pull every gauge on it, WITH live levels

```bash
pegel --compact stations list --waters RHEIN --include-timeseries --include-current
```

> **The critical trap: `--include-current` does nothing on its own here.** The
> current reading is nested **inside** each station's `timeseries[]`, so without
> `--include-timeseries` there is no array to attach it to and the embed is
> silently dropped — you get bare station metadata and *no levels*. **Always pass
> both `--include-timeseries` and `--include-current` together.** (The README's
> `--waters RHEIN --include-current` example is misleading for this reason.)

Each item is a station. Fields that matter:

| Field | Meaning |
|---|---|
| `shortname` / `longname` | gauge name |
| `km` | **river kilometre** — the downstream-ordering key. Increases downstream. |
| `agency` | responsible WSV office (e.g. `STANDORT KÖLN`) |
| `longitude` / `latitude` | WGS84 coords |
| `water` | `{ shortname, longname }` |
| `timeseries[]` | present only with `--include-timeseries`; each has `shortname`, `longname`, `unit`, and (with `--include-current`) a nested `currentMeasurement` |

Inside the `W` timeseries' `currentMeasurement`: `value` (cm), `timestamp` (local
German offset), and `stateMnwMhw` / `stateNswHsw` (the flood/low-water flags;
values seen: `normal`, `high`, `low`, `unknown`).

## Step 3 — Order downstream and rank

1. **Order by `km` ascending** — that reads the river source→mouth (downstream).
   Some stations may lack `km`; sort those to the end and note it.
2. For each station, pull the **`W`** series' `currentMeasurement` (find the
   timeseries with `shortname === "W"`). Some stations publish no `W` (only `Q` or
   temperature) — mark them "no water-level series".
3. **Rank the alert list** by `stateMnwMhw`: `high` first (flood-leaning), then
   `low`, then `normal`/`unknown`. The headline is *how many gauges are not
   normal*, not the longest list.

Useful one-liner to flatten the merged data:

```bash
pegel --compact stations list --waters RHEIN --include-timeseries --include-current \
  | jq -r 'sort_by(.km)[]
      | . as $s
      | (.timeseries[]? | select(.shortname=="W")) as $w
      | [$s.km, $s.shortname, $w.currentMeasurement.value, $w.unit,
         $w.currentMeasurement.stateMnwMhw] | @tsv'
```

## Step 4 — Report

Lead with a verdict line (total gauges, how many high / low), then a downstream
table, flagging the non-normal ones:

```
RHEIN — 36 gauges, 0 high, 2 low water (as of 11 Jun, local time)
  km    gauge            level   state
  0.5   KONSTANZ-RHEIN   ...     low ⬇
  166   RHEINWEILER      ...     normal
  …
  654.8 BONN             182 cm  normal
  688   KÖLN             241 cm  normal
  …
```

Rules:
- Lead with the count of gauges **not normal**; that's the answer to "any
  flooding?". If all normal, say so plainly.
- Keep the table **km-ordered** (downstream) — that's the spatial story.
- Show `value` + unit (W is **cm**) and the state per gauge.
- A river can have 30–60+ gauges; a table is fine, but call out the high/low ones
  up top so the user doesn't have to scan.
- Don't fabricate a level for a gauge whose `currentMeasurement` is absent — say
  "no current W reading".
