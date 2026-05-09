/// Tests for research_session — covers happy path + every error path
/// + the multi-source PTB-atomicity story that is the project's core
/// claim.
#[test_only]
module argus_sui::research_session_tests;

use std::string;
use sui::coin::{Self, Coin};
use sui::sui::SUI;
use sui::test_scenario::{Self as ts, Scenario};
use argus_sui::argus::{Self, ArgusConfig};
use argus_sui::research_session::{Self as rs, ResearchSession};

const ASKER: address = @0xA11CE;
const PAYEE_A: address = @0xBEEFA;
const PAYEE_B: address = @0xBEEFB;
const PAYEE_C: address = @0xBEEFC;
const VIEWER: address = @0xC0DE;
const STRANGER: address = @0xDEAD;

const HASH_A: vector<u8> = b"00000000000000000000000000000000";
const HASH_B: vector<u8> = b"11111111111111111111111111111111";
const HASH_C: vector<u8> = b"22222222222222222222222222222222";
const Q_BLOB: vector<u8> = b"q-blob-id";
const R_BLOB: vector<u8> = b"r-blob-id";

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

fun setup(): Scenario {
    let mut sc = ts::begin(ASKER);
    argus::init_for_testing(sc.ctx());
    sc.next_tx(ASKER);
    sc
}

fun mint_with_budget(sc: &mut Scenario, budget_units: u64, min_sources: u64) {
    let cfg = sc.take_shared<ArgusConfig>();
    let budget = coin::mint_for_testing<SUI>(budget_units, sc.ctx());
    rs::mint_session<SUI>(
        &cfg,
        string::utf8(Q_BLOB),
        budget,
        min_sources,
        b"",
        sc.ctx(),
    );
    ts::return_shared(cfg);
}

// ─────────────────────────────────────────────────────────────────────
// Mint
// ─────────────────────────────────────────────────────────────────────

#[test]
fun mint_session_happy() {
    let mut sc = setup();
    mint_with_budget(&mut sc, 1000, 0);
    sc.next_tx(ASKER);

    let session = sc.take_shared<ResearchSession<SUI>>();
    assert!(rs::owner(&session) == ASKER, 0);
    assert!(rs::budget_cap(&session) == 1000, 1);
    assert!(rs::total_paid(&session) == 0, 2);
    assert!(rs::balance_value(&session) == 1000, 3);
    assert!(!rs::locked(&session), 4);
    assert!(rs::min_sources(&session) == 0, 5);
    ts::return_shared(session);
    ts::end(sc);
}

#[test, expected_failure(abort_code = rs::EZeroBudget)]
fun mint_session_zero_budget_aborts() {
    let mut sc = setup();
    mint_with_budget(&mut sc, 0, 0);
    ts::end(sc);
}

// ─────────────────────────────────────────────────────────────────────
// pay_and_record — happy path single call
// ─────────────────────────────────────────────────────────────────────

#[test]
fun pay_and_record_single_settles_atomically() {
    let mut sc = setup();
    mint_with_budget(&mut sc, 1000, 0);
    sc.next_tx(ASKER);

    let cfg = sc.take_shared<ArgusConfig>();
    let mut session = sc.take_shared<ResearchSession<SUI>>();
    rs::pay_and_record<SUI>(
        &cfg,
        &mut session,
        100,
        PAYEE_A,
        HASH_A,
        1,
        sc.ctx(),
    );
    assert!(rs::total_paid(&session) == 100, 0);
    assert!(rs::balance_value(&session) == 900, 1);
    assert!(*vector::borrow(rs::paid_to(&session), 0) == PAYEE_A, 2);
    assert!(rs::receipt_exists<SUI>(&session, PAYEE_A, 1), 3);

    let (amount, blob_hash, sequence) = rs::receipt<SUI>(&session, PAYEE_A, 1);
    assert!(amount == 100, 4);
    assert!(blob_hash == HASH_A, 5);
    assert!(sequence == 0, 6);

    ts::return_shared(cfg);
    ts::return_shared(session);
    sc.next_tx(PAYEE_A);
    let received = sc.take_from_sender<Coin<SUI>>();
    assert!(coin::value(&received) == 100, 7);
    sc.return_to_sender(received);
    ts::end(sc);
}

// ─────────────────────────────────────────────────────────────────────
// pay_and_record — multi-call PTB-atomicity
// ─────────────────────────────────────────────────────────────────────

