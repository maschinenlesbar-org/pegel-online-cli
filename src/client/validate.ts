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
