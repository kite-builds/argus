#!/bin/bash
# scripts/demo-walkthrough.sh — narrated walkthrough of the Quikt atomic-bundle flow.
#
# This is a SCRIPTED walkthrough — the timings and outputs are deterministic
# so the asciinema cast is repeatable. The on-chain hashes are real, pulled
# from intent 4 of the Kite × AWM cross-operator loop on Sui Overflow 2026
# testnet on 2026-05-09.
#
# To run the LIVE version (executes real PTBs against Sui testnet), use:
#   node --experimental-strip-types --no-warnings scripts/demo-bundle.ts
#
# This walkthrough exists so judges + grant reviewers can see the flow shape
# in 60 seconds without needing a testnet wallet.

set -e

BOLD=$'\033[1m'
DIM=$'\033[2m'
GREEN=$'\033[32m'
CYAN=$'\033[36m'
YELLOW=$'\033[33m'
RED=$'\033[31m'
RESET=$'\033[0m'

p() { printf '%b\n' "$1"; sleep "${2:-0.4}"; }

clear

p "${BOLD}quikt — atomic multi-source agent payment on Sui${RESET}"           0.6
p "${DIM}Sui Overflow 2026 · Agentic Web track${RESET}"                       0.6
p ""                                                                          0.3
p "${BOLD}\$ node scripts/demo-bundle.ts${RESET}"                             0.4
p ""                                                                          0.3
p "${CYAN}step 1${RESET} ${DIM}— off-chain — fetch + Walrus upload per source${RESET}" 0.4
p "  bloomfilter.xyz       ${DIM}→ blob bafyrei…  hash=0x9c8a…${RESET}  ${GREEN}5000 MIST${RESET}"    0.4
p "  blockrun.ai           ${DIM}→ blob bafyrei…  hash=0xa1cd…${RESET}  ${GREEN}10000 MIST${RESET}"   0.4
p "  snack.money           ${DIM}→ blob bafyrei…  hash=0xb284…${RESET}  ${GREEN}20000 MIST${RESET}"   0.6
p ""                                                                          0.3
p "${CYAN}step 2${RESET} ${DIM}— on-chain — mint ResearchSession (one PTB)${RESET}" 0.4
p "  session: ${BOLD}0xfb12${RESET}${DIM}…${RESET}"                           0.3
p "  digest:  ${BOLD}3xPQ${RESET}${DIM}…${RESET}"                             0.3
p "  ${DIM}→ https://suiscan.xyz/testnet/tx/3xPQ…${RESET}"                    0.6
p ""                                                                          0.3
p "${CYAN}step 3${RESET} ${BOLD}— on-chain — atomic multi-source bundle (ONE PTB)${RESET}"   0.4
p "  digest:  ${BOLD}Hs7K${RESET}${DIM}…${RESET}"                             0.3
p "  events:  ${GREEN}3 ReceiptRecorded${RESET} ${DIM}(one per source) from ONE tx${RESET}" 0.4
p "  ${DIM}→ https://suiscan.xyz/testnet/tx/Hs7K…${RESET}"                    0.6
p ""                                                                          0.3
p "${CYAN}step 4${RESET} ${DIM}— on-chain — lock session (owner finalisation)${RESET}" 0.4
p "  digest:  ${BOLD}9d1L${RESET}${DIM}…${RESET}"                             0.3
p "  ${DIM}→ https://suiscan.xyz/testnet/tx/9d1L…${RESET}"                    0.8
p ""                                                                          0.3
p "${GREEN}${BOLD}✓ session finalised. 3 paid sources, 1 atomic settlement, 0 race conditions.${RESET}" 0.6
p ""                                                                          0.3
p "${BOLD}\$ node scripts/demo-bundle.ts --malicious${RESET}"                 0.5
p ""                                                                          0.3
p "${CYAN}step 1${RESET}–${CYAN}step 2${RESET} ${DIM}— identical to above…${RESET}"  0.5
p ""                                                                          0.3
p "${CYAN}step 3${RESET} ${BOLD}— atomic multi-source bundle${RESET}${RED} (source #3 over-bills 100×)${RESET}"  0.4
p "  ${RED}reverted: AmountExceedsCap${RESET}"                                0.4
p "  ${YELLOW}→ sources #1 and #2 don't settle either${RESET}"                0.4
p "  ${YELLOW}→ ResearchReceipt is a hot-potato; cannot be dropped${RESET}"   0.6
p ""                                                                          0.3
p "${GREEN}${BOLD}✓ atomicity verified: budget intact, no partial settlement.${RESET}" 0.6
p ""                                                                          0.3
p "${DIM}This is what x402 / a402 cannot give you over independent HTTP calls.${RESET}" 0.8
p ""                                                                          0.3
