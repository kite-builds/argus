/// research_session — Argus's auditable research-receipt primitive.
///
/// What this is:
///   `ResearchSession<T>` is a shared on-chain object that records a
///   user's research question, the per-source payments the agent made,
///   and a commitment hash for each source's response blob already
///   stored in Walrus. The PTB binds payment, receipt registration,
///   and Walrus blob commitment into a single atomic step per source;
///   any number of these can be chained inside one PTB to settle a
///   whole multi-source workflow with no partial-fill.
///
/// What this is NOT:
///   • Not a proof of source authenticity. Today's x402 endpoints do
///     not sign their response bodies, so the on-chain hash proves
///     only that the *agent* saw a specific blob — not that the
///     endpoint produced it. The receipt is an audit/replay/dispute
///     log, not source attestation.
///   • Not a Walrus uploader. The blob is already stored before the
///     PTB runs; this module commits its hash on-chain alongside
///     payment so storage and settlement reference the same bytes.
///
/// Why it composes well in a PTB:
///   `pay_and_record` is `public` (callable from any PTB), takes one
///   source at a time, and uses a phantom-typed nonce-keyed dynamic-
///   field receipt registry for replay protection — the exact pattern
///   Mysten's own sui-payment-kit ships. A research bundle is the
///   agent SDK chaining N `pay_and_record` calls into one PTB; if any
///   of them aborts (budget exceeded, replayed nonce, version
///   mismatch), the whole bundle reverts.
module argus_sui::research_session;

use std::string::String;
use sui::balance::{Self, Balance};
use sui::coin::{Self, Coin};
use sui::dynamic_field as df;
use sui::event;
use argus_sui::argus::{Self, ArgusConfig};

// Note: Move 2024 auto-generates `session.fn_name()` receiver syntax for
// every public function whose first parameter is `&ResearchSession<T>` or
// `&mut ResearchSession<T>`. No explicit `use fun` block needed.

// ─────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────

const ENotOwner: u64 = 0;
const EAlreadyLocked: u64 = 1;
const EBudgetExceeded: u64 = 2;
const EZeroBudget: u64 = 3;
const ENotInAllowlist: u64 = 4;
const ENotLocked: u64 = 5;
const EReceiptAlreadyExists: u64 = 6;
const EHashWrongLength: u64 = 7;
const EZeroPayment: u64 = 8;
const ESealKeyMismatch: u64 = 9;
const EMinSourcesNotMet: u64 = 10;
const ENotAuthorizedAgent: u64 = 11;
const EZeroPayee: u64 = 12;
const ETooManyReceipts: u64 = 13;
const EAllowlistFull: u64 = 14;
const EBlobIdTooLong: u64 = 15;

// ─────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────

/// Walrus blob hashes are 32-byte BLAKE2b-256 digests.
const BLOB_HASH_LEN: u64 = 32;
/// DoS bounds — refuse sessions that would grow unboundedly.
const MAX_RECEIPTS: u64 = 256;
const MAX_ALLOWLIST: u64 = 64;
/// Walrus blob ids are typically <100 chars; cap to bound on-chain footprint.
const MAX_BLOB_ID_LEN: u64 = 256;

// ─────────────────────────────────────────────────────────────────────
// Objects
// ─────────────────────────────────────────────────────────────────────

/// One research question, parameterised by stablecoin type T (USDC on
/// mainnet; tests use any compatible Coin variant). `T` is a phantom
/// witness so the same object family supports USDC / USDT / native SUI
/// without duplicating code.
public struct ResearchSession<phantom T> has key {
    id: UID,
    /// Owner — the asker. Only this address can lock or withdraw.
    owner: address,
    /// Walrus blob id holding the encrypted question + agent reasoning
    /// preamble. Set at mint time.
    question_blob_id: String,
    /// Walrus blob id holding the final synthesised answer. Empty
    /// until `lock_session` is called.
    response_blob_id: String,
    /// True after `lock_session`. Locked sessions are read-only.
    locked: bool,
    /// Hard cap on T-units the agent may spend across all paid calls.
    budget_cap: u64,
    /// Running total of T-units already paid out.
    total_paid: u64,
    /// Minimum number of distinct paid sources required before a session
    /// can be locked. Lets the asker reject thin single-source answers.
    min_sources: u64,
    /// Endpoints that received a payment in this session, in payment
    /// order. Same address may appear multiple times if hit twice.
    payees: vector<address>,
    /// 32-byte Walrus blob hashes for each paid response, parallel to
    /// `payees`. Hash commits to the blob the agent observed; does
    /// NOT prove the endpoint produced that blob.
    response_hashes: vector<vector<u8>>,
    /// Addresses (in addition to owner) authorised to decrypt the
    /// session via Seal. Owner-managed.
    allowlist: vector<address>,
    /// Pre-funded budget pool. Agent draws from this; remainder can be
    /// reclaimed by the owner once the session is locked.
    balance: Balance<T>,
    /// Optional MemWal account id for cross-session memory recall.
    mem_account_id: vector<u8>,
    /// Optional address authorised to call `pay_and_record`. If `Some`,
    /// only that address can settle calls; if `None`, any caller can
    /// (gated only by the budget pool). Owner can rotate via
    /// `set_authorized_agent`.
    authorized_agent: Option<address>,
    /// Number of *distinct* payees who received any payment, used to
    /// satisfy `min_sources` against duplicate-payee bypass attacks.
    unique_payees: u64,
}

