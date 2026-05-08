import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBullet, parseAwesomeReadme } from "../src/discover.ts";

test("parseBullet extracts name and url from a markdown list item", () => {
  const e = parseBullet("- [x402-saas](https://x402-saas.surge.sh) - blurb");
  assert.deepEqual(e, { name: "x402-saas", url: "https://x402-saas.surge.sh" });
});

test("parseBullet ignores non-bullet lines", () => {
  assert.equal(parseBullet("## Section heading"), null);
  assert.equal(parseBullet("Just a paragraph."), null);
  assert.equal(parseBullet(""), null);
});

test("parseBullet rejects bullets with non-http(s) URLs", () => {
  assert.equal(parseBullet("- [bad](javascript:alert(1))"), null);
  assert.equal(parseBullet("- [also bad](mailto:foo@bar)"), null);
});

test("parseBullet tolerates leading whitespace and trailing description", () => {
  const e = parseBullet("    - [Coinbase CDP](https://cdp.coinbase.com) — Coinbase facilitator description");
  assert.deepEqual(e, { name: "Coinbase CDP", url: "https://cdp.coinbase.com" });
});

test("parseAwesomeReadme buckets entries into the three known categories", () => {
  const md = `
# Awesome x402

## Hosted Facilitators
- [Coinbase CDP](https://cdp.coinbase.com) - Coinbase x402 facilitator
- [x402-saas](https://x402-saas.surge.sh) - Hosted multi-tenant proxy

## Tools & SDKs
- [x402-py](https://example.com/x402py) - Python SDK
- [x402-go](https://example.com/x402go) - Go SDK

## Endpoints
- [Weather API](https://example.com/weather) - x402-paid weather data

## Some Other Section
- [Ignored](https://example.com/ignored)
`;
  const reg = parseAwesomeReadme(md);
  assert.equal(reg.categories.facilitators.entries.length, 2);
  assert.equal(reg.categories.infrastructure.entries.length, 2);
  assert.equal(reg.categories.services.entries.length, 1);
  // Unmapped section is ignored — total entries equals sum across the three buckets.
  const total =
    reg.categories.facilitators.entries.length +
    reg.categories.infrastructure.entries.length +
    reg.categories.services.entries.length;
  assert.equal(total, 5);
});

test("parseAwesomeReadme dedupes within a bucket by (name, url) pair", () => {
  const md = `
## Hosted Facilitators
- [x402-saas](https://x402-saas.surge.sh) - first mention
- [x402-saas](https://x402-saas.surge.sh) - duplicate, same url
- [x402-saas](https://different.url) - same name, different url — kept
`;
  const reg = parseAwesomeReadme(md);
  assert.equal(reg.categories.facilitators.entries.length, 2);
});

test("parseAwesomeReadme stamps a scrapedAt and source", () => {
  const reg = parseAwesomeReadme("");
  assert.match(reg.scrapedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(reg.source, /awesome-x402/);
});
