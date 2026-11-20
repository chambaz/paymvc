# Solana / Anchor

A standalone address-only payments demo using Anchor 1.2.2, Solana Kit 8.6.0, and generated Codama clients. Each session controls one disposable wallet.

## 1. Run

Use Node 24.21.0, Rust 1.98.1, Anchor 1.2.2, Solana 4.1.2, and platform-tools v1.57. Run commands from this directory:

```sh
npm ci
npm run contracts:build
npm run local
```

The launcher starts a loopback validator, initializes the mint and directory, and serves the frontend at `http://127.0.0.1:5176`. Click **Create demo wallet**, then fund its address:

```sh
solana airdrop 1 WALLET_ADDRESS --url http://127.0.0.1:8899
```

Click **Start demo** to register and receive 100 credits. Use a separate browser profile for a second user. Setup creates no other users or activity. Restarting the local validator changes its genesis hash and requires a fresh browser session.

`npm run dev` serves the Devnet frontend at port 5175. Public demos never fall back to a local validator.

The selector links every implementation. Override each link with its `VITE_<NETWORK>_URL` variable, for example `VITE_ETHEREUM_URL`. Each origin keeps its own wallet and theme preference.

## 2. Architecture

The Anchor program is in `programs/paymvc/`. `npm run contracts:build` builds it and generates `idl/paymvc.json` and the Codama client in `src/chain/generated/`. Do not edit generated files.

- `src/chain/config.ts`: deployment record, RPC client, program addresses, SOL formatting.
- `src/chain/session.ts`: one Ed25519 seed, deployment-bound storage, intent validation, exact amounts.
- `src/chain/transactions.ts`: native Kit transaction construction and signing, saved signed bytes, signature reconciliation, and expiry checks.
- `src/chain/payments.ts`: explicit program accounts, registration, directory, payments, token balances, and activity reads.
- `src/app.tsx`: maps chain data to the shared view.

### Program interface

| Instruction | Arguments                  | Rules                                                                                                 |
| ----------- | -------------------------- | ----------------------------------------------------------------------------------------------------- |
| `register`  | none                       | The signer registers itself. Creates its profile and directory member, and mints 100 credits.         |
| `send`      | `to, amount, operation`    | The signer pays `to`. Creates a Paid Transfer entry and moves the tokens in the same instruction.     |
| `request`   | `payer, amount, operation` | The signer asks `payer` for credits. Creates a Pending Request entry. Reserves no funds.              |
| `approve`   | `from, operation`          | Only `entry.to`, only Pending. Transfers `amount` to `from` and marks Paid.                           |
| `decline`   | `from, operation`          | Only `entry.to`, only Pending. Marks Declined. Takes only the payer and the entry: no token accounts. |

`Entry { from, to, operation, amount, kind, state }` lives at the PDA `["entry", from, operation]`. `Kind` is `Transfer | Request` and `State` is `Pending | Paid | Declined`.

The profile holds its owner and activity count. Registration atomically creates the profile, the associated token account when needed, and a numbered directory member. It mints 100 credits and increments the directory count.

The directory has a count account and one immutable member account per registration index. The client reads at most six members to show five other users, omitting self. Registration order is stable.

Each participant has activity accounts `["activity", owner, page]` of 32 records each. Record `i` is in page `i / 32`, at position `i % 32`, and points to an entry. A payment creates the page that holds a participant's next record when it does not exist yet (`init_if_needed`). The client reads activity with an absolute cursor: a read holds the records with index < `before`, newest first, at most 50. It starts with `before = activity_count`. A new record gets a higher index, so it never shifts a later read. Requests update their original entry, so a paid request keeps its position.

The client chooses the activity accounts from the counts it read before signing. Payments to the same person by other users land in the same page, so they do not conflict. Only a concurrent record that fills a page makes a prepared payment fail, because its next record then belongs to the next page. A concurrent registration can also invalidate a prepared directory index. Transactions skip preflight, so the stale transaction lands as a confirmed failure. It does not allocate credits, add membership, or move funds, and it clears the saved transaction. Explicit retry then reads the current counts and signs a new transaction.

The two 1 KB activity accounts in `send` and `request` are boxed, so the instruction stays within the 4 KB stack frame. `npm run contracts:build` fails if any function exceeds it, because `anchor build` only prints that error.

### Native differences from the canonical interface

