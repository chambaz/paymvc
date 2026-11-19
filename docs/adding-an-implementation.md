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
- `implementation.schema.json`

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

Every implementation's selector lists all implementations. Add yours to the list in `src/components/payments-view.tsx`, give it a local port, and copy the changed file to every implementation.

### 6. Test

- Contract tests: see [testing](testing.md#contract-tests).
- Unit tests: amounts, sessions, transactions, and recovery.
- Browser tests: the shared scenario with two independent users, at desktop and mobile sizes, in light and dark mode.
- Live test: the shared scenario on the public testnet.

### 7. Record evidence

Run the live tests on the public testnet and commit the evidence file. See [testing](testing.md#evidence).

### 8. Document

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
- [ ] The selector lists the new implementation in every implementation.
- [ ] Browser tests pass at desktop and mobile sizes, in light and dark mode.
- [ ] The shared scenario passes on the public testnet, and the evidence file is committed.
- [ ] The README has the standard sections and documents each native difference.
- [ ] `implementation.json` validates against the schema.
- [ ] CI runs the implementation's checks.
