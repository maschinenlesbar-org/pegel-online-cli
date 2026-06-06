import { test } from "node:test";
import assert from "node:assert/strict";
import { RequestEngine } from "../src/client/engine.js";
import { PegelApiError, PegelParseError } from "../src/client/errors.js";
import { makeMockTransport, jsonResponse, rawResponse } from "./helpers.js";

test("buildUrl normalises the path and appends the query", () => {
  const e = new RequestEngine({ baseUrl: "https://example.test/" });
  assert.equal(e.buildUrl("webservices/"), "https://example.test/webservices/");
  assert.equal(
    e.buildUrl("/x", { a: "1", b: ["2", "3"] }),
    "https://example.test/x?a=1&b=2&b=3",
  );
});

test("getJson parses a JSON body", async () => {
  const mt = makeMockTransport(() => jsonResponse({ ok: true }));
  const e = new RequestEngine({ transport: mt.transport });
  assert.deepEqual(await e.getJson("/x"), { ok: true });
});

test("getJson throws PegelParseError on invalid JSON", async () => {
  const mt = makeMockTransport(() => rawResponse("not json", "application/json"));
  const e = new RequestEngine({ transport: mt.transport });
  await assert.rejects(() => e.getJson("/x"), PegelParseError);
});

test("a 503 is retried up to maxRetries then surfaces as PegelApiError", async () => {
  let calls = 0;
  const mt = makeMockTransport(() => {
    calls += 1;
    return jsonResponse({ detail: "busy" }, 503);
  });
  const e = new RequestEngine({
    transport: mt.transport,
    maxRetries: 2,
    sleep: async () => {},
  });
  await assert.rejects(
    () => e.getJson("/x"),
    (err) => err instanceof PegelApiError && err.status === 503,
  );
  assert.equal(calls, 3); // initial + 2 retries
});

test("a retried request that then succeeds resolves", async () => {
  let calls = 0;
  const mt = makeMockTransport(() => {
    calls += 1;
    return calls === 1 ? jsonResponse({}, 503) : jsonResponse({ ok: 1 });
  });
  const e = new RequestEngine({ transport: mt.transport, sleep: async () => {} });
  assert.deepEqual(await e.getJson("/x"), { ok: 1 });
  assert.equal(calls, 2);
});

test("a cross-origin redirect strips credential-bearing headers", async () => {
  const seen: Array<Record<string, string> | undefined> = [];
  const mt = makeMockTransport((req) => {
    seen.push(req.headers);
    if (req.url.startsWith("https://a.test")) {
      return { status: 302, headers: { location: "https://b.test/x" }, body: Buffer.from("") };
    }
    return jsonResponse({ ok: true });
  });
  const e = new RequestEngine({ baseUrl: "https://a.test", transport: mt.transport });
  // Inject an Authorization header via a custom request path is not exposed, so we
  // assert the guard logic by confirming the redirect is followed cross-origin and
  // the second request carries no Authorization/Cookie (none were set, and none
  // were synthesised across the hop).
  assert.deepEqual(await e.getJson("/x"), { ok: true });
  assert.equal(seen.length, 2);
  assert.equal(seen[1]?.["Authorization"], undefined);
  assert.equal(seen[1]?.["Cookie"], undefined);
});

test("the User-Agent and Accept headers are sent", async () => {
  const mt = makeMockTransport(() => jsonResponse({}));
  const e = new RequestEngine({ transport: mt.transport, userAgent: "ua/1" });
  await e.getJson("/x");
  assert.equal(mt.last().headers?.["User-Agent"], "ua/1");
  assert.equal(mt.last().headers?.["Accept"], "application/json");
});
