import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { probe, type ProbeResult } from "../src/probe.ts";

/**
 * Tiny in-process HTTP server that lets each test stand up exactly the
 * surface it wants probe() to see. Keeps the suite fast (no real network)
 * and deterministic.
 */
type RouteMap = Record<string, (req: { method?: string }) => {
  status: number;
  headers?: Record<string, string>;
  body?: string;
}>;

async function serveOnce(routes: RouteMap): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const path = req.url ?? "/";
    const handler = routes[path];
    if (!handler) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
      return;
    }
    const out = handler({ method: req.method });
    const headers = { ...(out.headers ?? {}) };
    if (out.body !== undefined && !headers["content-type"]) {
      headers["content-type"] = "application/json";
    }
    res.writeHead(out.status, headers);
    res.end(out.body ?? "");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

test("probe returns null source when nothing is detected", async () => {
  const srv = await serveOnce({});
  try {
    const r: ProbeResult = await probe(srv.url);
    assert.equal(r.source, null);
    assert.deepEqual(r.endpoints, []);
    assert.equal(r.error, "no x402 surface detected");
  } finally {
    await srv.close();
  }
});

test("probe detects /.well-known/x402-manifest.json and parses endpoints", async () => {
  const manifest = {
    endpoints: [
      { path: "/v1/price", method: "GET", price: "$0.01", description: "BTC price" },
      { path: "/v1/order", method: "POST", priceUsd: 0.05 },
    ],
    facilitator: "https://facilitator.x402.rs",
  };
  const srv = await serveOnce({
    "/.well-known/x402-manifest.json": () => ({
      status: 200,
      body: JSON.stringify(manifest),
    }),
  });
  try {
    const r = await probe(srv.url);
    assert.equal(r.source, "manifest");
    assert.equal(r.facilitator, "https://facilitator.x402.rs");
    assert.equal(r.endpoints.length, 2);
    assert.equal(r.endpoints[0].path, "/v1/price");
    assert.equal(r.endpoints[0].price, "$0.01");
    // priceUsd as a number coerces to a string field
    assert.equal(r.endpoints[1].price, "0.05");
  } finally {
    await srv.close();
  }
});

test("probe falls back to /.well-known/agent.json when manifest missing", async () => {
  const srv = await serveOnce({
    "/.well-known/agent.json": () => ({
      status: 200,
      body: JSON.stringify({ name: "test-agent", version: "1.0" }),
    }),
  });
  try {
    const r = await probe(srv.url);
    assert.equal(r.source, "agent-json");
    assert.deepEqual(r.endpoints, []);
  } finally {
    await srv.close();
  }
});

test("probe falls back to /__x402/health when neither well-known surface exists", async () => {
  const srv = await serveOnce({
    "/__x402/health": () => ({
      status: 200,
      body: JSON.stringify({ ok: true, ts: 123 }),
    }),
  });
  try {
    const r = await probe(srv.url);
    assert.equal(r.source, "health");
  } finally {
    await srv.close();
  }
});

test("probe detects 402 challenge via HEAD when no JSON surface available", async () => {
  const srv = await serveOnce({
    "/": (req) => {
      // Only respond to HEAD with a 402; manifest/agent/health probes
      // (which use GET) should miss earlier.
      if (req.method === "HEAD") {
        return {
          status: 402,
          headers: { "www-authenticate": "x402 realm=\"x402.example\"" },
        };
      }
      return { status: 404, body: "{}" };
    },
  });
  try {
    const r = await probe(srv.url);
    assert.equal(r.source, "challenge-header");
  } finally {
    await srv.close();
  }
});

test("probe normalises URLs with trailing slashes and paths to the origin", async () => {
  const srv = await serveOnce({
    "/__x402/health": () => ({
      status: 200,
      body: JSON.stringify({ ok: true }),
    }),
  });
  try {
    const r = await probe(`${srv.url}/some/deep/path/here/`);
    assert.equal(r.source, "health");
    assert.equal(r.baseUrl, srv.url);
  } finally {
    await srv.close();
  }
});

test("probe handles malformed JSON manifest gracefully", async () => {
  const srv = await serveOnce({
    "/.well-known/x402-manifest.json": () => ({
      status: 200,
      body: "this is not json",
    }),
  });
  try {
    const r = await probe(srv.url);
    // Bad manifest → fall through; nothing else served → null source
    assert.equal(r.source, null);
  } finally {
    await srv.close();
  }
});

test("probe handles a manifest with non-array endpoints field without crashing", async () => {
  const srv = await serveOnce({
    "/.well-known/x402-manifest.json": () => ({
      status: 200,
      body: JSON.stringify({ endpoints: "not-an-array", facilitator: "https://f" }),
    }),
  });
  try {
    const r = await probe(srv.url);
    assert.equal(r.source, "manifest");
    assert.deepEqual(r.endpoints, []);
    assert.equal(r.facilitator, "https://f");
  } finally {
    await srv.close();
  }
});
