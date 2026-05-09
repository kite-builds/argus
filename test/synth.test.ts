import { test } from "node:test";
import assert from "node:assert/strict";
import { summariseBody, synth, synthHeuristic, synthWithGemini } from "../src/synth.ts";
import type { PaidFetchResult } from "../src/payment.ts";
import type { BudgetSummary } from "../src/cost.ts";

function fakeBudget(durationMs = 8400, totalUsd = 0.027, callCount = 3, endpointsUnique = 3): BudgetSummary {
  return {
    totalUsd,
    callCount,
    endpointsUnique,
    durationMs,
    remainingUsd: 0.073,
    capUsd: 0.10,
  };
}

function fakeResponse(body: unknown, payTo = "0xabc", price = "$0.01"): PaidFetchResult {
  return {
    body,
    status: 200,
    paid: { raw: price, usd: parseFloat(price.replace("$", "")) },
    paymentRequirement: { scheme: "exact", price, network: "base", payTo },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// summariseBody
// ─────────────────────────────────────────────────────────────────────────────

test("summariseBody returns scalar bodies as strings", () => {
  assert.equal(summariseBody("plain string"), "plain string");
  assert.equal(summariseBody(42), "42");
  assert.equal(summariseBody(true), "true");
});

test("summariseBody handles null + undefined", () => {
  assert.equal(summariseBody(null), "(empty)");
  assert.equal(summariseBody(undefined), "(empty)");
});

test("summariseBody prefers known headline keys", () => {
  assert.equal(summariseBody({ noise: "x", answer: "yes" }), "answer=yes");
  assert.equal(summariseBody({ noise: "x", value: 7 }), "value=7");
});

test("summariseBody falls back to first scalar field", () => {
  assert.equal(summariseBody({ first: "a", nested: { b: 1 } }), "first=a");
});

test("summariseBody truncates very long outputs", () => {
  const long = "x".repeat(500);
  const out = summariseBody({ first: long }, 100);
  assert.ok(out.length <= 100, `expected ≤100 chars, got ${out.length}`);
  assert.ok(out.endsWith("…"));
});

// ─────────────────────────────────────────────────────────────────────────────
// synthHeuristic
// ─────────────────────────────────────────────────────────────────────────────

test("synthHeuristic produces an answer with strategy='heuristic'", () => {
  const out = synthHeuristic({
    question: "what's btc volume?",
    responses: [fakeResponse({ answer: "1.2B" })],
    budget: fakeBudget(),
  });
  assert.equal(out.strategy, "heuristic");
  assert.match(out.answer, /1\.2B/);
});

test("synthHeuristic surfaces every paid response as a numbered line", () => {
  const out = synthHeuristic({
    question: "test",
    responses: [
      fakeResponse({ answer: "first" }),
      fakeResponse({ answer: "second" }),
      fakeResponse({ answer: "third" }),
    ],
    budget: fakeBudget(),
  });
  assert.match(out.answer, /1\..*first/);
  assert.match(out.answer, /2\..*second/);
  assert.match(out.answer, /3\..*third/);
});

test("synthHeuristic emits the canonical cost stamp", () => {
  const out = synthHeuristic({
    question: "anything",
    responses: [fakeResponse({ answer: "x" })],
    budget: fakeBudget(8400, 0.027, 3, 3),
  });
  // Cost stamp is sourced from cost.ts renderSummaryLine, which
  // formats "Answered in 8.4s, paid $0.027 USDC across 3 endpoints"
  assert.match(out.costStamp, /Answered in 8\.\ds, paid \$0\.027 USDC across 3 endpoints/);
});

test("synthHeuristic includes a citation per paid response", () => {
  const out = synthHeuristic({
    question: "test",
    responses: [
      fakeResponse({ answer: "a" }, "0xaaa", "$0.01"),
      fakeResponse({ answer: "b" }, "0xbbb", "$0.02"),
    ],
    budget: fakeBudget(),
  });
  assert.equal(out.citations.length, 2);
  assert.equal(out.citations[0].endpoint, "0xaaa");
  assert.equal(out.citations[0].price, "$0.01");
});

test("synthHeuristic handles zero responses gracefully", () => {
  const out = synthHeuristic({
    question: "no data",
    responses: [],
    budget: { ...fakeBudget(), callCount: 0, endpointsUnique: 0, totalUsd: 0 },
  });
  assert.match(out.answer, /No endpoints were paid/);
  assert.equal(out.citations.length, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// synthWithGemini (with stub)
// ─────────────────────────────────────────────────────────────────────────────

test("synthWithGemini delegates to the client and tags strategy='gemini'", async () => {
  let capturedPrompt = "";
  const client = {
    async generateText(prompt: string): Promise<string> {
      capturedPrompt = prompt;
      return "BTC volume was $1.2B over the last 24 hours [1].";
    },
  };
  const out = await synthWithGemini(
    {
      question: "what was BTC's 24h volume?",
      responses: [fakeResponse({ answer: "1.2B" })],
      budget: fakeBudget(),
    },
    client,
  );
  assert.equal(out.strategy, "gemini");
  assert.match(out.answer, /BTC volume/);
  assert.match(capturedPrompt, /what was BTC's 24h volume/);
  assert.match(capturedPrompt, /\[1\] \(paid \$0\.01/);
});

test("synthWithGemini still emits cost stamp + citations", async () => {
  const client = {
    async generateText(_prompt: string): Promise<string> {
      return "answer";
    },
  };
  const out = await synthWithGemini(
    {
      question: "x",
      responses: [fakeResponse({ answer: "a" }, "0xaaa", "$0.01")],
      budget: fakeBudget(),
    },
    client,
  );
  assert.match(out.costStamp, /paid \$0\.027/);
  assert.equal(out.citations[0].endpoint, "0xaaa");
});

test("synthWithGemini trims the answer", async () => {
  const client = {
    async generateText(_prompt: string): Promise<string> {
      return "  \n  trimmed answer  \n  ";
    },
  };
  const out = await synthWithGemini(
    {
      question: "x",
      responses: [fakeResponse({ answer: "a" })],
      budget: fakeBudget(),
    },
    client,
  );
  assert.equal(out.answer, "trimmed answer");
});

// ─────────────────────────────────────────────────────────────────────────────
// synth() auto-selection
// ─────────────────────────────────────────────────────────────────────────────

test("synth() falls back to heuristic when no client is supplied", async () => {
  const out = await synth({
    question: "x",
    responses: [fakeResponse({ answer: "a" })],
    budget: fakeBudget(),
  });
  assert.equal(out.strategy, "heuristic");
});

test("synth() uses Gemini when a client is supplied", async () => {
  const client = {
    async generateText(_prompt: string): Promise<string> {
      return "stub";
    },
  };
  const out = await synth(
    {
      question: "x",
      responses: [fakeResponse({ answer: "a" })],
      budget: fakeBudget(),
    },
    client,
  );
  assert.equal(out.strategy, "gemini");
});
