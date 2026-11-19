use credits::{ERC20Client, ERC20Error, ERC20MetadataClient};
use paymvc::{
    ACTIVITY_PAGE, Created, Entry, Kind, MAX_AMOUNT, PROFILE_PAGE, PayMVCClient, PaymentError,
    Registered, Resolved, State,
};
use std::panic::AssertUnwindSafe;
use thruput_erc20_if::ERC20AllowanceExpiryClient;
use thruput_sdk::*;

static OP: SHA256Hash = thruput_sdk::sha256_static!("OPERATION");
static OP2: SHA256Hash = thruput_sdk::sha256_static!("OPERATION_2");
const ZERO_OP: SHA256Hash = SHA256Hash::new([0; 32]);

fn op(i: u8) -> SHA256Hash {
    SHA256Hash::new([i + 1; 32])
}

/// A deployed PayMVC and its credits token.
pub struct App<'a> {
    env: &'a TestEnvironmentHandle,
    pub address: ContractAddress,
    pub token: ContractAddress,
}

impl App<'_> {
    pub fn app(&self) -> PayMVCClient {
        PayMVCClient::new(&self.address)
    }

    pub fn credits(&self) -> ERC20Client {
        ERC20Client::new(&self.token)
    }

    /// Run `body` as one transaction from `caller` and require success.
    pub fn run(&self, caller: &ContractAddress, body: impl FnOnce(&Self)) {
        self.env
            .transact(|tx| tx.call(caller).run(AssertUnwindSafe(|| body(self))))
            .assert_success();
    }

    /// Run `body` as one transaction that must fail at commit, because an
    /// earlier transaction in the same block took an exclusive lock.
    pub fn conflict(&self, caller: &ContractAddress, body: impl FnOnce(&Self)) {
        self.env
            .transact(|tx| tx.call(caller).run(AssertUnwindSafe(|| body(self))))
            .assert_commit_failed_nondeterministically();
    }

    pub fn next_block(&self) {
        self.env.advance_block();
    }

    /// The wallet batch the client sends: allow PayMVC, then pay.
    pub fn send(&self, to: &ContractAddress, amount: i128, operation: &SHA256Hash) {
        self.credits().adjust_allowance(&self.address, amount);
        self.app().send(to, amount, operation);
    }

    pub fn approve(&self, from: &ContractAddress, operation: &SHA256Hash, amount: i128) {
        self.credits().adjust_allowance(&self.address, amount);
        self.app().approve(from, operation);
    }

    pub fn register(&self, account: &ContractAddress) {
        self.run(account, |a| a.app().register());
        self.next_block();
    }
}

/// Deploy both contracts the way the CLI deployment does: the token first,
/// then PayMVC with an initializer that binds the token.
pub fn deploy<'a>(
    env: &'a TestEnvironmentHandle,
    app_hash: &SHA256Hash,
    token_hash: &SHA256Hash,
) -> App<'a> {
    let deployer = ContractAddress::named("deployer");
    let mut addresses = (deployer, deployer);
    env.transact(|tx| {
        tx.call(&deployer).run(AssertUnwindSafe(|| {
            let token = deploy_contract(&sha256_static!("credits"), token_hash);
            let address = deploy_contract(&sha256_static!("paymvc"), app_hash);
            PayMVCClient::new(&address).initialize(&token);
            addresses = (address, token);
        }))
    })
    .assert_success();
    env.advance_block();
    App {
        env,
        address: addresses.0,
        token: addresses.1,
    }
}

fn alice() -> ContractAddress {
    ContractAddress::named("alice")
}
fn bob() -> ContractAddress {
    ContractAddress::named("bob")
}
fn outsider() -> ContractAddress {
    ContractAddress::named("outsider")
}

fn pair<'a>(env: &'a TestEnvironmentHandle, app: &SHA256Hash, token: &SHA256Hash) -> App<'a> {
    let a = deploy(env, app, token);
    a.register(&alice());
    a.register(&bob());
    a
}

fn entry(
    from: ContractAddress,
    to: ContractAddress,
    operation: SHA256Hash,
    amount: i128,
    kind: Kind,
    state: State,
) -> Entry {
    Entry {
        from,
        to,
        operation,
        amount,
        kind,
        state,
    }
}

