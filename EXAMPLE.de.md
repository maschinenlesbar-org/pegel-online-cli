# Beispiele

Echte Beispiele für die Claude-Code-Skills des Plugins `pegel`, eines pro Skill: eine
Anfrage, die `pegel`-Befehle, die der Skill ausgeführt hat, und Claudes Antwort.

Jedes Beispiel lief am 6. Oktober 2026 gegen die Live-API: pegel-river-overview und
pegel-stations-geojson mit `pegel` 0.3.0, pegel-trend und pegel-water-level-check mit 0.4.0.
Die Daten ändern sich, Ihre Ergebnisse werden also abweichen; mit den gezeigten IDs und
Schlüsseln können Sie die Anfragen selbst ausprobieren. Lange Listen sind gekürzt.

Zum Ausprobieren installieren Sie die CLI und das Plugin – siehe [SKILLS.md](SKILLS.md) (englisch).

Skills: [pegel-river-overview](#pegel-river-overview) · [pegel-stations-geojson](#pegel-stations-geojson) · [pegel-trend](#pegel-trend) · [pegel-water-level-check](#pegel-water-level-check)

## pegel-river-overview

> Gibt es am Rhein gerade Hoch- oder Niedrigwasser? Bitte alle Pegel zeigen.

```bash
pegel --compact waters | jq -r '.[] | [.shortname, .longname] | @tsv'          # RHEIN
pegel --compact stations list --waters RHEIN --include-timeseries --include-current > rhein.json
jq -r --argjson dir 1 'sort_by(.km == null, (.km // 0) * $dir)[] | … | @tsv' rhein.json   # km, Pegel, Stand, Einheit, Zustand, Zeit, Kommentar
jq -r 'def epoch: …; .[] | … | select($c != null and (now - ($c.timestamp | epoch)) > 7200) | …' rhein.json   # veraltet: keiner
```

Der Skill hat den Fluss einmal abgerufen und beide Rezepte auf die gespeicherte Antwort
angewendet. Die Rhein-Kilometer wachsen flussabwärts, die Tabelle läuft also von der Quelle zur
Mündung. Jede `W`-Reihe gab ihre Einheit als `cm` an, und kein Messwert war veraltet, `null`
(kein Wert) oder als Störung (`commented`) markiert.

```
RHEIN – 36 Pegel, 0 Hochwasser, 24 Niedrigwasser (Stand 06.10.2026, 00:45–01:00 Ortszeit; keiner veraltet)
  Jeder Pegel mit Bezug auf mittleres Niedrigwasser von IFFEZHEIM (km 336,2) bis hinunter nach
  EMMERICH (km 851,9) meldet low. RHEINWEILER und KEHL-KRONENHOF am Oberrhein sind normal.
  10 Pegel haben keinen Bezug auf mittleres Niedrig-/Hochwasser (unknown), darunter
  KONSTANZ-RHEIN, Basel-Rheinhalle, LOBITH und PANNERDENSE KOP.

  km       Pegel               Stand    Zustand
  0,5      KONSTANZ-RHEIN      228 cm   unknown
  186,2    RHEINWEILER         200 cm   normal
  292,2    KEHL-KRONENHOF      182 cm   normal
  336,2    IFFEZHEIM            46 cm   low ⬇
  443,37   WORMS               -25 cm   low ⬇
  546,23   KAUB                  4 cm   low ⬇
  591,49   KOBLENZ               0 cm   low ⬇
  654,8    BONN                 67 cm   low ⬇
  688      KÖLN                 51 cm   low ⬇
  744,2    DÜSSELDORF            2 cm   low ⬇
  851,9    EMMERICH            -19 cm   low ⬇
  867,3    PANNERDENSE KOP     584 cm   unknown
  … 24 weitere in der vollständigen Tabelle

  Die Stände sind in cm über dem jeweiligen Pegelnullpunkt und lassen sich nicht zwischen Pegeln vergleichen.
```

Als Nächstes angeboten: der Verlauf an einem Pegel (z. B. KAUB) mit **pegel-trend**.

## pegel-stations-geojson

> Ein GeoJSON der Pegel am Mittellandkanal mit ihren aktuellen Wasserständen erstellen, für QGIS.

```bash
pegel --compact waters | jq -r '.[] | select(.longname | test("MITTELLAND")) | [.shortname, .longname] | @tsv'   # MLK
pegel --compact stations list --waters MLK --include-timeseries --include-current > mlk-raw.json   # 31 Stationen
jq '{type:"FeatureCollection", features: [ .[] | select(.longitude != null and .latitude != null) | … ([.timeseries[]? | select(.shortname=="W")][0]) as $w … ]}' mlk-raw.json > pegel-mlk.geojson
jq -r '.[] | select(.longitude == null or .latitude == null) | .shortname' mlk-raw.json   # keine
```

Der Skill hat die Einheit jedes Punkts aus seiner Zeitreihe gelesen, statt cm anzunehmen, und das
war hier wichtig: Die meisten Kanalpegel melden die Wasseroberfläche in Metern über Normalnull
(`m+NN`), drei in Zentimetern. Die 4 Stationen ohne `W`-Reihe blieben mit leerem Wasserstand
erhalten. `pegel-mlk.geojson` gab es noch nicht, eine Rückfrage war nicht nötig.

```
pegel-mlk.geojson geschrieben (14,8 KB): eine FeatureCollection mit 31 Pegelpunkten am MITTELLANDKANAL.
  Keiner Station fehlten Koordinaten.
  Eigenschaften: shortname, longname, km, agency, water, level, unit, state, comment, measuredAt
  Die Einheiten unterscheiden sich: 24 Pegel melden die Kanaloberfläche in m+NN (Meter über
    Normalnull), 50,29–65,15; VELSDORF 5603 und KANALBRÜCKE 5611 sind in cm (offenbar dieselbe
    Oberfläche, rund 56 m über Normalnull, in Zentimetern), WARBER GRABEN -2 cm. Punkte nicht über
    Einheiten hinweg nach level einfärben oder skalieren: erst nach unit == "m+NN" filtern oder
    nach state einfärben.
  state:  unknown 27 (am Kanal kein Bezug auf mittleres Niedrig-/Hochwasser) ·
          ohne W-Reihe 4 (MINDEN, WESER, ANDERTEN, SÜLFELD; level null)
  Kein Pegel meldete eine Störung (kein comment).
  Prüfung: eine gültige FeatureCollection; Koordinaten numerisch als [lon, lat],
           Länge 7,605–11,689, Breite 52,230–52,479.
```

Als Nächstes angeboten: die Datei auf https://geojson.io öffnen oder eine Karte nur der `m+NN`-Stände.

## pegel-trend

> Steigt oder fällt der Rhein an der Pannerdense Kop? Bitte die letzte Woche zeigen.

```bash
pegel --compact stations list --fuzzy-id pannerdense             # PANNERDENSE KOP, RHEIN km 867,3
pegel --compact timeseries "PANNERDENSE KOP" W | jq '{unit, comment}'   # cm, kein comment
pegel --compact measurements "PANNERDENSE KOP" W --start P7D | jq 'def epoch: …; (map(select(.value != null))) as $p | …'
```

PANNERDENSE KOP bezeichnet genau einen Pegel, also ließ die Namensprüfung der CLI (eine zusätzliche
Abfrage vor jeder pegelbezogenen Anfrage) beide Aufrufe durch. Das 7-Tage-Fenster enthielt 125
Punkte, alle mit Wert, aber erst ab 05.10. 17:00: Für den Rest der Woche kam vom Pegel nichts. Der
Skill hat das Alter des letzten Messwerts geprüft und das Fenster beschrieben, das tatsächlich
zurückkam, statt eines Wochentrends.

```
PANNERDENSE KOP (RHEIN km 867,3, Rijkswaterstaat), Wasserstand W in cm
  582 cm am 06.10. um 13:40 (8 min alt); 584 cm am 05.10. um 17:00
  →  −2 cm in 20 h 40 min: gleichbleibend
  Spanne 582–587 cm (Maximum 05.10. 17:20, Minimum 06.10. 12:20); 125 Messwerte im 10-Minuten-Takt
  Von der angefragten Woche kamen nur die letzten 21 Stunden: keine Messwerte vor 05.10. 17:00,
  ein Wochentrend lässt sich aus diesen Daten nicht ablesen.
```

Als Nächstes angeboten: eine CSV der Messwerte für ein Diagramm oder die Einstufung des
Wasserstands mit **pegel-water-level-check**.

## pegel-water-level-check

> Wie hoch ist das Wasser gerade in Rinteln, an Münster OW am Dortmund-Ems-Kanal und in
> Neustadt in Holstein?

```bash
pegel --compact stations list --fuzzy-id rinteln                 # RINTELN, WESER km 163,2
pegel --compact stations list --fuzzy-id münster                 # MÜNSTER OW und MÜNSTER UW, DEK
pegel --compact stations list --fuzzy-id neustadt                # stderr: Note: "NEUSTADT" names 2 stations …
pegel --compact stations get RINTELN --include-current | jq '.timeseries[] | select(.shortname == "W") | {unit, comment, currentMeasurement}'
pegel --compact stations get "MÜNSTER OW" --include-current | jq '…'   # Einheit m+NN
pegel --compact stations get 9610080 --include-current | jq '…'        # NEUSTADT an der OSTSEE
```

Die Suche nach „neustadt“ fand zwei Stationen namens NEUSTADT, an der LEINE (48800200) und an der
OSTSEE (9610080), neben NEUSTADT GLEWE OP; der Hinweis der CLI auf stderr besagte, dass eine
Abfrage über diesen Namen abgelehnt wird. Neustadt in Holstein liegt an der Ostsee, also nahm der
Skill die Nummer des OSTSEE-Pegels. Ein Aufruf je Pegel lieferte den Messwert zusammen mit Einheit
und Kommentar seiner Zeitreihe: Der Stand von MÜNSTER OW ist in m+NN, nicht in cm, und RINTELN war
als `commented` markiert, also gestört, mit dem Grund im Kommentar.

```
Wasserstände am 06.10.2026 gegen 13:45 Ortszeit:
  RINTELN     (WESER, km 163,2)               Störung ⚠  „Funktionsstörung, fehlerhafte Messwerte“:
                                              gemeldet 89 cm, unzuverlässig, keine Einstufung   13:45
  NEUSTADT    (OSTSEE, Neustadt in Holstein)  511 cm      normal                          13:45
  MÜNSTER OW  (Dortmund-Ems-Kanal, km 70,3)   56,52 m+NN  kein Hochwasserbezug (unknown)  13:30
              die Kanaloberfläche 56,52 m über Normalnull: eine Höhe, keine Tiefe in cm

„Neustadt“ bezeichnet zwei Pegel: NEUSTADT an der LEINE (48800200) und NEUSTADT an der OSTSEE
(9610080, hier verwendet).
```

Als Nächstes angeboten: der Verlauf in NEUSTADT (Nummer 9610080) über die letzte Woche mit **pegel-trend**.
