/**
 * ask.ts — orchestrator that turns a question into a paid answer.
 *
 * Threads the seven primitives together:
 *
 *   loadRegistry  ─→  rank()  ─→  paidFetch each top-N  ─→  synth()
 *
 * Designed to be testable — every external dependency (rank LLM,
 * paidFetch fetcher, synth LLM) is supplied as a parameter so unit
 * tests run with stubs and the real CLI fills them in.
 *
 * The actual `argus ask "question"` CLI wiring lands in cli.ts at
 * build-week Day 5; this module is the ts-level entry point that
 * cli.ts will call into.
 */

import type { RankInput, RankResult } from "./rank.ts";
import { rankHeuristic } from "./rank.ts";
import type { PaidFetchOptions, PaidFetchResult, X402PaymentClient } from "./payment.ts";
import { paidFetch } from "./payment.ts";
import { BudgetTracker } from "./cost.ts";
import { loadRegistry, buyableEntries, type RegistryEntry } from "./registry.ts";
import type { SynthInput, SynthOutput } from "./synth.ts";
import { synthHeuristic } from "./synth.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface AskOptions {
  /** The user's research question. */
  question: string;
  /** Hard cap on USDC the session can spend. Default $0.10. */
  budgetUsd?: number;
  /** How many of the top-ranked endpoints to actually pay. Default 3. */
  payTopN?: number;
  /** Per-call cap; refuse any single requirement above this. Default budget/payTopN. */
  maxPerCallUsd?: number;
  /** Payment client (mock for tests, real for build-week). */
  client: X402PaymentClient;
  /** Optional pre-loaded registry; otherwise loadRegistry() is called. */
  registry?: RegistryEntry[];
  /** Optional ranker injection — tests stub this; real run uses Gemini or heuristic fallback. */
  rankFn?: (input: RankInput) => Promise<RankResult>;
  /** Optional synth injection. */
  synthFn?: (input: SynthInput) => Promise<SynthOutput>;
  /** Override the fetch used by paidFetch (testing). */
  fetchImpl?: typeof fetch;
  /** Sink for human-readable progress lines. Default: console.log. */
  log?: (line: string) => void;
}

export interface AskResult {
  question: string;
  synth: SynthOutput;
  paid: PaidFetchResult[];
  /** Endpoints the ranker chose but we couldn't pay (out-of-budget, no rail, etc.). */
  skipped: { entry: RegistryEntry; reason: string }[];
  rankedTotal: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Defaults
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_BUDGET = 0.10;
const DEFAULT_PAY_TOP_N = 3;

async function defaultRank(input: RankInput): Promise<RankResult> {
  return rankHeuristic(input);
}

async function defaultSynth(input: SynthInput): Promise<SynthOutput> {
  return synthHeuristic(input);
}

// ─────────────────────────────────────────────────────────────────────────────
// Orchestrator
// ─────────────────────────────────────────────────────────────────────────────

export async function ask(opts: AskOptions): Promise<AskResult> {
  const log = opts.log ?? ((s: string) => console.log(s));
  const budgetCap = opts.budgetUsd ?? DEFAULT_BUDGET;
  const payTopN = opts.payTopN ?? DEFAULT_PAY_TOP_N;
  const maxPerCallUsd =
    opts.maxPerCallUsd ?? budgetCap / payTopN;
  const rankFn = opts.rankFn ?? defaultRank;
  const synthFn = opts.synthFn ?? defaultSynth;

  // 1. Registry
  const allEntries = opts.registry ?? (await loadRegistry());
  const candidates = buyableEntries(allEntries);
  log(`[ask] ${candidates.length} buyable candidates from the registry`);

  // 2. Rank
  const ranking = await rankFn({
    question: opts.question,
    candidates,
    topN: payTopN,
  });
  log(`[ask] ranked via ${ranking.strategy}; trying top ${ranking.ranked.length}:`);
  for (const r of ranking.ranked) {
    log(`       ${r.score.toFixed(2)}  ${r.entry.name}  — ${r.reason}`);
  }

  // 3. Pay each top-N in turn (sequentially so budget refusals fail fast)
  const budget = new BudgetTracker(budgetCap);
  const paid: PaidFetchResult[] = [];
  const skipped: { entry: RegistryEntry; reason: string }[] = [];

  for (const ranked of ranking.ranked) {
    const entry = ranked.entry;
    try {
      const result = await paidFetch(entry.url, {
        client: opts.client,
        budget,
        maxPerCallUsd,
        fetchImpl: opts.fetchImpl,
        description: `ask("${opts.question.slice(0, 40)}")`,
      });
      paid.push(result);
      log(`[ask]  paid ${result.paid.raw} for ${entry.name}`);
    } catch (err) {
      const reason = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      skipped.push({ entry, reason });
      log(`[ask]  skipped ${entry.name} — ${reason}`);
      // If we ran out of budget, no point trying the rest.
      if (budget.remaining() <= 0) break;
    }
  }

  // 4. Synthesise
  const synth = await synthFn({
    question: opts.question,
    responses: paid,
    budget: budget.summary(),
  });

  log(`[ask] ${synth.costStamp}`);
  return {
    question: opts.question,
    synth,
    paid,
    skipped,
    rankedTotal: ranking.ranked.length,
  };
}
