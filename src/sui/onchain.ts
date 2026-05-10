/**
 * onchain.ts — typed wrappers around the argus_sui Move package.
 *
 * One method per public Move entry point:
 *   • `mintSession`  → quikt_sui::research_session::mint_session
 *   • `payAndRecord` → quikt_sui::research_session::pay_and_record
 *   • `lockSession`  → quikt_sui::research_session::lock_session
 *
 * The interesting one is `buildBundlePtb`: it composes N pay_and_record
 * calls into a single Programmable Transaction Block so the multi-source
 * research bundle either commits fully or reverts. That is the property
 * that lets Argus claim atomic multi-source settlement.
 */
import { Transaction } from "@mysten/sui/transactions";
import { SuiClient } from "@mysten/sui/client";
import type { Signer } from "@mysten/sui/cryptography";

export interface ArgusDeployment {
  packageId: string;
  argusConfigId: string;
  network: "testnet" | "mainnet" | "devnet" | "local";
}

export interface BundleStep {
  /** T-units the agent owes this endpoint (USDC has 6 decimals; SUI has 9). */
  amount: bigint;
  /** Endpoint's payout address. */
  payee: string;
  /** 32-byte BLAKE2b-256 hash of the response blob already in Walrus. */
  blobHash: Uint8Array;
  /** Per-(payee, session) replay nonce. */
  nonce: bigint;
}

export class ArgusOnchain {
  readonly client: SuiClient;
  readonly deployment: ArgusDeployment;
  readonly coinType: string;

  constructor(client: SuiClient, deployment: ArgusDeployment, coinType: string) {
    this.client = client;
    this.deployment = deployment;
    this.coinType = coinType;
  }

  /**
   * Build (but do not sign/submit) a tx that mints a fresh
   * `ResearchSession<T>` funded by `budgetCoinId`.
   *
   * `budgetCoinId` must be a Coin<T> already in the signer's wallet
   * with the desired budget; the SDK does no splitting itself —
   * callers can `tx.splitCoins` upstream if needed.
   */
  buildMintSession(args: {
    questionBlobId: string;
    /**
     * Either an existing Coin<T> object id, or a u64 amount to split
     * off the gas coin in this same tx. Splitting in-tx avoids the
     * eventual-consistency race between a setup tx that creates the
     * coin and a follow-up tx that consumes it.
     */
    budget: { coinId: string } | { splitFromGas: bigint };
    minSources: number;
    memAccountId?: Uint8Array;
    /** Optional address that's the only one allowed to call pay_and_record. */
    authorizedAgent?: string | null;
  }): Transaction {
    const tx = new Transaction();
    let budgetArg;
    if ("coinId" in args.budget) {
      budgetArg = tx.object(args.budget.coinId);
    } else {
      const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(args.budget.splitFromGas)]);
      budgetArg = coin;
    }
    const agentArg =
      args.authorizedAgent != null
        ? tx.moveCall({
            target: "0x1::option::some",
            typeArguments: ["address"],
            arguments: [tx.pure.address(args.authorizedAgent)],
          })
        : tx.moveCall({
            target: "0x1::option::none",
            typeArguments: ["address"],
          });
    tx.moveCall({
      target: `${this.deployment.packageId}::research_session::open_session`,
      typeArguments: [this.coinType],
      arguments: [
        tx.object(this.deployment.argusConfigId),
        tx.pure.string(args.questionBlobId),
        budgetArg,
        tx.pure.u64(args.minSources),
        tx.pure.vector("u8", Array.from(args.memAccountId ?? new Uint8Array())),
        agentArg,
      ],
    });
    return tx;
  }

  /**
   * Compose a multi-source bundle into a single PTB. Each step
   * becomes one `pay_and_record` Move call; the SDK chains them in
   * the supplied order, and PTB-atomicity guarantees all-or-nothing.
   *
   * Returns the unsigned Transaction so the caller can attach the
   * signer, gas coin, and submission policy.
   */
  buildBundlePtb(args: {
    sessionId: string;
    steps: BundleStep[];
  }): Transaction {
    if (args.steps.length === 0) {
      throw new Error("ArgusOnchain.buildBundlePtb: empty steps");
    }
    const tx = new Transaction();
    for (const step of args.steps) {
      tx.moveCall({
        target: `${this.deployment.packageId}::research_session::pay_and_record`,
        typeArguments: [this.coinType],
        arguments: [
          tx.object(this.deployment.argusConfigId),
          tx.object(args.sessionId),
          tx.pure.u64(step.amount),
          tx.pure.address(step.payee),
          tx.pure.vector("u8", Array.from(step.blobHash)),
          tx.pure.u64(step.nonce),
        ],
      });
    }
    return tx;
  }

  /** Owner-only finalisation. */
  buildLockSession(args: {
    sessionId: string;
    responseBlobId: string;
  }): Transaction {
    const tx = new Transaction();
    tx.moveCall({
      target: `${this.deployment.packageId}::research_session::lock_session`,
      typeArguments: [this.coinType],
      arguments: [
        tx.object(this.deployment.argusConfigId),
        tx.object(args.sessionId),
        tx.pure.string(args.responseBlobId),
      ],
    });
    return tx;
  }

  /**
   * Sign + submit a prepared tx and wait for finality. Returns the
   * digest plus the parsed object/effect summary the caller cares
   * about.
   */
  async signAndExecute(
    tx: Transaction,
    signer: Signer,
  ): Promise<{
    digest: string;
    effects: unknown;
    events: unknown[];
    objectChanges: unknown[];
  }> {
    const result = await this.client.signAndExecuteTransaction({
      transaction: tx,
      signer,
      options: { showEffects: true, showEvents: true, showObjectChanges: true },
    });
    // Wait for the tx to be readable by other RPC nodes before
    // returning. Fullnode reads have eventual consistency vs the
    // executor; without this, follow-up `getTransactionBlock` calls
    // fail with "could not find the referenced transaction".
    await this.client.waitForTransaction({ digest: result.digest });
    return {
      digest: result.digest,
      effects: result.effects,
      events: result.events ?? [],
      objectChanges: result.objectChanges ?? [],
    };
  }

  /**
   * Fetch a freshly-minted session's id from a mint tx digest. Useful
   * because the agent SDK needs to chain `pay_and_record` against a
   * session id that was only known after submission.
   */
  async findSessionIdInTx(digest: string): Promise<string | null> {
    const tx = await this.client.getTransactionBlock({
      digest,
      options: { showObjectChanges: true },
    });
    const sessionType = `${this.deployment.packageId}::research_session::ResearchSession<${this.coinType}>`;
    for (const change of tx.objectChanges ?? []) {
      if (change.type === "created" && change.objectType === sessionType) {
        return change.objectId;
      }
    }
    return null;
  }
}
