/**
 * rank.ts — given a research question and a candidate-endpoint pool,
 * order them by likely answer-fit so Argus pays only the most relevant
 * top-N rather than spraying USDC at every match.
 *
 * Two strategies share one interface:
 *
 *   1. **Heuristic** — pure-logic, deterministic, zero-network. Looks at
 *      lexical overlap between the question and each endpoint's name,
 *      URL path, and probe-derived endpoint descriptions. Useful as a
 *      fallback and as a sanity baseline for any LLM ranker.
 *
 *   2. **Gemini** — LLM-judged ranking via Gemini Pro. Wins on nuance
 *      (semantic match, freshness reasoning) but adds cost, latency,
 *      and API-key dependency. Only used when GEMINI_API_KEY is present.
 *
 * The CLI/web UI calls `rank()` which auto-selects: Gemini if
 * configured, else heuristic. The summary line at the end of an Argus
 * run notes which strategy ran.
 */

import type { RegistryEntry } from "./registry.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface RankInput {
  question: string;
  candidates: RegistryEntry[];
  /** Optional cap on the result list. Returns all if omitted. */
  topN?: number;
}

export interface RankedCandidate {
  entry: RegistryEntry;
  /** 0..1 score; 1 = best fit. */
  score: number;
  /** One-line plain-language reason for the score. */
  reason: string;
}

export interface RankResult {
  strategy: "heuristic" | "gemini";
  ranked: RankedCandidate[];
  /** Only set when strategy = "gemini". Approximate USD cost of the LLM call. */
  llmCostUsd?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Heuristic ranking (deterministic, no network)
// ─────────────────────────────────────────────────────────────────────────────

const STOPWORDS = new Set([
  "the", "a", "an", "of", "and", "or", "to", "for", "in", "on",
  "at", "by", "with", "what", "which", "is", "are", "was", "were",
  "from", "this", "that", "these", "those", "as", "be", "do", "i",
]);

function tokenise(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/**
 * Score one candidate against the question by Jaccard overlap of
 * token sets, plus a tiny boost for the canonical service category.
 *
 * Returns a value in [0, 1]. Pure function.
 */
export function scoreHeuristic(
  question: string,
  entry: RegistryEntry,
): { score: number; overlap: string[] } {
  const qTokens = new Set(tokenise(question));
  const eTokens = new Set([
    ...tokenise(entry.name),
    ...tokenise(entry.url),
  ]);
  if (qTokens.size === 0 || eTokens.size === 0) {
    return { score: 0, overlap: [] };
  }
  const overlap: string[] = [];
  for (const t of qTokens) {
    if (eTokens.has(t)) overlap.push(t);
  }
  const jaccard = overlap.length / new Set([...qTokens, ...eTokens]).size;
  const categoryBoost = entry.category === "services" ? 0.1 : 0;
  return { score: Math.min(1, jaccard + categoryBoost), overlap };
}

export function rankHeuristic(input: RankInput): RankResult {
  const ranked: RankedCandidate[] = input.candidates.map((entry) => {
    const { score, overlap } = scoreHeuristic(input.question, entry);
    const reason =
      overlap.length > 0
        ? `lexical overlap: ${overlap.slice(0, 4).join(", ")}`
        : "no lexical overlap; baseline category-prior only";
    return { entry, score, reason };
  });
  ranked.sort((a, b) => b.score - a.score);
  const sliced =
    typeof input.topN === "number" ? ranked.slice(0, input.topN) : ranked;
  return { strategy: "heuristic", ranked: sliced };
}

// ─────────────────────────────────────────────────────────────────────────────
// Gemini ranking (LLM-driven, network)
// ─────────────────────────────────────────────────────────────────────────────

const GEMINI_PROMPT_PREAMBLE = `You are a relevance ranker for x402-paid research endpoints. Given a research question and a list of candidate endpoints (name + URL + category), assign each a score from 0.0 (irrelevant) to 1.0 (high fit) and a one-line reason. Return strict JSON.

Rules:
- Reason must reference SPECIFIC tokens from the endpoint name/URL.
- Penalize infrastructure/facilitator entries when the question asks for data.
- Penalize service entries when the question asks for tooling.
- Be conservative: if you cannot tell, score 0.3 with reason "insufficient signal".
`;

interface GeminiClientLike {
  /**
   * Minimal interface the rank function needs from a Gemini client.
   * Real implementation lives behind GEMINI_API_KEY at build-week
   * Day 3; tests use a stub matching this signature.
   */
  generateJson<T>(prompt: string): Promise<T>;
}

interface GeminiRankItem {
  index: number;
  score: number;
  reason: string;
}

export async function rankWithGemini(
  input: RankInput,
  client: GeminiClientLike,
): Promise<RankResult> {
  const numbered = input.candidates
    .map(
      (e, i) =>
        `${i}. ${e.name} | ${e.url} | category=${e.category}`,
    )
    .join("\n");
  const prompt = [
    GEMINI_PROMPT_PREAMBLE,
    "",
    "Question:",
    input.question,
    "",
    "Candidates:",
    numbered,
    "",
    'Return JSON of shape {"items": [{"index": <int>, "score": <0..1>, "reason": "<text>"}, ...]} ordered by score descending. Include every candidate.',
  ].join("\n");

  const out = await client.generateJson<{ items: GeminiRankItem[] }>(prompt);
  const ranked: RankedCandidate[] = out.items
    .filter((x) => x.index >= 0 && x.index < input.candidates.length)
    .map((x) => ({
      entry: input.candidates[x.index],
      score: Math.max(0, Math.min(1, x.score)),
      reason: x.reason,
    }));
  ranked.sort((a, b) => b.score - a.score);
  const sliced =
    typeof input.topN === "number" ? ranked.slice(0, input.topN) : ranked;
  return { strategy: "gemini", ranked: sliced };
}

// ─────────────────────────────────────────────────────────────────────────────
// Auto-selecting entry point
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Top-level rank: prefer Gemini if a client is supplied, else fall
 * back to the deterministic heuristic.
 */
export async function rank(
  input: RankInput,
  client?: GeminiClientLike,
): Promise<RankResult> {
  if (client) return rankWithGemini(input, client);
  return rankHeuristic(input);
}
