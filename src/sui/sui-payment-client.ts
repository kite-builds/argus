/**
 * sui-payment-client.ts — Sui implementation of `X402PaymentClient`.
 *
 * The Base/x402 implementation produces an `X-PAYMENT` HTTP header
 * that the resource server's facilitator verifies + settles in two
 * steps. The Sui rail collapses payment + receipt into a single PTB,
 * so this client exposes two flavours:
 *
 *   1. `buildPaymentHeader` — single-call legacy path. Constructs a
 *      one-step PTB that transfers `Coin<T>` to the payee, signs it,
 *      submits, and returns the digest as the header value.
 *      Compatible with the existing `paidFetch` orchestrator.
 *
 *   2. `buildBundle` — the differentiated path. Composes N
 *      `pay_and_record` calls into one atomic PTB against a live
 *      `ResearchSession<T>` and returns the digest. This is what
 *      `bundleAsk()` uses for the multi-source story.
 *
 * The receipt-side write (`pay_and_record`) lives in `onchain.ts`;
 * this module is only responsible for the signing + settlement
 * surface that the rest of Argus calls into.
 */
import { SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";
import type { Signer } from "@mysten/sui/cryptography";
import type {
  X402PaymentClient,
  X402PaymentRequirement,
} from "../payment.ts";
import { ArgusOnchain, type ArgusDeployment, type BundleStep } from "./onchain.ts";

export interface SuiPaymentClientOptions {
  client: SuiClient;
  signer: Signer;
  deployment: ArgusDeployment;
  /** Fully qualified coin type to settle in (e.g. `0x2::sui::SUI`). */
  coinType: string;
  /**
   * Network labels this client is willing to settle on, e.g.
   * `["sui:testnet", "sui:mainnet"]`. Argus's payment.ts filters
   * x402 challenges through this list.
   */
  networks: readonly string[];
}

export class SuiPaymentClient implements X402PaymentClient {
  readonly onchain: ArgusOnchain;
  private readonly client: SuiClient;
  private readonly signer: Signer;
  private readonly networks: readonly string[];

  constructor(opts: SuiPaymentClientOptions) {
    this.client = opts.client;
    this.signer = opts.signer;
    this.networks = opts.networks;
    this.onchain = new ArgusOnchain(opts.client, opts.deployment, opts.coinType);
  }

  supportedNetworks(): readonly string[] {
    return this.networks;
  }

  /**
   * Single-call legacy header path. Sends `Coin<T>` of the requested
   * value to the payee in a one-step PTB, returns the digest in a
   * header-friendly form. The amount is pulled from the active
   * gas-coin context — callers must ensure the signer's wallet has
   * sufficient T.
   *
   * NOTE: This path does NOT use Argus's atomicity primitive. It's
   * here so the existing `paidFetch` flow keeps working when callers
   * choose `--network sui` without opting into bundles. Use
   * `bundleAsk` for the differentiated path.
   */
  async buildPaymentHeader(req: X402PaymentRequirement): Promise<string> {
    const amount = priceToUnits(req.price);
    const tx = new Transaction();
    const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(amount)]);
    tx.transferObjects([coin], tx.pure.address(req.payTo));

    const result = await this.client.signAndExecuteTransaction({
      transaction: tx,
      signer: this.signer,
      options: { showEffects: true },
    });
    return `sui:${this.coinTypeShort()}:${amount}:${req.payTo}:${result.digest}`;
  }

  /**
   * The differentiated path. Builds + signs + submits a single PTB
   * that chains N `pay_and_record` calls against an existing
   * `ResearchSession<T>`. Returns the digest and the events the Move
   * package emitted (`ReceiptRecorded` per step).
   */
  async buildBundle(args: {
    sessionId: string;
    steps: BundleStep[];
  }): Promise<{ digest: string; events: unknown[] }> {
    const tx = this.onchain.buildBundlePtb(args);
    const r = await this.onchain.signAndExecute(tx, this.signer);
    return { digest: r.digest, events: r.events };
  }

  /**
   * Mint a fresh ResearchSession funded with a `Coin<T>` already in
   * the signer's wallet. Returns the new session id (looked up from
   * the tx's object changes).
   */
  async mintSession(args: {
    questionBlobId: string;
    budget: { coinId: string } | { splitFromGas: bigint };
    minSources: number;
    memAccountId?: Uint8Array;
  }): Promise<{ sessionId: string; digest: string }> {
    const tx = this.onchain.buildMintSession(args);
    const r = await this.onchain.signAndExecute(tx, this.signer);
    const sessionType = `${this.onchain.deployment.packageId}::research_session::ResearchSession<${this.onchain.coinType}>`;
    const created = (r.objectChanges as Array<{ type?: string; objectType?: string; objectId?: string }>)
      .find((c) => c.type === "created" && c.objectType === sessionType);
    if (!created?.objectId) {
      throw new Error(`mintSession: no ResearchSession found in tx ${r.digest}`);
    }
    return { sessionId: created.objectId, digest: r.digest };
  }

  /** Owner-only lock. */
  async lockSession(args: {
    sessionId: string;
    responseBlobId: string;
  }): Promise<{ digest: string }> {
    const tx = this.onchain.buildLockSession(args);
    const r = await this.onchain.signAndExecute(tx, this.signer);
    return { digest: r.digest };
  }

  private coinTypeShort(): string {
    return this.onchain.coinType.split("::").slice(-1)[0];
  }
}

/**
 * Convert an x402 `price` string ("$0.01", "10 USDC", "0.5 SUI") to
 * unit integers. Defaults to USDC's 6 decimals when the unit is "$"
 * or "USDC" / "USDT"; SUI has 9 decimals; explicit "SUI" units use 9.
 *
 * This is a deliberately small parser — it only handles the formats
 * the existing `cost.ts:parseQuote` produces upstream.
 */
function priceToUnits(price: string): bigint {
  const trimmed = price.trim();
  const dollarMatch = trimmed.match(/^\$\s*([\d.]+)/);
  if (dollarMatch) {
    const usd = Number(dollarMatch[1]);
    return BigInt(Math.round(usd * 1e6));
  }
  const numMatch = trimmed.match(/^([\d.]+)\s*([A-Za-z]+)$/);
  if (numMatch) {
    const value = Number(numMatch[1]);
    const unit = numMatch[2].toUpperCase();
    if (unit === "USDC" || unit === "USDT") return BigInt(Math.round(value * 1e6));
    if (unit === "SUI" || unit === "MIST") {
      return unit === "MIST" ? BigInt(Math.round(value)) : BigInt(Math.round(value * 1e9));
    }
  }
  throw new Error(`SuiPaymentClient: cannot parse price "${price}"`);
}
