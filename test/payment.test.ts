import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ChallengeMalformedError,
  MockX402PaymentClient,
  NoAcceptableRailError,
  PaymentRejectedError,
  paidFetch,
} from "../src/payment.ts";
import { BudgetTracker } from "../src/cost.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers — minimal fetch stub
// ─────────────────────────────────────────────────────────────────────────────

interface FakeResponse {
  status: number;
  body: unknown;
}

function makeFetch(routes: Array<(req: { url: string; init?: RequestInit }) => FakeResponse | undefined>): typeof fetch {
  let callIdx = 0;
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : (input as URL).toString();
    const handler = routes[callIdx++];
    if (!handler) throw new Error(`unexpected fetch call ${callIdx}: ${url}`);
    const r = handler({ url, init });
    if (!r) throw new Error(`route ${callIdx} returned no response for ${url}`);
    return new Response(JSON.stringify(r.body), {
      status: r.status,
      headers: { "content-type": "application/json" },
    });
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Happy path
// ─────────────────────────────────────────────────────────────────────────────

test("paidFetch round-trips a 402 → pay → 200 flow and books the spend", async () => {
  const fetcher = makeFetch([
    () => ({
      status: 402,
      body: {
        x402Version: 2,
        accepts: [
          { scheme: "exact", price: "$0.01", network: "base", payTo: "0xabc" },
        ],
      },
    }),
    ({ init }) => {
      assert.equal((init?.headers as Record<string, string> | undefined)?.["X-PAYMENT"], "mock:base:$0.01:0xabc");
      return { status: 200, body: { answer: "BTC volume = 1.2B" } };
    },
  ]);

  const budget = new BudgetTracker(0.10);
  const result = await paidFetch("https://api.example.com/btc-volume", {
    client: new MockX402PaymentClient(["base"]),
    budget,
    fetchImpl: fetcher,
  });

  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { answer: "BTC volume = 1.2B" });
  assert.equal(result.paid.usd, 0.01);
  assert.equal(budget.spent(), 0.01);
  assert.equal(budget.ledger().length, 1);
});