#[test]
fun pay_and_record_three_sources_in_one_tx_all_settle() {
    let mut sc = setup();
    mint_with_budget(&mut sc, 1000, 3);
    sc.next_tx(ASKER);

    let cfg = sc.take_shared<ArgusConfig>();
    let mut session = sc.take_shared<ResearchSession<SUI>>();

    rs::pay_and_record<SUI>(&cfg, &mut session, 100, PAYEE_A, HASH_A, 1, sc.ctx());
    rs::pay_and_record<SUI>(&cfg, &mut session, 200, PAYEE_B, HASH_B, 2, sc.ctx());
    rs::pay_and_record<SUI>(&cfg, &mut session, 50, PAYEE_C, HASH_C, 3, sc.ctx());

    assert!(rs::total_paid(&session) == 350, 0);
    assert!(rs::balance_value(&session) == 650, 1);
    assert!(vector::length(rs::paid_to(&session)) == 3, 2);
    assert!(vector::length(rs::response_blob_hashes(&session)) == 3, 3);
    let (_, h1, _) = rs::receipt<SUI>(&session, PAYEE_B, 2);
    assert!(h1 == HASH_B, 4);

    ts::return_shared(cfg);
    ts::return_shared(session);
    ts::end(sc);
}

// ─────────────────────────────────────────────────────────────────────
// pay_and_record — error paths
// ─────────────────────────────────────────────────────────────────────

#[test, expected_failure(abort_code = rs::EBudgetExceeded)]
fun pay_and_record_over_budget_aborts() {
    let mut sc = setup();
    mint_with_budget(&mut sc, 100, 0);
    sc.next_tx(ASKER);
    let cfg = sc.take_shared<ArgusConfig>();
    let mut session = sc.take_shared<ResearchSession<SUI>>();
    rs::pay_and_record<SUI>(&cfg, &mut session, 200, PAYEE_A, HASH_A, 1, sc.ctx());
    ts::return_shared(cfg);
    ts::return_shared(session);
    ts::end(sc);
}

#[test, expected_failure(abort_code = rs::EZeroPayment)]
fun pay_and_record_zero_amount_aborts() {
    let mut sc = setup();
    mint_with_budget(&mut sc, 100, 0);
    sc.next_tx(ASKER);
    let cfg = sc.take_shared<ArgusConfig>();
    let mut session = sc.take_shared<ResearchSession<SUI>>();
    rs::pay_and_record<SUI>(&cfg, &mut session, 0, PAYEE_A, HASH_A, 1, sc.ctx());
    ts::return_shared(cfg);
    ts::return_shared(session);
    ts::end(sc);
}

#[test, expected_failure(abort_code = rs::EHashWrongLength)]
fun pay_and_record_wrong_hash_length_aborts() {
    let mut sc = setup();
    mint_with_budget(&mut sc, 100, 0);
    sc.next_tx(ASKER);
    let cfg = sc.take_shared<ArgusConfig>();
    let mut session = sc.take_shared<ResearchSession<SUI>>();
    rs::pay_and_record<SUI>(&cfg, &mut session, 50, PAYEE_A, b"too-short", 1, sc.ctx());
    ts::return_shared(cfg);
    ts::return_shared(session);
    ts::end(sc);
}

#[test, expected_failure(abort_code = rs::EReceiptAlreadyExists)]
fun pay_and_record_replay_nonce_aborts() {
    let mut sc = setup();
    mint_with_budget(&mut sc, 1000, 0);
    sc.next_tx(ASKER);
    let cfg = sc.take_shared<ArgusConfig>();
    let mut session = sc.take_shared<ResearchSession<SUI>>();
    rs::pay_and_record<SUI>(&cfg, &mut session, 50, PAYEE_A, HASH_A, 1, sc.ctx());
    rs::pay_and_record<SUI>(&cfg, &mut session, 50, PAYEE_A, HASH_B, 1, sc.ctx());
    ts::return_shared(cfg);
    ts::return_shared(session);
    ts::end(sc);
}

