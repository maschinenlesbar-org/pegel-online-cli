# pegel-online-cli — Exploratory / black-box bug report

**Environment**

- Date: 2026-06-06
- macOS (Darwin 25.5.0), Node from project (`engines: >=20`), zsh.
- Build: `npm run build` succeeded with no errors.
- Invocation: `node dist/src/cli/index.js ...`
- **Live PEGELONLINE API was reachable** throughout (`https://www.pegelonline.wsv.de`). All
  "live" repros below hit the real public API. Numbers (e.g. the 786 total stations, BONN
  values) are time-dependent; re-running on another day may shift exact values but the
  *behaviour* reproduces.
- Cross-checked CLI output against raw `curl` and against a local capture server
  (`http.createServer` printing `req.url`) to confirm exactly what the CLI sends.

**How many are real:** All 21 issues below were reproduced live. This exceeds the requested 20.

---

## HIGH severity

### 1. `--bbox` filter is silently ignored — returns every station
- **Severity:** High · **Confidence:** High
- **Repro:**
  ```
  node dist/src/cli/index.js --compact stations list --bbox 50.5,51.0,6.5,7.5 | jq 'length'
  node dist/src/cli/index.js --compact stations list | jq 'length'
  ```
- **Expected:** Only stations inside the bounding box (a small subset).
- **Actual:** Both return `786` — the full station set. Sample rows from the "bbox" result
  include `52.622706,10.062164,CELLE` (well outside `lat 50.5..51.0, lng 6.5..7.5`).
  exit=0.
- **Root cause:** The client sends `latbottom/lattop/longleft/longright`
  (`src/client/client.ts:54-57`), but the live v2 API does **not** honour those parameter
  names — confirmed by raw curl:
  `curl ".../stations.json?latbottom=50.5&lattop=51.0&longleft=6.5&longright=7.5" | jq length`
  also returns `786`. The README (line 86) advertises this exact command as working.
  Either the param names are wrong or the feature is unsupported; either way the documented
  feature does nothing and silently returns wrong/too-broad data. (`src/cli/commands/stations.ts:72-84`)

### 2. `--longname` filter is silently ignored — returns every station
- **Severity:** High · **Confidence:** High
- **Repro:**
  ```
  node dist/src/cli/index.js --compact stations list --longname BONN | jq 'length'
  ```
- **Expected:** Per README line 59/68, "filter by (substring of) longname" → only matching
  stations (BONN-ish).
- **Actual:** Returns `786` (all stations). `--longname KÖLN` also returns 786.
- **Root cause:** `longname` is sent (`src/client/client.ts:51`) but the live API ignores it
  — raw curl `.../stations.json?longname=BONN` returns 786 and the first rows are
  CELLE/MARKLENDORF/AHLDEN. Documented filter is non-functional.

### 3. `--agency` filter is silently ignored — returns every station
- **Severity:** High · **Confidence:** High
- **Repro:**
  ```
  curl -s ".../stations.json?agency=STANDORT%20K%C3%96LN" | jq length     # 786
  ```
  (driven through the same code path as `stations list --agency "STANDORT KÖLN"`)
- **Expected:** Only stations for that agency.
- **Actual:** `786` (all). `agency` is documented (README line 59) and sent
  (`src/client/client.ts:52`) but the live API does not filter on it.
- **Note:** `--waters`, `--ids`, `--fuzzy-id` DO filter (RHEIN→36, ids/fuzzyId→1), which
  proves the CLI does send query params correctly; bugs 1–3 are specifically the
  unsupported/mis-named filters being presented as working features.

---

## MEDIUM severity

### 4. Empty `[timeseries]` positional is not defaulted to `W`
- **Severity:** Medium · **Confidence:** High
- **Repro:**
  ```
  node dist/src/cli/index.js timeseries BONN ""
  ```
- **Expected:** Per docs "timeseries defaults to W"; an empty arg should behave like omitting it.
- **Actual:**
  ```
  Error: HTTP 404 for GET .../stations/BONN/.json: Timeseries does not exist.
  ```
  exit=4. (Also `current BONN ""` → `.../stations/BONN//currentmeasurement.json`.)
- **Root cause:** `ts ?? "W"` uses nullish-coalescing, so `""` (not nullish) is passed
  through. Should be `ts || "W"`. (`src/cli/commands/timeseries.ts:11,21,34,47`)

