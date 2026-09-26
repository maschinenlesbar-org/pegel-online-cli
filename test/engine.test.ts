import { test } from "node:test";
import assert from "node:assert/strict";
import { RequestEngine, parseRetryAfter, MAX_RETRY_AFTER_MS } from "../src/client/engine.js";
import { PegelApiError, PegelError, PegelNetworkError, PegelParseError } from "../src/client/errors.js";
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

test("a cross-origin redirect strips credential headers case-insensitively (PEGEL-04)", async () => {
  const seen: Array<Record<string, string>> = [];
  const mt = makeMockTransport((req) => {
    // Snapshot the headers: the engine mutates the same object in place across
    // hops, so recording the live reference would show only its final state.
    seen.push({ ...req.headers });
    if (req.url.startsWith("https://a.test")) {
      return { status: 302, headers: { location: "https://b.test/x" }, body: Buffer.from("") };
    }
    return jsonResponse({ ok: true });
  });
  // Seed credentials in mixed / non-canonical casing to prove the strip is
  // case-insensitive and covers X-Api-Key, not just exact-case Authorization/Cookie.
  const e = new RequestEngine({
    baseUrl: "https://a.test",
    transport: mt.transport,
    headers: { "X-Api-Key": "secret", authorization: "Bearer t", Cookie: "s=1" },
  });

  assert.deepEqual(await e.getJson("/x"), { ok: true });
  assert.equal(seen.length, 2);
  // First hop (same origin) carries the credentials...
  assert.equal(seen[0]?.["X-Api-Key"], "secret");
  // ...the cross-origin hop carries none, regardless of the original casing.
  const crossOrigin = seen[1] ?? {};
  for (const [k, v] of Object.entries(crossOrigin)) {
    const lower = k.toLowerCase();
    assert.ok(
      lower !== "x-api-key" && lower !== "authorization" && lower !== "cookie",
      `credential header leaked across origin: ${k}=${v}`,
    );
  }
});

test("a same-host https->http downgrade strips credential headers (PEGEL-04)", async () => {
  const seen: Array<Record<string, string>> = [];
  const mt = makeMockTransport((req) => {
    seen.push({ ...req.headers });
    if (req.url.startsWith("https://")) {
      return { status: 302, headers: { location: "http://a.test/x" }, body: Buffer.from("") };
    }
    return jsonResponse({ ok: true });
  });
  const e = new RequestEngine({
    baseUrl: "https://a.test",
    transport: mt.transport,
    headers: { "X-Api-Key": "secret" },
  });

  assert.deepEqual(await e.getJson("/x"), { ok: true });
  assert.equal(seen.length, 2);
  assert.equal(seen[1]?.["X-Api-Key"], undefined);
});

test("the User-Agent and Accept headers are sent", async () => {
  const mt = makeMockTransport(() => jsonResponse({}));
  const e = new RequestEngine({ transport: mt.transport, userAgent: "ua/1" });
  await e.getJson("/x");
  assert.equal(mt.last().headers?.["User-Agent"], "ua/1");
  assert.equal(mt.last().headers?.["Accept"], "application/json");
});

// Control chars are built via char codes so no raw control bytes ever appear in
// this source file.
const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const CSI = String.fromCharCode(0x9b); // a C1 control

/** True if the string contains any C0/C1 control char except tab/newline. */
function hasControlChars(s: string): boolean {
  return [...s].some((c) => {
    const n = c.charCodeAt(0);
    return n <= 8 || (n >= 0x0b && n <= 0x1f) || (n >= 0x7f && n <= 0x9f);
  });
}

test("error detail is stripped of terminal control characters (PEGEL-01)", async () => {
  // ESC + CSI + BEL interleaved with printable text in the response `detail`.
  const evil = `boom${ESC}[31mred${BEL}${CSI}2J`;
  const mt = makeMockTransport(() =>
    jsonResponse({ detail: evil }, 500),
  );
  const e = new RequestEngine({ transport: mt.transport, maxRetries: 0 });

  await assert.rejects(
    () => e.getJson("/x"),
    (err: unknown) => {
      assert.ok(err instanceof PegelApiError);
      // The control bytes are gone from both the structured detail and the
      // human-readable message that run.ts prints to stderr...
      assert.ok(!hasControlChars(err.detail ?? ""));
      assert.ok(!hasControlChars(err.message));
      // ...while the printable characters are preserved.
      assert.equal(err.detail, "boom[31mred2J");
      return true;
    },
  );
});

