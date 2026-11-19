# Stellar / Soroban

Standalone single-wallet PayMVC browser and contracts for Stellar Testnet. This folder can be copied and run without another implementation.

## 1. Run

Use Node 24.21.0, Rust 1.96.0, Stellar CLI 30.0.1, and Soroban SDK 29.0.1 (locked in Cargo.toml). Install the Rust `wasm32v1-none` target. Build contracts with `stellar contract build`; bare `cargo build` does not process this SDK's contract specifications.

```bash
npm ci
rustup target add wasm32v1-none
npm run contracts:build
npm run dev
```

Open http://127.0.0.1:5181. Select Create demo wallet, open Friendbot, then select Start demo. Use independent browser profiles for independent users.

### Local network

Repeatable browser tests use Docker's Stellar Quickstart network (Core, RPC, Horizon, and Friendbot). The launcher pins the image digest and binds port 8000 to loopback. It reuses an existing container without clearing its ledger.

```bash
npm run local
curl -sS http://127.0.0.1:8000/rpc -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}'
# Once healthy:
LOCAL=1 npm run deploy
VITE_DEPLOYMENT_URL=/local.json npm run dev
```

Local passphrase: `Standalone Network ; February 2017`. RPC: `http://127.0.0.1:8000/rpc`. Horizon: `http://127.0.0.1:8000`. Friendbot: `http://127.0.0.1:8000/friendbot`.

## 2. Architecture

Chain code is in `src/chain/`:

- `config.ts` validates the deployment record, creates the RPC client, and formats XLM amounts.
- `session.ts` creates, validates, and stores the disposable key, the transaction journal, and the unresolved intent. `isAddress` is the one address rule for account (`G…`) and contract (`C…`) addresses, because a contract can register itself.
- `transactions.ts` builds, simulates, signs, saves, submits, and reconciles native transactions. `readContract` reads through simulation.
- `payments.ts` handles setup, sends, requests, approvals, and declines, and checks each on-chain effect. It also reads contacts, balance, and activity.
- `generated/specs.ts` holds the contract specs that `npm run contracts:build` reads from the WASM. The client encodes every argument and decodes every result with them (`contract.Spec`), so the app always matches the contract types. Do not edit it; `npm run check` fails if it is out of date.
- `errors.ts` names the contract error in a failed simulation, for example `Error(Contract, #2)` becomes "Choose a different, registered PayMVC account."

`src/hooks/use-demo.ts` handles the browser lifecycle. `scripts/deploy.ts` runs the Stellar CLI deployment.

### Contract interface

`contracts/paymvc` implements the canonical interface:

| Function       | Signature                                                   |
| -------------- | ----------------------------------------------------------- |
| register       | `register(owner)`                                           |
| send           | `send(from, to, amount: i128, operation: BytesN<32>)`       |
| request        | `request(from, payer, amount: i128, operation: BytesN<32>)` |
| approve        | `approve(payer, from, operation)`                           |
| decline        | `decline(payer, from, operation)`                           |
| registered     | `registered(account) -> bool`                               |
| profile_count  | `profile_count() -> u64`                                    |
| profiles       | `profiles(start: u64, limit: u32) -> Vec<Address>`          |
| entry          | `entry(from, operation) -> Option<Entry>`                   |
| activity_count | `activity_count(account) -> u64`                            |
| activity       | `activity(account, before: u64, limit: u32) -> Vec<Entry>`  |
| token          | `token() -> Address` (the credits contract)                 |

`Entry { from, to, operation, amount, kind, state }`. `Kind { Transfer, Request }` and `State { Pending, Paid, Declined }` are `#[contracttype]` enums. Errors: `AlreadyRegistered`, `NotRegistered`, `InvalidParticipants`, `InvalidAmount`, `InvalidOperation`, `OperationUsed`, `NotFound`, `Unauthorized`, `NotPending`, `InvalidPage` (codes 1 to 10). The credits contract numbers its errors from 100, so a token error that passes up through `send` or `approve` cannot look like a PayMVC error.

Events (`#[contractevent]`): `Registered { account }`, `Created { from, to, operation, amount, kind }`, and `Resolved { from, operation, state }`. The app reads state, not events; the events let explorers and indexers follow payments.

Native deviations from the canonical interface:

