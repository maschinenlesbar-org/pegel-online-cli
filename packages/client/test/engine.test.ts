import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { TextDecoder } from "node:util";
import assert from "node:assert/strict";
import {
  RequestEngine,
  bigIntegerKeysOption,
  cleartextProblem,
  firstInexactNumber,
  MAX_RETRY_AFTER_MS,
  parseRetryAfter,
  sanitizeServerText,
  scanNumbers,
  validateBaseUrl,
} from "../src/engine.js";
import {
  PegelApiError,
  PegelError,
  PegelNetworkError,
  PegelParseError,
  PegelValidationError,
  credentialsIn,
  cutText,
  echoedCredentialForms,
  TextBuilder,
  toWellFormed,
  typedUrlCredentials,
} from "../src/errors.js";
import { PegelOnlineClient } from "../src/client.js";
import { makeMockTransport, jsonResponse, rawResponse } from "./helpers.js";
import type { HttpResponse } from "../src/http.js";

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

test("a number the JSON cannot carry exactly is a parse error, never a changed value", async () => {
  // JSON.parse rounds 12345678901234567890 (in any form: .0, e0, E-1) and 9007199254740992.5 to the
  // nearest double, turns 1e400 into Infinity (printed as null) and 1e-400 into 0, silently.
  const body = (n: string) => `{"id":"a","n":${n},"text":"12345678901234567890 in a string"}`;
  for (const n of [
    "12345678901234567890", "-9007199254740993", "1e400", "-1E400", "12345678901234567890.0", "9007199254740993e0",
    "90071992547409930E-1", "9007199254740992.5", "-9007199254740992.5", "1e-400", "-0.0001e-399",
    "123456789012345678901234567890",
    // Subnormal: below 2.2250738585072014e-308 a double has fewer digits (D4).
    "3e-324", "4e-324", "-4.9e-324", "1.2345678901234567e-310", "2.225073858507201e-309",
  ]) {
    const e = new RequestEngine({ transport: makeMockTransport(() => rawResponse(body(n), "application/json")).transport });
    await assert.rejects(e.getJson("/items/a"), (err: unknown) => {
      assert.ok(err instanceof PegelParseError, n);
      assert.equal(err.message, `GET https://www.pegelonline.wsv.de/items/a: the number ${n} cannot be represented exactly.`);
      return true;
    });
  }
  // What a double carries exactly, or as JSON means it (a decimal fraction below 2^53), passes.
  // Gauge readings are decimals, and 99999 is the "no reading" marker the client maps to null.
  const exact: Array<[string, number]> = [
    ["9007199254740991", 9007199254740991], ["9007199254740992.0", 2 ** 53], ["9007199254740992e0", 2 ** 53],
    ["90071992547409920E-1", 2 ** 53], ["1e21", 1e21], ["1.2e21", 1.2e21], ["0", 0], ["-0", -0], ["0.0e-500", 0],
    ["1.10", 1.1], ["0.1", 0.1], ["1.00000000000000001", 1], ["5e-324", 5e-324],
    // A subnormal printed as written, and the smallest normal double (D4).
    ["-5e-324", -5e-324], ["1e-310", 1e-310], ["2.2250738585072014e-308", 2.2250738585072014e-308],
    // A double a server printed in its shortest form reads back as that double and prints as the
    // same number: not a changed value, though the decimal is not the double's exact binary value.
    ["1e23", 1e23], ["100000000000000000000000", 1e23], ["1E23", 1e23], ["1.7976931348623157E308", Number.MAX_VALUE], ["-1.7976931348623157e308", -Number.MAX_VALUE],
    ["4.35e30", 4.35e30], ["99999", 99999], ["576.3", 576.3], ["-12.25", -12.25], ["50.937531", 50.937531],
  ];
  for (const [n, value] of exact) {
    const e = new RequestEngine({ transport: makeMockTransport(() => rawResponse(body(n), "application/json")).transport });
    assert.equal((await e.getJson<{ n: number }>("/x")).n, value, n);
  }
});

test("the number check skips strings and costs one pass over the text", async () => {
  // Escaped quotes and backslashes must not end a string early and expose its digits.
  const tricky = `{"id":"a","s":"\\\\\\"12345678901234567890\\\\","t":"1e400","n":[1,2.5,-3e2]}`;
  const e = new RequestEngine({ transport: makeMockTransport(() => rawResponse(tricky, "application/json")).transport });
  assert.deepEqual(await e.getJson("/x"), JSON.parse(tricky));
  // 1 MB of numbers: the scan is linear.
  const big = `[${Array.from({ length: 200_000 }, (_, i) => i * 7).join(",")}]`;
  const f = new RequestEngine({ transport: makeMockTransport(() => rawResponse(big, "application/json")).transport });
  assert.equal((await f.getJson<number[]>("/x")).length, 200_000);
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
      // ...and so are whole escape sequences, while the printable text is preserved.
      assert.equal(err.detail, "boomred");
      return true;
    },
  );
});

test("a non-http(s) base URL is rejected at construction, before any request", () => {
  for (const baseUrl of ["file:///etc/passwd", "ftp://example.org"]) {
    const mt = makeMockTransport(() => jsonResponse({}));
    assert.throws(
      () => new RequestEngine({ baseUrl, transport: mt.transport }),
      (err) =>
        err instanceof PegelValidationError &&
        !(err instanceof PegelNetworkError) &&
        err.message === "Invalid baseUrl: Only http and https URLs are supported.",
    );
    assert.equal(mt.calls.length, 0);
  }
});

