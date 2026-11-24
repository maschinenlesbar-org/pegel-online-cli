# pegel-mcp

An [MCP](https://modelcontextprotocol.io/) server for [PEGELONLINE](https://www.pegelonline.wsv.de),
the live water levels at Germany's federal waterway gauges (Wasserstraßen- und
Schifffahrtsverwaltung des Bundes, WSV): about 790 gauges on about 100 rivers, canals, lakes and
coasts, every 15 minutes, the last ~31 days, as tools for AI agents. Read-only, no API key; the
data is under the Datenlizenz Deutschland – Zero 2.0 (no attribution required).

The states' official flood warnings are not in PEGELONLINE: for those, use
[hochwasserzentralen-cli](https://github.com/maschinenlesbar-org/hochwasserzentralen-cli).

It is the MCP side of [pegel-online-cli](https://github.com/maschinenlesbar-org/pegel-online-cli),
built on the same typed client, and released with it.

## Install

```bash
npm i -g @maschinenlesbar.org/pegel-online-mcp
```

This installs the **`pegel-mcp`** command (Node.js 22.12+). Or run the container
image, for linux/amd64 and linux/arm64, which needs no Node.js:

```bash
docker run -i --rm ghcr.io/maschinenlesbar-org/pegel-online-mcp:latest
```

## Connect a client

The server speaks MCP on stdio by default.

**Claude Code**

```bash
claude mcp add pegel -- pegel-mcp
# or with the image:
claude mcp add pegel -- docker run -i --rm ghcr.io/maschinenlesbar-org/pegel-online-mcp:latest
```

**Claude Desktop** (`claude_desktop_config.json`)

```json
{ "mcpServers": { "pegel": { "command": "pegel-mcp" } } }
```

**VS Code** (`.vscode/mcp.json`)

```json
{ "servers": { "pegel": { "type": "stdio", "command": "pegel-mcp" } } }
```

**Over HTTP** (Streamable HTTP, one endpoint `POST /mcp`):

```bash
pegel-mcp --transport http            # http://127.0.0.1:3000/mcp
claude mcp add --transport http pegel http://127.0.0.1:3000/mcp
```

In a container, publish the port on loopback only:
`docker run --rm -p 127.0.0.1:3000:3000 ghcr.io/maschinenlesbar-org/pegel-online-mcp:latest --transport http --host 0.0.0.0 --allowed-hosts localhost,127.0.0.1`.

For scripts and shared configs, pin a release and its digest from the
[release notes](https://github.com/maschinenlesbar-org/pegel-online-cli/releases) instead of
`latest`: `…/pegel-online-mcp:<version>@sha256:<digest>`. Check an image's provenance with
`gh attestation verify oci://ghcr.io/maschinenlesbar-org/pegel-online-mcp:<version> --repo maschinenlesbar-org/pegel-online-cli`.

## Tools

| Tool | What it answers |
|---|---|
| `getWaterLevels` | The live level (or flow, temperature) at 1–10 named gauges in one request: value with the series' own unit (cm on rivers, m+NN on canals), time, age, and a verdict from the state against mean low and high water (high, low, normal; a gauge fault with the operator's comment, out-dated, no flood reference, no value), high and low first. A name several gauges carry is ambiguous, with the gauges to choose from. |
| `getLevelTrend` | Rising, falling or steady at one gauge over a window (ISO-8601 period, default P7D): delta, rate per day, min and max with their times, the window the API sent, the last reading's age; points without a value left out and counted; optionally a few points for a chart. |
| `getRiverOverview` | Every gauge on one water with its live reading, in flow order by river kilometre (the Danube's km count down, the Weser has two chainages), how many are high, low, faulty or stale, and those first. |
| `getStationsMap` | Gauges as a GeoJSON FeatureCollection of points, by water, names or a bbox, optionally with each one's live reading; gauges without coordinates left off and named. |
| `listWaters` | The waters PEGELONLINE covers, with shortname and long name. |
| `listStations` | The gauges on a water, by name or a part of it, or all of them, with number, uuid, km, agency and coordinates. |
| `getStation` | One gauge with every series it publishes, each with unit, reading and verdict; optionally its gauge marks (MNW, MHW, HHW, …) verbatim and its forecast series. |
| `getMeasurements` | The raw points of one series in a window, oldest first, with the unit, a page at a time; forecast points (WV) with their type. |

Waters are taken by shortname, long name, English name or a part (`RHEIN`, `Rhine`,
`Mittellandkanal`); gauges by German name, number, uuid or a part (`KÖLN`, `2710080`, `DARCHAU`).
A reading over two hours old is marked stale. The verdict is PEGELONLINE's classification against
the gauge's marks, not an official flood warning.

Every tool only reads. An answer is JSON (`structuredContent` and the same as text), with the
`source` it came from and the data licence. A failure is a tool error that says what to change.

## Options

```
--transport <stdio|http>   stdio (default), or Streamable HTTP on POST /mcp
--host <address>           HTTP: the address to listen on (default 127.0.0.1)
--port <n>                 HTTP: the port (default 3000)
--allowed-hosts <list>     HTTP: Host header names to answer (default localhost,127.0.0.1,[::1])
--allowed-origins <list>   HTTP: browser origins allowed to call, exactly (https://app.example.org); none by default
--auth-token-file <path>   HTTP: a file with the bearer token every request must send (mode 600, 32+ characters)
--base-url <url>           API base URL (default https://www.pegelonline.wsv.de)
--timeout <ms>             per upstream request (default 30000)
--call-timeout <ms>        per tool call, retries included (default 45000)
--max-result-chars <n>     cap on one tool result's JSON (default 25000)
--max-pages <n>            pages a tool reads per list and call (default 10)
--user-agent <ua>          User-Agent header value
--log-format <text|jsonl>  the log records on stderr (default text)
```

## What it does and doesn't do

- **Read-only.** No tool changes anything, here or upstream.
- **No authentication** on HTTP unless you give one. It listens on loopback by default; it checks
  the `Host` header and, from a browser, the `Origin` (only the origins given with
  `--allowed-origins`, matched exactly) against DNS rebinding and other web pages. With
  `--auth-token-file <path>` every request must send `Authorization: Bearer <token>` (the file holds
  one token of at least 32 characters, mode 600, owned by the user the server runs as; read once at
  start; `(umask 077; openssl rand -hex 32 > mcp-token)` makes one); anything else is answered 401.
  Exposed beyond localhost (it logs a warning then), it belongs behind a proxy that authenticates or
  at least terminates TLS.
- **Gentle with the upstream.** One server process sends at most 2 requests at a time and 120 a
  minute to the API, pauses on HTTP 429 (as long as its Retry-After asks, at most 30 s), and stops a
  tool call after its deadline (a tool that has read part of its answer by then may answer with that
  part, and says so). A request those limits would hold longer than it or its call may wait is not
  sent: the call fails at once, naming the limit and when to ask again (and the log says so).
- **Results are data.** Text from the API is cleaned (control, bidi and zero-width characters
  removed), but it is still other people's text: a model can be told things in it. The server
  can't act on that (it has no tool that writes), but other tools in the same session could.
- **Stops cleanly.** On `docker stop` (SIGTERM) or Ctrl-C the HTTP server takes no new
  connection and lets calls in flight answer for up to 5 s, then exits 143 (130); a second signal
  ends it at once. On stdio it ends at once, and when stdin ends.
- **In a container** it needs at least 12 processes and threads (`--pids-limit`) and about
  256 MB of memory.
- **Logs** go to stderr, one record per line; stdout carries only the protocol.
- **Never installs anything.**

## Licence

Code: AGPL-3.0-or-later or commercial
([LICENSING.md](https://github.com/maschinenlesbar-org/pegel-online-cli/blob/main/LICENSING.md)).
Data: the Wasserstraßen- und Schifffahrtsverwaltung des Bundes' (WSV), under the
[Datenlizenz Deutschland – Zero – Version 2.0](https://www.govdata.de/dl-de/zero-2-0): use,
change and pass on, also commercially, without restriction and without naming the source
([DATA_LICENSE.md](https://github.com/maschinenlesbar-org/pegel-online-cli/blob/main/DATA_LICENSE.md),
the [terms of use](https://www.pegelonline.wsv.de/gast/nutzungsbedingungen)). Naming
"PEGELONLINE (WSV)" is good practice. The values are unchecked raw data without warranty: errors
and gaps occur, and for flood warnings the states' flood services and official channels are
authoritative.
