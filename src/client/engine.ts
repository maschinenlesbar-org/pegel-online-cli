// The request engine: turns logical (method, path, query) calls into HTTP
// requests via a Transport, applies retry/backoff for transient statuses
// (429, 503), and decodes responses.

import { TextDecoder } from "node:util";
import {
  MAX_TIMEOUT_MS,
  nodeHttpTransport,
  sizeLimitMessage,
  type HttpRequest,
  type HttpResponse,
  type Transport,
} from "./http.js";
import { buildQueryString, type QueryParams } from "./query.js";
import {
  PegelApiError,
  PegelError,
  PegelNetworkError,
  PegelParseError,
  PegelValidationError,
  credentialsIn,
  redactCredentials,
  redactUrl,
} from "./errors.js";
import { assertValid, baseUrlProblem, headerValueProblem, knownKeysProblem } from "./validate.js";

export const DEFAULT_BASE_URL = "https://www.pegelonline.wsv.de";
const DEFAULT_USER_AGENT = "pegel-online-cli";

export interface RawResponse {
  data: Buffer;
  contentType: string;
  status: number;
}

/**
 * Options for {@link RequestEngine} and the client. The numeric options must be
 * integers within their documented range; anything else (negative, fractional,
 * NaN, Infinity, too large) makes the constructor throw a PegelValidationError, as
 * does a `transport` or `sleep` that is not a function and a `headers` value an HTTP
 * header can't carry.
 */
export interface EngineOptions {
  /** Base URL of the API. Defaults to https://www.pegelonline.wsv.de */
  baseUrl?: string;
  /** Swappable transport. Defaults to the built-in node http/https transport. */
  transport?: Transport;
  /** Value of the User-Agent header. */
  userAgent?: string;
  /**
   * Extra headers sent on every request. Credential-bearing headers
   * (Authorization, Cookie, X-API-Key, Proxy-Authorization) are automatically
   * stripped when a redirect crosses to a different origin, so they never leak to
   * an arbitrary host named in Location. This client is keyless and sets none, but
   * library consumers may add one.
   */
  headers?: Record<string, string>;
  /**
   * Time limit per request in milliseconds, covering the whole response body, not
   * only idle gaps (0 disables; at most `MAX_TIMEOUT_MS`, 2^31 - 1 ms).
   */
  timeoutMs?: number;
  /**
   * Number of automatic retries for transient (429/503) responses and reset
   * connections (ECONNRESET, EPIPE, ECONNABORTED, undici's UND_ERR_SOCKET, anywhere in
   * the error's `cause` chain; GET and HEAD only), 0..`MAX_RETRIES` (10). Each waits
   * `retryDelayMs * attempt`, or longer when the response's `Retry-After` asks (up to
   * `MAX_RETRY_AFTER_MS`; a longer one is not retried). Timeouts are not retried.
   */
  maxRetries?: number;
  /**
   * Base backoff between retries in milliseconds (grows linearly); the floor of every
   * wait, Retry-After or not. At most `MAX_RETRY_AFTER_MS`.
   */
  retryDelayMs?: number;
  /**
   * Number of HTTP redirects (301/302/303/307/308) to follow, 0..20. Defaults to 5. Any
   * other 3xx, one with a missing or malformed Location, and one past this limit
   * surface as a PegelApiError naming the target.
   */
  maxRedirects?: number;
  /**
   * Hard cap on response body size in bytes (defends against memory exhaustion
   * from a hostile/buggy endpoint). Defaults to 100 MiB; set to 0 for no limit.
   */
  maxResponseBytes?: number;
  /** Injectable sleep, primarily for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_MAX_RESPONSE_BYTES = 100 * 1024 * 1024;

/** Most automatic retries a caller may ask for (the CLI's --max-retries shares it). */
export const MAX_RETRIES = 10;

/** Most redirects a caller may let the engine follow (the Fetch standard's limit). */
const MAX_REDIRECTS = 20;

/**
 * Read a numeric engine option: `undefined` gives the default; anything but an
 * integer in [0, max] throws. Without this a negative or NaN `timeoutMs` silently
 * disabled the timeout, and `maxRetries: NaN` silently meant no retries.
 */
function intOption(name: string, value: number | undefined, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new PegelValidationError(
      `Invalid option ${name}: expected an integer from 0 to ${max}, got ${typeof value === "number" ? String(value) : typeof value}.`,
    );
  }
  return value;
}

