// Error types raised by the client. Kept free of any I/O so they are trivial to
// construct in tests and to `instanceof`-check by consumers.

import type { StationChoice } from "./types.js";

/**
 * `text` cut to at most `max` UTF-16 units, never inside a surrogate pair: when the cut
 * would land after a high surrogate it is made one unit earlier, so a message that holds
 * the cut text is well-formed (a lone `\ud83d` makes jq reject a whole JSON stream).
 * Text no longer than `max` is returned as it is; the caller marks a cut.
 */
export function cutText(text: string, max: number): string {
  if (text.length <= max) return text;
  const end = max > 0 && isHighSurrogate(text.charCodeAt(max - 1)) ? max - 1 : max;
  return text.slice(0, end);
}

/**
 * The longest value (in characters) an own message quotes from a server answer or from
 * the user's input: a station name, a key, a charset. A longer one is cut (`cutText`)
 * and ends in "…", so a library caller's `err.message` stays bounded too.
 */
export const MAX_QUOTED_LENGTH = 200;

/** `text` cut to `max` characters (default `MAX_QUOTED_LENGTH`), a cut marked with "…". */
export function cutForMessage(text: string, max = MAX_QUOTED_LENGTH): string {
  const cut = cutText(text, max);
  return cut.length < text.length ? `${cut}…` : text;
}

/** True for a character server text in a message never carries: C0, DEL, C1, U+2028/2029 and the bidi controls. */
function droppedFromServerText(n: number): boolean {
  return (
    n < 0x20 || (n >= 0x7f && n <= 0x9f) || n === 0x2028 || n === 0x2029 ||
    n === 0x061c || n === 0x200e || n === 0x200f || (n >= 0x202a && n <= 0x202e) || (n >= 0x2066 && n <= 0x2069)
  );
}

/**
 * Server text that one of the library's own messages quotes — a station's shortname,
 * water, number or uuid in the ambiguous-station message — made safe and short: white
 * space (line breaks, tabs, U+2028/U+2029 included) folded to one space, so it stays on
 * one line and cannot forge a log record; the other control characters (C0, DEL, C1: ESC
 * and the 8-bit CSI would steer a terminal) and the bidi controls dropped; trimmed and cut
 * at `max` characters (`MAX_QUOTED_LENGTH`, 200). The data the text came from is kept
 * as the server sent it.
 */
export function serverTextForMessage(text: string, max = MAX_QUOTED_LENGTH): string {
  let clean = "";
  for (const ch of text.replace(/\s+/g, " ")) {
    if (!droppedFromServerText(ch.codePointAt(0) ?? 0)) clean += ch;
  }
  return cutForMessage(clean.trim(), max);
}

function isHighSurrogate(c: number): boolean {
  return c >= 0xd800 && c <= 0xdbff;
}

/**
 * `text` with every lone surrogate (half of a character) replaced by U+FFFD, like
 * `String.prototype.toWellFormed` (ES2024, so not in this package's `lib`).
 */
export function toWellFormed(text: string): string {
  return text.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "\ufffd");
}

/** Base class for every error originating from this client. */
export class PegelError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/**
 * Replace the userinfo of a URL (`https://user:secret@host/...`) with `***`, so a
 * credential in a base URL never reaches an error message, a log or CI output.
 * A value that does not parse as a URL (a port typo, an unencoded "#" in the
 * password) or has no scheme (`user:pw@host`) is cut by text instead
 * (`credentialsIn` + `redactCredentials`); one without userinfo is returned unchanged.
 */
export function redactUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return redactCredentials(url, credentialsIn(url));
  }
  // `user:pw@host` without a scheme parses as a URL with the scheme "user:": no userinfo.
  if (parsed.username === "" && parsed.password === "") return redactCredentials(url, credentialsIn(url));
  parsed.username = "***";
  parsed.password = "";
  return parsed.href;
}

/**
 * The userinfo a URL-like value carries, exactly as written — `["alice:pa#ss"]` for
 * `https://alice:pa#ss@host` — or `[]` when it carries none. It works on values that
 * don't parse as a URL too, and on values with a prefix (`--base-url=https://u:p@h`):
 * the userinfo is everything between `://` and the last `@` before the host. A value
 * without a scheme counts when it reads `user:password@host`. Used to redact those
 * exact strings from text that echoes the value (usage errors, help), whatever
 * characters the password contains.
 */
