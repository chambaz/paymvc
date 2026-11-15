#[test_only]
module paymvc::paymvc_tests {
    use std::bcs;
    use std::option;
    use std::signer;
    use aptos_framework::account;
    use aptos_framework::primary_fungible_store;
    use paymvc::credits::metadata;
    use paymvc::paymvc::{
        Self, activity, activity_count, approve, decline, entry, profile_count, profiles,
        register, registered, request, send
    };

    fun balance(owner: address): u64 {
        primary_fungible_store::balance(owner, metadata())
    }

    /// A nonzero 32-byte operation ID.
    fun op(n: u8): vector<u8> {
        bcs::to_bytes(&(n as u256))
    }

    fun setup(publisher: &signer, a: &signer, b: &signer) {
        account::create_account_for_test(signer::address_of(publisher));
        account::create_account_for_test(signer::address_of(a));
        account::create_account_for_test(signer::address_of(b));
        paymvc::init_for_test(publisher);
        register(a);
        register(b);
    }

    #[test(publisher = @paymvc, a = @0xa, b = @0xb)]
    fun canonical(publisher: &signer, a: &signer, b: &signer) {
        setup(publisher, a, b);
        assert!(balance(@0xa) == 100 && balance(@0xb) == 100);
        send(a, @0xb, 7, op(1));
        assert!(balance(@0xa) == 93 && balance(@0xb) == 107);
        request(b, @0xa, 20, op(1));
        approve(a, @0xb, op(1));
        assert!(balance(@0xa) == 73 && balance(@0xb) == 127);
        request(b, @0xa, 5, op(2));
        decline(a, @0xb, op(2));
        assert!(balance(@0xa) == 73 && balance(@0xb) == 127);
        request(a, @0xb, 9, op(2));
        approve(b, @0xa, op(2));
        assert!(balance(@0xa) == 82 && balance(@0xb) == 118);
        primary_fungible_store::transfer(b, metadata(), @0xa, 3);
        assert!(balance(@0xa) == 85 && balance(@0xb) == 115);
        assert!(activity_count(@0xa) == 4 && activity_count(@0xb) == 4);
        assert!(paymvc::is_paid(option::borrow(&entry(@0xb, op(1)))));
        assert!(paymvc::is_declined(option::borrow(&entry(@0xb, op(2)))));
    }

    #[test(publisher = @paymvc, a = @0xa, b = @0xb)]
    fun directory_pages_in_registration_order(publisher: &signer, a: &signer, b: &signer) {
        setup(publisher, a, b);
        assert!(profile_count() == 2);
        assert!(profiles(0, 1) == vector[@0xa]);
        assert!(profiles(1, 50) == vector[@0xb]);
        assert!(profiles(2, 5) == vector[]);
        assert!(registered(@0xa) && !registered(@0xc));
    }

    #[test(publisher = @paymvc, a = @0xa, b = @0xb)]
    fun entry_lookup(publisher: &signer, a: &signer, b: &signer) {
        setup(publisher, a, b);
        assert!(option::is_none(&entry(@0xa, op(1))));
        request(a, @0xb, 5, op(1));
        let found = option::destroy_some(entry(@0xa, op(1)));
        assert!(paymvc::is_request(&found) && paymvc::is_pending(&found));
        assert!(paymvc::amount(&found) == 5);
        // The key includes the creator, so the same operation ID from another account is separate.
        assert!(option::is_none(&entry(@0xb, op(1))));
    }

    #[test(publisher = @paymvc, a = @0xa, b = @0xb)]
    fun activity_cursor_is_stable(publisher: &signer, a: &signer, b: &signer) {
        setup(publisher, a, b);
        for (n in 1..4) send(a, @0xb, 1, op(n));
        let first = activity(@0xa, activity_count(@0xa), 2);
        assert!(first.length() == 2 && paymvc::operation(&first[0]) == op(3));
        // A new entry lands between pages. The next page starts at the absolute index.
        send(a, @0xb, 1, op(4));
        let next = activity(@0xa, 1, 2);
        assert!(next.length() == 1 && paymvc::operation(&next[0]) == op(1));
        assert!(activity(@0xa, 0, 50) == vector[]);
        assert!(activity(@0xa, 100, 50).length() == 4);
        assert!(activity(@0xc, 0, 50) == vector[]);
    }

