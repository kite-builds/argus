import { test } from "node:test";
import assert from "node:assert/strict";
import {
  rank,
  rankHeuristic,
  rankWithGemini,
  scoreHeuristic,
} from "../src/rank.ts";
import type { RegistryEntry } from "../src/registry.ts";

const SAMPLE: RegistryEntry[] = [
  { name: "ETH Price Oracle", url: "https://eth-price.example.com/v1/price", category: "services" },
  { name: "BTC Volume Tracker", url: "https://btc-volume.example.com/24h", category: "services" },
  { name: "USDC Supply Stats", url: "https://usdc-stats.example.com/supply", category: "services" },
  { name: "x402.rs facilitator", url: "https://facilitator.x402.rs", category: "facilitators" },
  { name: "x402-saas SDK", url: "https://x402-saas.surge.sh", category: "infrastructure" },
];

// ─────────────────────────────────────────────────────────────────────────────
// scoreHeuristic
// ─────────────────────────────────────────────────────────────────────────────

test("scoreHeuristic returns 0 for empty inputs", () => {
  const r = scoreHeuristic("", SAMPLE[0]);
  assert.equal(r.score, 0);
});

test("scoreHeuristic finds direct token overlap", () => {
  const r = scoreHeuristic("what is the current ETH price?", SAMPLE[0]);
  assert.ok(r.score > 0, "non-zero score expected");
  assert.ok(r.overlap.includes("eth"), `expected 'eth' in overlap, got ${r.overlap}`);
  assert.ok(r.overlap.includes("price"), `expected 'price' in overlap, got ${r.overlap}`);
});

test("scoreHeuristic ignores stopwords and punctuation", () => {
  const a = scoreHeuristic("The eth price?", SAMPLE[0]);
  const b = scoreHeuristic("ETH price", SAMPLE[0]);
  // Same content tokens after stopwording → same score.
  assert.equal(a.score.toFixed(4), b.score.toFixed(4));
});

test("scoreHeuristic gives services a category-prior boost", () => {
  // A question with zero lexical overlap should still score services
  // slightly higher than facilitators thanks to the prior.
  const service = scoreHeuristic("totally unrelated query string", SAMPLE[0]);
  const fac = scoreHeuristic("totally unrelated query string", SAMPLE[3]);
  // Both have zero Jaccard; service gets +0.1 boost.
  assert.ok(service.score > fac.score, "services should beat facilitators on prior alone");
});

// ─────────────────────────────────────────────────────────────────────────────
// rankHeuristic
// ─────────────────────────────────────────────────────────────────────────────

test("rankHeuristic returns strategy='heuristic'", () => {
  const r = rankHeuristic({ question: "ETH price", candidates: SAMPLE });
  assert.equal(r.strategy, "heuristic");
});

test("rankHeuristic puts the lexically best candidate first", () => {
  const r = rankHeuristic({ question: "what is the current ETH price?", candidates: SAMPLE });
  assert.equal(r.ranked[0].entry.name, "ETH Price Oracle");
});

test("rankHeuristic respects topN", () => {
  const r = rankHeuristic({ question: "anything", candidates: SAMPLE, topN: 2 });
  assert.equal(r.ranked.length, 2);
});

test("rankHeuristic sets a reason for every candidate", () => {
  const r = rankHeuristic({ question: "ETH price", candidates: SAMPLE });
  for (const c of r.ranked) {
    assert.equal(typeof c.reason, "string");
    assert.ok(c.reason.length > 0);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// rankWithGemini (with stub client)
// ─────────────────────────────────────────────────────────────────────────────

test("rankWithGemini delegates to the client and tags strategy='gemini'", async () => {
  const client = {
    async generateJson<T>(_prompt: string): Promise<T> {
      // Stub returns BTC first to prove the LLM ordering wins over heuristic.
      return {
        items: [
          { index: 1, score: 0.92, reason: "BTC volume directly answers the question" },
          { index: 0, score: 0.30, reason: "ETH price is adjacent" },
          { index: 3, score: 0.05, reason: "facilitator, not data" },
        ],
      } as T;
    },
  };
  const r = await rankWithGemini(
    { question: "what was BTC's 24h volume?", candidates: SAMPLE },
    client,
  );
  assert.equal(r.strategy, "gemini");
  assert.equal(r.ranked[0].entry.name, "BTC Volume Tracker");
  assert.equal(r.ranked[0].score, 0.92);
});

test("rankWithGemini clamps out-of-range scores to [0,1]", async () => {
  const client = {
    async generateJson<T>(_prompt: string): Promise<T> {
      return {
        items: [
          { index: 0, score: 1.5, reason: "over the cap" },
          { index: 1, score: -0.2, reason: "below floor" },
        ],
      } as T;
    },
  };
  const r = await rankWithGemini(
    { question: "anything", candidates: SAMPLE.slice(0, 2) },
    client,
  );
  assert.equal(r.ranked[0].score, 1);
  assert.equal(r.ranked[1].score, 0);
});

test("rankWithGemini drops items with out-of-bounds index", async () => {
  const client = {
    async generateJson<T>(_prompt: string): Promise<T> {
      return {
        items: [
          { index: 0, score: 0.5, reason: "valid" },
          { index: 99, score: 0.9, reason: "out of bounds — should be dropped" },
          { index: -1, score: 0.7, reason: "negative — should be dropped" },
        ],
      } as T;
    },
  };
  const r = await rankWithGemini(
    { question: "anything", candidates: SAMPLE.slice(0, 2) },
    client,
  );
  assert.equal(r.ranked.length, 1);
  assert.equal(r.ranked[0].entry.name, "ETH Price Oracle");
});

// ─────────────────────────────────────────────────────────────────────────────
// rank() auto-selection
// ─────────────────────────────────────────────────────────────────────────────

test("rank() falls back to heuristic when no client is supplied", async () => {
  const r = await rank({ question: "ETH price", candidates: SAMPLE });
  assert.equal(r.strategy, "heuristic");
});

test("rank() uses Gemini when a client is supplied", async () => {
  const client = {
    async generateJson<T>(_prompt: string): Promise<T> {
      return { items: [{ index: 0, score: 0.5, reason: "stub" }] } as T;
    },
  };
  const r = await rank({ question: "ETH price", candidates: SAMPLE.slice(0, 1) }, client);
  assert.equal(r.strategy, "gemini");
});