export function credentialsIn(value: string): string[] {
  const schemeAt = value.indexOf("://");
  const rest = schemeAt >= 0 ? value.slice(schemeAt + 3) : value;
  // Without a scheme only the unmistakable `user:password@host` form counts.
  if (schemeAt < 0 && !/^[^\s/@:]+:[^@]*@[^@\s/]/.test(rest)) return [];
  // The URL itself starts at its scheme (`--base-url=https://…` has a prefix).
  const scheme = schemeAt >= 0 ? /[a-z][a-z0-9+.-]*$/i.exec(value.slice(0, schemeAt)) : null;
  let parses = false;
  try {
    new URL(schemeAt >= 0 ? value.slice(scheme?.index ?? schemeAt) : `http://${rest}`);
    parses = true;
  } catch {
    // Doesn't parse: the password may hold "/", "?", "#" or spaces.
  }
  // In a URL that parses, the userinfo ends at the last "@" of the authority (before
  // the first "/", "?" or "#"); in one that doesn't, at the last "@" of the value.
  const authority = parses ? rest.slice(0, rest.search(/[/?#]|$/)) : rest;
  const end = authority.lastIndexOf("@");
  return end > 0 ? [rest.slice(0, end)] : [];
}

/**
 * `text` with every occurrence of each credential (as `credentialsIn` returns them)
 * that is followed by `@` replaced by `***`. Matching the exact strings, not a
 * pattern, covers passwords with spaces, quotes, `#`, `?` or `/` that no URL pattern
 * can delimit. The percent-encoded form (`alice%3Apw%40`, as a URL typed where a
 * station id belongs ends up in a request path) is replaced too.
 */
export function redactCredentials(text: string, credentials: readonly string[]): string {
  let out = text;
  for (const secret of credentials) {
    if (secret === "") continue;
    out = out.split(`${secret}@`).join("***@");
    out = out.split(`${encodeURIComponent(secret)}%40`).join("***%40");
  }
  return out;
}

/**
 * The API responded with a non-2xx status code. `detail` holds a human-readable
 * message extracted from the response body when one is present.
 */
export class PegelApiError extends PegelError {
  readonly status: number;
  readonly detail: string | undefined;
  readonly url: string;
  readonly method: string;
  readonly body: string;
  /**
   * For a 3xx that was not followed (not a followed status, a malformed Location,
   * or past `maxRedirects`): the redirect target, absolute, sanitised, userinfo
   * redacted. The message names it.
   */
  readonly location: string | undefined;
  /**
   * For a 429/503 that was not retried because its `Retry-After` asked for longer than
   * the client waits (`MAX_RETRY_AFTER_MS`, 30 s): the wait the server asked for, in
   * milliseconds. Retrying before then won't help.
   */
  readonly retryAfterMs: number | undefined;

  constructor(args: {
    status: number;
    url: string;
    method: string;
    body: string;
    detail?: string;
    location?: string;
    /** Redirects already followed when the limit stopped this one (> 0 only). */
    redirectsFollowed?: number;
    /** A Retry-After longer than the client waits (not retried). */
    retryAfterMs?: number;
    /** Advice appended to the message (e.g. that a redirect dropped the credentials). */
    hint?: string;
  }) {
    const parts: string[] = [];
    if (args.detail) parts.push(args.detail);
    if (args.status >= 300 && args.status < 400) {
      const limit =
        args.redirectsFollowed !== undefined && args.redirectsFollowed > 0
          ? ` (stopped after ${args.redirectsFollowed} redirects)`
          : "";
      parts.push(
        args.location
          ? `redirect to ${args.location} not followed${limit}`
          : "redirect not followed (no Location header)",
      );
    }
    if (args.retryAfterMs !== undefined) {
      parts.push(
        `the server asked to wait ${Math.ceil(args.retryAfterMs / 1000)} s (Retry-After), longer than the 30 s ` +
          "the client waits, so it was not retried; try again after that",
      );
    }
    if (args.hint) parts.push(args.hint);
    const detailPart = parts.length > 0 ? `: ${parts.join("; ")}` : "";
    // The URL is shown without userinfo: a credential in --base-url must not leak.
    const url = redactUrl(args.url);
    super(`HTTP ${args.status} for ${args.method} ${url}${detailPart}`);
    this.status = args.status;
    this.url = url;
    this.method = args.method;
    this.body = args.body;
    this.detail = args.detail;
    this.location = args.location;
    this.retryAfterMs = args.retryAfterMs;
  }

  /** True for statuses the API documents as transient and retry-able. */
  get isRetryable(): boolean {
    return this.status === 429 || this.status === 503;
  }
}

/**
 * An input the library rejects before sending any request: a client option or a
 * method argument that breaks one of the rules in `validate.ts`. The message reads
 * `Invalid <name>: <reason>`. The CLI reports it as a usage error (exit 2).
 */
export class PegelValidationError extends PegelError {}

/**
 * A station name that more than one station carries (`NEUSTADT` names a gauge on the
 * LEINE and one on the OSTSEE), raised by `stations.assertUnique` before the request
 * that would have silently picked one of them. `stations` lists them, to choose one by
 * its uuid or number. A PegelValidationError, so the CLI exits 2 (usage error).
 */
export class PegelAmbiguousStationError extends PegelValidationError {
  readonly station: string;
  readonly stations: StationChoice[];
  constructor(station: string, stations: StationChoice[]) {
    const which = describeStationChoices(stations);
    super(
      `Invalid station ${JSON.stringify(cutForMessage(station))}: it names ${stations.length} stations, ${which}; ` +
        "use the number or uuid.",
    );
    this.station = station;
    this.stations = stations;
  }
}

/**
 * `NEUSTADT on LEINE (number 48800200, uuid dda39817-…)`: one station, told apart. Every
 * field is the server's text, so each goes through `serverTextForMessage`: one line, no
 * control or bidi characters, at most 200 characters.
 */
export function describeStationChoice(s: StationChoice): string {
  const text = serverTextForMessage;
  return `${text(s.shortname)}${s.water !== undefined ? ` on ${text(s.water)}` : ""} (number ${text(s.number)}, uuid ${text(s.uuid)})`;
}

/** The most stations {@link describeStationChoices} lists; the rest are counted. */
export const MAX_LISTED_STATIONS = 10;

/**
 * Same-named stations for a message: at most {@link MAX_LISTED_STATIONS} of them, each
 * as {@link describeStationChoice} tells it apart, joined with " and ", then
 * `… (N more)` for the rest. A name 500 stations share used to make a 40 kB line.
 */
export function describeStationChoices(stations: readonly StationChoice[]): string {
  const shown = stations.slice(0, MAX_LISTED_STATIONS).map(describeStationChoice).join(" and ");
  const more = stations.length - MAX_LISTED_STATIONS;
  return more > 0 ? `${shown} and … (${more} more)` : shown;
}

/** A transport-level failure (DNS, connection reset, timeout, ...). */
export class PegelNetworkError extends PegelError {}

/** The response body could not be parsed as the expected JSON shape. */
export class PegelParseError extends PegelError {}
