#[test_only]
module paymvc::paymvc_tests;

use paymvc::credits::{Self, CREDITS};
use paymvc::paymvc::{Self, App, new_entry};
use sui::coin::{Self, Coin};
use sui::test_scenario::{Self as scenario, Scenario};

const A: address = @0xa;
const B: address = @0xb;
const C: address = @0xc;

const PENDING: u8 = 0;
const PAID: u8 = 1;
const DECLINED: u8 = 2;

/// A 32-byte operation ID that ends in `n`.
fun op(n: u8): vector<u8> {
    let mut id = vector[];
    31u64.do!(|_| id.push_back(0));
    id.push_back(n);
    id
}

fun register(s: &mut Scenario, account: address) {
    s.next_tx(account);
    let mut app = s.take_shared<App<CREDITS>>();
    app.register(s.ctx());
    scenario::return_shared(app);
}

/// A and B are registered. The next transaction is from A.
fun setup(): Scenario {
    let mut s = scenario::begin(A);
    credits::init_for_testing(s.ctx());
    register(&mut s, A);
    register(&mut s, B);
    s.next_tx(A);
    s
}

/// A coin of `value` from the sender's credits. The change goes back to the sender.
fun pay(s: &mut Scenario, value: u64): Coin<CREDITS> {
    let sender = s.sender();
    let mut all = coin::zero<CREDITS>(s.ctx());
    s.ids_for_sender<Coin<CREDITS>>().do!(|id| all.join(s.take_from_sender_by_id(id)));
    let payment = all.split(value, s.ctx());
    transfer::public_transfer(all, sender);
    payment
}

fun balance(s: &mut Scenario, account: address): u64 {
    s.next_tx(account);
    let mut total = 0;
    s.ids_for_sender<Coin<CREDITS>>().do!(|id| {
        let coin = s.take_from_sender_by_id<Coin<CREDITS>>(id);
        total = total + coin.value();
        s.return_to_sender(coin);
    });
    total
}

fun send(s: &mut Scenario, from: address, to: address, operation: u8, amount: u64) {
    s.next_tx(from);
    let mut app = s.take_shared<App<CREDITS>>();
    let payment = pay(s, amount);
    app.send(to, op(operation), payment, s.ctx());
    scenario::return_shared(app);
}

fun request(s: &mut Scenario, from: address, payer: address, operation: u8, amount: u64) {
    s.next_tx(from);
    let mut app = s.take_shared<App<CREDITS>>();
    app.request(payer, amount, op(operation), s.ctx());
    scenario::return_shared(app);
}

fun approve(s: &mut Scenario, payer: address, from: address, operation: u8, amount: u64) {
    s.next_tx(payer);
    let mut app = s.take_shared<App<CREDITS>>();
    let payment = pay(s, amount);
    app.approve(from, op(operation), payment, s.ctx());
    scenario::return_shared(app);
}

fun decline(s: &mut Scenario, payer: address, from: address, operation: u8) {
    s.next_tx(payer);
    let mut app = s.take_shared<App<CREDITS>>();
    app.decline(from, op(operation), s.ctx());
    scenario::return_shared(app);
}

#[test]
fun canonical_scenario_and_external_transfer() {
    let mut s = setup();
    send(&mut s, A, B, 1, 7);
    assert!(balance(&mut s, A) == 93 && balance(&mut s, B) == 107);
    request(&mut s, B, A, 1, 20);
    approve(&mut s, A, B, 1, 20);
    assert!(balance(&mut s, A) == 73 && balance(&mut s, B) == 127);
    request(&mut s, B, A, 2, 5);
    decline(&mut s, A, B, 2);
    request(&mut s, A, B, 2, 9);
    approve(&mut s, B, A, 2, 9);
    assert!(balance(&mut s, A) == 82 && balance(&mut s, B) == 118);

    // A plain coin transfer works outside the app and creates no activity.
    s.next_tx(B);
    let coin = pay(&mut s, 3);
    transfer::public_transfer(coin, A);
    assert!(balance(&mut s, A) == 85 && balance(&mut s, B) == 115);

    s.next_tx(A);
    let app = s.take_shared<App<CREDITS>>();
    assert!(app.profile_count() == 2);
    assert!(app.profiles(0, 1) == vector[A]);
    assert!(app.profiles(1, 50) == vector[B]);
    assert!(app.profiles(2, 50).is_empty());
    assert!(app.activity_count(A) == 4 && app.activity_count(B) == 4);
    assert!(app.activity(A, 4, 50) == vector[
        new_entry(A, B, op(2), 9, true, PAID),
        new_entry(B, A, op(2), 5, true, DECLINED),
        new_entry(B, A, op(1), 20, true, PAID),
        new_entry(A, B, op(1), 7, false, PAID),
    ]);
    assert!(app.activity(B, 4, 50) == app.activity(A, 4, 50));
    scenario::return_shared(app);
    s.end();
}

