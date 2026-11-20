# Aptos / Move

PayMVC on Aptos Testnet uses one disposable wallet per user. Toolchain: Aptos CLI 9.6.0 and Node 24.21.0.

## 1. Run

Run from this directory, including when copied outside the repository:

```sh
npm ci
npx playwright install chromium
npm run local
```

`npm run local` starts a disposable Aptos node, faucet, deployment, and frontend on port 5186. It uses ports 8170, 8180, and 8181. Each run resets the node data in `.local/node`. It also overwrites `.local/local-deployer.json` with a fresh deployment wallet, `.local/validator.log`, `.local/node-override.yaml`, and `public/local.json`. It needs no indexer or Docker.

The local launcher disables Aptos telemetry and host disk metrics. Disk-metric collection can block startup on an unavailable FUSE mount. Shutdown terminates the node, deployment, and frontend process groups.

`npm run dev` opens the Testnet frontend on port 5185. Create a wallet, fund its displayed address, then select Start demo. Use separate browser profiles for independent users.

## 2. Architecture

The package has two Move modules:

- [`paymvc::credits`](contracts/sources/credits.move): the fungible asset. It keeps the `MintRef` in a private resource. Its `mint` function is `friend` to `paymvc::paymvc` only.
- [`paymvc::paymvc`](contracts/sources/paymvc.move): the app. It holds the directory and the entries, and calls `credits::mint` only in `register`.

| Function            | Signature                                                                               |
| ------------------- | --------------------------------------------------------------------------------------- |
| `register`          | `entry register(account: &signer)`                                                      |
| `send`              | `entry send(sender: &signer, to: address, amount: u64, operation: vector<u8>)`          |
| `request`           | `entry request(requester: &signer, payer: address, amount: u64, operation: vector<u8>)` |
| `approve`           | `entry approve(payer: &signer, from: address, operation: vector<u8>)`                   |
| `decline`           | `entry decline(payer: &signer, from: address, operation: vector<u8>)`                   |
| `registered`        | `#[view] registered(account: address): bool`                                            |
| `profile_count`     | `#[view] profile_count(): u64`                                                          |
| `profiles`          | `#[view] profiles(start: u64, limit: u64): vector<address>`                             |
| `entry`             | `#[view] entry(from: address, operation: vector<u8>): Option<Entry>`                    |
| `activity_count`    | `#[view] activity_count(account: address): u64`                                         |
| `activity`          | `#[view] activity(account: address, before: u64, limit: u64): vector<Entry>`            |
| `credits::metadata` | `#[view] metadata(): Object<Metadata>`                                                  |

`Entry { from, to, operation, amount, kind, state }` uses the Move 2 enums `Kind { Transfer, Request }` and `State { Pending, Paid, Declined }`. The view API returns an enum value as `{ "__variant__": "Paid" }`.

Storage:

- The `App` resource at the package address holds the directory, `Table<u64, address>` with a count, and all entries, `Table<EntryKey, Entry>`, keyed by `(from, operation)`. There is no global entry counter.
- Each registered address holds a `Profile` resource with its activity, `Table<u64, EntryKey>` with a count. `activity(account, before, limit)` returns the entries with history index below `before`, newest first. The client starts with `before = activity_count`, so a new entry cannot shift a later page.

Errors are numbered constants with doc comments, so the node shows the name and text in `vm_status`: `E_ALREADY_REGISTERED` (1), `E_NOT_REGISTERED` (2), `E_INVALID_PARTICIPANTS` (3), `E_INVALID_AMOUNT` (4), `E_INVALID_OPERATION` (5), `E_OPERATION_USED` (6), `E_NOT_FOUND` (7), `E_UNAUTHORIZED` (8), `E_NOT_PENDING` (9), `E_INVALID_PAGE` (10). Insufficient credits abort in `0x1::fungible_asset` and roll back the whole transaction.

Native differences from the [contract interface](../../../docs/contract-interface.md):

- The caller is the `&signer` argument. Move has no implicit caller.
- Amounts are `u64`, the fungible-asset amount type.
- The token balance is read with the framework view `0x1::primary_fungible_store::balance`, not an app function, because any wallet reads the standard asset the same way.

Frontend:

