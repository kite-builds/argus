/// session_display — publish a Display<ResearchSession<T>> so wallets
/// (Slush, Suiet) render a rich card during PTB sign instead of raw bytes.
///
/// This module exists only to mint the Display object at package
/// publish time. The keys/values reference fields on ResearchSession,
/// so any wallet implementing Display V2 can show:
///   • Quikt-branded card with session id
///   • Live total_paid + budget_cap counters
///   • Owner address
/// directly in the approval modal.
module quikt_sui::session_display;

use std::string::utf8;
use sui::display;
use sui::package;
use quikt_sui::research_session::ResearchSession;

/// One-time witness for `package::claim`.
public struct SESSION_DISPLAY has drop {}

fun init(otw: SESSION_DISPLAY, ctx: &mut TxContext) {
    let publisher = package::claim(otw, ctx);

    let keys = vector[
        utf8(b"name"),
        utf8(b"description"),
        utf8(b"image_url"),
        utf8(b"thumbnail_url"),
        utf8(b"project_url"),
        utf8(b"link"),
        utf8(b"creator"),
    ];
    let values = vector[
        utf8(b"Quikt research session"),
        utf8(b"Atomic agent receipts on Sui. Owner: {owner}. Paid {total_paid} of {budget_cap} so far."),
        utf8(b"https://quikt.dev/card.png"),
        utf8(b"https://quikt.dev/thumb.png"),
        utf8(b"https://quikt.dev"),
        utf8(b"https://suiscan.xyz/mainnet/object/{id}"),
        utf8(b"Quikt"),
    ];

    let mut d = display::new_with_fields<ResearchSession<sui::sui::SUI>>(
        &publisher, keys, values, ctx,
    );
    d.update_version();
    transfer::public_transfer(d, ctx.sender());
    transfer::public_transfer(publisher, ctx.sender());
}

#[test_only]
public fun init_for_testing(ctx: &mut TxContext) {
    init(SESSION_DISPLAY {}, ctx);
}