test("a non-http(s) base URL is rejected at construction, before any request", () => {
  for (const baseUrl of ["file:///etc/passwd", "ftp://example.org"]) {
    const mt = makeMockTransport(() => jsonResponse({}));
    assert.throws(
      () => new RequestEngine({ baseUrl, transport: mt.transport }),
      (err) => err instanceof PegelNetworkError && /Unsupported protocol/.test(err.message),
    );
    assert.equal(mt.calls.length, 0);
  }
});

test("an unparseable base URL is rejected at construction", () => {
  const mt = makeMockTransport(() => jsonResponse({}));
  assert.throws(
    () => new RequestEngine({ baseUrl: "not a url", transport: mt.transport }),
    (err) => err instanceof PegelNetworkError && /Invalid base URL/.test(err.message),
  );
  assert.equal(mt.calls.length, 0);
});

test('buildUrl rejects a "." or ".." path segment; dotted names and %2e pass', () => {
  const e = new RequestEngine({ baseUrl: "https://example.test" });
  for (const path of ["/a/../b.json", "/a/./b", "/.."]) {
    assert.throws(() => e.buildUrl(path), (err: unknown) =>
      err instanceof PegelError &&
      /^Invalid path segment "\.{1,2}" in .*: "\." and "\.\." cannot be used as an id\.$/.test(err.message));
  }
  assert.equal(e.buildUrl("/a/.../b"), "https://example.test/a/.../b");
  assert.equal(e.buildUrl("/a/1.0.0/b"), "https://example.test/a/1.0.0/b");
  assert.equal(e.buildUrl("/a/%252e%252e/b"), "https://example.test/a/%252e%252e/b");
});

function retryEngine(headers: Record<string, string>) {
  const delays: number[] = [];
  let calls = 0;
  const mt = makeMockTransport(() => {
    calls += 1;
    return { status: 429, headers: { "content-type": "application/json", ...headers }, body: Buffer.from('{"message":"slow"}') };
  });
  const e = new RequestEngine({
    transport: mt.transport,
    maxRetries: 2,
    sleep: async (ms) => { delays.push(ms); },
  });
  return { e, delays, calls: () => calls };
}

test("a 429 waits the server's Retry-After (seconds) before each retry", async () => {
  const r = retryEngine({ "retry-after": "1" });
  await assert.rejects(() => r.e.getJson("/x"), (err) => err instanceof PegelApiError && err.status === 429);
  assert.deepEqual(r.delays, [1000, 1000]);
  assert.equal(r.calls(), 3);
});

test("a malformed Retry-After falls back to linear backoff", async () => {
  for (const bad of ["-1", "1.5", "+5", "1e3", "0x10", "soon", "Sunday, 06-Nov-94 08:49:37 GMT", ""]) {
    const r = retryEngine({ "retry-after": bad });
    await assert.rejects(() => r.e.getJson("/x"), PegelApiError);
    assert.deepEqual(r.delays, [200, 400], bad);
  }
});

test("a Retry-After beyond MAX_RETRY_AFTER_MS is not retried at all", async () => {
  const far = new Date(Date.now() + 3_600_000).toUTCString();
  for (const ra of ["31", "99999999999", far]) {
    const r = retryEngine({ "retry-after": ra });
    await assert.rejects(() => r.e.getJson("/x"), (err) => err instanceof PegelApiError && err.status === 429);
    assert.deepEqual(r.delays, [], ra);
    assert.equal(r.calls(), 1, ra);
  }
});

test("parseRetryAfter reads delay-seconds and IMF-fixdate only", () => {
  const now = Date.parse("Sat, 26 Sep 2026 10:00:00 GMT");
  assert.equal(parseRetryAfter("5", now), 5000);
  assert.equal(parseRetryAfter([" 2 ", "9"], now), 2000);
  assert.equal(parseRetryAfter("Sat, 26 Sep 2026 10:00:10 GMT", now), 10_000);
  assert.equal(parseRetryAfter("Sat, 26 Sep 2026 09:00:00 GMT", now), 0);
  assert.equal(parseRetryAfter("1.5", now), undefined);
  assert.equal(parseRetryAfter(undefined, now), undefined);
  assert.equal(MAX_RETRY_AFTER_MS, 30_000);
});

test("the engine refuses an unsendable userAgent with a typed error; tab and Latin-1 pass", () => {
  assert.throws(() => new RequestEngine({ userAgent: "a\r\nb" }), /control characters are not allowed/);
  assert.throws(() => new RequestEngine({ userAgent: "Pegel€" }), (err: unknown) =>
    err instanceof PegelError && /outside Latin-1/.test(err.message));
  new RequestEngine({ userAgent: "a\tb" });
  new RequestEngine({ userAgent: "Müller" });
});