/** Every EngineOptions key; any other is rejected (a JavaScript `timeout` for `timeoutMs`). */
const OPTION_NAMES = [
  "baseUrl",
  "transport",
  "userAgent",
  "headers",
  "timeoutMs",
  "maxRetries",
  "retryDelayMs",
  "maxRedirects",
  "maxResponseBytes",
  "sleep",
] as const satisfies ReadonlyArray<keyof EngineOptions>;

/**
 * Read a function option: `undefined` gives the default; anything else that is not a
 * function throws. A string `transport` used to fail at the first request as a raw
 * TypeError, and a bad `sleep` on the first retry.
 */
function functionOption<F extends (...args: never[]) => unknown>(name: string, value: F | undefined, fallback: F): F {
  if (value === undefined) return fallback;
  if (typeof value !== "function") {
    throw new PegelValidationError(`Invalid option ${name}: expected a function, got ${typeof value}.`);
  }
  return value;
}

/**
 * Read the `headers` option: a plain object of header values, each one an HTTP header
 * can carry (headerValueProblem). An array or a non-string value used to reach Node as
 * an opaque TypeError at request time.
 */
function headersOption(value: Record<string, string> | undefined): Record<string, string> {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PegelValidationError(`Invalid option headers: expected an object of header values, got ${Array.isArray(value) ? "an array" : typeof value}.`);
  }
  for (const [name, header] of Object.entries(value)) {
    const reason = headerValueProblem(header);
    if (reason !== undefined) throw new PegelValidationError(`Invalid option headers: ${JSON.stringify(name)}: ${reason}`);
  }
  return { ...value };
}

/**
 * Longest server text (in characters) kept for an error message: an error `detail`, a
 * transport's error text or a redirect target. A longer one is cut and ends in "…", so a
 * hostile or buggy body cannot flood stderr or a CI log with one huge line.
 * `PegelApiError.body` keeps the full text.
 */
const MAX_DETAIL_LENGTH = 500;

/** sanitizeServerText, then cut at MAX_DETAIL_LENGTH characters. */
function cleanDetail(text: string): string {
  const clean = sanitizeServerText(text);
  return clean.length > MAX_DETAIL_LENGTH ? `${clean.slice(0, MAX_DETAIL_LENGTH)}…` : clean;
}

/**
 * The redirect statuses the engine follows. 300 (a choice for the user), 304 (a
 * cache answer to a conditional request this client never sends) and 305/306
 * (deprecated) are not redirects to follow; they surface as a PegelApiError.
 */
const FOLLOWED_REDIRECTS = new Set([301, 302, 303, 307, 308]);

/**
 * Longest `Retry-After` the engine waits out before retrying a 429/503. When the
 * server asks for longer, the engine does not retry at all and surfaces the error at
 * once, naming the requested wait (`PegelApiError.retryAfterMs`): retrying early would
 * only land inside the window the server asked us to wait out, and a hostile value must
 * not stall the CLI. A shorter `Retry-After` never makes a wait shorter than the normal
 * backoff.
 */
export const MAX_RETRY_AFTER_MS = 30_000;

/** An IMF-fixdate (RFC 9110 §5.6.7), the one HTTP-date form senders must generate. */
const IMF_FIXDATE =
  /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;

/**
 * Parse a `Retry-After` header into a delay in milliseconds (RFC 9110 §10.2.3):
 * either delay-seconds (`"120"`) or an HTTP-date (`"Wed, 21 Oct 2026 07:28:00 GMT"`,
 * turned into the time left from `now`; a date in the past gives 0).
 *
 * Returns `undefined` when the header is absent or malformed — negative (`"-1"`),
 * fractional (`"1.5"`), padded inside, any other date format — so the caller falls
 * back to its own backoff. The strict patterns matter: `Date.parse` alone would
 * read `"1.5"` as a date in 2001 and retry at once.
 */
