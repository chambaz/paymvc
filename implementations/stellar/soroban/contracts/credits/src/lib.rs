#![no_std]

#[cfg(test)]
mod tests;

use soroban_sdk::{
    Address, Env, MuxedAddress, String, contract, contracterror, contractimpl, contracttype,
    panic_with_error, token::TokenInterface,
};
use soroban_token_sdk::events;

#[contracttype]
#[derive(Clone)]
enum Key {
    App,
    Balance(Address),
    Allowance(Address, Address),
}

#[contracttype]
#[derive(Clone)]
struct Allowance {
    amount: i128,
    until: u32,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
/// Codes start at 100, so they never match a PayMVC error code that a caller reports.
pub enum Error {
    InvalidAmount = 100,
    InsufficientBalance = 101,
    InsufficientAllowance = 102,
    InvalidExpiry = 103,
    Overflow = 104,
    InvalidConfiguration = 105,
}

/// Extends the contract instance and, when given, one persistent entry.
/// Only writes call this: reads are simulations, so an extension would not persist.
fn keep(e: &Env, key: Option<&Key>) {
    let ttl = e.storage().max_ttl().min(518_400);
    e.storage().instance().extend_ttl(ttl / 2, ttl);
    if let Some(key) = key {
        e.storage().persistent().extend_ttl(key, ttl / 2, ttl);
    }
}

fn balance(e: &Env, owner: &Address) -> i128 {
    e.storage()
        .persistent()
        .get(&Key::Balance(owner.clone()))
        .unwrap_or(0)
}

fn write_balance(e: &Env, owner: &Address, value: i128) {
    let key = Key::Balance(owner.clone());
    e.storage().persistent().set(&key, &value);
    keep(e, Some(&key));
}

fn nonnegative(e: &Env, amount: i128) {
    if amount < 0 {
        panic_with_error!(e, Error::InvalidAmount);
    }
}

fn debit(e: &Env, from: &Address, amount: i128) {
    nonnegative(e, amount);
    let current = balance(e, from);
    if current < amount {
        panic_with_error!(e, Error::InsufficientBalance);
    }
    write_balance(e, from, current - amount);
}

fn credit(e: &Env, to: &Address, amount: i128) {
    let next = balance(e, to)
        .checked_add(amount)
        .unwrap_or_else(|| panic_with_error!(e, Error::Overflow));
    write_balance(e, to, next);
}

fn allowance(e: &Env, from: &Address, spender: &Address) -> Allowance {
    let value: Allowance = e
        .storage()
        .temporary()
        .get(&Key::Allowance(from.clone(), spender.clone()))
        .unwrap_or(Allowance {
            amount: 0,
            until: 0,
        });
    if value.until < e.ledger().sequence() {
        Allowance {
            amount: 0,
            until: value.until,
        }
    } else {
        value
    }
}

fn spend_allowance(e: &Env, from: &Address, spender: &Address, amount: i128) {
    nonnegative(e, amount);
    let mut value = allowance(e, from, spender);
    if value.amount < amount {
        panic_with_error!(e, Error::InsufficientAllowance);
    }
    if amount > 0 {
        value.amount -= amount;
        e.storage()
            .temporary()
            .set(&Key::Allowance(from.clone(), spender.clone()), &value);
    }
}

#[contract]
pub struct Credits;

#[contractimpl]
impl Credits {
    pub fn __constructor(e: Env, app: Address) {
        e.storage().instance().set(&Key::App, &app);
        keep(&e, None);
    }

    // The app is the immutable mint authority. It exposes only atomic registration.
    pub fn mint(e: Env, to: Address, amount: i128) {
        let app: Address = e
            .storage()
            .instance()
            .get(&Key::App)
            .unwrap_or_else(|| panic_with_error!(&e, Error::InvalidConfiguration));
        app.require_auth();
        nonnegative(&e, amount);
        credit(&e, &to, amount);
        events::MintWithAmountOnly { to, amount }.publish(&e);
    }
}

#[contractimpl(contracttrait)]
impl TokenInterface for Credits {
    fn balance(e: Env, id: Address) -> i128 {
        balance(&e, &id)
    }
    fn allowance(e: Env, from: Address, spender: Address) -> i128 {
        allowance(&e, &from, &spender).amount
    }
    fn approve(e: Env, from: Address, spender: Address, amount: i128, live_until_ledger: u32) {
        from.require_auth();
        nonnegative(&e, amount);
        if (amount > 0 && live_until_ledger < e.ledger().sequence())
            || live_until_ledger > e.ledger().max_live_until_ledger()
        {
            panic_with_error!(&e, Error::InvalidExpiry);
        }
        keep(&e, None);
        let key = Key::Allowance(from.clone(), spender.clone());
        if amount == 0 {
            e.storage().temporary().remove(&key);
        } else {
            e.storage().temporary().set(
                &key,
                &Allowance {
                    amount,
                    until: live_until_ledger,
                },
            );
            let ttl = live_until_ledger - e.ledger().sequence();
            e.storage().temporary().extend_ttl(&key, ttl, ttl);
        }
        events::Approve {
            from,
            spender,
            amount,
            live_until_ledger,
        }
        .publish(&e);
    }
    fn transfer(e: Env, from: Address, to: MuxedAddress, amount: i128) {
        from.require_auth();
        debit(&e, &from, amount);
        credit(&e, &to.address(), amount);
        events::Transfer {
            from,
            to: to.address(),
            to_muxed_id: to.id(),
            amount,
        }
        .publish(&e);
    }
    fn transfer_from(e: Env, spender: Address, from: Address, to: Address, amount: i128) {
        spender.require_auth();
        spend_allowance(&e, &from, &spender, amount);
        debit(&e, &from, amount);
        credit(&e, &to, amount);
        events::Transfer {
            from,
            to,
            to_muxed_id: None,
            amount,
        }
        .publish(&e);
    }
    fn burn(e: Env, from: Address, amount: i128) {
        from.require_auth();
        debit(&e, &from, amount);
        events::Burn { from, amount }.publish(&e);
    }
    fn burn_from(e: Env, spender: Address, from: Address, amount: i128) {
        spender.require_auth();
        spend_allowance(&e, &from, &spender, amount);
        debit(&e, &from, amount);
        events::Burn { from, amount }.publish(&e);
    }
    fn decimals(_e: Env) -> u32 {
        0
    }
    fn name(e: Env) -> String {
        String::from_str(&e, "Demo Credits")
    }
    fn symbol(e: Env) -> String {
        String::from_str(&e, "DEMO")
    }
}
