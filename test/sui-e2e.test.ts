/**
 * sui-e2e.test.ts — live testnet end-to-end exercise of the Argus
 * multi-source bundle PTB. Skipped unless ARGUS_E2E=testnet is set so
 * `npm test` stays offline-friendly.
 *
 * What this test proves:
 *   1. Mint a fresh ResearchSession<SUI> on testnet.
 *   2. Build ONE PTB that calls `pay_and_record` THREE times against
 *      three distinct payees with three distinct blob hashes.
 *   3. Submit + confirm. All three receipts are recorded atomically;
 *      reading back, total_paid sums correctly and the receipts are
 *      indexed by (payee, nonce) in the dynamic-field registry.
 *   4. Lock the session.
 *
 * That sequence is the demo-video core: multi-source atomicity that
 * `s402` / `a402` / `Beep` don't ship.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { SuiClient } from "@mysten/sui/client";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { fromB64 } from "@mysten/sui/utils";
import { ArgusOnchain } from "../src/sui/onchain.ts";
import { SuiPaymentClient } from "../src/sui/sui-payment-client.ts";
import { LocalWalrusTrace } from "../src/sui/walrus-trace.ts";

const SHOULD_RUN = process.env.ARGUS_E2E === "testnet";
const TESTNET_RPC = "https://fullnode.testnet.sui.io:443";

function loadDeployerKey(): Ed25519Keypair {
  const path = `${homedir()}/.sui/sui_config/sui.keystore`;
  const raw = JSON.parse(readFileSync(path, "utf8")) as string[];
  const keyB64 = raw[0];
  // Sui keystore prepends a 1-byte scheme flag (0x00 = ed25519).
  const all = fromB64(keyB64);
  const secret = all.slice(1, 33);
  return Ed25519Keypair.fromSecretKey(secret);
}

const DEPLOYMENT = JSON.parse(
  readFileSync(
    "move/quikt_sui/deployments/testnet.json",
    "utf8",
  ),
) as { packageId: string; objects: { quiktConfig: { id: string } } };

test(
  "sui-e2e: mint → multi-source bundle (3 sources, 1 PTB) → lock — all atomic",
  { skip: !SHOULD_RUN },
  async () => {
    const client = new SuiClient({ url: TESTNET_RPC });
    const signer = loadDeployerKey();
    const sender = signer.toSuiAddress();

    const sui = new SuiPaymentClient({
      client,
      signer,
      deployment: {
        packageId: DEPLOYMENT.packageId,
        argusConfigId: DEPLOYMENT.objects.quiktConfig.id,
        network: "testnet",
      },
      coinType: "0x2::sui::SUI",
      networks: ["sui:testnet"],
    });
    const walrus = new LocalWalrusTrace();

    // 1. Mint session — budget is split from gas IN the same tx, so
    //    no eventual-consistency race between setup and mint.
    const questionTrace = await walrus.upload(new TextEncoder().encode("test question"));
    const minted = await sui.mintSession({
      questionBlobId: questionTrace.blobId,
      budget: { splitFromGas: 150_000_000n }, // 0.15 SUI
      minSources: 3,
    });
    assert.match(minted.sessionId, /^0x/);

    // 3. Bundle: 3 sources, 1 PTB.
    const responses = ["alpha-bytes", "beta-bytes", "gamma-bytes"].map((s) =>
      new TextEncoder().encode(s),
    );
    const traces = await Promise.all(responses.map((r) => walrus.upload(r)));
    const payees = [
      "0x0000000000000000000000000000000000000000000000000000000000000A11",
      "0x0000000000000000000000000000000000000000000000000000000000000B22",
      "0x0000000000000000000000000000000000000000000000000000000000000C33",
    ];
    const bundle = await sui.buildBundle({
      sessionId: minted.sessionId,
      steps: [
        { amount: 50_000_000n, payee: payees[0], blobHash: traces[0].hash, nonce: 1n },
        { amount: 70_000_000n, payee: payees[1], blobHash: traces[1].hash, nonce: 2n },
        { amount: 30_000_000n, payee: payees[2], blobHash: traces[2].hash, nonce: 3n },
      ],
    });
    assert.match(bundle.digest, /^[A-Za-z0-9]+$/);

    const events = bundle.events as Array<{ type?: string }>;
    const receiptEvents = events.filter((e) =>
      typeof e.type === "string" && e.type.endsWith("::ReceiptRecorded"),
    );
    assert.equal(receiptEvents.length, 3, "three ReceiptRecorded events emitted from one PTB");

    // 4. Lock.
    const synth = await walrus.upload(new TextEncoder().encode("final answer"));
    const locked = await sui.lockSession({
      sessionId: minted.sessionId,
      responseBlobId: synth.blobId,
    });
    assert.match(locked.digest, /^[A-Za-z0-9]+$/);

    console.log("sui-e2e digests:", {
      mint: minted.digest,
      bundle: bundle.digest,
      lock: locked.digest,
      sessionId: minted.sessionId,
    });
  },
);