test("an unparseable base URL is rejected at construction", () => {
  const mt = makeMockTransport(() => jsonResponse({}));
  assert.throws(
    () => new RequestEngine({ baseUrl: "not-a-url", transport: mt.transport }),
    (err) =>
      err instanceof PegelValidationError && err.message === "Invalid baseUrl: Expected an absolute http(s) URL.",
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
  assert.throws(() => new RequestEngine({ userAgent: "a\r\nb" }), (err: unknown) =>
    err instanceof PegelValidationError && err.message === "Invalid User-Agent: Value contains control characters.");
  assert.throws(() => new RequestEngine({ userAgent: "Pegel€" }), (err: unknown) =>
    err instanceof PegelValidationError && /outside Latin-1/.test(err.message));
  for (const userAgent of ["", "  ", "\t"]) {
    assert.throws(() => new RequestEngine({ userAgent }), (err: unknown) =>
      err instanceof PegelValidationError && err.message === "Invalid User-Agent: Expected a non-empty value.");
  }
  new RequestEngine({ userAgent: "a\tb" });
  new RequestEngine({ userAgent: "Müller" });
});

test("the engine refuses a base URL with a query or fragment, never echoing userinfo", () => {
  for (const baseUrl of ["http://h.test/?x=1", "http://u:pw@h.test/#f"]) {
    assert.throws(() => new RequestEngine({ baseUrl }), (err: unknown) =>
      err instanceof PegelValidationError &&
      err.message === "Invalid baseUrl: A base URL cannot have a query (?) or fragment (#).");
  }
  assert.throws(() => new RequestEngine({ baseUrl: "ftp://u:pw@h.test" }), (err: unknown) =>
    err instanceof PegelValidationError && !err.message.includes("pw"));
});

test("validateBaseUrl returns the base URL without trailing slashes, or throws PegelValidationError", () => {
  assert.equal(validateBaseUrl("https://h.test/proxy//"), "https://h.test/proxy");
  assert.equal(validateBaseUrl("https://u:pw@h.test"), "https://u:pw@h.test");
  assert.throws(() => validateBaseUrl("https://h.test/ "), PegelValidationError);
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

test("Location is read from a Headers object, a Map and any header case (04#2)", async () => {
  for (const headers of [new Headers({ Location: "/y" }), new Map([["Location", "/y"]]), { Location: "/y" }, { LOCATION: "/y" }]) {
    const mt = makeMockTransport((req) =>
      req.url.endsWith("/x")
        ? { status: 302, headers: headers as unknown as Record<string, string>, body: Buffer.alloc(0) }
        : jsonResponse({ ok: 1 }));
    const e = new RequestEngine({ baseUrl: "https://a.test", transport: mt.transport });
    assert.deepEqual(await e.getJson("/x"), { ok: 1 }, headers.constructor.name);
    assert.equal(mt.last().url, "https://a.test/y");
  }
});

test("a non-http(s) redirect target is refused before the transport sees it", async () => {
  for (const target of ["file:///etc/passwd", "data:text/plain,x", "javascript:alert(1)"]) {
    const mt = makeMockTransport(() => ({ status: 302, headers: { location: target }, body: Buffer.alloc(0) }));
    const e = new RequestEngine({ baseUrl: "https://a.test", transport: mt.transport });
    await assert.rejects(() => e.getJson("/x"), (err: unknown) =>
      err instanceof PegelApiError && err.status === 302 && /not followed$/.test(err.message), target);
    assert.equal(mt.calls.length, 1, target);
  }
});

test("a transport failure names the request and keeps the original as cause (03#4)", async () => {
  const reset = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
  const e = new RequestEngine({ baseUrl: "https://a.test", maxRetries: 0, transport: async () => { throw reset; } });
  await assert.rejects(() => e.getJson("/stations/BONN.json"), (err: unknown) =>
    err instanceof PegelNetworkError && err.cause === reset &&
    err.message === "GET https://a.test/stations/BONN.json failed: socket hang up");
});

test("the size-limit message names --max-response-bytes (03#5)", async () => {
  const e = new RequestEngine({ maxResponseBytes: 95, transport: async () => jsonResponse({ pad: "x".repeat(100) }) });
  await assert.rejects(() => e.getJson("/x"), (err: unknown) =>
    err instanceof PegelNetworkError && /size limit of 95 bytes \(maxResponseBytes; --max-response-bytes on the CLI\)/.test(err.message));
});

test("a body is decoded by its declared charset; a BOM is dropped; an unknown charset is a parse error (03#3)", async () => {
  const latin1 = Buffer.from(JSON.stringify({ shortname: "KÖLN" }), "latin1");
  const e1 = new RequestEngine({ transport: async () => rawResponse(latin1, "application/json; charset=iso-8859-1") });
  assert.deepEqual(await e1.getJson("/x"), { shortname: "KÖLN" });
  const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"a":1}')]);
  const e2 = new RequestEngine({ transport: async () => rawResponse(bom, "application/json") });
  assert.deepEqual(await e2.getJson("/x"), { a: 1 });
  const e3 = new RequestEngine({ transport: async () => rawResponse('{"a":1}', "application/json; charset=x-no-such") });
  await assert.rejects(() => e3.getJson("/x"), (err: unknown) =>
    err instanceof PegelParseError && err.message === 'GET https://www.pegelonline.wsv.de/x: unsupported response charset "x-no-such".');
});

test("server text in a message is cut at 500 characters; the body keeps it all (P13)", async () => {
  const long = "x".repeat(200_000);
  const e = new RequestEngine({ maxRetries: 0, transport: async () => jsonResponse({ detail: long }, 500) });
  await assert.rejects(() => e.getJson("/x"), (err: unknown) =>
    err instanceof PegelApiError && err.detail === `${"x".repeat(500)}…` && err.message.length < 700 && err.body.includes(long));
});

test("cleartextProblem: the wording, loopback exemptions, never the secret", () => {
  assert.equal(cleartextProblem("not a url"), undefined);
  assert.equal(cleartextProblem("https://alice:pw@mirror.example"), undefined);
  for (const loop of ["http://localhost:8080", "http://127.4.5.6", "http://[::1]:9", "http://alice:pw@localhost"]) {
    assert.equal(cleartextProblem(loop), undefined, loop);
  }
  assert.equal(
    cleartextProblem("http://mirror.example:8080/api"),
    "requests to mirror.example:8080 are sent unencrypted (http:, not https:)",
  );
  assert.equal(
    cleartextProblem("http://alice:s3cret@mirror.example"),
    "the base URL's credentials are sent unencrypted to mirror.example (http:, not https:)",
  );
  assert.equal(
    cleartextProblem("http://alice:s3cret@mirror.example", ["the API key"]),
    "the API key and the base URL's credentials are sent unencrypted to mirror.example (http:, not https:)",
  );
  assert.equal(
    cleartextProblem("http://mirror.example", ["the API key"]),
    "the API key is sent unencrypted to mirror.example (http:, not https:)",
  );
});

test("cutText never cuts inside a surrogate pair; toWellFormed replaces half a character", () => {
  assert.equal(cutText("ab\u{1f600}cd", 3), "ab");
  assert.equal(cutText("ab\u{1f600}cd", 4), "ab\u{1f600}");
  assert.equal(cutText("short", 10), "short");
  assert.equal(toWellFormed("a\ud83d b\ude00 \u{1f600}"), "a\ufffd b\ufffd \u{1f600}");
});

test("a server detail cut at 500 characters keeps the message well-formed", async () => {
  const detail = "a" + "\u{1f600}".repeat(400);
  const e = new RequestEngine({ maxRetries: 0, transport: async () => jsonResponse({ detail }, 500) });
  await assert.rejects(() => e.getJson("/x"), (err: unknown) => {
    assert.ok(err instanceof PegelApiError);
    assert.equal(toWellFormed(err.message), err.message);
    assert.match(err.message, /…$/);
    return true;
  });
});

test("own messages quote a server or user value at most 200 characters long (L3)", async () => {
  const long = "x".repeat(5000);
  const charset = new RequestEngine({ transport: async () => rawResponse("[]", `application/json; charset=${long}`) });
  await assert.rejects(() => charset.getJson("/x"), (err: unknown) =>
    err instanceof PegelParseError && err.message.length < 400 && /charset "x+…"/.test(err.message));
  const client = new PegelOnlineClient({ transport: async () => jsonResponse([]) });
  await assert.rejects(() => client.stations.list({ [long]: "1" } as never), (err: unknown) =>
    err instanceof PegelValidationError && err.message.length < 600 && /Unknown key "x+"…/.test(err.message));
  await assert.rejects(() => client.stations.get(" ".repeat(5000)), (err: unknown) =>
    err instanceof PegelValidationError && err.message.length < 400);
  assert.throws(() => new RequestEngine({ headers: { [long]: "\u0001" } }), (err: unknown) =>
    err instanceof PegelValidationError && err.message.length < 400);
});

test("credentials a server echoes are scrubbed from the error: Basic, user:password, password (L13)", async () => {
  // Node's transport sends the pair UTF-8 encoded, so that is the form a server echoes.
  const basic = Buffer.from("alice:pä ss-pw", "utf8").toString("base64");
  const body = JSON.stringify({ message: `no: Basic ${basic} / alice:pä ss-pw / pä ss-pw` });
  const engine = new RequestEngine({
    baseUrl: "https://alice:p%C3%A4%20ss-pw@mirror.example",
    maxRetries: 0,
    transport: async () => ({ status: 401, headers: { "content-type": "application/json" }, body: Buffer.from(body) }),
  });
  await assert.rejects(engine.getJson("/x"), (err: unknown) => {
    assert.ok(err instanceof PegelApiError);
    for (const form of [basic, "alice:pä ss-pw", "pä ss-pw"]) assert.ok(!err.message.includes(form), err.message);
    assert.match(err.message, /no: Basic \*\*\* \/ \*\*\* \/ \*\*\*/);
    return true;
  });
});

test("a header named __proto__ is an ordinary header, never the prototype of the headers read (T12)", async () => {
  // A JavaScript transport may return any object; JSON.parse makes "__proto__" an own key.
  const headers = JSON.parse('{"__proto__":{"content-type":"application/json; charset=bogus"}}') as Record<string, string>;
  const e = new RequestEngine({ transport: async () => ({ status: 200, headers, body: Buffer.from('{"a":1}') }) });
  // With the prototype set, its "content-type" was read as the answer's, and the bogus charset refused it.
  assert.deepEqual(await e.getJson("/x"), { a: 1 });
  const fetchLike = new Headers([["__proto__", "x"], ["content-type", "application/json"]]);
  const f = new RequestEngine({ transport: async () => ({ status: 200, headers: fetchLike as unknown as Record<string, string>, body: Buffer.from('{"a":1}') }) });
  assert.deepEqual(await f.getJson("/x"), { a: 1 });
});

test("bigIntegerKeys: a declared member's number is its exact literal as a string; others keep the rule (D3)", async () => {
  const body = '{"_version_":1858054135406919680,"small":{"_version_":5},"neg":{"\\u005fversion_":-12345678901234567890},' +
    '"s":{"_version_":"text"},"n":{"_version_":null},"arr":{"_version_":[1]},"t":"\\"_version_\\":1","n2":42}';
  const e = new RequestEngine({
    bigIntegerKeys: new Set(["_version_"]),
    transport: makeMockTransport(() => rawResponse(body, "application/json")).transport,
  });
  assert.deepEqual(await e.getJson("/x"), {
    _version_: "1858054135406919680", small: { _version_: "5" }, neg: { _version_: "-12345678901234567890" },
    s: { _version_: "text" }, n: { _version_: null }, arr: { _version_: [1] }, t: '"_version_":1', n2: 42,
  });
  assert.deepEqual([...e.bigIntegerKeys], ["_version_"]);
  // An undeclared big number is still refused; a declared member doesn't make others exact.
  const other = new RequestEngine({
    bigIntegerKeys: ["_version_"] as unknown as ReadonlySet<string>,
    transport: makeMockTransport(() => rawResponse('{"_version_":1858054135406919680,"id":12345678901234567890}', "application/json")).transport,
  });
  await assert.rejects(other.getJson("/x"), /the number 12345678901234567890 cannot be represented exactly/);
  // Malformed stays malformed: a declared member with a leading zero still fails JSON.parse.
  const malformed = new RequestEngine({ bigIntegerKeys: new Set(["_version_"]), transport: makeMockTransport(() => rawResponse('{"_version_":01}', "application/json")).transport });
  await assert.rejects(malformed.getJson("/x"), PegelParseError);
  for (const bad of [new Set([""]), new Set([1]), "x", 5, null]) {
    assert.throws(() => new RequestEngine({ bigIntegerKeys: bad as unknown as ReadonlySet<string> }),
      (err: unknown) => err instanceof PegelValidationError && err.message === "Invalid option bigIntegerKeys: expected a set of non-empty member names.");
  }
  // The option reader copies a set or a list; undefined is none.
  const names = new Set(["a"]);
  const copy = bigIntegerKeysOption(names);
  names.add("b");
  assert.deepEqual([...copy], ["a"]);
  assert.deepEqual([...bigIntegerKeysOption(["x", "y"] as unknown as ReadonlySet<string>)], ["x", "y"]);
  assert.equal(bigIntegerKeysOption(undefined).size, 0);
  // Without declarations the scan is the plain number check.
  assert.equal(firstInexactNumber('{"a":"1e400","b":3e-324}'), "3e-324");
  assert.deepEqual(scanNumbers('{"a":1}'), { json: '{"a":1}', inexact: undefined });
});

test("an answer error names the request: method and URL, userinfo redacted (D9)", async () => {
  const answers: Array<[string, () => HttpResponse]> = [
    ["not valid JSON", () => rawResponse("<html>", "text/html")],
    ["empty response body", () => rawResponse(" ", "application/json")],
    ["cannot be represented exactly", () => rawResponse('{"n":1e400}', "application/json")],
    ["unsupported response charset", () => rawResponse("{}", "application/json; charset=x-bogus")],
    ["unsupported Content-Encoding", () => ({ status: 200, headers: { "content-type": "application/json", "content-encoding": "br" }, body: Buffer.from("{}") })],
  ];
  const base = new URL("https://www.pegelonline.wsv.de");
  base.username = "alice";
  base.password = "s3cret";
  for (const [what, respond] of answers) {
    const e = new RequestEngine({ baseUrl: base.href, transport: makeMockTransport(respond).transport });
    await assert.rejects(e.getJson("/items", { q: "x" }), (err: unknown) => {
      assert.ok(err instanceof PegelParseError, what);
      assert.ok(err.message.startsWith(`GET ${base.protocol}//***@${base.host}`), err.message);
      assert.ok(err.message.includes("/items?q=x: ") && err.message.includes(what), err.message);
      assert.ok(!err.message.includes("s3cret"), err.message);
      return true;
    });
  }
  // An HTML page names its type; a gzip body names its coding; an identity coding is no coding.
  const html = new RequestEngine({ transport: async () => rawResponse("<html>", "text/html; charset=utf-8") });
  await assert.rejects(html.getJson("/x"), (err: Error) =>
    err.message === 'GET https://www.pegelonline.wsv.de/x: the answer is not valid JSON (expected JSON, got Content-Type "text/html").');
  const gzip = new RequestEngine({ transport: async () => ({ status: 200, headers: { "content-type": "application/json", "content-encoding": "gzip" }, body: Buffer.from("{}") }) });
  await assert.rejects(gzip.getJson("/x"), (err: Error) =>
    err.message === 'GET https://www.pegelonline.wsv.de/x: unsupported Content-Encoding "gzip" (the client does not decompress responses).');
  const identity = new RequestEngine({ transport: async () => ({ status: 200, headers: { "content-type": "application/json", "content-encoding": "identity" }, body: Buffer.from('{"a":1}') }) });
  assert.deepEqual(await identity.getJson("/x"), { a: 1 });
});

test("text that is not valid is replaced with U+FFFD and reported through onWarning, never silently (D2)", async () => {
  const cases: Array<[string, Buffer, string, unknown, number]> = [
    // A lone surrogate written as an escape (high alone, low alone); a real pair and an escaped backslash stay.
    ["lone escapes", Buffer.from('{"a":"x\\ud800y","b":"\\udc00","c":"\\ud83d\\ude00","d":"\\\\ud800"}'), "application/json", { a: "x\ufffdy", b: "\ufffd", c: "\u{1f600}", d: "\\ud800" }, 2],
    // A lone surrogate in a member name.
    ["lone in a key", Buffer.from('{"\\udbff":1}'), "application/json", { "\ufffd": 1 }, 1],
    // Invalid UTF-8 bytes; a U+FFFD the server sent is not counted.
    ["invalid bytes", Buffer.concat([Buffer.from('{"a":"'), Buffer.from([0xff, 0xc3]), Buffer.from('","b":"\ufffd"}')]), "application/json", { a: "\ufffd\ufffd", b: "\ufffd" }, 2],
    // A byte undefined in a single-byte charset.
    ["iso-8859-3", Buffer.concat([Buffer.from('{"a":"'), Buffer.from([0xa5]), Buffer.from('"}')]), "application/json; charset=iso-8859-3", { a: "\ufffd" }, 1],
  ];
  for (const [label, body, type, expected, count] of cases) {
    const warnings: string[] = [];
    const e = new RequestEngine({ onWarning: (m) => warnings.push(m), transport: makeMockTransport(() => rawResponse(body, type)).transport });
    const value = await e.getJson("/items", { q: "x" });
    assert.deepEqual(value, expected, label);
    assert.ok(!/[\ud800-\udfff]/u.test(JSON.stringify(value)), `${label}: well-formed`);
    assert.deepEqual(warnings, [
      `GET https://www.pegelonline.wsv.de/items?q=x: ${count} ${count === 1 ? "character" : "characters"} of the answer ${count === 1 ? "was" : "were"} not valid text (invalid bytes or a lone surrogate) and replaced with U+FFFD.`,
    ], label);
  }
  // Valid text: no warning; a throwing hook never fails the request.
  const quiet: string[] = [];
  const ok = new RequestEngine({ onWarning: (m) => quiet.push(m), transport: makeMockTransport(() => rawResponse('{"a":"\\u00fc\ufffd"}', "application/json")).transport });
  assert.deepEqual(await ok.getJson("/x"), { a: "ü\ufffd" });
  assert.deepEqual(quiet, []);
  const throwing = new RequestEngine({ onWarning: () => { throw new Error("hook"); }, transport: makeMockTransport(() => rawResponse('"\\ud800"', "application/json")).transport });
  assert.equal(await throwing.getJson("/x"), "\ufffd");
  assert.throws(() => new RequestEngine({ onWarning: "log" as unknown as () => void }), PegelValidationError);
});

test("an answer longer than V8's longest string is a PegelParseError naming the request, not a plain Error (T14)", async (t) => {
  // A real one needs a body of 512 MB and more (possible with maxResponseBytes 0): V8's own
  // error is stood in for, for the body marked by its length.
  const huge = Buffer.from('[{"shortname":"a","longname":"b"}]            ');
  const tooLong = Object.assign(new Error("Cannot create a string longer than 0x1fffffe8 characters"), { code: "ERR_STRING_TOO_LONG" });
  const decode = TextDecoder.prototype.decode;
  t.mock.method(TextDecoder.prototype, "decode", function (this: InstanceType<typeof TextDecoder>, input?: Uint8Array, options?: { stream?: boolean }) {
    if (input !== undefined && input.byteLength === huge.length) throw tooLong;
    return decode.call(this, input, options);
  });
  const toString = Buffer.prototype.toString;
  t.mock.method(Buffer.prototype, "toString", function (this: Buffer, ...args: Parameters<Buffer["toString"]>) {
    if (this.length === huge.length && args[0] === "utf8") throw tooLong;
    return toString.apply(this, args);
  });
  const e = new RequestEngine({ maxResponseBytes: 0, transport: makeMockTransport(() => rawResponse(huge, "application/json")).transport });
  await assert.rejects(e.getJson("/waters.json", { q: "1=1" }), (err: unknown) => {
    assert.ok(err instanceof PegelParseError, String(err));
    assert.equal(
      err.message,
      `GET https://www.pegelonline.wsv.de/waters.json?q=1%3D1: the answer is too large to read as text (${huge.length} bytes; the longest string is 536870888 characters).`,
    );
    return true;
  });
  // An error status with such a body is still the API error, without the unreadable body.
  const failing = new RequestEngine({ maxResponseBytes: 0, transport: makeMockTransport(() => rawResponse(huge, "text/plain", 500)).transport });
  await assert.rejects(failing.getJson("/waters.json"), (err: unknown) => err instanceof PegelApiError && err.status === 500 && err.body === "");
});

test("sanitizeServerText drops whole escape sequences, not just their control bytes", () => {
  const CSI8 = String.fromCharCode(0x9b);
  const OSC8 = String.fromCharCode(0x9d);
  const ST8 = String.fromCharCode(0x9c);
  for (const [input, expected] of [
    [`line1 ${ESC}]0;title${BEL}rest`, "line1 rest"],
    [`${ESC}]8;;https://evil.example${ESC}\\click${ESC}]8;;${ESC}\\`, "click"],
    [`${ESC}[31mred${ESC}[0m plain`, "red plain"],
    [`${ESC}[1;31;4mbold`, "bold"],
    [`${CSI8}2Jcleared`, "cleared"],
    [`${OSC8}0;t${ST8}ok`, "ok"],
    [`a${ESC}7b${ESC}(Bc`, "abc"],
    // Unterminated: only ESC and its introducer go, the text stays.
    [`keep ${ESC}]0;no terminator here`, "keep 0;no terminator here"],
  ] as const) {
    assert.equal(sanitizeServerText(input), expected, JSON.stringify(input));
  }
});

test("sanitizeServerText reads a bounded prefix and drops what the per-character filter dropped", () => {
  // The per-character filter, one character at a time: C0 but TAB to CR, DEL, C1 and Cf go.
  const perCharacter = (text: string): string =>
    [...text]
      .filter((ch) => {
        const n = ch.codePointAt(0) ?? 0;
        return (n >= 0x09 && n <= 0x0d) || !(n <= 0x1f || (n >= 0x7f && n <= 0x9f) || /\p{Cf}/u.test(ch));
      })
      .join("")
      .replace(/\s+/g, " ")
      .trim();
  const every = Array.from({ length: 0x3000 }, (_, i) => String.fromCharCode(i)).join("") + "\u{1f600}\u{e0001}\ud800x";
  for (let at = 0; at < every.length; at += 512) {
    const piece = every.slice(at, at + 512).replace(/[\u001b\u0090\u0098\u009b-\u009f]/g, "");
    assert.equal(sanitizeServerText(piece), perCharacter(piece), `from U+${at.toString(16)}`);
  }
  // At most 16 384 units of the text are read, never half a surrogate pair.
  assert.equal(sanitizeServerText("x".repeat(100_000)).length, 16_384);
  assert.equal(sanitizeServerText(`${"x".repeat(16_383)}\u{1f600}`), "x".repeat(16_383));
  // A control string ends at another introducer: the first is dropped by the filter, the second
  // string as a whole.
  const OSC8 = String.fromCharCode(0x9d);
  const ST8 = String.fromCharCode(0x9c);
  assert.equal(sanitizeServerText(`a${OSC8}0;x${OSC8}0;t${ST8}b`), "a0;xb");
  assert.equal(sanitizeServerText(`a${ESC}]0;x${ESC}]0;t${BEL}b`), "a0;xb");
});

test("an error answer of unterminated control-string introducers is cleaned in linear time", async () => {
  for (const introducer of ["\u009d", "\u0090", "\u0098", "\u009e", "\u009f", `${ESC}]`]) {
    const e = new RequestEngine({ maxRetries: 0, transport: makeMockTransport(() => jsonResponse({ detail: introducer.repeat(100_000) }, 500)).transport });
    const started = performance.now();
    await assert.rejects(e.getJson("/x"), PegelApiError);
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 1000, `${JSON.stringify(introducer)}: ${Math.round(elapsed)} ms`);
  }
});

test("a TextBuilder joins its pieces in order across batches", () => {
  const b = new TextBuilder();
  const expected: string[] = [];
  for (let i = 0; i < 40_000; i++) {
    b.push(String(i), ",");
    expected.push(String(i), ",");
  }
  assert.equal(b.toString(), expected.join(""));
  assert.equal(new TextBuilder().toString(), "");
});

// These tests start a process with a small heap: 30 s instead of the suite's 5 s.
const STARTS_A_PROCESS = { timeout: 30_000 };

/** Run `script` (an ES module that imports the built engine as `engine`) under a 128 MB heap; its stdout. */
function inSmallHeap(script: string): string {
  const engine = new URL("../src/engine.js", import.meta.url).href;
  return execFileSync(
    process.execPath,
    ["--max-old-space-size=128", "--input-type=module", "-e", `const engine = await import(${JSON.stringify(engine)});${script}`],
    { encoding: "utf8" },
  );
}

test("a 16 MB error detail ends as an API error within a small heap", STARTS_A_PROCESS, () => {
  // One `+=` per character of the uncut detail made a rope node each: 8 MB aborted a 256 MB heap.
  const out = inSmallHeap(
    `const body = Buffer.from(JSON.stringify({ detail: "a\u00e4".repeat(8 * 1024 * 1024) }));` +
      `const e = new engine.RequestEngine({ maxRetries: 0, transport: async () => ({ status: 404, headers: { "content-type": "application/json" }, body }) });` +
      `try { await e.getJson("/x"); } catch (err) { process.stdout.write(err.constructor.name + " " + err.detail.length); }`,
  );
  assert.equal(out, "PegelApiError 501");
});

test("an answer of millions of lone surrogate escapes is repaired within a small heap", STARTS_A_PROCESS, () => {
  // One `+=` per repair made a rope node each: 6 million of them exhausted a 128 MB heap.
  const out = inSmallHeap(
    `const body = Buffer.from('["' + "\\\\ud800".repeat(6_000_000) + '"]');` +
      `const e = new engine.RequestEngine({ transport: async () => ({ status: 200, headers: { "content-type": "application/json" }, body }) });` +
      `const [text] = await e.getJson("/x"); process.stdout.write(String(text.length));`,
  );
  assert.equal(out, "6000000");
});

test("scanNumbers quotes millions of declared members within a small heap", STARTS_A_PROCESS, () => {
  // One `+=` per quoted member made a rope node each: 3 million of them exhausted a 128 MB heap.
  const n = 3_000_000;
  const out = inSmallHeap(
    `const json = "[" + '{"k":1},'.repeat(${n - 1}) + '{"k":1}]';` +
      `process.stdout.write(String(engine.scanNumbers(json, new Set(["k"])).json.length));`,
  );
  assert.equal(out, String(n * 10 + 1));
});

test("a credential echoed with JSON escapes is scrubbed from the message, the detail and the decoded body", async () => {
  // A JSON writer escapes some characters of an echoed password (a quote always, "/" with PHP's
  // json_encode, a non-ASCII letter with Python's json.dumps): the scrub of the text as sent
  // missed that spelling, and JSON.parse put the plain password into .detail and .message.
  const password = 'p"w/ä-secret';
  const baseUrl = `https://alice:${encodeURIComponent(password)}@mirror.example`;
  const escapings = [
    JSON.stringify(password), // the quote escaped
    JSON.stringify(password).replace(/\//g, "\\/").replace(/ä/g, "\\u00e4"), // PHP / Python style
    `"${[...password].map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`).join("")}"`, // every character
  ];
  for (const status of [401, 500]) {
    for (const quoted of escapings) {
      for (const key of ["detail", "message"]) {
        const body = `{"${key}":"wrong password ${quoted.slice(1)}}`;
        const e = new RequestEngine({ baseUrl, maxRetries: 0, transport: async () => rawResponse(body, "application/json", status) });
        const err = await e.getJson("/x").catch((caught: unknown) => caught);
        assert.ok(err instanceof PegelApiError, `${body}: ${String(err)}`);
        assert.ok(err.detail?.startsWith("wrong password"), `${body}: ${err.detail}`);
        for (const text of [err.message, err.detail ?? "", JSON.stringify(JSON.parse(err.body))]) {
          assert.ok(!text.includes("secret"), `${status} ${body}: ${text}`);
        }
      }
    }
  }
});