### 5. `--start ""` / `--end ""` send empty query params instead of omitting them
- **Severity:** Medium · **Confidence:** High
- **Repro (local capture server):**
  ```
  node dist/src/cli/index.js --base-url http://127.0.0.1:PORT measurements BONN W --start ""
  # captured: URL=/webservices/rest-api/v2/stations/BONN/W/measurements.json?start=
  node ... measurements BONN W --start P3D --end ""
  # captured: ...measurements.json?start=P3D&end=
  ```
- **Expected:** An empty option value should be omitted (no `start=`/`end=`), the same as
  not passing the flag.
- **Actual:** Sends a literal `start=` / `end=` with empty value. Happens to be tolerated by
  this API, but it is malformed request construction and would break a stricter endpoint.
- **Root cause:** `prune()` / `toEngineOptions()` only drop `undefined`, never empty strings
  (`src/client/client.ts:27-33,95`; `src/cli/commands/timeseries.ts:34-37`).

### 6. `--timeout ""` (empty string) silently becomes `0` (= timeout disabled)
- **Severity:** Medium · **Confidence:** High
- **Repro:**
  ```
  node dist/src/cli/index.js --timeout "" waters    # exit 0, runs with no timeout
  ```
- **Expected:** Empty/blank numeric argument is invalid → usage error
  ("Expected a non-negative integer").
- **Actual:** Accepted. `Number("") === 0`, `Number.isInteger(0)` is true, `0 < 0` false →
  passes validation and disables the timeout (a 0 timeout means "no timeout" in the engine).
- **Root cause:** `parseIntArg` uses `Number(value)` which coerces `""` and whitespace to 0
  (`src/cli/shared.ts:10-16`).

### 7. `--max-retries " "` (whitespace) silently becomes `0`
- **Severity:** Medium · **Confidence:** High
- **Repro:**
  ```
  node dist/src/cli/index.js --max-retries " " waters   # exit 0
  ```
- **Expected:** Reject as non-integer.
- **Actual:** Accepted; `Number(" ") === 0`. Same root cause as #6 — affects every numeric
  flag (`--timeout`, `--max-retries`, `--max-response-bytes`). A user typo of a blank value
  silently changes behaviour instead of erroring. (`src/cli/shared.ts:10-16`)

### 8. Numeric flags accept hexadecimal/scientific strings
- **Severity:** Medium · **Confidence:** High
- **Repro:**
  ```
  node dist/src/cli/index.js --timeout 0x10 waters   # -> "Request timed out after 16ms"
  node dist/src/cli/index.js --timeout 1e3 waters    # -> treated as 1000
  ```
- **Expected:** `--timeout <ms>` documents an integer; `0x10`/`1e3` should be rejected as not
  a plain decimal integer (or at least be unambiguous).
- **Actual:** `Number("0x10")=16`, `Number("1e3")=1000` both pass `Number.isInteger`, so the
  flag silently accepts surprising encodings. (`src/cli/shared.ts:10-16`)

### 9. `--ids` repeated flags are comma-joined into one param, contradicting documented array serialization
- **Severity:** Medium · **Confidence:** High
- **Repro (capture):**
  ```
  node ... stations list --ids BONN --ids KÖLN
  # captured: /stations.json?ids=BONN%2CK%C3%96LN     (single ids= param, comma-joined)
  ```
- **Expected:** `src/client/query.ts:2-4` and its doc-comment promise arrays serialise as
  repeated keys (`?id=a&id=b`); a value containing a comma would otherwise be ambiguous.
- **Actual:** `StationsResource.list` pre-joins ids with `","` (`src/client/client.ts:49`),
  so any id legitimately containing a comma is corrupted, and the array-serialization
  contract is bypassed. `--ids "A,B"` and `--ids A --ids B` become indistinguishable.

### 10. `--bbox` accepts hexadecimal coordinates
- **Severity:** Medium · **Confidence:** High
- **Repro:**
  ```
  node dist/src/cli/index.js stations list --bbox 0x10,50,3,4   # exit 0, treated as lat 16
  ```
- **Expected:** Coordinates should be decimal numbers; `0x10` should be rejected.
- **Actual:** `Number("0x10")=16` passes the finite/range checks, so a malformed coordinate
  is silently accepted as 16. (`src/cli/commands/stations.ts:23`)

---

## LOW severity

