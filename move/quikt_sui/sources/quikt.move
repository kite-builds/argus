/// Quikt root module — package config + admin cap.
///
/// Quikt is a race-condition-free agent payment + execution layer.
/// Where x402 separates payment settlement from response delivery
/// (and loses money to facilitator/chain-confirmation timing races),
/// Quikt binds both into a single atomic Sui PTB.
///
/// This module owns:
///   • Package init: minting the AdminCap for the publisher.
///   • Versioning: a shared `QuiktConfig` object that downstream
///     modules check before mutating state, so we can hot-fix the
///     deployed package without re-publishing.
module quikt_sui::quikt;

use sui::event;

// ─────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────

const EWrongVersion: u64 = 0;

// ─────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────

const CURRENT_VERSION: u64 = 1;

// ─────────────────────────────────────────────────────────────────────
// Objects
// ─────────────────────────────────────────────────────────────────────

/// Owner cap minted once at publish. Holders can bump the package
/// version when an upgrade lands.
public struct AdminCap has key, store {
    id: UID,
}

/// Shared package configuration. Every state-mutating entry function
/// in the package validates `config.version == CURRENT_VERSION` so an
/// admin can disable a buggy old binary by bumping the version.
public struct QuiktConfig has key {
    id: UID,
    version: u64,
}

// ─────────────────────────────────────────────────────────────────────
// Events
// ─────────────────────────────────────────────────────────────────────

public struct VersionBumped has copy, drop {
    old_version: u64,
    new_version: u64,
}

// ─────────────────────────────────────────────────────────────────────
// Init
// ─────────────────────────────────────────────────────────────────────

fun init(ctx: &mut TxContext) {
    let admin = AdminCap { id: object::new(ctx) };
    transfer::public_transfer(admin, ctx.sender());

    let config = QuiktConfig {
        id: object::new(ctx),
        version: CURRENT_VERSION,
    };
    transfer::share_object(config);
}

// ─────────────────────────────────────────────────────────────────────
// Admin
// ─────────────────────────────────────────────────────────────────────

/// Bump the on-chain version pointer. Called after the package is
/// re-published so downstream modules can refuse old code paths.
public fun bump_version(_: &AdminCap, config: &mut QuiktConfig, new_version: u64) {
    let old_version = config.version;
    assert!(new_version > old_version, EWrongVersion);
    config.version = new_version;
    event::emit(VersionBumped { old_version, new_version });
}

// ─────────────────────────────────────────────────────────────────────
// Read helpers — used by sibling modules to gate state mutations.
// ─────────────────────────────────────────────────────────────────────

public fun version(config: &QuiktConfig): u64 { config.version }

public fun assert_current_version(config: &QuiktConfig) {
    assert!(config.version == CURRENT_VERSION, EWrongVersion);
}

// ─────────────────────────────────────────────────────────────────────
// Test-only constructors
// ─────────────────────────────────────────────────────────────────────

#[test_only]
public fun init_for_testing(ctx: &mut TxContext) {
    init(ctx);
}

#[test_only]
public fun admin_cap_for_testing(ctx: &mut TxContext): AdminCap {
    AdminCap { id: object::new(ctx) }
}

#[test_only]
public fun config_for_testing(ctx: &mut TxContext): QuiktConfig {
    QuiktConfig { id: object::new(ctx), version: CURRENT_VERSION }
}

#[test_only]
public fun destroy_admin_cap_for_testing(cap: AdminCap) {
    let AdminCap { id } = cap;
    object::delete(id);
}

#[test_only]
public fun destroy_config_for_testing(config: QuiktConfig) {
    let QuiktConfig { id, version: _ } = config;
    object::delete(id);
}
