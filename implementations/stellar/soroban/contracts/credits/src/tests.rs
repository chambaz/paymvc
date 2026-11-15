use super::*;
use soroban_sdk::testutils::{Address as _, Ledger};

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
