# Thruput / Rust

A standalone browser-to-contract payments demo on Thruput. It uses Thruput CLI 0.45.2, the Rust SDK 0.61.1, the standard ERC-20 interfaces 0.1.75, and the `@thruputchain/client` 0.26.0 TypeScript client. Each session controls one disposable wallet.

## 1. Run

Use Node 24.21.0. Run commands from this directory:

```sh
npm ci
npm run dev
```

Open <http://127.0.0.1:5189>. Click **Create demo wallet**, copy its address, and fund it through the linked faucet. The wallet needs **10 native tokens**. Click **Start demo** to register and receive 100 credits. The faucet sets its own allocation and limits. The explorer may require sign-in.

`npm run local` starts a disposable local node with `thruput node`, deploys both contracts to it, and serves the app on <http://127.0.0.1:5190>. It needs the [Thruput CLI](#7-verification), its local runtime (`thruput toolchain install`), and free ports 9545 and 5190. The node funds the local deployer at genesis, and the deployment record is written to `public/local.json`. Each start makes a new chain with a random network hash, so a rerun never reuses an earlier deployment or session. Fund a wallet from the node's faucet, using the private CLI configuration that `npm run local` records:

```sh
XDG_CONFIG_HOME=.local/local-cli thruput airdrop <address> --amount 10 --profile local --yes
```

Stop the command to stop the node.

Wallet creation saves a key locally and submits no transactions. Each browser context controls one wallet. The app needs browser storage and Web Locks. Use a separate browser profile for a second user. Keep these test keys away from valuable assets.

## 2. Architecture

The Cargo workspace has two contracts:

- `contracts/paymvc`: the app. `src/implementation.rs` holds the contract; `src/main.rs` is the RV32 entry point.
- `contracts/credits`: the token, the SDK's example ERC-20 with metadata.

`npm run contracts:build` writes `target/thruput/paymvc.rv32a` and `target/thruput/credits.rv32a`, and generates the TypeScript bindings in `src/chain/generated/` from the contract specs. Do not edit generated files.

Chain code is in `src/chain/`:

- `config.ts`: deployment record, RPC client, native-token formatting.
- `session.ts`: one Ed25519 seed, deployment-bound storage, intent validation, exact amounts.
- `transactions.ts`: atomic wallet batches, signing, saved signed bytes, receipt reconciliation, and expiry checks.
- `payments.ts`: deployment checks, registration, payments, requests, and contact, balance, and activity reads.

`src/app.tsx` maps chain data to the shared view. `scripts/deploy.ts` runs the Thruput CLI deployment.

### Contract interface

`contracts/paymvc` implements the canonical interface:

| Function       | Signature                                                       |
| -------------- | --------------------------------------------------------------- |
| register       | `register()`                                                    |
| send           | `send(to, amount: i128, operation: SHA256Hash)`                 |
| request        | `request(payer, amount: i128, operation: SHA256Hash)`           |
| approve        | `approve(from, operation)`                                      |
| decline        | `decline(from, operation)`                                      |
| registered     | `registered(account) -> bool`                                   |
| profile_count  | `profile_count() -> u64`                                        |
| profiles       | `profiles(start: u64, limit: u64) -> Vec<ContractAddress>`      |
| entry          | `entry(from, operation) -> Option<Entry>`                       |
| activity_count | `activity_count(account) -> u64`                                |
| activity       | `activity(account, before: u64, limit: u64) -> Vec<Entry>`      |
| initialize     | `initialize(credits)`: runs once, inside the deploy transaction |
| credits        | `credits() -> ContractAddress`                                  |

`Entry { from, to, operation, amount, kind, state }`. `Kind { Transfer, Request }` and `State { Pending, Paid, Declined }` are `#[contract_type]` enums. Errors (`PaymentError`, codes 1 to 10): `AlreadyRegistered`, `NotRegistered`, `InvalidParticipants`, `InvalidAmount`, `InvalidOperation`, `OperationUsed`, `NotFound`, `Unauthorized`, `NotPending`, `InvalidPage`. The caller is the implicit `get_caller()`.

Native deviations from the canonical interface:

