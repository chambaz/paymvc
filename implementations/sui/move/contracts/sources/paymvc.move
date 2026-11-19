/// PayMVC: a directory of registered accounts, transfers, and payment requests.
///
/// `App` is generic over the coin type so that `credits` can create it in its
/// `init` without a module cycle. `create` is package-only, so the published
/// `App<CREDITS>` is the only instance.
module paymvc::paymvc;

use sui::balance;
use sui::coin::{Self, Coin, TreasuryCap};
use sui::event;
use sui::table::{Self, Table};

const E_ALREADY_REGISTERED: u64 = 1;
const E_NOT_REGISTERED: u64 = 2;
const E_INVALID_PARTICIPANTS: u64 = 3;
const E_INVALID_AMOUNT: u64 = 4;
const E_INVALID_OPERATION: u64 = 5;
const E_OPERATION_USED: u64 = 6;
const E_NOT_FOUND: u64 = 7;
const E_UNAUTHORIZED: u64 = 8;
const E_NOT_PENDING: u64 = 9;
const E_INVALID_PAGE: u64 = 10;

const ALLOCATION: u64 = 100;
const MAX_AMOUNT: u64 = 1_000_000;
const PAGE_LIMIT: u64 = 50;

public struct App<phantom T> has key {
    id: UID,
    treasury: TreasuryCap<T>,
    /// Registration order: index → account.
    members: Table<u64, address>,
    profiles: Table<address, Profile>,
    entries: Table<EntryKey, Entry>,
}

public struct Profile has store {
    /// History index → entry key. The newest entry has the highest index.
    activity: Table<u64, EntryKey>,
}

public struct EntryKey has copy, drop, store {
    from: address,
    operation: vector<u8>,
}

public enum Kind has copy, drop, store { Transfer, Request }

public enum State has copy, drop, store { Pending, Paid, Declined }

public struct Entry has copy, drop, store {
    /// The sender of a transfer, or the requester of a request.
    from: address,
    /// The recipient of a transfer, or the intended payer of a request.
    to: address,
    operation: vector<u8>,
    amount: u64,
    kind: Kind,
    state: State,
}

/// An account registered and received its allocation.
public struct Registered has copy, drop { account: address }

/// A transfer or request was created. `to` is the recipient or the intended payer.
public struct Created has copy, drop { from: address, to: address, operation: vector<u8>, amount: u64, kind: Kind }

/// A request was paid or declined.
public struct Resolved has copy, drop { from: address, operation: vector<u8>, state: State }

public(package) fun create<T>(treasury: TreasuryCap<T>, ctx: &mut TxContext) {
    transfer::share_object(App {
        id: object::new(ctx),
        treasury,
        members: table::new(ctx),
        profiles: table::new(ctx),
        entries: table::new(ctx),
    });
}

/// Add the caller to the directory and give it 100 credits, once.
/// Credits go to the account's address balance, so payments never fragment into many coins.
public fun register<T>(app: &mut App<T>, ctx: &mut TxContext) {
    let account = ctx.sender();
    assert!(!app.profiles.contains(account), E_ALREADY_REGISTERED);
    let index = app.members.length();
    app.members.add(index, account);
    app.profiles.add(account, Profile { activity: table::new(ctx) });
    balance::send_funds(coin::mint_balance(&mut app.treasury, ALLOCATION), account);
    event::emit(Registered { account });
}

/// Pay `to` with `payment`. The amount is the coin's value.
public fun send<T>(app: &mut App<T>, to: address, operation: vector<u8>, payment: Coin<T>, ctx: &mut TxContext) {
    let from = ctx.sender();
    let amount = payment.value();
    record(app, Entry { from, to, operation, amount, kind: Kind::Transfer, state: State::Paid });
    coin::send_funds(payment, to);
}

/// Ask `payer` for `amount`. No funds are reserved.
public fun request<T>(app: &mut App<T>, payer: address, amount: u64, operation: vector<u8>, ctx: &mut TxContext) {
    let from = ctx.sender();
    record(app, Entry { from, to: payer, operation, amount, kind: Kind::Request, state: State::Pending });
}

/// Pay the pending request `(from, operation)` with a coin of exactly its amount.
public fun approve<T>(app: &mut App<T>, from: address, operation: vector<u8>, payment: Coin<T>, ctx: &mut TxContext) {
    let entry = pending(app, from, operation, ctx);
    assert!(payment.value() == entry.amount, E_INVALID_AMOUNT);
    entry.state = State::Paid;
    coin::send_funds(payment, from);
    event::emit(Resolved { from, operation, state: State::Paid });
}