#[test]
fun pay_and_record_same_payee_different_nonce_settles_twice() {
    let mut sc = setup();
    mint_with_budget(&mut sc, 1000, 0);
    sc.next_tx(ASKER);
    let cfg = sc.take_shared<ArgusConfig>();
    let mut session = sc.take_shared<ResearchSession<SUI>>();
    rs::pay_and_record<SUI>(&cfg, &mut session, 50, PAYEE_A, HASH_A, 1, sc.ctx());
    rs::pay_and_record<SUI>(&cfg, &mut session, 75, PAYEE_A, HASH_B, 2, sc.ctx());
    assert!(rs::total_paid(&session) == 125, 0);
    assert!(vector::length(rs::paid_to(&session)) == 2, 1);
    ts::return_shared(cfg);
    ts::return_shared(session);
    ts::end(sc);
}

// ─────────────────────────────────────────────────────────────────────
// lock_session
// ─────────────────────────────────────────────────────────────────────

#[test]
fun lock_session_owner_locks_after_min_sources_met() {
    let mut sc = setup();
    mint_with_budget(&mut sc, 1000, 2);
    sc.next_tx(ASKER);
    let cfg = sc.take_shared<ArgusConfig>();
    let mut session = sc.take_shared<ResearchSession<SUI>>();
    rs::pay_and_record<SUI>(&cfg, &mut session, 50, PAYEE_A, HASH_A, 1, sc.ctx());
    rs::pay_and_record<SUI>(&cfg, &mut session, 75, PAYEE_B, HASH_B, 2, sc.ctx());
    rs::lock_session<SUI>(&cfg, &mut session, string::utf8(R_BLOB), sc.ctx());
    assert!(rs::locked(&session), 0);
    assert!(rs::response_blob_id(&session) == string::utf8(R_BLOB), 1);
    ts::return_shared(cfg);
    ts::return_shared(session);
    ts::end(sc);
}

#[test, expected_failure(abort_code = rs::EMinSourcesNotMet)]
fun lock_session_below_min_sources_aborts() {
    let mut sc = setup();
    mint_with_budget(&mut sc, 1000, 3);
    sc.next_tx(ASKER);
    let cfg = sc.take_shared<ArgusConfig>();
    let mut session = sc.take_shared<ResearchSession<SUI>>();
    rs::pay_and_record<SUI>(&cfg, &mut session, 50, PAYEE_A, HASH_A, 1, sc.ctx());
    rs::lock_session<SUI>(&cfg, &mut session, string::utf8(R_BLOB), sc.ctx());
    ts::return_shared(cfg);
    ts::return_shared(session);
    ts::end(sc);
}

#[test, expected_failure(abort_code = rs::ENotOwner)]
fun lock_session_non_owner_aborts() {
    let mut sc = setup();
    mint_with_budget(&mut sc, 1000, 0);
    sc.next_tx(STRANGER);
    let cfg = sc.take_shared<ArgusConfig>();
    let mut session = sc.take_shared<ResearchSession<SUI>>();
    rs::lock_session<SUI>(&cfg, &mut session, string::utf8(R_BLOB), sc.ctx());
    ts::return_shared(cfg);
    ts::return_shared(session);
    ts::end(sc);
}

#[test, expected_failure(abort_code = rs::EAlreadyLocked)]
fun pay_after_lock_aborts() {
    let mut sc = setup();
    mint_with_budget(&mut sc, 1000, 0);
    sc.next_tx(ASKER);
    let cfg = sc.take_shared<ArgusConfig>();
    let mut session = sc.take_shared<ResearchSession<SUI>>();
    rs::lock_session<SUI>(&cfg, &mut session, string::utf8(R_BLOB), sc.ctx());
    rs::pay_and_record<SUI>(&cfg, &mut session, 50, PAYEE_A, HASH_A, 1, sc.ctx());
    ts::return_shared(cfg);
    ts::return_shared(session);
    ts::end(sc);
}

// ─────────────────────────────────────────────────────────────────────
// allowlist
// ─────────────────────────────────────────────────────────────────────

#[test]
fun add_to_allowlist_idempotent() {
    let mut sc = setup();
    mint_with_budget(&mut sc, 100, 0);
    sc.next_tx(ASKER);
    let mut session = sc.take_shared<ResearchSession<SUI>>();
    rs::add_to_allowlist<SUI>(&mut session, VIEWER, sc.ctx());
    rs::add_to_allowlist<SUI>(&mut session, VIEWER, sc.ctx());
    let al = rs::allowlist(&session);
    assert!(vector::length(al) == 1, 0);
    assert!(*vector::borrow(al, 0) == VIEWER, 1);
    ts::return_shared(session);
    ts::end(sc);
}

