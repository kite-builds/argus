import { test } from "node:test";
import assert from "node:assert/strict";
import { loadRegistry, buyableEntries, type RegistryEntry } from "../src/registry.ts";

test("loadRegistry returns a non-empty list of entries", async () => {
  const entries = await loadRegistry();
  assert.ok(Array.isArray(entries), "should be an array");
  assert.ok(entries.length >= 50, `expected >=50 ecosystem entries, got ${entries.length}`);
});

test("each registry entry has required string fields and a known category", async () => {
  const entries = await loadRegistry();
  const allowed = new Set(["services", "infrastructure", "facilitators"]);
  for (const e of entries) {
    assert.equal(typeof e.name, "string");
    assert.ok(e.name.length > 0, "name should be non-empty");
    assert.equal(typeof e.url, "string");
    assert.ok(/^https?:\/\//.test(e.url), `url should be http(s): ${e.url}`);
    assert.ok(allowed.has(e.category), `unknown category: ${e.category}`);
  }
});

test("buyableEntries returns only services category", async () => {
  const all = await loadRegistry();
  const buy = buyableEntries(all);
  assert.ok(buy.length > 0, "expected at least one buyable entry");
  for (const e of buy) {
    assert.equal(e.category, "services");
  }
  assert.ok(buy.length < all.length, "buyable should be a strict subset");
});

test("loadRegistry caches and returns identical instance on second call", async () => {
  const a = await loadRegistry();
  const b = await loadRegistry();
  assert.strictEqual(a, b, "second call should return cached array reference");
});

test("registry entries are unique within (name, url, category) — same tool can span categories", async () => {
  const entries: RegistryEntry[] = await loadRegistry();
  const seen = new Set<string>();
  for (const e of entries) {
    const key = `${e.name}|${e.url}|${e.category}`;
    assert.ok(!seen.has(key), `exact duplicate registry entry: ${key}`);
    seen.add(key);
  }
});
