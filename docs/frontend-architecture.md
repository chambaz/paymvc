# Frontend architecture

Every implementation uses the same React and TypeScript layout. Shared files are identical in every implementation. Chain-specific code is in `src/chain/` and `src/app.tsx` only. The EVM implementation also has `src/networks/`, which configures its four networks. To compare two chains, compare those two places.

## Layout

```text
src/
  main.tsx                    loads the deployment record and renders App
  app.tsx                     connects the chain module to the shared view (chain-specific)
  hooks/use-demo.ts           session, queries, writes, and recovery (shared)
  components/                 the whole interface; no chain code (shared)
    payments-view.tsx         the page: header, setup, and dashboard
    payment-dialog.tsx        the Send and Request dialog
    reset-dialog.tsx          Reset Demo and its confirmation
    feedback.tsx              progress, notices, errors, and recovery actions
    entry-summary.tsx         one activity row
    address.tsx               short addresses and the copy button
    theme-toggle.tsx
    ui/                       shadcn/ui components
  chain/                      all chain code: keys, signing, reads, writes (chain-specific)
    config.ts
    session.ts
    transactions.ts
    payments.ts
    errors.ts                 user-facing error messages
    generated/                bindings generated from the contract build
    recovery.ts               the bounded recheck policy (shared)
  lib/utils.ts                (shared)
  styles.css                  (shared)
index.html                    the page head: icons and link preview tags (shared)
public/
  theme.js                    applies the saved theme before render (shared)
  favicon.svg, favicon.ico,   the site icons, made in web/ (shared)
  apple-touch-icon.png
```

`src/chain/generated/` holds the ABI, IDL client, or CLI bindings for the contract. Never edit it by hand; regenerate it from the contract build.

## Data flow

1. `main.tsx` fetches the public deployment record, validates it, and renders `App`.
2. `app.tsx` calls `useDemo(config)`, maps chain data to view rows, validates form input, and renders `PaymentsView`.
3. `use-demo.ts` owns the session, the React Query reads, and the single-writer tab lock. It runs one write at a time and rejects a second one. It calls the chain module for every chain operation.
4. `chain/payments.ts` builds each operation and checks its on-chain effect. `chain/transactions.ts` signs, saves, broadcasts, and confirms.
5. `PaymentsView` renders props and reports user actions. It never calls the chain.

## Chain module

Each implementation exports the same names. A chain can add helpers, but it must not rename these.

| Module            | Exports                                                                                                                                                                | Responsibility                                                                                                              |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `config.ts`       | `Deployment`, `parseDeployment`, `deploymentKey`                                                                                                                       | Validate the deployment record. Create RPC clients. Build the session storage key from the network and deployment identity. |
| `session.ts`      | `Session`, `Intent`, `newSession`, `loadSession`, `saveSession`, `accountFor`, `parseAmount`, `operationId`                                                            | Create, validate, and store the disposable wallet and its transaction journal. Validate amounts. Create operation IDs.      |
| `transactions.ts` | `transact`, `Progress`, `UnknownOutcome`, `BroadcastUnavailable`, `ResultPending`, `RevertedTransaction`, and `ExpiredTransaction` where the chain has expiry          | Sign, save before broadcast, broadcast, confirm, and reconcile. See [transaction recovery](recovery.md).                    |
| `payments.ts`     | `payments(config, session, persist, progress)` returning `{ setup, execute }`, `verifyDeployment`, `fundingBudget`, `FundingRequired`, `readContacts`, `readDashboard` | Register, send, request, approve, and decline, and verify each effect. Read contacts, balance, and activity.                |
| `recovery.ts`     | `recheckOnce`                                                                                                                                                          | One automatic recheck, then explicit user action. Shared.                                                                   |

### `transact`

Every chain uses the same first five arguments, then its own:

```ts
transact(config, session, persist, progress, label, ...chainArguments);
```

`label` names the journal record. The label of every record for a payment operation starts with its operation ID, so the shared hook can find and remove them. Every `transact` reports at least two progress messages: `Preparing transaction` before it signs, and `Waiting for confirmation` after it saves the signed transaction. A chain can add others, such as Thruput's `Checking the original transaction` when it reconciles a saved transaction.

## Session

The session is stored in `localStorage` under the deployment key. It holds:

- the disposable private key
- whether setup is complete
- the transaction journal: signed bytes and hashes, saved before broadcast, plus any data the chain needs to prove expiry
- the current unresolved intent, if any

The key never leaves the browser. It never appears in logs, URLs, API calls, errors, or test artifacts. Web Locks allow one writer tab per session; other tabs are read-only.

## Shared files

These files must be identical in every implementation:

- `src/hooks/use-demo.ts`
- every file in `src/components/`
- `src/chain/recovery.ts`
- `scripts/validate-manifest.ts`, which checks `implementation.json` and the evidence files
- `src/lib/utils.ts`
- `src/styles.css`
- `index.html`, which holds the icon links and the link preview tags
- `public/theme.js`
- `public/favicon.svg`, `public/favicon.ico`, and `public/apple-touch-icon.png`, copies of the files that `web/scripts/assets.mjs` makes

A change to one of these files must be applied to every implementation in the same pull request. `node conformance/verify.mjs` checks them: run it from the repository root to check every implementation, or from one implementation folder to check that folder.
