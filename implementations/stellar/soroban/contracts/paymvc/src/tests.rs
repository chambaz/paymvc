use super::*;
use soroban_sdk::{
    Event, IntoVal,
    testutils::{
        Address as _, Events, Ledger, MockAuth, MockAuthInvoke,
        storage::{Instance, Persistent},
    },
};

struct Demo {
    env: Env,
    app: Address,
    token: Address,
    users: [Address; 6],
}

impl Demo {
    fn new() -> Self {
        let env = Env::default();
        let hash = env.deployer().upload_contract_wasm(
            include_bytes!("../../../target/wasm32v1-none/release/demo_credits.wasm").as_slice(),
        );
        let app = env.register(PayMVC, (hash,));
        let token = PayMVCClient::new(&env, &app).token();
        let users = core::array::from_fn(|_| Address::generate(&env));
        Self {
            env,
            app,
            token,
            users,
        }
    }
    fn client(&self) -> PayMVCClient<'_> {
        PayMVCClient::new(&self.env, &self.app)
    }
    fn credits(&self) -> token::Client<'_> {
        token::Client::new(&self.env, &self.token)
    }
    fn op(&self, n: u8) -> BytesN<32> {
        BytesN::from_array(&self.env, &[n; 32])
    }
    fn register(&self) {
        self.env.mock_all_auths();
        for owner in &self.users {
            self.client().register(owner);
        }
    }
    fn state(&self, from: &Address, n: u8) -> State {
        self.client().entry(from, &self.op(n)).unwrap().state
    }
}

#[test]
fn registration_requires_owner_authorization() {
    let d = Demo::new();
    assert!(d.client().try_register(&d.users[0]).is_err());
    assert_eq!(d.client().profile_count(), 0);
    d.client()
        .mock_auths(&[MockAuth {
            address: &d.users[0],
            invoke: &MockAuthInvoke {
                contract: &d.app,
                fn_name: "register",
                args: (&d.users[0],).into_val(&d.env),
                sub_invokes: &[],
            },
        }])
        .register(&d.users[0]);
    assert_eq!(d.credits().balance(&d.users[0]), 100);
    assert!(d.client().registered(&d.users[0]));
}

#[test]
fn registration_cannot_allocate_twice() {
    let d = Demo::new();
    d.register();
    assert_eq!(
        d.client().try_register(&d.users[0]),
        Err(Ok(Error::AlreadyRegistered.into()))
    );
    assert_eq!(d.credits().balance(&d.users[0]), 100);
    assert_eq!(d.client().profile_count(), 6);
    assert_eq!(d.client().activity_count(&d.users[0]), 0);
}

#[test]
fn canonical_scenario_uses_real_balances_and_keeps_request_position() {
    let d = Demo::new();
    d.register();
    let c = d.client();
    let u = &d.users;
    c.send(&u[0], &u[1], &7, &d.op(1));
    assert_eq!(d.credits().balance(&u[0]), 93);
    c.request(&u[1], &u[0], &20, &d.op(2));
    c.approve(&u[0], &u[1], &d.op(2));
    c.request(&u[1], &u[0], &5, &d.op(3));
    c.decline(&u[0], &u[1], &d.op(3));
    c.request(&u[0], &u[1], &9, &d.op(4));
    c.approve(&u[1], &u[0], &d.op(4));
    d.credits().transfer(&u[1], &u[0], &3);
    assert_eq!(d.credits().balance(&u[0]), 85);
    assert_eq!(d.credits().balance(&u[1]), 115);
    assert_eq!(c.activity_count(&u[0]), 4);
    assert_eq!(c.activity_count(&u[1]), 4);
    let rows = c.activity(&u[0], &4, &50);
    assert_eq!(rows.len(), 4);
    assert_eq!(rows.get(0).unwrap().operation, d.op(4));
    assert_eq!(rows.get(1).unwrap().state, State::Declined);
    assert_eq!(rows.get(2).unwrap().state, State::Paid);
    assert_eq!(rows.get(2).unwrap().kind, Kind::Request);
    assert_eq!(rows.get(3).unwrap().kind, Kind::Transfer);
    assert_eq!(
        u.iter()
            .map(|owner| d.credits().balance(owner))
            .sum::<i128>(),
        600
    );
}

#[test]
fn entry_lookup_is_absent_then_present() {
    let d = Demo::new();
    d.register();
    let c = d.client();
    let u = &d.users;
    assert_eq!(c.entry(&u[0], &d.op(1)), None);
    c.request(&u[0], &u[1], &12, &d.op(1));
    assert_eq!(
        c.entry(&u[0], &d.op(1)),
        Some(Entry {
            from: u[0].clone(),
            to: u[1].clone(),
            operation: d.op(1),
            amount: 12,
            kind: Kind::Request,
            state: State::Pending,
        })
    );
    // The key is (from, operation): the same operation from the payer is a different entry.
    assert_eq!(c.entry(&u[1], &d.op(1)), None);
}

