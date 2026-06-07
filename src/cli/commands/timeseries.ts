import type { Command } from "commander";
import type { CliDeps } from "../io.js";
import { action, renderJson, requireArg, timeseriesOr } from "../shared.js";

/** An empty option value (e.g. `--start ""`) should be omitted, not sent blank. */
function optStr(value: unknown): string | undefined {
  const s = value as string | undefined;
  return s !== undefined && s !== "" ? s : undefined;
}

export function registerTimeseriesCommands(program: Command, deps: CliDeps): void {
  program
    .command("timeseries <station> [timeseries]")
    .description("Timeseries metadata (timeseries defaults to 'W' = water level)")
    .action(
      action(deps, async ({ client, global }, [station, ts]) => {
        renderJson(
          deps,
          global,
          await client.timeseries.get(requireArg("station", station), timeseriesOr(ts)),
        );
      }),
    );

  program
    .command("current <station> [timeseries]")
    .description("The current measurement (timeseries defaults to 'W')")
    .action(
      action(deps, async ({ client, global }, [station, ts]) => {
        renderJson(
          deps,
          global,
          await client.timeseries.currentMeasurement(requireArg("station", station), timeseriesOr(ts)),
        );
      }),
    );

  program
    .command("measurements <station> [timeseries]")
    .description("A window of measurements (timeseries defaults to 'W')")
    .option("--start <iso>", "window start: ISO-8601 instant, or a period like P7D")
    .option("--end <iso>", "window end: ISO-8601 instant")
    .action(
      action(deps, async ({ client, global, opts }, [station, ts]) => {
        renderJson(
          deps,
          global,
          await client.timeseries.measurements(requireArg("station", station), timeseriesOr(ts), {
            start: optStr(opts["start"]),
            end: optStr(opts["end"]),
          }),
        );
      }),
    );

  program
    .command("characteristic <station> [timeseries]")
    .description("Characteristic (gauge-mark) values (timeseries defaults to 'W')")
    .action(
      action(deps, async ({ client, global }, [station, ts]) => {
        renderJson(
          deps,
          global,
          await client.timeseries.characteristicValues(requireArg("station", station), timeseriesOr(ts)),
        );
      }),
    );

  program
    .command("waters")
    .description("List all bodies of water (Gewässer)")
    .action(
      action(deps, async ({ client, global }) => {
        renderJson(deps, global, await client.waters());
      }),
    );
}
