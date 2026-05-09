import { test } from "node:test";
import assert from "node:assert/strict";
import { ask } from "../src/ask.ts";
import { MockX402PaymentClient } from "../src/payment.ts";
import type { RankInput, RankResult } from "../src/rank.ts";
import type { RegistryEntry } from "../src/registry.ts";

const REGISTRY: RegistryEntry[] = [
  { name: "ETH Price Oracle", url: "https://eth-price.example.com/v1/price", category: "services" },
  { name: "BTC Volume Tracker", url: "https://btc-volume.example.com/24h", category: "services" },
  { name: "USDC Supply Stats", url: "https://usdc-stats.example.com/supply", category: "services" },
  { name: "x402.rs", url: "https://facilitator.x402.rs", category: "facilitators" }, // filtered out
];

// Deterministic rank stub that returns candidates in input order.
async function passthroughRank(input: RankInput): Promise<RankResult> {
  return {
    strategy: "heuristic",
    ranked: (input.candidates).slice(0, input.topN ?? input.candidates.length).map((entry, i) => ({
      entry,
      score: 1 - i * 0.1,
      reason: "stub",
    })),
  };
}

// Build a fetch impl that responds to a list of URLs in the order they're hit.
function makeMultiFetch(scenarios: Record<string, Array<{ status: number; body: unknown }>>): typeof fetch {
  const counters: Record<string, number> = {};
  return async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === "string" ? input : (input as URL).toString();
    const queue = scenarios[url];
    if (!queue) throw new Error(`no scenario for url ${url}`);
    const idx = counters[url] ?? 0;
    counters[url] = idx + 1;
    const next = queue[idx];
    if (!next) throw new Error(`scenario for ${url} exhausted at call ${idx + 1}`);
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { "content-type": "application/json" },
    });
  };
}

const lines: string[] = [];
const captureLog = (s: string) => { lines.push(s); };

// ─────────────────────────────────────────────────────────────────────────────
// Happy path
// ─────────────────────────────────────────────────────────────────────────────

test("ask() pays top-N candidates and synthesises a final answer", async () => {
  lines.length = 0;
  const fetcher = makeMultiFetch({
    "https://eth-price.example.com/v1/price": [
      { status: 402, body: {
        x402Version: 2,
        accepts: [{ scheme: "exact", price: "$0.01", network: "base", payTo: "0xeth" }],
      }},
      { status: 200, body: { answer: "ETH=2456" } },
    ],
    "https://btc-volume.example.com/24h": [
      { status: 402, body: {
        x402Version: 2,
        accepts: [{ scheme: "exact", price: "$0.02", network: "base", payTo: "0xbtc" }],
      }},
      { status: 200, body: { answer: "BTC volume 24h = 1.2B" } },
    ],
    "https://usdc-stats.example.com/supply": [
      { status: 402, body: {
        x402Version: 2,
        accepts: [{ scheme: "exact", price: "$0.005", network: "base", payTo: "0xusdc" }],
      }},
      { status: 200, body: { answer: "USDC supply = $63B" } },
    ],
  });
  const r = await ask({
    question: "What's BTC's 24h volume?",
    budgetUsd: 0.10,
    payTopN: 3,
    client: new MockX402PaymentClient(["base"]),
    registry: REGISTRY,
    rankFn: passthroughRank,
    fetchImpl: fetcher,
    log: captureLog,
  });

  assert.equal(r.paid.length, 3, "should pay all top-3 candidates");
  assert.equal(r.skipped.length, 0);
  assert.equal(r.rankedTotal, 3);
  assert.match(r.synth.answer, /ETH=2456/);
  assert.match(r.synth.costStamp, /Answered in \d+\.\ds, paid \$0\.035 USDC across 3 endpoints/);
  // Budget tracking should show ~ $0.035 spent (0.01 + 0.02 + 0.005)
  assert.equal(r.synth.citations.length, 3);
});

// ─────────────────────────────────────────────────────────────────────────────
// Budget refusal
// ─────────────────────────────────────────────────────────────────────────────