pub fn registration_is_atomic_and_once(
    env: &TestEnvironmentHandle,
    app: &SHA256Hash,
    token: &SHA256Hash,
) {
    let a = deploy(env, app, token);
    a.run(&alice(), |a| a.app().register());
    a.conflict(&alice(), |a| a.app().register());
    a.next_block();
    a.run(&alice(), |a| {
        let app = a.app();
        assert_eq!(
            app.try_register().unwrap_err().try_as(),
            Some(PaymentError::AlreadyRegistered)
        );
        assert!(app.registered(&alice()));
        assert!(!app.registered(&bob()));
        assert_eq!(app.profiles(0, PROFILE_PAGE), [alice()]);
        assert_eq!(app.profile_count(), 1);
        assert_eq!(app.activity_count(&alice()), 0);
        assert_eq!(app.credits(), a.token);
        let token = a.credits();
        assert_eq!(token.get_balance(), 100);
        assert_eq!(token.total_supply(), 100);
        assert_eq!(
            token.try_mint(&alice(), 100).unwrap_err().try_as(),
            Some(ERC20Error::MustBeContractOwner)
        );
        assert_eq!(
            token.try_initialize(&alice()).unwrap_err().try_as(),
            Some(ERC20Error::AlreadyInitialized)
        );
        assert_eq!(
            app.try_initialize(&alice()).unwrap_err().try_as(),
            Some(PaymentError::Unauthorized)
        );
        let metadata = ERC20MetadataClient::new(&a.token);
        assert_eq!(metadata.decimals(), Some(0));
        assert_eq!(metadata.symbol().as_deref(), Some("CREDITS"));
    });
}

pub fn payments_and_request_lifecycle(
    env: &TestEnvironmentHandle,
    app: &SHA256Hash,
    token: &SHA256Hash,
) {
    let a = pair(env, app, token);
    a.run(&alice(), |a| {
        a.send(&bob(), 10, &OP);
        a.app().request(&bob(), 5, &OP2);
    });
    a.next_block();
    a.run(&bob(), |a| a.approve(&alice(), &OP2, 5));
    a.next_block();
    a.run(&alice(), |a| {
        let app = a.app();
        assert_eq!(a.credits().get_balance_of(&alice()), 95);
        assert_eq!(a.credits().get_balance_of(&bob()), 105);
        assert_eq!(a.credits().allowance(&bob(), &a.address), 0);
        assert_eq!(a.credits().allowance(&alice(), &a.address), 0);
        assert_eq!(app.activity_count(&alice()), 2);
        assert_eq!(
            app.activity(&bob(), 2, ACTIVITY_PAGE),
            [
                entry(alice(), bob(), OP2, 5, Kind::Request, State::Paid),
                entry(alice(), bob(), OP, 10, Kind::Transfer, State::Paid),
            ]
        );
        assert_eq!(
            app.entry(&alice(), &OP),
            Some(entry(alice(), bob(), OP, 10, Kind::Transfer, State::Paid))
        );
        assert_eq!(app.entry(&bob(), &OP), None);
    });
}

pub fn payments_need_the_payers_allowance(
    env: &TestEnvironmentHandle,
    app: &SHA256Hash,
    token: &SHA256Hash,
) {
    let a = pair(env, app, token);
    a.run(&alice(), |a| {
        assert_eq!(
            a.app().try_send(&bob(), 10, &OP).unwrap_err().try_as(),
            Some(ERC20Error::TooLarge)
        );
        assert_eq!(a.app().entry(&alice(), &OP), None);
        a.app().request(&bob(), 10, &OP);
    });
    a.next_block();
    // An allowance from someone else does not let PayMVC spend the payer's credits.
    a.run(&alice(), |a| a.credits().adjust_allowance(&a.address, 10));
    a.run(&bob(), |a| {
        assert_eq!(
            a.app().try_approve(&alice(), &OP).unwrap_err().try_as(),
            Some(ERC20Error::TooLarge)
        );
    });
    a.next_block();
    a.run(&bob(), |a| {
        assert_eq!(a.app().entry(&alice(), &OP).unwrap().state, State::Pending);
        assert_eq!(a.credits().get_balance(), 100);
    });
}

