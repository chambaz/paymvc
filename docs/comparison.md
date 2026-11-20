# Comparing the implementations

All implementations have the same behavior. This page shows where each concept lives and what each platform does differently.

To read one implementation, start with `src/app.tsx`, follow `src/hooks/use-demo.ts` into `src/chain/payments.ts`, then read the contract. `src/chain/transactions.ts` shows signing and recovery. `src/components/` is the interface and contains no chain code.

## Where to look

|                   | Contract                                 | Token                                              | Chain client                            |
| ----------------- | ---------------------------------------- | -------------------------------------------------- | --------------------------------------- |
| EVM / Foundry     | `contracts/PayMVC.sol`                   | `contracts/DemoCredits.sol` (ERC-20)               | Viem                                    |
| Solana / Anchor   | `programs/paymvc/src/lib.rs`, `state.rs` | SPL Token mint                                     | Solana Kit, Codama client               |
| Stellar / Soroban | `contracts/paymvc/src/lib.rs`            | `contracts/credits/src/lib.rs` (SEP-41)            | Stellar SDK                             |
| Sui / Move        | `contracts/sources/paymvc.move`          | `contracts/sources/credits.move` (`Coin<CREDITS>`) | Sui TypeScript SDK (gRPC)               |
| Aptos / Move      | `contracts/sources/paymvc.move`          | `contracts/sources/credits.move` (fungible asset)  | Aptos TypeScript SDK                    |
| Thruput / Rust    | `contracts/paymvc/src/implementation.rs` | `contracts/credits/src/implementation.rs` (ERC-20) | Thruput TypeScript client, CLI bindings |

## Concepts

| Concept               | EVM                                                   | Solana                                      | Stellar                                  | Sui                                             | Aptos                                              | Thruput                                                              |
| --------------------- | ----------------------------------------------------- | ------------------------------------------- | ---------------------------------------- | ----------------------------------------------- | -------------------------------------------------- | -------------------------------------------------------------------- |
| Who is the caller     | `msg.sender`                                          | Signer account                              | Explicit address with `require_auth`     | `ctx.sender()`                                  | `&signer`                                          | `get_caller()`                                                       |
| Register and allocate | `register` mints through the token                    | `register` mints through an SPL CPI         | `register` calls the token's `mint`      | `register` mints with the private `TreasuryCap` | `register` mints with the private `MintRef`        | `register` mints through the credits contract                        |
| Pay                   | EIP-2612 permit in the same call, then `transferFrom` | Signer-authorized SPL transfer              | Token `transfer` under the caller's auth | An exact-value coin passed into `send`          | `primary_fungible_store::transfer` with the signer | One wallet transaction: an exact allowance, then `send` or `approve` |
| Deduplicate           | Mapping from sender and operation ID                  | Entry PDA from sender and operation ID      | Storage key from sender and operation ID | Table keyed by sender and operation ID          | Table keyed by sender and operation ID             | Map from sender and operation ID                                     |
| Directory             | Append-only array                                     | Counter account and numbered member PDAs    | Counter and numbered persistent entries  | Table in the shared `App` object                | Table in the `App` resource                        | `Vector` in registration order                                       |
| Activity              | Per-account index array                               | Activity accounts of 32 records per account | Numbered persistent entries per account  | Per-profile table                               | Per-profile table                                  | Per-account `Vector` of entry keys                                   |
| Reads                 | `view` calls at one block                             | Account reads                               | Simulated calls                          | View functions in one simulated transaction     | `view` functions                                   | Read-only calls                                                      |

## Native differences

- **Fees.** EVM pays gas. Base and Robinhood also pay L1 data fees. Solana pays fees and account rent. Stellar pays fees, reserves, and storage rent. Sui and Aptos pay gas. Thruput reserves gas without burning it and funds contract storage separately. Funding budgets are estimates.
- **Authorization.** EVM and Thruput see the immediate caller only, so the token sees PayMVC, not the user, when PayMVC calls it. EVM therefore passes an EIP-2612 permit signature into `send` and `approve`, so the token allowance and the payment happen in one transaction. Thruput sends one wallet transaction that grants PayMVC an exact allowance and then calls `send` or `approve`, so nothing stays approved. Stellar's `require_auth` authorizes the user's transfer inside the PayMVC call. Solana, Sui, and Aptos pass the user's signer, account, or coin directly.
- **Storage and concurrency.** Shared ordered data, such as the registration directory, can make concurrent writes conflict. Solana write-locks each account, so the program stores activity in pages of 32 records: payments to one person land together unless one fills a page. Stellar transactions declare their storage footprint. A Thruput `Vector` push takes an exclusive lock on its length for the block. Sui writes to the shared `App` object go through consensus in order. EVM and Aptos run transactions in order or re-execute on conflict.
- **Storage lifetime.** Stellar persistent entries have a TTL and can be archived. Other chains keep storage until it is deleted.
- **Expiry.** See [transaction recovery](recovery.md#per-chain).
- **Read consistency.** EVM reads the dashboard at one block, Aptos at one ledger version, and Sui in one simulated transaction. Solana and Stellar use separate reads, which are not one atomic snapshot. Every chain pages activity with an absolute cursor, so a new record never shifts a later page.
- **Operation IDs.** Every chain uses a nonzero 32-byte ID. An entry's identity is its sender and operation ID; there is no global entry counter.

## Deployment changes

Each implementation verifies its network and deployment before its first write. Most cache the result for the page load, because the deployed contracts cannot change.

| Chain   | Checks                                                                                   | Upgradeable |
| ------- | ---------------------------------------------------------------------------------------- | ----------- |
| EVM     | Chain ID, contract code hash, token address                                              | No          |
| Solana  | Genesis hash, program with no upgrade authority, mint authority, decimals, token program | No          |
| Stellar | Network passphrase, both WASM hashes, token address, decimals                            | No          |
| Sui     | Chain identifier, package digest, immutable package, shared `App` object type            | No          |
| Aptos   | Chain ID, both module hashes, asset metadata address, immutable package policy           | No          |
| Thruput | Network hash, both contract code hashes, the app's credits address, decimals             | No          |

The session storage key includes the deployment identity. A new deployment therefore gets new sessions. An RPC-only change keeps them. Solana programs can be upgradeable, so the Solana deployment is deployed with `--final`, and the browser refuses a program that still has an upgrade authority. A new program version gets a new program address.
