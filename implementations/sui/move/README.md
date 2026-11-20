# Sui / Move

PayMVC on Sui Testnet uses native zero-decimal `Coin<CREDITS>` assets and one disposable wallet per user.

## 1. Run

Use Sui CLI 1.83.1 and Node 24.21.0. Install that CLI version with `suiup install sui@testnet-1.83.1` and verify it with `sui --version` before building.

Run these commands from this directory, including when you copy it outside the repository:

```sh
npm ci
npx playwright install chromium
npm run check
npm test
npm run build
npm run test:e2e
```

`npm run dev` opens the Testnet frontend at `http://127.0.0.1:5183`. Create a wallet, fund its address, then select Start demo. Use separate browser profiles for independent users.

`npm run local` starts a disposable local Sui node, faucet, deployment, and frontend on port 5184. It needs free ports 9000 and 9123. Local startup waits for both the node and faucet. Local tests use real transactions. Run browser suites sequentially.

## 2. Architecture

The contract has two Move modules:

- [`paymvc::credits`](contracts/sources/credits.move) defines the `CREDITS` one-time witness and creates the coin. Its `init` moves the mint capability (`TreasuryCap`) into the shared app.
- [`paymvc::paymvc`](contracts/sources/paymvc.move) holds the app: directory, entries, activity, and all authorization and state rules.

`App` is generic over the coin type (`App<phantom T>`). This lets `credits::init` create the app without a module cycle. `create` is `public(package)`, so the published `App<CREDITS>` is the only instance. Only `register` can mint. It mints into the account's address balance with `balance::send_funds`.

| Function       | Signature                                                 |
| -------------- | --------------------------------------------------------- |
| register       | `register<T>(app, ctx)`                                   |
| send           | `send<T>(app, to, operation, payment: Coin<T>, ctx)`      |
| request        | `request<T>(app, payer, amount, operation, ctx)`          |
| approve        | `approve<T>(app, from, operation, payment: Coin<T>, ctx)` |
| decline        | `decline<T>(app, from, operation, ctx)`                   |
| registered     | `registered<T>(app, account): bool`                       |
| profile_count  | `profile_count<T>(app): u64`                              |
| profiles       | `profiles<T>(app, start, limit): vector<address>`         |
| entry          | `entry<T>(app, from, operation): Option<Entry>`           |
| activity_count | `activity_count<T>(app, account): u64`                    |
| activity       | `activity<T>(app, account, before, limit): vector<Entry>` |

`Entry { from, to, operation, amount, kind: Kind, state: State }` uses Move enums `Kind { Transfer, Request }` and `State { Pending, Paid, Declined }`. An operation ID is a 32-byte `vector<u8>`. It must be nonzero.

Storage uses native dynamic-field tables:

- `members: Table<u64, address>` holds the directory in registration order.
- `entries: Table<EntryKey, Entry>` holds every entry under its key `(from, operation)`. There is no global entry counter.
- Each profile has `activity: Table<u64, EntryKey>`. An entry is appended to the activity of both accounts.

Errors are numbered `E_` constants: `E_ALREADY_REGISTERED` (1), `E_NOT_REGISTERED` (2), `E_INVALID_PARTICIPANTS` (3), `E_INVALID_AMOUNT` (4), `E_INVALID_OPERATION` (5), `E_OPERATION_USED` (6), `E_NOT_FOUND` (7), `E_UNAUTHORIZED` (8), `E_NOT_PENDING` (9), `E_INVALID_PAGE` (10).

### Native differences from the canonical interface

- **The shared `App` object is an argument.** Sui functions change the objects that they receive, so every call passes the app. Every write goes through consensus on this one object, in order. The global directory order and the per-sender deduplication need shared state, so this is the simplest correct design; under heavy load, Sui can cancel transactions for congestion on the object. The client reports such a cancellation as a failure, and an explicit retry signs again.
- **The caller is `ctx.sender()`.** The transaction signer is the caller, so no address argument is needed.
- **`send` and `approve` take a `Coin<CREDITS>`, not an amount.** The signer passes a coin. The contract cannot take coins from an account. For `send`, the amount is the coin value, and the contract checks it. For `approve`, the coin value must equal the request amount. If the payer has too few credits, the client cannot build the coin, so the request stays `Pending`.
- **`decline` takes no coin.** A payer with no credits can decline.
- **Functions have a type parameter `<T>`.** The client passes `<package>::credits::CREDITS`. See the module explanation above.
- **The amount type is `u64`**, the type of `Coin` values.

