# Glossar

Ein Nachschlagewerk für die Fachbegriffe und projektspezifischen Begriffe, die in
`pegel-online-cli` verwendet werden. Die Fachsprache von PEGELONLINE ist deutsch; dieses
Glossar nennt die deutschen Begriffe zusammen mit den englischen Bezeichnungen, die CLI
und API verwenden, wo es solche gibt.

> **Kurzüberblick.** PEGELONLINE veröffentlicht nahezu in Echtzeit **Wasserstände**
> (und einige weitere Messgrößen) für das Netz der Bundeswasserstraßen.
> Die Hierarchie lautet: Ein **Gewässer** trägt **Pegel** (Messstellen); jeder Pegel
> hat eine oder mehrere **Zeitreihen** (z. B. `W` Wasserstand, `Q` Abfluss); jede
> Zeitreihe hat einen **aktuellen Messwert** und einen Verlauf von **Messwerten** und
> kann **Kennwerte** (Pegelmarken) veröffentlichen. Die CLI bildet diese Hierarchie ab.

---

## Der Dienst PEGELONLINE

**PEGELONLINE.** Der offene Wasserstands-Webdienst unter
[`pegelonline.wsv.de`](https://www.pegelonline.wsv.de/webservice/dokuRestapi).
Er liefert Pegelmesswerte der Bundeswasserstraßen nahezu in Echtzeit und
historisch über eine öffentliche, schreibgeschützte REST-API. Weder API-Schlüssel
noch Authentifizierung sind nötig.

**WSV – Wasserstraßen- und Schifffahrtsverwaltung des Bundes.** Die Behörde, die
die Pegel betreibt und PEGELONLINE veröffentlicht.

**REST-API v2.** Die API-Version, auf die dieser Client ausgerichtet ist. Der Basispfad
ist `/webservices/rest-api/v2`, ausgehend von der Standard-Basis-URL
`https://www.pegelonline.wsv.de`. Jeder Endpoint liefert JSON (der Client fordert
jeweils die `.json`-Darstellung einer Ressource an).

---

## Ressourcen und Endpoints

**Pegel (`stations`).** Die Sammlung der Messstellen.
`GET /stations.json` listet und filtert sie; `GET /stations/{station}.json` ruft
einen einzelnen ab. CLI: `stations list`, `stations get`. Client: `client.stations.list()`,
`client.stations.get()`.

**Gewässer (`waters`).** Die Liste aller Gewässer, die der Dienst abdeckt.
`GET /waters.json`. CLI: `waters`. Client: `client.waters()`.

**Zeitreihe (`{timeseries}`).** Eine einzelne Messgröße an einem Pegel.
`GET /stations/{station}/{timeseries}.json` liefert ihre Metadaten. CLI:
`timeseries <station> [timeseries]`. Client: `client.timeseries.get()`.

**Aktueller Messwert (`currentmeasurement`).** Der jüngste Messwert einer
Zeitreihe. `GET /stations/{station}/{timeseries}/currentmeasurement.json`.
CLI: `current <station> [timeseries]`. Client:
`client.timeseries.currentMeasurement()`.

**Messwerte (`measurements`).** Die Messwerte einer Zeitreihe in einem Zeitfenster.
`GET /stations/{station}/{timeseries}/measurements.json`. CLI:
`measurements <station> [timeseries] [--start] [--end]`. Client:
`client.timeseries.measurements()`.

**Kennwerte (`characteristicvalues`).** Die für eine Zeitreihe veröffentlichten
Pegelmarken bzw. Kennwerte (siehe *Kennwerte* unten).
`GET /stations/{station}/{timeseries}/characteristicvalues.json`.
CLI: `characteristic <station> [timeseries]`. Client:
`client.timeseries.characteristicValues()`.

---

## Pegel und Gewässer

**Pegel.** Eine Messstelle an einer Wasserstraße. Modelliert durch den Typ
`Station`. Wichtige Felder:

- **`uuid`** – die stabile, weltweit eindeutige Kennung des Pegels.
- **`number`** – die amtliche Pegelnummer (String).
- **`shortname`** – ein Kurzname, meist in Großbuchstaben (z. B. `BONN`).
- **`longname`** – der vollständige, lesbare Name.
- **`km`** – der Flusskilometer, an dem der Pegel liegt, nach der Kilometrierung der
  jeweiligen Wasserstraße. Er wächst nicht immer flussabwärts: An der Donau (`DONAU`) zählt
  er zur Mündung hin abwärts, an Mosel, Main, Neckar und Saar zählt er von der Mündung aus
  aufwärts, und die Weser hat zwei Kilometrierungen, die jeweils nahe 0 beginnen (oberhalb
  und unterhalb von Bremen). Einige wenige Pegel haben keinen `km`.
- **`agency`** – die zuständige WSV-Behörde.
- **`longitude` / `latitude`** – WGS84-Koordinaten des Pegels. Fehlen bei manchen Pegeln
  (57 von 787 am 15.09.2026).
- **`water`** – das Gewässer, an dem der Pegel misst (ein `Water`).
- **`timeseries`** – die Zeitreihen des Pegels, nur vorhanden, wenn angefordert.

**Pegelangabe (`<station>`).** Überall, wo ein Pegel angegeben wird, kann der Wert
eine **uuid**, eine **number**, ein **shortname** *oder* ein **longname** sein. Die API
löst jede dieser Formen auf. Die CLI lehnt eine leere Angabe sowie die Pfadsegmente
`.` / `..` ab, bevor sie die Anfrage-URL baut.

**Gewässer.** Eine Wasserstraße im Netz, modelliert durch den Typ `Water` mit einem
`shortname` (z. B. `RHEIN`) und einem `longname`. Der Filter `waters` von
`stations list` vergleicht mit dem `shortname` eines Gewässers.

---

## Zeitreihen, Messwerte und Einheiten

**Zeitreihe (`TimeseriesInfo`).** Metadaten zu einer Messgröße an einem Pegel: ihr
`shortname`, `longname`, `unit`, optional `equidistance`, optional ein eingebetteter
`currentMeasurement` und optional `characteristicValues`.

**Kurzname der Zeitreihe.** Ein kurzer Code, der die Messgröße bezeichnet. Standard
in der CLI ist **`W`** (Wasserstand). Weitere Codes, die ein Pegel anbieten kann, sind
**`Q`** (Durchfluss/Abfluss), **`WT`** (Wassertemperatur) und **`LT`**
(Lufttemperatur) – was verfügbar ist, hängt vom Pegel ab. Der Code wird als optionales
Positionsargument `[timeseries]` übergeben und ist `W`, wenn er fehlt; ein leerer Wert
wird als Bedienfehler abgelehnt.

**Einheit (`unit`).** Die physikalische Einheit der Werte einer Zeitreihe, wie von der
API veröffentlicht – z. B. `cm` für den Wasserstand, `m³/s` für den Abfluss, `°C` für
Temperaturen. Der Client gibt den String der API unverändert weiter.

**Äquidistanz (`equidistance`).** Der nominelle Abstand zwischen aufeinanderfolgenden
Messwerten einer Zeitreihe in Minuten (z. B. `15` für einen Messwert pro
Viertelstunde).

**Messwert (`Measurement`).** Ein Punkt einer Messreihe: ein `timestamp` (ISO-8601)
und ein numerischer `value` in der Einheit der Zeitreihe.

**Aktueller Messwert (`CurrentMeasurement`).** Der neueste Messwert einer Zeitreihe:
ein `timestamp`, ein `value` und bis zu zwei Zustandseinstufungen
(`stateMnwMhw`, `stateNswHsw`; siehe unten). „Neuester“ heißt nicht immer aktuell: Ein
Pegel, der keine Daten mehr meldet, behält seinen letzten Messwert samt Einstufung,
manchmal stundenlang – prüfen Sie daher den `timestamp`.

---

## Zustandseinstufungen

Diese String-Felder eines aktuellen Messwerts stufen den Wert gegenüber
standardisierten Bezugsmarken ein. Der Client gibt den Wert der API unverändert weiter.

**`stateMnwMhw`.** Einstufung des aktuellen Werts gegenüber den Marken
**Mittlerer Niedrigwasserstand (MNW)** und **Mittlerer Hochwasserstand
(MHW)**.

**`stateNswHsw`.** Einstufung des aktuellen Werts gegenüber den Marken
**Niedrigster Schifffahrtswasserstand (NSW)** und
**Höchster Schifffahrtswasserstand (HSW)** – den Grenzen, innerhalb derer
Schifffahrt erlaubt ist.

**Kennwerte (Pegelmarken).** Die Menge der Bezugsmarken, die für eine Zeitreihe
veröffentlicht werden (z. B. die oben genannten Stände MNW/MHW/NSW/HSW). Geliefert vom
Befehl `characteristic` bzw. der Methode `characteristicValues()` und einbettbar über
`--include-characteristic`. Die genaue Struktur hängt vom jeweiligen Standard ab,
deshalb gibt der Client sie als unverändertes JSON-Rohobjekt (`JsonObject`) zurück
statt als geratenen Typ.

---

## Filter, Einbettungen und Zeitfenster

**`ids`.** Eine Liste von Pegelkennungen (uuid/number/shortname/longname), auf die eine
Liste eingeschränkt wird. Wird kommagetrennt an die API gesendet. CLI: wiederholbares
`--ids <id>`.

**Filter `ids` / `waters` / `fuzzyId`.** Schränken `stations list` ein: nach
Pegel-ID (`--ids`, wiederholbar), nach Gewässer-shortname (`--waters`) oder über
einen unscharfen ID-Abgleich (`--fuzzy-id`). Nach Behörde oder Gebiet filtert die
CLI nicht; filtern Sie dafür die JSON-Ausgabe (z. B. mit `jq` auf `agency`,
`latitude`, `longitude`).

**Einbettungs-Flags.** Optionale Erweiterungen, die zusätzliche Daten in eine Pegel- bzw.
Zeitreihen-Antwort einbetten; standardmäßig aus:

- **`includeTimeseries`** (`--include-timeseries`) – bettet die Zeitreihenliste jedes
  Pegels ein.
- **`includeCurrentMeasurement`** (`--include-current`) – bettet den aktuellen
  Messwert ein.
- **`includeCharacteristicValues`** (`--include-characteristic`) – bettet die
  Kennwerte (Pegelmarken) ein.

**Zeitfenster (`start` / `end`).** Die Grenzen einer `measurements`-Anfrage als
ISO-8601-Zeitpunkte. `start` kann stattdessen auch eine **ISO-8601-Periode/Dauer** sein,
etwa `P7D` („die letzten 7 Tage“) oder `P3D`. CLI: `--start`, `--end`. Ein leerer Wert
wird als Bedienfehler abgelehnt, statt still auf das Standardfenster zurückzufallen.

---

## Zuverlässigkeit und Grenzen

**Retry / Backoff.** Vorübergehende Antworten **`429`** (Too Many Requests) und **`503`**
(Service Unavailable) werden automatisch mit linearem Backoff wiederholt, bis zu
`maxRetries`-mal (Standard `2`). CLI: `--max-retries`. `PegelApiError`
stellt `isRetryable` für genau diese Status bereit.

**Weiterleitungen.** Die Engine folgt bis zu `maxRedirects` (Standard `5`)
HTTP-Weiterleitungen (301/302/303/307/308), löst `Location` relativ zur aktuellen
URL auf und entfernt beim Wechsel des Origins alle Header mit Zugangsdaten.

**Timeout (`timeoutMs`).** Zeitlimit pro Anfrage in Millisekunden; es gilt für den
gesamten Antwortkörper, nicht nur für Leerlaufpausen (Standard `30000`; `0` schaltet es
ab). CLI: `--timeout`.

**Obergrenze der Antwortgröße (`maxResponseBytes`).** Eine feste Obergrenze für die
Größe des Antwortkörpers zum Schutz vor Speichererschöpfung (Standard 100 MiB;
`0` = unbegrenzt). CLI: `--max-response-bytes`.

**User-Agent (`userAgent`).** Der Wert des Headers `User-Agent` (Standard
`pegel-online-cli`). Steuerzeichen werden vorab abgelehnt, um Header-Injection
auszuschließen. CLI: `--user-agent`.

---

## Ausgabe und Fehlerbehandlung

**JSON-Ausgabe.** Jeder Befehl gibt JSON auf stdout aus – standardmäßig formatiert,
mit `--compact` in einer einzigen Zeile.

**Exit-Codes.** `0` bei Erfolg; `2` bei Aufruf- bzw. Parse-Fehlern (unbekannter Befehl
oder unbekannte Option, fehlendes Argument, ungültiger Flag-Wert); `4` bei einem `404`
der API; `1` bei jedem anderen Fehler (Laufzeit/Netzwerk).

---

> **Bibliothek & Interna.** Begriffe zum TypeScript-Client und seinen Interna –
> `PegelOnlineClient`, die Request-Engine, Transport, Retry/Backoff, Fehlertypen,
> Query-Builder – finden Sie in **[DEVELOPING.md](DEVELOPING.md)** (englisch).
