# Contract requirements

This page states what the PayMVC contract or program must do on every chain. The [specification](../SPEC.md) is normative; this page groups its contract rules by operation.

Use the chain's normal patterns. Some chains name the caller explicitly, pass objects or accounts, or authorize through signatures. Those are native differences. Document them in your README and in the [comparison](comparison.md).

## Data model

### Credits

- Use the chain's standard fungible token (ERC-20, SPL Token, or the equivalent) with zero decimals. Zero decimals prevent fractional balances from outside transfers.
- Only registration can create credits. There is no admin mint, top-up, repeat claim, or burn in the app.
- The token must allow direct transfers outside the app, including to accounts that are not registered.
- Balances must support at least 1,000,000 credits and use exact integer arithmetic.

### Entry

An entry is one transfer or one request.

| Field       | Meaning                                                         |
| ----------- | --------------------------------------------------------------- |
| `from`      | The sender of a transfer, or the requester of a request         |
| `to`        | The recipient of a transfer, or the intended payer of a request |
| `operation` | An ID that the client creates for each deliberate operation     |
| `amount`    | A whole number of credits from 1 to 1,000,000                   |
| `kind`      | `Transfer` or `Request`                                         |
| `state`     | `Pending`, `Paid`, or `Declined`                                |

A transfer is created `Paid`. A request is created `Pending`.

### Operation ID

The client creates a nonzero 32-byte operation ID for each deliberate operation and saves it before it signs. An entry's identity is its `from` and `operation`; there is no global entry counter. The contract rejects a second entry with the same `from` and `operation`. A retry of the same operation therefore cannot create a second payment. Two deliberate operations use two IDs.

## Interface

Every implementation uses these names and shapes. Names follow the language's case convention: `profileCount` in Solidity, `profile_count` in Rust and Move.

| Function         | Signature                                    | Purpose                                                   |
| ---------------- | -------------------------------------------- | --------------------------------------------------------- |
| `register`       | `register()`                                 | Register the caller and allocate 100 credits once         |
| `send`           | `send(to, amount, operation)`                | Pay `amount` to `to`                                      |
| `request`        | `request(payer, amount, operation)`          | Ask `payer` for `amount`                                  |
| `approve`        | `approve(from, operation)`                   | Pay the request that `from` created                       |
| `decline`        | `decline(from, operation)`                   | Decline the request that `from` created                   |
| `registered`     | `registered(account) → bool`                 | Is the account registered                                 |
| `profile_count`  | `profile_count() → count`                    | Number of registered accounts                             |
| `profiles`       | `profiles(start, limit) → address[]`         | One directory page, in registration order                 |
| `entry`          | `entry(from, operation) → Entry?`            | Find one entry, for display and retry                     |
| `activity_count` | `activity_count(account) → count`            | Number of entries in the account's activity               |
| `activity`       | `activity(account, before, limit) → Entry[]` | Entries with a history index below `before`, newest first |

`activity` uses an absolute cursor. The client starts with `before = activity_count(account)` and uses the last index it read for the next page. A new entry is added at the top, so it never moves an entry into a page that the client has already read.

Kinds and states are enums: `Kind { Transfer, Request }` and `State { Pending, Paid, Declined }`.

### Errors

Every implementation uses these names. Move uses numbered constants with the same names, for example `E_NOT_PENDING`.

| Error                 | When                                                                |
| --------------------- | ------------------------------------------------------------------- |
| `AlreadyRegistered`   | The account is already registered                                   |
| `NotRegistered`       | A participant is not registered                                     |
| `InvalidParticipants` | Sender and recipient are the same account                           |
| `InvalidAmount`       | The amount is not a whole number from 1 to 1,000,000                |
| `InvalidOperation`    | The operation ID is not 32 nonzero bytes                            |
| `OperationUsed`       | The sender already used this operation ID                           |
| `NotFound`            | No entry has this sender and operation ID                           |
| `Unauthorized`        | The caller is not the intended payer                                |
| `NotPending`          | The request is already Paid or Declined, or the entry is a transfer |
| `InvalidPage`         | The page limit is out of range                                      |

