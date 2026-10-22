// The library's input rules, as pure functions. Each `<thing>Problem(value)`
// returns the reason a value is invalid, or `undefined` when it is valid. The
// library enforces them with assertValid() before any request; the CLI's
// commander parsers call the same functions and turn the reason into a usage
// error, so a rule is written once and the CLI and the library cannot drift apart.

import { PegelValidationError, quoteValue } from "./errors.js";

/** A rule: the reason `value` is invalid (e.g. `"Expected a non-empty value."`), or `undefined` when it is valid. */
export type Problem<T = unknown> = (value: T) => string | undefined;

/**
 * Throw a {@link PegelValidationError} with the message `Invalid <name>: <reason>`
 * when `problem(value)` finds a reason; otherwise return `value` unchanged. Call it
 * before any request, so a rejected input sends nothing. Async methods call it
 * inside their body, so the rejection arrives as a rejected promise rather than a
 * synchronous throw.
 */
export function assertValid<T>(name: string, value: T, problem: Problem<T>): T {
  const reason = problem(value);
  if (reason !== undefined) throw new PegelValidationError(`Invalid ${name}: ${reason}`);
  return value;
}

/**
 * The form in which an id, name or filter value is sent: surrounding whitespace removed
 * and composed (NFC). The API matches station names, waters and ids exactly, so
 * `"RHEIN "` (a trailing space from a copy) listed no station and `"BONN "` was a 404, and
 * a decomposed umlaut ("KO" + U+0308 + "LN", as pasted from macOS file names or some
 * PDFs) found nothing either; no name upstream begins or ends with whitespace. NFC, not
 * NFKC: an id lookup must not rewrite compatibility characters, and case is left alone
 * (the API ignores it for station ids, but not everywhere).
 */
export function normalizeInput(value: string): string {
  return value.trim().normalize("NFC");
}

/** Characters that never make a value non-blank: whitespace, controls, format characters, combining marks. */
const INVISIBLE = /[\s\p{Cc}\p{Cf}\p{M}]/gu;

/** A lone surrogate: half of a character, which encodeURIComponent throws on and URLSearchParams sends as U+FFFD. */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/**
 * True when nothing in `value` would match anything: it holds only whitespace, control and
 * format characters (a zero-width space, a soft hyphen) and combining marks. Such a value reads
 * as "no filter" upstream, or matches nothing, so it is refused as blank.
 */
export function isBlank(value: string): boolean {
  return value.replace(INVISIBLE, "") === "";
}

/** `U+200B` for the first character of `text` that `pattern` matches. */
function codePointOf(text: string, pattern: RegExp): string {
  const ch = pattern.exec(text)?.[0] ?? "";
  return `U+${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`;
}

/**
 * A filter or query value must be a non-blank string: the API treats an empty
 * parameter (`?waters=`, `?start=`) as no filter, so a blank value would silently
 * return the unfiltered set or the default window. Blank includes a value of only invisible
 * characters (`isBlank`).
 */
export const nonEmptyProblem: Problem<unknown> = (value) =>
  typeof value !== "string" || isBlank(value) ? "Expected a non-empty value." : undefined;

/** A control character inside a text filter: C0 and C1, but not TAB, LF or CR (whitespace in a pasted phrase). */
const TEXT_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;

/** A format character inside a text filter, but not ZWNJ/ZWJ (U+200C/U+200D), which some scripts and emoji need. */
const TEXT_FORMAT = /(?![\u200c\u200d])\p{Cf}/u;

/**
 * Why `value` cannot be sent as a text filter (`fuzzyId`), or undefined when it can. Refused,
 * before any request, as the API would match nothing or everything:
 * - a value that is blank once trimmed, or that holds only invisible characters and combining
 *   marks (`isBlank`): an empty filter reads as "no filter" upstream;
 * - a lone surrogate (half of a character, sent as U+FFFD);
 * - a control character (but TAB, LF and CR) or a format character (a zero-width space, a soft
 *   hyphen, a bidi control; ZWNJ and ZWJ are allowed): pasted along, it makes the search find
 *   nothing.
 * The reason quotes the value with every invisible character escaped (`quoteValue`).
 */
export function textProblem(value: string): string | undefined {
  if (typeof value !== "string") return "Expected a string.";
  if (isBlank(value)) return "Expected a non-empty value.";
  if (LONE_SURROGATE.test(value)) return `${quoteValue(value)} contains half of a character (a lone surrogate).`;
  if (TEXT_CONTROL.test(value)) return `${quoteValue(value)} contains a control character (${codePointOf(value, TEXT_CONTROL)}).`;
  if (TEXT_FORMAT.test(value)) return `${quoteValue(value)} contains an invisible character (${codePointOf(value, TEXT_FORMAT)}).`;
  return undefined;
}

