---
name: pegel-river-overview
description: >
  Give a whole-river snapshot of every gauge on a German waterway, ordered
  along the river by river kilometre, with live water levels and flood/low-water flags
  ranked, using the pegel-online-cli. Trigger when the user asks "show all gauges
  on the Rhine", "water levels along the Elbe", "any flooding on the Mosel right
  now?", "rank Danube stations by level", "which stations on the Weser are high?",
  or wants the state of a river end-to-end rather than one spot. Does the
  cross-station merge, km-ordering and flood ranking the bare CLI doesn't.
compatibility: >
  Requires the `pegel` CLI (npm package @maschinenlesbar.org/pegel-online-cli)
  on PATH, installed by the user; the skill never installs it. Uses jq for JSON
  filtering. Network access to www.pegelonline.wsv.de.
---

# Pegel River Overview

Turn the per-station API into a **single ranked picture of a whole river** — every
gauge along it, ordered by river kilometre in the river's flow direction, each with
its live level and a normal / high / low flag, leading with anything in flood or low
water.

## Tooling

This skill drives the `pegel` command. **Before anything else, validate it is available** — run `command -v pegel` (or `pegel --version`). If it is not on your PATH, STOP and inform the user that the `pegel` CLI (`@maschinenlesbar.org/pegel-online-cli`) is not installed — installing it is their responsibility; never install it yourself, and do not fall back to `npx` or a local `node dist/...` build.

This skill also filters JSON with `jq`. **Validate it too** — run `command -v jq`. If it is missing, inform the user that `jq` is not installed — installing it is their responsibility; never install it yourself — and carry on without it: filter the CLI output with `node -e` instead (Node is already on your PATH, since the CLI runs on it).

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

> **The critical trap: the current reading lives inside `timeseries[]`.** The API
> nests it **inside** each station's `timeseries[]` and silently drops it without
> `--include-timeseries`. Current `pegel` versions turn that flag on for you when
> `--include-current` is given, but pegel 0.0.8 and older do not — you would get
> bare station metadata and *no levels*. **Always pass both
> `--include-timeseries` and `--include-current` together**; that works on every
> version.

Each item is a station. Fields that matter:

| Field | Meaning |
|---|---|
| `shortname` / `longname` | gauge name |
| `km` | **river kilometre** of the waterway's own chainage — the ordering key, but its direction differs between rivers (see Step 3). |
| `agency` | responsible WSV office (e.g. `STANDORT KÖLN`) |
| `longitude` / `latitude` | WGS84 coords |
| `water` | `{ shortname, longname }` |
| `timeseries[]` | present only with `--include-timeseries`; each has `shortname`, `longname`, `unit`, and (with `--include-current`) a nested `currentMeasurement` |

Inside the `W` timeseries' `currentMeasurement`: `value` (cm), `timestamp` (local
German offset), and `stateMnwMhw` / `stateNswHsw` (the flood/low-water flags;
values seen: `normal`, `high`, `low`, `unknown`, `out-dated`). `out-dated` is the
API's own staleness flag: the reading is too old to classify (ELBE's SANDAU and
NEU DARCHAU on 2026-09-26), so it is no verdict at all.

## Step 3 — Order along the river and rank

