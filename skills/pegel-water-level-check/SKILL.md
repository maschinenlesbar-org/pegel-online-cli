---
name: pegel-water-level-check
description: >
  Report the live water level at one or more German waterway gauges and judge
  whether it is normal, high (flood-leaning) or low, using the pegel-online-cli.
  Trigger when the user asks "what's the Rhine level at Bonn?", "is the water
  high in Cologne?", "current gauge reading at Emmerich", "flood risk at Köln?",
  "how high is the Elbe at Dresden right now?", or wants a quick now-cast for
  named gauges. Pulls the current measurement plus its state classification and
  reports value, unit, timestamp and a plain-language verdict — not raw JSON.
version: 1.0.0
userInvocable: true
---

# Pegel Water-Level Check

Answer "what's the level right now, and should I worry?" for one or more named
gauges — turning a bare number into a value + unit + timestamp + a normal / high /
low verdict, across as many stations as the user named.

## Tooling

This skill drives the `pegel` command. **Before anything else, validate it is available** — run `command -v pegel` (or `pegel --version`). If it is not on your PATH, STOP and inform the user that the `pegel` CLI (`@maschinenlesbar.org/pegel-online-cli`) is not installed — installing it is their responsibility; never install it yourself, and do not fall back to `npx` or a local `node dist/...` build.

Data is fetched from the open PEGELONLINE REST API — read-only, **no API key**. Pass `--compact` so each result is one line, easy to pipe into `jq`. A `<station>` may be a **shortname** (`BONN`, `KÖLN`), a **number**, a **longname** or a **uuid**.

## Step 1 — Resolve the station(s)

Map each place the user named to a station selector. Shortnames are usually the
upper-cased town name (`BONN`, `EMMERICH`, `DRESDEN`). If unsure or a name is
ambiguous, resolve it first — **don't guess and 404**:

```bash
pegel --compact stations list --fuzzy-id bonn
```

`--fuzzy-id` matches against short/long name and returns matching stations with
their `shortname`, `uuid`, `km`, `water` and coordinates. Use the `shortname` (or
`uuid`) from there. Note: a station selector that doesn't exist returns **exit
code 4** ("not found") — that means a wrong name, not a service outage.

## Step 2 — Pull the current reading

For each resolved station, fetch the current measurement. Default series is **`W`**
(water level, in `cm`); name another series for a different quantity (`Q` flow in
`m³/s`, `WT` water temperature in `°C`, `LT` air temperature):

```bash
pegel --compact current BONN          # W water level, the default
pegel --compact current BONN Q        # flow / discharge
```

The response is a single object:

| Field | Meaning |
|---|---|
| `value` | The reading, a number **in the series' unit** (W → cm, Q → m³/s, WT → °C) |
| `timestamp` | ISO-8601 with a **local German offset** (`+02:00` in summer), not UTC |
| `stateMnwMhw` | Classification vs. mean low / mean high water — the flood/low-water verdict. Seen values: `normal`, `high`, `low`, `unknown` |
| `stateNswHsw` | Classification vs. lowest / highest *navigable* water (shipping bounds). Often `unknown` |

> **Unit is not in this response.** `value` is just a number; the unit (`cm`,
> `m³/s`, `°C`) belongs to the series, not the measurement. Default `W` is **cm**.
> If you need to state the unit and it isn't obvious, get it from
> `pegel timeseries <station> <series>` (its `unit` field) — don't assume metres.

## Step 3 — Judge the level

The reliable flood/low-water signal is **`stateMnwMhw`** on the current
measurement, **not** the gauge marks. Map it to plain language:

- `normal` → normal range.
- `high` → high water / flood-leaning — call it out.
- `low` → low water (shipping/ecology concern).
- `unknown` → the station has no MNW/MHW reference for this series; say "no flood
  reference published" rather than implying it's fine. (`Q` flow and many
  temperature series carry **no** state fields at all — same handling.)

If the user explicitly wants the numeric flood thresholds, those live in the
gauge marks: `pegel stations get <station> --include-timeseries
--include-characteristic`, then read the `characteristicValues[]` of the `W`
series. **Heads-up:** those marks are river-specific codes (e.g. `GlW`, `M_I`,
`M_II` on the Rhine), **not** a tidy MNW/MHW pair — present them verbatim and
don't invent a missing MNW/MHW.

## Step 4 — Report

One concise line per station: value + unit, the verdict, the reading time, and the
water it's on. Example:

```
Rhine water levels (as of 11 Jun, 00:00 local):
  BONN      182 cm   normal
  KÖLN      241 cm   normal
  EMMERICH  ...      high ⚠ — above mean high water
```

Rules:
- Always show the **unit** and the **timestamp** — a level with no unit/time is
  useless. Note the timestamp is local German time.
- Lead with anything `high` or `low`; group the `normal`/`unknown` ones.
- For multiple stations, fetch each with its own `current` call (they're cheap)
  or, if they share one water, use the river overview approach (one list call
  with embeds — see `pegel-river-overview`).
- Don't convert cm↔m or fabricate a flood percentage the data doesn't give.
