# Working on PayMVC

Read `SPEC.md` and `docs/adding-an-implementation.md` first. For work on one implementation, also read its README.

- Keep all chain signing, reads, and transaction construction visible in `src/chain/`.
- Never change a shared file in one implementation only. See `docs/frontend-architecture.md#shared-files`.
- Use the platform's best native tools. Keep names and data shapes the same as the other implementations, but do not copy another chain's workaround.
- Use exact integer amounts. Never derive balances from activity.
- Save signed transactions before broadcast. Reconcile uncertain outcomes before retrying. See `docs/recovery.md`.
- Keep signing keys out of logs, URLs, APIs, commits, and test artifacts.
- Public demos use public testnets. Local chains are for development and tests only.
- Test authorization and failure paths, not only the happy path.
- Run the implementation's `check`, `test`, `build`, `test:e2e`, and `test:conformance` commands before committing.
- Never commit plans, decisions, status notes, or `.local/` data. Public docs describe the project, not its history.
