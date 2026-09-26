# Examples

Real examples for the Claude Code skills of the `pegel` plugin, one per skill: a request,
the `pegel` commands the skill ran, and the answer Claude gave.

Every example ran against the live API on 15 September 2026 with `pegel` 0.0.5, except
pegel-river-overview, re-run on 26 September 2026 with 0.1.0.
The data changes, so your results will differ; the ids and keys shown work for trying the
requests yourself. Long lists are shortened.

To try them, install the CLI and the plugin — see [SKILLS.md](SKILLS.md).

Skills: [pegel-river-overview](#pegel-river-overview) · [pegel-stations-geojson](#pegel-stations-geojson) · [pegel-trend](#pegel-trend) · [pegel-water-level-check](#pegel-water-level-check)

## pegel-river-overview

> Is the Elbe running low right now? Show me the gauges along the river.

```bash
pegel --compact waters | jq -r '.[] | [.shortname, .longname] | @tsv'          # ELBE
pegel --compact stations list --waters ELBE --include-timeseries --include-current
pegel --compact stations list --waters ELBE --include-current | jq '.[0] | keys'  # has timeseries: implied
```

Since 0.1.0, `--include-current` turns `--include-timeseries` on by itself: the third command
returned the same 73 stations, each with its `timeseries[]` and current reading, as the second.
The skill still passes both flags, because pegel 0.0.8 and older drop the reading without
`--include-timeseries`. It kept stations that have no `W` series in the list and marked them, so
the table has all 73 gauges, not just the 67 that have a level.

```
ELBE: 73 gauges, 0 high, 36 low water (as of 26 Sep 2026, 21:00–21:07 local time)
  Every gauge from SCHÖNA (km 2.05) down to HOHNSTORF (km 568.987) reports low, except
  SANDAU and NEU DARCHAU, whose readings are out of date (state out-dated).
  ARTLENBURG and GEESTHACHT are normal. The 27 gauges from WEHR GEESTHACHT UP to
  CUXHAVEN STEUBENHÖFT have no mean-low/high reference (unknown).

  km       gauge                   level    state
  2.05     SCHÖNA                   79 cm   low ⬇
  55.63    DRESDEN                  63 cm   low ⬇
  154.15   TORGAU                   49 cm   low ⬇
  294.82   BARBY                    32 cm   low ⬇
  326.67   MAGDEBURG-STROMBRÜCKE    48 cm   low ⬇
  350.64   ROGÄTZ                    0 cm   low ⬇
  416.06   SANDAU                  151 cm   out-dated (24 Sep 18:30)
  453.98   WITTENBERGE              92 cm   low ⬇
  504.7    DÖMITZ                    9 cm   low ⬇
  568.987  HOHNSTORF               414 cm   low ⬇
  573.86   ARTLENBURG              412 cm   normal
  583.393  GEESTHACHT              408 cm   normal
  623.1    HAMBURG ST. PAULI       488 cm   unknown
  724      CUXHAVEN STEUBENHÖFT    366 cm   unknown
  … 59 more in the full table

  No water-level series (6): PRELOUC (km -220.1, Q only), WITTENBERGGÜTE (km 1, TR only),
    and 4 LF/WT stations between km 641.5 and 685.1.
  Older readings: SANDAU 24 Sep 18:30, NEU DARCHAU 25 Sep 06:00.
  Levels are in cm relative to each gauge's own zero, so they can't be compared between gauges.
```

Next steps offered: the trend at one gauge (e.g. DRESDEN) with **pegel-trend**.

## pegel-stations-geojson

> Make me a GeoJSON of the Danube gauges with their current water levels, for QGIS.

```bash
pegel --compact stations list --waters DONAU --include-timeseries --include-current | jq '{type:"FeatureCollection", features: [ … (.timeseries[]? | select(.shortname=="W")) as $w … ]}' > pegel-donau.geojson   # 25 features, 9 with [null, null]
pegel --compact stations list --waters DONAU --include-timeseries --include-current > donau-raw.json   # 27 stations
pegel --compact stations list --waters DONAU --include-timeseries --include-current | jq '{type:"FeatureCollection", features: [ .[] | select(.longitude != null and .latitude != null) | … ([.timeseries[]? | select(.shortname=="W")][0]) as $w … ]}' > pegel-donau.geojson
```

The first file failed the validity check. 9 stations have no coordinates, and the stock
one-liner had silently dropped the 2 stations without a `W` series. The skill looked at the raw
listing, skipped the stations without coordinates, and kept the no-`W` stations with a null
level. The rewrite replaced its own default file, so no confirmation was needed.

```
Wrote pegel-donau.geojson (8.7 KB): one FeatureCollection with 18 gauge points on the DONAU.
  Dropped 9 of 27 stations with no longitude/latitude: 8 VIA DONAU gauges
    (THEBNERSTRASSL … WILHERING) and KACHLET WEHR UP.
  Properties: shortname, longname, km, agency, water, level (cm), unit, state, measuredAt
  state:  low 11 · normal 2 (ERLAU, SCHWABELWEIS) ·
          unknown 3 (ACHLEITEN, KELHEIM DONAU, INGOLSTADT LUITPOLDSTRASSE) ·
          no W series 2 (PASSAU LUITPOLDBRÜCKE DFH, PASSAU STEINBACHBRÜCKE DFH, level null)
  Checks: parses as one FeatureCollection; coordinates are numeric [lon, lat],
          lon 11.426–13.587, lat 48.567–49.024.
```

Next steps offered: colour the points by `state` in QGIS, or open the file at https://geojson.io.

## pegel-trend

> The Elbe at Dresden is low. Is it still falling? Show me the last week.

```bash
pegel --compact stations list --fuzzy-id dresden                 # DRESDEN, ELBE km 55.63
pegel --compact measurements DRESDEN W --start P7D
pegel --compact measurements DRESDEN W --start P1D
```

Over the full week the level barely changed, but there was a rise and fall in between. The
skill added a 24-hour window to answer "still falling?" for right now.

```
DRESDEN (ELBE), water level W: last 7 days
  now 56 cm, was 55 cm  →  steady, +1 cm over 7 days
  range over window: 52–64 cm  (min 10 Sep 16:00, max last reached 13 Sep 15:30)
  A small rise to 63–64 cm on 12–13 Sep has gone: 64 → 56 cm since 13 Sep 15:30 (≈ 4 cm/day).
  Last 24 h: 57 → 56 cm, range 56–58 cm. It is barely falling now.
  window 2026-09-08T18:00+02:00 → 2026-09-15T17:45+02:00, 672 readings, 15-min spacing
```

Next steps offered: a CSV of the 7-day series for charting, or the low-water verdict via **pegel-water-level-check**.

## pegel-water-level-check

> How low is the Rhine at Kaub and Köln right now? Show me the gauge marks too.

```bash
pegel --compact stations list --fuzzy-id kaub                    # KAUB, RHEIN km 546.23
pegel --compact stations list --fuzzy-id köln                    # KÖLN, RHEIN km 688
pegel --compact current KAUB
pegel --compact current KÖLN
pegel --compact current KAUB Q
pegel --compact timeseries KAUB W                                # unit cm
pegel --compact stations get KAUB --include-timeseries --include-characteristic
pegel --compact stations get KÖLN --include-timeseries --include-characteristic
```

The user asked for the marks, so the skill also fetched each gauge's characteristic values and
listed them as published, with their codes. Both gauges publish MNW/MHW as well as GlW and the
M_I/M_II marks.

```
Rhine water levels (as of 15 Sep 2026, 17:45 local time):
  KAUB  (km 546.23)   33 cm   low ⬇  (below mean low water)    stateNswHsw: normal
        marks (cm): GlW 77 · MNW 65 · NNW 25 (2018-10-22) · MW 208 · MHW 544 · M_I 460 · M_II/HSW 640
        TuGLW (fairway depth below GlW) 190 · flow Q 577 m³/s at 17:30
  KÖLN  (km 688)      76 cm   low ⬇  (below mean low water)    stateNswHsw: normal
        marks (cm): GlW 139 · MNW 114 · NNW 69 (2018-10-23) · MW 297 · MHW 725 · M_I 620 · M_II/HSW 830
        TuGLW 250

Both gauges are below GlW (Kaub by 44 cm, Köln by 63 cm). Kaub is 8 cm and Köln 7 cm
above their NNW, the lowest low water, set in October 2018.
```

Next steps offered: the trend at KAUB over the last week with **pegel-trend**.
