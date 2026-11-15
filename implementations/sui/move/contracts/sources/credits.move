/// The PayMVC demo credit: a standard zero-decimal `Coin<CREDITS>`.
module paymvc::credits;

use sui::coin_registry;

public struct CREDITS has drop {}

/// Create the currency and move its mint capability into the one shared app.
fun init(witness: CREDITS, ctx: &mut TxContext) {
    let (currency, treasury) = coin_registry::new_currency_with_otw(
        witness, 0, b"PAY".to_string(), b"PayMVC credits".to_string(),
        b"Testnet demo credits".to_string(), b"".to_string(), ctx,
    );
    coin_registry::finalize_and_delete_metadata_cap(currency, ctx);
    paymvc::paymvc::create(treasury, ctx);
}

#[test_only]
public fun init_for_testing(ctx: &mut TxContext) { init(CREDITS {}, ctx) }
