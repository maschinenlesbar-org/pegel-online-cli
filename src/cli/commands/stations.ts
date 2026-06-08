import type { Command } from "commander";
import { Option } from "commander";
import type { CliDeps } from "../io.js";
import { action, renderJson, requireArg } from "../shared.js";
import type { IncludeParams, StationListParams } from "../../client/types.js";

/** commander accumulator for a repeatable string option. */
function collect(value: string, previous: string[] = []): string[] {
  return previous.concat([value]);
}

/** Read the three include flags off a parsed-options object. */
function includesFrom(opts: Record<string, unknown>): IncludeParams {
  return {
    includeTimeseries: opts["includeTimeseries"] as boolean | undefined,
    includeCurrentMeasurement: opts["includeCurrent"] as boolean | undefined,
    includeCharacteristicValues: opts["includeCharacteristic"] as boolean | undefined,
  };
}

function addIncludeOptions(cmd: Command): Command {
  return cmd
    .addOption(new Option("--include-timeseries", "embed each station's timeseries list"))
    .addOption(new Option("--include-current", "embed the current measurement"))
    .addOption(new Option("--include-characteristic", "embed characteristic (gauge-mark) values"));
}

export function registerStationCommands(program: Command, deps: CliDeps): void {
  const stations = program.command("stations").description("Measuring stations");

  const list = stations
    .command("list")
    .description("List/filter stations")
    .option("--ids <id>", "station id (uuid/number/shortname/longname); repeatable", collect)
    .option("--waters <shortname>", "filter by water shortname (see `waters`)")
    .option("--fuzzy-id <id>", "fuzzy id match");
  addIncludeOptions(list).action(
    action(deps, async ({ client, global, opts }) => {
      const params: StationListParams = {
        ids: opts["ids"] as string[] | undefined,
        waters: opts["waters"] as string | undefined,
        fuzzyId: opts["fuzzyId"] as string | undefined,
        ...includesFrom(opts),
      };
      renderJson(deps, global, await client.stations.list(params));
    }),
  );

  const get = stations
    .command("get <station>")
    .description("Get one station by uuid/number/shortname/longname");
  addIncludeOptions(get).action(
    action(deps, async ({ client, global, opts }, [station]) => {
      renderJson(
        deps,
        global,
        await client.stations.get(requireArg("station", station), includesFrom(opts)),
      );
    }),
  );
}
