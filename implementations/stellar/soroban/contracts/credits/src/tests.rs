use super::*;
use soroban_sdk::testutils::{Address as _, Ledger, MuxedAddress as _};
use soroban_sdk::{MuxedAddress, token::TokenClient};

#[test]
fn allowance_is_consumed_and_expires_after_its_last_ledger() {
    let e = Env::default();
    e.ledger().with_mut(|ledger| ledger.sequence_number = 100);
    let owner = Address::generate(&e);
    let spender = Address::generate(&e);
    let recipient = Address::generate(&e);
    let id = e.register(Credits, (&owner,));
    let c = CreditsClient::new(&e, &id);
    e.mock_all_auths();
    c.mint(&owner, &100);
    c.approve(&owner, &spender, &10, &110);
    c.transfer_from(&spender, &owner, &recipient, &6);
    assert_eq!(c.allowance(&owner, &spender), 4);
    assert!(
        c.try_transfer_from(&spender, &owner, &recipient, &5)
            .is_err()
    );
    assert_eq!(c.balance(&recipient), 6);
    e.ledger().with_mut(|ledger| ledger.sequence_number = 110);
    assert_eq!(c.allowance(&owner, &spender), 4);
    e.ledger().with_mut(|ledger| ledger.sequence_number = 111);
    assert_eq!(c.allowance(&owner, &spender), 0);
    assert!(
        c.try_transfer_from(&spender, &owner, &recipient, &1)
            .is_err()
    );
}

#[test]
fn approval_and_delegated_spending_require_authorization() {
    let e = Env::default();
    let owner = Address::generate(&e);
    let spender = Address::generate(&e);
    let id = e.register(Credits, (&owner,));
    let c = CreditsClient::new(&e, &id);
    assert!(c.try_approve(&owner, &spender, &10, &100).is_err());
    e.mock_all_auths();
    c.mint(&owner, &100);
    c.approve(&owner, &spender, &10, &100);
    e.mock_auths(&[]);
    assert!(
        c.try_transfer_from(&spender, &owner, &spender, &10)
            .is_err()
    );
    assert!(c.try_burn_from(&spender, &owner, &10).is_err());
    assert_eq!(c.balance(&owner), 100);
    assert_eq!(c.allowance(&owner, &spender), 10);
}

#[test]
fn failed_delegated_transfer_does_not_consume_allowance() {
    let e = Env::default();
    let owner = Address::generate(&e);
    let spender = Address::generate(&e);
    let id = e.register(Credits, (&owner,));
    let c = CreditsClient::new(&e, &id);
    e.mock_all_auths();
    c.approve(&owner, &spender, &10, &100);
    assert!(
        c.try_transfer_from(&spender, &owner, &spender, &10)
            .is_err()
    );
    assert_eq!(c.allowance(&owner, &spender), 10);
    c.approve(&owner, &spender, &0, &0);
    assert_eq!(c.allowance(&owner, &spender), 0);
}

#[test]
fn errors_use_codes_that_do_not_collide_with_the_app() {
    let e = Env::default();
    let owner = Address::generate(&e);
    let id = e.register(Credits, (&owner,));
    let c = CreditsClient::new(&e, &id);
    e.mock_all_auths();
    assert_eq!(
        c.try_transfer(&owner, MuxedAddress::from(owner.clone()), &1),
        Err(Ok(Error::InsufficientBalance.into()))
    );
    assert_eq!(Error::InsufficientBalance as u32, 101);
}

#[test]
fn approval_cannot_outlive_the_network_maximum() {
    let e = Env::default();
    let owner = Address::generate(&e);
    let spender = Address::generate(&e);
    let id = e.register(Credits, (&owner,));
    let c = CreditsClient::new(&e, &id);
    e.mock_all_auths();
    let max = e.ledger().max_live_until_ledger();
    assert_eq!(
        c.try_approve(&owner, &spender, &10, &(max + 1)),
        Err(Ok(Error::InvalidExpiry.into()))
    );
    c.approve(&owner, &spender, &10, &max);
    assert_eq!(c.allowance(&owner, &spender), 10);
}

#[test]
fn burns_and_muxed_transfers_change_balances_once() {
    let e = Env::default();
    let owner = Address::generate(&e);
    let spender = Address::generate(&e);
    let muxed = MuxedAddress::generate(&e);
    let recipient = muxed.address();
    let id = e.register(Credits, (&owner,));
    let c = CreditsClient::new(&e, &id);
    let token = TokenClient::new(&e, &id);
    e.mock_all_auths();
    c.mint(&owner, &100);
    // A muxed address pays the underlying account.
    token.transfer(&owner, &muxed, &10);
    assert_eq!(c.balance(&recipient), 10);
    c.burn(&owner, &5);
    c.approve(&owner, &spender, &5, &100);
    c.burn_from(&spender, &owner, &5);
    assert_eq!(c.balance(&owner), 80);
    assert_eq!(c.allowance(&owner, &spender), 0);
    assert!(c.try_burn(&owner, &81).is_err());
}
