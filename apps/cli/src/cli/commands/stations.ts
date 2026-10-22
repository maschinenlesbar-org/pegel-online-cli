import type { Command } from "commander";
import { Option } from "commander";
import { logOf, type CliDeps } from "../io.js";
import { STATION_HELP, action, once, parseList, parseStationId, parseText, parseToken, renderJson } from "../shared.js";
import type { StationIncludeParams, StationListParams } from "@maschinenlesbar.org/pegel-online-client/internal/types";
import { stationListNotes, type StationListNote } from "@maschinenlesbar.org/pegel-online-client/internal/client";
import { describeStationChoices, quoteValue, serverTextForMessage } from "@maschinenlesbar.org/pegel-online-client/internal/errors";

/** A library note about the listing, worded with the CLI's flag names. */
function noteText(note: StationListNote): string {
  if (note.kind === "ambiguous") {
    const which = describeStationChoices(note.stations);
    return (
      `${JSON.stringify(serverTextForMessage(note.name))} names ${note.stations.length} stations: ${which}. ` +
      "A lookup by that name (stations get, timeseries, current, measurements) is refused; use the number or uuid."
    );
  }
  const value = quoteValue(note.value);
  switch (note.filter) {
    case "ids":
      return `--ids ${value} matched no station; the list has only the others. Find the name with --fuzzy-id.`;
    case "waters":
      return `--waters ${value} matched no station; it takes a water shortname as \`pegel waters\` lists it (e.g. RHEIN).`;
    case "fuzzyId":
      return `--fuzzy-id ${value} matched no station; it is matched literally, umlauts included (köln, not koeln).`;
  }
}

/** commander accumulator for `--ids`: a comma-separated list (parseList), repeatable. */
function collect(value: string, previous: string[] = []): string[] {
  return previous.concat(parseList(value));
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
    .option("--ids <ids>", "station ids (uuid/number/shortname/longname), comma-separated; repeatable", collect)
    .option("--waters <shortname>", "filter by water shortname (see `waters`)", once("--waters", parseToken))
    .option("--fuzzy-id <id>", "fuzzy id match", once("--fuzzy-id", parseText));
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
      for (const note of stationListNotes(params, stations)) logOf(deps).info("api", noteText(note));
    }),
  );

  const get = stations
    .command("get")
    .argument("<station>", STATION_HELP, parseStationId)
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