#[test]
fun entry_lookup_is_absent_then_present() {
    let mut s = setup();
    let app = s.take_shared<App<CREDITS>>();
    assert!(app.entry(B, op(1)).is_none());
    scenario::return_shared(app);
    request(&mut s, B, A, 1, 5);
    s.next_tx(A);
    let app = s.take_shared<App<CREDITS>>();
    assert!(app.entry(B, op(1)) == option::some(new_entry(B, A, op(1), 5, true, PENDING)));
    // The same operation ID from another account is a different entry.
    assert!(app.entry(A, op(1)).is_none());
    scenario::return_shared(app);
    s.end();
}

#[test]
fun activity_cursor_is_stable_when_a_record_lands_between_pages() {
    let mut s = setup();
    send(&mut s, A, B, 1, 1);
    send(&mut s, A, B, 2, 2);
    send(&mut s, A, B, 3, 3);
    s.next_tx(A);
    let app = s.take_shared<App<CREDITS>>();
    let before = app.activity_count(A);
    let first = app.activity(A, before, 2);
    assert!(first == vector[new_entry(A, B, op(3), 3, false, PAID), new_entry(A, B, op(2), 2, false, PAID)]);
    scenario::return_shared(app);
    send(&mut s, B, A, 1, 4);
    s.next_tx(A);
    let app = s.take_shared<App<CREDITS>>();
    assert!(app.activity(A, before - 2, 2) == vector[new_entry(A, B, op(1), 1, false, PAID)]);
    assert!(app.activity(A, 0, 2).is_empty());
    assert!(app.activity(A, 100, 1) == vector[new_entry(B, A, op(1), 4, false, PAID)]);
    scenario::return_shared(app);
    s.end();
}

#[test]
fun request_reserves_no_funds_and_decline_needs_no_coins() {
    let mut s = setup();
    // A gives all its credits to an unregistered account.
    s.next_tx(A);
    let coins = pay(&mut s, 100);
    transfer::public_transfer(coins, C);
    assert!(balance(&mut s, A) == 0 && balance(&mut s, C) == 100);
    request(&mut s, B, A, 1, 1_000_000);
    decline(&mut s, A, B, 1);
    s.next_tx(A);
    let app = s.take_shared<App<CREDITS>>();
    assert!(app.entry(B, op(1)) == option::some(new_entry(B, A, op(1), 1_000_000, true, DECLINED)));
    assert!(!app.registered(C) && app.activity_count(C) == 0);
    scenario::return_shared(app);
    s.end();
}

#[test, expected_failure(abort_code = paymvc::E_ALREADY_REGISTERED)]
fun registration_cannot_repeat() {
    let mut s = setup();
    register(&mut s, A);
    s.end();
}

#[test, expected_failure(abort_code = paymvc::E_NOT_REGISTERED)]
fun unregistered_sender_rejected() {
    let mut s = setup();
    s.next_tx(A);
    let coin = pay(&mut s, 5);
    transfer::public_transfer(coin, C);
    send(&mut s, C, A, 1, 5);
    s.end();
}

#[test, expected_failure(abort_code = paymvc::E_NOT_REGISTERED)]
fun unregistered_recipient_rejected() {
    let mut s = setup();
    request(&mut s, A, C, 1, 5);
    s.end();
}

#[test, expected_failure(abort_code = paymvc::E_INVALID_PARTICIPANTS)]
fun self_payment_rejected() {
    let mut s = setup();
    send(&mut s, A, A, 1, 5);
    s.end();
}

#[test, expected_failure(abort_code = paymvc::E_INVALID_AMOUNT)]
fun zero_coin_rejected() {
    let mut s = setup();
    send(&mut s, A, B, 1, 0);
    s.end();
}