- **Explicit caller.** Soroban has no implicit caller. Each write names its signer (`owner`, `from`, or `payer`) and calls `require_auth` on it. `approve` and `decline` take `payer` first; a signer that is not the request's `to` gets `Unauthorized`.
- **Amount type.** `i128`, the SEP-41 amount type.
- **Token address.** `token()` returns the credits contract that the app constructor deployed.

### Storage

An entry is stored under its key `(from, operation)`; there is no global entry ID. Each account has an activity count and a numbered list of `(from, operation)` keys. `activity` returns the entries with index below `before`, newest first. The client starts with `before = activity_count` and continues below the oldest row it read, so a new record cannot shift a later page.

Registration atomically adds membership, appends the address to the directory, and mints exactly 100 credits. The directory count and the token address are in instance storage. Profiles, directory members, entries, and activity are in persistent storage. Directory pages contain at most 50 addresses in registration order. The frontend reads at most six entries to show five other addresses, excludes self, and retains recipient selection during pagination.

Every write extends the TTL of the contract instance and of each persistent entry it writes, toward 518,400 ledgers (capped by the network maximum). A payment also extends both participants' profiles, so active users stay live. Each crate has one TTL helper, `keep`. Reads do not extend TTL: they are simulations, so an extension would not persist. Archived persistent entries keep their identity and are restored, never treated as a new profile or an unused operation. Since Protocol 23, simulation restores archived entries that a contract call needs automatically. If simulation still returns a separate restore preamble, the client reports that a restore is needed instead of signing.

## 3. Token model

PayMVC uses a custom zero-decimal SEP-41 contract, not the Stellar Asset Contract (SAC). The SAC always has 7 decimals, so external transfers could create fractional balances that the app cannot show as whole credits. The SAC also needs an issuer account and trustlines: a direct transfer to an unregistered account would fail until that account adds a trustline.

`contracts/credits` implements SEP-41 with zero decimals. The PayMVC constructor deploys it with the app as its immutable mint authority, so only `register` can mint. It has no upgrade entry point. Credits are separate from XLM fees and account reserves. Standard transfers support unregistered recipients, allowances, and muxed addresses. SEP-41 also requires authorized burn methods; these are native token methods, not PayMVC actions. External token transfers and burns change balances without adding app activity. `decline` does not call the token contract.

Balances use persistent storage; writes extend their TTL. Allowances use temporary storage and expire after the approved ledger.

## 4. Funding

Public demos use Stellar Testnet with passphrase `Test SDF Network ; September 2015`. Friendbot creates and funds a test account. The browser saves one disposable signing key locally before funding. Use this wallet only for test assets.

The displayed funding requirement is 5 XLM: 1 XLM for the account's minimum balance, up to 2.5 XLM for the call that extends the contract TTL (about every 15 days), and fees. Other registrations and payments cost from 0.0004 to 0.06 XLM each on Testnet. Friendbot sends 10,000 XLM. Registration allocates 100 credits once and adds the address to the directory. Setup creates no contacts or activity.

## 5. Confirmation and recovery

`src/chain/transactions.ts` simulates each contract call before signing to obtain resources, fees, and restoration requirements. A failed simulation is reported by its contract error name, and nothing is signed. The inclusion fee is the network's recent 90th percentile (`getFeeStats`), from 0.001 to 0.01 XLM, so a transaction lands under surge pricing instead of expiring. The client saves the envelope, hash, and preparation ledger before broadcast. Confirmation requires RPC `SUCCESS` in a closed ledger, followed by an application-state check. Stellar uses consensus finality rather than an EVM-style confirmation depth; this threshold still depends on the connected RPC and network.

Signed envelopes have a 180-second lifetime based on ledger time. A missing transaction proves expiry only when the latest closed ledger is past its deadline and the RPC's oldest retained ledger covers its preparation ledger. If history is incomplete, retain the evidence and report uncertainty. Retry checks the same hash and can rebroadcast the same bytes. Proven expiry or failure requires explicit retry; the application operation ID stays unchanged. Before a new submission, the client looks up `entry(from, operation)`: an existing entry with the expected state proves that an earlier transaction landed, and the contract rejects a second entry with `OperationUsed`. That proof also confirms a saved transaction that RPC history no longer covers (about seven days by default), so an old unknown outcome resolves without a hash lookup. Setup does the same with `registered`.

