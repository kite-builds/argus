import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

export interface RegistryEntry {
  name: string;
  url: string;
  category: "services" | "infrastructure" | "facilitators";
}

interface RegistryFile {
  scrapedAt: string;
  source: string;
  categories: Record<
    string,
    { description: string; entries: { name: string; url: string }[] }
  >;
}

let cached: RegistryEntry[] | null = null;

const here = dirname(fileURLToPath(import.meta.url));
const REGISTRY_PATH = resolve(here, "..", "data", "x402_ecosystem.json");

export async function loadRegistry(): Promise<RegistryEntry[]> {
  if (cached) return cached;
  const raw = await readFile(REGISTRY_PATH, "utf-8");
  const data = JSON.parse(raw) as RegistryFile;
  const out: RegistryEntry[] = [];
  for (const [cat, body] of Object.entries(data.categories)) {
    for (const e of body.entries) {
      out.push({ name: e.name, url: e.url, category: cat as RegistryEntry["category"] });
    }
  }
  cached = out;
  return out;
}

/** Filter to just the buyable surfaces (services). Infrastructure + facilitators
 * are tooling, not data we'd pay for. */
export function buyableEntries(all: RegistryEntry[]): RegistryEntry[] {
  return all.filter((e) => e.category === "services");
}
