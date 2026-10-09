# Examples

Real examples for the Claude Code skills of the `pegel` plugin, one per skill: a request,
the `pegel` commands the skill ran, and the answer Claude gave.

Every example ran against the live API on 6 October 2026: pegel-river-overview and
pegel-stations-geojson with `pegel` 0.3.0, pegel-trend and pegel-water-level-check with 0.4.0.
The data changes, so your results will differ; the ids and keys shown work for trying the
requests yourself. Long lists are shortened.

To try them, install the CLI and the plugin — see [SKILLS.md](SKILLS.md).

Skills: [pegel-river-overview](#pegel-river-overview) · [pegel-stations-geojson](#pegel-stations-geojson) · [pegel-trend](#pegel-trend) · [pegel-water-level-check](#pegel-water-level-check)

## pegel-river-overview

> Is anything on the Rhine flooding or running low right now? Show me all the gauges.

```bash
pegel --compact waters | jq -r '.[] | [.shortname, .longname] | @tsv'          # RHEIN
pegel --compact stations list --waters RHEIN --include-timeseries --include-current > rhein.json
jq -r --argjson dir 1 'sort_by(.km == null, (.km // 0) * $dir)[] | … | @tsv' rhein.json   # km, gauge, level, unit, state, time, comment
jq -r 'def epoch: …; .[] | … | select($c != null and (now - ($c.timestamp | epoch)) > 7200) | …' rhein.json   # stale: none
```

The skill fetched the river once and ran both of its recipes on the saved answer. The Rhine's
km grow downstream, so the table reads source to mouth. Every `W` series gave its unit as `cm`,
and no reading was stale, `null` (no value) or flagged as a gauge fault (`commented`).

```
RHEIN — 36 gauges, 0 high, 24 low water (as of 6 Oct 2026, 00:45–01:00 local time; none stale)
  Every gauge with a mean-low reference from IFFEZHEIM (km 336.2) down to EMMERICH (km 851.9)
  reports low. RHEINWEILER and KEHL-KRONENHOF on the Upper Rhine are normal. 10 gauges have
  no mean-low/high reference (unknown), among them KONSTANZ-RHEIN, Basel-Rheinhalle, LOBITH
  and PANNERDENSE KOP.

  km       gauge               level    state
  0.5      KONSTANZ-RHEIN      228 cm   unknown
  186.2    RHEINWEILER         200 cm   normal
  292.2    KEHL-KRONENHOF      182 cm   normal
  336.2    IFFEZHEIM            46 cm   low ⬇
  443.37   WORMS               -25 cm   low ⬇
  546.23   KAUB                  4 cm   low ⬇
  591.49   KOBLENZ               0 cm   low ⬇
  654.8    BONN                 67 cm   low ⬇
  688      KÖLN                 51 cm   low ⬇
  744.2    DÜSSELDORF            2 cm   low ⬇
  851.9    EMMERICH            -19 cm   low ⬇
  867.3    PANNERDENSE KOP     584 cm   unknown
  … 24 more in the full table

  Levels are in cm relative to each gauge's own zero, so they can't be compared between gauges.
```

Next steps offered: the trend at one gauge (e.g. KAUB) with **pegel-trend**.

## pegel-stations-geojson

> Make me a GeoJSON of the Mittellandkanal gauges with their current water levels, for QGIS.

```bash
pegel --compact waters | jq -r '.[] | select(.longname | test("MITTELLAND")) | [.shortname, .longname] | @tsv'   # MLK
pegel --compact stations list --waters MLK --include-timeseries --include-current > mlk-raw.json   # 31 stations
jq '{type:"FeatureCollection", features: [ .[] | select(.longitude != null and .latitude != null) | … ([.timeseries[]? | select(.shortname=="W")][0]) as $w … ]}' mlk-raw.json > pegel-mlk.geojson
jq -r '.[] | select(.longitude == null or .latitude == null) | .shortname' mlk-raw.json   # none
```

The skill read each point's `unit` from its series instead of assuming cm, and that mattered
here: most canal gauges give the water surface in metres above sea level (`m+NN`), three give
centimetres. It kept the 4 stations without a `W` series with a null level. `pegel-mlk.geojson`
didn't exist yet, so no confirmation was needed.

```
Wrote pegel-mlk.geojson (14.8 KB): one FeatureCollection with 31 gauge points on the MITTELLANDKANAL.
  No station lacked coordinates.
  Properties: shortname, longname, km, agency, water, level, unit, state, comment, measuredAt
  Units differ: 24 gauges report the canal surface in m+NN (metres above sea level), 50.29–65.15;
    VELSDORF 5603 and KANALBRÜCKE 5611 are in cm (apparently the same surface, about 56 m above
    sea level, in centimetres), WARBER GRABEN -2 cm. Don't color or size points by level across
    units: filter unit == "m+NN" first, or color by state.
  state:  unknown 27 (no mean-low/high reference on the canal) ·
          no W series 4 (MINDEN, WESER, ANDERTEN, SÜLFELD; level null)
  No gauge reported a fault (no comment).
  Checks: parses as one FeatureCollection; coordinates are numeric [lon, lat],
          lon 7.605–11.689, lat 52.230–52.479.
```

Next steps offered: open the file at https://geojson.io, or a map of just the `m+NN` levels.

## pegel-trend

> Is the Rhine at Pannerdense Kop rising or falling? Show me the last week.

```bash
pegel --compact stations list --fuzzy-id pannerdense             # PANNERDENSE KOP, RHEIN km 867.3
pegel --compact timeseries "PANNERDENSE KOP" W | jq '{unit, comment}'   # cm, no comment
pegel --compact measurements "PANNERDENSE KOP" W --start P7D | jq 'def epoch: …; (map(select(.value != null))) as $p | …'
```

PANNERDENSE KOP names a single station, so the CLI's check of the name (one extra lookup
before each per-station request) let both calls through. The 7-day window held 125 points, all
with a value, but only from 5 Oct 17:00: the gauge sent nothing for the rest of the week. The
skill checked the age of the last reading and reported the window it actually got instead of a
week-long trend.