- `src/chain/config.ts`: deployment record, RPC client, uncached ledger reads, APT formatting.
- `src/chain/session.ts`: one Ed25519 key, deployment-bound storage, intent validation, exact amounts, 32-byte operation IDs, and entry IDs (`"<from>:<operation>"`).
- `src/chain/transactions.ts`: signing, saved signed bytes, hash reconciliation, and expiry checks.
- `src/chain/errors.ts`: names the PayMVC error in a failed simulation, for example "Choose a different, registered PayMVC account." for `E_NOT_REGISTERED`.
- `src/chain/payments.ts`: view calls and entry-function construction for registration, payments, balances, and activity.
- `src/app.tsx`: maps chain data to the shared view.

Operation IDs go to the contract as bytes. The TypeScript SDK encodes a string argument for `vector<u8>` as UTF-8 text, so `operationBytes` converts the hex ID first.

[Payments](src/chain/payments.ts) reads actual fungible-asset balances. The dashboard reads the balance, the activity count, and every activity page at one ledger version from `latestLedger`, which bypasses the SDK's ledger cache. The UI reads five contacts and 50 activity entries initially. Requests reserve no funds. Only the intended payer can resolve a pending request; approval transfers the amount and changes its state atomically.

Successful immutable-package verification is shared within the page session. Reload or a new deployment configuration triggers verification again. Failed verification is never cached.

## 3. Token model

Credits are a native Aptos fungible asset with zero decimals. Each account holds credits in its primary store. Fungible assets are the current Aptos token standard and replace the legacy `coin` module. Any account can receive a direct transfer through `0x1::primary_fungible_store::transfer`; the receiver does not need to register first. Decline moves no funds, so it works even when the payer holds no credits.

## 4. Funding

