# pegel-online-cli

A TypeScript **API client** and **command-line interface** for the open
[PEGELONLINE REST API v2](https://www.pegelonline.wsv.de/webservice/dokuRestapi)
(`pegelonline.wsv.de`) operated by the **WSV** (Wasserstraßen- und
Schifffahrtsverwaltung des Bundes) — live **water levels** and related timeseries
across the German federal waterway network.

- **Zero runtime HTTP dependencies** — built on Node's built-in `http`/`https` (no axios, no fetch polyfill).
- **One small dependency** for the CLI: [`commander`](https://github.com/tj/commander.js).
- **Strongly typed** — typed stations, timeseries and measurement shapes.
- **Well tested** — unit tests on Node's built-in test runner (`node --test`), every HTTP response mocked.
- **Read-only, no auth** — the PEGELONLINE API needs no key; this client only reads.

New to PEGELONLINE, or terms like *Gewässer*, *timeseries* (`W`/`Q`), MNW/MHW or
NSW/HSW? See **[GLOSSARY.md](GLOSSARY.md)** for the domain concepts and the
project's own vocabulary.

## Requirements

- Node.js **>= 20** (uses the stable built-in test runner, ESM and top-level `await`).

## Install

```bash
npm install
npm run build        # compiles TypeScript to dist/
```

Run the CLI without a global install:

```bash
node dist/src/cli/index.js --help
# or, after `npm link` / global install:
pegel --help
```

---

## CLI usage

Every command prints pretty JSON to stdout (`--compact` for a single line). A
`<station>` may be a **uuid**, **number**, **shortname** or **longname**. A
`[timeseries]` defaults to **`W`** (water level); others include `Q` (flow),
`WT` (water temperature), `LT` (air temperature), depending on the station.

### Global options

| Option | Description |
| --- | --- |
| `--base-url <url>` | API base URL (default `https://www.pegelonline.wsv.de`) |
| `--timeout <ms>` | Per-request timeout (default `30000`) |
| `--user-agent <ua>` | `User-Agent` header value |
| `--max-retries <n>` | Retries for transient `429`/`503` responses (default `2`) |
| `--max-response-bytes <n>` | Cap response body size in bytes (`0` = unlimited; default 100 MiB) |
| `--compact` | Print JSON on a single line |

Global options are accepted **before or after** the command, e.g. both
`pegel --compact waters` and `pegel waters --compact` work; placing them before
the command is recommended for clarity.

### Commands

```text
stations list [--ids <id> ...] [--waters <shortname>] [--fuzzy-id <id>]
              [--include-timeseries] [--include-current] [--include-characteristic]
stations get <station> [--include-...]
timeseries     <station> [timeseries]    metadata for a timeseries
current        <station> [timeseries]    the current measurement
measurements   <station> [timeseries] [--start <iso|P7D>] [--end <iso>]
waters                                   list all bodies of water (Gewässer)
```

### Examples

```bash
# All stations on the Rhine, with their current water level
pegel stations list --waters RHEIN --include-current

# One station
pegel stations get BONN --include-timeseries --include-current

# Current water level at Bonn
pegel current BONN

# Last 3 days of measurements
pegel measurements BONN W --start P3D

# Characteristic (gauge-mark) values, embedded in the timeseries
pegel stations get BONN --include-timeseries --include-characteristic

# Bodies of water
pegel waters
```

Exit codes: `0` success, `2` for usage/parse errors (unknown command/option, missing argument, invalid flag value), `4` on a `404` from the API, `1` for any other (runtime/network) error.

---

## Library usage

```ts
import { PegelOnlineClient, PegelApiError } from "@maschinenlesbar.org/pegel-online-cli";

const client = new PegelOnlineClient(); // defaults to https://www.pegelonline.wsv.de

const rhine = await client.stations.list({ waters: "RHEIN", includeCurrentMeasurement: true });
const bonn = await client.stations.get("BONN", { includeTimeseries: true });
const now = await client.timeseries.currentMeasurement("BONN", "W");
const series = await client.timeseries.measurements("BONN", "W", { start: "P3D" });

try {
  await client.stations.get("DOES-NOT-EXIST");
} catch (err) {
  if (err instanceof PegelApiError) console.error(err.status, err.detail);
}
```

### Client options

```ts
new PegelOnlineClient({
  baseUrl: "https://www.pegelonline.wsv.de",
  timeoutMs: 15_000,
  maxRetries: 3,              // 429 / 503 are retried with linear backoff
  maxResponseBytes: 50 << 20, // abort responses larger than 50 MiB (0 = unlimited)
  userAgent: "my-app/1.0",
  transport: customTransport, // inject your own HTTP transport
});
```

### Resource groups

`client.stations` (`.list` / `.get`), `client.timeseries` (`.get` / `.currentMeasurement` /
`.measurements`), and `client.waters()`. Characteristic (gauge-mark) values are
available via the `includeCharacteristicValues` embed on `.get` / `.list`.

---

## Architecture

```
src/
  client/
    types.ts     # Station / TimeseriesInfo / CurrentMeasurement / Measurement + param objects
    query.ts     # dependency-free query-string builder
    http.ts      # the Transport interface + default node:http/https transport
    engine.ts    # URL building, retry/backoff, redirects, JSON decoding, error mapping
    errors.ts    # PegelError / PegelApiError / PegelNetworkError / PegelParseError
    client.ts    # PegelOnlineClient — stations + timeseries resources over the engine
  cli/
    io.ts        # injectable I/O seam (stdout/stderr)
    shared.ts    # option parsers, global-option resolver, JSON renderer
    commands/    # stations + timeseries/measurements/waters
    program.ts   # assembles the commander program from injectable deps
    run.ts       # parses argv -> exit code (no process.exit; testable)
    index.ts     # #! bin shim
```

**Design notes**

- The HTTP layer is a single `Transport` function (`(req) => Promise<HttpResponse>`). The default
  uses `node:http`/`node:https`; tests inject a mock. This keeps the client free of any HTTP framework.
- The CLI is built around injectable `CliDeps` (client factory + I/O), so the whole program can be
  driven in-process by tests with a mocked client and captured output — no subprocesses.
- The engine follows HTTP redirects, so trailing-slash and host normalisations are handled transparently.

---

## Testing

```bash
npm test          # builds, then runs `node --test` over dist/test
```

- **`query.test.ts`** — query-string serialisation.
- **`http.test.ts`** — the default transport against a real loopback `http.createServer`.
- **`engine.test.ts`** — URL building, JSON decoding, error mapping, 429/503 retry — mocked transport.
- **`client.test.ts`** — every endpoint's method/URL/query mapping — mocked transport.
- **`cli.test.ts`** — end-to-end command parsing, validation and exit codes — mocked client.

## Continuous integration

GitHub Actions workflows under `.github/workflows/`:

- **ci.yml** — type-check, build and test on Node 20/22/24 for every push and PR.
- **release.yml** — on a `v*` tag: verify the tag matches `package.json`, test, `npm pack`, and create a GitHub Release with the tarball.
- **publish.yml** — manual dispatch: publish to npm via OIDC **Trusted Publishing** (no stored `NPM_TOKEN`) with provenance.
- **docs.yml** — build TypeDoc API docs and deploy to GitHub Pages on each `v*` tag.

## License

**Dual-licensed** — use it under **either**:

- **[AGPL-3.0-or-later](LICENSE)** (default, free). Note the AGPL's §13 network
  clause: if you run a modified version as a network service, you must offer that
  modified source to the service's users.
- **Commercial license** (paid), for closed-source / proprietary or SaaS use
  without the AGPL's obligations.

See **[LICENSING.md](LICENSING.md)** for details, and **[CONTRIBUTING.md](CONTRIBUTING.md)**
for the contribution policy (this project does not accept external code
contributions). Commercial enquiries: **sebs@2xs.org**.
