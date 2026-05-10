/**
 * bundle-ask.ts — the differentiated multi-source orchestrator.
 *
 * Where `ask.ts` pays endpoints sequentially (one HTTP+chain
 * round-trip each), `bundleAsk` does:
 *
 *   1. Off-chain: probe + rank + paid-fetch each top-N endpoint, in
 *      parallel where possible, and store each response on Walrus
 *      (or local stand-in) to get a blob id + content hash.
 *   2. On-chain: mint a `ResearchSession<T>` funded with the bundle
 *      budget.
 *   3. On-chain: chain N `pay_and_record` calls into ONE PTB. If any
 *      step fails (replay nonce, budget exceeded, version mismatch),
 *      the whole bundle reverts — no partial-fill, no orphan
 *      payments.
 *   4. Off-chain: synth + return.
 *
 * That single-PTB step is the property `s402` / `a402` / `Beep`
 * don't ship. It's also Sam Blackshear's verbatim Sep-2025 demo
 * shape ("six purchases from three merchants in one atomic tx"),
 * scaled down to per-source research-receipt commitments.
 */
import type { Signer } from "@mysten/sui/cryptography";
import { paidFetch, type PaidFetchResult } from "../payment.ts";
import { BudgetTracker } from "../cost.ts";
import { buyableEntries, type RegistryEntry } from "../registry.ts";
import { rankHeuristic } from "../rank.ts";
import { synthHeuristic, type SynthOutput } from "../synth.ts";
import type { SuiPaymentClient } from "./sui-payment-client.ts";
import type { WalrusTraceUploader } from "./walrus-trace.ts";
import type { BundleStep } from "./onchain.ts";

export interface BundleAskOptions {
  question: string;
  /** Hard budget cap in T-units (USDC has 6 dp; SUI has 9). */
  budgetUnits: bigint;
  /** Per-call cap in T-units. */
  maxPerCallUnits?: bigint;
  /** How many endpoints to bundle. */
  payTopN?: number;
  /** Min sources required before lock_session will succeed. */
  minSources?: number;

  /** Pre-loaded registry; otherwise loadRegistry() upstream. */
  registry: RegistryEntry[];
  client: SuiPaymentClient;
  walrus: WalrusTraceUploader;

  /**
   * Either an existing Coin<T> object id, or a u64 amount the mint
   * tx will split off the signer's gas coin in-place.
   */
  budget: { coinId: string } | { splitFromGas: bigint };

  /** Override the default fetch (testing). */
  fetchImpl?: typeof fetch;
  /** Sink for human-readable progress lines. */
  log?: (line: string) => void;
}

export interface BundleAskResult {
  /** Mint-tx digest (one PTB). */
  mintDigest: string;
  /** Bundle-tx digest — the atomic multi-source PTB. */
  bundleDigest: string;
  /** Lock-tx digest — owner finalisation. */
  lockDigest: string;
  /** On-chain session id. */
  sessionId: string;
  /** Per-source receipts. Parallel to `paid`. */
  steps: BundleStep[];
  paid: PaidFetchResult[];
  synth: SynthOutput;
  totalPaidUnits: bigint;
}

const DEFAULT_PAY_TOP_N = 3;

export async function bundleAsk(opts: BundleAskOptions): Promise<BundleAskResult> {
  const log = opts.log ?? ((s: string) => console.log(s));
  const payTopN = opts.payTopN ?? DEFAULT_PAY_TOP_N;
  const minSources = opts.minSources ?? Math.min(2, payTopN);

  // 1. Rank
  const candidates = buyableEntries(opts.registry);
  const ranked = (await rankHeuristic({
    question: opts.question,
    candidates,
    topN: payTopN,
  })).ranked;
  log(`[bundleAsk] top-${ranked.length} candidates`);

  // 2. Off-chain: paidFetch each + Walrus upload of the response
  //    body. We still pay during the off-chain probe so the agent
  //    receives the data; the on-chain `pay_and_record` then
  //    duplicates a settlement-side receipt that *cannot* be
  //    half-applied. (Production would use receipt-only off-chain
  //    flow; for the demo this is the cleanest 14-day shape.)
  const budget = new BudgetTracker(Number(opts.budgetUnits) / 1e6);
  const maxPerCallUsd =
    opts.maxPerCallUnits != null ? Number(opts.maxPerCallUnits) / 1e6 : undefined;

  const paid: PaidFetchResult[] = [];
  const steps: BundleStep[] = [];
  let nonce = 1n;
  for (const r of ranked) {
    try {
      const result = await paidFetch(r.entry.url, {
        client: opts.client,
        budget,
        maxPerCallUsd,
        fetchImpl: opts.fetchImpl,
        description: `bundleAsk("${opts.question.slice(0, 40)}")`,
      });
      const payload = new TextEncoder().encode(JSON.stringify(result.body));
      const trace = await opts.walrus.upload(payload);
      const amount = BigInt(Math.round(result.paid.usd * 1e6));
      steps.push({
        amount,
        payee: result.paymentRequirement.payTo,
        blobHash: trace.hash,
        nonce,
      });
      paid.push(result);
      log(`[bundleAsk]  prepared ${r.entry.name} ${result.paid.raw} blob=${trace.blobId}`);
      nonce += 1n;
    } catch (err) {
      const reason = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      log(`[bundleAsk]  skipped ${r.entry.name} — ${reason}`);
    }
  }

  if (steps.length < minSources) {
    throw new Error(
      `bundleAsk: only ${steps.length}/${minSources} sources prepared, refusing to mint`,
    );
  }

  // 3. On-chain: mint, then bundle, then lock
  const questionBlob = await opts.walrus.upload(new TextEncoder().encode(opts.question));
  const minted = await opts.client.mintSession({
    questionBlobId: questionBlob.blobId,
    budget: opts.budget,
    minSources,
  });
  log(`[bundleAsk]  minted session ${minted.sessionId} (digest ${minted.digest})`);

  const bundle = await opts.client.buildBundle({
    sessionId: minted.sessionId,
    steps,
  });
  log(`[bundleAsk]  bundle settled in ONE PTB (digest ${bundle.digest})`);

  const synth = await synthHeuristic({
    question: opts.question,
    responses: paid,
    budget: budget.summary(),
  });
  const synthBlob = await opts.walrus.upload(new TextEncoder().encode(synth.answer));

  const locked = await opts.client.lockSession({
    sessionId: minted.sessionId,
    responseBlobId: synthBlob.blobId,
  });
  log(`[bundleAsk]  session locked (digest ${locked.digest})`);

  const totalPaidUnits = steps.reduce((acc, s) => acc + s.amount, 0n);
  return {
    mintDigest: minted.digest,
    bundleDigest: bundle.digest,
    lockDigest: locked.digest,
    sessionId: minted.sessionId,
    steps,
    paid,
    synth,
    totalPaidUnits,
  };
}