/// Dynamic-field key recording that a (payee, nonce) pair has settled.
/// Phantom-typed by the coin so a USDC nonce can't collide with a USDT
/// nonce. Mirrors Mysten's own `sui-payment-kit::PaymentKey<phantom T>`.
public struct ReceiptKey<phantom T> has copy, drop, store {
    payee: address,
    nonce: u64,
}

/// Stored payload at each receipt key — small audit footprint per
/// settled call. The blob hash is duplicated here for direct lookup
/// (avoids walking the parallel vectors).
public struct Receipt has copy, drop, store {
    amount: u64,
    blob_hash: vector<u8>,
    /// Tx index inside the session — matches position in `payees`.
    sequence: u64,
}

// ─────────────────────────────────────────────────────────────────────
// Events
// ─────────────────────────────────────────────────────────────────────

/// Emitted when a new research session opens.
public struct SessionOpened has copy, drop {
    session_id: ID,
    owner: address,
    question_blob_id: String,
    budget_cap: u64,
    min_sources: u64,
}

/// Emitted on each (payment + blob commitment) inside a PTB.
/// `sequence` is the index inside the session, useful for
///      reconstructing replay order from indexer streams.
public struct ReceiptRecorded has copy, drop {
    session_id: ID,
    payee: address,
    amount: u64,
    blob_hash: vector<u8>,
    nonce: u64,
    sequence: u64,
    total_paid: u64,
}

/// Emitted when the session is finalised by the owner.
public struct SessionLocked has copy, drop {
    session_id: ID,
    response_blob_id: String,
    total_paid: u64,
    num_sources: u64,
}

/// Emitted when an extra reader is added to the Seal allowlist.
public struct AllowlistGranted has copy, drop {
    session_id: ID,
    viewer: address,
}

// ─────────────────────────────────────────────────────────────────────
// Mint
// ─────────────────────────────────────────────────────────────────────

/// Open a research session pre-funded with a hard budget cap.
/// Session is shared so PTBs from the agent SDK can refer to it
///      by id. `min_sources = 0` disables the multi-source floor.
public fun open_session<T>(
    config: &ArgusConfig,
    question_blob_id: String,
    budget: Coin<T>,
    min_sources: u64,
    mem_account_id: vector<u8>,
    authorized_agent: Option<address>,
    ctx: &mut TxContext,
) {
    argus::assert_current_version(config);
    let budget_cap = coin::value(&budget);
    assert!(budget_cap > 0, EZeroBudget);
    assert!(question_blob_id.length() <= MAX_BLOB_ID_LEN, EBlobIdTooLong);

    let session = ResearchSession<T> {
        id: object::new(ctx),
        owner: ctx.sender(),
        question_blob_id,
        response_blob_id: b"".to_string(),
        locked: false,
        budget_cap,
        total_paid: 0,
        min_sources,
        payees: vector[],
        response_hashes: vector[],
        allowlist: vector[],
        balance: coin::into_balance(budget),
        mem_account_id,
        authorized_agent,
        unique_payees: 0,
    };

    event::emit(SessionOpened {
        session_id: object::id(&session),
        owner: session.owner,
        question_blob_id: session.question_blob_id,
        budget_cap,
        min_sources,
    });

    transfer::share_object(session);
}

// ─────────────────────────────────────────────────────────────────────
// The atomicity primitive
// ─────────────────────────────────────────────────────────────────────