test("an error body keeps its spelling unless a credential hides behind an escape", async () => {
  const base = "https://alice:s3cret-pw@mirror.example";
  const bodyOf = async (body: string): Promise<string> => {
    const e = new RequestEngine({ baseUrl: base, maxRetries: 0, transport: async () => rawResponse(body, "application/json", 500) });
    const err = await e.getJson("/x").catch((caught: unknown) => caught);
    assert.ok(err instanceof PegelApiError, String(err));
    return err.body;
  };
  // No credential, or one spelled as sent: the body as sent (scrubbed), escapes kept.
  assert.equal(await bodyOf('{"m":"caf\\u00e9 \\"x\\""}'), '{"m":"caf\\u00e9 \\"x\\""}');
  assert.equal(await bodyOf('{"m":"pw s3cret-pw \\u00e9"}'), '{"m":"pw *** \\u00e9"}');
  // Escaped: written again decoded, scrubbed in that spelling.
  assert.equal(await bodyOf('{"m":"pw s3cret\\u002dpw \\u00e9"}'), '{"m":"pw *** é"}');
  // Not JSON: nobody decodes it, it stays as sent.
  assert.equal(await bodyOf("pw s3cret\\u002dpw"), "pw s3cret\\u002dpw");
  // Deeply nested: written again where this runtime can, else left out (probed, not assumed:
  // whether JSON.stringify recurses depends on the Node version).
  const deep = `${"[".repeat(200_000)}"s3cret\\u002dpw"${"]".repeat(200_000)}`;
  let parses = true;
  let writes = true;
  try {
    const value: unknown = JSON.parse(deep);
    try {
      JSON.stringify(value);
    } catch {
      writes = false;
    }
  } catch {
    parses = false;
  }
  if (parses) {
    const body = await bodyOf(deep);
    assert.ok(!body.includes("s3cret"), body.slice(199_990, 200_030));
    assert.equal(body === "", !writes);
  }
});