#[test]
fn every_canonical_error() {
    let d = Demo::new();
    let c = d.client();
    let u = &d.users;
    d.env.mock_all_auths();
    let stranger = Address::generate(&d.env);
    c.register(&u[0]);
    c.register(&u[1]);
    c.register(&u[2]);
    assert_eq!(
        c.try_register(&u[0]),
        Err(Ok(Error::AlreadyRegistered.into()))
    );
    assert_eq!(
        c.try_send(&u[0], &stranger, &1, &d.op(1)),
        Err(Ok(Error::NotRegistered.into()))
    );
    assert_eq!(
        c.try_request(&stranger, &u[0], &1, &d.op(1)),
        Err(Ok(Error::NotRegistered.into()))
    );
    assert_eq!(
        c.try_send(&u[0], &u[0], &1, &d.op(1)),
        Err(Ok(Error::InvalidParticipants.into()))
    );
    for amount in [-1, 0, 1_000_001] {
        assert_eq!(
            c.try_send(&u[0], &u[1], &amount, &d.op(1)),
            Err(Ok(Error::InvalidAmount.into()))
        );
        assert_eq!(
            c.try_request(&u[0], &u[1], &amount, &d.op(1)),
            Err(Ok(Error::InvalidAmount.into()))
        );
    }
    assert_eq!(
        c.try_request(&u[0], &u[1], &1, &d.op(0)),
        Err(Ok(Error::InvalidOperation.into()))
    );
    c.request(&u[0], &u[1], &1, &d.op(1));
    assert_eq!(
        c.try_send(&u[0], &u[1], &1, &d.op(1)),
        Err(Ok(Error::OperationUsed.into()))
    );
    assert_eq!(
        c.try_approve(&u[1], &u[0], &d.op(9)),
        Err(Ok(Error::NotFound.into()))
    );
    assert_eq!(
        c.try_decline(&u[2], &u[0], &d.op(1)),
        Err(Ok(Error::Unauthorized.into()))
    );
    assert_eq!(
        c.try_approve(&u[0], &u[0], &d.op(1)),
        Err(Ok(Error::Unauthorized.into()))
    );
    c.decline(&u[1], &u[0], &d.op(1));
    assert_eq!(
        c.try_approve(&u[1], &u[0], &d.op(1)),
        Err(Ok(Error::NotPending.into()))
    );
    c.send(&u[0], &u[1], &1, &d.op(2));
    assert_eq!(
        c.try_approve(&u[1], &u[0], &d.op(2)),
        Err(Ok(Error::NotPending.into()))
    );
    for limit in [0, 51] {
        assert_eq!(
            c.try_profiles(&0, &limit),
            Err(Ok(Error::InvalidPage.into()))
        );
        assert_eq!(
            c.try_activity(&u[0], &u64::MAX, &limit),
            Err(Ok(Error::InvalidPage.into()))
        );
    }
}

#[test]
fn rejected_operations_leave_no_record() {
    let d = Demo::new();
    d.register();
    let c = d.client();
    let u = &d.users;
    assert!(c.try_send(&u[0], &u[1], &101, &d.op(1)).is_err());
    assert!(c.try_send(&u[0], &u[0], &1, &d.op(1)).is_err());
    assert_eq!(c.activity_count(&u[0]), 0);
    assert_eq!(c.entry(&u[0], &d.op(1)), None);
    assert_eq!(d.credits().balance(&u[0]), 100);
}

#[test]
fn replay_cannot_pay_twice() {
    let d = Demo::new();
    d.register();
    let c = d.client();
    let u = &d.users;
    c.send(&u[0], &u[1], &10, &d.op(1));
    assert_eq!(
        c.try_send(&u[0], &u[1], &10, &d.op(1)),
        Err(Ok(Error::OperationUsed.into()))
    );
    assert_eq!(
        c.try_request(&u[0], &u[1], &10, &d.op(1)),
        Err(Ok(Error::OperationUsed.into()))
    );
    assert_eq!(d.credits().balance(&u[0]), 90);
    assert_eq!(c.activity_count(&u[0]), 1);
}