#[test, expected_failure(abort_code = paymvc::E_INVALID_AMOUNT)]
fun zero_request_rejected() {
    let mut s = setup();
    request(&mut s, A, B, 1, 0);
    s.end();
}

#[test, expected_failure(abort_code = paymvc::E_INVALID_AMOUNT)]
fun excessive_request_rejected() {
    let mut s = setup();
    request(&mut s, A, B, 1, 1_000_001);
    s.end();
}

#[test, expected_failure(abort_code = paymvc::E_INVALID_AMOUNT)]
fun approval_requires_exact_coin() {
    let mut s = setup();
    request(&mut s, A, B, 1, 20);
    approve(&mut s, B, A, 1, 21);
    s.end();
}

#[test, expected_failure(abort_code = paymvc::E_INVALID_OPERATION)]
fun zero_operation_rejected() {
    let mut s = setup();
    request(&mut s, A, B, 0, 5);
    s.end();
}

#[test, expected_failure(abort_code = paymvc::E_INVALID_OPERATION)]
fun short_operation_rejected() {
    let mut s = setup();
    let mut app = s.take_shared<App<CREDITS>>();
    app.request(B, 5, x"01", s.ctx());
    scenario::return_shared(app);
    s.end();
}

#[test, expected_failure(abort_code = paymvc::E_OPERATION_USED)]
fun operation_cannot_be_reused() {
    let mut s = setup();
    request(&mut s, A, B, 1, 5);
    send(&mut s, A, B, 1, 5);
    s.end();
}

#[test, expected_failure(abort_code = paymvc::E_NOT_FOUND)]
fun missing_request_cannot_be_approved() {
    let mut s = setup();
    approve(&mut s, B, A, 1, 5);
    s.end();
}

#[test, expected_failure(abort_code = paymvc::E_NOT_FOUND)]
fun missing_request_cannot_be_declined() {
    let mut s = setup();
    decline(&mut s, B, A, 1);
    s.end();
}

#[test, expected_failure(abort_code = paymvc::E_UNAUTHORIZED)]
fun stranger_cannot_approve() {
    let mut s = setup();
    request(&mut s, A, B, 1, 5);
    register(&mut s, C);
    approve(&mut s, C, A, 1, 5);
    s.end();
}

#[test, expected_failure(abort_code = paymvc::E_UNAUTHORIZED)]
fun requester_cannot_approve() {
    let mut s = setup();
    request(&mut s, A, B, 1, 5);
    approve(&mut s, A, A, 1, 5);
    s.end();
}

#[test, expected_failure(abort_code = paymvc::E_UNAUTHORIZED)]
fun stranger_cannot_decline() {
    let mut s = setup();
    request(&mut s, A, B, 1, 5);
    decline(&mut s, C, A, 1);
    s.end();
}

#[test, expected_failure(abort_code = paymvc::E_NOT_PENDING)]
fun paid_request_cannot_be_declined() {
    let mut s = setup();
    request(&mut s, A, B, 1, 5);
    approve(&mut s, B, A, 1, 5);
    decline(&mut s, B, A, 1);
    s.end();
}

#[test, expected_failure(abort_code = paymvc::E_NOT_PENDING)]
fun declined_request_cannot_be_approved() {
    let mut s = setup();
    request(&mut s, A, B, 1, 5);
    decline(&mut s, B, A, 1);
    approve(&mut s, B, A, 1, 5);
    s.end();
}

#[test, expected_failure(abort_code = paymvc::E_NOT_PENDING)]
fun transfer_cannot_be_declined() {
    let mut s = setup();
    send(&mut s, A, B, 1, 5);
    decline(&mut s, B, A, 1);
    s.end();
}

#[test, expected_failure(abort_code = paymvc::E_INVALID_PAGE)]
fun oversized_directory_page_rejected() {
    let s = setup();
    let app = s.take_shared<App<CREDITS>>();
    app.profiles(0, 51);
    abort
}

#[test, expected_failure(abort_code = paymvc::E_INVALID_PAGE)]
fun empty_activity_page_rejected() {
    let s = setup();
    let app = s.take_shared<App<CREDITS>>();
    app.activity(A, 0, 0);
    abort
}