### Client

[Payments](src/chain/payments.ts) builds transactions and reads state. It calls the read functions in one simulated transaction (`simulateTransaction` with command results). The transaction is not signed or sent. All calls in one simulation read the same state. The `activity_count` result goes directly into the `before` argument of `activity` in the same transaction, so the count and its rows always agree. Later pages use `0x1::u64::saturating_sub` on the same count. Retry reconciliation uses `entry(from, operation)`. A row ID is `from:operation`.

The UI reads five contacts and 50 activity entries initially. It reads token balances directly, including native address balances.

Credits move between address balances: `register` mints into the owner's address balance, and `send` and `approve` deliver the coin with `coin::send_funds`. Address balances merge automatically, so many small payments never fragment into many coin objects. A payment withdraws from the address balance in the same transaction (`tx.withdrawal`) and adds owned coin objects only when an outside transfer delivered some.

The contract emits `Registered`, `Created`, and `Resolved` events. The app reads state, not events; the events let explorers and indexers follow payments.

[Transactions](src/chain/transactions.ts) handles signed evidence and recovery. No indexer or application backend is required.

## 3. Token model

Credits are a native `Coin<CREDITS>` with zero decimals. `Coin` is the standard fungible token on Sui, so wallets, explorers, and balance reads support it without app code. One coin unit is one whole credit. The mint capability is inside the shared app, and only `register` uses it. Plain coin transfers work outside the app, also to accounts that are not registered. They create no app activity.

## 4. Funding

