/// PayMVC credits: a zero-decimal fungible asset in primary stores.
/// Only `paymvc::paymvc` can mint, and it mints only during registration.
module paymvc::credits {
    use std::option;
    use std::string;
    use aptos_framework::fungible_asset::{Self, Metadata, MintRef};
    use aptos_framework::object::{Self, Object};
    use aptos_framework::primary_fungible_store;

    friend paymvc::paymvc;

    const NAME: vector<u8> = b"PayMVC credits";

    struct Credits has key {
        metadata: Object<Metadata>,
        mint: MintRef,
    }

    fun init_module(publisher: &signer) {
        let constructor = object::create_named_object(publisher, NAME);
        primary_fungible_store::create_primary_store_enabled_fungible_asset(
            &constructor,
            option::none(),
            string::utf8(NAME),
            string::utf8(b"PAY"),
            0,
            string::utf8(b"https://paymvc.com/apple-touch-icon.png"),
            string::utf8(b"https://paymvc.com"),
        );
        move_to(publisher, Credits {
            metadata: object::object_from_constructor_ref(&constructor),
            mint: fungible_asset::generate_mint_ref(&constructor),
        });
    }

    /// Mint `amount` credits into the primary store of `to`.
    friend fun mint(to: address, amount: u64) acquires Credits {
        let credits = &Credits[@paymvc];
        primary_fungible_store::mint(&credits.mint, to, amount);
    }

    #[view]
    public fun metadata(): Object<Metadata> acquires Credits {
        Credits[@paymvc].metadata
    }

    #[test_only]
    public fun init_for_test(publisher: &signer) {
        init_module(publisher)
    }
}
