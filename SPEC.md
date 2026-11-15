# PayMVC specification

**Version 1.0.0-draft.2.** MUST denotes a requirement. Contract layouts and transaction counts are implementation choices. Guides and reference material are in [`docs/`](docs/README.md).

## Application

Every implementation MUST provide the canonical React interface: implementation selector, the user's address, actual demo-token balance, registered-address contacts, Send and Request forms, incoming request approval/decline, outgoing requests, PayMVC activity, registration/recovery progress, and Reset Demo. Each session controls one disposable wallet. No extension or external user account is required. A manual faucet may impose its own requirements, which MUST be disclosed.

Addresses are the only user identity; there are no names or editable profile fields. Show short addresses in compact controls and make full addresses available to inspect and copy. Full addresses identify recipients internally; shortened text MUST NOT be used as an identifier. Send/Request dialogs use a recipient address input and an in-dialog mode toggle. Contact buttons fill the address input; the main Send and Request buttons open it empty for pasting. Contact pagination stays on the dashboard. Retain the recipient and amount when switching modes; disable switching and input changes while an operation is unresolved. Close the dialog after confirmed success and show the result in the dashboard.

Use whole demo credits separate from native fees. Preferred token models are ERC-20 and SPL Token, with zero decimals to prevent external fractional balances. An idiomatic ledger on another chain requires a documented rationale. Display exact on-chain balances, including external transfers; never infer balances from activity.

## Profiles and allocations

An address is the identity. Registration MUST be authorized by that account, record its membership, and allocate 100 credits exactly once per deployment. Registration, directory membership, and allocation MUST be atomic or recoverable without duplicate membership or minting. A profile is only registered-address membership; it has no name.

## Contact discovery

Each deployment MUST expose a small on-chain directory of registered addresses in stable registration order, through bounded pages and a count or equivalent native cursor. Do not require an indexer or fetch the entire directory to show the first contacts. Events may supplement the directory. Retrying registration MUST NOT add an address twice.

Show five other registered addresses initially, or all available if fewer exist, and Load more when additional contacts exist. Exclude the current wallet, omit duplicates, and retain a selected recipient as pages load. Pagination MUST handle the user's own entry and registrations arriving between reads without skipping existing contacts. An empty directory shows a short empty state. The maintainer may register real launch profiles separately; ordinary setup MUST NOT create contacts or fabricated activity. Contacts are scoped to the same network and application deployment. No random sampling, search service, presence, ranking, or automatic contact responses are required.

## Transfers

PayMVC send/request amounts MUST be integers in [1, 1,000,000]. Reject zero, negative, fractional, malformed, excessive, or overflowing amounts. Balances MUST support at least 1,000,000 credits and use exact integer arithmetic. Direct payments MUST debit only their authorized payer, credit the recipient by the same amount, and reject insufficient funds. Both PayMVC participants MUST be registered and distinct.

These restrictions apply to PayMVC operations. The standard token MUST still allow direct transfers outside the app, including to unregistered accounts. There is no repeat claim, admin top-up, burn, or profile-edit action in v1.

## Requests

The requester signs creation of a positive-amount request to a registered, distinct payer. Creation reserves no funds and is allowed even if the payer lacks funds. Each request has a stable ID, requester, intended payer, amount, and Pending/Paid/Declined state.

Only the intended payer can approve or decline Pending. Approval MUST atomically transfer the exact amount and mark Paid. Decline MUST mark Declined without moving funds. Insufficient funds leaves Pending. Paid and Declined are terminal. Concurrent transitions MUST permit at most one success. Requests cannot be edited, cancelled, expired, or partly paid.

Multiple deliberate requests are allowed; retrying one operation MUST NOT create another. Token allowances are preparation, not request approval. Show additional prerequisite transactions as named progress steps.

Only the intended payer's own session offers Approve or Decline. Outgoing requests show their status without a Pay as or simulated-response action. No session stores or uses another user's key.

## Setup

Create demo wallet MUST save one identity without starting transactions. Then show the full address, copy action, manual faucet link, and estimated native funding budget for that account's prerequisites, registration, and use. Start demo MUST verify deployment and funding, perform any necessary native account/token prerequisites, and register only that wallet. Keep native prerequisites visible; do not require identical transaction counts across chains.

A fresh isolated registered user starts with 100 credits and no app activity or requests. There are no automatic seed transactions or contact-funding stages. Read the actual balance: other users or external token transfers may change it after allocation. Registration and allocation do not appear in Activity.

Show concise registration progress and named prerequisites where needed. Confirm registration, directory membership, and allocation before reporting success. Unknown setup outcomes receive one bounded automatic recheck using saved evidence; definitive failure or proven expiry requires explicit retry. Refresh and retry MUST resume the same identity and reconcile completed actions. Never repeat an allocation.

## Transaction outcomes and recovery

Expose Preparing, Pending, Confirmed, Failed, and Outcome unknown. Confirmation requires chain evidence at the documented confirmation threshold and verification of the expected application effect. A timeout is not definitive failure. Preserve signed transaction evidence before broadcast; recover by checking or rebroadcasting the same operation, not silently issuing another payment.

Persist unresolved operation IDs and transaction identities. Prevent concurrent writes within a browser session, including multiple tabs. Reconciliation MUST continue after refresh. Failed reads retain the last balance with a stale indicator; never replace it with zero. Failed writes retain form values. Do not label speculative state confirmed.

Implementations MUST document expiry, reorganization handling, and the confirmation threshold. Confirmation is not an assertion of irreversible finality.

## Activity

Label the feed **Activity**. Use one row per PayMVC direct transfer and one per request. Request rows update to Paid/Declined in their original creation position; a paid request does not add a duplicate transfer row. Registration and claims do not appear here. External token transfers need not appear.

Records MUST be reconstructable from chain state/events or a documented indexer. Sort newest creation first, with deterministic tie-breaking. Show 50 records initially and Load more when needed. Unresolved local transactions have explicit status outside or within the feed. Store transaction evidence for resolutions. Indexer delays and duplicate events MUST NOT create false successes, false failures, or duplicate rows.

## Sessions and reset

Store one versioned disposable wallet locally, bound to the implementation, chain, and deployment identity. Never send keys to application APIs, URLs, logs, analytics, or diagnostic exports. If storage is unavailable, stop before funding and explain recovery. A second tab must be read-only while another tab owns the session. Independent users MUST use independent sessions; multi-user tests use separate browser contexts.

Refresh restores the session. Switching implementations preserves separate sessions. Reset requires confirmation, clears only the current implementation's session, and returns to entry. It does not cancel pending chain transactions or delete chain state. Creating a wallet after reset produces one fresh identity.

## Interface and accessibility

Use the [interface requirements](docs/ui.md) and the shared source and assets. Support keyboard use, visible focus, named controls, status announcements, and mobile/desktop layouts. No charts, performance comparisons, fee dashboards, or architecture explainers inside the application. Keep test-only notices concise and visible.

## Acceptance

The [testing requirements](docs/testing.md) define the observable checks. Implementations MUST supply contract tests, shared E2E/visual evidence, and live-testnet evidence. Deterministic mocks are only allowed in isolated UI/failure tests, never in the hosted live demo. Version this spec, the interface requirements, and the test suite together. No implementation may claim v1 conformance while checks are failed or unrun.