test("ask() stops paying when the next call would exceed budget", async () => {
  lines.length = 0;
  const fetcher = makeMultiFetch({
    "https://eth-price.example.com/v1/price": [
      { status: 402, body: {
        x402Version: 2,
        accepts: [{ scheme: "exact", price: "$0.05", network: "base", payTo: "0xeth" }],
      }},
      { status: 200, body: { answer: "ETH=2456" } },
    ],
    "https://btc-volume.example.com/24h": [
      // The cap is $0.06; this is $0.05 → would push us to $0.10, which fits exactly.
      // So second call should also succeed since 0.05+0.05 = 0.10 == cap.
      { status: 402, body: {
        x402Version: 2,
        accepts: [{ scheme: "exact", price: "$0.05", network: "base", payTo: "0xbtc" }],
      }},
      { status: 200, body: { answer: "BTC volume" } },
    ],
    "https://usdc-stats.example.com/supply": [
      // Third call: budget is exhausted → paidFetch raises NoAcceptableRailError
      { status: 402, body: {
        x402Version: 2,
        accepts: [{ scheme: "exact", price: "$0.01", network: "base", payTo: "0xusdc" }],
      }},
    ],
  });
  const r = await ask({
    question: "test",
    budgetUsd: 0.10,
    payTopN: 3,
    maxPerCallUsd: 0.10,
    client: new MockX402PaymentClient(["base"]),
    registry: REGISTRY,
    rankFn: passthroughRank,
    fetchImpl: fetcher,
    log: captureLog,
  });
  assert.equal(r.paid.length, 2);
  assert.equal(r.skipped.length, 1);
  assert.match(r.skipped[0].reason, /NoAcceptableRailError/);
});

// ─────────────────────────────────────────────────────────────────────────────
// All payments fail → still synthesise gracefully
// ─────────────────────────────────────────────────────────────────────────────

test("ask() returns the heuristic 'no paid calls' synthesis when every payment fails", async () => {
  lines.length = 0;
  const fetcher = makeMultiFetch({
    "https://eth-price.example.com/v1/price": [
      { status: 500, body: { error: "boom" } },
    ],
    "https://btc-volume.example.com/24h": [
      { status: 500, body: { error: "boom" } },
    ],
    "https://usdc-stats.example.com/supply": [
      { status: 500, body: { error: "boom" } },
    ],
  });
  const r = await ask({
    question: "test",
    client: new MockX402PaymentClient(),
    registry: REGISTRY,
    rankFn: passthroughRank,
    fetchImpl: fetcher,
    log: captureLog,
  });
  assert.equal(r.paid.length, 0);
  assert.equal(r.skipped.length, 3);
  assert.match(r.synth.answer, /No endpoints were paid/);
  assert.match(r.synth.costStamp, /no paid calls$/);
});

// ─────────────────────────────────────────────────────────────────────────────
// Filters
// ─────────────────────────────────────────────────────────────────────────────

test("ask() filters facilitators out of the candidate pool via buyableEntries", async () => {
  lines.length = 0;
  let observedCount = 0;
  const trackingRank = async (input: RankInput): Promise<RankResult> => {
    observedCount = input.candidates.length;
    return passthroughRank(input);
  };
  await ask({
    question: "test",
    client: new MockX402PaymentClient(),
    registry: REGISTRY, // contains 3 services + 1 facilitator
    rankFn: trackingRank,
    fetchImpl: makeMultiFetch({}),
    log: captureLog,
    payTopN: 0, // skip all payments
  });
  // The facilitator should be filtered out before ranking.
  assert.equal(observedCount, 3, "facilitator entries should be filtered out");
});

test("ask() respects payTopN and pays only that many", async () => {
  lines.length = 0;
  const fetcher = makeMultiFetch({
    "https://eth-price.example.com/v1/price": [
      { status: 402, body: {
        x402Version: 2,
        accepts: [{ scheme: "exact", price: "$0.01", network: "base", payTo: "0x1" }],
      }},
      { status: 200, body: { answer: "x" } },
    ],
  });
  const r = await ask({
    question: "test",
    budgetUsd: 0.10,
    payTopN: 1,
    client: new MockX402PaymentClient(["base"]),
    registry: REGISTRY,
    rankFn: passthroughRank,
    fetchImpl: fetcher,
    log: captureLog,
  });
  assert.equal(r.paid.length, 1);
  assert.equal(r.rankedTotal, 1);
});
