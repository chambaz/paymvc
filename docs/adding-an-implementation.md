# Add an implementation

This guide explains how to add PayMVC for a new chain or framework. Read the [specification](../SPEC.md) first. A pull request that follows these steps is ready for review.

## What an implementation is

An implementation is one self-contained folder:

```text
implementations/<chain>/<framework>/
```

For example, `implementations/solana/anchor`. The folder contains everything for that chain:

- the contract or program, and its tests
- the React frontend, with its own signing, reads, and writes
- deployment scripts and the public deployment record
- unit, browser, and live-testnet tests
- a README and an `implementation.json` manifest

A developer must be able to copy the folder out of the repository, then install, run, test, build, and deploy it. Do not import code from another implementation. Do not use symlinks or scripts that call into sibling folders. The one exception is `npm run test:conformance`: it compares the folder with the shared files, so it runs only inside the repository.

If a new network uses the same execution model as an existing implementation, add a network configuration instead of a new folder. For example, Base, Monad, and Robinhood Chain are network configurations in `implementations/ethereum/foundry/src/networks/`.

## Two rules

**Same app.** All implementations share the same screens, behavior, names, and data shapes. A reader compares two folders and sees only what the platforms do differently.

**Best on each chain.** Use the platform's native tools and normal patterns. If the chain has a better mechanism, use it, even when other chains cannot. Examples are batched calls, signer authorization, object ownership, and storage that is safe for parallel execution. Do not copy another chain's workaround. Document each difference in your README and in the [comparison](comparison.md).

## Steps

### 1. Start from an existing implementation

Copy the implementation closest to your chain. Keep the file layout from [frontend architecture](frontend-architecture.md).

These files are shared. Copy them without changes:

- `src/hooks/use-demo.ts`
- every file in `src/components/`
- `src/chain/recovery.ts`
- `scripts/validate-manifest.ts`, which checks `implementation.json` and the evidence files
- `src/lib/utils.ts`
- `src/styles.css`
- `index.html`, which holds the icon links and the link preview tags
- `public/theme.js`
- `public/favicon.svg`, `public/favicon.ico`, and `public/apple-touch-icon.png`, copies of the files that `web/scripts/assets.mjs` makes
- `tests/conformance/*`
- `implementation.schema.json` and `evidence.schema.json`

If a shared file must change, change it in every implementation in the same pull request.

### 2. Write the contract

Follow [contract requirements](contract-interface.md). In summary:

- Registration records the caller once and allocates 100 credits atomically.
- Credits use the chain's standard fungible token with zero decimals. If you use another model, explain why in your README.
- Send, request, approve, and decline follow the rules for authorization, amounts, and states.
- The directory and the activity history are readable on-chain in bounded pages.

Write contract tests for authorization and failure paths, not only the happy path. See [testing](testing.md).

### 3. Write the chain module

Replace the contents of `src/chain/` with your chain's code. Keep the same module names and exports. `src/app.tsx` connects the chain module to the shared view.

Follow [transaction recovery](recovery.md). Save each signed transaction before you broadcast it. Never issue a second payment when the outcome of the first is unknown.

### 4. Deploy to a public testnet

- Add a `deploy` script that a maintainer can run again safely.
- Commit the public deployment record (for example `public/deployment.json`). Never commit keys.
- Verify the deployment in the browser before the first write: network identity, contract code, and token settings.
- Link a faucet. If the faucet needs sign-in or has limits, say so in your README.
- Add `railpack.json` with `"provider": "node"`. The hosted site is the static frontend build, so contract files such as `Cargo.toml` must not change how it builds.

### 5. Add the chain to the selector

Every implementation's selector lists all implementations. Add yours to the `implementations` list in `src/components/payments-view.tsx`, with a `VITE_<CHAIN>_URL` variable and a local port, and copy the changed file to every implementation. Then:

- Add your destination to the `switching.spec.ts` browser test in each implementation, and to the destination list in Thruput's selector test (`tests/e2e/payments.spec.ts`).
- Set `VITE_<CHAIN>_URL` to your hosted address in the hosting settings of every implementation's site. On Railway, these are service variables. The landing page links only the EVM demo; add your chain to it as described in step 8.

Use the next free ports from this table: one for `npm run dev`, and the next one for the browser tests. Some implementations also serve `npm run local` on their browser test port.

| Implementation        | `npm run dev` | Browser tests |
| --------------------- | ------------- | ------------- |
| Landing page (`web/`) | 5170          |               |
| Ethereum              | 5173          | 5174          |
| Solana                | 5175          | 5176          |
| Base                  | 5177          |               |
| Monad                 | 5179          |               |
| Stellar               | 5181          | 5182          |
| Sui                   | 5183          | 5184          |
| Aptos                 | 5185          | 5186          |
| Robinhood             | 5187          |               |
| Thruput               | 5189          | 5190          |
| EVM network tests     |               | 5198          |
| EVM visual tests      |               | 5199          |

The four EVM networks share one browser test port.

### 6. Test

- Contract tests: see [testing](testing.md#contract-tests).
- Unit tests: amounts, sessions, transactions, and recovery.
- Browser tests: the shared scenario with two independent users, at desktop and mobile sizes, in light and dark mode.
- Live test: the shared scenario on the public testnet.

### 7. Record evidence

Run the live tests on the public testnet and commit the evidence file. See [testing](testing.md#evidence).

### 8. Document

Add the implementation to each place that lists the implementations:

- the tables in `README.md` and `docs/README.md`
- the three tables in `docs/comparison.md` and its native differences
- the per-chain table in `docs/recovery.md`
- the native differences table in `docs/contract-interface.md`
- the selector order in `docs/ui.md`
- the network list in `web/src/main.tsx`, with a monochrome icon in `web/src/assets/networks/` and its source in `web/src/assets/README.md`
- the `networks` list in `web/scripts/assets.mjs`, which draws the link preview image. Run `npm run assets` in `web/` and commit the new `web/public/og.png`.

Write a README with these sections:

1. Run
2. Architecture
3. Token model
4. Funding
5. Confirmation and recovery
6. Deploy
7. Verification
8. References

Add `implementation.json`. It must validate against `implementation.schema.json`.

### 9. Add CI

Copy an existing workflow in `.github/workflows/` and change the folder, the `paths` filters, and the toolchain steps. It runs `npm run check`, `npm test`, `npm run build`, `npm run test:e2e`, and `npm run test:conformance`. Pin each action to a commit SHA, and pin and verify each toolchain: check a download against its published SHA-256, or install an exact version with a lock file (for example `cargo install --locked`).

## Pull request checklist

- [ ] The folder runs, tests, builds, and deploys after you copy it out of the repository.
- [ ] Shared files are unchanged, or changed in every implementation.
- [ ] The contract meets [contract requirements](contract-interface.md), with tests for authorization and failure paths.
- [ ] The frontend uses the same module layout and exports.
- [ ] Signed transactions are saved before broadcast, and recovery follows [transaction recovery](recovery.md).
- [ ] No key appears in logs, URLs, APIs, commits, or test artifacts.
- [ ] The token model uses the chain's standard token with zero decimals, or the README explains why not.
- [ ] The selector lists the new implementation in every implementation, with a free port.
- [ ] The README tables, the docs tables, and the landing page list the new implementation.
- [ ] Browser tests pass at desktop and mobile sizes, in light and dark mode.
- [ ] The shared scenario passes on the public testnet, and the evidence file is committed.
- [ ] The README has the standard sections and documents each native difference.
- [ ] `implementation.json` validates against the schema.
- [ ] CI runs the implementation's checks.