/** A text filter as it is sent: trimmed and composed (NFC), as `normalizeInput`. Check it with {@link textProblem} first. */
export function normalizeText(value: string): string {
  return normalizeInput(value);
}

/** A control or format character in a token (after trimming): every Cc and every Cf. */
const TOKEN_INVISIBLE = /[\p{Cc}\p{Cf}]/u;

/**
 * Why `value` cannot be sent as a token, or undefined when it can. A token is a value the API
 * compares exactly: a station or timeseries id, a water shortname (`waters`), an ISO date or
 * period (`start`, `end`), an `ids` entry. The rules apply to the value with surrounding
 * whitespace trimmed, as it is sent ({@link normalizeToken}): not blank (and not only invisible
 * characters or combining marks), no lone surrogate, and no control or format character at all
 * (a zero-width space, ZWJ, a soft hyphen, a bidi control), since an invisible character in an id
 * only ever makes it match nothing. The reason quotes the value visibly.
 */
export function tokenProblem(value: string): string | undefined {
  if (typeof value !== "string") return "Expected a string.";
  if (isBlank(value)) return "Expected a non-empty value.";
  const token = value.trim();
  if (LONE_SURROGATE.test(token)) return `${quoteValue(value)} contains half of a character (a lone surrogate).`;
  if (TOKEN_INVISIBLE.test(token)) {
    return `${quoteValue(value)} contains an invisible or control character (${codePointOf(token, TOKEN_INVISIBLE)}).`;
  }
  return undefined;
}

/** A token as it is sent: trimmed and composed (NFC), as `normalizeInput`. Check it with {@link tokenProblem} first. */
export function normalizeToken(value: string): string {
  return normalizeInput(value);
}

/**
 * Why `value` cannot be put into a request path as a timeseries id (or, through
 * {@link stationIdProblem}, a station id), or undefined when it can: the {@link tokenProblem}
 * rules, and then on the trimmed value no "/" (sent as `%2F`, which a server or proxy that
 * decodes it reads as more path segments: `BONN/../KOELN` would re-target the request), and not
 * "." or ".." (encodeURIComponent leaves them unchanged and URL parsing resolves them).
 */
export function idProblem(value: string): string | undefined {
  const problem = tokenProblem(value);
  if (problem !== undefined) return problem;
  const id = value.trim();
  if (id.includes("/")) return `${quoteValue(id)}: an id cannot contain "/" (the API reads it as a path separator).`;
  if (id === "." || id === "..") return `${quoteValue(id)}: "." and ".." cannot be used as an id.`;
  return undefined;
}

/**
 * Why `value` cannot name a station (uuid, number, shortname or longname), or undefined when it
 * can: {@link idProblem}, with the hint that a station is always reachable by its number or uuid,
 * and no ",": a name is looked up first as `ids=<name>` (`stations.assertUnique`), where the API
 * splits at the comma — `"NEUSTADT,"` found both NEUSTADTs and `","` downloaded every station —
 * and no station's name holds one.
 */
export function stationIdProblem(value: string): string | undefined {
  const problem = tokenProblem(value);
  if (problem !== undefined) return problem;
  const id = value.trim();
  if (id.includes("/")) return `${quoteValue(id)}: an id cannot contain "/" (the API reads it as a path separator); use the station's number or uuid.`;
  if (id.includes(",")) return `${quoteValue(id)}: a station id cannot contain "," (the API reads it as a list); for several stations use stations list --ids.`;
  return idProblem(value);
}

/**
 * The items of a comma-separated list option (`--ids BONN,KÖLN`), as typed: each item is checked
 * (`listProblem`) and canonicalised (`normalizeToken`) on its own, so `"BONN, KÖLN"` sends `KÖLN`,
 * and `"BONN,,KÖLN"`, `"BONN,"` and `","` are refused rather than sent as an empty item (which the
 * API reads as "no filter").
 */
export function splitList(value: string): string[] {
  return value.split(",");
}

/**
 * Why `items` cannot be sent as a list, or undefined when it can: not an array of strings, no
 * item at all (an empty list reads as "no filter"), or an item that `itemProblem` refuses (by
 * default {@link tokenProblem}: a blank item is refused, never dropped). The reason names the item.
 */
export function listProblem(items: readonly string[], itemProblem: Problem<string> = tokenProblem): string | undefined {
  if (!Array.isArray(items)) return "Expected a list of strings.";
  if (items.length === 0) return "Expected at least one value.";
  for (let i = 0; i < items.length; i++) {
    const problem = itemProblem(items[i] as string);
    if (problem !== undefined) return items.length === 1 ? problem : `item ${i + 1} of ${items.length}: ${problem}`;
  }
  return undefined;
}

/** An entry of the comma-joined `ids` list: a token without a comma (it would split into two ids). */
function listedIdProblem(value: string): string | undefined {
  return tokenProblem(value) ?? (value.includes(",") ? "An id in a list cannot contain a comma." : undefined);
}

