/**
 * payment.ts — execute x402 paid GET requests through a pluggable
 * payment-client interface.
 *
 * The actual on-chain settlement is owned by an `X402PaymentClient`
 * (see interface below). Argus stays out of wallet management and
 * USDC math — those concerns live one layer down. This module is
 * responsible only for:
 *
 *   1. Issuing the unauthenticated GET to discover the 402 challenge
 *      shape (`x402Version`, `accepts[]`, `payTo`, etc.).
 *   2. Picking the cheapest acceptable payment requirement from the
 *      `accepts[]` array under the session budget.
 *   3. Asking the payment client for an `X-PAYMENT` header.
 *   4. Retrying the request with the header, returning the body.
 *   5. Booking the spend on the supplied BudgetTracker.
 *   6. Surfacing typed errors for the cases worth distinguishing
 *      (challenge-malformed, no-acceptable-rail, payment-rejected,
 *      retry-rejected).
 *
 * A stub in-memory client is exported for tests and for the
 * `--mock-payments` CLI flag during build-week local iteration.
 */

import { BudgetTracker, parseQuote, type PriceQuote } from "./cost.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface X402PaymentRequirement {
  scheme: string;          // "exact"
  price: string;            // "$0.01" / "0.05 USDC"
  network: string;          // "base" / "stellar:testnet" / "sui:mainnet"
  payTo: string;
}

export interface X402Challenge {
  x402Version: number;
  accepts: X402PaymentRequirement[];
  /** Free-form description from the resource server. */
  description?: string;
  /** Anything else the facilitator returned. */
  raw?: unknown;
}

export interface X402PaymentClient {
  /**
   * Build an `X-PAYMENT` header value for the given requirement.
   * Implementations are responsible for signing + facilitator
   * coordination.
   */
  buildPaymentHeader(req: X402PaymentRequirement): Promise<string>;

  /** Networks this client can settle on, e.g. ["base", "stellar:testnet"]. */
  supportedNetworks(): readonly string[];
}

export interface PaidFetchOptions {
  client: X402PaymentClient;
  budget: BudgetTracker;
  /** Soft-cap on what we'll pay for this single call, regardless of the budget. */
  maxPerCallUsd?: number;
  /** Override the default fetch (testing). */
  fetchImpl?: typeof fetch;
  /** Optional human-readable description recorded on the budget ledger. */
  description?: string;
}

export interface PaidFetchResult {
  body: unknown;
  status: number;
  paid: PriceQuote;
  paymentRequirement: X402PaymentRequirement;
}

// ─────────────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────────────

export class ChallengeMalformedError extends Error {
  readonly status: number;
  readonly raw: unknown;
  constructor(status: number, raw: unknown) {
    super(`x402 challenge body was not parseable as a v1/v2 challenge (status=${status})`);
    this.name = "ChallengeMalformedError";
    this.status = status;
    this.raw = raw;
  }
}

export class NoAcceptableRailError extends Error {
  readonly accepts: X402PaymentRequirement[];
  readonly supported: readonly string[];
  constructor(accepts: X402PaymentRequirement[], supported: readonly string[]) {
    super(
      `No acceptable payment rail. Resource accepts ${accepts.length} requirement(s) on networks ` +
      `${accepts.map((a) => a.network).join(", ") || "(none)"}; client supports ${supported.join(", ") || "(none)"}.`,
    );
    this.name = "NoAcceptableRailError";
    this.accepts = accepts;
    this.supported = supported;
  }
}