Use Testnet for public verification. The [Aptos faucet](https://aptos.dev/network/faucet) may require authentication and may rate-limit requests. The public Aptos API rate-limits anonymous browser traffic, and one full scenario can exceed the limit. See the provider's current limits.

To use a keyed endpoint, set `VITE_RPC_URL` to the provider's full node API, ending in `/v1` like the public URL (for example `https://aptos-testnet.g.alchemy.com/v2/<key>/v1`, which holds its key) in `.env.local`, which Git ignores. Providers that expect the key in the `Authorization` header, such as Geomi, also need `VITE_APTOS_API_KEY`; the client sends it as a bearer token. The app, `npm run test:live`, and `npm run test:live:browser` all use it in place of the deployment's public URL. A key in `VITE_RPC_URL` or `VITE_APTOS_API_KEY` is shipped to the browser, so use a client key and restrict it to your site's origins in the provider dashboard before you host the app. The hosted site's Content Security Policy allows the public Testnet API and Alchemy's Aptos Testnet host, which the hosted site uses. For another provider, also add its host to `connect-src` in `Caddyfile.template`. The site sends no `Referer` header, so restrict the key by origin, not by referrer.

The estimated starting budget is 0.1 APT. Fee estimates can change. Application transactions cap the gas reservation at 50,000 gas units (`MAX_GAS_AMOUNT`), because the SDK default reserves 2,000,000 units. Registration uses about 19,000.

## 5. Confirmation and recovery

The general policy is in [transaction recovery](../../../docs/recovery.md).

[Transactions](src/chain/transactions.ts) saves the signed BCS transaction, hash, and preparation ledger version before submission. Storage failure stops submission. Recovery checks or resubmits those exact signed bytes. A timeout does not create a replacement payment.

Confirmation requires a committed successful user transaction and the expected application state: `entry(from, operation)` shows the expected participants, amount, kind, and state. The contract rejects a second entry with the same `(from, operation)` (`E_OPERATION_USED`), so a retry cannot pay twice. Reorganizations do not apply: Aptos consensus gives finality when a transaction commits, so the application does not use an EVM-style confirmation count. Reads after a commit use its ledger version, so a lagging node cannot hide the result. The transaction wait is bounded to 30 seconds. Failed reads retain the last displayed balance.

Before signing, the client checks that the wallet holds the maximum gas fee and simulates the call. A failed simulation is shown by its PayMVC error name, and nothing is signed. A submission that the node refuses for lack of APT keeps the saved bytes and asks for funds; the same bytes can still succeed.

Application transactions expire ten minutes after the ledger time read during preparation, so a wrong device clock does not change expiry. A sequence-number transaction has a faster proof too: if the account's committed transaction at the saved sequence number has another hash, the saved one can never commit, and the client allows a new attempt at once. Otherwise, proven expiry requires committed ledger time past the signed expiry, retained history covering preparation, a second absent-hash lookup, and current state without the operation's effect. Pruned or unavailable history leaves the outcome unknown. When the expected entry or registration is already on chain, it confirms the saved transaction directly. Definitive failure or proven expiry requires an explicit retry.

The contract emits `Registered`, `Created`, and `Resolved` events (`#[event]`). The app reads state, not events; the events let explorers and indexers follow payments.

Web Locks protect writes across tabs. Reset removes only the current local session after confirmation; it does not cancel pending transactions or erase chain state.

## 6. Deploy

```sh
aptos move publish --package-dir contracts --named-addresses paymvc=<deployer> --private-key-file <key> --url https://api.testnet.aptoslabs.com --assume-yes
```

`npm run deploy` runs that command for you:

1. It creates `.local/testnet-deployer.json` if needed and prints its address.
2. If the package is not yet published, it checks that the deployer holds at least 0.1 APT. If not, it prints the amount needed and stops. Publishing used 64,059 gas units, about 0.064 APT.
3. It runs `aptos move publish` with a temporary CLI profile under `.local/` (mode 0600), removed afterwards. The profile holds the key and the endpoint, so neither appears on a command line. `RPC_URL` can select a keyed endpoint. `Move.toml` sets `upgrade_policy = "immutable"`.
4. It finds the publish transaction among the deployer's first transactions, compiles the source for the deployer's address and checks that both published modules match it byte for byte, verifies the chain ID, the asset metadata, and the immutable policy, and writes `public/deployment.json`. The browser repeats the module hash and policy checks once per page load, and requires that the immutable package holds exactly `credits` and `paymvc`.

A rerun after publication skips step 3 and verifies again. A second publication of the same immutable package fails on-chain, so a rerun cannot replace the code. A new deployment needs a new deployer address. The session key includes the package address and publish hash, so a new deployment gets new sessions. Keep `.local/` private.

`LOCAL=1 npm run deploy` does the same against the local node; `npm run local` runs it for you.

## 7. Verification

```sh
npm run check
npm test
npm run build
npm run test:e2e
npm run test:conformance
```

`npm test` runs the Move unit tests and the Vitest unit tests in `tests/unit/`. `npm run test:e2e` starts `npm run local` and runs the browser tests in `tests/e2e/` against real local transactions. Run browser suites one at a time. `npm run test:conformance` compares the shared files, the test snapshots, and the committed evidence with the repository, so it runs only inside the repository. CI runs these commands in `.github/workflows/aptos.yml`.

Public acceptance runs against Testnet:

```sh
npm run test:live
npm run test:live:browser
```

Public acceptance uses the deployment wallet to fund independent fixture users with 0.3 APT each. One user spends about 0.055 APT at a gas price of 100 octas, so a full run (chain, desktop, and mobile: six users) needs about 1.9 APT in the deployment wallet. Chain acceptance resumes saved steps.

Both commands write `evidence/testnet.json` in the format of `evidence.schema.json`. `npm run test:live` replaces the `chain` result. `npm run test:live:browser` replaces the `browser` result for each viewport. A command keeps the other results if the deployment is the same, and starts a new file if the deployment changed. Each result records the commit (`git rev-parse HEAD`), the final balances and activity counts of users A and B, and the transaction hashes in scenario order. `npm run check` validates every file in `evidence/`.

Run live tests from a clean working tree. If this implementation has uncommitted changes, the result goes to `.local/evidence-testnet.json` instead. Local runs write `.local/evidence-localnet.json`: `LOCAL=1 npm run test:live` against a running `npm run local`, and the canonical test in `npm run test:e2e`. Evidence never contains keys or signed transactions; fixture keys stay in `.local/`. Browser traces, videos, and screenshots are disabled for wallet tests.

## 8. References

- [Aptos fungible assets](https://aptos.dev/build/smart-contracts/fungible-asset)
- [Aptos TypeScript SDK](https://aptos.dev/build/sdks/ts-sdk)
- [Aptos CLI](https://aptos.dev/build/cli)
- [Aptos faucet](https://aptos.dev/network/faucet)