/// Pay an endpoint AND commit its response-blob hash atomically.
/// The blob is already stored in Walrus before this is called.
///      What this function adds is on-chain coupling: payment, receipt
///      registration in the dynamic-field registry, and the hash
///      commitment all happen in one Move call. PTBs chain N of these
///      to atomically settle a multi-source bundle — any abort reverts
///      the whole bundle.
///
///      The `nonce` is unique per (payee, session) and prevents replay:
///      attempting to call this twice with the same (payee, nonce)
///      aborts with `EReceiptAlreadyExists`.
///
///      Anyone can call this (the agent caller, in practice). The
///      budget pool is the gate, not the sender. Owner-only operations
///      are `lock_session`, `add_to_allowlist`, `withdraw_balance`.
public fun pay_and_record<T>(
    config: &ArgusConfig,
    session: &mut ResearchSession<T>,
    amount: u64,
    payee: address,
    blob_hash: vector<u8>,
    nonce: u64,
    ctx: &mut TxContext,
) {
    argus::assert_current_version(config);
    assert!(!session.locked, EAlreadyLocked);
    assert!(amount > 0, EZeroPayment);
    assert!(payee != @0x0, EZeroPayee);
    assert!(vector::length(&blob_hash) == BLOB_HASH_LEN, EHashWrongLength);
    assert!(session.total_paid + amount <= session.budget_cap, EBudgetExceeded);
    assert!(vector::length(&session.payees) < MAX_RECEIPTS, ETooManyReceipts);

    // Auth: if `authorized_agent` is `Some`, gate by sender; if `None`,
    // anyone can settle (still gated by budget pool).
    if (option::is_some(&session.authorized_agent)) {
        let allowed = *option::borrow(&session.authorized_agent);
        assert!(ctx.sender() == allowed, ENotAuthorizedAgent);
    };

    let key = ReceiptKey<T> { payee, nonce };
    assert!(!df::exists(&session.id, key), EReceiptAlreadyExists);

    let payment_balance = balance::split(&mut session.balance, amount);
    let payment_coin = coin::from_balance(payment_balance, ctx);
    transfer::public_transfer(payment_coin, payee);

    let sequence = vector::length(&session.payees);
    let is_new_payee = !vector::contains(&session.payees, &payee);
    session.total_paid = session.total_paid + amount;
    vector::push_back(&mut session.payees, payee);
    vector::push_back(&mut session.response_hashes, blob_hash);
    if (is_new_payee) {
        session.unique_payees = session.unique_payees + 1;
    };

    df::add(&mut session.id, key, Receipt {
        amount,
        blob_hash,
        sequence,
    });

    event::emit(ReceiptRecorded {
        session_id: object::id(session),
        payee,
        amount,
        blob_hash,
        nonce,
        sequence,
        total_paid: session.total_paid,
    });
}

/// Owner-only: rotate the authorised agent (e.g., after a key compromise).
/// Pass `option::none()` to disable agent gating entirely.
public fun set_authorized_agent<T>(
    session: &mut ResearchSession<T>,
    new_agent: Option<address>,
    ctx: &TxContext,
) {
    assert!(ctx.sender() == session.owner, ENotOwner);
    session.authorized_agent = new_agent;
}

// ─────────────────────────────────────────────────────────────────────
// Lock — owner finalises the session
// ─────────────────────────────────────────────────────────────────────

/// Owner-only: write the final synthesised answer blob and
///         emit the locked event. After this, no more receipts can be
///         recorded.
/// Enforces `min_sources` so a thin single-source answer can be
///      rejected by the asker's policy.
public fun lock_session<T>(
    config: &ArgusConfig,
    session: &mut ResearchSession<T>,
    response_blob_id: String,
    ctx: &TxContext,
) {
    argus::assert_current_version(config);
    assert!(ctx.sender() == session.owner, ENotOwner);
    assert!(!session.locked, EAlreadyLocked);
    assert!(response_blob_id.length() <= MAX_BLOB_ID_LEN, EBlobIdTooLong);
    // Use unique_payees, not payees.length, to defeat duplicate-payee bypass.
    assert!(session.unique_payees >= session.min_sources, EMinSourcesNotMet);

    session.response_blob_id = response_blob_id;
    session.locked = true;

    event::emit(SessionLocked {
        session_id: object::id(session),
        response_blob_id,
        total_paid: session.total_paid,
        num_sources: session.unique_payees,
    });
}

// ─────────────────────────────────────────────────────────────────────
// Allowlist
// ─────────────────────────────────────────────────────────────────────