export function parseRetryAfter(
  header: string | string[] | undefined,
  now: number = Date.now(),
): number | undefined {
  const value = (Array.isArray(header) ? header[0] : header)?.trim();
  if (value === undefined || value === "") return undefined;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  if (!IMF_FIXDATE.test(value)) return undefined;
  const when = Date.parse(value);
  return Number.isNaN(when) ? undefined : Math.max(0, when - now);
}

/** Why `value` is not a usable HttpResponse, or undefined when it is. */
function responseProblem(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return "not an object";
  const r = value as Partial<Record<"status" | "headers" | "body", unknown>>;
  if (typeof r.status !== "number" || !Number.isInteger(r.status) || r.status < 100 || r.status > 599) {
    return "status is not an HTTP status code";
  }
  if (typeof r.headers !== "object" || r.headers === null || Array.isArray(r.headers)) return "headers is not an object";
  if (bodyBytes(r.body) === undefined) return "body is not a Buffer, Uint8Array, other ArrayBuffer view or ArrayBuffer";
  return undefined;
}

/**
 * The response body as a Buffer (a view, no copy): a Buffer, any ArrayBuffer view (a
 * Uint8Array from fetch, a DataView) or an ArrayBuffer/SharedArrayBuffer — checked by
 * internal slot, not `instanceof`, so a value from another realm (a vm context, a Jest
 * test) counts. Undefined for anything else. (`Uint8Array#toString` ignores an encoding
 * argument and yields "123,34,…", which is how a fetch body used to fail to parse.)
 */
function bodyBytes(value: unknown): Buffer | undefined {
  if (Buffer.isBuffer(value)) return value;
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  const tag = Object.prototype.toString.call(value);
  if (tag === "[object ArrayBuffer]" || tag === "[object SharedArrayBuffer]") return Buffer.from(value as ArrayBuffer);
  return undefined;
}

/**
 * The response headers as a plain record with lower-case names. A transport built on
 * `fetch` naturally returns its `Headers` object, which has no plain properties, and a
 * custom one may write `Retry-After` or `Location` capitalised: the engine then saw no
 * Retry-After (and retried at once) and no Location (and failed the redirect). Such an
 * object (anything with `get` and `forEach`, a `Map` included) is copied; a plain record
 * gets its names lower-cased.
 */
function plainHeaders(headers: object): Record<string, string | string[] | undefined> {
  const h = headers as { get?: unknown; forEach?: unknown };
  if (typeof h.get === "function" && typeof h.forEach === "function") {
    const record: Record<string, string> = {};
    (h.forEach as (cb: (value: unknown, name: unknown) => void) => void).call(headers, (value, name) => {
      // Headers#forEach gives (value, name), and so does Map#forEach.
      record[String(name).toLowerCase()] = String(value);
    });
    return record;
  }
  const record: Record<string, string | string[] | undefined> = {};
  for (const [name, value] of Object.entries(headers as Record<string, string | string[] | undefined>)) {
    record[name.toLowerCase()] = value;
  }
  return record;
}

/** One header value as a string (the first of a repeated one), or undefined. */
function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Error codes of a connection that broke off mid-request: Node's (`socket hang up` is
 * ECONNRESET) and undici's (`fetch failed` with cause UND_ERR_SOCKET, "other side closed").
 */
const TRANSIENT_NETWORK_CODES = new Set(["ECONNRESET", "EPIPE", "ECONNABORTED", "UND_ERR_SOCKET"]);

/** True when `err` or an error in its `cause` chain has a transient connection code. */
function hasTransientCode(err: unknown, depth = 0): boolean {
  if (typeof err !== "object" || err === null || depth > 4) return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string" && TRANSIENT_NETWORK_CODES.has(code)) return true;
  return hasTransientCode((err as { cause?: unknown }).cause, depth + 1);
}

/**
 * True for a PegelNetworkError caused by a reset or aborted connection, which the
 * engine retries — whichever transport raised it (a Node error, fetch's TypeError with
 * an undici cause). A refused connection, a DNS failure or a timeout is not transient
 * in that sense and is not retried.
 */
export function isTransientNetworkError(err: unknown): boolean {
  return err instanceof PegelNetworkError && hasTransientCode(err.cause);
}

