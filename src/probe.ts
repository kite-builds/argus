/**
 * probe.ts — given a base URL, try to discover x402 metadata.
 *
 * Strategy (in order, return on first hit):
 *  1) GET <root>/.well-known/x402-manifest.json — published by some
 *     ecosystem entries (CRYPTYX, etc.) per the discussion in the x402
 *     spec community. Best signal: machine-readable price + endpoints.
 *  2) GET <root>/.well-known/agent.json — emerging convention.
 *  3) GET <root>/__x402/health — x402-saas style health probe (we built
 *     this convention; some others copied).
 *  4) HEAD <root>/ and parse `WWW-Authenticate` for x402 challenge — most
 *     primitive but most x402-spec-compliant signal.
 *
 * Returns a normalized ProbeResult: where the manifest is, what
 * endpoints look like, rough price hints. NULL if nothing detected.
 */

export interface ProbeResult {
  baseUrl: string;
  source: "manifest" | "agent-json" | "health" | "challenge-header" | null;
  endpoints: { path: string; price?: string; method?: string; description?: string }[];
  facilitator?: string;
  raw?: unknown;
  error?: string;
}

const TIMEOUT_MS = 6_000;

async function fetchJson(url: string): Promise<{ ok: boolean; data?: unknown; status?: number; error?: string }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { "user-agent": "argus/0.0.1 (+https://github.com/kite-builds/argus)" },
    });
    if (!res.ok) return { ok: false, status: res.status };
    const data = await res.json();
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(t);
  }
}

async function fetchHead(url: string): Promise<{ ok: boolean; status?: number; headers?: Record<string, string> }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: "HEAD", signal: ctrl.signal, redirect: "manual" });
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
    return { ok: true, status: res.status, headers };
  } catch {
    return { ok: false };
  } finally {
    clearTimeout(t);
  }
}

function originOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return url.replace(/\/+$/, "");
  }
}

export async function probe(baseUrl: string): Promise<ProbeResult> {
  const root = originOf(baseUrl);
  const result: ProbeResult = { baseUrl: root, source: null, endpoints: [] };

  // (1) x402-manifest.json
  const m = await fetchJson(`${root}/.well-known/x402-manifest.json`);
  if (m.ok && m.data && typeof m.data === "object") {
    result.source = "manifest";
    result.raw = m.data;
    const d = m.data as Record<string, unknown>;
    const eps = (d.endpoints || d.routes || d.paths) as unknown[] | undefined;
    if (Array.isArray(eps)) {
      for (const ep of eps) {
        if (typeof ep === "object" && ep !== null) {
          const e = ep as Record<string, unknown>;
          result.endpoints.push({
            path: String(e.path ?? e.route ?? e.url ?? "/"),
            method: typeof e.method === "string" ? e.method : "GET",
            price: typeof e.price === "string" ? e.price :
                   typeof e.priceUsd === "string" ? e.priceUsd :
                   typeof e.priceUsd === "number" ? String(e.priceUsd) : undefined,
            description: typeof e.description === "string" ? e.description : undefined,
          });
        }
      }
    }
    if (typeof d.facilitator === "string") result.facilitator = d.facilitator;
    return result;
  }

  // (2) agent.json (A2A / Google convention)
  const a = await fetchJson(`${root}/.well-known/agent.json`);
  if (a.ok && a.data && typeof a.data === "object") {
    result.source = "agent-json";
    result.raw = a.data;
    return result;
  }

  // (3) health probe (x402-saas style)
  const h = await fetchJson(`${root}/__x402/health`);
  if (h.ok) {
    result.source = "health";
    result.raw = h.data;
    return result;
  }

  // (4) HEAD root + look for WWW-Authenticate: x402 challenge
  const head = await fetchHead(`${root}/`);
  if (head.ok && head.status === 402 && head.headers) {
    result.source = "challenge-header";
    result.raw = head.headers;
    return result;
  }

  result.error = "no x402 surface detected";
  return result;
}