/// Owner-only: extend Seal decryption rights to another address.
public fun add_to_allowlist<T>(
    session: &mut ResearchSession<T>,
    viewer: address,
    ctx: &TxContext,
) {
    assert!(ctx.sender() == session.owner, ENotOwner);
    if (!vector::contains(&session.allowlist, &viewer)) {
        assert!(vector::length(&session.allowlist) < MAX_ALLOWLIST, EAllowlistFull);
        vector::push_back(&mut session.allowlist, viewer);
        event::emit(AllowlistGranted { session_id: object::id(session), viewer });
    }
}

// ─────────────────────────────────────────────────────────────────────
// Withdraw remaining budget
// ─────────────────────────────────────────────────────────────────────

/// Owner-only: reclaim any unspent budget after the session is
///         locked.
/// Locking is required so the budget can't be withdrawn out from
///      under an in-flight payment.
public fun withdraw_balance<T>(
    session: &mut ResearchSession<T>,
    ctx: &mut TxContext,
): Coin<T> {
    assert!(ctx.sender() == session.owner, ENotOwner);
    assert!(session.locked, ENotLocked);

    let leftover = balance::value(&session.balance);
    let leftover_balance = balance::split(&mut session.balance, leftover);
    coin::from_balance(leftover_balance, ctx)
}

// ─────────────────────────────────────────────────────────────────────
// Seal gate
// ─────────────────────────────────────────────────────────────────────

/// Seal-protocol decryption gate. Seal calls this with the
///         BCS-encoded session id as `id` and the would-be reader as
///         `ctx.sender()`. Approved iff sender is owner or on the
///         allowlist. Aborts → Seal denies decryption.
entry fun seal_approve<T>(
    id: vector<u8>,
    session: &ResearchSession<T>,
    ctx: &TxContext,
) {
    let session_id_bytes = object::id_to_bytes(&object::id(session));
    assert!(id == session_id_bytes, ESealKeyMismatch);
    let sender = ctx.sender();
    let approved = sender == session.owner ||
        vector::contains(&session.allowlist, &sender);
    assert!(approved, ENotInAllowlist);
}

// ─────────────────────────────────────────────────────────────────────
// Read helpers
// ─────────────────────────────────────────────────────────────────────

public fun owner<T>(s: &ResearchSession<T>): address { s.owner }
public fun authorized_agent<T>(s: &ResearchSession<T>): &Option<address> { &s.authorized_agent }
public fun unique_payees<T>(s: &ResearchSession<T>): u64 { s.unique_payees }
public fun locked<T>(s: &ResearchSession<T>): bool { s.locked }
public fun budget_cap<T>(s: &ResearchSession<T>): u64 { s.budget_cap }
public fun total_paid<T>(s: &ResearchSession<T>): u64 { s.total_paid }
public fun min_sources<T>(s: &ResearchSession<T>): u64 { s.min_sources }
public fun balance_value<T>(s: &ResearchSession<T>): u64 { balance::value(&s.balance) }
public fun payees<T>(s: &ResearchSession<T>): &vector<address> { &s.payees }
public fun response_hashes<T>(s: &ResearchSession<T>): &vector<vector<u8>> {
    &s.response_hashes
}
public fun response_blob_id<T>(s: &ResearchSession<T>): String { s.response_blob_id }
public fun question_blob_id<T>(s: &ResearchSession<T>): String { s.question_blob_id }
public fun allowlist<T>(s: &ResearchSession<T>): &vector<address> { &s.allowlist }

/// Look up a stored receipt by (payee, nonce). Returns the
///         tuple form for SDK ergonomics.
public fun receipt<T>(
    session: &ResearchSession<T>,
    payee: address,
    nonce: u64,
): (u64, vector<u8>, u64) {
    let key = ReceiptKey<T> { payee, nonce };
    let v: &Receipt = df::borrow(&session.id, key);
    (v.amount, v.blob_hash, v.sequence)
}

public fun receipt_exists<T>(
    session: &ResearchSession<T>,
    payee: address,
    nonce: u64,
): bool {
    df::exists(&session.id, ReceiptKey<T> { payee, nonce })
}

// ─────────────────────────────────────────────────────────────────────
// Test-only mirrors (entry functions can't be called from #[test])
// ─────────────────────────────────────────────────────────────────────

#[test_only]
public fun seal_approve_for_testing<T>(
    id: vector<u8>,
    session: &ResearchSession<T>,
    ctx: &TxContext,
) {
    let session_id_bytes = object::id_to_bytes(&object::id(session));
    assert!(id == session_id_bytes, ESealKeyMismatch);
    let sender = ctx.sender();
    let approved = sender == session.owner ||
        vector::contains(&session.allowlist, &sender);
    assert!(approved, ENotInAllowlist);
}
