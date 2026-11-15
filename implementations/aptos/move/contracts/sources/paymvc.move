/// PayMVC: a directory of registered addresses, direct transfers, and requests.
module paymvc::paymvc {
    use std::option::{Self, Option};
    use std::signer;
    use aptos_std::table::{Self, Table};
    use aptos_framework::primary_fungible_store;
    use paymvc::credits;

    /// The account is already registered.
    const E_ALREADY_REGISTERED: u64 = 1;
    /// A participant is not registered.
    const E_NOT_REGISTERED: u64 = 2;
    /// The sender and the other account must be different.
    const E_INVALID_PARTICIPANTS: u64 = 3;
    /// The amount must be from 1 to 1,000,000.
    const E_INVALID_AMOUNT: u64 = 4;
    /// The operation ID must be 32 bytes and not zero.
    const E_INVALID_OPERATION: u64 = 5;
    /// The sender already used this operation ID.
    const E_OPERATION_USED: u64 = 6;
    /// No entry has this sender and operation ID.
    const E_NOT_FOUND: u64 = 7;
    /// Only the intended payer can resolve the request.
    const E_UNAUTHORIZED: u64 = 8;
    /// The request is not pending.
    const E_NOT_PENDING: u64 = 9;
    /// The page limit must be from 1 to 50.
    const E_INVALID_PAGE: u64 = 10;

    const ALLOCATION: u64 = 100;
    const MAX_AMOUNT: u64 = 1_000_000;
    const MAX_PAGE: u64 = 50;
    const OPERATION_BYTES: u64 = 32;

    enum Kind has copy, drop, store { Transfer, Request }

    enum State has copy, drop, store { Pending, Paid, Declined }

    /// An entry's identity: the account that created it and its operation ID.
    struct EntryKey has copy, drop, store {
        from: address,
        operation: vector<u8>,
    }

    /// One transfer or one request. `from` sends or requests; `to` receives or pays.
    struct Entry has copy, drop, store {
        from: address,
        to: address,
        operation: vector<u8>,
        amount: u64,
        kind: Kind,
        state: State,
    }

    struct App has key {
        profiles: Table<u64, address>,
        profile_count: u64,
        entries: Table<EntryKey, Entry>,
    }

    /// Held at each registered address. Lists the keys of its entries, oldest first.
    struct Profile has key {
        activity: Table<u64, EntryKey>,
        activity_count: u64,
    }

    fun init_module(publisher: &signer) {
        move_to(publisher, App {
            profiles: table::new(),
            profile_count: 0,
            entries: table::new(),
        });
    }

    public entry fun register(account: &signer) acquires App {
        let owner = signer::address_of(account);
        assert!(!exists<Profile>(owner), E_ALREADY_REGISTERED);
        let app = &mut App[@paymvc];
        app.profiles.add(app.profile_count, owner);
        app.profile_count += 1;
        move_to(account, Profile { activity: table::new(), activity_count: 0 });
        credits::mint(owner, ALLOCATION);
    }

    public entry fun send(
        sender: &signer, to: address, amount: u64, operation: vector<u8>
    ) acquires App, Profile {
        let from = signer::address_of(sender);
        create(from, to, amount, operation, Kind::Transfer, State::Paid);
        primary_fungible_store::transfer(sender, credits::metadata(), to, amount);
    }

    public entry fun request(
        requester: &signer, payer: address, amount: u64, operation: vector<u8>
    ) acquires App, Profile {
        create(
            signer::address_of(requester), payer, amount, operation, Kind::Request, State::Pending
        );
    }

    public entry fun approve(payer: &signer, from: address, operation: vector<u8>) acquires App {
        let entry = pending(payer, from, operation);
        entry.state = State::Paid;
        primary_fungible_store::transfer(payer, credits::metadata(), from, entry.amount);
    }

    public entry fun decline(payer: &signer, from: address, operation: vector<u8>) acquires App {
        pending(payer, from, operation).state = State::Declined;
    }