```
PANNERDENSE KOP (RHEIN km 867.3, Rijkswaterstaat), water level W in cm
  582 cm at 6 Oct 13:40 (8 min old); 584 cm at 5 Oct 17:00
  →  −2 cm over 20 h 40 min: steady
  range 582–587 cm (max 5 Oct 17:20, min 6 Oct 12:20); 125 readings at 10-min spacing
  The requested week came back as its last 21 hours: no readings before 5 Oct 17:00,
  so a week-long trend can't be read from these data.
```

Next steps offered: a CSV of the readings for charting, or the water-level verdict via
**pegel-water-level-check**.

## pegel-water-level-check

> How high is the water right now at Rinteln, at Münster OW on the Dortmund-Ems-Kanal, and in
> Neustadt in Holstein?

```bash
pegel --compact stations list --fuzzy-id rinteln                 # RINTELN, WESER km 163.2
pegel --compact stations list --fuzzy-id münster                 # MÜNSTER OW and MÜNSTER UW, DEK
pegel --compact stations list --fuzzy-id neustadt                # stderr: INFO  [pegel.api] "NEUSTADT" names 2 stations …
pegel --compact stations get RINTELN --include-current | jq '.timeseries[] | select(.shortname == "W") | {unit, comment, currentMeasurement}'
pegel --compact stations get "MÜNSTER OW" --include-current | jq '…'   # unit m+NN
pegel --compact stations get 9610080 --include-current | jq '…'        # NEUSTADT on the OSTSEE
```

The search for "neustadt" found two stations named NEUSTADT, on the LEINE (48800200) and on the
OSTSEE (9610080), next to NEUSTADT GLEWE OP; the CLI's note on stderr said a lookup by that name is
refused. Neustadt in Holstein is on the Baltic coast, so the skill used the OSTSEE gauge's number.
One call per gauge gave the reading together with its series' unit and comment: MÜNSTER OW's level
is in m+NN, not cm, and RINTELN was flagged `commented`, a gauge fault, with the reason in its
comment.

```
Water levels, 6 Oct 2026 around 13:45 local time:
  RINTELN     (WESER, km 163.2)               gauge fault ⚠  "Funktionsstörung, fehlerhafte Messwerte"
                                              (malfunction, faulty readings): reported 89 cm,
                                              unreliable, no verdict                     13:45
  NEUSTADT    (OSTSEE, Neustadt in Holstein)  511 cm      normal                         13:45
  MÜNSTER OW  (Dortmund-Ems-Kanal, km 70.3)   56.52 m+NN  no flood reference (unknown)   13:30
              the canal surface 56.52 m above sea level: a height, not a depth in cm

"Neustadt" names two gauges: NEUSTADT on the LEINE (48800200) and NEUSTADT on the OSTSEE
(9610080, used here).
```

Next steps offered: the trend at NEUSTADT (number 9610080) over the last week with **pegel-trend**.