#[test]
fn failed_approval_remains_pending_and_terminal_state_cannot_change() {
    let d = Demo::new();
    d.register();
    let c = d.client();
    let u = &d.users;
    c.request(&u[0], &u[1], &101, &d.op(1));
    assert!(c.try_approve(&u[1], &u[0], &d.op(1)).is_err());
    assert_eq!(d.state(&u[0], 1), State::Pending);
    c.decline(&u[1], &u[0], &d.op(1));
    assert_eq!(d.state(&u[0], 1), State::Declined);
    assert_eq!(
        c.try_decline(&u[1], &u[0], &d.op(1)),
        Err(Ok(Error::NotPending.into()))
    );
    c.request(&u[0], &u[1], &5, &d.op(2));
    c.approve(&u[1], &u[0], &d.op(2));
    assert_eq!(
        c.try_decline(&u[1], &u[0], &d.op(2)),
        Err(Ok(Error::NotPending.into()))
    );
    assert_eq!(d.credits().balance(&u[0]), 105);
    assert_eq!(d.credits().balance(&u[1]), 95);
}

#[test]
fn decline_moves_no_credits_and_works_with_an_empty_balance() {
    let d = Demo::new();
    d.register();
    let c = d.client();
    let u = &d.users;
    c.request(&u[0], &u[1], &10, &d.op(1));
    // The payer moves every credit away, outside the app.
    d.credits().transfer(&u[1], &u[2], &100);
    c.decline(&u[1], &u[0], &d.op(1));
    assert_eq!(d.state(&u[0], 1), State::Declined);
    assert_eq!(d.credits().balance(&u[0]), 100);
    assert_eq!(d.credits().balance(&u[1]), 0);
}

#[test]
fn another_signer_cannot_send_approve_or_decline_for_the_payer() {
    let d = Demo::new();
    d.register();
    d.client().request(&d.users[0], &d.users[1], &10, &d.op(1));
    d.env.mock_auths(&[]);
    assert!(
        d.client()
            .try_send(&d.users[1], &d.users[0], &10, &d.op(2))
            .is_err()
    );
    // The requester signs, but names the payer as the resolver.
    let args = (&d.users[1], &d.users[0], d.op(1));
    let invoke = |fn_name| MockAuthInvoke {
        contract: &d.app,
        fn_name,
        args: args.into_val(&d.env),
        sub_invokes: &[],
    };
    let (approve, decline) = (invoke("approve"), invoke("decline"));
    let signed = |invoke| {
        [MockAuth {
            address: &d.users[0],
            invoke,
        }]
    };
    assert!(
        d.client()
            .mock_auths(&signed(&approve))
            .try_approve(&d.users[1], &d.users[0], &d.op(1))
            .is_err()
    );
    assert!(
        d.client()
            .mock_auths(&signed(&decline))
            .try_decline(&d.users[1], &d.users[0], &d.op(1))
            .is_err()
    );
    assert_eq!(d.state(&d.users[0], 1), State::Pending);
    assert_eq!(d.credits().balance(&d.users[1]), 100);
}

#[test]
fn users_cannot_call_the_app_only_mint() {
    let d = Demo::new();
    d.register();
    d.env.mock_auths(&[]);
    assert!(
        demo_credits::CreditsClient::new(&d.env, &d.token)
            .try_mint(&d.users[0], &100)
            .is_err()
    );
    assert_eq!(d.credits().balance(&d.users[0]), 100);
}

#[test]
fn directory_pages_are_bounded_and_stable_after_registration() {
    let d = Demo::new();
    d.register();
    let c = d.client();
    let first = c.profiles(&0, &5);
    assert_eq!(first.len(), 5);
    for index in 0..5 {
        assert_eq!(first.get(index).unwrap(), d.users[index as usize]);
    }
    let other = Address::generate(&d.env);
    c.register(&other);
    let second = c.profiles(&5, &5);
    assert_eq!(second.len(), 2);
    assert_eq!(second.get(0).unwrap(), d.users[5]);
    assert_eq!(second.get(1).unwrap(), other);
    assert!(c.profiles(&u64::MAX, &50).is_empty());
}

#[test]
fn external_transfer_does_not_require_profiles_or_add_activity() {
    let d = Demo::new();
    d.register();
    let stranger = Address::generate(&d.env);
    d.credits().transfer(&d.users[0], &stranger, &3);
    assert_eq!(d.credits().balance(&stranger), 3);
    assert_eq!(d.client().activity_count(&d.users[0]), 0);
    assert!(!d.client().registered(&stranger));
}

#[test]
fn activity_pages_are_newest_first() {
    let d = Demo::new();
    d.register();
    d.env.cost_estimate().budget().reset_unlimited();
    for n in 1..=55 {
        d.client().request(&d.users[0], &d.users[1], &1, &d.op(n));
    }
    let c = d.client();
    // A full page must fit the default per-call budget that the network enforces.
    d.env.cost_estimate().budget().reset_default();
    let first = c.activity(&d.users[0], &55, &50);
    let second = c.activity(&d.users[0], &5, &50);
    assert_eq!(first.len(), 50);
    assert_eq!(second.len(), 5);
    assert_eq!(first.get(0).unwrap().operation, d.op(55));
    assert_eq!(first.get(49).unwrap().operation, d.op(6));
    assert_eq!(second.get(0).unwrap().operation, d.op(5));
    assert_eq!(second.get(4).unwrap().operation, d.op(1));
    assert!(c.activity(&d.users[0], &0, &50).is_empty());
    // A cursor past the end starts at the newest entry.
    assert_eq!(
        c.activity(&d.users[0], &u64::MAX, &1)
            .get(0)
            .unwrap()
            .operation,
        d.op(55)
    );
}