/// Refuse the pending request `(from, operation)`. No funds move.
public fun decline<T>(app: &mut App<T>, from: address, operation: vector<u8>, ctx: &mut TxContext) {
    pending(app, from, operation, ctx).state = State::Declined;
    event::emit(Resolved { from, operation, state: State::Declined });
}

fun record<T>(app: &mut App<T>, entry: Entry) {
    assert!(app.profiles.contains(entry.from), E_NOT_REGISTERED);
    assert!(entry.from != entry.to, E_INVALID_PARTICIPANTS);
    assert!(app.profiles.contains(entry.to), E_NOT_REGISTERED);
    assert!(entry.amount > 0 && entry.amount <= MAX_AMOUNT, E_INVALID_AMOUNT);
    assert!(entry.operation.length() == 32 && entry.operation.any!(|byte| *byte != 0), E_INVALID_OPERATION);
    let key = EntryKey { from: entry.from, operation: entry.operation };
    assert!(!app.entries.contains(key), E_OPERATION_USED);
    app.entries.add(key, entry);
    append(app, entry.from, key);
    append(app, entry.to, key);
    event::emit(Created { from: entry.from, to: entry.to, operation: entry.operation, amount: entry.amount, kind: entry.kind });
}

fun append<T>(app: &mut App<T>, account: address, key: EntryKey) {
    let activity = &mut app.profiles.borrow_mut(account).activity;
    let index = activity.length();
    activity.add(index, key);
}

/// The request `(from, operation)`, checked to be pending and payable by the caller.
fun pending<T>(app: &mut App<T>, from: address, operation: vector<u8>, ctx: &mut TxContext): &mut Entry {
    let key = EntryKey { from, operation };
    assert!(app.entries.contains(key), E_NOT_FOUND);
    let entry = app.entries.borrow_mut(key);
    assert!(entry.to == ctx.sender(), E_UNAUTHORIZED);
    // Transfers are created Paid, so only requests can pass.
    assert!(entry.state == State::Pending, E_NOT_PENDING);
    entry
}

public fun registered<T>(app: &App<T>, account: address): bool { app.profiles.contains(account) }

public fun profile_count<T>(app: &App<T>): u64 { app.members.length() }

/// Registered accounts in registration order, from index `start`.
public fun profiles<T>(app: &App<T>, start: u64, limit: u64): vector<address> {
    assert!(limit > 0 && limit <= PAGE_LIMIT, E_INVALID_PAGE);
    let count = app.members.length();
    if (start >= count) return vector[];
    let end = (start + limit).min(count);
    let mut accounts = vector[];
    let mut index = start;
    while (index < end) {
        accounts.push_back(*app.members.borrow(index));
        index = index + 1;
    };
    accounts
}

public fun entry<T>(app: &App<T>, from: address, operation: vector<u8>): Option<Entry> {
    let key = EntryKey { from, operation };
    if (app.entries.contains(key)) option::some(*app.entries.borrow(key)) else option::none()
}

public fun activity_count<T>(app: &App<T>, account: address): u64 {
    if (app.profiles.contains(account)) app.profiles.borrow(account).activity.length() else 0
}

/// The entries of `account` with history index below `before`, newest first.
/// Start with `before = activity_count`. New entries never shift a later page.
public fun activity<T>(app: &App<T>, account: address, before: u64, limit: u64): vector<Entry> {
    assert!(limit > 0 && limit <= PAGE_LIMIT, E_INVALID_PAGE);
    let mut entries = vector[];
    if (!app.profiles.contains(account)) return entries;
    let activity = &app.profiles.borrow(account).activity;
    let mut index = before.min(activity.length());
    while (index > 0 && entries.length() < limit) {
        index = index - 1;
        entries.push_back(*app.entries.borrow(*activity.borrow(index)));
    };
    entries
}

#[test_only]
public fun new_entry(from: address, to: address, operation: vector<u8>, amount: u64, request: bool, state: u8): Entry {
    let kind = if (request) Kind::Request else Kind::Transfer;
    let state = if (state == 0) State::Pending else if (state == 1) State::Paid else State::Declined;
    Entry { from, to, operation, amount, kind, state }
}

#[test_only]
public fun new_registered(account: address): Registered { Registered { account } }

#[test_only]
public fun new_created(from: address, to: address, operation: vector<u8>, amount: u64, request: bool): Created {
    let kind = if (request) Kind::Request else Kind::Transfer;
    Created { from, to, operation, amount, kind }
}

#[test_only]
public fun new_resolved(from: address, operation: vector<u8>, paid: bool): Resolved {
    let state = if (paid) State::Paid else State::Declined;
    Resolved { from, operation, state }
}
