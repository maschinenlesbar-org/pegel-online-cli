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

**Kennwerte (`characteristicValues`).** Die für eine Zeitreihe veröffentlichten
Pegelmarken bzw. Kennwerte (siehe *Kennwerte* unten). Einen eigenen Befehl bzw. eine
eigene Methode gibt es dafür nicht: Sie sind eine Einbettung der Pegel-Anfrage,
`GET /stations/{station}.json?includeTimeseries=true&includeCharacteristicValues=true`,
und stehen in jedem Eintrag von `timeseries[]`. CLI:
`stations get <station> --include-characteristic` (schaltet `--include-timeseries` mit ein).
Client: `client.stations.get(station, { includeCharacteristicValues: true })`.

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
löst jede dieser Formen auf. **Namen sind nicht eindeutig:** `NEUSTADT` ist der
shortname eines Pegels an der LEINE (number 48800200) und eines an der OSTSEE (9610080),
und die API beantwortet eine Abfrage über den Namen mit einem der beiden. Deshalb schlagen
`stations get`, `timeseries`, `current` und `measurements` einen Namen zuerst nach (eine
zusätzliche Anfrage, keine bei number oder uuid; Bibliothek: `stations.assertUnique`) und
lehnen einen Namen ab, der mehrere Pegel bezeichnet – Exit `2`,
`PegelAmbiguousStationError`, mit number und uuid jedes dieser Pegel.
`stations list --ids NEUSTADT` oder `--fuzzy-id` listet beide und gibt einen Hinweis
aus; nehmen Sie die **number** oder **uuid** des gemeinten Pegels. Die CLI lehnt eine
leere Angabe sowie die Pfadsegmente
`.` / `..` für `<station>` und `[timeseries]` ab, bevor sie die Anfrage-URL baut (die
URL-Auflösung würde sie sonst auflösen und eine andere Ressource abfragen); die
Client-Bibliothek lehnt sie ebenfalls ab, mit einem `PegelValidationError` vor jeder
Anfrage. Pegel- und Zeitreihennamen, `--ids`, `--waters` und `--fuzzy-id` werden ohne
umgebende Leerzeichen und in zusammengesetzter Unicode-Form (NFC) gesendet, sodass ein
mitkopiertes Leerzeichen oder ein zerlegter Umlaut (`KÖLN` als `KO` + U+0308 + `LN`,
häufig in Text aus macOS-Dateinamen oder PDFs) denselben Pegel findet.

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
(Lufttemperatur) – was verfügbar ist, hängt vom Pegel ab – sowie die Vorhersage-Zeitreihe
**`WV`** (siehe *Vorhersage-Zeitreihe* unten). Der Code wird als optionales
Positionsargument `[timeseries]` übergeben und ist `W`, wenn er fehlt; ein leerer Wert
wird als Bedienfehler abgelehnt.

**Einheit (`unit`).** Die physikalische Einheit der Werte einer Zeitreihe, wie von der
API veröffentlicht – z. B. `cm` für den Wasserstand, `m³/s` für den Abfluss, `°C` für
Temperaturen. Der Client gibt den String der API unverändert weiter. Die Einheit gehört
zur Zeitreihe, nicht zum Code: **Nicht jedes `W` ist in cm.** Am 5. Oktober 2026 waren
668 von 737 `W`-Zeitreihen in `cm`, aber 67 Kanalpegel (Mittellandkanal, Wesel-Datteln-,
Rhein-Herne-, Elbe-Seiten-, Dortmund-Ems-, Datteln-Hamm-Kanal, Ruhr) meldeten `m+NN` –
Meter über Normalnull, MÜNSTER OW also 56,54 – und zwei Talsperren (EDERTALSPERRE,
DIEMELTALSPERRE) `m+PNP`, Meter über Pegelnullpunkt. Ein aktueller Messwert trägt keine
Einheit; lesen Sie sie jedes Mal an der Zeitreihe ab (`pegel timeseries <station>
<series>` oder `.timeseries[].unit` mit `--include-timeseries`).

**Äquidistanz (`equidistance`).** Der nominelle Abstand zwischen aufeinanderfolgenden
Messwerten einer Zeitreihe in Minuten (z. B. `15` für einen Messwert pro
Viertelstunde).

**Messwert (`Measurement`).** Ein Punkt einer Messreihe: ein `timestamp` (ISO-8601)
und ein numerischer `value` in der Einheit der Zeitreihe – oder `null` für einen Punkt
ohne Messwert (siehe *Kein Wert* unten). Punkte einer Vorhersage-Zeitreihe tragen
zusätzlich `initialized` und `type`.

