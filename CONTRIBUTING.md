# Contributing

Thank you for helping. Read the [specification](SPEC.md) first.

## Add a new chain

Follow [Add an implementation](docs/adding-an-implementation.md). It lists the steps, the requirements, and a pull request checklist.

## Change an existing implementation

- Use the target ecosystem's normal patterns.
- Keep each implementation folder independent. Do not import code, symlink files, or call scripts from another implementation.
- Shared files must stay identical. If you change one, change it in every implementation in the same pull request. See [frontend architecture](docs/frontend-architecture.md#shared-files).
- If you change behavior, check the [comparison](docs/comparison.md) so that the fix reaches every implementation.
- Test authorization and failure paths, not only the happy path.

## Before you open a pull request

In each implementation you changed, run:

```sh
npm run check
npm test
npm run build
npm run test:e2e
npm run test:conformance
```

Some implementations need extra toolchains or commands; see their READMEs.

- A person must review every visual baseline change. Never update a baseline to hide a regression.
- Report a testnet outage apart from an implementation failure.
- Never commit keys, browser profiles, signed-transaction journals, `.local/` data, or private working notes.
- In the pull request, explain what changed and which tests you ran.