    fun create(
        from: address, to: address, amount: u64, operation: vector<u8>, kind: Kind, state: State
    ) acquires App, Profile {
        assert!(from != to, E_INVALID_PARTICIPANTS);
        assert!(exists<Profile>(from) && exists<Profile>(to), E_NOT_REGISTERED);
        assert!(amount >= 1 && amount <= MAX_AMOUNT, E_INVALID_AMOUNT);
        assert!(
            operation.length() == OPERATION_BYTES && operation.any(|byte| *byte != 0),
            E_INVALID_OPERATION
        );
        let key = EntryKey { from, operation };
        let entries = &mut App[@paymvc].entries;
        assert!(!entries.contains(key), E_OPERATION_USED);
        entries.add(key, Entry { from, to, operation, amount, kind, state });
        append_activity(from, key);
        append_activity(to, key);
    }

    fun append_activity(owner: address, key: EntryKey) acquires Profile {
        let profile = &mut Profile[owner];
        profile.activity.add(profile.activity_count, key);
        profile.activity_count += 1;
    }

    /// The pending request `(from, operation)`, if `payer` is its intended payer.
    inline fun pending(payer: &signer, from: address, operation: vector<u8>): &mut Entry {
        let entries = &mut App[@paymvc].entries;
        let key = EntryKey { from, operation };
        assert!(entries.contains(key), E_NOT_FOUND);
        let entry = entries.borrow_mut(key);
        assert!(entry.to == signer::address_of(payer), E_UNAUTHORIZED);
        assert!(entry.state is State::Pending, E_NOT_PENDING);
        entry
    }

    #[view]
    public fun registered(account: address): bool {
        exists<Profile>(account)
    }

    #[view]
    public fun profile_count(): u64 acquires App {
        App[@paymvc].profile_count
    }

    #[view]
    /// Registered addresses in registration order, from index `start`.
    public fun profiles(start: u64, limit: u64): vector<address> acquires App {
        assert!(limit >= 1 && limit <= MAX_PAGE, E_INVALID_PAGE);
        let app = &App[@paymvc];
        let result = vector[];
        let index = start;
        while (index < app.profile_count && result.length() < limit) {
            result.push_back(*app.profiles.borrow(index));
            index += 1;
        };
        result
    }

    #[view]
    public fun entry(from: address, operation: vector<u8>): Option<Entry> acquires App {
        let entries = &App[@paymvc].entries;
        let key = EntryKey { from, operation };
        if (entries.contains(key)) option::some(*entries.borrow(key)) else option::none()
    }

    #[view]
    public fun activity_count(account: address): u64 acquires Profile {
        if (exists<Profile>(account)) Profile[account].activity_count else 0
    }

    #[view]
    /// Newest first: the entries of `account` with history index below `before`.
    /// Start with `before = activity_count(account)`. New entries never shift a later page.
    public fun activity(account: address, before: u64, limit: u64): vector<Entry> acquires App, Profile {
        assert!(limit >= 1 && limit <= MAX_PAGE, E_INVALID_PAGE);
        let result = vector[];
        if (!exists<Profile>(account)) return result;
        let profile = &Profile[account];
        let entries = &App[@paymvc].entries;
        let index = if (before > profile.activity_count) profile.activity_count else before;
        while (index > 0 && result.length() < limit) {
            index -= 1;
            result.push_back(*entries.borrow(*profile.activity.borrow(index)));
        };
        result
    }

    #[test_only]
    public fun init_for_test(publisher: &signer) {
        credits::init_for_test(publisher);
        init_module(publisher)
    }

    #[test_only]
    public fun is_paid(entry: &Entry): bool { entry.state is State::Paid }

    #[test_only]
    public fun is_pending(entry: &Entry): bool { entry.state is State::Pending }

    #[test_only]
    public fun is_declined(entry: &Entry): bool { entry.state is State::Declined }

    #[test_only]
    public fun is_request(entry: &Entry): bool { entry.kind is Kind::Request }

    #[test_only]
    public fun amount(entry: &Entry): u64 { entry.amount }

    #[test_only]
    public fun operation(entry: &Entry): vector<u8> { entry.operation }
}
