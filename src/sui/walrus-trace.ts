/**
 * walrus-trace.ts — encrypt + upload an Argus reasoning trace to
 * Walrus, return the blob id and its content hash.
 *
 * Honesty note (red-team caught this earlier): Walrus uploads are
 * off-chain and async. The blob exists *before* the PTB runs. What
 * Argus's atomicity gives is on-chain coupling between payment and
 * the hash of an already-stored blob — not "atomic upload."
 *
 * For the e2e harness we ship a `LocalWalrusTrace` that hashes the
 * payload locally and synthesises a deterministic blob id. The
 * production Walrus path lives behind the same interface and gets
 * wired up before mainnet deploy.
 */
import { createHash } from "node:crypto";

export interface WalrusTraceUpload {
  /** Walrus blob id (or local fake id in tests). */
  blobId: string;
  /** 32-byte BLAKE2b-256 (or SHA-256 in the local fallback) hash of bytes. */
  hash: Uint8Array;
  /** Original byte length, useful for cost-stamping. */
  size: number;
}

export interface WalrusTraceUploader {
  upload(payload: Uint8Array): Promise<WalrusTraceUpload>;
}

/**
 * In-process Walrus stand-in. SHA-256 is used here because Node's
 * built-in `crypto` ships it; production swaps to BLAKE2b-256 to
 * match the Move-side `BLOB_HASH_LEN = 32`. Both produce 32-byte
 * digests, so the hash field is wire-compatible.
 */
export class LocalWalrusTrace implements WalrusTraceUploader {
  private counter = 0;

  async upload(payload: Uint8Array): Promise<WalrusTraceUpload> {
    const hash = createHash("sha256").update(payload).digest();
    this.counter += 1;
    const blobId = `local-walrus-${this.counter}-${hash.subarray(0, 4).toString("hex")}`;
    return {
      blobId,
      hash: new Uint8Array(hash),
      size: payload.byteLength,
    };
  }
}
