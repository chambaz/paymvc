#![no_std]

use soroban_sdk::{
    Address, BytesN, Env, IntoVal, Val, Vec, contract, contractclient, contracterror,
    contractevent, contractimpl, contracttype, panic_with_error, token,
};

const ALLOCATION: i128 = 100;
const MAX_AMOUNT: i128 = 1_000_000;
const MAX_PAGE: u32 = 50;
const TTL: u32 = 518_400;

#[contractclient(name = "CreditsClient")]
pub trait Credits {
    fn mint(e: Env, to: Address, amount: i128);
}

#[contracttype]
#[derive(Clone)]
enum Key {
    // Instance storage
    Token,
    ProfileCount,
    // Persistent storage
    Profile(Address),
    Member(u64),
    ActivityCount(Address),
    Activity(Address, u64),
    Entry(Address, BytesN<32>),
}

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Kind {
    Transfer,
    Request,
}

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum State {
    Pending,
    Paid,
    Declined,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Entry {
    pub from: Address,
    pub to: Address,
    pub operation: BytesN<32>,
    pub amount: i128,
    pub kind: Kind,
    pub state: State,
}

/// An account registered and received its allocation.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Registered {
    #[topic]
    pub account: Address,
}

/// A transfer or request was created. `to` is the recipient or the intended payer.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Created {
    #[topic]
    pub from: Address,
    #[topic]
    pub to: Address,
    pub operation: BytesN<32>,
    pub amount: i128,
    pub kind: Kind,
}

/// A request was paid or declined.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Resolved {
    #[topic]
    pub from: Address,
    pub operation: BytesN<32>,
    pub state: State,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Error {
    AlreadyRegistered = 1,
    NotRegistered = 2,
    InvalidParticipants = 3,
    InvalidAmount = 4,
    InvalidOperation = 5,
    OperationUsed = 6,
    NotFound = 7,
    Unauthorized = 8,
    NotPending = 9,
    InvalidPage = 10,
}

/// Extends the contract instance and, when given, one persistent entry.
/// Only writes call this: reads are simulations, so an extension would not persist.
fn keep(e: &Env, key: Option<&Key>) {
    let ttl = e.storage().max_ttl().min(TTL);
    e.storage().instance().extend_ttl(ttl / 2, ttl);
    if let Some(key) = key {
        e.storage().persistent().extend_ttl(key, ttl / 2, ttl);
    }
}

fn save<V: IntoVal<Env, Val>>(e: &Env, key: &Key, value: &V) {
    e.storage().persistent().set(key, value);
    keep(e, Some(key));
}

fn token(e: &Env) -> token::Client<'_> {
    token::Client::new(e, &e.storage().instance().get(&Key::Token).unwrap())
}

fn registered(e: &Env, account: &Address) -> bool {
    e.storage().persistent().has(&Key::Profile(account.clone()))
}

fn profile_count(e: &Env) -> u64 {
    e.storage().instance().get(&Key::ProfileCount).unwrap_or(0)
}

fn activity_count(e: &Env, account: &Address) -> u64 {
    e.storage()
        .persistent()
        .get(&Key::ActivityCount(account.clone()))
        .unwrap_or(0)
}

fn entry(e: &Env, from: &Address, operation: &BytesN<32>) -> Option<Entry> {
    e.storage()
        .persistent()
        .get(&Key::Entry(from.clone(), operation.clone()))
}

fn check_page(e: &Env, limit: u32) {
    if limit == 0 || limit > MAX_PAGE {
        panic_with_error!(e, Error::InvalidPage);
    }
}

/// Adds the entry key `(from, operation)` to the account's activity list.
fn append(e: &Env, account: &Address, from: &Address, operation: &BytesN<32>) {
    let index = activity_count(e, account);
    save(
        e,
        &Key::Activity(account.clone(), index),
        &(from.clone(), operation.clone()),
    );
    save(e, &Key::ActivityCount(account.clone()), &(index + 1));
}

/// Creates a transfer (Paid, credits move now) or a request (Pending, no funds reserved).
fn create(e: &Env, from: Address, to: Address, amount: i128, operation: BytesN<32>, kind: Kind) {
    from.require_auth();
    if !(1..=MAX_AMOUNT).contains(&amount) {
        panic_with_error!(e, Error::InvalidAmount);
    }
    if from == to {
        panic_with_error!(e, Error::InvalidParticipants);
    }
    if !registered(e, &from) || !registered(e, &to) {
        panic_with_error!(e, Error::NotRegistered);
    }
    if operation == BytesN::from_array(e, &[0; 32]) {
        panic_with_error!(e, Error::InvalidOperation);
    }
    if entry(e, &from, &operation).is_some() {
        panic_with_error!(e, Error::OperationUsed);
    }
    // Active profiles stay live, so a payment rarely has to restore an archived one.
    keep(e, Some(&Key::Profile(from.clone())));
    keep(e, Some(&Key::Profile(to.clone())));
    let state = match kind {
        Kind::Transfer => {
            token(e).transfer(&from, &to, &amount);
            State::Paid
        }
        Kind::Request => State::Pending,
    };
    let key = Key::Entry(from.clone(), operation.clone());
    let record = Entry {
        from: from.clone(),
        to: to.clone(),
        operation: operation.clone(),
        amount,
        kind,
        state,
    };
    save(e, &key, &record);
    append(e, &from, &from, &operation);
    append(e, &to, &from, &operation);
    Created {
        from,
        to,
        operation,
        amount,
        kind,
    }
    .publish(e);
}