Use the [Sui faucet](https://faucet.sui.io/) and select Testnet. The faucet may rate-limit requests. The initial estimate is 0.1 SUI for registration, storage, and use; fees can change. Browser users fund their own separate disposable wallets.

## 5. Confirmation and recovery

Before broadcast, the implementation saves signed bytes, signature, digest, expiry epoch, and the preparation checkpoint. A storage failure stops submission. Recovery checks the saved digest and can rebroadcast the same signed bytes. It does not create a replacement payment after a timeout.

Confirmation requires successful transaction effects and the expected application state. The client finds that state with `entry(from, operation)`. A send or request is confirmed when its entry exists and matches the saved intent. An approval or decline is confirmed when the request has the expected state. A second entry with the same `(from, operation)` fails with `E_OPERATION_USED`, so a retry cannot pay twice. An indexed-transaction wait is bounded to 30 seconds. Sui consensus provides finality, so there are no reorganizations to handle. The application does not use an EVM-style confirmation count or speculative balance updates. A failed RPC read retains the last displayed balance.

Transactions use `ValidDuring` through the next epoch, so a saved transaction can stay valid for up to two epochs (about 48 hours on Testnet). Sui validators reject the `ValidDuring` timestamp fields as not yet supported, so a shorter window is not available. Expiry requires a later epoch, then current state without the operation's effect. The client requests that state after it sees the later epoch, but a load-balanced endpoint can answer from a node that is slightly behind. In that case a transaction from the last checkpoints of its epoch can look absent. The contract still prevents a second effect: a retry aborts with `E_OPERATION_USED`, `E_NOT_PENDING`, or `E_ALREADY_REGISTERED`, and the checks before signing find the effect. While checkpoint history covers preparation, a second absent-digest lookup comes first. The state check matters because public nodes keep about two weeks of history and can balance requests across nodes: a "not found" alone cannot prove that a transaction never executed. After the epoch, the transaction can no longer execute, so state decides even when history is gone. A failed state read leaves the outcome unknown. When the expected entry or registration is already on chain, it confirms the saved transaction directly, even after history no longer covers it.

A failed dry run names the contract's abort, for example "Choose a different, registered PayMVC account." for `E_NOT_REGISTERED`. Nothing is signed in that case.

A failed broadcast keeps the saved transaction and reports an unknown outcome. Most rejections can change: an object can appear, an address balance can grow, a lagging validator can report expiry early, and a consumed object version can mean that the same transaction already executed. The one exception is a chain ID mismatch, which is permanent. The app then removes the saved transaction and reports that the network rejected it. A failed transaction, a permanent rejection, or proven expiry permits an explicit retry. Browser setup makes at most one automatic recovery attempt; payment result reconciliation is also bounded.

Web Locks prevent a second tab from writing. Reset removes the current local wallet after confirmation, but does not cancel transactions or remove on-chain records.

## 6. Deploy

```sh
sui client ptb --publish contracts --assign upgrade_cap --move-call 0x2::package::make_immutable upgrade_cap
```

`npm run deploy` runs this command through the Sui CLI. One transaction publishes the package and passes its `UpgradeCap` to `make_immutable`, which destroys it. The script checks that no `UpgradeCap` survives and records that transaction as `immutableDigest` in the deployment record, so anyone can audit it on an explorer. Every Sui package object is immutable; only the `UpgradeCap` can publish an upgrade that changes the shared `App`. The browser checks the package digest and the `App` object once per page load. It cannot re-check `immutableDigest` later, because public nodes keep about two weeks of transaction history. A second CLI transaction (`0x2::coin_registry::finalize_registration`) finalizes the coin's registry entry. The script then reads the CLI JSON output, verifies the deployment, and writes `public/deployment.json`.

The script creates `.local/testnet-deployer.json` if needed and prints only its address. Fund that address with at least 0.2 SUI, then rerun. The script writes a private CLI config and keystore to `.local/sui-testnet/` (mode 0600). The key never goes into command arguments or output.

Each transaction is signed with `--serialize-signed-transaction` and saved in `.local/` before it is sent. The file name includes the network, its chain identifier, and the compiled package's digest. A rerun of the same code sends the same signed bytes, so it cannot publish twice. New code gets new files, so a redeploy never resends an older package. If a saved transaction expired without executing, delete its `.tx` file and rerun. If `public/deployment.json` exists and the current build was never published, the script stops before it publishes: new code or a new CLI can compile different bytecode, and a new package is a new app. Run `npm run deploy -- --replace` to publish a new app on purpose.

The Sui package manager does not publish to an ephemeral local chain with `ptb --publish`. Local runs (`npm run local`) use the package manager's `sui client test-publish --build-env testnet` command, then make the package immutable in a second transaction.

## 7. Verification

```sh
npm run test:live
npm run test:live:browser
```

The deployment wallet funds each user: 0.15 SUI per user for the chain script and 0.13 SUI per user for browser acceptance. One user spends about 0.03 SUI in the scenario, so a full run (chain, desktop, and mobile) needs about 0.85 SUI. The chain script resumes saved steps. Browser acceptance creates fresh users and runs desktop and mobile sequentially.

Both commands write `evidence/testnet.json` in the [evidence format](evidence.schema.json). `test:live` replaces the `chain` result, and `test:live:browser` replaces the result for each viewport. Results for the same deployment stay in the file; a new deployment starts a new file. `npm run check` validates every evidence file.

Run live tests from a clean working tree, so that `revision` is the tested commit. If this folder has uncommitted changes outside `evidence/`, the result goes to `.local/evidence-testnet.json` instead. Local runs (`LOCAL=1 npm run test:live` with `npm run local` running, and the canonical browser test in `npm run test:e2e`) write `.local/evidence-localnet.json`.

Private user keys stay in `.local/`. Evidence contains no keys or signed transactions. Browser traces, video, and screenshots are disabled for wallet tests to keep keys out of diagnostic artifacts.

`npm run test:conformance` compares the shared files, the test snapshots, and the committed evidence with the repository, so it runs only inside the repository. The local unit and browser suites do not need the repository.

## 8. References

- [Sui documentation](https://docs.sui.io/)
- [Sui TypeScript SDK](https://sdk.mystenlabs.com/sui)
- [Move on Sui](https://docs.sui.io/concepts/sui-move-concepts)
- [Sui Testnet faucet](https://faucet.sui.io/)