test("an echo of the request URL as sent is scrubbed, a short password too", async () => {
  // Typed raw; WHATWG spells it `p%22%C3%A4` in the URL (as Node's http reads it), which a
  // server or a transport echoes.
  const e = new RequestEngine({
    baseUrl: 'https://alice:p"ä@mirror.example',
    maxRetries: 0,
    transport: async (req) => rawResponse(JSON.stringify({ message: `no access: ${new URL(req.url).href}` }), "application/json", 403),
  });
  const err = await e.getJson("/x").catch((caught: unknown) => caught);
  assert.ok(err instanceof PegelApiError, String(err));
  for (const text of [err.message, err.detail ?? "", err.body]) {
    assert.ok(!text.includes("p%22%C3%A4@") && !text.includes('p"ä@'), text);
  }
});

test("a number with a long run of zeros is refused in linear time (security audit 2026-10-27, A)", async () => {
  // The trailing-zero regex `/0+$/` tried a match at every zero of a run that doesn't end the
  // digits: 1.<100 000 zeros>1e300 took about 15 s, after the answer was in (past --timeout).
  const literal = `1.${"0".repeat(100_000)}1e300`;
  let start = performance.now();
  assert.equal(scanNumbers(`[${literal}]`).inexact, literal);
  assert.ok(performance.now() - start < 1000, `scanNumbers: ${Math.round(performance.now() - start)} ms`);
  // The same through a request: one clean parse error, the literal cut in the message.
  const e = new RequestEngine({ maxRetries: 0, transport: makeMockTransport(() => rawResponse(`{"n":${literal}}`, "application/json")).transport });
  start = performance.now();
  await assert.rejects(e.getJson("/x"), (err) => {
    assert.ok(err instanceof PegelParseError);
    assert.match(err.message, /cannot be represented exactly/);
    assert.ok(err.message.length < 1000, "the message quotes the literal cut");
    return true;
  });
  assert.ok(performance.now() - start < 1000, `getJson: ${Math.round(performance.now() - start)} ms`);
  // Same digits and exponent as before: zeros at both ends are still dropped, inner ones kept.
  assert.equal(firstInexactNumber(`[12345678901234567890.0000]`), "12345678901234567890.0000");
  assert.equal(firstInexactNumber(`[9007199254740992.000]`), undefined);
  assert.equal(firstInexactNumber(`[1${"0".repeat(400)}]`), `1${"0".repeat(400)}`);
  assert.equal(firstInexactNumber(`[1e300, 1000e297, 0.001e303, 0e0, 0.000]`), undefined);
});