    #[test(publisher = @paymvc, a = @0xa, b = @0xb)]
    fun request_reserves_no_funds_and_external_transfers_work(
        publisher: &signer, a: &signer, b: &signer
    ) {
        setup(publisher, a, b);
        request(a, @0xb, 1000000, op(1));
        primary_fungible_store::transfer(b, metadata(), @0xc, 100);
        assert!(balance(@0xb) == 0 && balance(@0xc) == 100);
        assert!(!registered(@0xc) && activity_count(@0xc) == 0);
        // Decline moves no funds, so a payer with no credits can still decline.
        decline(b, @0xa, op(1));
        assert!(paymvc::is_declined(option::borrow(&entry(@0xa, op(1)))));
        assert!(balance(@0xa) == 100 && balance(@0xb) == 0);
    }

    #[test(publisher = @paymvc, a = @0xa, b = @0xb)]
    #[expected_failure(abort_code = 1, location = paymvc::paymvc)]
    fun already_registered(publisher: &signer, a: &signer, b: &signer) {
        setup(publisher, a, b);
        register(a);
    }

    #[test(publisher = @paymvc, a = @0xa, b = @0xb, c = @0xc)]
    #[expected_failure(abort_code = 2, location = paymvc::paymvc)]
    fun unregistered_sender(publisher: &signer, a: &signer, b: &signer, c: &signer) {
        setup(publisher, a, b);
        request(c, @0xa, 1, op(1));
    }

    #[test(publisher = @paymvc, a = @0xa, b = @0xb)]
    #[expected_failure(abort_code = 2, location = paymvc::paymvc)]
    fun unregistered_recipient(publisher: &signer, a: &signer, b: &signer) {
        setup(publisher, a, b);
        send(a, @0xc, 1, op(1));
    }

    #[test(publisher = @paymvc, a = @0xa, b = @0xb)]
    #[expected_failure(abort_code = 3, location = paymvc::paymvc)]
    fun self_payment(publisher: &signer, a: &signer, b: &signer) {
        setup(publisher, a, b);
        send(a, @0xa, 1, op(1));
    }

    #[test(publisher = @paymvc, a = @0xa, b = @0xb)]
    #[expected_failure(abort_code = 4, location = paymvc::paymvc)]
    fun zero_amount(publisher: &signer, a: &signer, b: &signer) {
        setup(publisher, a, b);
        send(a, @0xb, 0, op(1));
    }

    #[test(publisher = @paymvc, a = @0xa, b = @0xb)]
    #[expected_failure(abort_code = 4, location = paymvc::paymvc)]
    fun excessive_amount(publisher: &signer, a: &signer, b: &signer) {
        setup(publisher, a, b);
        request(a, @0xb, 1000001, op(1));
    }

    #[test(publisher = @paymvc, a = @0xa, b = @0xb)]
    #[expected_failure(abort_code = 5, location = paymvc::paymvc)]
    fun zero_operation(publisher: &signer, a: &signer, b: &signer) {
        setup(publisher, a, b);
        send(a, @0xb, 1, op(0));
    }

    #[test(publisher = @paymvc, a = @0xa, b = @0xb)]
    #[expected_failure(abort_code = 5, location = paymvc::paymvc)]
    fun short_operation(publisher: &signer, a: &signer, b: &signer) {
        setup(publisher, a, b);
        request(a, @0xb, 1, vector[1u8]);
    }

    #[test(publisher = @paymvc, a = @0xa, b = @0xb)]
    #[expected_failure(abort_code = 6, location = paymvc::paymvc)]
    fun operation_used(publisher: &signer, a: &signer, b: &signer) {
        setup(publisher, a, b);
        send(a, @0xb, 5, op(1));
        request(a, @0xb, 5, op(1));
    }