- **Smaller pages.** The runtime return buffer limits one call's result. `profiles` accepts `limit` 1 to 25 and `activity` 1 to 5; a larger limit fails with `InvalidPage`. The client reads 50 activity records as ten pages in one batched RPC read.
- **Payment authorization.** `send` and `approve` move credits with `transfer_from`. The client sends each payment as one atomic wallet transaction: allow PayMVC exactly the amount on the token, then call PayMVC. See [Token model](#3-token-model).
- **Token errors.** Insufficient credits or a missing allowance fail with the token's `ERC20Error::TooLarge`, which the cross-contract call propagates.
- **Initializer.** `initialize(credits)` binds the token and makes PayMVC its only minter. The deployment runs it atomically. A second call fails with `Unauthorized`.
- **Amount type.** `i128`, the ERC-20 interface amount type.

### Storage

An entry is stored in `entries: Map<from, Map<operation, Entry>>`, so its key is `(from, operation)`. There is no global entry ID or counter. `directory` is a vector in registration order. Each account's `history` is a vector of `EntryKey { from, operation }`. `activity` returns the entries with history index below `before`, newest first. The client starts with `before = activity_count`, so a new record cannot shift a later page.

Registration, entry creation, and request resolution use exclusive storage writes. On Thruput, identical ordinary writes can merge, so they cannot protect one-time allocation, operation IDs, or approval. A vector push writes its length with an exclusive lock. So at most one registration, and one history change per account, can land in each block. This limit comes from this contract's storage choice, not from the chain.

## 3. Token model

`contracts/credits` is a standard ERC-20 with metadata. It is modeled on the SDK's `example-contracts/erc20`, because no ERC-20 implementation crate is published. It has no clawback, burn, or upgrade path. Amounts are exact `i128` whole credits. Balances always come from `get_balance_of`.

- PayMVC's initializer sets the token to zero decimals, symbol `CREDITS`, and administrator PayMVC. Only the administrator can mint, and PayMVC mints only in `register`, 100 per address, once.
- Direct ERC-20 transfers work, including to unregistered accounts, and add no PayMVC activity.
- `decline` does not call the token.

**Payment authorization.** Three native options were considered:

1. **Atomic wallet batch (chosen).** A pubkey account's DefaultWallet runs up to 16 calls in one transaction, atomically ([Send transactions](https://www.thruput.network/docs/typescript/transactions/#execute-multiple-calls)). A payment is `adjust_allowance(PayMVC, amount)` followed by `send` or `approve`. `transfer_from` consumes exactly that allowance, so nothing stays approved, and a failed payment reverts both calls. That is one user transaction per payment. The swap example uses the same allowance-then-call pattern ([Build an AMM](https://www.thruput.network/docs/guides/build-an-amm/)).
2. **Typed auth tokens (`Signed<T>`).** A contract mints them; `consume()` proves only the minter ([Authorization](https://www.thruput.network/docs/contracts/authorization/#auth-tokens-and-signedt)). The DefaultWallet's `execute(calls)` forwards plain calls and cannot mint tokens. Each user would need a custom wallet contract, such as the SDK's `permit_wallet`. Detached signatures that become `Signed<T>` have not landed yet.
3. **Plain allowance, as on EVM.** This needs a separate approval transaction and leaves a standing allowance.

## 4. Funding

Fund the displayed address with Futurenet native tokens before registration. One native token is 10,000,000 base units.

Each transaction reserves gas as scheduling capacity: one base unit per unit of gas. A PayMVC call gets 8,000,000 gas and an allowance change 2,000,000. The wallet adds 2,000,000 for its own work. So a payment reserves at most 1.2 native tokens while it is scheduled. Gas is not a token fee.

Contract storage uses each contract's own balance. The deployment funds each contract with 25 native tokens. If storage capacity runs out, the maintainer must fund the contract. The app never reports a failed or unknown operation as successful.

## 5. Confirmation and recovery

The general policy is in [transaction recovery](../../../docs/recovery.md).

- Signed bytes and their hash are saved before broadcast. If the save fails, nothing is broadcast.
- Confirmation needs a successful committed receipt and the expected entry: participants, amount, kind, and state. The session records the receipt's block, and later reads wait for that state height. A receipt is not a claim of irreversible finality.
- Retry checks the original transaction. While it is unexpired, a scheduler `retry` or `dropped` status resends the same bytes.
- A timeout, an advisory failure, or a missing receipt stays unknown. A known commitment is kept even when its receipt is unavailable.
- Transactions expire 200 blocks after preparation. A new transaction is allowed only after a failed receipt, or after expiry plus a later `entry(from, operation)` read that shows the operation did not happen. The saved transaction is then deleted, and the user must retry explicitly.
- The contract rejects a second entry with the same `(from, operation)` (`OperationUsed`), and `Paid` and `Declined` are final, so these absence checks are meaningful and a retry cannot pay twice.

Setup makes one automatic recheck after five seconds for an unknown outcome or a delayed registration result. Payments make one recheck for a delayed result. A recheck never signs a new transaction. Further recovery needs user action.

Before each read and write, `verifyDeployment` checks:

- the RPC network hash;
- each contract's deployed code hash, through `getContractDeployment`;
- that PayMVC's `credits()` is the saved token;
- that the token has zero decimals.

Futurenet can reset. Sessions bind to the network hash and PayMVC address, and a mismatch stops signing.

Failed reads keep the last balance with a stale indicator. Keys stay in browser storage. Web Locks permit one writer tab. Reset removes this session's local access. It cannot cancel transactions or remove chain state.

## 6. Deploy

Both contracts deploy with `thruput deploy`:

```sh
thruput deploy --artifact target/thruput/credits.rv32a --fund 25 --profile futurenet
thruput deploy --artifact target/thruput/paymvc.rv32a --fund 25 \
  --init initialize --init-arg <credits address> --profile futurenet
```

The token deploys uninitialized. PayMVC's initializer initializes it in PayMVC's own deploy transaction. If anyone initializes the token first, PayMVC's deployment fails and nothing is bound. The addresses never need to be predicted.

`npm run deploy` runs these commands and writes the deployment record:

```sh
npm run contracts:build
npm run deploy
```

The script runs the CLI with a private configuration in `.local/futurenet-cli/`. It holds the dedicated deployer key and a profile pinned to the RPC's network hash. Without enough native tokens, the script prints the deployer address and stops before broadcasting. Each CLI result is saved in `.local/futurenet-cli/deployment.json`, so a rerun resumes after the last completed step. If the CLI reports an uncertain outcome, inspect it with `thruput tx show` before rerunning: a new deploy uses a new nonce and address. After both steps, the script checks the record as the app does (network hash, both code hashes through `getContractDeployment`, PayMVC's `credits()`, and zero token decimals), then writes `public/deployment.json`.

For local development, use `npm run local`. It starts the node, then runs `npm run deploy -- --local`, which signs with the private configuration in `.local/local-cli/`. A local chain is disposable, so a local deployment always starts over. The node sends no CORS headers, so the local record points the app at the development server's same-origin proxy, `/thruput-rpc` (`vite.config.ts`). Local deployments are not public demos.

## 7. Verification

Install the CLI with `cargo install thruput --version 0.45.2 --locked`, then install its default local runtime with `thruput toolchain install`. The runtime needs GLIBC 2.38 or later, for example Ubuntu 24.04, and these shared libraries: jemalloc, snappy, brotli, lz4, zstd, bzip2, and libatomic. On Ubuntu: `sudo apt-get install libjemalloc2 libsnappy1v5 libbrotli1 liblz4-1 libzstd1 libbz2-1.0 libatomic1`. Check with `ldd "$(thruput toolchain which)"`. `rust-toolchain.toml` pins Rust nightly `2026-07-01`. Keep `.cargo/` and the host and guest features together.

```sh
npm run check
npm test
npm run contracts:test
npm run build
npm run test:e2e
npm run test:conformance
```

`npm test` runs the native contract tests and the unit tests in `tests/unit/`. `npm run contracts:test` builds both RV32 artifacts and runs the same contract scenarios against them. Report native and RV32 results separately. Neither needs a node. The first native build downloads the SDK's test executor. Set `HOGD_DOWNLOAD_CACHE_DIR` to keep that download outside `target/`.

Browser tests in `tests/e2e/` run against a local node. Playwright starts `npm run local` and the tests read `public/local.json`; they never contact Futurenet. The canonical scenario runs on desktop and mobile with real transactions. The tests fund each user from the local deployer key. Traces are off to keep keys out of artifacts. `npm run test:conformance` compares the shared files, the test snapshots, and the committed evidence with the repository, so it runs only inside the repository.

Public funded acceptance is explicit:

```sh
npm run test:live           # the canonical scenario with chain calls only
npm run test:live:browser   # the canonical scenario in the browser, desktop and mobile
```

Both commands fund new users A and B with 20 native tokens each from the deployer key in `.local/futurenet-cli/`, saving each wallet before funding. A full run (chain plus both viewports) funds six users, so it needs 120 native tokens. Signed transactions are saved before broadcast. `npm run test:live` keeps its sessions and completed steps in `.local/live-<network hash>-<PayMVC address>/`, so a rerun reconciles the saved transactions and continues after the last completed step. `LOCAL=1 npm run test:live` runs the same scenario against the node from `npm run local`.

Each command records its result in `evidence/futurenet.json`, in the format of `evidence.schema.json`: the deployment, the tested commit, the final balances and activity counts of A and B, and the transaction hashes in scenario order. `npm run test:live` writes the `chain` section and `npm run test:live:browser` one `browser` entry per viewport. A run keeps the other sections if the deployment is the same. Run live tests from a clean working tree: if `git status --porcelain -- . ':!evidence'` shows changes, or the run is local, the result goes to `.local/evidence-<network>.json` instead. `npm run check` validates every file in `evidence/`. Private sessions and signed transactions stay in `.local/`.

## 8. References

- [Thruput documentation](https://www.thruput.network/docs/)
- [Install the CLI](https://www.thruput.network/docs/cli/install/)
- [Deploy and call](https://www.thruput.network/docs/cli/deploy-and-call/)
- [Authorization](https://www.thruput.network/docs/contracts/authorization/)
- [Storage economics](https://www.thruput.network/docs/architecture/storage-economics/)
- [JSON-RPC API](https://www.thruput.network/docs/reference/json-rpc-api/)
