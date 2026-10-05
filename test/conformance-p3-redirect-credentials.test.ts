// Conformance test P3 (fix plan 2026-10-06): credentials follow a redirect only within the
// same origin. A same-origin absolute Location keeps the base URL's userinfo; another origin
// (or a scheme change) gets neither it nor a credential header; a transport that followed a
// redirect itself is not trusted; and a 401 after such a hop says why. Written in
// pegel-online-cli, the first redirect-following repo of the rollout; shared across the
// *-cli repos that follow redirects or take a key — only the adapter block differs.

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { HttpRequest, HttpResponse } from "../src/client/http.js";

// ---- adapter (per repo) -------------------------------------------------------------
import { PegelOnlineClient as Client } from "../src/client/client.js";
import { PegelApiError as ApiError, PegelNetworkError as NetworkError } from "../src/client/errors.js";
/** One call that makes a single GET and needs no arguments. */
const call = (client: Client): Promise<unknown> => client.waters();
/** A 2xx body the call accepts. */
const okBody = [{ shortname: "RHEIN", longname: "RHEIN" }];
/** Extra client options that add a credential header, or undefined for a repo without one. */
const keyOptions = { headers: { "X-API-Key": "k3y-secret" } };
// --------------------------------------------------------------------------------------

interface Seen { path: string; authorization?: string; apiKey?: string }

/** A local server that records what it receives and answers with `respond`. */
async function server(respond: (req: http.IncomingMessage, res: http.ServerResponse) => void) {
  const seen: Seen[] = [];
  const s = http.createServer((req, res) => {
    seen.push({
      path: req.url ?? "",
      ...(req.headers.authorization !== undefined ? { authorization: req.headers.authorization } : {}),
      ...(typeof req.headers["x-api-key"] === "string" ? { apiKey: req.headers["x-api-key"] } : {}),
    });
    respond(req, res);
  });
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return { seen, base: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, close: () => s.close() };
}

const ok = (res: http.ServerResponse): void => {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(okBody));
};

const BASIC = `Basic ${Buffer.from("alice:s3cret").toString("base64")}`;

test("P3: a redirect to another origin carries neither the userinfo nor a credential header", async () => {
  const b = await server((_req, res) => ok(res));
  const a = await server((req, res) => {
    res.statusCode = 302;
    res.setHeader("location", `${b.base}${req.url}`);
    res.end();
  });
  try {
    const base = a.base.replace("http://", "http://alice:s3cret@");
    await call(new Client({ baseUrl: base, maxRetries: 0, ...keyOptions }));
    assert.equal(a.seen[0]?.authorization, BASIC, "the base URL's own origin gets the credentials");
    assert.equal(b.seen.length, 1);
    assert.equal(b.seen[0]?.authorization, undefined, "no userinfo to the other origin");
    assert.equal(b.seen[0]?.apiKey, undefined, "no credential header to the other origin");
  } finally {
    a.close();
    b.close();
  }
});

test("P3: a same-origin absolute redirect keeps the credentials", async () => {
  const a = await server((req, res) => {
    if (req.url?.startsWith("/moved")) return ok(res);
    res.statusCode = 301;
    res.setHeader("location", `http://127.0.0.1:${(req.socket.localPort ?? 0)}/moved${req.url}`);
    res.end();
  });
  try {
    const base = a.base.replace("http://", "http://alice:s3cret@");
    await call(new Client({ baseUrl: base, maxRetries: 0, ...keyOptions }));
    assert.equal(a.seen.length, 2);
    assert.equal(a.seen[1]?.authorization, BASIC);
    assert.equal(a.seen[1]?.apiKey, keyOptions.headers["X-API-Key"]);
  } finally {
    a.close();
  }
});

test("P3: transports are told not to follow redirects, and one that did is rejected", async () => {
  let seen: HttpRequest | undefined;
  const transport = async (req: HttpRequest): Promise<HttpResponse> => {
    seen = req;
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: Buffer.from(JSON.stringify(okBody)),
      url: "https://elsewhere.example/landing",
    };
  };
  await assert.rejects(call(new Client({ transport, maxRetries: 0 })), (e: unknown) =>
    e instanceof NetworkError && /followed a redirect to another origin/.test(e.message));
  assert.equal(seen?.redirect, "manual");
  // A final URL on the same origin is fine.
  const same = async (req: HttpRequest): Promise<HttpResponse> => ({
    status: 200,
    headers: { "content-type": "application/json" },
    body: Buffer.from(JSON.stringify(okBody)),
    url: req.url,
  });
  await assert.doesNotReject(call(new Client({ transport: same })));
});

test("P3: a 401 after an http to https redirect says the credentials were not sent there", async () => {
  const transport = async (req: HttpRequest): Promise<HttpResponse> => {
    const url = new URL(req.url);
    if (url.protocol === "http:") {
      return { status: 301, headers: { location: `https://${url.host}${url.pathname}` }, body: Buffer.alloc(0) };
    }
    return { status: 401, headers: { "content-type": "application/json" }, body: Buffer.from('{"message":"login required"}') };
  };
  await assert.rejects(
    call(new Client({ baseUrl: "http://alice:s3cret@mirror.example", transport, maxRetries: 0 })),
    (e: unknown) => e instanceof ApiError && e.status === 401 && /http to https.*use an https base URL/.test(e.message),
  );
});
