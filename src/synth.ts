/**
 * synth.ts — synthesize a final answer from the bodies returned by
 * paid endpoint calls.
 *
 * Same shape as rank.ts: two strategies (heuristic, Gemini) behind
 * one auto-selecting entry point. Tests use a stub matching the
 * GeminiClientLike contract; the real Gemini Flash binding lands at
 * build-week Day 3 alongside rank.ts's binding.
 *
 * Heuristic synthesis is intentionally simple: it concatenates the
 * relevant excerpts with attribution and a one-line cost summary. It
 * exists so Argus has a graceful-degraded answer when the LLM key is
 * absent or the LLM call fails. The hackathon demo runs against
 * Gemini, but the ✅-on-eval-tonight CI run uses the heuristic path.
 */

import type { PaidFetchResult } from "./payment.ts";
import type { BudgetSummary } from "./cost.ts";
import { renderSummaryLine } from "./cost.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface SynthInput {
  question: string;
  /** Per-endpoint paid responses, in the order they were paid. */
  responses: PaidFetchResult[];
  /** Final session budget summary, used to format the cost stamp. */
  budget: BudgetSummary;
}

export interface SynthOutput {
  strategy: "heuristic" | "gemini";
  /** Final answer text. */
  answer: string;
  /** One-line cost stamp, ready to print under the answer. */
  costStamp: string;
  /** Citations: which endpoint contributed what. */
  citations: { endpoint: string; price: string }[];
}

interface GeminiSynthClient {
  generateText(prompt: string): Promise<string>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Heuristic synthesis (deterministic, no network)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pull a "headline excerpt" from a JSON body. We try, in order:
 *   1. A scalar `answer` / `result` / `value` field on the root.
 *   2. The first scalar field on the root.
 *   3. JSON.stringify of the root (truncated).
 *
 * Pure function. Used for the heuristic synthesis path AND as the
 * basis for the prompt sent to Gemini.
 */
export function summariseBody(body: unknown, maxChars = 240): string {
  if (typeof body === "string") return truncate(body, maxChars);
  if (typeof body === "number" || typeof body === "boolean") {
    return String(body);
  }
  if (body === null || body === undefined) return "(empty)";
  if (Array.isArray(body)) {
    return truncate(JSON.stringify(body), maxChars);
  }
  if (typeof body === "object") {
    const obj = body as Record<string, unknown>;
    for (const k of ["answer", "result", "value", "data", "summary"]) {
      const v = obj[k];
      if (v !== undefined && (typeof v === "string" || typeof v === "number" || typeof v === "boolean")) {
        return truncate(`${k}=${v}`, maxChars);
      }
    }
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
        return truncate(`${k}=${v}`, maxChars);
      }
    }
    return truncate(JSON.stringify(obj), maxChars);
  }
  return truncate(String(body), maxChars);
}

function truncate(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s;
  return s.slice(0, maxChars - 1) + "…";
}

export function synthHeuristic(input: SynthInput): SynthOutput {
  const citations = input.responses.map((r) => ({
    endpoint: r.paymentRequirement.payTo === "n/a"
      ? "(free)"
      : r.paymentRequirement.payTo,
    price: r.paid.raw,
  }));

  const lines: string[] = [];
  lines.push(`Question: ${input.question}`);
  lines.push("");
  if (input.responses.length === 0) {
    lines.push("No endpoints were paid. No answer is available.");
  } else {
    lines.push(`Drawn from ${input.responses.length} source(s):`);
    for (let i = 0; i < input.responses.length; i++) {
      const r = input.responses[i];
      lines.push(`  ${i + 1}. ${summariseBody(r.body)}`);
    }
  }

  return {
    strategy: "heuristic",
    answer: lines.join("\n"),
    costStamp: renderSummaryLine(input.budget),
    citations,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Gemini synthesis (LLM, network)
// ─────────────────────────────────────────────────────────────────────────────

const GEMINI_SYNTH_PREAMBLE = `You are a careful research synthesiser. You will be given a question and a set of paid-API responses. Combine them into a single concise answer.

Rules:
- Use ONLY the data in the paid responses. Do not invent numbers.
- Cite each fact by the source-index it came from, e.g. "[1]".
- If the responses disagree, say so explicitly and pick the freshest source.
- If the responses do not contain enough information to answer, say "Insufficient data" and stop.
- Keep the answer under 5 short sentences.`;

export async function synthWithGemini(
  input: SynthInput,
  client: GeminiSynthClient,
): Promise<SynthOutput> {
  const sources = input.responses
    .map((r, i) => {
      const body = summariseBody(r.body, 600);
      const tag = r.paymentRequirement.payTo === "n/a" ? "(free)" : r.paymentRequirement.payTo;
      return `[${i + 1}] (paid ${r.paid.raw} → ${tag}): ${body}`;
    })
    .join("\n");

  const prompt = [
    GEMINI_SYNTH_PREAMBLE,
    "",
    `Question: ${input.question}`,
    "",
    "Sources:",
    sources || "(no sources)",
  ].join("\n");

  const answer = await client.generateText(prompt);
  return {
    strategy: "gemini",
    answer: answer.trim(),
    costStamp: renderSummaryLine(input.budget),
    citations: input.responses.map((r) => ({
      endpoint: r.paymentRequirement.payTo === "n/a" ? "(free)" : r.paymentRequirement.payTo,
      price: r.paid.raw,
    })),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Auto-selecting entry point
// ─────────────────────────────────────────────────────────────────────────────

export async function synth(
  input: SynthInput,
  client?: GeminiSynthClient,
): Promise<SynthOutput> {
  if (client) return synthWithGemini(input, client);
  return synthHeuristic(input);
}