#[test, expected_failure(abort_code = rs::ENotOwner)]
fun add_to_allowlist_non_owner_aborts() {
    let mut sc = setup();
    mint_with_budget(&mut sc, 100, 0);
    sc.next_tx(STRANGER);
    let mut session = sc.take_shared<ResearchSession<SUI>>();
    rs::add_to_allowlist<SUI>(&mut session, VIEWER, sc.ctx());
    ts::return_shared(session);
    ts::end(sc);
}

// ─────────────────────────────────────────────────────────────────────
// seal_approve
// ─────────────────────────────────────────────────────────────────────

#[test]
fun seal_approve_owner_passes() {
    let mut sc = setup();
    mint_with_budget(&mut sc, 100, 0);
    sc.next_tx(ASKER);
    let session = sc.take_shared<ResearchSession<SUI>>();
    let id_bytes = sui::object::id_to_bytes(&sui::object::id(&session));
    rs::seal_approve_for_testing<SUI>(id_bytes, &session, sc.ctx());
    ts::return_shared(session);
    ts::end(sc);
}

#[test]
fun seal_approve_allowlisted_passes() {
    let mut sc = setup();
    mint_with_budget(&mut sc, 100, 0);
    sc.next_tx(ASKER);
    let mut session = sc.take_shared<ResearchSession<SUI>>();
    rs::add_to_allowlist<SUI>(&mut session, VIEWER, sc.ctx());
    ts::return_shared(session);

    sc.next_tx(VIEWER);
    let session = sc.take_shared<ResearchSession<SUI>>();
    let id_bytes = sui::object::id_to_bytes(&sui::object::id(&session));
    rs::seal_approve_for_testing<SUI>(id_bytes, &session, sc.ctx());
    ts::return_shared(session);
    ts::end(sc);
}

#[test, expected_failure(abort_code = rs::ENotInAllowlist)]
fun seal_approve_stranger_aborts() {
    let mut sc = setup();
    mint_with_budget(&mut sc, 100, 0);
    sc.next_tx(STRANGER);
    let session = sc.take_shared<ResearchSession<SUI>>();
    let id_bytes = sui::object::id_to_bytes(&sui::object::id(&session));
    rs::seal_approve_for_testing<SUI>(id_bytes, &session, sc.ctx());
    ts::return_shared(session);
    ts::end(sc);
}

#[test, expected_failure(abort_code = rs::ESealKeyMismatch)]
fun seal_approve_wrong_id_aborts() {
    let mut sc = setup();
    mint_with_budget(&mut sc, 100, 0);
    sc.next_tx(ASKER);
    let session = sc.take_shared<ResearchSession<SUI>>();
    rs::seal_approve_for_testing<SUI>(b"not-the-right-id", &session, sc.ctx());
    ts::return_shared(session);
    ts::end(sc);
}

// ─────────────────────────────────────────────────────────────────────
// withdraw_balance
// ─────────────────────────────────────────────────────────────────────

#[test]
fun withdraw_balance_after_lock() {
    let mut sc = setup();
    mint_with_budget(&mut sc, 1000, 0);
    sc.next_tx(ASKER);
    let cfg = sc.take_shared<ArgusConfig>();
    let mut session = sc.take_shared<ResearchSession<SUI>>();
    rs::pay_and_record<SUI>(&cfg, &mut session, 100, PAYEE_A, HASH_A, 1, sc.ctx());
    rs::lock_session<SUI>(&cfg, &mut session, string::utf8(R_BLOB), sc.ctx());
    let leftover = rs::withdraw_balance<SUI>(&mut session, sc.ctx());
    assert!(coin::value(&leftover) == 900, 0);
    coin::burn_for_testing(leftover);
    assert!(rs::balance_value(&session) == 0, 1);
    ts::return_shared(cfg);
    ts::return_shared(session);
    ts::end(sc);
}

#[test, expected_failure(abort_code = rs::ENotLocked)]
fun withdraw_before_lock_aborts() {
    let mut sc = setup();
    mint_with_budget(&mut sc, 100, 0);
    sc.next_tx(ASKER);
    let mut session = sc.take_shared<ResearchSession<SUI>>();
    let leftover = rs::withdraw_balance<SUI>(&mut session, sc.ctx());
    coin::burn_for_testing(leftover);
    ts::return_shared(session);
    ts::end(sc);
}
