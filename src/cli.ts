#!/usr/bin/env node
/**
 * argus — autonomous research agent that pays for the data it needs.
 *
 * v0.0.1 CLI: limited to discovery + probing. Pre-build prep before
 * Milan AI Agent Olympics build phase (May 13). Real LLM ranking +
 * payment will land during build week.
 *
 * Subcommands:
 *   argus list           — print the registry of buyable services
 *   argus probe <name>   — probe one service (or top-N) for x402 metadata
 *   argus probe --all    — sweep all services and report which expose
 *                          machine-readable manifests
 */

import { loadRegistry, buyableEntries, type RegistryEntry } from "./registry.js";
import { probe } from "./probe.js";

async function listCmd(): Promise<void> {
  const all = await loadRegistry();
  const buy = buyableEntries(all);
  console.log(`registry: ${all.length} entries (${buy.length} buyable)`);
  for (const e of buy.slice(0, 20)) {
    console.log(`  ${e.name.padEnd(28)}  ${e.url}`);
  }
  if (buy.length > 20) console.log(`  …and ${buy.length - 20} more (use --all to see all)`);
}

function findEntry(needle: string, entries: RegistryEntry[]): RegistryEntry | undefined {
  const lc = needle.toLowerCase();
  return entries.find((e) => e.name.toLowerCase() === lc) ||
         entries.find((e) => e.name.toLowerCase().includes(lc)) ||
         entries.find((e) => e.url.toLowerCase().includes(lc));
}

async function probeCmd(args: string[]): Promise<void> {
  const all = buyableEntries(await loadRegistry());
  if (args[0] === "--all") {
    console.log(`probing ${all.length} services in parallel (limit 6)…\n`);
    const limit = 6;
    const results: { entry: RegistryEntry; result: Awaited<ReturnType<typeof probe>> }[] = [];
    for (let i = 0; i < all.length; i += limit) {
      const batch = all.slice(i, i + limit);
      const out = await Promise.all(batch.map((e) => probe(e.url).then((r) => ({ entry: e, result: r }))));
      results.push(...out);
    }
    const detected = results.filter((r) => r.result.source !== null);
    const withManifest = detected.filter((r) => r.result.source === "manifest");
    console.log(`detected x402 surface: ${detected.length}/${all.length}`);
    console.log(`  with manifest:        ${withManifest.length}`);
    console.log("");
    console.log("services exposing /.well-known/x402-manifest.json:");
    for (const r of withManifest.slice(0, 30)) {
      const eps = r.result.endpoints.length;
      console.log(`  ${r.entry.name.padEnd(28)}  ${eps} endpoint(s)  ${r.entry.url}`);
    }
    return;
  }
  const target = args[0];
  if (!target) {
    console.error("usage: argus probe <name|url>  OR  argus probe --all");
    process.exit(1);
  }
  const entry = findEntry(target, all);
  if (!entry) {
    console.error(`no registry entry matching: ${target}`);
    process.exit(1);
  }
  console.log(`probing ${entry.name} (${entry.url})…\n`);
  const result = await probe(entry.url);
  console.log(JSON.stringify(result, null, 2));
}

async function main(): Promise<void> {
  const [, , cmd, ...rest] = process.argv;
  switch (cmd) {
    case "list":
      return listCmd();
    case "probe":
      return probeCmd(rest);
    case undefined:
    case "help":
    case "-h":
    case "--help":
      console.log(`argus — autonomous research agent (v0.0.1 prep)\n`);
      console.log(`commands:`);
      console.log(`  argus list              list buyable services from the registry`);
      console.log(`  argus probe <name|url>  probe one service for x402 metadata`);
      console.log(`  argus probe --all       sweep all services, report manifest coverage`);
      return;
    default:
      console.error(`unknown command: ${cmd}\nrun 'argus help'`);
      process.exit(1);
  }
}

main().catch((e) => {
  console.error("argus error:", e);
  process.exit(1);
});