test("a credential in a redirect's Location is named in no message, followed or not (security audit 2026-10-27, D2)", async () => {
  // The engine follows redirects, so a Location's text becomes the URL every later message names
  // (the API error, a network failure, onRetry) as well as the target of the last one. The
  // Location was resolved and only its own userinfo redacted: the base URL's password in its
  // path or query reached every message.
  const PW = "pä\"s's-W0rd";
  const base = `https://alice:${encodeURIComponent(PW)}@mirror.example`;
  const basic = Buffer.from(`alice:${PW}`, "utf8").toString("base64");
  const secrets = [PW, `alice:${PW}`, basic];
  const decoded = (text: string): string => {
    try {
      return decodeURIComponent(text);
    } catch {
      return text;
    }
  };
  const seen = (err: unknown, retried: string[] = []): string => {
    const e = err as { message?: unknown; location?: unknown; url?: unknown };
    return decoded([e.message, e.location, e.url, ...retried].map(String).join("\n"));
  };
  const locations = [
    `https://elsewhere.example/login?user=alice&pw=${encodeURIComponent(PW)}`,
    `https://elsewhere.example/login?pw=${PW}`,
    `https://elsewhere.example/${encodeURIComponent(`alice:${PW}`)}/x`,
    `https://elsewhere.example/auth?basic=${basic}`,
    `/relative/${PW}`,
    `relative/${encodeURIComponent(PW)}/`,
  ];
  for (const location of locations) {
    // Answered with this 302 forever: the limit names the last URL and its target.
    const loop = new RequestEngine({ baseUrl: base, maxRetries: 0, transport: async () => ({ status: 302, headers: { location }, body: Buffer.alloc(0) }) });
    const err = await loop.getJson("/x").catch((caught: unknown) => caught);
    assert.ok(err instanceof PegelApiError && /stopped after 5 redirects/.test(err.message), String(err));
    for (const secret of secrets) assert.ok(!seen(err).includes(secret), `${location}: ${seen(err)}`);
    // Followed once, then a 500, a 503 retried, or a failed connection: each names the URL followed.
    for (const after of ["500", "503", "reset"] as const) {
      const retried: string[] = [];
      let calls = 0;
      const once = new RequestEngine({
        baseUrl: base,
        maxRetries: 1,
        sleep: async () => {},
        onRetry: (event) => retried.push(event.url),
        transport: async () => {
          calls += 1;
          if (calls === 1) return { status: 302, headers: { location }, body: Buffer.alloc(0) };
          if (after === "reset") throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
          return { status: Number(after), headers: {}, body: Buffer.alloc(0) };
        },
      });
      const failed = await once.getJson("/x").catch((caught: unknown) => caught);
      assert.ok(failed instanceof PegelError, String(failed));
      for (const secret of secrets) assert.ok(!seen(failed, retried).includes(secret), `${location} ${after}: ${seen(failed, retried)}`);
    }
  }
  // A 3xx not followed names its target scrubbed too.
  const refused = new RequestEngine({ baseUrl: base, transport: async () => ({ status: 300, headers: { location: `/choose?pw=${PW}` }, body: Buffer.alloc(0) }) });
  const err = await refused.getJson("/x").catch((caught: unknown) => caught);
  assert.ok(err instanceof PegelApiError && /redirect to .* not followed$/.test(err.message), String(err));
  for (const secret of secrets) assert.ok(!seen(err).includes(secret), seen(err));
});

