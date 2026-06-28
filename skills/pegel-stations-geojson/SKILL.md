---
name: pegel-stations-geojson
description: >
  Export German waterway gauges as valid GeoJSON for mapping — optionally with
  their live water levels baked into each point's properties — using the
  pegel-online-cli. Trigger when the user asks to "map the Rhine gauges", "export
  Elbe stations as GeoJSON", "plot all water-level stations near Cologne", "show
  gauges with current levels on a map", or wants station geodata for Leaflet /
  geojson.io / QGIS / Kibana. Emits a clean FeatureCollection in correct
  [lon, lat] order, handling the embed quirk.
version: 1.0.0
userInvocable: true
---

# Pegel → GeoJSON Export

Turn a station listing into a **valid GeoJSON `FeatureCollection`** ready for
geojson.io, Leaflet, QGIS, or Kibana — optionally enriching each gauge point with
its live water level and flood/low-water state.

## Tooling

This skill drives the `pegel` command. **Before anything else, validate it is available** — run `command -v pegel` (or `pegel --version`). If it is not on your PATH, STOP and inform the user that the `pegel` CLI (`@maschinenlesbar.org/pegel-online-cli`) is not installed — installing it is their responsibility; never install it yourself, and do not fall back to `npx` or a local `node dist/...` build.

Data is fetched from the open PEGELONLINE REST API — read-only, **no API key**. Always `--compact`.

## Step 1 — Fetch the stations

Scope the listing to what the user wants:

```bash
pegel --compact stations list --waters RHEIN                       # one river
pegel --compact stations list                                      # all gauges, network-wide
pegel --compact stations list --ids BONN --ids KÖLN --ids EMMERICH # a fixed set
```

To bake **live levels** into the map, add **both** embed flags (see trap):

```bash
pegel --compact stations list --waters RHEIN --include-timeseries --include-current
```

> **Trap: `--include-current` is silently ignored without `--include-timeseries`.**
> The current reading lives **inside** each station's `timeseries[]`; with no
> `--include-timeseries` there's no array to attach it to, so you get bare metadata
> and no levels. To enrich points with levels, **pass both flags together.**

> **No `--bbox` flag exists.** Despite what some docs imply, the CLI has no
> bounding-box option. To restrict to a map viewport, fetch the listing and filter
> by `latitude`/`longitude` with `jq` (see Step 3).

## Step 2 — Build the GeoJSON

Each station carries numeric `longitude` and `latitude` (WGS84, already decimal
degrees — **not** strings, no split needed). GeoJSON wants `[longitude, latitude]`
(x, y) order:

```js
// per station
const feature = {
  type: "Feature",
  geometry: { type: "Point", coordinates: [station.longitude, station.latitude] }, // [lon, lat]
  properties: {
    uuid: station.uuid,
    shortname: station.shortname,
    longname: station.longname,
    number: station.number,
    km: station.km,
    agency: station.agency,
    water: station.water?.shortname,
    // when embeds were requested, pull the W series' current reading:
    level: w?.currentMeasurement?.value,          // cm
    unit: w?.unit,                                 // "cm"
    state: w?.currentMeasurement?.stateMnwMhw,     // normal | high | low | unknown
    measuredAt: w?.currentMeasurement?.timestamp,  // local German offset
  },
};
// where: const w = (station.timeseries || []).find(t => t.shortname === "W");
```

Wrap them: `{ "type": "FeatureCollection", "features": [ … ] }`.

A jq one-liner that does the whole thing (with levels):

```bash
pegel --compact stations list --waters RHEIN --include-timeseries --include-current \
  | jq '{type:"FeatureCollection", features: [ .[]
      | . as $s | (.timeseries[]? | select(.shortname=="W")) as $w
      | { type:"Feature",
          geometry:{type:"Point", coordinates:[$s.longitude, $s.latitude]},
          properties:{ shortname:$s.shortname, longname:$s.longname, km:$s.km,
                       agency:$s.agency, water:$s.water.shortname,
                       level:$w.currentMeasurement.value, unit:$w.unit,
                       state:$w.currentMeasurement.stateMnwMhw } } ] }'
```

## Step 3 — (Optional) viewport filter

There is no `--bbox`; filter coordinates with `jq` before building features. The
box is min/max latitude and longitude (decimal degrees, WGS84):

```bash
pegel --compact stations list \
  | jq '[ .[] | select(.latitude  >= 50.5 and .latitude  <= 51.0
                   and .longitude >= 6.5  and .longitude <= 7.5) ]'
```

## Step 4 — Output & validate

Write the FeatureCollection to a file the user can open (default
`./pegel-<water-or-scope>.geojson`) and report **the path you wrote and the feature count**.
If a name the user supplied already exists, confirm before overwriting it (re-running with
the default name to refresh is fine). Validity checklist before handing it over:

- coordinates are `[longitude, latitude]` (x, y) — **not** `[lat, lon]`;
- they're **numbers** (the API already gives numbers; don't quote them);
- the whole thing parses as JSON and is a single `FeatureCollection`.

Notes:
- Skip any station missing `longitude`/`latitude` (rare) and report how many were
  dropped.
- The full network is hundreds of gauges — fine as a map layer, but warn before
  pasting it inline as text; offer to open it at https://geojson.io.
- Offer to color points by `state` (high/low/normal) when levels were embedded.
