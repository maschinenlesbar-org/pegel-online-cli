import type { Command } from "commander";
import type { CliDeps } from "../io.js";
import { STATION_HELP, action, parseNonEmpty, parsePathArg, renderJson, timeseriesOr } from "../shared.js";

const TIMESERIES_HELP = "timeseries shortname, e.g. W (water level) or Q (flow)";

export function registerTimeseriesCommands(program: Command, deps: CliDeps): void {
  program
    .command("timeseries")
    .argument("<station>", STATION_HELP, parsePathArg)
    .argument("[timeseries]", TIMESERIES_HELP, parsePathArg)
    .description("Timeseries metadata (timeseries defaults to 'W' = water level)")
    .action(
      action(deps, async ({ client, global }, [station, ts]) => {
        renderJson(
          deps,
          global,
          await client.timeseries.get(station!, timeseriesOr(ts)),
        );
      }),
    );

  program
    .command("current")
    .argument("<station>", STATION_HELP, parsePathArg)
    .argument("[timeseries]", TIMESERIES_HELP, parsePathArg)
    .description("The current measurement (timeseries defaults to 'W')")
    .action(
      action(deps, async ({ client, global }, [station, ts]) => {
        renderJson(
          deps,
          global,
          await client.timeseries.currentMeasurement(station!, timeseriesOr(ts)),
        );
      }),
    );

  program
    .command("measurements")
    .argument("<station>", STATION_HELP, parsePathArg)
    .argument("[timeseries]", TIMESERIES_HELP, parsePathArg)
    .description("A window of measurements (timeseries defaults to 'W')")
    .option("--start <iso>", "window start: ISO-8601 instant, or a period like P7D", parseNonEmpty)
    .option("--end <iso>", "window end: ISO-8601 instant", parseNonEmpty)
    .action(
      action(deps, async ({ client, global, opts }, [station, ts]) => {
        renderJson(
          deps,
          global,
          await client.timeseries.measurements(station!, timeseriesOr(ts), {
            start: opts["start"] as string | undefined,
            end: opts["end"] as string | undefined,
          }),
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
