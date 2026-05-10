#!/usr/bin/env node
/**
 * scripts/demo-bundle.ts — the demo-video flow.
 *
 * Runs a deterministic 3-source research bundle against the live
 * Argus deployment on Sui testnet. Prints terminal output friendly
 * to dual-pane recording: each step shows what's happening + the
 * digest that will appear on suiscan.
 *
 * Usage:
 *   node --experimental-strip-types scripts/demo-bundle.ts
 *
 * Optional env:
 *   ARGUS_DEMO_QUESTION — override the demo question text
 *   ARGUS_DEMO_NETWORK  — testnet (default) or mainnet
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { SuiClient, getFullnodeUrl } from "@mysten/sui/client";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { fromB64 } from "@mysten/sui/utils";
import { SuiPaymentClient } from "../src/sui/sui-payment-client.ts";
import { LocalWalrusTrace } from "../src/sui/walrus-trace.ts";

const NETWORK = (process.env.ARGUS_DEMO_NETWORK ?? "testnet") as "testnet" | "mainnet";
const QUESTION = process.env.ARGUS_DEMO_QUESTION ?? "What is BTC's 24h volume across DEXes?";
const MALICIOUS = process.argv.includes("--malicious");

const SOURCES = [
  {
    name: "bloomfilter.xyz",
    url: "https://bloomfilter.xyz/btc/volume",
    response: { source: "bloomfilter", btc_24h_volume: 38_400_000_000 },
    priceMicroUsd: 5000n, // $0.005
    payee: "0x000000000000000000000000000000000000000000000000000000000000A11C",
  },
  {
    name: "blockrun.ai",
    url: "https://blockrun.ai/api/btc",
    response: { source: "blockrun", volume_24h: 39_100_000_000, ts: "2026-05-10" },
    priceMicroUsd: 10_000n, // $0.010
    payee: "0x000000000000000000000000000000000000000000000000000000000000B22D",
  },
  {
    name: "snack.money",
    url: "https://snack.money/api/btc",
    response: { source: "snack", btcVolUsd24: 38_900_000_000 },
    priceMicroUsd: 20_000n, // $0.020
    payee: "0x000000000000000000000000000000000000000000000000000000000000C33E",
  },
];

function loadDeployerKey(): Ed25519Keypair {
  const path = `${homedir()}/.sui/sui_config/sui.keystore`;
  const raw = JSON.parse(readFileSync(path, "utf8")) as string[];
  const all = fromB64(raw[0]);
  return Ed25519Keypair.fromSecretKey(all.slice(1, 33));
}

function loadDeployment() {
  const path = `move/quikt_sui/deployments/${NETWORK}.json`;
  return JSON.parse(readFileSync(path, "utf8")) as {
    packageId: string;
    objects: { quiktConfig: { id: string } };
  };
}

function explorer(kind: "tx" | "object", id: string): string {
  const root = NETWORK === "testnet"
    ? "https://suiscan.xyz/testnet"
    : "https://suiscan.xyz/mainnet";
  return `${root}/${kind}/${id}`;
}

function pause(label: string) {
  console.log("");
  console.log(`──────── ${label} ────────`);
}

async function main(): Promise<void> {
  console.log("ARGUS — multi-source research bundle on Sui");
  console.log(`network: ${NETWORK}`);
  console.log(`question: "${QUESTION}"`);
  if (MALICIOUS) {
    console.log("mode:    MALICIOUS — source 3 over-bills, expect atomic abort");
  }
  console.log("");

  // In malicious mode, source 3 bills 100x — pushing the bundle over budget.
  // The PTB aborts on the third pay_and_record call; sources 1+2 also revert.
  const sources = MALICIOUS
    ? SOURCES.map((s, i) => i === 2 ? { ...s, priceMicroUsd: s.priceMicroUsd * 100n } : s)
    : SOURCES;

  const deployment = loadDeployment();
  const signer = loadDeployerKey();
  const sender = signer.toSuiAddress();
  console.log(`signer:   ${sender}`);
  console.log(`package:  ${deployment.packageId}`);
  console.log(`config:   ${deployment.objects.quiktConfig.id}`);

  const client = new SuiClient({ url: getFullnodeUrl(NETWORK) });
  const sui = new SuiPaymentClient({
    client,
    signer,
    deployment: {
      packageId: deployment.packageId,
      argusConfigId: deployment.objects.quiktConfig.id,
      network: NETWORK,
    },
    coinType: "0x2::sui::SUI",
    networks: [`sui:${NETWORK}`],
  });
  const walrus = new LocalWalrusTrace();

  // ─── Off-chain step: collect responses + Walrus uploads ───
  pause("step 1: off-chain — fetch + Walrus upload per source");
  const steps = [];
  let nonce = 1n;
  for (const s of sources) {
    const payload = new TextEncoder().encode(JSON.stringify(s.response));
    const trace = await walrus.upload(payload);
    // Convert micro-USD to MIST. For demo, treat $0.001 = 1 MIST.
    const amountMist = s.priceMicroUsd / 1n; // 1 MIST per microUSD
    steps.push({
      amount: amountMist,
      payee: s.payee,
      blobHash: trace.hash,
      nonce,
    });
    console.log(`  ${s.name.padEnd(20)} → blob ${trace.blobId}  hash=${Buffer.from(trace.hash).toString("hex").slice(0, 16)}…  ${amountMist} MIST`);
    nonce += 1n;
  }

  // ─── On-chain step 1: mint session ───
  pause("step 2: on-chain — mint ResearchSession (one PTB)");
  const questionTrace = await walrus.upload(new TextEncoder().encode(QUESTION));
  const totalAmount = steps.reduce((acc, s) => acc + s.amount, 0n);
  // Honest budget: covers honest prices with 2x headroom. Malicious
  // mode hits this cap because source 3 inflates 100x.
  const honestTotal = SOURCES.reduce((acc, s) => acc + s.priceMicroUsd, 0n);
  const minted = await sui.mintSession({
    questionBlobId: questionTrace.blobId,
    budget: { splitFromGas: honestTotal * 2n },
    minSources: SOURCES.length,
  });
  console.log(`  session: ${minted.sessionId}`);
  console.log(`  digest:  ${minted.digest}`);
  console.log(`  → ${explorer("tx", minted.digest)}`);

  // ─── On-chain step 2: bundle ───
  pause("step 3: on-chain — atomic multi-source bundle (ONE PTB)");
  let bundleDigest: string | null = null;
  try {
    const bundle = await sui.buildBundle({
      sessionId: minted.sessionId,
      steps,
    });
    const receiptCount = (bundle.events as Array<{ type?: string }>).filter((e) =>
      typeof e.type === "string" && e.type.endsWith("::ReceiptRecorded"),
    ).length;
    console.log(`  digest:  ${bundle.digest}`);
    console.log(`  events:  ${receiptCount} ReceiptRecorded (one per source) from ONE tx`);
    console.log(`  → ${explorer("tx", bundle.digest)}`);
    bundleDigest = bundle.digest;
  } catch (err) {
    if (!MALICIOUS) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  ABORTED — PTB reverted atomically.`);
    console.log(`  reason:  ${msg.split("\n")[0].slice(0, 240)}`);
    console.log(``);
    console.log(`  no payments settled. no blob hashes recorded.`);
    console.log(`  the malicious source over-billed; sources 1+2 also reverted.`);
    console.log(`  this is the property s402/a402/Beep don't ship: bundle-level`);
    console.log(`  atomicity. partial-fill is impossible by construction.`);
    pause("done (malicious mode)");
    console.log(`session object: ${explorer("object", minted.sessionId)} (still empty — locked-out)`);
    return;
  }

  // ─── On-chain step 3: lock ───
  pause("step 4: on-chain — lock session (owner finalisation)");
  const synthBlob = await walrus.upload(
    new TextEncoder().encode(`Consensus answer: BTC 24h volume ≈ $38.8B (3 sources, σ=$0.3B)`),
  );
  const locked = await sui.lockSession({
    sessionId: minted.sessionId,
    responseBlobId: synthBlob.blobId,
  });
  console.log(`  digest:  ${locked.digest}`);
  console.log(`  → ${explorer("tx", locked.digest)}`);

  pause("done");
  console.log(`session object: ${explorer("object", minted.sessionId)}`);
  console.log(`anyone can verify: ${SOURCES.length} payments + ${SOURCES.length} blob hashes,`);
  console.log(`bound atomically in one Sui PTB — no partial-fill possible.`);
  if (bundleDigest) {
    console.log(`bundle tx:      ${explorer("tx", bundleDigest)}`);
  }
}

main().catch((e) => {
  console.error("demo-bundle: fatal:", e);
  process.exit(1);
});
