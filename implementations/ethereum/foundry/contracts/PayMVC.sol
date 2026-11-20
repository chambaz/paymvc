// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {DemoCredits} from "./DemoCredits.sol";
import {SafeERC20, IERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice A small payments application. Direct ERC-20 transfers remain independent of this ledger.
/// @dev Non-upgradeable, no owner, and no privileged debit or repeat-claim function.
contract PayMVC {
    using SafeERC20 for IERC20;

    uint256 public constant MAX_AMOUNT = 1_000_000;
    uint256 public constant MAX_PAGE = 50;

    enum Kind {
        Transfer,
        Request
    }
    enum State {
        Pending,
        Paid,
        Declined
    }

    struct Entry {
        address from; // sender for transfers; requester for requests
        address to; // recipient for transfers; intended payer for requests
        bytes32 operation;
        uint256 amount;
        Kind kind;
        State state;
    }

    /// @notice The location of an entry: its creator and operation ID.
    struct Key {
        address from;
        bytes32 operation;
    }

    /// @dev An entry in one storage slot. Its creator and operation ID are the mapping keys,
    /// and a zero `to` means that no entry exists.
    struct Record {
        address to;
        uint64 amount;
        Kind kind;
        State state;
    }

    DemoCredits public immutable token;
    mapping(address account => bool) public registered;
    address[] private directory;
    mapping(address from => mapping(bytes32 operation => Record)) private records;
    // Per-account indexes make history readable without an off-chain indexer.
    mapping(address account => Key[]) private history;

    event Registered(address indexed account);
    event Created(
        address indexed from,
        bytes32 indexed operation,
        address indexed to,
        uint256 amount,
        Kind kind
    );
    event Resolved(address indexed from, bytes32 indexed operation, State state);

    error AlreadyRegistered();
    error NotRegistered();
    error InvalidParticipants();
    error InvalidAmount();
    error InvalidOperation();
    error OperationUsed();
    error NotFound();
    error Unauthorized();
    error NotPending();
    error InvalidPage();

    constructor() {
        token = new DemoCredits();
    }

    function register() external {
        if (registered[msg.sender]) revert AlreadyRegistered();
        registered[msg.sender] = true;
        directory.push(msg.sender);
        token.allocate(msg.sender);
        emit Registered(msg.sender);
    }

    /// @notice Pays `amount` from the caller to `to`. The permit authorizes this one payment.
    function send(
        address to,
        uint256 amount,
        bytes32 operation,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        create(to, amount, operation, Kind.Transfer, State.Paid);
        pay(to, amount, deadline, v, r, s);
    }

    /// @notice Asks `payer` for `amount`. A request reserves no funds.
    function request(address payer, uint256 amount, bytes32 operation) external {
        create(payer, amount, operation, Kind.Request, State.Pending);
    }

    /// @notice Pays the pending request `(from, operation)`. Only its intended payer can approve.
    function approve(
        address from,
        bytes32 operation,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        Record storage found = pending(from, operation);
        found.state = State.Paid;
        pay(from, found.amount, deadline, v, r, s);
        emit Resolved(from, operation, State.Paid);
    }

    /// @notice Declines the pending request `(from, operation)`. No funds move.
    function decline(address from, bytes32 operation) external {
        pending(from, operation).state = State.Declined;
        emit Resolved(from, operation, State.Declined);
    }

    function profileCount() external view returns (uint256) {
        return directory.length;
    }

    /// @notice Registration order. New registrations append, so existing pages never move.
    function profiles(uint256 start, uint256 limit) external view returns (address[] memory page) {
        if (limit == 0 || limit > MAX_PAGE) revert InvalidPage();
        uint256 end = start >= directory.length ? start : min(start + limit, directory.length);
        page = new address[](end - start);
        for (uint256 i; i < page.length; i++) {
            page[i] = directory[start + i];
        }
    }

    /// @notice Reverts with NotFound if no entry has this creator and operation ID.
    function entry(address from, bytes32 operation) external view returns (Entry memory) {
        if (records[from][operation].to == address(0)) revert NotFound();
        return load(from, operation);
    }

    function activityCount(address account) external view returns (uint256) {
        return history[account].length;
    }

    /// @notice Newest first: the entries of `account` with a history index below `before`.
    /// @dev Start with `before = activityCount(account)`. New entries never shift a later page.
    function activity(address account, uint256 before, uint256 limit)
        external
        view
        returns (Entry[] memory page)
    {
        if (limit == 0 || limit > MAX_PAGE) revert InvalidPage();
        Key[] storage keys = history[account];
        uint256 end = min(before, keys.length);
        page = new Entry[](min(end, limit));
        for (uint256 i; i < page.length; i++) {
            Key storage key = keys[end - 1 - i];
            page[i] = load(key.from, key.operation);
        }
    }

    function create(address other, uint256 amount, bytes32 operation, Kind kind, State state)
        private
    {
        if (!registered[msg.sender] || !registered[other]) revert NotRegistered();
        if (other == msg.sender) revert InvalidParticipants();
        if (amount == 0 || amount > MAX_AMOUNT) revert InvalidAmount();
        if (operation == bytes32(0)) revert InvalidOperation();
        if (records[msg.sender][operation].to != address(0)) revert OperationUsed();
        // casting to 'uint64' is safe because the amount check above caps it at MAX_AMOUNT
        // forge-lint: disable-next-line(unsafe-typecast)
        records[msg.sender][operation] = Record(other, uint64(amount), kind, state);
        history[msg.sender].push(Key(msg.sender, operation));
        history[other].push(Key(msg.sender, operation));
        emit Created(msg.sender, operation, other, amount, kind);
    }

    function load(address from, bytes32 operation) private view returns (Entry memory) {
        Record memory found = records[from][operation];
        return Entry(from, found.to, operation, found.amount, found.kind, found.state);
    }

    /// @dev Transfers are created Paid, so only a pending request passes this check.
    function pending(address from, bytes32 operation) private view returns (Record storage found) {
        found = records[from][operation];
        if (found.to == address(0)) revert NotFound();
        if (found.to != msg.sender) revert Unauthorized();
        if (found.state != State.Pending) revert NotPending();
    }

    /// @dev Moves the caller's credits only. The permit may already be used, for example when
    /// someone copied it from a pending transaction. Then the allowance it set pays instead.
    function pay(address to, uint256 amount, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        private
    {
        try token.permit(msg.sender, address(this), amount, deadline, v, r, s) {} catch {}
        IERC20(address(token)).safeTransferFrom(msg.sender, to, amount);
    }

    function min(uint256 a, uint256 b) private pure returns (uint256) {
        return a < b ? a : b;
    }
}