    #[test(publisher = @paymvc, a = @0xa, b = @0xb)]
    #[expected_failure(abort_code = 7, location = paymvc::paymvc)]
    fun approve_missing(publisher: &signer, a: &signer, b: &signer) {
        setup(publisher, a, b);
        approve(b, @0xa, op(1));
    }

    #[test(publisher = @paymvc, a = @0xa, b = @0xb)]
    #[expected_failure(abort_code = 7, location = paymvc::paymvc)]
    fun decline_missing(publisher: &signer, a: &signer, b: &signer) {
        setup(publisher, a, b);
        decline(b, @0xa, op(1));
    }

    #[test(publisher = @paymvc, a = @0xa, b = @0xb)]
    #[expected_failure(abort_code = 8, location = paymvc::paymvc)]
    fun requester_cannot_approve(publisher: &signer, a: &signer, b: &signer) {
        setup(publisher, a, b);
        request(a, @0xb, 5, op(1));
        approve(a, @0xa, op(1));
    }

    #[test(publisher = @paymvc, a = @0xa, b = @0xb)]
    #[expected_failure(abort_code = 8, location = paymvc::paymvc)]
    fun stranger_cannot_decline(publisher: &signer, a: &signer, b: &signer) {
        setup(publisher, a, b);
        request(a, @0xb, 5, op(1));
        decline(publisher, @0xa, op(1));
    }

    #[test(publisher = @paymvc, a = @0xa, b = @0xb)]
    #[expected_failure(abort_code = 9, location = paymvc::paymvc)]
    fun paid_is_terminal(publisher: &signer, a: &signer, b: &signer) {
        setup(publisher, a, b);
        request(a, @0xb, 5, op(1));
        approve(b, @0xa, op(1));
        decline(b, @0xa, op(1));
    }

    #[test(publisher = @paymvc, a = @0xa, b = @0xb)]
    #[expected_failure(abort_code = 9, location = paymvc::paymvc)]
    fun declined_is_terminal(publisher: &signer, a: &signer, b: &signer) {
        setup(publisher, a, b);
        request(a, @0xb, 5, op(1));
        decline(b, @0xa, op(1));
        approve(b, @0xa, op(1));
    }

    #[test(publisher = @paymvc, a = @0xa, b = @0xb)]
    #[expected_failure(abort_code = 9, location = paymvc::paymvc)]
    fun transfer_cannot_be_approved(publisher: &signer, a: &signer, b: &signer) {
        setup(publisher, a, b);
        send(a, @0xb, 5, op(1));
        approve(b, @0xa, op(1));
    }

    #[test(publisher = @paymvc, a = @0xa, b = @0xb)]
    #[expected_failure(abort_code = 10, location = paymvc::paymvc)]
    fun empty_profile_page(publisher: &signer, a: &signer, b: &signer) {
        setup(publisher, a, b);
        profiles(0, 0);
    }

    #[test(publisher = @paymvc, a = @0xa, b = @0xb)]
    #[expected_failure(abort_code = 10, location = paymvc::paymvc)]
    fun oversized_profile_page(publisher: &signer, a: &signer, b: &signer) {
        setup(publisher, a, b);
        profiles(0, 51);
    }

    #[test(publisher = @paymvc, a = @0xa, b = @0xb)]
    #[expected_failure(abort_code = 10, location = paymvc::paymvc)]
    fun oversized_activity_page(publisher: &signer, a: &signer, b: &signer) {
        setup(publisher, a, b);
        activity(@0xa, 0, 51);
    }

    #[test(publisher = @paymvc, a = @0xa, b = @0xb)]
    #[expected_failure(abort_code = 65540, location = aptos_framework::fungible_asset)]
    fun insufficient_send(publisher: &signer, a: &signer, b: &signer) {
        setup(publisher, a, b);
        send(a, @0xb, 101, op(1));
    }

    #[test(publisher = @paymvc, a = @0xa, b = @0xb)]
    #[expected_failure(abort_code = 65540, location = aptos_framework::fungible_asset)]
    fun insufficient_approval(publisher: &signer, a: &signer, b: &signer) {
        setup(publisher, a, b);
        request(a, @0xb, 101, op(1));
        approve(b, @0xa, op(1));
    }
}