#[test]
fn activity_cursor_is_stable_when_a_record_lands_between_pages() {
    let d = Demo::new();
    d.register();
    let c = d.client();
    let u = &d.users;
    for n in 1..=4 {
        c.request(&u[0], &u[1], &1, &d.op(n));
    }
    let first = c.activity(&u[0], &c.activity_count(&u[0]), &2);
    assert_eq!(first.get(1).unwrap().operation, d.op(3));
    // A new record lands. The next page continues below the oldest row already read.
    c.send(&u[1], &u[0], &1, &d.op(5));
    let second = c.activity(&u[0], &2, &2);
    assert_eq!(second.len(), 2);
    assert_eq!(second.get(0).unwrap().operation, d.op(2));
    assert_eq!(second.get(1).unwrap().operation, d.op(1));
}

#[test]
fn every_write_extends_the_instance_lifetime() {
    let d = Demo::new();
    d.register();
    let c = d.client();
    let u = &d.users;
    let ttl = || {
        d.env
            .as_contract(&d.app, || d.env.storage().instance().get_ttl())
    };
    let full = ttl();
    let age = || {
        d.env
            .ledger()
            .with_mut(|ledger| ledger.sequence_number += full / 2 + 1);
        assert!(ttl() < full / 2);
    };
    age();
    c.request(&u[0], &u[1], &1, &d.op(1));
    assert_eq!(ttl(), full);
    age();
    c.decline(&u[1], &u[0], &d.op(1));
    assert_eq!(ttl(), full);
    age();
    c.send(&u[0], &u[1], &1, &d.op(2));
    assert_eq!(ttl(), full);
}

#[test]
fn distinct_operations_with_the_same_values_both_succeed() {
    let d = Demo::new();
    d.register();
    let c = d.client();
    c.request(&d.users[0], &d.users[1], &5, &d.op(1));
    c.request(&d.users[0], &d.users[1], &5, &d.op(2));
    c.send(&d.users[0], &d.users[1], &5, &d.op(3));
    c.send(&d.users[0], &d.users[1], &5, &d.op(4));
    assert_eq!(c.activity_count(&d.users[0]), 4);
    assert_eq!(d.credits().balance(&d.users[1]), 110);
}

#[test]
fn events_describe_each_change() {
    let d = Demo::new();
    d.register();
    let c = d.client();
    let (a, b) = (&d.users[0], &d.users[1]);
    c.request(a, b, &20, &d.op(1));
    assert_eq!(
        d.env.events().all().filter_by_contract(&d.app),
        [Created {
            from: a.clone(),
            to: b.clone(),
            operation: d.op(1),
            amount: 20,
            kind: Kind::Request,
        }
        .to_xdr(&d.env, &d.app)]
    );
    c.decline(b, a, &d.op(1));
    assert_eq!(
        d.env.events().all().filter_by_contract(&d.app),
        [Resolved {
            from: a.clone(),
            operation: d.op(1),
            state: State::Declined,
        }
        .to_xdr(&d.env, &d.app)]
    );
    let newcomer = Address::generate(&d.env);
    c.register(&newcomer);
    assert_eq!(
        d.env.events().all().filter_by_contract(&d.app),
        [Registered { account: newcomer }.to_xdr(&d.env, &d.app)]
    );
}

#[test]
fn payments_keep_both_profiles_and_their_records_live() {
    let d = Demo::new();
    d.register();
    let (a, b) = (&d.users[0], &d.users[1]);
    let ttl = |key: &Key| {
        d.env
            .as_contract(&d.app, || d.env.storage().persistent().get_ttl(key))
    };
    let start = ttl(&Key::Profile(b.clone()));
    // Time passes without any write to B's profile.
    d.env
        .ledger()
        .with_mut(|ledger| ledger.sequence_number += TTL / 2 + 1);
    assert!(ttl(&Key::Profile(b.clone())) < start);
    d.client().send(a, b, &1, &d.op(1));
    assert!(ttl(&Key::Profile(b.clone())) >= TTL / 2);
    assert!(ttl(&Key::Profile(a.clone())) >= TTL / 2);
    assert!(ttl(&Key::Entry(a.clone(), d.op(1))) >= TTL / 2);
    assert!(ttl(&Key::Activity(b.clone(), 0)) >= TTL / 2);
}
