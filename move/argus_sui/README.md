# Argus on Sui — multi-source research receipts

> Sui Overflow 2026 — Agentic Web track submission.

Argus is an **auditable multi-source research agent built on Sui
Payment Kit + Walrus + Seal**. When the agent answers a research
question by querying *N* paid endpoints, every per-source payment
and the hash of every response blob is committed in **one atomic
Programmable Transaction Block**. Either all sources settle and all
hashes record, or zero do — no partial-fill, no orphan payments.

## The wedge

x402 (Coinbase's HTTP micropayment protocol) has a documented
race-condition class: the facilitator's HTTP timeout (~5–10 s) is
shorter than Base's chain confirmation under load, so payments
succeed on-chain *after* the facilitator has already 402'd. Real
production reports:

- **GitHub `x402-foundation/x402#1062`** (lpender, 2026-01-31, with BaseScan tx `0x8e01aace…629ae696` as proof): *"100% payment failures despite correct client implementation. Users pay for requests but receive no data because payments succeed on-chain after the facilitator has already timed out."*
- **NDSS 2026 Poster #51** (Hwang & Choi, Sungkyunkwan University), peer-reviewed: *"Exploiting the Two-Phase Gap in the x402 Protocol."*
- **arXiv 2603.01179** (Peking U + SJTU, March 2026): *"A402: Binding Cryptocurrency Payments to Service Execution."*

Single-call atomicity is well-trodden ground on Sui — `s402`,
`a402` / Beep, and APEX Protocol all ship that. Argus's wedge is
**multi-source bundle atomicity**, paired with **on-chain
commitment of each source's response-blob hash in the same PTB as
its payment**. That combination is exactly Sam Blackshear's
verbatim Sep-2025 demo shape — *"a client agent performing six
separate purchases from three merchant agents in a single atomic
transaction on Sui"* — adapted to research-agent semantics.

## How it differs

|                                              | s402  | a402 / Beep | APEX     | **Argus** |
| -------------------------------------------- | ----- | ----------- | -------- | --------- |
| Atomicity                                    | per-call | per-call | escrow   | **multi-source bundle** |
| On-chain blob-hash commitment in payment PTB | no    | no          | post-hoc | **yes**   |
| Phantom-typed nonce-keyed receipt registry   | yes   | unknown     | no       | **yes (Mysten `sui-payment-kit` pattern)** |
| Walrus + Seal stack                          | partial | partial   | no       | **yes**   |

## What this *isn't*

Honest framing matters more than aspirational claims:

- **Not a Walrus uploader.** Walrus uploads happen off-chain and async; the blob exists *before* the PTB runs. The PTB commits the hash of an *already-stored* blob alongside payment.
- **Not a proof of source authenticity.** Today's x402 endpoints don't sign their response bodies. The on-chain hash proves the agent observed specific bytes — not that the endpoint produced them. The receipt is an **audit / replay / dispute log**, not source attestation. Adding endpoint signatures (or TEE attestation, or trusted relays) is a follow-on; the primitive defined here is the substrate they slot into.

## On-chain artefacts

### Move surface

```
sources/
├── argus.move              ~80 LOC — vault, AdminCap, ArgusConfig (versioned)
└── research_session.move  ~370 LOC — ResearchSession<T> + receipt registry
tests/
└── research_session_tests.move  21 unit tests, all branches
```

`pay_and_record<T>(config, &mut session, amount, payee, blob_hash, nonce, ctx)`
is the atomicity primitive. PTBs chain N of these. The receipt registry uses
a `phantom T`-keyed dynamic field — the same pattern Mysten's own
`sui-payment-kit` ships — so a USDC nonce can't collide with a USDT nonce,
and replay attacks abort with `EReceiptAlreadyExists`.

### Testnet deployment

Live on Sui testnet:

| | |
| - | - |
| Package | [`0xca33144f3cac917b81d41d6720c942d51c0691a5dea8dbd5940d93ba8cc03c74`](https://suiscan.xyz/testnet/object/0xca33144f3cac917b81d41d6720c942d51c0691a5dea8dbd5940d93ba8cc03c74) |
| ArgusConfig (shared) | `0x1c6fefe5fbcd5b973a38abdcc37d5e156d8a9dd78cfd26a17ed4ab91734a8c8e` |
| AdminCap | `0xd475230d54aa649ea4b05f63740c70de1641344b599d0708f5191ad7722ae2e1` |

### Live e2e proof

A demo run (3 sources, 1 PTB, atomic settle):

| step | digest |
| - | - |
| mint | [`CRyiqGJQndSMERrGSpu5cppjfRvBpnukxMrv8QjTmB6X`](https://suiscan.xyz/testnet/tx/CRyiqGJQndSMERrGSpu5cppjfRvBpnukxMrv8QjTmB6X) |
| **bundle (3 ReceiptRecorded events from ONE tx)** | [`H7e9B8jXoyhMnhHYuSTFf4yDooq9wuHTUsAHwrrA3Psx`](https://suiscan.xyz/testnet/tx/H7e9B8jXoyhMnhHYuSTFf4yDooq9wuHTUsAHwrrA3Psx) |
| lock | [`EYW41KHqm8Kg5MuUeScQmkFx9kkkMt4CZFSyDVUzwdMS`](https://suiscan.xyz/testnet/tx/EYW41KHqm8Kg5MuUeScQmkFx9kkkMt4CZFSyDVUzwdMS) |

Read the bundle tx on suiscan; the events list shows three
`ReceiptRecorded` events emitted from the same transaction — one
PTB, one block, all-or-nothing.

## Reproduce

```bash
git clone https://github.com/kite-builds/argus
cd argus && git checkout feat/sui-conk
npm install
cd move/argus_sui && sui move test                      # 21/21 unit tests
cd ../..
ARGUS_E2E=testnet npm test -- test/sui-e2e.test.ts      # live testnet e2e
node --experimental-strip-types scripts/demo-bundle.ts              # honest run
node --experimental-strip-types scripts/demo-bundle.ts --malicious  # fail-closed reveal
```

The `--malicious` flag inflates one source's price 100× to push the
bundle over budget. The PTB aborts on `EBudgetExceeded`; sources 1
and 2 also revert. The `ResearchSession` object stays empty. That
property is the wedge.

## Stack

- **Move** — phantom types, dynamic fields, `Balance<T>` custody, `seal_approve` gate
- **Walrus** — response-blob storage, hash committed on-chain
- **Seal** — owner + allowlist decryption gate
- **Sui Payment Kit pattern** — receipt registry mirrors Mysten's reference implementation
- **MemWal** *(planned, optional)* — cross-session memory addressed by zkLogin identity, used as a TS-side dependency, not an on-chain dependency

## Roadmap

- **Pre-submission (now):** testnet-only, demo video.
- **Submission (Sat 2026-05-23):** Devfolio entry citing this README + the demo video.
- **Mainnet by August:** unlocks the second 50 % of any prize won. Same package, mainnet env.
- **`@kite/argus-sdk` on npm + `@kite/oc-argus` OpenClaw plugin:** ClawHub currently has zero agent-payment plugins; this is the distribution wedge alongside the Move primitive.
- **AP2-compatible execution-correctness primitive:** post-hackathon framing for the $150 M AI Ecosystem Fund / Sui Foundation grant pipeline. The hash-binding-with-payment story slots into Mysten + Google's AP2 mandate-delegation flow without overlapping their "intent → authorization → signaling → execution → receipt" stack.

## License

MIT.
