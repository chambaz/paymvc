// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/// @notice Test-only ERC-20 with EIP-2612 permits. Only the immutable PayMVC contract can allocate credits.
contract DemoCredits is ERC20Permit {
    address public immutable minter;
    error OnlyMinter();

    constructor() ERC20("PayMVC Demo Credits", "DEMO") ERC20Permit("PayMVC Demo Credits") {
        minter = msg.sender;
    }

    function decimals() public pure override returns (uint8) {
        return 0;
    }

    function allocate(address account) external {
        if (msg.sender != minter) revert OnlyMinter();
        _mint(account, 100);
    }
}
