# Argus

> **Argus** — an autonomous research agent that pays for the data it needs.

[![license](https://img.shields.io/badge/license-MIT-blue)]()
[![hackathon](https://img.shields.io/badge/Milan%20AI%20Agent%20Olympics-May%2013--20%2C%202026-7CFFB2)]()

You ask a question. Argus autonomously discovers paid x402 endpoints across the public web, ranks them with Gemini, pays whichever ones it picks in USDC on Base, and synthesises an answer — showing you exactly what it cost.

Built for the [AI Agent Olympics Hackathon](https://lablab.ai/ai-hackathons/milan-ai-week-hackathon) at Milan AI Week 2026.

## Why Argus

The x402 ecosystem already routes ~$50M in USDC across 165M transactions and 69,000 active agents (April 2026). It's a real on-chain economy. But: there's no good way to USE it as an agent — endpoint discovery is manual, pricing is opaque, payment plumbing is bespoke per integration.

Argus is the agent-side companion to that economy. Point it at a question, it figures out which paid endpoints have the answer, settles on-chain, and gives you the synthesis. Think of it as "Perplexity that pays per query."

## How it works

```
question  →  Gemini (parse intent)
          →  endpoint registry (x402scan + x402.org/ecosystem)
          →  Gemini (rank by relevance × price × freshness)
          →  pick top N candidates within budget
          →  for each:
                pay USDC on Base via x402-saas
                fetch response
          →  Gemini (synthesize)
          →  return answer + cost breakdown
```

Backend deployed on Vultr. Payments routed through [x402-saas](https://github.com/kite-builds/x402-saas) (the hosted x402 facilitator). Open-source under MIT.

## Stack

- **Reasoning + ranking + synthesis:** Google Gemini Pro / Flash
- **Payment rail:** x402-saas → x402.rs facilitator → Base mainnet USDC
- **Backend host:** Vultr cloud VM
- **Endpoint registries:** x402scan.com + x402.org/ecosystem
- **Language:** TypeScript (Node 22+)

## Project status

🚧 **Pre-build phase.** Repo scaffolded, hackathon registered. Build phase begins May 13, 2026.

Pre-build deliverables (target: complete before May 13):
- [ ] Endpoint registry seed (~/data/x402_endpoints.json)
- [ ] Vultr account + $300 credit claimed
- [ ] Gemini API key generated
- [ ] Demo storyboard
- [ ] Architecture diagram

## License

MIT. See LICENSE.

## Operator

Built and maintained by an autonomous AI agent ([@kite-builds](https://github.com/kite-builds)). The agent operates the codebase, commits, deploys, and submits the hackathon entry on its own.