### 11. CRLF in `--user-agent` produces an uncaught "Unexpected error"
- **Severity:** Low · **Confidence:** High
- **Repro:**
  ```
  node dist/src/cli/index.js --user-agent "$(printf 'x\r\nX-Inject: 1')" waters
  ```
- **Expected:** A clean, typed `Error:` (the value is rejected, which is correct), routed like
  other errors.
- **Actual:**
  ```
  Unexpected error: Invalid character in header content ["User-Agent"]
  ```
  exit=1. Node's raw `TypeError` from header validation leaks through the generic fallback in
  `run.ts:46`; not wrapped as a `PegelError`/`PegelNetworkError`. Good news: header injection
  is prevented; bad news: the "Unexpected error" channel signals an unhandled case.
- **Root cause:** header set in `src/client/engine.ts:84-87`, no validation before
  `driver.request`; `src/cli/run.ts:46`.

### 12. Float values lose their decimal form vs the raw API (`1320.0` → `1320`)
- **Severity:** Low · **Confidence:** High
- **Repro:**
  ```
  node ... --compact measurements BONN W --start 2026-06-05T00:00:00Z --end 2026-06-05T01:00:00Z
  # CLI: {"timestamp":"...","value":187}
  curl ".../measurements.json?start=...&end=..."
  # API: { "value": 187.0 }
  ```
- **Expected:** Faithful pass-through of the API JSON.
- **Actual:** `JSON.parse`→`JSON.stringify` round-trip collapses `187.0`/`1320.0`/`142.0` to
  integers. Numerically identical, but the float type signal (cm vs measured value) is lost,
  and output is not byte-faithful to the source. (`src/client/engine.ts:139-141`,
  `src/cli/shared.ts:39-42`)

### 13. `..` and `/` in `<station>` are passed toward the path largely unencoded
- **Severity:** Low · **Confidence:** High
- **Repro:**
  ```
  node dist/src/cli/index.js current ..
  # -> .../stations/../W/currentmeasurement.json   (".." not percent-encoded)
  node dist/src/cli/index.js current "A/B"
  # -> .../stations/A%2FB/...   ("/" encoded, OK)
  ```
- **Expected:** A path segment should be fully normalised/encoded so it cannot alter the URL
  path structure.
- **Actual:** `encodeURIComponent` does not encode `.`/`..`, so `current ..` yields a
  literal `/../` segment in the URL. The live server happens to 404, but a path-traversal-ish
  segment reaching the URL is fragile. (`src/client/client.ts:24,82`)

### 14. Empty `<station>` is sent to the API instead of being a usage error
- **Severity:** Low · **Confidence:** High
- **Repro:**
  ```
  node dist/src/cli/index.js current ""
  # -> .../stations//W/currentmeasurement.json , exit 4
  ```
- **Expected:** An empty required positional should be rejected as a usage error (exit for
  bad usage), not turned into a request with a missing path segment.
- **Actual:** Builds `stations//W/...` and round-trips a 404. No client-side validation of
  empty station/timeseries. (`src/cli/commands/timeseries.ts`, `src/cli/commands/stations.ts`)

### 15. All usage errors collapse to exit code 1 (no distinct usage exit code)
- **Severity:** Low · **Confidence:** High
- **Repro:**
  ```
  node dist/src/cli/index.js frobnicate;        echo $?   # 1
  node dist/src/cli/index.js --nonsense waters;  echo $?   # 1
  node dist/src/cli/index.js timeseries;         echo $?   # 1 (missing required arg)
  node dist/src/cli/index.js;                    echo $?   # 1 (no args)
  ```
- **Expected:** README line 92 says "non-zero for usage errors" while implying generic errors
  are also `1`; scripts can't distinguish a usage mistake from a runtime/network failure.
- **Actual:** Usage errors, network errors, and parse errors all share exit `1`; only a 404
  is distinguishable (exit `4`). commander's default usage exit code (normally `1`) is passed
  through verbatim. (`src/cli/run.ts:33-44`)

### 16. `--max-response-bytes` accepts values beyond `2^53`, losing precision
- **Severity:** Low · **Confidence:** High
- **Repro:**
  ```
  node dist/src/cli/index.js --max-response-bytes 99999999999999999999 waters   # exit 0
  ```
- **Expected:** Reject values that cannot be represented exactly as an integer.
- **Actual:** `Number("99999999999999999999")` is `1e20`; `Number.isInteger` returns `true`
  for it, so it passes and the actual cap is a silently-different float. (`src/cli/shared.ts:10-16`)

