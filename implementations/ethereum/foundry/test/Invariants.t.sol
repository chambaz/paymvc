// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {PayMVC} from "../contracts/PayMVC.sol";
import {DemoCredits} from "../contracts/DemoCredits.sol";
import {Vm} from "./PayMVC.t.sol";

/// @dev Calls PayMVC as four registered users with valid inputs. The fuzzer chooses the calls.
contract Handler {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    bytes32 constant PERMIT_TYPEHASH = keccak256(
        "Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"
    );

    struct Made {
        address from;
        bytes32 operation;
        PayMVC.State state;
    }

    PayMVC public immutable app;
    DemoCredits public immutable token;
    uint256[4] keys = [uint256(0xa11ce), 0xb0b, 0xca401, 0xd00d];
    address[4] public actors;
    /// @dev Every entry created, with the state it must have now.
    Made[] public made;
    uint256 operations;

    constructor(PayMVC app_) {
        app = app_;
        token = app_.token();
        for (uint256 i; i < keys.length; i++) {
            actors[i] = vm.addr(keys[i]);
            vm.prank(actors[i]);
            app.register();
        }
    }

    function madeCount() external view returns (uint256) {
        return made.length;
    }

    function send(uint256 from, uint256 to, uint256 amount) external {
        (uint256 key, address payer) = actor(from);
        (, address payee) = actor(to);
        uint256 balance = token.balanceOf(payer);
        if (payer == payee || balance == 0) return;
        amount = bound(amount, 1, balance);
        bytes32 operation = next();
        (uint8 v, bytes32 r, bytes32 s) = permit(key, amount);
        vm.prank(payer);
        app.send(payee, amount, operation, type(uint256).max, v, r, s);
        made.push(Made(payer, operation, PayMVC.State.Paid));
    }

    function request(uint256 from, uint256 to, uint256 amount) external {
        (, address requester) = actor(from);
        (, address payer) = actor(to);
        if (requester == payer) return;
        bytes32 operation = next();
        amount = bound(amount, 1, app.MAX_AMOUNT());
        vm.prank(requester);
        app.request(payer, amount, operation);
        made.push(Made(requester, operation, PayMVC.State.Pending));
    }

    function approve(uint256 index) external {
        (bool pending, uint256 i) = pendingRequest(index);
        if (!pending) return;
        Made storage target = made[i];
        PayMVC.Entry memory entry = app.entry(target.from, target.operation);
        if (token.balanceOf(entry.to) < entry.amount) return;
        (uint8 v, bytes32 r, bytes32 s) = permit(keyOf(entry.to), entry.amount);
        vm.prank(entry.to);
        app.approve(target.from, target.operation, type(uint256).max, v, r, s);
        target.state = PayMVC.State.Paid;
    }

    function decline(uint256 index) external {
        (bool pending, uint256 i) = pendingRequest(index);
        if (!pending) return;
        Made storage target = made[i];
        vm.prank(app.entry(target.from, target.operation).to);
        app.decline(target.from, target.operation);
        target.state = PayMVC.State.Declined;
    }

    /// @dev Tries to resolve a Paid or Declined entry. It must fail, so the state stays final.
    function resolveFinal(uint256 index, bool pay) external {
        if (made.length == 0) return;
        Made storage target = made[index % made.length];
        if (target.state == PayMVC.State.Pending) return;
        PayMVC.Entry memory entry = app.entry(target.from, target.operation);
        (uint8 v, bytes32 r, bytes32 s) = permit(keyOf(entry.to), entry.amount);
        vm.prank(entry.to);
        if (pay) {
            try app.approve(target.from, target.operation, type(uint256).max, v, r, s) {} catch {}
        } else {
            try app.decline(target.from, target.operation) {} catch {}
        }
    }

    /// @dev A direct token transfer outside PayMVC.
    function transfer(uint256 from, uint256 to, uint256 amount) external {
        (, address sender) = actor(from);
        (, address receiver) = actor(to);
        uint256 balance = token.balanceOf(sender);
        if (balance == 0) return;
        vm.prank(sender);
        require(token.transfer(receiver, bound(amount, 1, balance)));
    }

    /// @dev Transfers are created Paid, so a Pending entry is a request.
    function pendingRequest(uint256 index) private view returns (bool, uint256) {
        if (made.length == 0) return (false, 0);
        uint256 i = index % made.length;
        return (made[i].state == PayMVC.State.Pending, i);
    }

    function actor(uint256 seed) private view returns (uint256, address) {
        uint256 i = seed % keys.length;
        return (keys[i], actors[i]);
    }

    function keyOf(address account) private view returns (uint256) {
        for (uint256 i; i < keys.length; i++) {
            if (actors[i] == account) return keys[i];
        }
        revert();
    }

    function next() private returns (bytes32) {
        return bytes32(++operations);
    }

    function bound(uint256 value, uint256 low, uint256 high) private pure returns (uint256) {
        return low + value % (high - low + 1);
    }

    function permit(uint256 key, uint256 amount) private view returns (uint8, bytes32, bytes32) {
        address owner = vm.addr(key);
        bytes32 permitHash = keccak256(
            abi.encode(
                PERMIT_TYPEHASH, owner, address(app), amount, token.nonces(owner), type(uint256).max
            )
        );
        return
            vm.sign(
                key, keccak256(abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(), permitHash))
            );
    }
}

/// @notice Properties that hold after any sequence of valid calls.
contract PayMVCInvariantTest {
    PayMVC app;
    DemoCredits token;
    Handler handler;

    function setUp() public {
        app = new PayMVC();
        token = app.token();
        handler = new Handler(app);
    }

    /// @dev Read by forge: the fuzzer calls only the handler.
    function targetContracts() public view returns (address[] memory targets) {
        targets = new address[](1);
        targets[0] = address(handler);
    }

    function invariant_creditsExistOnlyFromRegistration() public view {
        require(token.totalSupply() == 100 * app.profileCount());
    }

    function invariant_paymentsConserveCredits() public view {
        uint256 total;
        for (uint256 i; i < 4; i++) {
            total += token.balanceOf(handler.actors(i));
        }
        require(total == token.totalSupply());
    }

    function invariant_directoryHoldsEachUserOnce() public view {
        address[] memory page = app.profiles(0, 50);
        require(page.length == 4);
        for (uint256 i; i < page.length; i++) {
            require(page[i] == handler.actors(i) && app.registered(page[i]));
        }
    }

    function invariant_finalStatesNeverChange() public view {
        for (uint256 i; i < handler.madeCount(); i++) {
            (address from, bytes32 operation, PayMVC.State state) = handler.made(i);
            require(app.entry(from, operation).state == state);
        }
    }

    function invariant_eachEntryIsInTwoHistories() public view {
        uint256 rows;
        for (uint256 i; i < 4; i++) {
            rows += app.activityCount(handler.actors(i));
        }
        require(rows == 2 * handler.madeCount());
    }
}
