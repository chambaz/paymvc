mod common;

use thruput_sdk::*;

macro_rules! scenario {
    ($name:ident) => {
        #[test]
        fn $name() {
            let env = TestEnvironment::no_cost();
            let app = paymvc::register_mock_contract(&env);
            let token = credits::register_mock_contract(&env);
            common::$name(&env, app.as_hash(), token.as_hash());
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
scenario!(credits_follow_the_token_rules);
scenario!(events_describe_each_change);
