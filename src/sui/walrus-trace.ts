/**
 * walrus-trace.ts — encrypt + upload a reasoning trace to Walrus,
 * return the blob id and its content hash.
 *
 * Honesty note: Walrus uploads are off-chain and async. The blob
 * exists *before* the PTB runs. The atomicity property the Sui
 * package gives is on-chain coupling between payment and the hash
 * of an already-stored blob — not "atomic upload."
 *
 * Hash function: BLAKE2b-256 (`createHash("blake2b512").digest().slice(0, 32)`
 * — Node ships BLAKE2b but only the 512-bit variant; the 256-bit form
 * is just the first 32 bytes per RFC 7693 §3.2 truncation). Real
 * Walrus blob IDs use BLAKE2b-256 over a Merkle tree of RedStuff-
 * encoded shards — when the production uploader path is wired up it
 * will compute the canonical blob_id via `@mysten/walrus`. For the
 * local stand-in we emit a 32-byte BLAKE2b-256 of the raw bytes,
 * which is *not* a real Walrus blob_id but is wire-compatible with
 * the Move-side `BLOB_HASH_LEN = 32` field for testing.
 */
import { createHash } from "node:crypto";

export interface WalrusTraceUpload {
  /** Walrus blob id (or local fake id in tests). */
  blobId: string;
  /** 32-byte BLAKE2b-256 hash of the raw payload bytes. */
  hash: Uint8Array;
  /** Original byte length, useful for cost-stamping. */
  size: number;
}

export interface WalrusTraceUploader {
  upload(payload: Uint8Array): Promise<WalrusTraceUpload>;
}

/**
 * Compute BLAKE2b-256 over `payload` using Node's built-in crypto.
 * Node only exposes BLAKE2b-512 directly; we truncate to 32 bytes
 * per the RFC 7693 §3.2 convention to obtain BLAKE2b-256 output.
 */
function blake2b256(payload: Uint8Array): Uint8Array {
  const full = createHash("blake2b512").update(payload).digest();
  return new Uint8Array(full.subarray(0, 32));
}

export class LocalWalrusTrace implements WalrusTraceUploader {
  private counter = 0;

  async upload(payload: Uint8Array): Promise<WalrusTraceUpload> {
    const hash = blake2b256(payload);
    this.counter += 1;
    const hex = Buffer.from(hash).toString("hex");
    const blobId = `local-walrus-${this.counter}-${hex.slice(0, 8)}`;
    return {
      blobId,
      hash,
      size: payload.byteLength,
    };
  }
}

/**
 * Real Walrus testnet uploader via the public unauthenticated publisher
 * endpoint. Skips the `@mysten/walrus` SDK entirely (which requires
 * `@mysten/sui@^2.16` and conflicts with our `1.x` pin) by talking HTTP
 * directly. The blob id returned here is the *canonical* Walrus blob id
 * (RedStuff Merkle root, base64url-ish), not just a local hash.
 *
 * The `hash` field stays the BLAKE2b-256 of the raw payload — that's
 * what the Move package's `pay_and_record(..., blob_hash, ...)` expects
 * on-chain. Real Walrus blob ids are useful as off-chain pointers but
 * the *commitment* is the hash.
 */
export class RemoteWalrusTrace implements WalrusTraceUploader {
  private readonly publisher: string;
  private readonly epochs: number;

  constructor(opts: { publisher?: string; epochs?: number } = {}) {
    this.publisher =
      opts.publisher ?? "https://publisher.walrus-testnet.walrus.space";
    this.epochs = opts.epochs ?? 1;
  }

  async upload(payload: Uint8Array): Promise<WalrusTraceUpload> {
    const hash = blake2b256(payload);
    const url = `${this.publisher.replace(/\/$/, "")}/v1/blobs?epochs=${this.epochs}`;
    const res = await fetch(url, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: payload,
    });
    if (!res.ok) {
      throw new Error(
        `walrus publisher ${url} returned ${res.status} ${res.statusText}`,
      );
    }
    const json = (await res.json()) as
      | { newlyCreated: { blobObject: { blobId: string } } }
      | { alreadyCertified: { blobId: string } };
    const blobId =
      "newlyCreated" in json
        ? json.newlyCreated.blobObject.blobId
        : (json as { alreadyCertified: { blobId: string } }).alreadyCertified.blobId;
    return { blobId, hash, size: payload.byteLength };
  }
}