pub fn operation_ids_are_unique_per_sender(
    env: &TestEnvironmentHandle,
    app: &SHA256Hash,
    token: &SHA256Hash,
) {
    let a = pair(env, app, token);
    a.run(&alice(), |a| a.send(&bob(), 10, &OP));
    a.conflict(&alice(), |a| a.app().request(&bob(), 10, &OP));
    a.next_block();
    a.run(&alice(), |a| {
        let app = a.app();
        for result in [
            app.try_request(&bob(), 10, &OP),
            app.try_send(&bob(), 10, &OP),
        ] {
            assert_eq!(
                result.unwrap_err().try_as(),
                Some(PaymentError::OperationUsed)
            );
        }
        assert_eq!(
            app.try_request(&bob(), 10, &ZERO_OP).unwrap_err().try_as(),
            Some(PaymentError::InvalidOperation)
        );
    });
    // Another sender can use the same operation ID.
    a.run(&bob(), |a| a.app().request(&alice(), 3, &OP));
    a.next_block();
    a.run(&alice(), |a| {
        assert_eq!(a.app().activity_count(&alice()), 2);
        assert_eq!(a.credits().get_balance(), 90);
        assert_eq!(a.app().entry(&bob(), &OP).unwrap().kind, Kind::Request);
    });
}

pub fn only_payer_can_resolve(env: &TestEnvironmentHandle, app: &SHA256Hash, token: &SHA256Hash) {
    let a = pair(env, app, token);
    a.run(&alice(), |a| {
        a.app().request(&bob(), 5, &OP);
        a.send(&bob(), 1, &OP2);
    });
    a.next_block();
    for caller in [alice(), outsider()] {
        a.run(&caller, |a| {
            let app = a.app();
            assert_eq!(
                app.try_approve(&alice(), &OP).unwrap_err().try_as(),
                Some(PaymentError::Unauthorized)
            );
            assert_eq!(
                app.try_decline(&alice(), &OP).unwrap_err().try_as(),
                Some(PaymentError::Unauthorized)
            );
        });
    }
    a.run(&bob(), |a| {
        let app = a.app();
        assert_eq!(
            app.try_approve(&bob(), &OP).unwrap_err().try_as(),
            Some(PaymentError::NotFound)
        );
        assert_eq!(
            app.try_decline(&alice(), &OP2).unwrap_err().try_as(),
            Some(PaymentError::NotPending)
        );
        // Decline moves nothing and needs no credits or allowance.
        a.credits().transfer(&outsider(), 101);
        app.decline(&alice(), &OP);
    });
    a.next_block();
    a.run(&bob(), |a| {
        let app = a.app();
        assert_eq!(app.entry(&alice(), &OP).unwrap().state, State::Declined);
        for result in [
            app.try_approve(&alice(), &OP),
            app.try_decline(&alice(), &OP),
        ] {
            assert_eq!(result.unwrap_err().try_as(), Some(PaymentError::NotPending));
        }
        assert_eq!(a.credits().get_balance_of(&alice()), 99);
    });
}

pub fn same_block_resolutions_have_one_winner(
    env: &TestEnvironmentHandle,
    app: &SHA256Hash,
    token: &SHA256Hash,
) {
    let a = pair(env, app, token);
    a.run(&alice(), |a| a.app().request(&bob(), 20, &OP));
    a.next_block();
    a.run(&bob(), |a| a.approve(&alice(), &OP, 20));
    a.conflict(&bob(), |a| a.approve(&alice(), &OP, 20));
    a.conflict(&bob(), |a| a.app().decline(&alice(), &OP));
    a.next_block();
    a.run(&bob(), |a| {
        assert_eq!(a.credits().get_balance(), 80);
        assert_eq!(a.credits().get_balance_of(&alice()), 120);
        assert_eq!(a.app().entry(&alice(), &OP).unwrap().state, State::Paid);
    });
}

pub fn insufficient_balance_keeps_request_pending(
    env: &TestEnvironmentHandle,
    app: &SHA256Hash,
    token: &SHA256Hash,
) {
    let a = pair(env, app, token);
    a.run(&alice(), |a| {
        a.credits().adjust_allowance(&a.address, 101);
        assert_eq!(
            a.app().try_send(&bob(), 101, &OP).unwrap_err().try_as(),
            Some(ERC20Error::TooLarge)
        );
        assert_eq!(a.app().activity_count(&alice()), 0);
        // A request reserves nothing, so it may exceed the payer's balance.
        a.app().request(&bob(), 101, &OP);
    });
    a.next_block();
    a.run(&bob(), |a| {
        a.credits().adjust_allowance(&a.address, 101);
        assert_eq!(
            a.app().try_approve(&alice(), &OP).unwrap_err().try_as(),
            Some(ERC20Error::TooLarge)
        );
        assert_eq!(a.app().entry(&alice(), &OP).unwrap().state, State::Pending);
        assert_eq!(a.credits().get_balance(), 100);
    });
}