**Vorhersage-Zeitreihe (`WV`, Wasserstandsvorhersage).** Eine **Vorhersage** des
Wasserstands, kein Messwert: Die Bundesanstalt für Gewässerkunde (BfG) sagt den Stand
einiger Pegel voraus – am 6. Oktober 2026 sieben am Rhein (OESTRICH, KAUB, KOBLENZ,
KÖLN, DÜSSELDORF, DUISBURG-RUHRORT, EMMERICH) – etwa vier Tage im Voraus in
Zwei-Stunden-Schritten (`equidistance` `120`). Die Werte stehen in der `unit` der
Zeitreihe (dort `cm`, wie beim `W` des Pegels). Die API führt `WV` in der Zeitreihenliste
eines Pegels nur mit `includeForecastTimeseries` (`--include-forecast`, schaltet
`--include-timeseries` mit ein); `start`/`end` der Zeitreihe nennen das
Vorhersagefenster, ihr `comment` Lauf und Quelle („Vorhersagen und Abschätzungen vom:
06.10.2026 um 07:00 Uhr, Quelle: Bundesanstalt für Gewässerkunde“). Die Werte liefert
`pegel measurements <station> WV`; jeder Punkt trägt `initialized` (wann der Lauf
erstellt wurde) und `type`: **`forecast`** (Vorhersage) für die näheren Punkte, danach
**`estimate`** (Abschätzung, ein gröberer Ausblick) für die späteren. `pegel current
<station> WV` ist ein 404 – eine Vorhersage hat keinen aktuellen Messwert.

**Kein Wert (`99999` → `null`).** Manche Pegel melden statt eines Messwerts den
Platzhalter `99999` – so der Rhein-Pegel PANNERDENSE KOP (Rijkswaterstaat) am
5. Oktober 2026, abwechselnd mit echten Werten von 576–597 cm. Als Zahl gelesen wäre
das ein Wasserstand von 1 km. Client und CLI machen daraus überall, wo ein Messwert
steht, `null` (`current`, `measurements` und der mit `--include-current` eingebettete
aktuelle Messwert; Konstante `NO_VALUE_SENTINEL`): Ein `value` von `null` heißt „kein
Messwert zu dieser Zeit“. Lassen Sie solche Punkte weg, bevor Sie Minimum, Maximum oder
Trend berechnen.

**Aktueller Messwert (`CurrentMeasurement`).** Der neueste Messwert einer Zeitreihe:
ein `timestamp`, ein `value` und bis zu zwei Zustandseinstufungen
(`stateMnwMhw`, `stateNswHsw`; siehe unten). „Neuester“ heißt nicht immer aktuell: Ein
Pegel, der keine Daten mehr meldet, behält seinen letzten Messwert samt Einstufung,
manchmal stundenlang – prüfen Sie daher den `timestamp`.

---

## Zustandseinstufungen

Diese String-Felder eines aktuellen Messwerts stufen den Wert gegenüber
standardisierten Bezugsmarken ein. Es gibt sie nur bei Wasserstands-Zeitreihen (nicht bei
`Q` oder Temperaturen). Der Client gibt den Wert der API unverändert weiter; die API
dokumentiert sechs Werte:

| Wert | Bedeutung |
| --- | --- |
| `low` | auf oder unter MNW (nur `stateMnwMhw`) |
| `normal` | zwischen MNW und MHW (bzw. zwischen 0 und HSW) |
| `high` | auf oder über MHW (bzw. HSW) |
| `unknown` | die Zeitreihe hat keine MNW/MHW- (bzw. HSW-)Marke zum Vergleich |
| `commented` | **Fehlfunktion oder Störung des Pegels** – der Wert kann falsch sein; der Grund steht im `comment` der Zeitreihe |
| `out-dated` | der Messwert ist älter als 25 Stunden |

Ein Messwert mit `commented` ist kein Wasserstand zum Einstufen: Am 5. Oktober 2026
zeigte RINTELN 92 cm, unter seinem MNW, mit dem Kommentar „Funktionsstörung,
fehlerhafte Messwerte“.

**Kommentar (`comment`).** Der Hinweis des Betreibers zu einer gestörten Zeitreihe –
`{ shortDescription, longDescription }`, z. B. „Techn. Störung“ oder „Behelfspegel -
Messwerte können Fehler aufweisen“. Er gehört zur Zeitreihe (`pegel timeseries
<station> <series>` oder `--include-timeseries` bei `stations get` / `stations list`),
nicht zum Messwert; `current` allein zeigt ihn nicht.

