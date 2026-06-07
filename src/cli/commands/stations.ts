import type { Command } from "commander";
import { Option } from "commander";
import type { CliDeps } from "../io.js";
import { action, renderJson, requireArg } from "../shared.js";
import { PegelError } from "../../client/errors.js";
import type { IncludeParams, StationListParams } from "../../client/types.js";

/** commander accumulator for a repeatable string option. */
function collect(value: string, previous: string[] = []): string[] {
  return previous.concat([value]);
}

/** A plain decimal number (optional sign, optional fraction, optional exponent
 *  is *not* allowed — coordinates are written as plain decimals). */
const DECIMAL = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/;

/** Parse a "latbottom,lattop,longleft,longright" bounding box into four numbers. */
export function parseBbox(value: string): [number, number, number, number] {
  const fields = value.split(",");
  // Require exactly four non-empty fields; an empty field (e.g. "1,,3,4") is a
  // user error, not an implicit 0 (Number("") === 0 would mask the mistake).
  if (fields.length !== 4 || fields.some((f) => f.trim() === "")) {
    throw new PegelError(
      "Invalid --bbox. Expected four comma-separated numbers: latbottom,lattop,longleft,longright",
    );
  }
  const trimmed = fields.map((f) => f.trim());
  // Require plain decimal coordinates; reject hex/scientific (0x10, 1e3) which
  // Number() would otherwise silently accept as 16/1000.
  if (trimmed.some((f) => !DECIMAL.test(f))) {
    throw new PegelError(
      "Invalid --bbox. Expected four decimal numbers: latbottom,lattop,longleft,longright",
    );
  }
  const parts = trimmed.map((f) => Number(f));
  if (parts.some((n) => !Number.isFinite(n))) {
    throw new PegelError(
      "Invalid --bbox. Expected four finite numbers: latbottom,lattop,longleft,longright",
    );
  }
  const [latbottom, lattop, longleft, longright] = parts as [number, number, number, number];
  if (latbottom < -90 || latbottom > 90 || lattop < -90 || lattop > 90) {
    throw new PegelError("Invalid --bbox. Latitude must be within [-90, 90].");
  }
  if (longleft < -180 || longleft > 180 || longright < -180 || longright > 180) {
    throw new PegelError("Invalid --bbox. Longitude must be within [-180, 180].");
  }
  if (latbottom > lattop) {
    throw new PegelError("Invalid --bbox. latbottom must be <= lattop.");
  }
  if (longleft > longright) {
    throw new PegelError("Invalid --bbox. longleft must be <= longright.");
  }
  return [latbottom, lattop, longleft, longright];
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
    .option("--longname <name>", "filter by (substring of) longname")
    .option("--waters <shortname>", "filter by water shortname (see `waters`)")
    .option("--agency <agency>", "filter by agency")
    .option("--fuzzy-id <id>", "fuzzy id match")
    .option("--bbox <latbottom,lattop,longleft,longright>", "bounding box", parseBbox);
  addIncludeOptions(list).action(
    action(deps, async ({ client, global, opts }) => {
      const bbox = opts["bbox"] as [number, number, number, number] | undefined;
      const params: StationListParams = {
        ids: opts["ids"] as string[] | undefined,
        longname: opts["longname"] as string | undefined,
        waters: opts["waters"] as string | undefined,
        agency: opts["agency"] as string | undefined,
        fuzzyId: opts["fuzzyId"] as string | undefined,
        ...(bbox
          ? { latbottom: bbox[0], lattop: bbox[1], longleft: bbox[2], longright: bbox[3] }
          : {}),
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
