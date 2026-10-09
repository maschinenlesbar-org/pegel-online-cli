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

All fields are optional; the values below are illustrative overrides, **not**
defaults (defaults are `maxRetries: 2`, `maxResponseBytes: 100 MiB`, `timeoutMs:
30_000`, `maxRedirects: 5`). Numeric options must be integers in range —
`timeoutMs` 0..`MAX_TIMEOUT_MS`, `maxRetries` 0..`MAX_RETRIES` (10), `retryDelayMs`
0..`MAX_RETRY_AFTER_MS`, `maxRedirects` 0..20, `maxResponseBytes` 0..2^53-1 — or the
constructor throws `PegelValidationError` (`Invalid option timeoutMs: expected an integer
from 0 to 2147483647, got NaN.`), so `Number(process.env.X)` of an unset variable can't
silently disable the timeout. A `transport` or `sleep` that is not a function, and a
`headers` option that is not an object of sendable header values, are rejected the same
way; so is a station or timeseries id that is not a non-blank string, or is "." / "..".
Server text in a message (an error `detail`, a transport's error text, a redirect target)
is cut at 500 characters; `PegelApiError.body` keeps it all.

```ts
new PegelOnlineClient({
  baseUrl: "https://www.pegelonline.wsv.de",
  timeoutMs: 15_000,
  maxRetries: 3,              // 429 / 503 / resets: linear backoff, longer if Retry-After (<= 30 s) asks
  maxResponseBytes: 50 << 20, // abort responses larger than 50 MiB (0 = unlimited)
  userAgent: "my-app/1.0",
  transport: customTransport, // inject your own HTTP transport
});
```

### Resource groups

`client.stations` (`.list` / `.get` / `.assertUnique`), `client.timeseries` (`.get` /
`.currentMeasurement` / `.measurements`), and `client.waters()`. Characteristic
(gauge-mark) values are available via the `includeCharacteristicValues` embed on
`.get` / `.list`; forecast series (`WV`) via `includeForecastTimeseries`
(`StationIncludeParams`, station methods only — `timeseries.get` rejects it). On those
two station methods, `includeCurrentMeasurement`, `includeCharacteristicValues` and
`includeForecastTimeseries` imply `includeTimeseries: true` unless it is set
explicitly: the API nests all three inside the timeseries list and drops them without
it. A forecast series' metadata carries `start`/`end` (the forecast window), and its
`timeseries.measurements(station, "WV")` points carry `initialized` and `type`
(`ForecastType`: `forecast` | `estimate`); `currentMeasurement(station, "WV")` is a 404.

## Architecture

```
src/
  client/
    types.ts     # Station / TimeseriesInfo / CurrentMeasurement / Measurement + param objects
    query.ts     # dependency-free query-string builder
    http.ts      # the Transport interface + default node:http/https transport
    engine.ts    # URL building, retry/backoff, redirects, JSON decoding, error mapping
    errors.ts    # PegelError / PegelApiError / PegelNetworkError / PegelParseError / PegelValidationError
    validate.ts  # input rules (Problem functions) + assertValid, shared by library and CLI
    client.ts    # PegelOnlineClient — stations + timeseries resources over the engine
  cli/
    io.ts        # injectable I/O seam (stdout/stderr), the logger and the clock
    log.ts       # the stderr log: records with ts, level, topic; --log-format text|jsonl
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

**Retry / backoff.** Transient `429` (rate limit) and `503` responses are retried automatically,
up to `maxRetries` (default `2`; CLI `--max-retries`, `0`–`10`). So is a reset connection
(`isTransientNetworkError`: `ECONNRESET`/`EPIPE`/`ECONNABORTED` or undici's `UND_ERR_SOCKET`
anywhere in the error's `cause` chain), with the linear backoff, for `GET`/`HEAD` only;
a refused connection, a DNS failure and a timeout are not retried. Each retry waits
`retryDelayMs * attempt` (200 ms, 400 ms, …). A `Retry-After` (`parseRetryAfter`:
delay-seconds or an IMF-fixdate, anything else is ignored) can make that wait longer, never
shorter: `Retry-After: 0` or a date in the past still waits the backoff, so retries never
burst. A `Retry-After` above `MAX_RETRY_AFTER_MS` (30 s) is not retried: the error surfaces at
once, its message names the requested wait, and `PegelApiError.retryAfterMs` holds it.
`PegelApiError` exposes `isRetryable` for exactly these statuses.

**Redirects.** The engine follows up to `maxRedirects` (default `5`) HTTP redirects
(301/302/303/307/308), resolving `Location` relative to the current URL. Any other 3xx,
a missing or malformed `Location` and a hop past the limit surface as a `PegelApiError`
whose `location` field and message name the target (`redirect to <url> not followed`,
plus `(stopped after N redirects)` at the limit; resolved, userinfo redacted,
sanitised). When a hop
crosses to a different **origin** (scheme + host + port) — including a same-host
`https:` -> `http:` downgrade — credential-bearing headers (`Authorization`, `Cookie`,
`X-API-Key`, `Proxy-Authorization`) are stripped, case-insensitively, before the next
request. This client is keyless and sets none, but the guard is unconditional so a
library consumer that adds one via `headers` is protected. The base URL's userinfo (sent
as Basic auth) follows the same rule: a redirect on the same origin keeps it — an absolute
`Location` too, not only a relative one — and one to another origin, an `http:` -> `https:`
upgrade included, drops it. If the request then fails with 401 or 403, the message says the
redirect dropped the credentials (for http -> https: "use an https base URL"). Transports
must not follow redirects themselves: `HttpRequest.redirect` is `"manual"` (pass it to
`fetch`), and a response whose `url` lies on another origin than the request is rejected as
a `PegelNetworkError`.

**maxResponseBytes.** A hard cap on response body size to defend against memory exhaustion
(default 100 MiB; `0` = unlimited). CLI: `--max-response-bytes`. The default transport aborts
as soon as the cap is passed; the engine also checks the body any transport returns, so the
cap holds for custom transports too. The message names both the option and the flag.

**timeoutMs.** A deadline for the whole request, response body included (default 30 s;
`0` disables). The engine enforces it itself, for every transport: the transport gets an
`AbortSignal` (`HttpRequest.signal`) that fires at the deadline, and the call rejects then
with a `PegelNetworkError` whether the transport stops or not, so a `fetch` or `node:http`
transport can't hang a caller. A timed-out request is not retried.

**Custom transports.** A transport may return the body as a Buffer, any `ArrayBuffer` view
(fetch's `Uint8Array`, from any realm) or an `ArrayBuffer`, and the headers as a plain record
in any letter case, a `Headers` object or a `Map` (`Retry-After` and `Location` are found in
all of them). Whatever it throws, and a response without a usable `status` (100–599),
`headers` or `body`, becomes a `PegelNetworkError` whose message names the request
(`GET <url> failed: socket hang up`), with the original as `cause`. A redirect to anything
but `http:`/`https:` (`file:`, `data:`, `javascript:`) is refused before the transport is
called.

**RawResponse.** The low-level result of a request: `{ data: Buffer, contentType, status }` —
raw bytes, never lossily decoded. Exported for completeness; endpoints return decoded JSON. `getJson` decodes the
bytes by the charset the `Content-Type` names (UTF-8 when it names none; a byte order mark is
dropped); an unknown charset label is a `PegelParseError`.

**Query builder (`buildQueryString`).** [`src/client/query.ts`](src/client/query.ts) — a
dependency-free serialiser: omits `undefined`/`null`, repeats keys for arrays, renders booleans
as `true`/`false`, dates as ISO-8601, and encodes spaces as `%20` (not `+`).

**CliDeps / CliIO.** The dependency-injection seam for the CLI
([`src/cli/io.ts`](src/cli/io.ts)): a client factory plus an I/O object (`out`/`err`). Lets the
whole CLI run in tests with a mocked client and captured output — no subprocess.

**Error types.** [`src/client/errors.ts`](src/client/errors.ts):
`PegelApiError` (non-2xx; carries `status`, `detail`, `url`, `method`, `body`),
`PegelNetworkError` (transport failure/timeout — whatever a custom transport throws —,
an invalid transport response, a body over `maxResponseBytes`, and the default
transport's per-hop scheme check), `PegelParseError` (bad JSON, an unknown charset, or a 2xx
answer without the documented shape: every method checks it — an array of waters or
stations with string `shortname`/`longname`/`uuid`, a station or timeseries object, a
measurement with a string `timestamp` and a numeric or `null` `value` — so `null`, `{}`, an
error envelope or a proxy page is never returned as data),
`PegelValidationError` (an input rejected before any request), all extending the
base `PegelError`.

**Input validation.** [`src/client/validate.ts`](src/client/validate.ts) holds the
library's input rules as pure `<thing>Problem(value)` functions, which return the
reason a value is invalid or `undefined`. The client enforces them with
`assertValid(name, value, problem)` before any request, so a rejected input sends
nothing: it throws (from a constructor) or rejects (from a method) with
`PegelValidationError` and the message `Invalid <name>: <reason>`. The rules so far:

- **Blank filters** (`nonEmptyProblem`, `idListProblem`): `stations.list` rejects a
  blank `waters` or `fuzzyId`, a blank `ids` entry and an empty `ids` array, and
  `timeseries.measurements` a blank `start` or `end`. The API reads an empty
  parameter as no filter, so these would silently return every station or the
  default window.
- **Base URL** (`baseUrlProblem`, applied by the exported `validateBaseUrl`): the
  constructor rejects, in this order, a `baseUrl` with surrounding whitespace or any
  whitespace/control character inside (`baseUrlWhitespaceProblem`), one that is not
  an absolute URL, a scheme other than `http:`/`https:`, a query or fragment, and a
  `%` in the user name or password that doesn't start a valid escape (Node would fail
  to decode it for the Authorization header at request time; write a literal `%` as
  `%25`).
  It checks the raw value, before trailing slashes are stripped: `new URL()` would
  trim or strip whitespace silently, but the engine glues request paths onto the raw
  string (`"https://h/ "` requests `/%20/webservices/...`). A bad base URL is a
  `PegelValidationError`, not a `PegelNetworkError`; the CLI's `--base-url` parser
  uses the same rule and messages. The reasons never repeat the value. The CLI also
  redacts on output: `run.ts` (`withRedactedOutput`) takes the exact userinfo of every
  argument (`credentialsIn`, exported) and replaces it with `***` in everything it
  prints — commander's usage errors, which echo rejected values, and its own
  messages — so a password with spaces, quotes, `#`, `?` or `/` is caught as well as
  an ordinary one. `redactUrl` falls back to the same text-based cut
  (`redactCredentials`, exported) for a value that doesn't parse as a URL. In the library, the
  engine keeps the base URL (and any `headers` a caller adds) in real `#private` fields,
  so `console.log(client)`, `util.inspect` and `JSON.stringify` never show them, and it
  scrubs the base URL's userinfo (raw and percent-decoded) from error bodies, details,
  transport error text and the `cause` chain it attaches.
- **Cleartext base URL** (`cleartextProblem(baseUrl, secrets = [])`, exported): returns
  one sentence when requests to `baseUrl` would travel unencrypted — `requests to <host>
  are sent unencrypted (http:, not https:)`, or `the base URL's credentials are sent
  unencrypted to <host> (http:, not https:)` when it carries userinfo (other secrets'
  noun phrases in `secrets` are joined with "and") — and `undefined` for `https:`, an
  unparseable URL and a loopback host (`localhost`, 127.0.0.0/8, `::1`). `<host>` is
  `url.host`; the sentence never holds a password. It is advice, not a rule: the engine
  still accepts `http:`. The CLI's `action()` (`cli/shared.ts`) prints it once per run
  as a `WARN` record of `pegel.http` on stderr before the client is built; help, version and
  usage errors never reach an action, and stdout and the exit code are unchanged.
- **User-Agent** (`headerValueProblem`): only an omitted `userAgent` selects the
  default `pegel-online-cli`. An explicit value must not be blank (it would replace
  the default with an empty header) and must not contain a control character other
  than tab or a character above U+00FF, which an HTTP header cannot carry (CR/LF
  would also allow header injection). The CLI's `--user-agent` parser uses the same
  rule.

- **Normalised ids and filters** (`normalizeInput`): every station and timeseries id,
  `ids` entry, `waters`, `fuzzyId`, `start` and `end` is sent trimmed and composed (NFC).
  The API matches them exactly, so `"RHEIN "` used to list no station and `"BONN "` was a
  404; no upstream name begins or ends with whitespace.
- **Parameter keys** (`knownKeysProblem`, `optionalBooleanProblem`): every method's
  parameter object, and the constructor's options, may hold only the documented keys; a
  misspelled one (`water`, `fuzzyID`, `timeout`), `__proto__` or `constructor` is a
  `PegelValidationError` naming a close match, instead of being dropped (which listed
  every station). The include flags must be booleans.
- **Filters that matched nothing** (`stationListNotes(params, stations)`): the API drops
  an unknown `ids` entry and answers an unknown `waters`/`fuzzyId` with `[]`, all with
  HTTP 200. This function returns those filter values (`{ kind: "unmatched", filter,
  value }`), and — when the call looked stations up by name (`ids`, `fuzzyId`) — every
  shortname two returned stations share (`{ kind: "ambiguous", name, stations }`;
  `NEUSTADT` names a LEINE and an OSTSEE gauge, and the API answers a lookup by that name
  with one of them). The CLI logs them as `INFO` records of `pegel.api` on stderr and exits 0.
- **Ambiguous station names** (`stations.assertUnique(station)`, `isUnambiguousStationId`,
  `PegelAmbiguousStationError`): the per-station methods (`stations.get`, `timeseries.*`)
  send a name as given and make no extra request. `assertUnique` checks it first: a uuid
  or number (digits only) passes without a request; a name is looked up with
  `stations.list({ ids: [name] })`, and when two or more returned stations carry it (by
  uuid, number, shortname or longname, ignoring case) it rejects with
  `PegelAmbiguousStationError` (a `PegelValidationError`; `.station`, and `.stations` as
  `StationChoice` objects with water, number and uuid). The CLI calls it before
  `stations get`, `timeseries`, `current` and `measurements`, so a name costs one extra
  request and an ambiguous one exits 2 without the per-station request.

The CLI's
commander parsers call the same functions, so a rule exists once; a single-value option
given twice is a usage error (`once` in `cli/shared.ts`) rather than the last one winning; `run.ts` maps a
`PegelValidationError` raised during an action to the usage exit code 2, logged as an
`ERROR` record of `pegel.cli`.

## Testing

```bash
npm test          # builds, then runs `node --test` over dist/test
```

- **`query.test.ts`** — query-string serialisation.
- **`http.test.ts`** — the default transport against a real loopback `http.createServer`.
- **`engine.test.ts`** — URL building, JSON decoding, error mapping, 429/503 retry — mocked transport.
- **`client.test.ts`** — every endpoint's method/URL/query mapping — mocked transport.
- **`cli.test.ts`** — end-to-end command parsing, validation and exit codes — mocked client.
- **`validate.test.ts`** — the input rules and `assertValid`.
- **`log.test.ts`** — the record helpers of `src/cli/log.ts` on their own
  (`escapeForRecord`, `formatLogRecord`); the CLI-level checks are P23's.
- **Parity tests** use `parity()` from `test/helpers.ts`: one input through `run()` and through
  the library call on recording mock transports; both must reject without a request, or both
  send the same request.
- **`conformance-p*.test.ts`** — the shared checks of the 2026-10-05 fix patterns, copied
  across the maschinenlesbar.org CLIs with only their adapter block changed: P1 (credentials
  in CLI output), P2 (in logged clients and errors), P3 (credentials across redirects), P4
  (base-URL rules; the P19 case is skipped — pegel reads no environment variable), P5 (the
  transport contract), P6 (retry policy), P7 (pipes and exit codes, runs the built bin), P8/P9/P13
  (charset, response shapes, validation errors), P10 (strict filters), and, from the
  2026-10-06 follow-up round, P20 (the stderr warning for a plain-`http:` base URL; the
  environment and other-secret cases are skipped — pegel reads no environment variable
  and sends no key) and P21 (every relative link in `README.md`, which npmjs.com shows, points
  to a file `package.json` `files` ships; a document the tarball leaves out is linked by its
  `https://github.com/maschinenlesbar-org/pegel-online-cli/blob/main/…` URL), and P23 (the
  stderr log: records with timestamp, level and topic, `--log-format text|jsonl`). `validFor()` in
  `test/helpers.ts` answers any endpoint with a body of its documented shape.

## Continuous integration

GitHub Actions workflows under `.github/workflows/`:

- **ci.yml** — type-check, build and test on Node 22/24 for every push and PR.
- **release.yml** — on a `v*` tag: verify the tag matches `package.json`, test, `npm pack`, and create a GitHub Release with the tarball.
- **publish.yml** — manual dispatch from the release tag (`gh workflow run publish.yml --ref vX.Y.Z`; the version is the tag's): publish to npm via OIDC **Trusted Publishing** (no stored `NPM_TOKEN`) with provenance.
- **docs.yml** — build the project website (`site/`, English and German) with the TypeDoc API docs
  under `/api/`, and deploy both to GitHub Pages on each `v*` tag.
  TypeDoc runs from the isolated, lockfile-pinned `tools/docs/` toolchain because it
  needs the TypeScript 6 compiler API, which TypeScript 7 no longer ships; locally,
  run `npm ci --prefix tools/docs` once before `npm run docs`.

## Website

The project website — <https://maschinenlesbar-org.github.io/pegel-online-cli/> in English and
<https://maschinenlesbar-org.github.io/pegel-online-cli/de/> in German — is built from `site/`
with [Jekyll](https://jekyllrb.com/), [banira](https://sebs.github.io/banira/) web components
and [Fylgja](https://fylgja.dev/) CSS, and deployed by `docs.yml` together with the TypeDoc API
reference under `/api/`. Its content comes from this repository: the README intro and quick
start, the command tree of the built CLI (`site/scripts/cli-reference.mjs`), `Usage.md`,
`GLOSSARY.md` and its German version `GLOSSARY.de.md`, the skills, and the skill examples in
`EXAMPLE.md` and `EXAMPLE.de.md`. The only repo-specific files are `site/_config.yml` and
`site/_data/project.yml` (the German intro and the access requirements); the rest of `site/` is
identical in every maschinenlesbar.org CLI, so change it in all of them together. When the
README intro changes, update the German intro in `site/_data/project.yml`.

```bash
npm run build                        # the CLI, for the command reference
cd site && npm ci && bundle install  # once (Node >= 22.12, Ruby 3.4, Bundler)
npm run serve                        # http://127.0.0.1:4000/pegel-online-cli/
```

## License

Dual-licensed under **[AGPL-3.0-or-later](LICENSE)** or a commercial license — see
**[LICENSING.md](LICENSING.md)**. This project does **not** accept external code
contributions; see **[CONTRIBUTING.md](CONTRIBUTING.md)**.

## The log on stderr

Every diagnostic line on stderr is a log record (`src/cli/log.ts`): a timestamp, a level
(`ERROR`, `WARN`, `INFO`) and a topic, `pegel.<area>`. `--log-format text` (the default)
writes it log4j style, `<ISO 8601 UTC> <LEVEL padded to 5> [<topic>] <message>`;
`--log-format jsonl` writes one JSON object per line with exactly `ts`, `level`, `topic`
and `msg`. A record is always one line: `formatLogRecord` runs `escapeForRecord` over
the message (text) or the whole JSON object (jsonl), which writes CR and LF as `\r`/`\n`,
every other C0 control but TAB, DEL and C1 as `\u00XX`, and U+2028, U+2029 and the bidi
controls as `\uXXXX`, so no text that reaches a record, by whatever path, can split it,
forge another one or steer the terminal. The areas are `cli` (usage errors, commander's messages, validation errors such
as an ambiguous station name, unexpected errors), `api` (the API's answers, and the notes
on a filter that matched nothing or a name two stations share) and `http` (the
connection, the cleartext warning). Code logs through `logOf(deps)` and never writes
diagnostics with `io.err` directly. `run()` builds the logger from argv before commander
parses it, so commander's own usage errors are records too, and on top of the redacted
`io.err`, so a secret is kept out of the log in either format. `CliDeps.now` makes the
timestamps testable. stdout carries data only; `Output error: …` from
`handleOutputErrors`, written outside `run()`, stays a raw line. Conformance test P23
checks all of this, and its body is shared across the *-cli repos.