The browser verifies the network passphrase, both WASM hashes, the token address, and its zero decimals once per page load, before the first operation. It reads the XLM balance from the RPC (`getAccountEntry`), so the app needs no Horizon server.

The browser uses Web Locks for one writer per session. Reload restores saved identities and unresolved operations. Setup performs one automatic recheck for unknown or delayed outcomes; interactive actions recheck delayed state once. Further recovery requires explicit retry. Reset clears only this deployment's browser session and does not cancel chain transactions.

## 6. Deploy

The deployment uses the Stellar CLI:

```bash
stellar contract upload --wasm target/wasm32v1-none/release/demo_credits.wasm --optimize=false
stellar contract upload --wasm target/wasm32v1-none/release/paymvc.wasm --optimize=false
stellar contract deploy --wasm-hash <paymvc hash> --salt <salt> -- --token_wasm <credits hash>
```

`npm run deploy` runs these commands (each with `--source-account deployer` and the network's RPC and passphrase). The PayMVC constructor deploys the credits contract. The script then only verifies the deployment and writes `public/deployment.json`.

```bash
npm run contracts:build
npm run deploy             # Testnet
LOCAL=1 npm run deploy     # local network, writes public/local.json
npm run test:live
npm run test:live:browser
```

The script:

1. Creates the `deployer` CLI identity if it is missing and funds it with Friendbot when it has less than 100 XLM.
2. Uploads both WASM files and checks that each returned hash equals the SHA-256 of the local file.
3. Computes the contract ID from the deployer and a saved salt (`stellar contract id wasm`). It deploys only if that contract does not exist yet.
4. Verifies the network, code hashes, token address, and zero decimals, then writes the record.

A re-run is safe: an upload of existing code is a no-op, and the fixed salt makes a confirmed deployment visible instead of creating a second one. The CLI configuration (deployer key and salts) is in `.local/cli-<network>/`. Keep this directory private. New contract code gets a new salt and a fresh deployment. To redeploy the same code, delete its `.salt` file. `RPC_URL` can select another Testnet RPC.

`npm run test:live` stores the private A/B sessions under `.local/live-v2-<network>-<contract>-<run>/`. Set `LIVE_RUN` to a new name for fresh identities. Friendbot funds users A and B in both live commands; the deployer does not fund them. Testnet resets invalidate deployments and sessions; redeploy and reset the browser after a network reset.

## 7. Verification

```bash
npm run check
npm test
cargo clippy --all-targets --all-features --locked -- -D warnings
npm run build
npm run test:e2e
npm run test:conformance
LOCAL=1 npm run test:live
LOCAL=1 npm run test:live:browser
```

Rust contract tests run without Docker. Build the credits WASM before running tests: app tests deploy it through the real constructor. Unit tests are in `tests/unit/`.

Browser tests need the local network and `LOCAL=1 npm run deploy` (see [Local network](#local-network)). Run browser suites sequentially. `test:e2e` starts a separate frontend on port 5182 and uses `public/local.json`. Traces and video are disabled to keep local signing data out of artifacts. `npm run test:conformance` compares the shared files, the test snapshots, and the committed evidence with the repository, so it runs only inside the repository.

### Evidence

`npm run test:live` (chain) and `npm run test:live:browser` (desktop and mobile) run the shared scenario on Testnet and write `evidence/testnet.json` in the format of `evidence.schema.json`. Each command replaces only its own section. If the deployment changed, the file starts again. `scripts/evidence.ts` reads the final balances and activity counts from the contracts and the transaction hashes, in scenario order, from Horizon. It validates the file before it writes it. `npm run check` validates every `evidence/*.json`.

Run live commands with no uncommitted changes in this folder, so that `revision` is the tested commit. Changes in `evidence/` and in other implementations do not count. With uncommitted changes here, or with `LOCAL=1`, the commands write `.local/evidence-<network>.json` instead.

## 8. References

- [Stellar development setup](https://developers.stellar.org/docs/build/smart-contracts/getting-started/setup)
- [State archival and restoration](https://developers.stellar.org/docs/learn/fundamentals/contract-development/storage/state-archival)
- [Soroban SDK](https://docs.rs/soroban-sdk/29.0.1/soroban_sdk/)