pub fn external_transfers_reach_unregistered_accounts(
    env: &TestEnvironmentHandle,
    app: &SHA256Hash,
    token: &SHA256Hash,
) {
    let a = pair(env, app, token);
    a.run(&alice(), |a| a.credits().transfer(&outsider(), 60));
    a.next_block();
    a.register(&outsider());
    a.run(&outsider(), |a| {
        assert_eq!(a.credits().get_balance(), 160);
        assert_eq!(a.credits().get_balance_of(&alice()), 40);
        assert_eq!(a.credits().total_supply(), 300);
        assert_eq!(a.app().activity_count(&outsider()), 0);
        assert_eq!(
            a.credits()
                .try_transfer_from(&bob(), &outsider(), 1)
                .unwrap_err()
                .try_as(),
            Some(ERC20Error::TooLarge)
        );
    });
}

pub fn invalid_inputs_and_bounded_pages(
    env: &TestEnvironmentHandle,
    app: &SHA256Hash,
    token: &SHA256Hash,
) {
    let a = pair(env, app, token);
    a.run(&alice(), |a| {
        let app = a.app();
        for amount in [i128::MIN, -1, 0, 1_000_001, i128::MAX] {
            for result in [
                app.try_send(&bob(), amount, &OP),
                app.try_request(&bob(), amount, &OP),
            ] {
                assert_eq!(
                    result.unwrap_err().try_as(),
                    Some(PaymentError::InvalidAmount)
                );
            }
        }
        assert_eq!(
            app.try_send(&alice(), 1, &OP).unwrap_err().try_as(),
            Some(PaymentError::InvalidParticipants)
        );
        assert_eq!(
            app.try_request(&outsider(), 1, &OP).unwrap_err().try_as(),
            Some(PaymentError::NotRegistered)
        );
        assert_eq!(app.profiles(0, 1), [alice()]);
        assert_eq!(app.profiles(1, 1), [bob()]);
        assert!(app.profiles(u64::MAX, PROFILE_PAGE).is_empty());
        for limit in [0, PROFILE_PAGE + 1] {
            assert_eq!(
                app.try_profiles(0, limit).unwrap_err().try_as(),
                Some(PaymentError::InvalidPage)
            );
        }
        for limit in [0, ACTIVITY_PAGE + 1] {
            assert_eq!(
                app.try_activity(&alice(), 0, limit).unwrap_err().try_as(),
                Some(PaymentError::InvalidPage)
            );
        }
        assert!(app.activity(&alice(), u64::MAX, 1).is_empty());
        assert_eq!(app.entry(&alice(), &OP), None);
    });
    a.run(&outsider(), |a| {
        assert_eq!(
            a.app().try_request(&alice(), 1, &OP).unwrap_err().try_as(),
            Some(PaymentError::NotRegistered)
        );
    });
}

pub fn activity_cursor_is_stable(
    env: &TestEnvironmentHandle,
    app: &SHA256Hash,
    token: &SHA256Hash,
) {
    let a = pair(env, app, token);
    let count = ACTIVITY_PAGE as u8 + 2;
    a.run(&alice(), |a| {
        for i in 0..count {
            a.app().request(&bob(), 1, &op(i));
        }
    });
    a.next_block();
    let mut first = Vec::new();
    a.run(&bob(), |a| {
        first = a.app().activity(&bob(), count.into(), ACTIVITY_PAGE)
    });
    // A new record lands between the two page reads.
    a.run(&bob(), |a| a.app().request(&alice(), 1, &OP));
    a.next_block();
    a.run(&bob(), |a| {
        let app = a.app();
        let before = count as u64 - ACTIVITY_PAGE;
        let second = app.activity(&bob(), before, ACTIVITY_PAGE);
        let ops: Vec<_> = first.iter().chain(&second).map(|e| e.operation).collect();
        assert_eq!(ops, (0..count).rev().map(op).collect::<Vec<_>>());
        assert_eq!(app.activity_count(&bob()), count as u64 + 1);
        assert_eq!(app.activity(&bob(), count as u64 + 1, 1)[0].operation, OP);
    });
}