test("echoedCredentialForms treats a userinfo without a password as a token (Basic `TOKEN:`) (security audit 2026-10-27, E)", async () => {
  const basic = (pair: string): string => Buffer.from(pair, "utf8").toString("base64");
  assert.deepEqual(echoedCredentialForms("alice:s3cret"), [basic("alice:s3cret"), "alice:s3cret", "s3cret"]);
  assert.deepEqual(echoedCredentialForms("T0ken"), [basic("T0ken:"), "T0ken:", "T0ken"]);
  assert.deepEqual(echoedCredentialForms("T0ken:"), [basic("T0ken:"), "T0ken:", "T0ken"]);
  assert.deepEqual(echoedCredentialForms("T%C3%B6k"), [basic("Tök:"), "Tök:"]); // short: not alone
  assert.deepEqual(echoedCredentialForms(":pw12"), [basic(":pw12"), ":pw12", "pw12"]);
  assert.deepEqual(echoedCredentialForms(""), []);
  assert.deepEqual(echoedCredentialForms(":"), []);
  // Through the engine: every echoed form of a token is scrubbed from the error.
  const TOKEN = "T0kenS3cret";
  for (const base of [`https://${TOKEN}@mirror.example`, `https://${TOKEN}:@mirror.example`]) {
    for (const echo of [`bad token ${TOKEN}`, `Authorization: Basic ${basic(`${TOKEN}:`)}`, `user ${TOKEN}: unknown`]) {
      const e = new RequestEngine({ baseUrl: base, maxRetries: 0, transport: makeMockTransport(() => jsonResponse({ message: echo }, 401)).transport });
      const err = await e.getJson("/x").catch((caught: unknown) => caught);
      assert.ok(err instanceof PegelApiError, String(err));
      for (const text of [err.message, err.detail ?? "", err.body]) assert.ok(!text.includes(TOKEN) && !text.includes(basic(`${TOKEN}:`)), `${base} ${echo}: ${text}`);
    }
  }
});

