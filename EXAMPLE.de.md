# Beispiele

Echte Beispiele für die Claude-Code-Skills des Plugins `pegel`, eines pro Skill: eine
Anfrage, die `pegel`-Befehle, die der Skill ausgeführt hat, und Claudes Antwort.

Jedes Beispiel lief am 15. September 2026 mit `pegel` 0.0.5 gegen die Live-API, außer
pegel-river-overview, das am 26. September 2026 mit 0.1.0 neu lief.
Die Daten ändern sich, Ihre Ergebnisse werden also abweichen; mit den gezeigten IDs und
Schlüsseln können Sie die Anfragen selbst ausprobieren. Lange Listen sind gekürzt.

Zum Ausprobieren installieren Sie die CLI und das Plugin – siehe [SKILLS.md](SKILLS.md) (englisch).

Skills: [pegel-river-overview](#pegel-river-overview) · [pegel-stations-geojson](#pegel-stations-geojson) · [pegel-trend](#pegel-trend) · [pegel-water-level-check](#pegel-water-level-check)

## pegel-river-overview

> Führt die Elbe gerade Niedrigwasser? Bitte alle Pegel entlang des Flusses zeigen.

```bash
pegel --compact waters | jq -r '.[] | [.shortname, .longname] | @tsv'          # ELBE
pegel --compact stations list --waters ELBE --include-timeseries --include-current
pegel --compact stations list --waters ELBE --include-current | jq '.[0] | keys'  # mit timeseries: impliziert
```

Seit 0.1.0 schaltet `--include-current` `--include-timeseries` selbst ein: Der dritte Befehl
lieferte dieselben 73 Stationen, jede mit ihrem `timeseries[]` und dem aktuellen Messwert, wie der
zweite. Der Skill setzt trotzdem beide Flags, weil pegel 0.0.8 und älter den Messwert ohne
`--include-timeseries` verwerfen. Stationen ohne `W`-Reihe blieben in der Liste und sind markiert –
die Tabelle umfasst also alle 73 Pegel, nicht nur die 67 mit Wasserstand.

```
ELBE: 73 Pegel, 0 Hochwasser, 36 Niedrigwasser (Stand 26.09.2026, 21:00–21:07 Ortszeit)
  Alle Pegel von SCHÖNA (km 2,05) bis hinunter nach HOHNSTORF (km 568,987) melden low, außer
  SANDAU und NEU DARCHAU, deren Messwerte veraltet sind (Zustand out-dated).
  ARTLENBURG und GEESTHACHT sind normal. Die 27 Pegel von WEHR GEESTHACHT UP bis
  CUXHAVEN STEUBENHÖFT haben keinen Bezug auf mittleres Niedrig-/Hochwasser (unknown).

  km       Pegel                   Stand    Zustand
  2,05     SCHÖNA                   79 cm   low ⬇
  55,63    DRESDEN                  63 cm   low ⬇
  154,15   TORGAU                   49 cm   low ⬇
  294,82   BARBY                    32 cm   low ⬇
  326,67   MAGDEBURG-STROMBRÜCKE    48 cm   low ⬇
  350,64   ROGÄTZ                    0 cm   low ⬇
  416,06   SANDAU                  151 cm   out-dated (24.09. 18:30)
  453,98   WITTENBERGE              92 cm   low ⬇
  504,7    DÖMITZ                    9 cm   low ⬇
  568,987  HOHNSTORF               414 cm   low ⬇
  573,86   ARTLENBURG              412 cm   normal
  583,393  GEESTHACHT              408 cm   normal
  623,1    HAMBURG ST. PAULI       488 cm   unknown
  724      CUXHAVEN STEUBENHÖFT    366 cm   unknown
  … 59 weitere in der vollständigen Tabelle

  Ohne Wasserstandsreihe (6): PRELOUC (km -220,1, nur Q), WITTENBERGGÜTE (km 1, nur TR)
    und 4 LF/WT-Stationen zwischen km 641,5 und 685,1.
  Ältere Messwerte: SANDAU 24.09. 18:30, NEU DARCHAU 25.09. 06:00.
  Die Stände sind in cm über dem jeweiligen Pegelnullpunkt und lassen sich nicht zwischen Pegeln vergleichen.
```

Als Nächstes angeboten: der Verlauf an einem Pegel (z. B. DRESDEN) mit **pegel-trend**.

## pegel-stations-geojson

> Ein GeoJSON der Donau-Pegel mit ihren aktuellen Wasserständen erstellen, für QGIS.

```bash
pegel --compact stations list --waters DONAU --include-timeseries --include-current | jq '{type:"FeatureCollection", features: [ … (.timeseries[]? | select(.shortname=="W")) as $w … ]}' > pegel-donau.geojson   # 25 Features, 9 mit [null, null]
pegel --compact stations list --waters DONAU --include-timeseries --include-current > donau-raw.json   # 27 Stationen
pegel --compact stations list --waters DONAU --include-timeseries --include-current | jq '{type:"FeatureCollection", features: [ .[] | select(.longitude != null and .latitude != null) | … ([.timeseries[]? | select(.shortname=="W")][0]) as $w … ]}' > pegel-donau.geojson
```

Die erste Datei fiel bei der Gültigkeitsprüfung durch: 9 Stationen haben keine Koordinaten, und
der mitgelieferte Einzeiler hatte die 2 Stationen ohne `W`-Reihe stillschweigend weggelassen. Der
Skill hat die Rohliste geprüft, Stationen ohne Koordinaten übersprungen und die ohne `W` mit
leerem Wasserstand behalten. Überschrieben wurde nur die eigene Standarddatei, eine Rückfrage war
nicht nötig.

```
pegel-donau.geojson geschrieben (8,7 KB): eine FeatureCollection mit 18 Pegelpunkten an der DONAU.
  9 von 27 Stationen ohne longitude/latitude ausgelassen: 8 Pegel von VIA DONAU
    (THEBNERSTRASSL … WILHERING) und KACHLET WEHR UP.
  Eigenschaften: shortname, longname, km, agency, water, level (cm), unit, state, measuredAt
  state:  low 11 · normal 2 (ERLAU, SCHWABELWEIS) ·
          unknown 3 (ACHLEITEN, KELHEIM DONAU, INGOLSTADT LUITPOLDSTRASSE) ·
          ohne W-Reihe 2 (PASSAU LUITPOLDBRÜCKE DFH, PASSAU STEINBACHBRÜCKE DFH, level null)
  Prüfung: eine gültige FeatureCollection; Koordinaten numerisch als [lon, lat],
           Länge 11,426–13,587, Breite 48,567–49,024.
```

Als Nächstes angeboten: die Punkte in QGIS nach `state` einfärben oder die Datei auf https://geojson.io öffnen.

## pegel-trend

> Die Elbe in Dresden führt Niedrigwasser. Fällt der Pegel noch? Bitte die letzte Woche zeigen.

```bash
pegel --compact stations list --fuzzy-id dresden                 # DRESDEN, ELBE km 55,63
pegel --compact measurements DRESDEN W --start P7D
pegel --compact measurements DRESDEN W --start P1D
```

Über die ganze Woche hat sich der Stand kaum verändert, dazwischen ist er aber gestiegen und
wieder gefallen. Für die Frage, ob er jetzt noch fällt, hat der Skill zusätzlich die letzten
24 Stunden abgerufen.

```
DRESDEN (ELBE), Wasserstand W: letzte 7 Tage
  jetzt 56 cm, zu Beginn 55 cm  →  gleichbleibend, +1 cm in 7 Tagen
  Spanne im Zeitraum: 52–64 cm  (Minimum 10.09. 16:00, Maximum zuletzt 13.09. 15:30)
  Ein kleiner Anstieg auf 63–64 cm am 12. und 13.09. ist wieder abgeflossen: 64 → 56 cm seit 13.09. 15:30 (≈ 4 cm/Tag).
  Letzte 24 h: 57 → 56 cm, Spanne 56–58 cm. Der Pegel fällt derzeit kaum noch.
  Zeitraum 2026-09-08T18:00+02:00 → 2026-09-15T17:45+02:00, 672 Messwerte im 15-Minuten-Takt
```

Als Nächstes angeboten: eine CSV der 7-Tage-Reihe für ein Diagramm oder die Niedrigwasser-Einstufung mit **pegel-water-level-check**.

## pegel-water-level-check

> Wie niedrig ist der Rhein gerade in Kaub und Köln? Bitte auch die Pegelmarken zeigen.

```bash
pegel --compact stations list --fuzzy-id kaub                    # KAUB, RHEIN km 546,23
pegel --compact stations list --fuzzy-id köln                    # KÖLN, RHEIN km 688
pegel --compact current KAUB
pegel --compact current KÖLN
pegel --compact current KAUB Q
pegel --compact timeseries KAUB W                                # Einheit cm
pegel --compact stations get KAUB --include-timeseries --include-characteristic
pegel --compact stations get KÖLN --include-timeseries --include-characteristic
```

Weil nach den Marken gefragt war, hat der Skill auch die Kennwerte jedes Pegels abgerufen und sie
wie veröffentlicht mit ihren Kürzeln aufgeführt. Beide Pegel veröffentlichen MNW/MHW sowie GlW
und die Marken M_I/M_II.

```
Wasserstände am Rhein (Stand 15.09.2026, 17:45 Ortszeit):
  KAUB  (km 546,23)   33 cm   low ⬇  (unter mittlerem Niedrigwasser)    stateNswHsw: normal
        Marken (cm): GlW 77 · MNW 65 · NNW 25 (2018-10-22) · MW 208 · MHW 544 · M_I 460 · M_II/HSW 640
        TuGLW (Fahrrinnentiefe unter GlW) 190 · Abfluss Q 577 m³/s um 17:30
  KÖLN  (km 688)      76 cm   low ⬇  (unter mittlerem Niedrigwasser)    stateNswHsw: normal
        Marken (cm): GlW 139 · MNW 114 · NNW 69 (2018-10-23) · MW 297 · MHW 725 · M_I 620 · M_II/HSW 830
        TuGLW 250

Beide Pegel liegen unter GlW (Kaub um 44 cm, Köln um 63 cm). Kaub liegt 8 cm und Köln 7 cm
über dem NNW, dem niedrigsten Niedrigwasserstand vom Oktober 2018.
```

Als Nächstes angeboten: der Verlauf in KAUB über die letzte Woche mit **pegel-trend**.