export class PaymentRejectedError extends Error {
  readonly status: number;
  readonly raw: unknown;
  constructor(status: number, raw: unknown) {
    super(`Resource server rejected the X-PAYMENT header (status=${status})`);
    this.name = "PaymentRejectedError";
    this.status = status;
    this.raw = raw;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Core paidFetch
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Perform a paid GET against `url`. Returns body + the PriceQuote we
 * actually paid. Throws one of the typed errors above on the cases
 * worth distinguishing.
 *
 * Booking model: only the SUCCESSFUL retry is charged to the budget.
 * The discovery-probe call (the one that returns 402) is free and
 * does not consume any cap.
 */
export async function paidFetch(
  url: string,
  options: PaidFetchOptions,
): Promise<PaidFetchResult> {
  const fetcher = options.fetchImpl ?? fetch;

  // 1. Probe the resource for a 402 challenge.
  const probeRes = await fetcher(url, { method: "GET" });
  if (probeRes.status !== 402) {
    if (probeRes.ok) {
      // The endpoint was free. Return as-is so the caller gets
      // useful data with zero spend.
      const body = await safeJson(probeRes);
      return {
        body,
        status: probeRes.status,
        paid: { raw: "free", usd: 0 },
        paymentRequirement: {
          scheme: "free",
          price: "free",
          network: "n/a",
          payTo: "n/a",
        },
      };
    }
    throw new ChallengeMalformedError(probeRes.status, await safeJson(probeRes));
  }

  // 2. Parse the challenge body.
  const challenge = await safeJson(probeRes);
  if (!isChallenge(challenge)) {
    throw new ChallengeMalformedError(probeRes.status, challenge);
  }

  // 3. Filter to networks the client can settle on, then pick the cheapest.
  const supported = options.client.supportedNetworks();
  const eligible = challenge.accepts
    .filter((r) => supported.includes(r.network))
    .map((r) => ({ req: r, quote: parseQuote(r.price) }))
    .filter((c) => Number.isFinite(c.quote.usd));

  if (eligible.length === 0) {
    throw new NoAcceptableRailError(challenge.accepts, supported);
  }

  eligible.sort((a, b) => a.quote.usd - b.quote.usd);
  const chosen = eligible[0];

  // 4. Per-call cap, if requested.
  if (typeof options.maxPerCallUsd === "number" && chosen.quote.usd > options.maxPerCallUsd) {
    throw new NoAcceptableRailError(
      [chosen.req],
      supported,
    );
  }

  // 5. Budget gate (without booking yet — we book on success).
  if (!options.budget.canAfford(chosen.quote)) {
    throw new NoAcceptableRailError([chosen.req], supported);
  }

  // 6. Build payment header + retry.
  const header = await options.client.buildPaymentHeader(chosen.req);
  const paidRes = await fetcher(url, {
    method: "GET",
    headers: { "X-PAYMENT": header },
  });

  if (paidRes.status === 402 || paidRes.status >= 400) {
    throw new PaymentRejectedError(paidRes.status, await safeJson(paidRes));
  }

  // 7. Book the spend.
  options.budget.charge(url, chosen.quote, options.description);

  return {
    body: await safeJson(paidRes),
    status: paidRes.status,
    paid: chosen.quote,
    paymentRequirement: chosen.req,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function isChallenge(value: unknown): value is X402Challenge {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (typeof v.x402Version !== "number") return false;
  if (!Array.isArray(v.accepts)) return false;
  for (const a of v.accepts as unknown[]) {
    if (!a || typeof a !== "object") return false;
    const r = a as Record<string, unknown>;
    if (typeof r.scheme !== "string") return false;
    if (typeof r.price !== "string") return false;
    if (typeof r.network !== "string") return false;
    if (typeof r.payTo !== "string") return false;
  }
  return true;
}

async function safeJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// In-memory mock client (for tests + --mock-payments CLI flag)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Always returns a deterministic header. Useful for local iteration
 * and unit tests; never use in production.
 */
export class MockX402PaymentClient implements X402PaymentClient {
  private readonly networks: readonly string[];

  constructor(networks: readonly string[] = ["base", "stellar:testnet", "sui:mainnet"]) {
    this.networks = networks;
  }

  async buildPaymentHeader(req: X402PaymentRequirement): Promise<string> {
    return `mock:${req.network}:${req.price}:${req.payTo}`;
  }

  supportedNetworks(): readonly string[] {
    return this.networks;
  }
}
