# Quikt — Google Cloud Rapid Agent Hackathon submission notes

**Track:** Optimize an existing agent prototype for production reliability.

Quikt is an autonomous research agent that fans out to *N* paid data
sources and settles all of them in a single **Sui Programmable Transaction
Block** — either every payment + on-chain blob commitment lands, or the
whole bundle reverts. It uses **Gemini** to rank candidate endpoints by
relevance before spending the buyer's budget (`src/rank.ts`,
`GEMINI_API_KEY`-gated, with a deterministic heuristic fallback so the
agent never hard-fails on a missing key).

## What "production reliability" means here

A judge should be able to go from `git clone` to a green test suite and a
working build with **zero manual flags**. As of this submission that holds:

```
npm install      # clean, no --legacy-peer-deps, no ERESOLVE
npm test         # 82 tests, 81 pass, 1 skipped (live-key e2e), 0 fail
npm run build    # tsc emits dist/, .ts imports rewritten to .js
node dist/cli.js --help
```

### Reliability fixes shipped for this submission

1. **Removed a dead dependency that broke install out of the box.**
   `@mysten/walrus@1.1.7` was listed in `package.json` but never imported
   — the Walrus upload path (`src/sui/walrus-trace.ts`) talks to the public
   testnet publisher over plain HTTP precisely *to avoid* the SDK. The unused
   dependency carried a peer requirement of `@mysten/sui@^2.16`, conflicting
   with our pinned `1.x` and causing `npm install` to fail with an ERESOLVE
   error for anyone cloning fresh. Removing it makes install deterministic.

2. **Fixed `npm run build`.** Source uses explicit `.ts` import extensions
   (required by Node's `--experimental-strip-types` runtime). `tsc` rejected
   these on emit. Enabling `allowImportingTsExtensions` +
   `rewriteRelativeImportExtensions` lets the same source both run under
   strip-types *and* compile to `dist/` with imports rewritten to `.js` — so
   dev, test, and production-build paths agree.

## Honesty notes (kept from the engineering docs)

- Walrus uploads are off-chain/async; the on-chain atomicity is the coupling
  between payment and the hash of an already-stored blob, not "atomic upload."
  See the header comment in `src/sui/walrus-trace.ts`.
- The live cross-chain e2e (`test/sui-e2e.test.ts`) is **skipped** without a
  funded key — it is the one non-passing entry in the count above, by design,
  so CI stays deterministic.

## Live deployment

- Testnet package / receipt registry object:
  `0x8bfa4c14b1fd4427c0ed6c27c3fba4cb8727c02010103bda32eb48568b7edb24`
  (Suiscan: testnet).