/**
 * Credential-bearing headers that must never be carried across an origin boundary
 * on a redirect. Stored lower-cased and compared case-insensitively so a header
 * added as `X-Api-Key` or `Authorization` is caught regardless of casing.
 */
const CREDENTIAL_HEADERS: ReadonlySet<string> = new Set([
  "authorization",
  "cookie",
  "x-api-key",
  "proxy-authorization",
]);

/**
 * Delete every credential-bearing header from `headers`, matching case-insensitively.
 * The CLI sends none today (keyless), but RequestEngine is exported as a library and
 * a keyed sibling/consumer could add one via a future headers option — keep the
 * guarantee correct regardless of the casing the caller used.
 */
function stripSensitiveHeaders(headers: Record<string, string>): boolean {
  let stripped = false;
  for (const key of Object.keys(headers)) {
    if (CREDENTIAL_HEADERS.has(key.toLowerCase())) {
      delete headers[key];
      stripped = true;
    }
  }
  return stripped;
}

/** True when `a` and `b` parse and share scheme, host and port; false otherwise. */
function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

/**
 * Why a 401/403 after a redirect to another origin may not be the credentials' fault:
 * the engine did not send them there. An http->https upgrade on the same host gets its
 * own advice.
 */
function credentialsDroppedHint(from: URL, to: URL): string {
  if (from.protocol === "http:" && to.protocol === "https:" && from.hostname === to.hostname) {
    return "the server redirected http to https, so the credentials were not sent there; use an https base URL";
  }
  return `the server redirected to another origin (${to.origin}), so the credentials were not sent there; use that origin as the base URL if it should get them`;
}

/**
 * Strip control characters (all C0/C1 controls except tab and newline, plus DEL)
 * out of a string that originates in an attacker-controlled response — the error
 * `detail`. `JSON.parse` decodes an escaped ESC in an error body into a real ESC
 * byte, so without this a hostile or MITM'd endpoint
 * could drive ANSI/OSC escape sequences into the user's terminal once the message
 * is printed raw to stderr (title spoofing, output overwrite, OSC 52 clipboard).
 * The CLI's JSON output is escaped separately (`escapeControlChars` in
 * cli/shared.ts): `JSON.stringify` alone leaves DEL and the C1 range raw.
 */
function sanitizeServerText(text: string): string {
  let out = "";
  for (const ch of text) {
    const n = ch.codePointAt(0) ?? 0;
    if (n <= 8 || (n >= 0x0b && n <= 0x1f) || (n >= 0x7f && n <= 0x9f)) continue;
    out += ch;
  }
  return out;
}

/**
 * Check a base URL against the library's rules (baseUrlProblem: no whitespace or
 * control characters, an absolute http(s) URL, no query or fragment) and return it
 * without trailing slashes. Throws PegelValidationError `Invalid baseUrl: …`: a
 * configuration mistake, not a PegelNetworkError. The RequestEngine constructor
 * calls it on the raw value, so a custom transport never sees a bad base URL; the
 * default transport still re-checks the scheme on every hop.
 */
export function validateBaseUrl(raw: string): string {
  return assertValid("baseUrl", raw, baseUrlProblem).replace(/\/+$/, "");
}

/** True for a loopback host: `localhost`, 127.0.0.0/8 or `::1` (as URL#hostname spells it). */
function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "[::1]" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
}

/**
 * Whether requests to `baseUrl` would travel unencrypted, as one sentence for a
 * warning (no prefix), or `undefined` when they would not: for
 * `https:`, for a URL that does not parse, and for a loopback host (`localhost`,
 * 127.0.0.0/8, `::1`), where nothing leaves the machine.
 *
 * The sentence names the host (`url.host`: host and port, never the userinfo) and what
 * secret travels with the requests: the base URL's credentials when it carries
 * userinfo, and every phrase in `secrets` (noun phrases such as "the API key"). It
 * never contains a password or key. The CLI logs it once per run as a
 * `WARN` record of `pegel.http` on stderr.
 */
