// Shared helpers used across CLI command groups: option parsers, the global
// option resolver, and the JSON result renderer.

import type { Command } from "commander";
import { InvalidArgumentError } from "commander";
import type { CliDeps } from "./io.js";
import type { EngineOptions } from "../client/engine.js";
import { PegelError } from "../client/errors.js";

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

/**
 * Validate a required positional argument: reject an empty/blank value rather
 * than forwarding it into the URL path (which would produce a malformed request
 * like `/stations//W/...`). Returns the trimmed value.
 */
export function requireArg(name: string, value: string | undefined): string {
  if (value === undefined || value.trim() === "") {
    throw new PegelError(`Missing required <${name}> argument.`);
  }
  // Reject "." / ".." which encodeURIComponent leaves untouched and which would
  // otherwise inject a relative path segment into the request URL.
  if (value === "." || value === "..") {
    throw new PegelError(`Invalid <${name}> argument: "${value}".`);
  }
  return value;
}

/**
 * Normalise an optional `[timeseries]` positional: an empty/blank value behaves
 * like omitting it and defaults to "W" (water level), matching the documented
 * default. (`??` alone would forward an empty string into the path.)
 */
export function timeseriesOr(value: string | undefined, fallback = "W"): string {
  return value && value.trim() !== "" ? value : fallback;
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

/** Render a JSON value to stdout, pretty by default, compact with --compact. */
export function renderJson(deps: CliDeps, global: GlobalOptions, value: unknown): void {
  const text = global.compact ? JSON.stringify(value) : JSON.stringify(value, null, 2);
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