- **Reads are account reads.** Solana programs do not return data to clients. The client reads the profile, directory, member, activity, and entry accounts directly. `registered`, `profile_count`, `profiles`, `entry`, `activity_count`, and `activity` are account reads in `src/chain/payments.ts`. `entry(from, operation)` is a fetch of the entry PDA that may not exist.
- **Accounts are explicit.** Each instruction lists the accounts it reads or writes. The client passes the activity accounts, because their addresses depend on the current activity counts. The generated client derives the other accounts from the arguments.
- **Some errors come from the account runtime.** The program raises `InvalidParticipants`, `InvalidAmount`, `InvalidOperation`, `Unauthorized`, and `NotPending`. The other canonical errors are native:

  | Canonical error   | Solana error                          | Cause                                                                         |
  | ----------------- | ------------------------------------- | ----------------------------------------------------------------------------- |
  | AlreadyRegistered | System `AccountAlreadyInUse` (0)      | `init` on an existing profile                                                 |
  | OperationUsed     | System `AccountAlreadyInUse` (0)      | `init` on an existing entry                                                   |
  | NotRegistered     | Anchor `AccountNotInitialized` (3012) | A missing profile account                                                     |
  | NotFound          | Anchor `AccountNotInitialized` (3012) | A missing entry account                                                       |
  | InvalidPage       | none                                  | There is no read instruction. The client limits each read to 1 to 50 records. |

- **`approve` and `decline` take `from` and `operation`** only to derive the entry address. The account constraints use them; the handlers do not.

## 3. Token model

Demo credits are a standard SPL Token mint with zero decimals. Balances come from the user's associated token account.

- The mint and its mint authority are program-derived addresses. Only the program mints, and only at registration.
- The mint has no freeze authority.
- There is no administrator mint or debit instruction.
- `send` and `approve` move credits with `transfer_checked`, signed by the payer. `decline` does not touch token accounts.
- A user can close an empty token account outside the app. Before `send` and `approve`, the client adds the associated token program's idempotent create instruction when the receiver's account is missing, so a payment to that user still lands. The payer pays its rent.
- External SPL transfers, including to unregistered accounts, change the real balance without adding app activity.

Once per page load, before the first operation, the client checks the mint owner, decimals, mint authority, and missing freeze authority.

## 4. Funding

Fund the displayed address with Devnet SOL through the linked faucet before registration. Faucets may require sign-in or impose limits.

The funding estimate includes rent for the profile, token account, and directory member, rent for eight entries and two activity accounts, and fees. It is at least 0.05 SOL. The wallet is saved before funding or transactions start. Before it signs a payment, the client checks that the wallet can pay the fee and the rent of the accounts that the payment creates. If not, it asks for more SOL and signs nothing.

Transactions set no priority fee, so they use the default compute unit limit at no extra cost. `tests/payments.rs` checks that each instruction stays well below it.

## 5. Confirmation and recovery

The general policy is in [transaction recovery](../../../docs/recovery.md).

- Signed bytes, the signature, and `lastValidBlockHeight` are saved before broadcast.
- Confirmation requires a `confirmed` signature status and the expected program state. It is not finality.
- Retry checks the original signature and may rebroadcast the same bytes.
- The client polls the signature status every 2 s and rebroadcasts the saved bytes at most every 5 s. A failed read is not proof of anything: the client keeps waiting for up to 90 s, then reports an unknown outcome.
- The public devnet RPC limits requests per IP address. Every RPC client retries an HTTP 429 or 503 response up to four times. It waits for `Retry-After` when the response has it, up to 15 s, otherwise 1, 2, 4, and 8 s. Browsers cannot read devnet's `Retry-After`, so this fallback (15 s in total) must outlast devnet's 10 s block.
- A new signature is allowed only after the finalized block height passes the saved expiry and a second history lookup finds no transaction. That lookup counts only if its context slot is at or after the finalized slot, because the public RPC balances requests across nodes that can lag. A confirmed failure also permits explicit retry.
- After confirmation, the client reads the expected state with `minContextSlot` set to the confirmation slot, so a lagging node cannot hide it.
- Permanent entry PDAs from `(from, operation)` prevent duplicate payments. Retry reconciliation fetches the same PDA. If a new attempt lands as a failure because an earlier attempt already created the entry or resolved the request, the client reads the entry from that slot and reports the earlier success.

Setup makes one automatic recheck after five seconds for an unknown outcome or a delayed registration result. Interactive operations make one recheck for delayed application state. Further recovery needs user action.

Failed reads keep the last balance with a stale indicator. Activity reads use `confirmed` commitment in batches of at most 50. Separate reads are not an atomic snapshot.

