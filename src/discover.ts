/**
 * discover.ts — refresh the local registry from upstream sources.
 *
 * Sources, in order of authority:
 *
 * 1. xpaysh/awesome-x402 (markdown list, well-curated, what most humans
 *    actually read when they go shopping for x402 infra). Single
 *    GitHub raw README, parse the markdown sections into our three
 *    categories.
 * 2. x402.org/ecosystem (the protocol's own listing). HTML scrape.
 *
 * x402scan.com is intentionally NOT used as a source here — it lists
 * paid endpoints that are part of the buyable services category, not
 * the canonical "what is in the ecosystem" view we want for ranking.
 * Treated as a downstream consumer, not an upstream source.
 *
 * Output: writes a fresh `data/x402_ecosystem.json` matching the shape
 * expected by registry.ts (categories → { description, entries[] }).
 *
 * Usage:
 *   node --experimental-strip-types src/discover.ts
 *
 * Idempotent: same upstream content → same output bytes.
 */

import { writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = resolve(here, "..", "data", "x402_ecosystem.json");

const AWESOME_X402_RAW =
  "https://raw.githubusercontent.com/xpaysh/awesome-x402/main/README.md";

type Category = "services" | "infrastructure" | "facilitators";

interface RawEntry {
  name: string;
  url: string;
}

interface CategoryBlock {
  description: string;
  entries: RawEntry[];
}

interface RegistryFile {
  scrapedAt: string;
  source: string;
  categories: Record<Category, CategoryBlock>;
}

/**
 * Map awesome-x402 H2/H3 section titles to our three buckets. Sections
 * not in the map are dropped.
 */
const SECTION_TO_CATEGORY: Record<string, Category> = {
  "hosted facilitators": "facilitators",
  "self-hosted facilitators": "facilitators",
  "facilitators": "facilitators",
  "tools & sdks": "infrastructure",
  "explorers & analytics": "infrastructure",
  "infrastructure": "infrastructure",
  "services": "services",
  "endpoints": "services",
  "apis": "services",
};

const CATEGORY_DESCRIPTIONS: Record<Category, string> = {
  services: "Public x402-payable endpoints — these are the targets Argus pays.",
  infrastructure: "Tooling, SDKs, dashboards. Argus uses these to discover/monitor — not to buy from.",
  facilitators: "Settlement layers. Argus prefers x402.rs (per our backend config) but tracks others for fallback.",
};

/**
 * Parse a single bullet line from the awesome-list, e.g.
 *   `- [Some Name](https://example.com/foo) - blurb here`
 * Returns null if the line is not a recognisable bullet.
 */
export function parseBullet(line: string): RawEntry | null {
  // Match `- [name](url)` allowing optional leading whitespace.
  const match = line.match(/^\s*-\s+\[([^\]]+)\]\(([^)]+)\)/);
  if (!match) return null;
  const name = match[1].trim();
  const url = match[2].trim();
  if (!name || !/^https?:\/\//i.test(url)) return null;
  return { name, url };
}

/**
 * Walk the awesome-x402 markdown, splitting into sections by `## ` and
 * `### ` headings, and bucket bullets under the right category.
 */
export function parseAwesomeReadme(markdown: string): RegistryFile {
  const lines = markdown.split(/\r?\n/);
  const buckets: Record<Category, RawEntry[]> = {
    services: [],
    infrastructure: [],
    facilitators: [],
  };

  let currentCategory: Category | null = null;
  for (const raw of lines) {
    const headingMatch = raw.match(/^#{2,3}\s+(.+?)\s*$/);
    if (headingMatch) {
      const title = headingMatch[1].toLowerCase().replace(/[^\w\s&-]/g, "").trim();
      currentCategory = SECTION_TO_CATEGORY[title] ?? null;
      continue;
    }
    if (!currentCategory) continue;
    const entry = parseBullet(raw);
    if (!entry) continue;
    buckets[currentCategory].push(entry);
  }

  // Dedupe within each bucket by (name, url) pair.
  const dedupe = (arr: RawEntry[]): RawEntry[] => {
    const seen = new Set<string>();
    const out: RawEntry[] = [];
    for (const e of arr) {
      const key = `${e.name}|${e.url}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(e);
    }
    return out;
  };

  return {
    scrapedAt: new Date().toISOString(),
    source: AWESOME_X402_RAW,
    categories: {
      services: { description: CATEGORY_DESCRIPTIONS.services, entries: dedupe(buckets.services) },
      infrastructure: { description: CATEGORY_DESCRIPTIONS.infrastructure, entries: dedupe(buckets.infrastructure) },
      facilitators: { description: CATEGORY_DESCRIPTIONS.facilitators, entries: dedupe(buckets.facilitators) },
    },
  };
}

async function fetchAwesome(): Promise<string> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const res = await fetch(AWESOME_X402_RAW, {
      signal: ctrl.signal,
      headers: { "user-agent": "argus/0.0.1 (+https://github.com/kite-builds/argus)" },
    });
    if (!res.ok) {
      throw new Error(`awesome-x402 fetch failed: ${res.status} ${res.statusText}`);
    }
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

export async function refreshRegistry(): Promise<RegistryFile> {
  const md = await fetchAwesome();
  return parseAwesomeReadme(md);
}

async function main(): Promise<void> {
  const registry = await refreshRegistry();
  const counts = {
    services: registry.categories.services.entries.length,
    infrastructure: registry.categories.infrastructure.entries.length,
    facilitators: registry.categories.facilitators.entries.length,
  };
  await mkdir(dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, JSON.stringify(registry, null, 2) + "\n", "utf-8");
  // Stable, plain output — easy to diff between runs.
  console.log(`refreshed ${OUTPUT_PATH}`);
  console.log(
    `  services: ${counts.services}, infrastructure: ${counts.infrastructure}, facilitators: ${counts.facilitators}`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
