import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { nodeHttpTransport } from "../src/client/http.js";
import { PegelNetworkError } from "../src/client/errors.js";

/** Start a throwaway loopback server for one test and return its base URL. */
async function withServer(
  handler: http.RequestListener,
  fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("no address");
  try {
    await fn(`http://127.0.0.1:${addr.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("performs a real GET and returns status, headers and body", async () => {
  await withServer(
    (req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ path: req.url }));
    },
    async (baseUrl) => {
      const resp = await nodeHttpTransport({ method: "GET", url: `${baseUrl}/webservices/` });
      assert.equal(resp.status, 200);
      assert.equal(resp.headers["content-type"], "application/json");
      assert.deepEqual(JSON.parse(resp.body.toString("utf8")), { path: "/webservices/" });
    },
  );
});

test("rejects an unsupported protocol with PegelNetworkError", async () => {
  await assert.rejects(
    () => nodeHttpTransport({ method: "GET", url: "ftp://example.test/x" }),
    PegelNetworkError,
  );
});

test("enforces maxResponseBytes", async () => {
  await withServer(
    (_req, res) => res.end("x".repeat(1000)),
    async (baseUrl) => {
      await assert.rejects(
        () => nodeHttpTransport({ method: "GET", url: baseUrl, maxResponseBytes: 10 }),
        PegelNetworkError,
      );
    },
  );
});

test("enforces an overall deadline against a trickle response (PEGEL-02)", async () => {
  // The server dribbles one byte every 20ms and never ends the response. Each
  // byte resets the idle timeout (40ms), so the idle timer alone would never
  // fire — the overall deadline (10 x timeoutMs = 400ms) must catch it.
  let timer: ReturnType<typeof setInterval> | undefined;
  await withServer(
    (_req, res) => {
      res.setHeader("content-type", "application/json");
      res.writeHead(200);
      timer = setInterval(() => res.write("x"), 20);
    },
    async (baseUrl) => {
      const started = Date.now();
      await assert.rejects(
        () => nodeHttpTransport({ method: "GET", url: baseUrl, timeoutMs: 40 }),
        (err: unknown) => {
          assert.ok(err instanceof PegelNetworkError);
          assert.match(err.message, /overall deadline/);
          return true;
        },
      );
      // It must reject on the deadline, not hang indefinitely; allow generous slack.
      assert.ok(Date.now() - started < 4000, "did not reject within the deadline window");
    },
  );
  if (timer !== undefined) clearInterval(timer);
});
