# pegel-online-cli — Claude Code Skills

A set of [Claude Code](https://code.claude.com/docs/en/skills) **Agent Skills** for live
German waterway water-level intelligence, all powered by the **[pegel](README.md)** CLI
over the open [PEGELONLINE REST API v2](https://www.pegelonline.wsv.de/webservice/dokuRestapi)
(`pegelonline.wsv.de`), operated by the WSV.

Each skill teaches Claude how to drive the `pegel` CLI to answer a specific, real-world
question — "what's the Rhine level at Bonn?", "any flooding along the Elbe?", "is the level
rising or falling?", "map the gauges with their levels" — and to report the answer with
evidence rather than guesswork. They encode the parts that are easy to get wrong (the
`--include-current` embed that silently needs `--include-timeseries`, the flood signal
living on the current reading rather than the gauge marks) so Claude doesn't have to
rediscover them each time.

## Skills

| Skill | What it does | Ask it… |
|---|---|---|
| **pegel-water-level-check** | Pulls the current reading at one or more named gauges and judges normal / high / low from the state classification — value, unit, time, verdict. | "what's the Rhine at Bonn?", "is the water high in Köln?", "flood risk at Emmerich?" |
| **pegel-river-overview** | Merges every gauge on a river, orders them downstream by river-km, embeds live levels and ranks the high/low ones. | "show all gauges on the Rhine", "any flooding on the Mosel?", "rank Danube stations by level" |
| **pegel-trend** | Reduces a measurement window to direction, delta, rate and min/max — a trend, not hundreds of points. | "is the Elbe at Dresden rising or falling?", "level trend last 7 days at Köln" |
| **pegel-stations-geojson** | Exports gauges (optionally with live levels in the properties) as a valid GeoJSON `FeatureCollection` for Leaflet / geojson.io / QGIS. | "map the Rhine gauges", "export Elbe stations as GeoJSON", "plot gauges near Cologne" |

## Requirements

- **[Claude Code](https://code.claude.com/docs/en/overview)** (or any harness that loads
  Agent Skills).
- **The `pegel` CLI** installed globally and on your PATH:
  ```bash
  npm i -g @maschinenlesbar.org/pegel-online-cli   # installs the `pegel` bin
  ```
  No API key is required — the PEGELONLINE API is free, open, and read-only.

## Installation

### Plugin marketplace (recommended)

This repo is a Claude Code **plugin marketplace**, so installation is two commands inside
Claude Code:

```
/plugin marketplace add maschinenlesbar-org/pegel-online-cli
/plugin install pegel@pegel-skills
```

The first command registers the marketplace; the second installs the `pegel` plugin,
which bundles all four skills. Update later with `/plugin marketplace update`.

### Manual (copy the skill folders)

Prefer not to use the marketplace? Copy the skills into your **personal** directory
(available across all your projects):

```bash
git clone https://github.com/maschinenlesbar-org/pegel-online-cli tmp-skills
mkdir -p ~/.claude/skills
cp -R tmp-skills/skills/* ~/.claude/skills/
rm -rf tmp-skills
```

…or into a single project's `.claude/skills/` by swapping `~/.claude/skills` for
`.claude/skills`. Each skill lives in its own directory with a `SKILL.md`, e.g.
`skills/pegel-water-level-check/SKILL.md`. Start a new Claude Code session and the skills
are picked up automatically.

## Usage

You don't normally invoke these by name — Claude auto-selects the right skill from your
request. Just ask in natural language:

> What's the Rhine level at Bonn, and is it high?

> Show me all the gauges on the Elbe with their current levels, flooded ones first.

> Is the water at Dresden rising or falling over the last week?

> Export the Rhine gauges as GeoJSON with their levels so I can open it in geojson.io.

You can also invoke a skill explicitly with its slash command, e.g. `/pegel-water-level-check`.

## How it works

Every skill is a single `SKILL.md` — a short, model-facing playbook describing which
`pegel` subcommands to call, in what order, and how to interpret the JSON. The skills
encode the non-obvious parts of this API, for example:

- **`--include-current` is silently dropped without `--include-timeseries`** on
  `stations list` / `stations get` — the current reading is nested *inside* each station's
  `timeseries[]`, so both flags must be passed together to get levels (the README's
  `--waters RHEIN --include-current` example is misleading; see **pegel-river-overview**);
- the reliable flood/low-water signal is **`stateMnwMhw`** on the *current measurement*
  (`normal` / `high` / `low` / `unknown`), **not** the gauge marks — which are
  river-specific codes like `GlW` / `M_I` / `M_II`, not the MNW/MHW pair the docs imply
  (see **pegel-water-level-check**);
- a measurement `value` carries **no unit** — the unit (`cm` for W, `m³/s` for Q, `°C` for
  temperatures) belongs to the series; default `W` is centimetres, never assume metres;
- **timestamps are local German time** (`+02:00` in summer), even when you pass `Z`/UTC
  window bounds to `measurements`;
- a **bad `--start` returns HTTP 400 but the CLI still exits 0** — check stdout actually
  parsed as a non-empty array before trusting a trend (see **pegel-trend**);
- there is **no `--bbox` flag** despite some docs — filter `latitude`/`longitude` with
  `jq` for a viewport (see **pegel-stations-geojson**);
- station coordinates are already numeric WGS84 `longitude`/`latitude` — GeoJSON needs
  `[longitude, latitude]` (x, y) order, not `[lat, lon]`.

## Contributing

This project does not accept external code contributions (see
[CONTRIBUTING.md](CONTRIBUTING.md)). When adding a skill internally, keep `SKILL.md`
focused, give it a `description` with concrete trigger phrases, and follow the
[official skill format](https://code.claude.com/docs/en/skills).

## License

[AGPL-3.0-or-later](LICENSE) © Sebastian Schürmann. See [LICENSING.md](LICENSING.md) for
the dual-licensing / commercial option.