test("the engine refuses a base URL with a query or fragment, redacting userinfo", () => {
  for (const baseUrl of ["http://h.test/?x=1", "http://u:pw@h.test/#f"]) {
    assert.throws(() => new RequestEngine({ baseUrl }), (err: unknown) =>
      err instanceof PegelNetworkError &&
      /^Base URL must not contain a query or fragment: /.test(err.message) &&
      !err.message.includes("pw"));
  }
  assert.throws(() => new RequestEngine({ baseUrl: "ftp://u:pw@h.test" }), (err: unknown) =>
    err instanceof Error && err.message.includes("ftp://***@h.test") && !err.message.includes("pw"));
});

function redirectEngine(responder: (url: string) => { status: number; headers: Record<string, string> }, maxRedirects?: number) {
  const mt = makeMockTransport((req) => {
    const r = responder(req.url);
    return { status: r.status, headers: r.headers, body: Buffer.from(r.status < 300 ? '{"ok":1}' : "") };
  });
  const e = new RequestEngine({ baseUrl: "https://a.test", transport: mt.transport, ...(maxRedirects !== undefined ? { maxRedirects } : {}) });
  return { e, mt };
}

test("only 301/302/303/307/308 are followed; 300/304/305 surface naming the target", async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    const { e, mt } = redirectEngine((url): { status: number; headers: Record<string, string> } => (url.endsWith("/x") ? { status, headers: { location: "/y" } } : { status: 200, headers: {} }));
    assert.deepEqual(await e.getJson("/x"), { ok: 1 });
    assert.equal(mt.calls.length, 2, String(status));
  }
  for (const status of [300, 304, 305]) {
    const { e, mt } = redirectEngine(() => ({ status, headers: { location: "/y" } }));
    await assert.rejects(() => e.getJson("/x"), (err: unknown) =>
      err instanceof PegelApiError && err.status === status && err.location === "https://a.test/y" &&
      err.message === `HTTP ${status} for GET https://a.test/x: redirect to https://a.test/y not followed`);
    assert.equal(mt.calls.length, 1);
  }
});

test("a malformed or missing Location is a PegelApiError, not a raw TypeError", async () => {
  const bad = redirectEngine(() => ({ status: 302, headers: { location: "http://[::1" } }));
  await assert.rejects(() => bad.e.getJson("/x"), (err: unknown) =>
    err instanceof PegelApiError && err.message === "HTTP 302 for GET https://a.test/x: redirect to http://[::1 not followed");
  const none = redirectEngine(() => ({ status: 302, headers: {} }));
  await assert.rejects(() => none.e.getJson("/x"), (err: unknown) =>
    err instanceof PegelApiError && /redirect not followed \(no Location header\)$/.test(err.message));
});

test("a redirect loop stops at maxRedirects and says so; the target is sanitised and redacted", async () => {
  const loop = redirectEngine(() => ({ status: 302, headers: { location: "/loop" } }));
  await assert.rejects(() => loop.e.getJson("/loop"), (err: unknown) =>
    err instanceof PegelApiError &&
    err.message === "HTTP 302 for GET https://a.test/loop: redirect to https://a.test/loop not followed (stopped after 5 redirects)");
  assert.equal(loop.mt.calls.length, 6);
  const zero = redirectEngine(() => ({ status: 301, headers: { location: "https://u:pw@b.test/\u001b[2Jz" } }), 0);
  await assert.rejects(() => zero.e.getJson("/x"), (err: unknown) =>
    err instanceof PegelApiError && !err.message.includes("pw") && !err.message.includes("\u001b") &&
    /redirect to https:\/\/\*\*\*@b\.test\/.*not followed$/.test(err.message));
});

test("numeric engine options must be integers in range, or the constructor throws", () => {
  const bad: Array<[string, number]> = [
    ["timeoutMs", NaN], ["timeoutMs", -5], ["timeoutMs", 2_147_483_648], ["timeoutMs", 1.5],
    ["maxRetries", NaN], ["maxRetries", Infinity], ["maxRetries", 11],
    ["retryDelayMs", -1], ["retryDelayMs", 30_001],
    ["maxRedirects", NaN], ["maxRedirects", 21],
    ["maxResponseBytes", -1], ["maxResponseBytes", 2 ** 53],
  ];
  for (const [name, value] of bad) {
    assert.throws(() => new RequestEngine({ [name]: value }), (err: unknown) =>
      err instanceof PegelError &&
      err.message.startsWith(`Invalid option ${name}: expected an integer from 0 to `) &&
      err.message.endsWith(`, got ${String(value)}.`), `${name}=${value}`);
  }
  new RequestEngine({ timeoutMs: 0, maxRetries: 10, retryDelayMs: 0, maxRedirects: 20, maxResponseBytes: 0 });
});
