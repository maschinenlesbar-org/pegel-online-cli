# Data license

> **This tool does not include, host, or redistribute any data.**
> `pegel-online-cli` is a *client*. It only accesses data served live by
> **PEGELONLINE** (Wasserstraßen- und Schifffahrtsverwaltung des Bundes / WSV).
> That data is the WSV's and is governed by **their** terms, summarized below. The
> license of this CLI's own source code is a separate matter — see
> [LICENSING.md](LICENSING.md).

| | |
|---|---|
| **Data provider** | Wasserstraßen- und Schifffahrtsverwaltung des Bundes (WSV) / GDWS |
| **API / source** | `https://www.pegelonline.wsv.de/webservices/rest-api/v2/` |
| **Data license** | **Datenlizenz Deutschland – Zero – Version 2.0 (`DL-DE->Zero-2.0`)** — public-domain-style, the German equivalent of CC0 (since May 2024). |
| **License text** | https://www.pegelonline.wsv.de/gast/nutzungsbedingungen · https://www.govdata.de/dl-de/zero-2-0 |
| **Attribution** | **Not required** — the previous attribution/immutability requirements were explicitly dropped. |
| **Commercial use** | Allowed, explicitly and without restriction. |
| **Redistribution / modification** | Both fully permitted; no share-alike, no notice-preservation obligation. |

## Notes & caveats

> [!IMPORTANT]
> **No warranty.** The WSV provides **unchecked raw values** ("ungeprüfte
> gewässerkundliche Daten" / "Rohwerte") straight from the gauges and assumes no
> liability for accuracy, timeliness, or completeness. Errors and gaps may occur.

- The terms confirm: *"die Unveränderbarkeit und erforderliche Quellenangabe
  entfallen"* — attribution is optional good practice, not an obligation.
- The REST API serves only a **rolling window** of recent measurements (roughly
  the last ~31 days per timeseries); PEGELONLINE is a real-time service, not a
  long-term archive. (The day-count is an API characteristic, not stated in the
  terms — verify against the live API if a precise figure matters.)

## Attribution (optional)

```
Data: PEGELONLINE (Wasserstraßen- und Schifffahrtsverwaltung des Bundes / WSV),
https://www.pegelonline.wsv.de — Datenlizenz Deutschland – Zero – Version 2.0.
Provided as unchecked raw data without warranty.
```

## Sources

- https://www.pegelonline.wsv.de/gast/nutzungsbedingungen — official terms of use
- https://www.itzbund.de/SharedDocs/Pressemitteilungen/DE/2024/2024-06-14_Pegelonline-DL-DE-Zero.html — announcement of the DL-DE Zero 2.0 switch

---

*Good-faith summary compiled 2026-06-16; not legal advice. The provider's terms
are authoritative and can change — verify at the source. Note: an earlier
web snapshot claiming "CC BY 4.0" is outdated; the current license is DL-DE Zero 2.0.*