/**
 * The `ids` filter of `stations.list`: an array of at least one id, each a token
 * ({@link tokenProblem}) without a comma. An empty list would be dropped and list every station;
 * a blank entry would be sent as `ids=BONN,%20`, and a comma inside an entry splits it upstream
 * (`","` alone listed every station).
 */
export const idListProblem: Problem<unknown> = (value) => {
  if (!Array.isArray(value)) return "Expected an array of ids.";
  if (value.length === 0) return "Expected at least one id.";
  return listProblem(value as string[], listedIdProblem);
};

/**
 * Whitespace and control characters in a base URL. `new URL()` silently trims
 * surrounding whitespace and strips an interior tab or newline, so the URL checks
 * pass, but the engine concatenates request paths onto the raw string:
 * `"https://h/ "` would request `/%20/webservices/...`, and a custom transport would
 * get the raw padded value.
 */
export const baseUrlWhitespaceProblem: Problem<unknown> = (value) => {
  if (typeof value !== "string") return "Expected a string.";
  if (value !== value.trim()) return "A base URL cannot have surrounding whitespace.";
  if (/[\s\u0000-\u001f\u007f]/.test(value)) return "A base URL cannot contain whitespace or control characters.";
  return undefined;
};

/**
 * The full base-URL rule set, in order: no whitespace or control characters
 * (baseUrlWhitespaceProblem), an absolute URL, an `http:`/`https:` scheme, no
 * query or fragment, and no `%` in the userinfo that doesn't start a valid escape
 * (`%25` for a literal one). Request paths are appended to the base URL as a string, so a
 * `?` or `#` in it would swallow every path: `http://h/?x=1` requests
 * `/?x=1/webservices/...` and `http://h/#f` requests `/`. A path prefix is fine, and
 * userinfo is allowed (Node sends it as Basic auth). The reasons name no URL, so a
 * credential in it never reaches a message.
 */
export const baseUrlProblem: Problem<unknown> = (value) => {
  const whitespace = baseUrlWhitespaceProblem(value);
  if (whitespace !== undefined) return whitespace;
  let url: URL;
  try {
    url = new URL(value as string);
  } catch {
    return "Expected an absolute http(s) URL.";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "Only http and https URLs are supported.";
  if (/[?#]/.test(value as string)) return "A base URL cannot have a query (?) or fragment (#).";
  // Node decodes the userinfo into the Authorization header and throws "URI malformed"
  // for a "%" that isn't an escape — at request time, as a network error. Reject it here.
  for (const part of [url.username, url.password]) {
    try {
      decodeURIComponent(part);
    } catch {
      return 'The user name or password has a "%" that is not followed by two hex digits; write a literal "%" as %25.';
    }
  }
  return undefined;
};

/**
 * A value that goes into an HTTP header (the User-Agent): non-blank, no C0 control
 * or DEL (tab is allowed, as in HTTP), nothing above U+00FF. A blank value would be
 * sent as an empty header instead of the default; Node's HTTP layer refuses the
 * others with an opaque "Invalid character in header content" TypeError at request
 * time, and an injected transport would send a CR/LF value as is (header
 * injection). Checked by char code so the source stays free of control bytes.
 */
export const headerValueProblem: Problem<unknown> = (value) => {
  if (typeof value !== "string" || isBlank(value)) return "Expected a non-empty value.";
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if ((c < 0x20 && c !== 0x09) || c === 0x7f) return "Value contains control characters.";
    if (c > 0xff) return "Value contains characters outside Latin-1 (above U+00FF).";
  }
  return undefined;
};

/**
 * A parameter object of a client method: a plain object whose own keys are all in
 * `allowed` (an `undefined` value counts as unset and is ignored). A misspelled key
 * (`water` for `waters`, `fuzzyID`), `__proto__` or `constructor` was dropped silently
 * and the API answered with every station; TypeScript catches a typo, JavaScript and a
 * JSON config do not. The reason names the key, a close match and the allowed keys.
 */
export function knownKeysProblem(allowed: readonly string[]): Problem<unknown> {
  return (value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return "Expected an object.";
    for (const [key, v] of Object.entries(value)) {
      if (v === undefined || allowed.includes(key)) continue;
      const lower = key.toLowerCase();
      const hint = allowed.find((name) => name.toLowerCase().includes(lower) || lower.includes(name.toLowerCase()));
      return (
        `Unknown key ${quoteValue(key)}` +
        (hint === undefined ? `; the keys are ${allowed.join(", ")}.` : ` (did you mean ${hint}?).`)
      );
    }
    return undefined;
  };
}

/** An optional flag (`includeTimeseries` …): `true`, `false` or unset — not "yes", 1 or "false". */
export const optionalBooleanProblem: Problem<unknown> = (value) =>
  value === undefined || typeof value === "boolean" ? undefined : "Expected true or false.";
