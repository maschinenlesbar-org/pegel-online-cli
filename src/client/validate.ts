// The library's input rules, as pure functions. Each `<thing>Problem(value)`
// returns the reason a value is invalid, or `undefined` when it is valid. The
// library enforces them with assertValid() before any request; the CLI's
// commander parsers call the same functions and turn the reason into a usage
// error, so a rule is written once and the CLI and the library cannot drift apart.

import { PegelValidationError } from "./errors.js";

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

/** True for an empty or whitespace-only string. */
export function isBlank(value: string): boolean {
  return value.trim() === "";
}

/**
 * A filter or query value must be a non-blank string: the API treats an empty
 * parameter (`?waters=`, `?start=`) as no filter, so a blank value would silently
 * return the unfiltered set or the default window.
 */
export const nonEmptyProblem: Problem<unknown> = (value) =>
  typeof value !== "string" || isBlank(value) ? "Expected a non-empty value." : undefined;

/**
 * The `ids` filter of `stations.list`: at least one id, none of them blank. An
 * empty list would be dropped and list every station; a blank entry would be sent
 * as `ids=BONN,%20`.
 */
export const idListProblem: Problem<unknown> = (value) => {
  if (!Array.isArray(value)) return "Expected an array of ids.";
  if (value.length === 0) return "Expected at least one id.";
  for (const id of value) {
    const reason = nonEmptyProblem(id);
    if (reason !== undefined) return reason;
  }
  return undefined;
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
        `Unknown key ${JSON.stringify(key)}` +
        (hint === undefined ? `; the keys are ${allowed.join(", ")}.` : ` (did you mean ${hint}?).`)
      );
    }
    return undefined;
  };
}

/** An optional flag (`includeTimeseries` …): `true`, `false` or unset — not "yes", 1 or "false". */
export const optionalBooleanProblem: Problem<unknown> = (value) =>
  value === undefined || typeof value === "boolean" ? undefined : "Expected true or false.";