### Native differences

Each implementation's README explains these in detail.

| Platform | Difference                                                                                                                                                                                                                                                                               | Reason                                                                                                                                                                         |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| EVM      | `send` and `approve` also take an EIP-2612 permit (`deadline, v, r, s`).                                                                                                                                                                                                                 | The token sees PayMVC as the caller, not the user. The permit authorizes the transfer in the same transaction.                                                                 |
| Solana   | Instructions take accounts. There are no read instructions; the client reads the entry, profile, and activity accounts. `AlreadyRegistered` and `OperationUsed` appear as "account already in use"; `NotRegistered` and `NotFound` appear as "account not initialized".                  | Accounts are created and checked before the program runs.                                                                                                                      |
| Stellar  | Writes take the signer as their first argument: `register(owner)`, `send(from, to, amount, operation)`, `approve(payer, from, operation)`.                                                                                                                                               | Soroban has no implicit caller; the contract calls `require_auth` on the signer.                                                                                               |
| Sui      | `send` and `approve` take a `Coin<CREDITS>` of the exact amount. The shared `App<T>` object is the first argument.                                                                                                                                                                       | Coins are objects. `App` is generic over the coin type to avoid a module cycle.                                                                                                |
| Aptos    | Writes take `&signer`.                                                                                                                                                                                                                                                                   | Move entry functions receive the signer.                                                                                                                                       |
| Thruput  | A payment is one wallet transaction that grants PayMVC an exact allowance and then calls `send` or `approve`. `profiles` returns at most 25 addresses and `activity` at most 5 entries per call. PayMVC binds its credits contract with `initialize(credits)` in its deploy transaction. | The token sees PayMVC as the caller. The runtime limits each return value to 1,024 bytes. `thruput deploy` chooses its own nonce, so PayMVC's address is not known in advance. |
| All      | The amount type follows the token standard: `uint256`, `u64`, or `i128`.                                                                                                                                                                                                                 | Token standards                                                                                                                                                                |

## Operations

### Register

- The account registers itself. Registration must be authorized by that account.
- Registration adds the account to the directory and allocates 100 credits.
- Membership, directory insertion, and allocation are atomic, or recoverable without a duplicate member or a second allocation.
- A second registration of the same account fails or has no effect. It never allocates again.

### Send

- The caller pays. Only the caller's own credits can move.
- Both accounts are registered, and they are different.
- The amount is a whole number from 1 to 1,000,000. Reject zero, negative, fractional, and larger amounts.
- Insufficient credits fail the whole operation.
- The recipient receives exactly the amount that the caller pays.
- The entry and the token transfer are atomic.

### Request

- The caller is the requester. The intended payer is registered and different.
- The amount rules are the same as for send.
- A request reserves no funds. It is allowed when the payer has too few credits.

### Approve and decline

- Only the intended payer can approve or decline, and only while the request is `Pending`.
- Approve transfers the exact amount from the payer to the requester and marks the request `Paid`, atomically.
- If the payer has too few credits, approve fails and the request stays `Pending`.
- Decline marks the request `Declined`. No funds move.
- `Paid` and `Declined` are final. When two resolutions compete, at most one succeeds.
- Requests cannot be edited, cancelled, expired, or partly paid.

## Reads

The app reads everything it shows from the chain. It must not need an indexer.

### Directory

- Registered accounts in stable registration order.
- Bounded pages (at most 50 per read) and a count, or an equivalent native cursor.
- New registrations never move existing entries, so a reader never skips an existing contact.

### Activity

- Each account's entries, newest first, in bounded pages.
- A request keeps its original position when it becomes `Paid` or `Declined`. Approval does not add a second row.
- Registration and allocation are not activity.

### Entry lookup

- The client can find an entry from its `from` and `operation`. Retry reconciliation uses this lookup.

### Balance

- The app reads the real token balance. It never calculates a balance from activity.

## Deployment

- No upgrade path, or a documented one. If the deployment can change, the session identity must change with it.
- The browser verifies the deployment before the first write: network identity, contract code, and token settings.
