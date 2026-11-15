// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {PayMVC} from "../contracts/PayMVC.sol";

interface Vm {
    function startBroadcast() external;
    function stopBroadcast() external;
}

/// @notice Deploys PayMVC, which creates its DemoCredits token. The same script deploys to Anvil.
/// @dev The signer comes from the command line, for example `--private-key`, so `--resume` can
/// rebroadcast the saved transactions without running the script again.
contract Deploy {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function run() external returns (PayMVC app) {
        vm.startBroadcast();
        app = new PayMVC();
        vm.stopBroadcast();
    }
}
