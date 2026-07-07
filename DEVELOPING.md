# Developing & integrating

This document covers `pegel-online-cli` as a **TypeScript library**, plus its
architecture, testing and release setup. If you just want to use the
command-line tool, start with the **[README](README.md)** and
**[Usage.md](Usage.md)** instead.

The package ships both a CLI (`pegel`) and a typed API client
(`PegelOnlineClient`) for the
[PEGELONLINE REST API v2](https://www.pegelonline.wsv.de/webservice/dokuRestapi)
(`pegelonline.wsv.de/webservices/rest-api/v2`).

**Design goals**

- **Zero runtime HTTP dependencies** — built on Node's built-in `http`/`https` (no axios, no fetch polyfill).
- **One small dependency** for the CLI: [`commander`](https://github.com/tj/commander.js).
- **Strongly typed** — typed stations, timeseries and measurement shapes.
- **Well tested** — unit tests on Node's built-in test runner (`node --test`), every HTTP response mocked.
- **Read-only, no auth** — the PEGELONLINE API needs no key; this client only reads.

## Build from source

```bash
npm install
npm run build        # compiles TypeScript to dist/
```

Run the locally built CLI without a global install:

```bash
node dist/src/cli/index.js --help
# or, after `npm link`:
pegel --help
```

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

`client.stations` (`.list` / `.get`), `client.timeseries` (`.get` /
`.currentMeasurement` / `.measurements`), and `client.waters()`. Characteristic
(gauge-mark) values are available via the `includeCharacteristicValues` embed on
`.get` / `.list`.

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

### Library & technical terms

**API client (`PegelOnlineClient`).** [`src/client/client.ts`](src/client/client.ts) — the typed,
resource-grouped wrapper over the API. Usable as a library independently of the CLI. Exposes
`stations`, `timeseries` and the `waters()` method.

**Resource group.** A cohesive set of client methods for one part of the API
(`client.stations`, `client.timeseries`) and the matching top-level CLI command.

**Request engine (`RequestEngine`).** [`src/client/engine.ts`](src/client/engine.ts)
— builds URLs, serialises queries, applies retry/backoff, follows redirects,
decodes JSON and maps errors. Sits between the client's resource methods and the transport.
`DEFAULT_BASE_URL` is `https://www.pegelonline.wsv.de`.

**Transport.** A single function `(HttpRequest) => Promise<HttpResponse>`
([`src/client/http.ts`](src/client/http.ts)). The default (`nodeHttpTransport`) uses Node's
built-in `http`/`https`; tests inject a mock. This is the only HTTP seam.

**Retry / backoff.** Transient `429` (rate limit) and `503` responses are retried automatically
with linear backoff, up to `maxRetries` (default `2`). `PegelApiError` exposes `isRetryable`
for exactly these statuses. CLI: `--max-retries`.

**Redirects.** The engine follows up to `maxRedirects` (default `5`) HTTP redirects
(301/302/303/307/308), resolving `Location` relative to the current URL. When a hop
crosses to a different **origin** (scheme + host + port) — including a same-host
`https:` -> `http:` downgrade — credential-bearing headers (`Authorization`, `Cookie`,
`X-API-Key`, `Proxy-Authorization`) are stripped, case-insensitively, before the next
request. This client is keyless and sets none, but the guard is unconditional so a
library consumer that adds one via `headers` is protected.

**maxResponseBytes.** A hard cap on response body size to defend against memory exhaustion
(default 100 MiB; `0` = unlimited). CLI: `--max-response-bytes`.

**RawResponse.** The low-level result of a request: `{ data: Buffer, contentType, status }` —
raw bytes, never lossily decoded. Exported for completeness; endpoints return decoded JSON.

**Query builder (`buildQueryString`).** [`src/client/query.ts`](src/client/query.ts) — a
dependency-free serialiser: omits `undefined`/`null`, repeats keys for arrays, renders booleans
as `true`/`false`, dates as ISO-8601, and encodes spaces as `%20` (not `+`).

**CliDeps / CliIO.** The dependency-injection seam for the CLI
([`src/cli/io.ts`](src/cli/io.ts)): a client factory plus an I/O object (`out`/`err`). Lets the
whole CLI run in tests with a mocked client and captured output — no subprocess.

**Error types.** [`src/client/errors.ts`](src/client/errors.ts):
`PegelApiError` (non-2xx; carries `status`, `detail`, `url`, `method`, `body`),
`PegelNetworkError` (transport failure/timeout), `PegelParseError` (bad JSON),
all extending the base `PegelError`.

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

Dual-licensed under **[AGPL-3.0-or-later](LICENSE)** or a commercial license — see
**[LICENSING.md](LICENSING.md)**. This project does **not** accept external code
contributions; see **[CONTRIBUTING.md](CONTRIBUTING.md)**.
