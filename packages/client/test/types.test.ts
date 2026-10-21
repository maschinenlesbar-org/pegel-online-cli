// Compile-time checks of the exported library types; the runtime assertions are trivial.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PegelOnlineClient } from "../src/index.js";
import { makeMockTransport, validFor } from "./helpers.js";

// Runs the TypeScript compiler over a consumer file.
const STARTS_A_PROCESS = { timeout: 30_000 };
const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const INDEX = fileURLToPath(new URL("../src/index.js", import.meta.url));

test("a consumer with the strictest compiler settings can pass undefined for any option", STARTS_A_PROCESS, async () => {
  // Under exactOptionalPropertyTypes, `{ baseUrl: process.env.X }` fails to compile against an
  // option declared `?: string`, although the runtime treats undefined as omitted.
  const dir = mkdtempSync(join(tmpdir(), "pegel-online-types-"));
  try {
    writeFileSync(
      join(dir, "use.ts"),
      [
        `import { PegelOnlineClient, type EngineOptions, type StationListParams, type StationIncludeParams, type IncludeParams, type MeasurementsParams } from ${JSON.stringify(INDEX)};`,
        "declare function allUndefined<T>(): { [K in keyof T]-?: undefined };",
        "export const options: EngineOptions = allUndefined<EngineOptions>();",
        "export const list: StationListParams = allUndefined<StationListParams>();",
        "export const stationIncludes: StationIncludeParams = allUndefined<StationIncludeParams>();",
        "export const includes: IncludeParams = allUndefined<IncludeParams>();",
        "export const window: MeasurementsParams = allUndefined<MeasurementsParams>();",
        "export const client = new PegelOnlineClient({ baseUrl: process.env.PEGEL_BASE_URL, timeoutMs: 15_000 });",
        "export const names = async (): Promise<string[]> => (await client.stations.list({ waters: process.env.WATERS })).map((s) => s.shortname);",
        "export const window2 = async () => client.timeseries.measurements(\"BONN\", \"W\", { start: process.env.START, end: undefined });",
      ].join("\n"),
    );
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          exactOptionalPropertyTypes: true,
          noUncheckedIndexedAccess: true,
          module: "nodenext",
          moduleResolution: "nodenext",
          target: "es2022",
          noEmit: true,
          skipLibCheck: false,
          types: ["node"],
          typeRoots: [join(ROOT, "node_modules/@types")],
        },
        files: ["use.ts"],
      }),
    );
    const tsc = join(ROOT, "node_modules/typescript/bin/tsc");
    const result = await new Promise<{ code: number; out: string }>((resolve) => {
      execFile(process.execPath, [tsc, "-p", join(dir, "tsconfig.json")], (err, stdout, stderr) =>
        resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, out: stdout + stderr }),
      );
    });
    assert.equal(result.code, 0, result.out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an option given as undefined means its default, as an omitted one does", async () => {
  const mt = makeMockTransport(validFor);
  const client = new PegelOnlineClient({
    baseUrl: undefined,
    userAgent: undefined,
    headers: undefined,
    timeoutMs: undefined,
    maxRetries: undefined,
    retryDelayMs: undefined,
    maxRedirects: undefined,
    maxResponseBytes: undefined,
    sleep: undefined,
    onRetry: undefined,
    transport: mt.transport,
  });
  await client.stations.list({
    ids: undefined,
    waters: undefined,
    fuzzyId: undefined,
    includeTimeseries: undefined,
    includeCurrentMeasurement: undefined,
    includeCharacteristicValues: undefined,
    includeForecastTimeseries: undefined,
  });
  await client.stations.get("12345", {
    includeTimeseries: undefined,
    includeCurrentMeasurement: undefined,
    includeCharacteristicValues: undefined,
    includeForecastTimeseries: undefined,
  });
  await client.timeseries.get("12345", "W", { includeTimeseries: undefined, includeCurrentMeasurement: undefined, includeCharacteristicValues: undefined });
  await client.timeseries.measurements("12345", "W", { start: undefined, end: undefined });
  assert.deepEqual(
    mt.calls.map((r) => r.url),
    [
      "https://www.pegelonline.wsv.de/webservices/rest-api/v2/stations.json",
      "https://www.pegelonline.wsv.de/webservices/rest-api/v2/stations/12345.json",
      "https://www.pegelonline.wsv.de/webservices/rest-api/v2/stations/12345/W.json",
      "https://www.pegelonline.wsv.de/webservices/rest-api/v2/stations/12345/W/measurements.json",
    ],
  );
  assert.equal(mt.calls[0]!.headers?.["User-Agent"], "pegel-online-cli");
  assert.equal(mt.calls[0]!.timeoutMs, 30_000);
  assert.equal(mt.calls[0]!.maxResponseBytes, 100 * 1024 * 1024);
});