**`stateMnwMhw`.** Einstufung des aktuellen Werts gegenüber den Marken
**Mittlerer Niedrigwasserstand (MNW)** und **Mittlerer Hochwasserstand
(MHW)**.

**`stateNswHsw`.** Einstufung des aktuellen Werts gegenüber den Marken
**Niedrigster Schifffahrtswasserstand (NSW)** und
**Höchster Schifffahrtswasserstand (HSW)** – den Grenzen, innerhalb derer
Schifffahrt erlaubt ist.

**Kennwerte (Pegelmarken).** Die Menge der Bezugsmarken, die für eine Zeitreihe
veröffentlicht werden (z. B. die oben genannten Stände MNW/MHW/NSW/HSW). Eingebettet in jede
Zeitreihe über `--include-characteristic` (Client: `includeCharacteristicValues`) bei
`stations get` / `stations list`; einen eigenen Befehl gibt es nicht. Die genaue Struktur hängt vom jeweiligen Standard ab,
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
`latitude`, `longitude`). Die API liest einen leeren Parameter als „kein Filter“,
daher wird ein leerer Wert (und im Client eine leere `ids`-Liste) vor jeder Anfrage
abgelehnt: in der CLI als Bedienfehler, im Client mit `PegelValidationError`.

**Einbettungs-Flags.** Optionale Erweiterungen, die zusätzliche Daten in eine Pegel- bzw.
Zeitreihen-Antwort einbetten; standardmäßig aus:

- **`includeTimeseries`** (`--include-timeseries`) – bettet die Zeitreihenliste jedes
  Pegels ein.
- **`includeCurrentMeasurement`** (`--include-current`) – bettet den aktuellen
  Messwert in jede Zeitreihe ein.
- **`includeCharacteristicValues`** (`--include-characteristic`) – bettet die
  Kennwerte (Pegelmarken) in jede Zeitreihe ein.
- **`includeForecastTimeseries`** (`--include-forecast`, nur bei Pegel-Anfragen) – führt
  zusätzlich die Vorhersage-Zeitreihe (`WV`) in der Zeitreihenliste auf.

Die API verschachtelt alle drei in der Zeitreihenliste und verwirft sie ohne
`includeTimeseries` stillschweigend; bei einer Pegel-Anfrage schaltet daher jedes der
drei `includeTimeseries` mit ein (CLI und Client), sofern es nicht ausdrücklich
gesetzt ist.

**Zeitfenster (`start` / `end`).** Die Grenzen einer `measurements`-Anfrage als
ISO-8601-Zeitpunkte. `start` kann stattdessen auch eine **ISO-8601-Periode/Dauer** sein,
etwa `P7D` („die letzten 7 Tage“) oder `P3D`. CLI: `--start`, `--end`. Ein leerer Wert
wird abgelehnt (in der CLI als Bedienfehler, im Client mit `PegelValidationError`),
statt still auf das Standardfenster zurückzufallen.

---

## Zuverlässigkeit und Grenzen

**Retry / Backoff.** Vorübergehende Antworten **`429`** (Too Many Requests) und **`503`**
(Service Unavailable) sowie vom Server zurückgesetzte Verbindungen werden automatisch
wiederholt, bis zu `maxRetries`-mal (Standard `2`; `--max-retries` der CLI nimmt
`0`–`10`); ein Timeout nicht. Jede Wiederholung wartet 200 ms × Versuch, oder länger,
wenn das `Retry-After` der Antwort (Sekunden oder HTTP-Datum) es verlangt – nie kürzer,
sodass `Retry-After: 0` keine Anfragesalve auslöst. Ein `Retry-After` über 30 s
(`MAX_RETRY_AFTER_MS`) wird nicht wiederholt: Der Fehler kommt sofort und nennt die
verlangte Wartezeit. `PegelApiError` stellt `isRetryable` für diese Status bereit.

**Weiterleitungen.** Die Engine folgt bis zu `maxRedirects` (Standard `5`)
HTTP-Weiterleitungen (301/302/303/307/308), löst `Location` relativ zur aktuellen
URL auf. Zugangsdaten – die Userinfo der Basis-URL und jeder Header mit Zugangsdaten –
bleiben beim selben Origin und entfallen, wenn eine Weiterleitung zu einem anderen
führt (ein 401/403 nach einem solchen Sprung sagt das). Jeder
andere 3xx-Status (300, 304, 305), ein fehlendes oder fehlerhaftes `Location` und ein
Sprung über das Limit hinaus sind ein Fehler (Exit 1), der das Ziel nennt:
`redirect to <url> not followed` (am Limit mit `(stopped after 5 redirects)`) oder
`redirect not followed (no Location header)`.

