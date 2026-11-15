# Conformance

Shared test code for every implementation. See [testing](../docs/testing.md) for the requirements.

| File                   | Purpose                                                    |
| ---------------------- | ---------------------------------------------------------- |
| `scenario.ts`          | The two-user scenario that every implementation drives     |
| `recovery.test.ts`     | Tests for the shared recovery policy                       |
| `manifest.schema.json` | The schema for each `implementation.json`                  |
| `verify.mjs`           | Checks that each implementation's copies match these files |

Each implementation keeps copies in `tests/conformance/` and `implementation.schema.json`, so that it runs on its own. `npm run test:conformance` in an implementation runs `verify.mjs`.
