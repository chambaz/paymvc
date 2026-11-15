// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {PayMVC} from "../contracts/PayMVC.sol";
import {DemoCredits} from "../contracts/DemoCredits.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";

interface Vm {
    function addr(uint256 key) external pure returns (address);
    function sign(uint256 key, bytes32 digest) external pure returns (uint8, bytes32, bytes32);
    function prank(address) external;
    function startPrank(address) external;
    function stopPrank() external;
    function expectRevert(bytes4) external;
    function expectRevert(bytes calldata) external;
}

contract PayMVCTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    bytes32 constant PERMIT_TYPEHASH = keccak256(
        "Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"
    );
    uint256 constant ALICE = 0xa11ce;
    uint256 constant BOB = 0xb0b;
    PayMVC app;
    DemoCredits token;
    address alice = vm.addr(ALICE);
    address bob = vm.addr(BOB);
    address outsider = address(0xbad);
    bytes32 constant OP1 = bytes32(uint256(1));
    bytes32 constant OP2 = bytes32(uint256(2));
    bytes32 constant OP3 = bytes32(uint256(3));

    function setUp() public {
        app = new PayMVC();
        token = app.token();
        vm.prank(alice);
        app.register();
        vm.prank(bob);
        app.register();
    }

    /// @dev Signs an EIP-2612 permit for the app to spend `amount` of the signer's credits.
    function permit(uint256 key, uint256 amount) internal view returns (uint8, bytes32, bytes32) {
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

    function send(uint256 key, address to, uint256 amount, bytes32 operation) internal {
        (uint8 v, bytes32 r, bytes32 s) = permit(key, amount);
        vm.prank(vm.addr(key));
        app.send(to, amount, operation, type(uint256).max, v, r, s);
    }

    function approve(uint256 key, address from, bytes32 operation, uint256 amount) internal {
        (uint8 v, bytes32 r, bytes32 s) = permit(key, amount);
        vm.prank(vm.addr(key));
        app.approve(from, operation, type(uint256).max, v, r, s);
    }

    function testRegistrationAndMintAuthority() public {
        require(token.balanceOf(alice) == 100 && token.decimals() == 0);
        vm.expectRevert(PayMVC.AlreadyRegistered.selector);
        vm.prank(alice);
        app.register();
        vm.expectRevert(DemoCredits.OnlyMinter.selector);
        token.allocate(outsider);
        require(token.totalSupply() == 200);
    }

    function testFuzzTransferConserves(uint256 raw) public {
        uint256 amount = raw % 100 + 1;
        send(ALICE, bob, amount, OP1);
        require(token.balanceOf(alice) == 100 - amount);
        require(token.balanceOf(bob) == 100 + amount);
        require(token.totalSupply() == 200);
        require(token.allowance(alice, address(app)) == 0);
    }

    function testSendCreatesPaidTransferInOneCall() public {
        send(ALICE, bob, 7, OP1);
        PayMVC.Entry memory entry = app.entry(alice, OP1);
        require(entry.from == alice && entry.to == bob && entry.operation == OP1);
        require(entry.amount == 7 && entry.kind == PayMVC.Kind.Transfer);
        require(entry.state == PayMVC.State.Paid);
        require(token.nonces(alice) == 1);
    }

    function testEntryLookup() public {
        vm.expectRevert(PayMVC.NotFound.selector);
        app.entry(alice, OP1);
        vm.prank(alice);
        app.request(bob, 5, OP1);
        require(app.entry(alice, OP1).state == PayMVC.State.Pending);
        // The key is the creator and the operation ID together.
        vm.expectRevert(PayMVC.NotFound.selector);
        app.entry(bob, OP1);
    }

    function testInsufficientTransferRollsBackEverything() public {
        (uint8 v, bytes32 r, bytes32 s) = permit(ALICE, 101);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, alice, 100, 101)
        );
        vm.prank(alice);
        app.send(bob, 101, OP1, type(uint256).max, v, r, s);
        vm.expectRevert(PayMVC.NotFound.selector);
        app.entry(alice, OP1);
        require(app.activityCount(alice) == 0 && token.balanceOf(alice) == 100);
        require(token.nonces(alice) == 0);
    }

    function testCanonicalValidationErrors() public {
        vm.startPrank(alice);
        vm.expectRevert(PayMVC.InvalidParticipants.selector);
        app.request(alice, 1, OP1);
        vm.expectRevert(PayMVC.NotRegistered.selector);
        app.request(outsider, 1, OP1);
        vm.expectRevert(PayMVC.InvalidAmount.selector);
        app.request(bob, 0, OP1);
        vm.expectRevert(PayMVC.InvalidAmount.selector);
        app.request(bob, 1_000_001, OP1);
        vm.expectRevert(PayMVC.InvalidOperation.selector);
        app.request(bob, 1, bytes32(0));
        vm.stopPrank();
        vm.expectRevert(PayMVC.NotRegistered.selector);
        vm.prank(outsider);
        app.request(bob, 1, OP1);
    }

    function testSendValidatesBeforePaying() public {
        (uint8 v, bytes32 r, bytes32 s) = permit(ALICE, 1);
        vm.startPrank(alice);
        vm.expectRevert(PayMVC.InvalidParticipants.selector);
        app.send(alice, 1, OP1, type(uint256).max, v, r, s);
        vm.expectRevert(PayMVC.NotRegistered.selector);
        app.send(outsider, 1, OP1, type(uint256).max, v, r, s);
        vm.stopPrank();
        require(token.balanceOf(alice) == 100);
    }

    function testReplayAndDistinctOperations() public {
        send(ALICE, bob, 10, OP1);
        (uint8 v, bytes32 r, bytes32 s) = permit(ALICE, 10);
        vm.expectRevert(PayMVC.OperationUsed.selector);
        vm.prank(alice);
        app.send(bob, 10, OP1, type(uint256).max, v, r, s);
        vm.startPrank(alice);
        app.request(bob, 20, OP2);
        app.request(bob, 20, OP3);
        vm.stopPrank();
        // Another creator can use the same operation ID.
        vm.prank(bob);
        app.request(alice, 1, OP1);
        require(app.activityCount(alice) == 4 && token.balanceOf(bob) == 110);
    }

    function testUsedPermitFallsBackToItsAllowance() public {
        (uint8 v, bytes32 r, bytes32 s) = permit(ALICE, 10);
        // Someone copies the permit from a pending transaction and submits it first.
        vm.prank(outsider);
        token.permit(alice, address(app), 10, type(uint256).max, v, r, s);
        vm.prank(alice);
        app.send(bob, 10, OP1, type(uint256).max, v, r, s);
        require(token.balanceOf(bob) == 110 && token.allowance(alice, address(app)) == 0);
    }

    function testPaymentNeedsAMatchingPermit() public {
        (uint8 v, bytes32 r, bytes32 s) = permit(ALICE, 5);
        vm.expectRevert(
            abi.encodeWithSelector(
                IERC20Errors.ERC20InsufficientAllowance.selector, address(app), 0, 10
            )
        );
        vm.prank(alice);
        app.send(bob, 10, OP1, type(uint256).max, v, r, s);
        // A permit signed by Alice cannot pay from Bob.
        vm.expectRevert(
            abi.encodeWithSelector(
                IERC20Errors.ERC20InsufficientAllowance.selector, address(app), 0, 5
            )
        );
        vm.prank(bob);
        app.send(alice, 5, OP1, type(uint256).max, v, r, s);
        require(token.balanceOf(alice) == 100 && token.balanceOf(bob) == 100);
    }

    function testApprovalAuthorizationAndAtomicity() public {
        vm.prank(alice);
        app.request(bob, 20, OP1);
        (uint8 v, bytes32 r, bytes32 s) = permit(ALICE, 20);
        vm.expectRevert(PayMVC.Unauthorized.selector);
        vm.prank(alice);
        app.approve(alice, OP1, type(uint256).max, v, r, s);
        approve(BOB, alice, OP1, 20);
        require(token.balanceOf(alice) == 120 && token.balanceOf(bob) == 80);
        require(app.entry(alice, OP1).state == PayMVC.State.Paid);
        (v, r, s) = permit(BOB, 20);
        vm.startPrank(bob);
        vm.expectRevert(PayMVC.NotPending.selector);
        app.approve(alice, OP1, type(uint256).max, v, r, s);
        vm.expectRevert(PayMVC.NotPending.selector);
        app.decline(alice, OP1);
        vm.expectRevert(PayMVC.NotFound.selector);
        app.approve(alice, OP2, type(uint256).max, v, r, s);
        vm.stopPrank();
        require(app.activityCount(bob) == 1);
    }

    function testTransferCannotBeApproved() public {
        send(ALICE, bob, 1, OP1);
        (uint8 v, bytes32 r, bytes32 s) = permit(BOB, 1);
        vm.expectRevert(PayMVC.NotPending.selector);
        vm.prank(bob);
        app.approve(alice, OP1, type(uint256).max, v, r, s);
    }

    function testInsufficientApprovalStaysPending() public {
        vm.prank(alice);
        app.request(bob, 101, OP1);
        (uint8 v, bytes32 r, bytes32 s) = permit(BOB, 101);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, bob, 100, 101)
        );
        vm.prank(bob);
        app.approve(alice, OP1, type(uint256).max, v, r, s);
        require(app.entry(alice, OP1).state == PayMVC.State.Pending);
        require(token.balanceOf(bob) == 100);
    }

    function testDeclineNeedsNoCreditsOrPermit() public {
        vm.prank(alice);
        app.request(bob, 20, OP1);
        vm.prank(bob);
        require(token.transfer(outsider, 100));
        vm.expectRevert(PayMVC.Unauthorized.selector);
        vm.prank(outsider);
        app.decline(alice, OP1);
        vm.expectRevert(PayMVC.NotFound.selector);
        vm.prank(bob);
        app.decline(alice, OP2);
        vm.prank(bob);
        app.decline(alice, OP1);
        require(app.entry(alice, OP1).state == PayMVC.State.Declined);
        require(token.balanceOf(alice) == 100 && token.balanceOf(bob) == 0);
        (uint8 v, bytes32 r, bytes32 s) = permit(BOB, 20);
        vm.expectRevert(PayMVC.NotPending.selector);
        vm.prank(bob);
        app.approve(alice, OP1, type(uint256).max, v, r, s);
    }

    function testExternalTransferNotInAppHistory() public {
        vm.prank(alice);
        require(token.transfer(outsider, 10));
        require(token.balanceOf(outsider) == 10);
        require(app.activityCount(alice) == 0);
    }

    function testActivityCursorIsStable() public {
        vm.startPrank(alice);
        app.request(bob, 1, OP1);
        app.request(bob, 2, OP2);
        vm.stopPrank();
        uint256 before = app.activityCount(bob);
        PayMVC.Entry[] memory page = app.activity(bob, before, 1);
        require(page.length == 1 && page[0].operation == OP2);
        // A new record lands between pages. The next page still continues from the cursor.
        vm.prank(alice);
        app.request(bob, 3, OP3);
        page = app.activity(bob, before - 1, 50);
        require(page.length == 1 && page[0].operation == OP1);
        page = app.activity(bob, type(uint256).max, 50);
        require(page.length == 3 && page[0].operation == OP3 && page[2].operation == OP1);
        require(app.activity(bob, 0, 50).length == 0);
        // A resolved request keeps its position.
        vm.prank(bob);
        app.decline(alice, OP1);
        page = app.activity(bob, 1, 50);
        require(page.length == 1 && page[0].state == PayMVC.State.Declined);
        vm.expectRevert(PayMVC.InvalidPage.selector);
        app.activity(bob, 3, 0);
        vm.expectRevert(PayMVC.InvalidPage.selector);
        app.activity(bob, 3, 51);
    }

    function testDirectoryRegistrationIsAtomicAndUnique() public {
        vm.prank(outsider);
        app.register();
        require(token.balanceOf(outsider) == 100);
        require(app.registered(outsider));
        require(app.profileCount() == 3);
        vm.expectRevert(PayMVC.AlreadyRegistered.selector);
        vm.prank(outsider);
        app.register();
        require(app.profileCount() == 3 && token.totalSupply() == 300);
        require(app.activityCount(outsider) == 0);
    }

    function testDirectoryBoundedStablePages() public {
        for (uint160 i = 1; i <= 7; i++) {
            vm.prank(address(i));
            app.register();
        }
        address[] memory page = app.profiles(0, 5);
        require(page.length == 5 && page[0] == alice && page[1] == bob);
        vm.prank(outsider);
        app.register();
        page = app.profiles(5, 5);
        require(page.length == 5 && page[0] == address(4) && page[4] == outsider);
        require(app.profiles(10, 5).length == 0);
        require(app.profiles(type(uint256).max, 5).length == 0);
        vm.expectRevert(PayMVC.InvalidPage.selector);
        app.profiles(0, 0);
        vm.expectRevert(PayMVC.InvalidPage.selector);
        app.profiles(0, 51);
    }
}