1. **Order by `km`, after checking the river's direction.** `km` follows each
   waterway's official chainage, which does not always grow downstream (checked
   2026-09-15):
   - grows downstream: `RHEIN` (KONSTANZ-RHEIN 0.5 → EMMERICH 851.9), `ELBE`
     (SCHÖNA 2.05 → CUXHAVEN STEUBENHÖFT 724);
   - counts **down** towards the mouth: `DONAU` (INGOLSTADT LUITPOLDSTRASSE
     2458.3 → PASSAU DONAU 2226.7 → the Austrian gauges down to 1879.2) — sort
     descending;
   - counts **up from the mouth**, so ascending km runs upstream: `MOSEL`
     (Koblenz-Lützel DFH 1.3 → Perl 241.8), `MAIN`, `NECKAR`, `SAAR` — sort
     descending for source→mouth;
   - `WESER` has two chainages that each start near 0: HANN.MUENDEN 0.65 →
     WESERWEHR UW 362.79 above the Bremen weir, then GROSSE WESERBRÜCKE 0.04 →
     LEUCHTTURM ALTE WESER 115 below it. One km sort interleaves them; split
     the list (the upper section has agencies HANN-MÜNDEN and VERDEN plus the
     BREMEN gauges at km 355 and above) and order each part.

   For any other river, compare the km of two gauges whose position you know
   before sorting, and say in the report which way the table reads. Stations
   without `km` go to the end; note them. Odd values happen: on `ELBE`,
   PRELOUC (Czech, POVODÍ LABE) is at km -220.1 and WITTENBERGGÜTE (a BFG
   KOBLENZ quality station) at km 1, although the WITTENBERG gauge is at km
   214.14.
2. For each station, pull the **`W`** series' `currentMeasurement` (the first
   timeseries with `shortname == "W"`). Some stations publish no `W` (only `Q`,
   temperature or water-quality series) — keep them in the table and mark them
   "no water-level series".
3. **Check how old each reading is.** Most gauges update every 15 minutes, but
   some lag by hours and keep their last state flag: on 2026-09-15 at 22:20,
   ELBE's PIRNA still showed 12:15 and NEU DARCHAU 23:00 the day before, both
   `low`. Mark readings older than about two hours as stale.
4. **Rank the alert list** by `stateMnwMhw`: `high` first (flood-leaning), then
   `low`, then `normal`/`unknown`; list `out-dated` gauges apart as "no current
   reading", never as normal. The headline is *how many gauges are not
   normal*, not the longest list.

One-liner to flatten the merged data, one row per station (set `dir` to `1`
where km grows downstream, `-1` where it counts down towards the mouth):

```bash
pegel --compact stations list --waters RHEIN --include-timeseries --include-current \
  | jq -r --argjson dir 1 'sort_by(.km == null, (.km // 0) * $dir)[]
      | . as $s
      | ([.timeseries[]? | select(.shortname=="W")][0]) as $w
      | [$s.km, $s.shortname,
         (if $w == null then "no W series"
          else ($w.currentMeasurement.value // "no current W") end),
         ($w.unit // ""), ($w.currentMeasurement.stateMnwMhw // ""),
         ($w.currentMeasurement.timestamp // "")] | @tsv'
```

Readings older than two hours (German timestamps carry their offset, so they
are converted to epoch seconds first):

```bash
pegel --compact stations list --waters ELBE --include-timeseries --include-current \
  | jq -r 'def epoch: (.[0:19] + "Z" | fromdateiso8601)
             - (if .[19:20] == "-" then -1 else 1 end)
               * ((.[20:22] | tonumber) * 3600 + (.[23:25] | tonumber) * 60);
      .[] | . as $s
      | ([.timeseries[]? | select(.shortname=="W")][0].currentMeasurement) as $c
      | select($c != null and (now - ($c.timestamp | epoch)) > 7200)
      | [$s.shortname, $c.timestamp, $c.stateMnwMhw] | @tsv'
```

## Step 4 — Report

Lead with a verdict line (total gauges, how many high / low), then a table in
flow order, flagging the non-normal ones:

```
RHEIN — 36 gauges, 0 high, 2 low water (most readings 11 Jun 00:00 local; 1 stale)
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
- Keep the table **km-ordered in flow direction** — that's the spatial story.
  Say which way it reads when the river's km count down or restart.
- Show `value` + unit (W is **cm**) and the state per gauge.
- A river can have 30–60+ gauges; a table is fine, but call out the high/low ones
  up top so the user doesn't have to scan.
- Don't fabricate a level for a gauge whose `currentMeasurement` is absent — say
  "no current W reading".
- Don't give one "as of" time that hides stale gauges: give the time most
  readings share and name the stale ones with their own timestamp.
