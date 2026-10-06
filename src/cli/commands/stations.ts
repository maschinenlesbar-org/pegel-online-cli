import type { Command } from "commander";
import { Option } from "commander";
import type { CliDeps } from "../io.js";
import { STATION_HELP, action, once, parseNonEmpty, parsePathArg, renderJson } from "../shared.js";
import type { StationIncludeParams, StationListParams } from "../../client/types.js";
import { stationListNotes, type StationListNote } from "../../client/client.js";
import { describeStationChoice } from "../../client/errors.js";

/** A library note about the listing, worded with the CLI's flag names. */
function noteText(note: StationListNote): string {
  if (note.kind === "ambiguous") {
    const which = note.stations.map(describeStationChoice).join(" and ");
    return (
      `Note: ${JSON.stringify(note.name)} names ${note.stations.length} stations: ${which}. ` +
      "A lookup by that name (stations get, timeseries, current, measurements) is refused; use the number or uuid."
    );
  }
  const value = JSON.stringify(note.value);
  switch (note.filter) {
    case "ids":
      return `Note: --ids ${value} matched no station; the list has only the others. Find the name with --fuzzy-id.`;
    case "waters":
      return `Note: --waters ${value} matched no station; it takes a water shortname as \`pegel waters\` lists it (e.g. RHEIN).`;
    case "fuzzyId":
      return `Note: --fuzzy-id ${value} matched no station; it is matched literally, umlauts included (köln, not koeln).`;
  }
}

/** commander accumulator for a repeatable string option. */
function collect(value: string, previous: string[] = []): string[] {
  return previous.concat([parseNonEmpty(value)]);
}

/** Read the four include flags off a parsed-options object. */
function includesFrom(opts: Record<string, unknown>): StationIncludeParams {
  return {
    includeTimeseries: opts["includeTimeseries"] as boolean | undefined,
    includeCurrentMeasurement: opts["includeCurrent"] as boolean | undefined,
    includeCharacteristicValues: opts["includeCharacteristic"] as boolean | undefined,
    includeForecastTimeseries: opts["includeForecast"] as boolean | undefined,
  };
}

function addIncludeOptions(cmd: Command): Command {
  return cmd
    .addOption(new Option("--include-timeseries", "embed each station's timeseries list"))
    .addOption(
      new Option(
        "--include-current",
        "embed the current measurement in each timeseries (implies --include-timeseries)",
      ),
    )
    .addOption(
      new Option(
        "--include-characteristic",
        "embed characteristic (gauge-mark) values in each timeseries (implies --include-timeseries)",
      ),
    )
    .addOption(
      new Option(
        "--include-forecast",
        "also list forecast series (WV, water-level forecast) in the timeseries list (implies --include-timeseries)",
      ),
    );
}

export function registerStationCommands(program: Command, deps: CliDeps): void {
  const stations = program.command("stations").description("Measuring stations");

  const list = stations
    .command("list")
    .description("List/filter stations")
    .option("--ids <id>", "station id (uuid/number/shortname/longname); repeatable", collect)
    .option("--waters <shortname>", "filter by water shortname (see `waters`)", once("--waters", parseNonEmpty))
    .option("--fuzzy-id <id>", "fuzzy id match", once("--fuzzy-id", parseNonEmpty));
  addIncludeOptions(list).action(
    action(deps, async ({ client, global, opts }) => {
      const params: StationListParams = {
        ids: opts["ids"] as string[] | undefined,
        waters: opts["waters"] as string | undefined,
        fuzzyId: opts["fuzzyId"] as string | undefined,
        ...includesFrom(opts),
      };
      const stations = await client.stations.list(params);
      renderJson(deps, global, stations);
      // Filter values the API matched nothing for: still exit 0 (the answer is valid),
      // but say so on stderr rather than silently printing fewer stations or [].
      for (const note of stationListNotes(params, stations)) deps.io.err(noteText(note));
    }),
  );

  const get = stations
    .command("get")
    .argument("<station>", STATION_HELP, parsePathArg)
    .description("Get one station by uuid/number/shortname/longname");
  addIncludeOptions(get).action(
    action(deps, async ({ client, global, opts }, [station]) => {
      await client.stations.assertUnique(station!);
      renderJson(
        deps,
        global,
        await client.stations.get(station!, includesFrom(opts)),
      );
    }),
  );
}
