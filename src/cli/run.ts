// Run the CLI and resolve to a process exit code. Kept separate from the bin
// shim so tests can call run() directly with injected deps and assert on the
// captured output and exit code without spawning a subprocess.

import { CommanderError, type Command } from "commander";
import { buildProgram, defaultDeps } from "./program.js";
import type { CliDeps } from "./io.js";
import {
  PegelApiError,
  PegelError,
  PegelValidationError,
  credentialsIn,
  redactCredentials,
} from "../client/errors.js";

/**
 * Apply exitOverride + output redirection to every command in the tree.
 * commander does not propagate these to subcommands, so a parse error on a
 * subcommand would otherwise call process.exit() and bypass our error handling.
 */
function configureTree(command: Command, deps: CliDeps): void {
  command.exitOverride();
  command.configureOutput({
    writeOut: (str) => deps.io.out(str.replace(/\n$/, "")),
    writeErr: (str) => deps.io.err(str.replace(/\n$/, "")),
  });
  for (const child of command.commands) configureTree(child, deps);
}

/** Distinct exit code for usage/parse errors, so scripts can tell a user mistake
 *  apart from a runtime/network failure (which exit 1). */
const USAGE_EXIT = 2;

/**
 * `deps` with an `io` that redacts the credentials of every argument from everything it
 * prints. Commander echoes rejected values in its errors (`argument '<value>' is
 * invalid`), names unknown commands and options, and a URL typed where a station id
 * belongs ends up in an error message: whatever path a credential takes to stdout or
 * stderr, its exact userinfo (as `credentialsIn` finds it, plus its JSON-quoted form) is
 * replaced by `***`. A pattern alone can't delimit a password with spaces, quotes, `#`,
 * `?` or `/`; the exact strings can. Without credentials the output passes through
 * unchanged. (This CLI reads no environment variable, so the arguments are the only
 * source.)
 */
export function withRedactedOutput(deps: CliDeps, argv: readonly string[]): CliDeps {
  // An `--option=value` token is echoed as its value alone.
  const values = argv.map((token) =>
    token.startsWith("-") && token.includes("=") ? token.slice(token.indexOf("=") + 1) : token,
  );
  const secrets = new Set<string>();
  for (const source of [...argv, ...values]) {
    for (const secret of credentialsIn(source)) {
      secrets.add(secret);
      secrets.add(JSON.stringify(secret).slice(1, -1));
    }
  }
  if (secrets.size === 0) return deps;
  const list = [...secrets];
  const redact = (text: string): string => redactCredentials(text, list);
  return { ...deps, io: { out: (text) => deps.io.out(redact(text)), err: (text) => deps.io.err(redact(text)) } };
}

export async function run(argv: string[], deps: CliDeps = defaultDeps): Promise<number> {
  deps = withRedactedOutput(deps, argv);
  const program = buildProgram(deps);
  configureTree(program, deps);

  // A bare invocation with no command should show help on stdout and exit 0,
  // matching `--help`, rather than erroring out with help on stderr.
  if (argv.length === 0) {
    deps.io.out(program.helpInformation().replace(/\n$/, ""));
    return 0;
  }

  try {
    await program.parseAsync(argv, { from: "user" });
    return 0;
  } catch (err) {
    if (err instanceof CommanderError) {
      // Help/version requests are not errors -> exit 0.
      if (err.code === "commander.help" || err.code === "commander.helpDisplayed") return 0;
      if (err.code === "commander.version") return 0;
      // Every other CommanderError is a usage/parse error -> distinct exit code.
      return USAGE_EXIT;
    }
    if (err instanceof PegelApiError) {
      deps.io.err(`Error: ${err.message}`);
      // Map a few notable statuses to distinct exit codes for scripting.
      if (err.status === 404) return 4;
      return 1;
    }
    if (err instanceof PegelValidationError) {
      // An input the library rejected before any request: a usage error, the same
      // exit code as commander's own parse errors.
      deps.io.err(`Error: ${err.message}`);
      return USAGE_EXIT;
    }
    if (err instanceof PegelError) {
      deps.io.err(`Error: ${err.message}`);
      return 1;
    }
    deps.io.err(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