/// Loads a Pending request that `payer` may resolve. The payer must sign.
fn pending(e: &Env, payer: &Address, from: &Address, operation: &BytesN<32>) -> Entry {
    payer.require_auth();
    let record = entry(e, from, operation).unwrap_or_else(|| panic_with_error!(e, Error::NotFound));
    if record.to != *payer {
        panic_with_error!(e, Error::Unauthorized);
    }
    if record.kind != Kind::Request || record.state != State::Pending {
        panic_with_error!(e, Error::NotPending);
    }
    keep(e, Some(&Key::Profile(payer.clone())));
    record
}

fn finish(e: &Env, mut record: Entry, state: State) {
    record.state = state;
    let key = Key::Entry(record.from.clone(), record.operation.clone());
    save(e, &key, &record);
    Resolved {
        from: record.from,
        operation: record.operation,
        state,
    }
    .publish(e);
}

#[contract]
pub struct PayMVC;

#[contractimpl]
impl PayMVC {
    /// Deploys the credits contract with this app as its only minter.
    pub fn __constructor(e: Env, token_wasm: BytesN<32>) {
        let token = e.deployer().with_current_contract([0; 32]).deploy_contract(
            soroban_sdk::ContractExecutable::Wasm(token_wasm),
            (e.current_contract_address(),),
        );
        e.storage().instance().set(&Key::Token, &token);
        keep(&e, None);
    }

    pub fn token(e: Env) -> Address {
        e.storage().instance().get(&Key::Token).unwrap()
    }

    /// Adds `owner` to the directory and mints 100 credits, once.
    pub fn register(e: Env, owner: Address) {
        owner.require_auth();
        if registered(&e, &owner) {
            panic_with_error!(&e, Error::AlreadyRegistered);
        }
        let index = profile_count(&e);
        e.storage().instance().set(&Key::ProfileCount, &(index + 1));
        save(&e, &Key::Profile(owner.clone()), &());
        save(&e, &Key::Member(index), &owner);
        CreditsClient::new(&e, &token(&e).address).mint(&owner, &ALLOCATION);
        Registered { account: owner }.publish(&e);
    }

    pub fn send(e: Env, from: Address, to: Address, amount: i128, operation: BytesN<32>) {
        create(&e, from, to, amount, operation, Kind::Transfer);
    }

    pub fn request(e: Env, from: Address, payer: Address, amount: i128, operation: BytesN<32>) {
        create(&e, from, payer, amount, operation, Kind::Request);
    }

    /// Pays the request from `payer` to the requester and marks it Paid.
    pub fn approve(e: Env, payer: Address, from: Address, operation: BytesN<32>) {
        let record = pending(&e, &payer, &from, &operation);
        // The requester receives credits, so their profile stays live too.
        keep(&e, Some(&Key::Profile(from.clone())));
        token(&e).transfer(&payer, &from, &record.amount);
        finish(&e, record, State::Paid);
    }

    /// Marks the request Declined. No credits move.
    pub fn decline(e: Env, payer: Address, from: Address, operation: BytesN<32>) {
        let record = pending(&e, &payer, &from, &operation);
        finish(&e, record, State::Declined);
    }

    pub fn registered(e: Env, account: Address) -> bool {
        registered(&e, &account)
    }

    pub fn profile_count(e: Env) -> u64 {
        profile_count(&e)
    }

    /// Registered addresses in registration order, from index `start`.
    pub fn profiles(e: Env, start: u64, limit: u32) -> Vec<Address> {
        check_page(&e, limit);
        let end = profile_count(&e).min(start.saturating_add(limit.into()));
        let mut page = Vec::new(&e);
        for index in start..end {
            page.push_back(e.storage().persistent().get(&Key::Member(index)).unwrap());
        }
        page
    }

    pub fn entry(e: Env, from: Address, operation: BytesN<32>) -> Option<Entry> {
        entry(&e, &from, &operation)
    }

    pub fn activity_count(e: Env, account: Address) -> u64 {
        activity_count(&e, &account)
    }

    /// The account's entries with history index below `before`, newest first.
    pub fn activity(e: Env, account: Address, before: u64, limit: u32) -> Vec<Entry> {
        check_page(&e, limit);
        let end = activity_count(&e, &account).min(before);
        let mut page = Vec::new(&e);
        for index in (end.saturating_sub(limit.into())..end).rev() {
            let (from, operation): (Address, BytesN<32>) = e
                .storage()
                .persistent()
                .get(&Key::Activity(account.clone(), index))
                .unwrap();
            page.push_back(entry(&e, &from, &operation).unwrap());
        }
        page
    }
}

#[cfg(test)]
mod tests;
