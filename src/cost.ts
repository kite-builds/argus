/**
 * cost.ts — session-level cost accounting + budget enforcement.
 *
 * Argus's value-prop is "answers a question for a deterministic budget".
 * The demo line we want to print at the end of every run is:
 *
 *     Answered in 8.4s, paid $0.027 USDC across 3 endpoints
 *
 * That requires:
 *
 *   1. A canonical place that knows the budget cap and refuses calls
 *      that would exceed it.
 *   2. A per-endpoint ledger so the breakdown is auditable.
 *   3. A duration tracker so the wall-clock cost-per-question is
 *      visible alongside the dollar cost.
 *
 * This module is pure logic — no network, no LLM, no fs — so it's
 * fully unit-testable and reusable from both the CLI and the Vultr-
 * hosted web UI we ship during build week.
 */

export interface PriceQuote {
  /** USD-denominated price string, e.g. "$0.01" or "0.027". */
  raw: string;
  /** Parsed numeric value. NaN if the raw quote could not be parsed. */
  usd: number;
}

export interface PaidCall {
  endpoint: string;
  description?: string;
  quote: PriceQuote;
  paidAt: number; // epoch ms
}

export interface BudgetSummary {
  totalUsd: number;
  callCount: number;
  endpointsUnique: number;
  durationMs: number;
  remainingUsd: number;
  capUsd: number;
}

export class BudgetExceededError extends Error {
  // Plain field declarations + manual assignment in the constructor —
  // Node's strip-only TS mode doesn't accept "parameter properties".
  readonly endpoint: string;
  readonly quote: PriceQuote;
  readonly remaining: number;

  constructor(endpoint: string, quote: PriceQuote, remaining: number) {
    super(
      `Budget exceeded paying ${quote.raw} for ${endpoint}: only $${remaining.toFixed(4)} remaining.`,
    );
    this.name = "BudgetExceededError";
    this.endpoint = endpoint;
    this.quote = quote;
    this.remaining = remaining;
  }
}

/**
 * Parse a price quote into a normalised numeric USD value. Handles the
 * common shapes that show up in x402 manifests:
 *   "$0.01"    → 0.01
 *   "0.05"     → 0.05
 *   "1.23 USD" → 1.23
 *   "free", "" → 0
 * Anything else returns { usd: NaN } so callers can refuse the call.
 */
export function parseQuote(raw: string | undefined | null): PriceQuote {
  const s = (raw ?? "").trim();
  if (!s || /^free$/i.test(s)) {
    return { raw: s || "free", usd: 0 };
  }
  // strip leading $ or trailing currency code (USD/USDC), tolerate spaces
  const cleaned = s.replace(/^\$/, "").replace(/\s*(USD|USDC)\s*$/i, "").trim();
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n < 0) {
    return { raw: s, usd: Number.NaN };
  }
  return { raw: s, usd: n };
}

/**
 * Tracks per-session spend. One BudgetTracker per agent run.
 *
 * Usage:
 *
 *   const budget = new BudgetTracker(0.10); // $0.10 cap for the question
 *   budget.charge("https://api/foo", parseQuote("$0.01"));
 *   budget.charge("https://api/bar", parseQuote("$0.02"));
 *   const summary = budget.summary();
 *   console.log(summary.totalUsd); // 0.03
 */
export class BudgetTracker {
  private readonly capUsd: number;
  private readonly calls: PaidCall[] = [];
  private readonly startedAt: number;

  constructor(capUsd: number) {
    if (!(capUsd >= 0)) {
      throw new TypeError(`capUsd must be a non-negative number, got: ${capUsd}`);
    }
    this.capUsd = capUsd;
    this.startedAt = Date.now();
  }

  /** Total USD already paid out. */
  spent(): number {
    return this.calls.reduce((sum, c) => sum + c.quote.usd, 0);
  }

  /** USD remaining under the cap. */
  remaining(): number {
    return Math.max(0, this.capUsd - this.spent());
  }

  /** True iff a charge of `quote.usd` would still fit under the cap. */
  canAfford(quote: PriceQuote): boolean {
    if (!Number.isFinite(quote.usd) || quote.usd < 0) return false;
    return this.spent() + quote.usd <= this.capUsd;
  }

  /**
   * Record a successful paid call. Throws if the charge would put the
   * session over the cap — callers should `canAfford()` first if they
   * want to gate cleanly.
   */
  charge(endpoint: string, quote: PriceQuote, description?: string): PaidCall {
    if (!this.canAfford(quote)) {
      throw new BudgetExceededError(endpoint, quote, this.remaining());
    }
    const call: PaidCall = {
      endpoint,
      description,
      quote,
      paidAt: Date.now(),
    };
    this.calls.push(call);
    return call;
  }

  /** Read-only view of the per-call ledger. */
  ledger(): readonly PaidCall[] {
    return this.calls;
  }

  summary(): BudgetSummary {
    const totalUsd = this.spent();
    const endpoints = new Set(this.calls.map((c) => c.endpoint));
    return {
      totalUsd,
      callCount: this.calls.length,
      endpointsUnique: endpoints.size,
      durationMs: Date.now() - this.startedAt,
      remainingUsd: this.remaining(),
      capUsd: this.capUsd,
    };
  }
}

/**
 * Render the demo-friendly one-line summary.
 *
 *   "Answered in 8.4s, paid $0.027 USDC across 3 endpoints"
 *
 * Edge cases:
 *   - 0 calls           → "Answered in 8.4s with no paid calls"
 *   - 1 call            → "Answered in 8.4s, paid $0.010 USDC across 1 endpoint"
 *   - sub-second        → "Answered in 0.4s, …"
 */
export function renderSummaryLine(s: BudgetSummary): string {
  const seconds = (s.durationMs / 1000).toFixed(1);
  if (s.callCount === 0) {
    return `Answered in ${seconds}s with no paid calls`;
  }
  const dollar = s.totalUsd.toFixed(3);
  const word = s.endpointsUnique === 1 ? "endpoint" : "endpoints";
  return `Answered in ${seconds}s, paid $${dollar} USDC across ${s.endpointsUnique} ${word}`;
}