**Unverschlüsselte Basis-URL (`cleartextProblem`).** Eine Basis-URL mit einfachem
`http:` schickt jede Anfrage – und die Userinfo der Basis-URL, falls vorhanden –
unverschlüsselt. Die Engine nimmt sie an (ein lokaler Spiegel kann sie brauchen), aber die
CLI warnt einmal pro Aufruf auf stderr: `warning: requests to <host> are sent unencrypted
(http:, not https:)`, mit Userinfo `the base URL's credentials are sent unencrypted to
<host> …` (nie das Passwort selbst). Loopback-Hosts (`localhost`, `127.x.x.x`, `::1`) sind
ausgenommen; stdout und der Exit-Code bleiben unverändert.

**Timeout (`timeoutMs`).** Zeitlimit pro Anfrage in Millisekunden; es gilt für den
gesamten Antwortkörper, nicht nur für Leerlaufpausen (Standard `30000`; `0` schaltet es
ab). CLI: `--timeout`. Der Client setzt es für jeden Transport durch, auch für einen
eigenen.

**Obergrenze der Antwortgröße (`maxResponseBytes`).** Eine feste Obergrenze für die
Größe des Antwortkörpers zum Schutz vor Speichererschöpfung (Standard 100 MiB;
`0` = unbegrenzt). CLI: `--max-response-bytes`; die Fehlermeldung nennt diese Option.

**User-Agent (`userAgent`).** Der Wert des Headers `User-Agent` (Standard
`pegel-online-cli`, nur wenn die Option fehlt). Ein leerer Wert, Steuerzeichen (außer
Tab) und Zeichen oberhalb von U+00FF, die ein HTTP-Header nicht tragen kann, werden
vorab abgelehnt; das schließt auch Header-Injection aus: Der Client wirft
`PegelValidationError`, die CLI meldet bei `--user-agent` einen Bedienfehler (Exit 2).

---

## Ausgabe und Fehlerbehandlung

**JSON-Ausgabe.** Jeder Befehl gibt JSON auf stdout aus – standardmäßig formatiert,
mit `--compact` in einer einzigen Zeile.

**Exit-Codes.** `0` bei Erfolg; `2` bei Aufruf- bzw. Parse-Fehlern (unbekannter Befehl
oder unbekannte Option, fehlendes Argument, ungültiger Flag-Wert, eine Option mit einem
Wert zweimal angegeben, ein Pegelname, der mehrere Pegel bezeichnet); `4` bei einem
`404` der API; `1` bei jedem anderen Fehler
(Laufzeit/Netzwerk), auch bei einer Antwort ohne die dokumentierte Form. Ein
fehlgeschlagener Lauf behält seinen Code, auch wenn niemand mehr stderr liest.

**Log-Eintrag.** Jede Diagnosezeile, die die CLI auf stderr schreibt: ein Zeitstempel,
eine Stufe (`ERROR`, `WARN`, `INFO`) und ein Thema `pegel.<Bereich>`, als Text (im Stil
von log4j) oder mit `--log-format jsonl` als ein JSON-Objekt pro Zeile. Die Bereiche:
`cli` (Bedienfehler, Meldungen von commander, ein mehrdeutiger Pegelname, unerwartete
Fehler), `api` (die Antworten der API: ein Fehlerstatus, eine fehlerhafte Antwort –
kein JSON, die falsche Form, ein unbekannter Zeichensatz –, und die Hinweise unten),
`http` (die Verbindung, die Warnung vor unverschlüsseltem `http:`) und `output` (ein
fehlgeschlagenes Schreiben auf stdout). Ein Eintrag ist immer eine Zeile; Steuerzeichen
darin werden maskiert.

**Hinweise.** `stations list` gibt `Note: …`-Zeilen auf stderr aus – weiterhin mit
Exit `0` –, wenn ein `--ids`-Eintrag, `--waters` oder `--fuzzy-id` keinen Pegel traf und
wenn zwei gelistete Pegel denselben Namen tragen.

---

> **Bibliothek & Interna.** Begriffe zum TypeScript-Client und seinen Interna –
> `PegelOnlineClient`, die Request-Engine, Transport, Retry/Backoff, Fehlertypen,
> Query-Builder – finden Sie in **[DEVELOPING.md](DEVELOPING.md)** (englisch).