test("paidFetch returns the body untouched for free endpoints (no 402)", async () => {
  const fetcher = makeFetch([
    () => ({ status: 200, body: { ok: true } }),
  ]);
  const budget = new BudgetTracker(0.10);
  const result = await paidFetch("https://api.example.com/free", {
    client: new MockX402PaymentClient(),
    budget,
    fetchImpl: fetcher,
  });
  assert.equal(result.paid.usd, 0);
  assert.equal(budget.spent(), 0);
  assert.deepEqual(result.body, { ok: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// Network-selection logic
// ─────────────────────────────────────────────────────────────────────────────

test("paidFetch picks the cheapest acceptable rail when multiple options are offered", async () => {
  const fetcher = makeFetch([
    () => ({
      status: 402,
      body: {
        x402Version: 2,
        accepts: [
          { scheme: "exact", price: "$0.05", network: "base", payTo: "0xabc" },
          { scheme: "exact", price: "$0.01", network: "stellar:testnet", payTo: "GABC" },
          { scheme: "exact", price: "$0.02", network: "base", payTo: "0xabc" },
        ],
      },
    }),
    ({ init }) => {
      // Should pick the $0.01 stellar rail.
      assert.match(
        (init?.headers as Record<string, string> | undefined)?.["X-PAYMENT"] ?? "",
        /^mock:stellar:testnet:\$0\.01:GABC$/,
      );
      return { status: 200, body: { ok: true } };
    },
  ]);
  const budget = new BudgetTracker(0.10);
  const r = await paidFetch("https://api.example.com/x", {
    client: new MockX402PaymentClient(["base", "stellar:testnet"]),
    budget,
    fetchImpl: fetcher,
  });
  assert.equal(r.paid.usd, 0.01);
});

test("paidFetch throws NoAcceptableRailError when no offered network is supported", async () => {
  const fetcher = makeFetch([
    () => ({
      status: 402,
      body: {
        x402Version: 2,
        accepts: [
          { scheme: "exact", price: "$0.01", network: "polygon", payTo: "0xabc" },
        ],
      },
    }),
  ]);
  const budget = new BudgetTracker(0.10);
  await assert.rejects(
    () => paidFetch("https://api.example.com/x", {
      client: new MockX402PaymentClient(["base", "stellar:testnet"]),
      budget,
      fetchImpl: fetcher,
    }),
    NoAcceptableRailError,
  );
  assert.equal(budget.spent(), 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// Budget + per-call cap
// ─────────────────────────────────────────────────────────────────────────────

test("paidFetch refuses the call when the cheapest rail exceeds maxPerCallUsd", async () => {
  const fetcher = makeFetch([
    () => ({
      status: 402,
      body: {
        x402Version: 2,
        accepts: [
          { scheme: "exact", price: "$0.50", network: "base", payTo: "0xabc" },
        ],
      },
    }),
  ]);
  const budget = new BudgetTracker(10);
  await assert.rejects(
    () => paidFetch("https://api.example.com/x", {
      client: new MockX402PaymentClient(["base"]),
      budget,
      maxPerCallUsd: 0.10,
      fetchImpl: fetcher,
    }),
    NoAcceptableRailError,
  );
  assert.equal(budget.spent(), 0);
});

test("paidFetch refuses when the call would put the session over the budget cap", async () => {
  const fetcher = makeFetch([
    () => ({
      status: 402,
      body: {
        x402Version: 2,
        accepts: [
          { scheme: "exact", price: "$0.20", network: "base", payTo: "0xabc" },
        ],
      },
    }),
  ]);
  const budget = new BudgetTracker(0.10);
  await assert.rejects(
    () => paidFetch("https://api.example.com/x", {
      client: new MockX402PaymentClient(["base"]),
      budget,
      fetchImpl: fetcher,
    }),
    NoAcceptableRailError,
  );
  assert.equal(budget.spent(), 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// Malformed / unhappy responses
// ─────────────────────────────────────────────────────────────────────────────

test("paidFetch throws ChallengeMalformedError on a non-402 error response", async () => {
  const fetcher = makeFetch([
    () => ({ status: 500, body: { error: "internal" } }),
  ]);
  const budget = new BudgetTracker(0.10);
  await assert.rejects(
    () => paidFetch("https://api.example.com/x", {
      client: new MockX402PaymentClient(),
      budget,
      fetchImpl: fetcher,
    }),
    ChallengeMalformedError,
  );
});

test("paidFetch throws ChallengeMalformedError when 402 body lacks accepts[]", async () => {
  const fetcher = makeFetch([
    () => ({ status: 402, body: { x402Version: 2 /* missing accepts */ } }),
  ]);
  const budget = new BudgetTracker(0.10);
  await assert.rejects(
    () => paidFetch("https://api.example.com/x", {
      client: new MockX402PaymentClient(),
      budget,
      fetchImpl: fetcher,
    }),
    ChallengeMalformedError,
  );
});

test("paidFetch throws PaymentRejectedError when the retry returns 402 again", async () => {
  const fetcher = makeFetch([
    () => ({
      status: 402,
      body: {
        x402Version: 2,
        accepts: [{ scheme: "exact", price: "$0.01", network: "base", payTo: "0xabc" }],
      },
    }),
    () => ({ status: 402, body: { error: "bad payment proof" } }),
  ]);
  const budget = new BudgetTracker(0.10);
  await assert.rejects(
    () => paidFetch("https://api.example.com/x", {
      client: new MockX402PaymentClient(["base"]),
      budget,
      fetchImpl: fetcher,
    }),
    PaymentRejectedError,
  );
  // No spend booked since the retry failed.
  assert.equal(budget.spent(), 0);
});

test("paidFetch throws PaymentRejectedError on retry-side 5xx", async () => {
  const fetcher = makeFetch([
    () => ({
      status: 402,
      body: {
        x402Version: 2,
        accepts: [{ scheme: "exact", price: "$0.01", network: "base", payTo: "0xabc" }],
      },
    }),
    () => ({ status: 503, body: { error: "upstream down" } }),
  ]);
  const budget = new BudgetTracker(0.10);
  await assert.rejects(
    () => paidFetch("https://api.example.com/x", {
      client: new MockX402PaymentClient(["base"]),
      budget,
      fetchImpl: fetcher,
    }),
    PaymentRejectedError,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// MockX402PaymentClient
// ─────────────────────────────────────────────────────────────────────────────

test("MockX402PaymentClient exposes the configured network list", () => {
  const c = new MockX402PaymentClient(["base"]);
  assert.deepEqual(c.supportedNetworks(), ["base"]);
});

test("MockX402PaymentClient defaults to base + stellar:testnet + sui:mainnet", () => {
  const c = new MockX402PaymentClient();
  const nets = c.supportedNetworks();
  assert.ok(nets.includes("base"));
  assert.ok(nets.includes("stellar:testnet"));
  assert.ok(nets.includes("sui:mainnet"));
});
