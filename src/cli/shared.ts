// Shared helpers used across CLI command groups: option parsers, the global
// option resolver, and the JSON result renderer.

import type { Command } from "commander";
import { InvalidArgumentError } from "commander";
import type { CliDeps } from "./io.js";
import type { EngineOptions } from "../client/engine.js";
import { PegelError } from "../client/errors.js";
import { baseUrlProblem, headerValueProblem, nonEmptyProblem } from "../client/validate.js";

/** Help text of every `<station>` positional. */
export const STATION_HELP = "station uuid, number, shortname or longname";

/** commander value-parser: a non-negative integer. */
export function parseIntArg(value: string): number {
  // Require a plain decimal integer. Reject blank/whitespace ("" and " " coerce
  // to 0 via Number()), hex/scientific encodings (0x10, 1e3), and signs/decimals.
  if (!/^[0-9]+$/.test(value)) {
    throw new InvalidArgumentError("Expected a non-negative integer.");
  }
  const n = Number(value);
  // Number() can still produce a non-exact integer for very large inputs (beyond
  // 2^53); reject those rather than silently using a different value.
  if (!Number.isSafeInteger(n)) {
    throw new InvalidArgumentError("Expected a non-negative integer.");
  }
  return n;
}

/** Build a commander value-parser for an integer constrained to [min, max]. */
export function parseBoundedInt(min: number, max: number): (value: string) => number {
  return (value: string) => {
    const n = parseIntArg(value);
    if (n < min || n > max) {
      throw new InvalidArgumentError(`Expected an integer from ${min} to ${max}.`);
    }
    return n;
  };
}

/**
 * commander value-parser: a value that is not blank. The rule is the library's
 * nonEmptyProblem, which the client enforces on every filter value too (the API
 * reads an empty parameter as no filter); here it only turns a blank value into an
 * early usage error.
 */
export function parseNonEmpty(value: string): string {
  const reason = nonEmptyProblem(value);
  if (reason !== undefined) throw new InvalidArgumentError(reason);
  return value;
}

/**
 * commander value-parser for a value that ends up in an HTTP header (`--user-agent`):
 * the library's headerValueProblem rule (not blank, no control character except tab,
 * nothing above U+00FF), which the engine enforces when the client is built; here it
 * only turns a bad value into an early usage error.
 */
export function parseHeaderValue(value: string): string {
  const reason = headerValueProblem(value);
  if (reason !== undefined) throw new InvalidArgumentError(reason);
  return value;
}

/**
 * commander value-parser for an id that becomes a URL path segment (the
 * `<station>` and `[timeseries]` positionals): not blank (which would build
 * `/stations//W/...`), and not "." / "..", which
 * encodeURIComponent leaves untouched and URL parsing would resolve, sending the
 * request to a different resource. A usage error, before any request.
 */
export function parsePathArg(value: string): string {
  parseNonEmpty(value);
  if (value === "." || value === "..") {
    throw new InvalidArgumentError('"." and ".." cannot be used as an id.');
  }
  return value;
}

/**
 * commander value-parser for `--base-url`: the library's baseUrlProblem rule (no
 * whitespace or control characters, an absolute http(s) URL, no query or
 * fragment), reported at *parse* time as a usage error (exit 2). The engine
 * enforces the same rule when the client is built, and the transport still gates
 * the scheme on every hop as the authoritative egress control.
 */
export function parseBaseUrl(value: string): string {
  const reason = baseUrlProblem(value);
  if (reason !== undefined) throw new InvalidArgumentError(reason);
  return value;
}

/**
 * Default an omitted optional `[timeseries]` positional to "W" (water level),
 * matching the documented default. A blank value never reaches here: the
 * positional's `parseNonEmpty` parser rejects it as a usage error.
 */
export function timeseriesOr(value: string | undefined, fallback = "W"): string {
  return value ?? fallback;
}

export interface GlobalOptions {
  baseUrl?: string;
  timeout?: number;
  userAgent?: string;
  maxRetries?: number;
  maxResponseBytes?: number;
  compact?: boolean;
}

/** Translate resolved global CLI options into client EngineOptions. */
export function toEngineOptions(global: GlobalOptions): EngineOptions {
  const options: EngineOptions = {};
  if (global.baseUrl !== undefined) options.baseUrl = global.baseUrl;
  if (global.timeout !== undefined) options.timeoutMs = global.timeout;
  if (global.userAgent !== undefined) options.userAgent = global.userAgent;
  if (global.maxRetries !== undefined) options.maxRetries = global.maxRetries;
  if (global.maxResponseBytes !== undefined) options.maxResponseBytes = global.maxResponseBytes;
  return options;
}

/**
 * Escape the control characters JSON.stringify leaves raw. It escapes C0 (including
 * ESC) but not DEL or the C1 range U+0080–U+009F, and terminals may act on those —
 * U+009B is the 8-bit form of CSI. The output is server data, so escape them; the
 * result is equivalent, valid JSON (these characters only occur inside strings).
 * Checked by char code so the source stays free of control bytes.
 */
export function escapeControlChars(json: string): string {
  let result = "";
  let from = 0;
  for (let i = 0; i < json.length; i++) {
    const c = json.charCodeAt(i);
    if (c >= 0x7f && c <= 0x9f) {
      result += json.slice(from, i) + "\\u" + c.toString(16).padStart(4, "0");
      from = i + 1;
    }
  }
  return from === 0 ? json : result + json.slice(from);
}

/**
 * JSON.stringify, pretty or compact. A deeply nested value (a hostile or broken
 * response) overflows the stack — the pretty form far sooner than the compact one,
 * which is why the message suggests --compact. The RangeError becomes a PegelError so
 * the CLI prints a clear message instead of "Unexpected error: Maximum call stack
 * size exceeded".
 */
function stringifyJson(value: unknown, compact: boolean): string {
  try {
    return compact ? JSON.stringify(value) : JSON.stringify(value, null, 2);
  } catch (err) {
    if (err instanceof RangeError) {
      throw new PegelError(
        compact
          ? "The response is nested too deeply to print."
          : "The response is nested too deeply to pretty-print; try --compact.",
        { cause: err },
      );
    }
    throw err;
  }
}

/** Render a JSON value to stdout, pretty by default, compact with --compact. */
export function renderJson(deps: CliDeps, global: GlobalOptions, value: unknown): void {
  const text = escapeControlChars(stringifyJson(value, global.compact === true));
  deps.io.out(text);
}

export interface ActionContext {
  client: ReturnType<CliDeps["createClient"]>;
  global: GlobalOptions;
  /** This command's own parsed options. */
  opts: Record<string, unknown>;
}

/**
 * Wrap an async command action with consistent global-option resolution and
 * client construction. The callback receives a context (client + resolved global
 * options + this command's options) and the command's positional arguments.
 *
 * Commander invokes actions as (arg1, ..., argN, options, command); we slice off
 * the trailing options object and command instance to recover the positionals.
 */
export function action(
  deps: CliDeps,
  fn: (ctx: ActionContext, positionals: string[]) => Promise<void>,
): (...args: unknown[]) => Promise<void> {
  return async (...args: unknown[]) => {
    const command = args[args.length - 1] as Command;
    const positionals = args.slice(0, Math.max(0, args.length - 2)) as string[];
    const global = command.optsWithGlobals() as GlobalOptions;
    const client = deps.createClient(toEngineOptions(global));
    await fn({ client, global, opts: command.opts() }, positionals);
  };
}
