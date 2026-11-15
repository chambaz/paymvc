mod common;

use std::path::PathBuf;
use thruput_sdk::*;

/// `thruput build` writes artifacts to the workspace's `target/thruput/`.
fn artifact(file_name: &str) -> PathBuf {
    std::env::var_os("CARGO_TARGET_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../target"))
        .join("thruput")
        .join(file_name)
}

macro_rules! scenario {
    ($name:ident) => {
        #[test]
        #[ignore = "requires RV32 builds — run via `npm run contracts:test`"]
        fn $name() {
            let env = TestEnvironment::no_cost();
            let app = env.setup_create_contract(&load_rv32_contract(artifact("paymvc.rv32a")));
            let token = env.setup_create_contract(&load_rv32_contract(artifact("credits.rv32a")));
            common::$name(&env, &app, &token);
        }
    };
}

scenario!(registration_is_atomic_and_once);
scenario!(payments_and_request_lifecycle);
scenario!(payments_need_the_payers_allowance);
scenario!(operation_ids_are_unique_per_sender);
scenario!(only_payer_can_resolve);
scenario!(same_block_resolutions_have_one_winner);
scenario!(insufficient_balance_keeps_request_pending);
scenario!(external_transfers_reach_unregistered_accounts);
scenario!(invalid_inputs_and_bounded_pages);
scenario!(activity_cursor_is_stable);
scenario!(full_pages_fit_the_return_buffer);
