# Testing

Tests check what users see, not internal layouts. Every implementation runs the same shared scenario, plus contract, unit, browser, and live-testnet tests.

## Shared scenario

`conformance/scenario.ts` defines the scenario. Each implementation keeps a copy in `tests/conformance/` and supplies a driver for its chain.

Two users, A and B, use separate browser contexts. Each creates and funds only its own wallet, registers normally, and finds the other by full address. A and B are test labels only; the app never stores names. Both start with 100 credits and no activity.

| Step | Action                                                               |   A |   B | Activity each |
| ---- | -------------------------------------------------------------------- | --: | --: | ------------: |
| 1    | A sends B 7                                                          |  93 | 107 |             1 |
| 2    | B requests 20 from A; A approves                                     |  73 | 127 |             2 |
| 3    | B requests 5 from A; A declines                                      |  73 | 127 |             3 |
| 4    | A requests 9 from B; B approves                                      |  82 | 118 |             4 |
| 5    | Reload both; identities, requests, balances, and order are unchanged |  82 | 118 |             4 |
| 6    | B transfers 3 to A outside PayMVC                                    |  85 | 115 |             4 |
| 7    | Reset A with confirmation; B is unchanged; A's next wallet is new    |     |     |               |

Use a fresh local deployment for a fixed contact order. Public runs must allow for other registered users.

`conformance/recovery.test.ts` checks the shared recovery policy: one automatic recheck, then explicit action, and no writes after the view unmounts.

## Contract tests

Cover at least:

- One 100-credit allocation per account, and registration authorized by that account.
- One directory entry per account; stable bounded pages; duplicate registration.
- Conservation for transfers; invalid amounts (zero, too large); insufficient funds.
- Unauthorized debits, self-transfers, and unregistered participants.
- Duplicate operation IDs, and distinct operations with the same values.
- Request creation; approval only by the intended payer; atomic approval; decline; insufficient funds leaves the request pending.
- Final states, and two competing resolutions with at most one success.
- External token transfers change balances without app activity.

## Browser tests

Run against a local chain with real transactions. Cover:

- The shared scenario at 390×844 and 1440×1000.
- Interrupted registration, pending and unknown outcomes, a definite failure, and the saved-transaction retry.
- Stale reads keep the last balance.
- Reset, a read-only second tab, and switching implementations.
- Contact pagination: self at a page boundary, a registration between reads, selection kept while pages load, and a read failure.
- The payment dialog: input kept on error and on mode change, automatic close on success.
- Axe checks for the [interface states](ui.md#transaction-states) in light and dark mode.

Use fixed fonts, locale, timezone, animation settings, and test addresses.

### Visual baselines

Light and dark mode screenshots of the [interface states](ui.md#transaction-states) live only in the EVM implementation (`tests/visual/`). The view is byte-identical in every implementation, and `conformance/verify.mjs` enforces this. The suite uses the UI fixture and needs no local chain. It runs only in the official Playwright Docker image, so every machine renders the same pixels:

```sh
npm run test:visual         # compare
npm run test:visual:update  # regenerate
```

A person must review every baseline change. Never update a baseline to hide a regression.

Failure injection (for example, a failing RPC) is allowed only in tests. Fixture data is never a production fallback.

## Live tests

Live tests run the shared scenario on the public testnet with real transactions:

```sh
npm run test:live          # chain scenario
npm run test:live:browser  # browser scenario
```

They never reset or fund through debug RPC methods. A faucet outage is a failed run, not a pass. Report a testnet outage apart from an implementation failure.

## Evidence

Each implementation commits one evidence file per public network: `evidence/<network>.json`, for example `evidence/base.json`. The file follows `conformance/evidence.schema.json`:

- `deployment`: the public contract addresses or IDs
- `chain`: the result of `npm run test:live`
- `browser`: one result per viewport from `npm run test:live:browser`

Each result records the tested commit (`revision`), the date, the final balances and activity counts of users A and B, and the transaction hashes in scenario order. A pass ends at 85 and 115 credits with four activity rows each.

Run live tests from a clean working tree, so that `revision` is the code that was tested. A new run replaces the old result; Git keeps the history. Evidence never contains keys, signed transactions, browser profiles, or traces.

## Repository checks

`conformance/verify.mjs` checks that each implementation's shared files and its copies of the test files and schemas match, and that evidence files have the required fields and no private material. Run it through each implementation's `npm run test:conformance`.

Each implementation also runs its own checks:

```sh
npm run check
npm test
npm run build
npm run test:e2e
```
