import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BudgetExceededError,
  BudgetTracker,
  parseQuote,
  renderSummaryLine,
} from "../src/cost.ts";

// ---------------------------------------------------------------------------
// parseQuote
// ---------------------------------------------------------------------------

test("parseQuote handles dollar-prefix shape", () => {
  assert.equal(parseQuote("$0.01").usd, 0.01);
  assert.equal(parseQuote("$1.23").usd, 1.23);
});

test("parseQuote handles bare number shape", () => {
  assert.equal(parseQuote("0.05").usd, 0.05);
});

test("parseQuote handles trailing USD/USDC currency token", () => {
  assert.equal(parseQuote("1.23 USD").usd, 1.23);
  assert.equal(parseQuote("0.5 USDC").usd, 0.5);
});

test("parseQuote treats 'free' and empty as zero", () => {
  assert.equal(parseQuote("free").usd, 0);
  assert.equal(parseQuote("Free").usd, 0);
  assert.equal(parseQuote("").usd, 0);
  assert.equal(parseQuote(undefined).usd, 0);
  assert.equal(parseQuote(null).usd, 0);
});

test("parseQuote returns NaN usd for unparseable input", () => {
  assert.ok(Number.isNaN(parseQuote("twenty bucks").usd));
  assert.ok(Number.isNaN(parseQuote("-1").usd)); // negative not allowed
});

// ---------------------------------------------------------------------------
// BudgetTracker
// ---------------------------------------------------------------------------

test("BudgetTracker rejects negative cap at construction", () => {
  assert.throws(() => new BudgetTracker(-1), TypeError);
});

test("BudgetTracker accepts a zero cap (free-only sessions)", () => {
  const b = new BudgetTracker(0);
  assert.equal(b.spent(), 0);
  assert.equal(b.remaining(), 0);
  // free quote charges still work even on a $0 cap
  const free = parseQuote("free");
  assert.ok(b.canAfford(free));
  b.charge("https://api/free", free);
  assert.equal(b.spent(), 0);
});

test("BudgetTracker tracks running spend across multiple charges", () => {
  const b = new BudgetTracker(0.1);
  b.charge("https://api/a", parseQuote("$0.01"));
  b.charge("https://api/b", parseQuote("$0.02"));
  assert.ok(Math.abs(b.spent() - 0.03) < 1e-9);
  assert.ok(Math.abs(b.remaining() - 0.07) < 1e-9);
});

test("BudgetTracker.canAfford returns false for charges that would exceed cap", () => {
  const b = new BudgetTracker(0.05);
  b.charge("https://api/a", parseQuote("$0.04"));
  assert.equal(b.canAfford(parseQuote("$0.02")), false);
  assert.equal(b.canAfford(parseQuote("$0.01")), true);
});

test("BudgetTracker.charge throws BudgetExceededError when over cap", () => {
  const b = new BudgetTracker(0.05);
  b.charge("https://api/a", parseQuote("$0.04"));
  assert.throws(
    () => b.charge("https://api/b", parseQuote("$0.02")),
    BudgetExceededError,
  );
});

test("BudgetTracker refuses NaN-priced calls", () => {
  const b = new BudgetTracker(1);
  const bad = parseQuote("twenty bucks");
  assert.equal(b.canAfford(bad), false);
  assert.throws(() => b.charge("https://api/x", bad), BudgetExceededError);
});

test("BudgetTracker.ledger returns read-only view of recorded calls", () => {
  const b = new BudgetTracker(0.1);
  b.charge("https://api/a", parseQuote("$0.01"), "first call");
  b.charge("https://api/b", parseQuote("$0.02"), "second call");
  const led = b.ledger();
  assert.equal(led.length, 2);
  assert.equal(led[0].endpoint, "https://api/a");
  assert.equal(led[0].description, "first call");
  assert.equal(led[1].quote.usd, 0.02);
});

test("BudgetTracker.summary reports unique-endpoint count", () => {
  const b = new BudgetTracker(1);
  b.charge("https://api/a", parseQuote("$0.01"));
  b.charge("https://api/a", parseQuote("$0.01")); // same endpoint twice
  b.charge("https://api/b", parseQuote("$0.01"));
  const s = b.summary();
  assert.equal(s.callCount, 3);
  assert.equal(s.endpointsUnique, 2);
});

// ---------------------------------------------------------------------------
// renderSummaryLine
// ---------------------------------------------------------------------------

test("renderSummaryLine produces the canonical demo string", () => {
  const b = new BudgetTracker(1);
  b.charge("https://api/a", parseQuote("$0.01"));
  b.charge("https://api/b", parseQuote("$0.012"));
  b.charge("https://api/c", parseQuote("$0.005"));
  const out = renderSummaryLine(b.summary());
  assert.match(out, /Answered in \d+\.\ds, paid \$0\.027 USDC across 3 endpoints/);
});

test("renderSummaryLine pluralises endpoint vs endpoints", () => {
  const b = new BudgetTracker(1);
  b.charge("https://api/a", parseQuote("$0.05"));
  const out = renderSummaryLine(b.summary());
  assert.match(out, /across 1 endpoint$/);
});

test("renderSummaryLine handles the no-paid-calls case", () => {
  const b = new BudgetTracker(1);
  const out = renderSummaryLine(b.summary());
  assert.match(out, /Answered in \d+\.\ds with no paid calls/);
});