The network genesis hash, the program, and the mint settings are verified once per page load, before the first operation. The program must be owned by the upgradeable loader with no upgrade authority, so it cannot change under existing sessions. Sessions bind to the genesis hash and program address. A new program version needs a new program address.

Keys stay in browser storage and local signing inputs. Web Locks permit one writer tab. Reset removes this session's local access. It cannot cancel transactions or remove chain state. Signing keys never belong in logs, URLs, APIs, commits, or test artifacts.

## 6. Deploy

```sh
solana program deploy target/deploy/paymvc.so --program-id .local/paymvc-program.json \
  --buffer .local/paymvc-buffer.json --use-tpu-client --final \
  --commitment confirmed --with-compute-unit-price 1000 \
  --url https://api.devnet.solana.com --keypair .local/deployer.json
```

`npm run deploy` runs that command, then `scripts/initialize.ts`. Run `npm run contracts:build` first.

- Builds use the declared program ID without its private key. The deployment needs the matching key in `.local/paymvc-program.json`.
- For a new program, generate a key with `solana-keygen new --outfile .local/paymvc-program.json`. Put its address in `declare_id!` and `Anchor.toml`, then rebuild. A new program ID gives every browser a new session.
- `--final` removes the upgrade authority. The program can never change, and the browser refuses a program that still has an authority. Local validators load the program the same way.
- The deploy script uses `.local/deployer.json` and the buffer key `.local/paymvc-buffer.json`. It prints the deployer address and balance. Rent is (bytes + 128) × 6,960 lamports per account. For the current 295 KB program, the buffer and the program data need about 2.1 SOL each, so the deployer needs about 4.2 SOL plus fees. The buffer rent returns after deployment.
- If an upload stops, rerun. The CLI resumes into the same buffer.
- Initialization signs with the deployer key, saves the signed bytes before broadcast, and reconciles them on rerun. It writes the verified configuration to `public/deployment.json`.
- `RPC_URL` selects a public browser-accessible Devnet endpoint. Do not publish provider secrets. Keep all keys private.

## 7. Verification

```sh
npm run check
npm test
npm run build
npm run test:e2e
npm run test:conformance
cargo clippy --all-targets --all-features --locked -- -D warnings
```

Build the program before tests. Rust tests run the actual SBPF program in LiteSVM. They cover the mint settings, a second initialization, substituted profiles, mints, and token accounts with their exact errors, activity pages under concurrent payments, and the compute units of each instruction. Unit tests are in `tests/unit/`. Browser tests in `tests/e2e/` use real validator transactions and independent A/B sessions. Run browser suites one at a time. Traces and videos are off to keep keys out of artifacts. Local tests do not prove public-testnet acceptance.

This directory can be copied on its own. `npm run test:conformance` compares the shared files, the test snapshots, and the committed evidence with the repository, so it runs only inside the repository. Production code never imports sibling implementations.

### Live evidence

The live commands run the shared scenario on Solana devnet with two new users, A and B. Each pass ends at 85 and 115 credits with four activity rows per user.

```sh
npm run test:live          # the scenario through the chain module
npm run test:live:browser  # the scenario in the browser, desktop and mobile
```

- The deployer in `.local/deployer.json` funds each user with the app's funding budget (0.05 SOL). A full run (chain and two viewports) creates six users and needs about 0.3 SOL plus fees.
- The commands write `evidence/devnet.json` in the format of `evidence.schema.json`. `test:live` replaces `chain`. `test:live:browser` replaces `browser`. A command keeps the other section only while the deployment is the same.
- Run from a commit with no uncommitted changes in this folder (`evidence/` excepted), so that `revision` is the tested code. Otherwise the commands write `.local/evidence-devnet.json` instead.
- `LOCAL=1` runs against `npm run local` and writes `.local/evidence-localnet.json`. Start `npm run local` before `LOCAL=1 npm run test:live`. The browser command starts it if it is not running.
- `LIVE_RUN=name` uses new users for `test:live`. Private sessions and signed transactions stay in `.local`. Evidence holds no keys, signed transactions, or browser profiles. `npm run check` validates every evidence file.

## 8. References

- [Anchor account constraints](https://www.anchor-lang.com/docs/references/account-constraints)
- [Solana Kit](https://www.solanakit.com/)
- [SPL Token](https://www.solana-program.com/docs/token)
- [Codama](https://github.com/codama-idl/codama)
- [LiteSVM](https://www.litesvm.com/)