test("credentialsIn ends the authority of a special scheme at a backslash, as WHATWG does (security audit 2026-10-27, F)", () => {
  for (const scheme of ["http", "https", "HTTPS", "ws", "wss", "ftp"]) {
    assert.deepEqual(credentialsIn(`${scheme}://u:p@a.example\\@b.example/x`), ["u:p"], scheme);
    assert.equal(new URL(`${scheme}://u:p@a.example\\@b.example/x`).password, "p", scheme);
  }
  // Another scheme's authority runs on to "/", "?" or "#".
  assert.deepEqual(credentialsIn("foo://u:p@a.example\\@b.example/x"), ["u:p@a.example\\"]);
  assert.deepEqual(credentialsIn("https://u:p@a.example/x\\@y"), ["u:p"]);
});

test("credentialsIn skips the slashes and backslashes WHATWG skips after a special scheme (security audit 2026-10-27, F3)", () => {
  // `http:///u:pw@h`, `https:\\u:pw@h` and `http:u:pw@h` all carry `u:pw` for WHATWG; read
  // after "://", the userinfo was missed, so a refused --base-url echoed the password in clear.
  for (const value of [
    "http:alice:pw@h.example",
    "http:/alice:pw@h.example",
    "http:///alice:pw@h.example/x",
    "https:////alice:pw@h.example",
    "HTTPS:\\\\alice:pw@h.example",
    "wss:\\/alice:pw@h.example",
    "ftp:alice:pw@h.example",
  ]) {
    assert.deepEqual(credentialsIn(value), ["alice:pw"], value);
    assert.equal(new URL(value).password, "pw", value);
  }
  // Another scheme needs "//" before an authority: `foo:u:p@h` and `foo:///u:p@h` carry none.
  assert.deepEqual(credentialsIn("foo:u:p@h.example"), []);
  assert.deepEqual(credentialsIn("foo:///u:p@h.example"), []);
  assert.equal(new URL("foo:///u:p@h.example").password, "");
});