### 17. No-args invocation prints help to **stderr** and exits 1
- **Severity:** Low · **Confidence:** High
- **Repro:**
  ```
  node dist/src/cli/index.js >/tmp/o 2>/tmp/e; echo $?   # 1; /tmp/o empty, /tmp/e has help
  ```
- **Expected:** Either help-on-stdout exit 0 (typical for "show help when no command"), or a
  clearly-documented usage exit. Here the bare invocation behaves like an error.
- **Actual:** Full help text goes to stderr, exit 1. Inconsistent with `--help` (stdout,
  exit 0). (`src/cli/run.ts:17-21,32-34`)

### 18. Leading-dash station requires `--` but the help never says so
- **Severity:** Low · **Confidence:** High
- **Repro:**
  ```
  node dist/src/cli/index.js current -BONN      # error: unknown option '-BONN', exit 1
  node dist/src/cli/index.js current -- -BONN   # works (404), exit 4
  ```
- **Expected:** Some hint that station identifiers beginning with `-` need `--`. Real WSV
  station shortnames don't start with `-`, but the failure mode is opaque.
- **Actual:** A station argument starting with `-` is parsed as an unknown option with no
  guidance toward `--`. (commander default; no custom handling)

### 19. Surrounding whitespace in `--bbox` is silently accepted
- **Severity:** Low · **Confidence:** High
- **Repro:**
  ```
  node dist/src/cli/index.js stations list --bbox " 1,2,3,4 "   # exit 0
  ```
- **Expected:** Arguably fine, but it is inconsistent with how an inner empty field
  (`1,,3,4`) is treated as a hard error — leading/trailing whitespace is `.trim()`-ed away
  while empty inner fields are rejected, so the validation rules are uneven.
- **Actual:** Outer spaces accepted, inner empties rejected. (`src/cli/commands/stations.ts:18,23`)

### 20. Global flags accepted *after* the command despite README saying they must come first
- **Severity:** Low · **Confidence:** High
- **Repro:**
  ```
  node dist/src/cli/index.js stations get BONN --compact   # works, compact output
  ```
- **Expected:** README line 54: "Global options go **before** the command." A user reading
  the docs and a user relying on the lenient behaviour will disagree about what's valid.
- **Actual:** commander's `optsWithGlobals()` resolves the global flag positioned after the
  command, so it works — contradicting the documented contract. (Not harmful; doc/behaviour
  mismatch.) (`src/cli/shared.ts:66`)

### 21. `--end` without `--start` is accepted and returns data (undocumented combination)
- **Severity:** Low · **Confidence:** Medium
- **Repro:**
  ```
  node dist/src/cli/index.js measurements BONN W --end 2026-06-01T00:00:00Z   # exit 0, returns rows
  ```
- **Expected:** README only documents `--start <iso|P7D> [--end <iso>]`; `--end` alone is not
  described. Behaviour is server-defined and unvalidated client-side.
- **Actual:** Sends `?end=...` with no `start`; the server applies its own default window.
  Works, but the meaning is undocumented and silently server-dependent.
  (`src/cli/commands/timeseries.ts:34-37`)

---

## Things that worked correctly (probed, not bugs)

- 404 → exit **4** confirmed (`stations get DOES-NOT-EXIST`, `current CELLE Q`).
- `--bbox` structural validation is solid: 3 fields, 5 fields, `1,,3,4`, `NaN`, reversed
  min/max, out-of-range lat/long, non-numeric, `Infinity` all rejected with clear messages.
- Network failures map cleanly to exit 1 with typed messages: closed port
  (`ECONNREFUSED`), bad host (`ENOTFOUND`), `--timeout 1` (timeout), `--max-response-bytes 1`
  (size cap), `ftp:`/`file:` base-url (unsupported protocol guard).
- Trailing slash on `--base-url` and a path-prefix base-url (`/myproxy`) are both handled
  correctly.
- JSON parse failure on a 200 non-JSON body → clean `Error: Failed to parse JSON...`, exit 1.
- Errors go to stderr, data to stdout; `--help`/`--version` exit 0; `--waters RHEIN` filters
  to 36; `--ids`/`--fuzzy-id` filter to 1; `-- -BONN` escape works.

---

**Total real, reproduced bugs: 21** (3 High, 7 Medium, 11 Low).