export function cleartextProblem(baseUrl: string, secrets: readonly string[] = []): string | undefined {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" || isLoopbackHost(url.hostname)) return undefined;
  const userinfo = url.username !== "" || url.password !== "";
  const phrases = [...secrets, ...(userinfo ? ["the base URL's credentials"] : [])];
  if (phrases.length === 0) return `requests to ${url.host} are sent unencrypted (http:, not https:)`;
  const verb = phrases.length === 1 && !userinfo ? "is" : "are";
  return `${phrases.join(" and ")} ${verb} sent unencrypted to ${url.host} (http:, not https:)`;
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class RequestEngine {
  // Real private fields (not TypeScript's `private`): util.inspect, console.log and
  // JSON.stringify of a client never show them, so a password in the base URL, or an
  // Authorization header a caller added, can't be logged by accident. Messages show the
  // base URL through redactUrl.
  readonly #baseUrl: string;
  /** The base URL's userinfo, raw and percent-decoded, for scrubbing server and transport text. */
  readonly #credentials: string[];
  readonly #extraHeaders: Record<string, string>;
  private readonly transport: Transport;
  private readonly userAgent: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly maxRedirects: number;
  private readonly maxResponseBytes: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: EngineOptions = {}) {
    // A JavaScript caller may pass null for "no options"; treat it like undefined.
    options = options ?? {};
    // A typo (`timeout` for `timeoutMs`) used to be ignored and the default applied.
    assertValid("options", options, knownKeysProblem(OPTION_NAMES));
    // The raw value, before the slash strip: the engine glues it into every URL, so
    // "https://h/ " must not lose its slash first and slip past the check.
    this.#baseUrl = validateBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
    this.#credentials = credentialsIn(this.#baseUrl).flatMap((raw) => {
      try {
        return [raw, decodeURIComponent(raw)];
      } catch {
        return [raw];
      }
    });
    this.transport = functionOption("transport", options.transport, nodeHttpTransport);
    // Only `undefined` selects the default. An explicit value must be one an HTTP
    // header can carry (headerValueProblem): not blank, which would replace the
    // default with an empty header, and no control character (CR/LF in particular,
    // which also closes header injection; tab is allowed) or character above U+00FF,
    // which Node would refuse late with a raw TypeError.
    this.userAgent =
      options.userAgent === undefined
        ? DEFAULT_USER_AGENT
        : assertValid("User-Agent", options.userAgent, headerValueProblem);
    this.#extraHeaders = headersOption(options.headers);
    this.timeoutMs = intOption("timeoutMs", options.timeoutMs, 30_000, MAX_TIMEOUT_MS);
    this.maxRetries = intOption("maxRetries", options.maxRetries, 2, MAX_RETRIES);
    this.retryDelayMs = intOption("retryDelayMs", options.retryDelayMs, 200, MAX_RETRY_AFTER_MS);
    this.maxRedirects = intOption("maxRedirects", options.maxRedirects, 5, MAX_REDIRECTS);
    this.maxResponseBytes = intOption(
      "maxResponseBytes",
      options.maxResponseBytes,
      DEFAULT_MAX_RESPONSE_BYTES,
      Number.MAX_SAFE_INTEGER,
    );
    this.sleep = functionOption("sleep", options.sleep, realSleep);
  }

  /**
   * Build a fully-qualified URL from a path and optional query parameters.
   *
   * Throws a PegelValidationError for a path with a "." or ".." segment. The resource methods
   * put ids into the path with `encodeURIComponent`, which leaves those two
   * unchanged, and URL parsing then resolves them: `currentMeasurement("BONN", "..")`
   * would request `/stations/currentmeasurement.json` (a station of that name).
   * Neither can name a resource. (Percent-encoded forms such as "%2e%2e" are safe:
   * encodeURIComponent turns their "%" into "%25".)
   */
  buildUrl(path: string, query?: QueryParams): string {
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    const dotSegment = normalizedPath.split("/").find((s) => s === "." || s === "..");
    if (dotSegment !== undefined) {
      throw new PegelValidationError(
        `Invalid path segment "${dotSegment}" in ${normalizedPath}: "." and ".." cannot be used as an id.`,
      );
    }
    const qs = query ? buildQueryString(query) : "";
    return `${this.#baseUrl}${normalizedPath}${qs ? `?${qs}` : ""}`;
  }

  /**
   * `text` without the base URL's credentials: server text (an error body that echoes
   * the request URL) and transport text (fetch's "Failed to fetch <url>") can carry them.
   */
  private scrub(text: string): string {
    return this.#credentials.length === 0 ? text : redactCredentials(text, this.#credentials);
  }

  /**
   * A transport failure as the `cause` of the error the engine raises: the original
   * when its text carries no credentials, otherwise a copy with them scrubbed (message,
   * `code` and the cause chain kept), so logging the error with its causes can't reveal
   * the base URL's password.
   */
  private scrubCause(cause: unknown, depth = 0): unknown {
    if (this.#credentials.length === 0 || depth > 5) return cause;
    if (typeof cause === "string") return this.scrub(cause);
    if (!(cause instanceof Error)) return cause;
    const inner = this.scrubCause(cause.cause, depth + 1);
    const message = this.scrub(cause.message);
    if (message === cause.message && inner === cause.cause && !this.scrub(cause.stack ?? "").includes("***@")) return cause;
    const copy = new Error(message, inner === undefined ? undefined : { cause: inner });
    copy.name = cause.name;
    const code = (cause as { code?: unknown }).code;
    if (code !== undefined) Object.assign(copy, { code });
    return copy;
  }

  /**
   * Call the transport under the overall deadline (`timeoutMs`): the request gets an
   * AbortSignal that fires at the deadline, and the call rejects then whether the
   * transport stops or not — a custom transport (fetch, a node:http wrapper) that
   * ignores `timeoutMs` can't hang the caller. A synchronous throw becomes a rejection.
   */
  private async callTransport(request: HttpRequest): Promise<HttpResponse> {
    const call = (signal?: AbortSignal): Promise<HttpResponse> =>
      Promise.resolve().then(() => this.transport(signal === undefined ? request : { ...request, signal }));
    if (this.timeoutMs === 0) return call();
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const err = new PegelNetworkError(`Request timed out after ${this.timeoutMs}ms`);
        controller.abort(err);
        reject(err);
      }, this.timeoutMs);
      timer.unref?.();
    });
    try {
      return await Promise.race([call(controller.signal), deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Perform a request with Accept negotiation and transient-error retries. */
  async request(
    method: string,
    path: string,
    options: { query?: QueryParams; accept: string } = { accept: "application/json" },
  ): Promise<RawResponse> {
    let url = this.buildUrl(path, options.query);
    const headers: Record<string, string> = {
      ...this.#extraHeaders,
      Accept: options.accept,
      "User-Agent": this.userAgent,
    };

    // Only an idempotent request is sent again after a reset: request() is public, and
    // a POST re-sent after a broken connection may be applied twice. The client itself
    // sends GETs only.
    const idempotent = /^(GET|HEAD)$/i.test(method);
    let attempt = 0;
    let redirects = 0;
    /** Where a redirect to another origin dropped the credentials, for the 401/403 hint. */
    let droppedCredentialsAt: { from: URL; to: URL } | undefined;
    // attempts = initial try + maxRetries (redirects are counted separately)
    for (;;) {
      let response: HttpResponse;
      try {
        response = await this.callTransport({
          method,
          url,
          headers,
          redirect: "manual",
          timeoutMs: this.timeoutMs,
          ...(this.maxResponseBytes > 0 ? { maxResponseBytes: this.maxResponseBytes } : {}),
        });
      } catch (cause) {
        // A connection the server (or a gateway) reset is the network-level twin of a
        // 503: retry the GET, whichever transport reported it. Timeouts are not retried
        // — a slow upstream should not be asked again at once.
        if (idempotent && hasTransientCode(cause) && attempt < this.maxRetries) {
          attempt += 1;
          await this.sleep(this.retryDelayMs * attempt);
          continue;
        }
        // The default transport rejects with PegelNetworkError only; an injected one may
        // throw anything (a string, a TypeError, null). Keep the error contract for both:
        // every failure is a PegelError. The message names the request — Node's text
        // ("socket hang up") says nothing about which host or gauge failed — and the
        // original is the `cause`. Any other PegelError passes through.
        if (cause instanceof PegelError && !(cause instanceof PegelNetworkError)) throw cause;
        const reason = cause instanceof Error ? cause.message : String(cause);
        const retried = attempt > 0 ? ` (after ${attempt} ${attempt === 1 ? "retry" : "retries"})` : "";
        throw new PegelNetworkError(
          `${method} ${redactUrl(url)} failed: ${cleanDetail(this.scrub(reason))}${retried}`,
          { cause: this.scrubCause(cause) },
        );
      }

      // An injected transport may resolve with anything; a malformed HttpResponse would
      // otherwise surface below as a raw TypeError, outside the PegelError contract.
      const invalid = responseProblem(response);
      if (invalid !== undefined) {
        throw new PegelNetworkError(
          `${method} ${redactUrl(url)} failed: the transport returned an invalid response (${invalid}).`,
        );
      }
      // Transports must not follow redirects (HttpRequest.redirect is "manual"); fetch does
      // by default. One that reports a final URL on another origin has carried the
      // request — and maybe a credential header fetch doesn't strip — somewhere the
      // engine never vetted, so its answer is not trusted.
      const finalUrl = (response as { url?: unknown }).url;
      if (typeof finalUrl === "string" && finalUrl !== "" && !sameOrigin(finalUrl, url)) {
        throw new PegelNetworkError(
          `${method} ${redactUrl(url)} failed: the transport followed a redirect to another origin ` +
            `(${cleanDetail(redactUrl(finalUrl))}); a transport must not follow redirects (HttpRequest.redirect is "manual").`,
        );
      }
      const status = response.status;
      const responseHeaders = plainHeaders(response.headers);
      const body = bodyBytes(response.body) as Buffer;
      // The size cap holds whatever the transport did: the default one aborts early, a
      // custom one may have read everything.
      if (this.maxResponseBytes > 0 && body.byteLength > this.maxResponseBytes) {
        throw new PegelNetworkError(`${method} ${redactUrl(url)} failed: ${sizeLimitMessage(this.maxResponseBytes)}`);
      }

      const retryable = status === 429 || status === 503;
      // A Retry-After beyond MAX_RETRY_AFTER_MS is not retried: the error below surfaces
      // at once and names the wait the server asked for.
      let refusedWaitMs: number | undefined;
      if (retryable && attempt < this.maxRetries) {
        // Back off linearly (retryDelayMs × attempt). A Retry-After can make the wait
        // longer, never shorter: `Retry-After: 0` or a date in the past used to turn the
        // retries into a zero-delay burst against a server that had just asked for less.
        const retryAfter = parseRetryAfter(responseHeaders["retry-after"]);
        if (retryAfter === undefined || retryAfter <= MAX_RETRY_AFTER_MS) {
          attempt += 1;
          const backoff = this.retryDelayMs * attempt;
          await this.sleep(retryAfter === undefined ? backoff : Math.max(retryAfter, backoff));
          continue;
        }
        refusedWaitMs = retryAfter;
      }

      // Follow redirects, resolving the Location relative to the current URL.
      const location = headerValue(responseHeaders["location"]);
      const next = FOLLOWED_REDIRECTS.has(status) ? resolveLocation(location, url) : undefined;
      if (next !== undefined && redirects >= this.maxRedirects) {
        // A loop (or a long chain): say how far it got rather than a bare 3xx.
        // (With maxRedirects 0 nothing was followed; the plain text says enough.)
        throw this.toApiError(method, url, status, body, location, redirects || undefined);
      }
      if (next !== undefined) {
        const current = new URL(url);
        if (next.origin !== current.origin) {
          // Security: never carry credentials across an origin boundary — neither
          // credential-bearing headers (a caller's Authorization/Cookie/X-Api-Key) nor
          // the base URL's userinfo, which an absolute Location to another host doesn't
          // carry. Comparing full origin (scheme + host + port) also covers a same-host
          // https->http downgrade and an http->https upgrade.
          if (stripSensitiveHeaders(headers) || current.username !== "" || current.password !== "") {
            droppedCredentialsAt = { from: current, to: next };
          }
        } else if (next.username === "" && next.password === "") {
          // Same origin: keep the base URL's userinfo. A relative Location inherits it
          // when resolved; an absolute one (`Location: https://same-host/…`) used to
          // drop it and turn a mirror login into a 401.
          next.username = current.username;
          next.password = current.password;
        }
        url = next.toString();
        redirects += 1;
        continue;
      }
      // Any other 3xx — not a followed status, or no usable Location — falls
      // through and surfaces as a PegelApiError naming the target.

      const contentType = String(headerValue(responseHeaders["content-type"]) ?? "");
      if (status < 200 || status >= 300) {
        const hint =
          (status === 401 || status === 403) && droppedCredentialsAt !== undefined
            ? credentialsDroppedHint(droppedCredentialsAt.from, droppedCredentialsAt.to)
            : undefined;
        throw this.toApiError(method, url, status, body, location, undefined, refusedWaitMs, hint);
      }

      return { data: body, contentType, status };
    }
  }

  /** Perform a GET expecting JSON and parse it into `T`. */
  async getJson<T>(path: string, query?: QueryParams): Promise<T> {
    const res = await this.request("GET", path, { query, accept: "application/json" });
    const text = decodeBody(res.data, res.contentType, path);
    try {
      return JSON.parse(text) as T;
    } catch (cause) {
      throw new PegelParseError(`Failed to parse JSON response from ${path}`, { cause });
    }
  }

  private toApiError(
    method: string,
    url: string,
    status: number,
    body: Buffer,
    locationHeader?: string,
    redirectsFollowed?: number,
    retryAfterMs?: number,
    hint?: string,
  ): PegelApiError {
    const text = this.scrub(body.toString("utf8"));
    let detail: string | undefined;
    try {
      const parsed = JSON.parse(text) as { detail?: unknown; message?: unknown };
      if (parsed && typeof parsed.detail === "string") detail = parsed.detail;
      else if (parsed && typeof parsed.message === "string") detail = parsed.message;
    } catch {
      // Non-JSON error body; leave detail undefined.
    }
    // `detail` came from the response body; strip control characters so a hostile
    // endpoint cannot inject terminal escape sequences via the stderr error message.
    if (detail !== undefined) detail = cleanDetail(detail);
    // Name the target of a redirect that was not followed.
    const location =
      status >= 300 && status < 400 && locationHeader ? redirectTarget(url, locationHeader) : undefined;
    return new PegelApiError({
      status,
      url,
      method,
      body: text,
      detail,
      ...(location !== undefined ? { location } : {}),
      ...(redirectsFollowed !== undefined ? { redirectsFollowed } : {}),
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      ...(hint !== undefined ? { hint } : {}),
    });
  }
}

/**
 * Decode a response body by the charset its Content-Type names (UTF-8 when it names
 * none). A proxy or mirror that answers in ISO-8859-1 used to come out as "K\uFFFDLN"
 * with exit 0. TextDecoder also drops a leading byte order mark, which
 * Buffer#toString keeps and JSON.parse then rejects. An unknown charset label is a
 * PegelParseError.
 */
function decodeBody(body: Buffer, contentType: string, path: string): string {
  const charset = /;\s*charset\s*=\s*"?([^";\s]+)"?/i.exec(contentType)?.[1] ?? "utf-8";
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(charset);
  } catch {
    throw new PegelParseError(`Unsupported response charset "${sanitizeServerText(charset)}" from ${path}.`);
  }
  return decoder.decode(body);
}

/**
 * Resolve a Location header against the current URL; undefined if missing, malformed
 * or not http(s). A `file:`, `data:` or `javascript:` target is refused here, before
 * any transport sees it (the default transport would refuse it too; a custom one may
 * not), and surfaces as a PegelApiError naming the target.
 */
function resolveLocation(location: string | undefined, base: string): URL | undefined {
  if (location === undefined || location === "") return undefined;
  try {
    const next = new URL(location, base);
    return next.protocol === "http:" || next.protocol === "https:" ? next : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The absolute, printable form of a `Location` header: resolved against the request
 * URL, userinfo redacted, control characters stripped (it is server text bound for
 * stderr). An unparseable value is shown sanitised as it came.
 */
function redirectTarget(requestUrl: string, location: string): string | undefined {
  const resolved = resolveLocation(location, requestUrl);
  const clean = cleanDetail(resolved ? redactUrl(resolved.href) : location).trim();
  return clean === "" ? undefined : clean;
}