pub fn full_pages_fit_the_return_buffer(
    env: &TestEnvironmentHandle,
    app: &SHA256Hash,
    token: &SHA256Hash,
) {
    let a = deploy(env, app, token);
    let accounts: Vec<_> = (0..PROFILE_PAGE)
        .map(|i| ContractAddress::named(&format!("account-{i}")))
        .collect();
    // A directory push takes an exclusive lock, so one registration lands per block.
    for account in &accounts {
        a.register(account);
    }
    a.run(&accounts[0], |a| {
        for i in 0..ACTIVITY_PAGE as u8 {
            a.app()
                .request(&accounts[1], MAX_AMOUNT, &SHA256Hash::new([0xff - i; 32]));
        }
    });
    a.next_block();
    a.run(&accounts[0], |a| {
        assert_eq!(a.app().profiles(0, PROFILE_PAGE), accounts);
        assert_eq!(
            a.app()
                .activity(&accounts[0], ACTIVITY_PAGE, ACTIVITY_PAGE)
                .len() as u64,
            ACTIVITY_PAGE
        );
    });
}

/// The credits token's own rules: limits, delegated spending, expiry, and metadata.
pub fn credits_follow_the_token_rules(
    env: &TestEnvironmentHandle,
    app: &SHA256Hash,
    token: &SHA256Hash,
) {
    let a = pair(env, app, token);
    a.run(&alice(), |a| {
        let credits = a.credits();
        assert_eq!(ERC20MetadataClient::new(&a.token).decimals(), Some(0));
        assert_eq!(credits.total_supply(), 200);
        assert_eq!(
            credits.try_transfer(&bob(), 101).unwrap_err().try_as(),
            Some(ERC20Error::TooLarge)
        );
        assert_eq!(
            credits.try_delete_balance().unwrap_err().try_as(),
            Some(ERC20Error::BalanceNotZero)
        );
        // Bob may spend 10 of Alice's credits through the next block.
        let until = thruput_sdk::block::get_block_height() + 1;
        ERC20AllowanceExpiryClient::new(&a.token).reset_allowance(&bob(), until);
        credits.adjust_allowance(&bob(), 10);
        assert_eq!(credits.allowance(&alice(), &bob()), 10);
    });
    a.next_block();
    a.run(&bob(), |a| {
        let credits = a.credits();
        credits.transfer_from(&alice(), &outsider(), 4);
        assert_eq!(credits.allowance(&alice(), &bob()), 6);
        assert_eq!(
            credits
                .try_transfer_from(&alice(), &outsider(), 7)
                .unwrap_err()
                .try_as(),
            Some(ERC20Error::TooLarge)
        );
    });
    a.next_block();
    a.next_block();
    a.run(&bob(), |a| {
        let credits = a.credits();
        // The allowance has expired, so it reads zero and cannot be spent.
        assert_eq!(credits.allowance(&alice(), &bob()), 0);
        assert_eq!(
            credits
                .try_transfer_from(&alice(), &outsider(), 1)
                .unwrap_err()
                .try_as(),
            Some(ERC20Error::TooLarge)
        );
    });
    a.run(&alice(), |a| {
        let credits = a.credits();
        credits.delete_allowance(&bob());
        assert_eq!(credits.allowance(&alice(), &bob()), 0);
        assert_eq!(credits.get_balance(), 96);
        assert_eq!(credits.get_balance_of(&outsider()), 4);
    });
}

/// Registration, creation, and resolution each emit one PayMVC event.
pub fn events_describe_each_change(
    env: &TestEnvironmentHandle,
    app: &SHA256Hash,
    token: &SHA256Hash,
) {
    let a = deploy(env, app, token);
    let call = |caller: ContractAddress, body: &dyn Fn(&App)| {
        let result = env.transact(|tx| tx.call(&caller).run(AssertUnwindSafe(|| body(&a))));
        result.assert_success();
        env.advance_block();
        result
    };
    call(alice(), &|a| a.app().register()).assert_emitted::<Registered>(&a.address, |_| true);
    call(bob(), &|a| a.app().register()).assert_emitted::<Registered>(&a.address, |_| true);
    call(alice(), &|a| a.app().request(&bob(), 5, &OP))
        .assert_emitted::<Created>(&a.address, |_| true);
    call(bob(), &|a| a.app().decline(&alice(), &OP))
        .assert_emitted::<Resolved>(&a.address, |_| true);
}
