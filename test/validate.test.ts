import { test } from "node:test";
import assert from "node:assert/strict";
import { assertValid, idListProblem, isBlank, nonEmptyProblem, type Problem } from "../src/client/validate.js";
import { PegelError, PegelValidationError } from "../src/client/errors.js";
import * as library from "../src/index.js";
import { PegelOnlineClient } from "../src/client/client.js";
import { jsonResponse, parity } from "./helpers.js";

const nonEmpty: Problem<string> = (value) => (value.trim() === "" ? "Expected a non-empty value." : undefined);

test("assertValid returns a valid value unchanged", () => {
  assert.equal(assertValid("name", "x", nonEmpty), "x");
});

test("assertValid throws PegelValidationError with 'Invalid <name>: <reason>'", () => {
  assert.throws(
    () => assertValid("waters", " ", nonEmpty),
    (err: unknown) =>
      err instanceof PegelValidationError &&
      err instanceof PegelError &&
      err.name === "PegelValidationError" &&
      err.message === "Invalid waters: Expected a non-empty value.",
  );
});

test("assertValid inside an async method rejects instead of throwing synchronously", async () => {
  const method = async (value: string): Promise<string> => assertValid("q", value, nonEmpty);
  const pending = method("");
  assert.ok(pending instanceof Promise);
  await assert.rejects(pending, PegelValidationError);
});

test("the library root exports the validation layer", () => {
  assert.equal(library.PegelValidationError, PegelValidationError);
  assert.equal(library.assertValid, assertValid);
});

test("parity() runs one input through run() and the library on recording transports", async () => {
  const waters = [{ shortname: "RHEIN", longname: "RHEIN" }];
  const { cli, lib } = await parity(
    ["--compact", "waters"],
    (transport) => new PegelOnlineClient({ transport }).waters(),
    () => jsonResponse(waters),
  );
  assert.equal(cli.code, 0);
  assert.equal(cli.out, JSON.stringify(waters));
  assert.equal(lib.ok, true);
  assert.deepEqual(lib.value, waters);
  assert.deepEqual(
    cli.requests.map((r) => r.url),
    lib.requests.map((r) => r.url),
  );

  const failing = await parity(["waters"], () => {
    throw new PegelValidationError("Invalid x: y");
  });
  assert.equal(failing.lib.ok, false);
  assert.ok(failing.lib.error instanceof PegelValidationError);
  assert.deepEqual(failing.lib.requests, []);
});

test("nonEmptyProblem rejects blank and non-string values", () => {
  for (const value of ["", " ", "\t", "\n  "]) {
    assert.equal(nonEmptyProblem(value), "Expected a non-empty value.", JSON.stringify(value));
  }
  assert.equal(nonEmptyProblem(undefined), "Expected a non-empty value.");
  assert.equal(nonEmptyProblem(7), "Expected a non-empty value.");
  for (const value of ["RHEIN", " BONN ", "P7D"]) assert.equal(nonEmptyProblem(value), undefined);
  assert.equal(isBlank("  "), true);
  assert.equal(isBlank("x"), false);
});

test("idListProblem needs at least one id and no blank entry", () => {
  assert.equal(idListProblem([]), "Expected at least one id.");
  assert.equal(idListProblem([""]), "Expected a non-empty value.");
  assert.equal(idListProblem(["BONN", " "]), "Expected a non-empty value.");
  assert.equal(idListProblem("BONN"), "Expected an array of ids.");
  assert.equal(idListProblem(["BONN", "KÖLN"]), undefined);
});
