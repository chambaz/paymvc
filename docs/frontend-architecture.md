# Frontend architecture

Every implementation uses the same React and TypeScript layout. Shared files are identical in every implementation. Chain-specific code is in `src/chain/` and `src/app.tsx` only. The EVM implementation also has `src/networks/`, which configures its four networks. To compare two chains, compare those two places.

## Layout

```text
src/
  main.tsx                    loads the deployment record and renders App
  app.tsx                     connects the chain module to the shared view (chain-specific)
  hooks/use-demo.ts           session, queries, writes, and recovery (shared)
  components/
    payments-view.tsx         the whole interface; no chain code (shared)
    theme-toggle.tsx          (shared)
    ui/                       shadcn/ui components (shared)
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
public/
  theme.js                    applies the saved theme before render (shared)
```

`src/chain/generated/` holds the ABI, IDL client, or CLI bindings for the contract. Never edit it by hand; regenerate it from the contract build.

## Data flow

1. `main.tsx` fetches the public deployment record, validates it, and renders `App`.
2. `app.tsx` calls `useDemo(config)`, maps chain data to view rows, validates form input, and renders `PaymentsView`.
3. `use-demo.ts` owns the session, the React Query reads, the single-writer tab lock, and the write queue. It calls the chain module for every chain operation.
4. `chain/payments.ts` builds each operation and checks its on-chain effect. `chain/transactions.ts` signs, saves, broadcasts, and confirms.
5. `PaymentsView` renders props and reports user actions. It never calls the chain.

## Chain module

Each implementation exports the same names. A chain can add helpers, but it must not rename these.

| Module            | Exports                                                                                                                                                                | Responsibility                                                                                                              |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `config.ts`       | `Deployment`, `parseDeployment`, `deploymentKey`                                                                                                                       | Validate the deployment record. Create RPC clients. Build the session storage key from the network and deployment identity. |
| `session.ts`      | `Session`, `Intent`, `newSession`, `loadSession`, `saveSession`, `accountFor`, `parseAmount`, `operationId`                                                            | Create, validate, and store the disposable wallet and its transaction journal. Validate amounts. Create operation IDs.      |
| `transactions.ts` | `transact`, `UnknownOutcome`, `BroadcastUnavailable`, `ResultPending`, `RevertedTransaction`, and `ExpiredTransaction` where the chain has expiry                      | Sign, save before broadcast, broadcast, confirm, and reconcile. See [transaction recovery](recovery.md).                    |
| `payments.ts`     | `payments(config, session, persist, progress)` returning `{ setup, execute }`, `verifyDeployment`, `fundingBudget`, `FundingRequired`, `readContacts`, `readDashboard` | Register, send, request, approve, and decline, and verify each effect. Read contacts, balance, and activity.                |
| `recovery.ts`     | `recheckOnce`                                                                                                                                                          | One automatic recheck, then explicit user action. Shared.                                                                   |

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
- `src/components/payments-view.tsx`
- `src/components/theme-toggle.tsx`
- `src/components/ui/*`
- `src/chain/recovery.ts`
- `src/lib/utils.ts`
- `src/styles.css`
- `public/theme.js`

A change to one of these files must be applied to every implementation in the same pull request. `node conformance/verify.mjs` checks them: run it from the repository root to check every implementation, or from one implementation folder to check that folder.