test("a base URL with a backslash, or a scheme not followed by // and the host, is refused at construction, never echoing the password (security audit 2026-10-27, F, F4)", () => {
  const pw = "s3cret-Pw";
  for (const baseUrl of [
    `https://alice:${pw}@api.example\\@evil.example`,
    `http:alice:${pw}@127.0.0.1:9`,
    `http:/alice:${pw}@127.0.0.1:9`,
    `http:///alice:${pw}@127.0.0.1:9`,
    `HTTPS:alice:${pw}@mirror.example`,
    `https:\\\\alice:${pw}@mirror.example`,
  ]) {
    assert.throws(() => new RequestEngine({ baseUrl }), (err: unknown) => {
      assert.ok(err instanceof PegelValidationError, String(err));
      assert.ok(!err.message.includes(pw), err.message);
      return true;
    }, baseUrl);
  }
});

test("requests go to the host of the parsed base URL, spelled as it parses, an @ in its path included (security audit 2026-10-27, F)", async () => {
  for (const base of ["https://alice:pw@api.example/v1/@evil.example", "https://API.Example:443/v1"]) {
    const parsed = new URL(base);
    const mt = makeMockTransport(() => jsonResponse([]));
    await new RequestEngine({ baseUrl: base, transport: mt.transport }).getJson("/x");
    const url = mt.last().url;
    assert.equal(new URL(url).origin, parsed.origin, url);
    const authority = url.slice(url.indexOf("//") + 2).split("/")[0] ?? "";
    assert.ok(authority === parsed.host || authority.endsWith(`@${parsed.host}`), `${base}: ${url}`);
  }
});

test("typedUrlCredentials reads a value meant as a URL whatever its scheme: missing, special without //, mistyped (F7)", () => {
  for (const [value, userinfo] of [
    ["https://alice:pw@h.example/x", "alice:pw"],
    ["http:///alice:pw@h.example", "alice:pw"],
    ["alice:pw@h.example/x", "alice:pw"],
    ["my_user:pw@h.example", "my_user:pw"],
    ["T0ken:@h.example", "T0ken:"],
    ["http//alice:pw@h.example", "alice:pw"],
    ["https//alice:pw@h.example/v1", "alice:pw"],
    ["http/alice:pw@h.example", "alice:pw"],
    ["htp:/alice:pw@h.example", "alice:pw"],
    ["http\\\\alice:pw@h.example", "alice:pw"],
    ["http//alice:p/w@h.example", "alice:p/w"],
  ] as const) {
    assert.deepEqual(typedUrlCredentials(value), [userinfo], value);
  }
  // No "@" after the slashes, or a scheme spelled with "//" and no userinfo: none.
  for (const value of ["", "h.example/x", "http//h.example/x", "@h.example/x", "http//@h.example", "https://h.example/a@b"]) {
    assert.deepEqual(typedUrlCredentials(value), [], value);
  }
});
