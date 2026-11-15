# PayMVC documentation

PayMVC is one small payments app, built on many smart contract platforms. Each implementation uses the same interface and the same behavior. The contracts, accounts, signing, and transaction handling use each platform's native tools. Compare two implementations to see how the platforms differ.

## Start here

- [Specification](../SPEC.md): the requirements. MUST rules are normative.
- [Add an implementation](adding-an-implementation.md): the steps and checklist for a pull request that adds a new chain.

## Reference

- [Contract requirements](contract-interface.md): what the contract or program must do.
- [User interface](ui.md): screens, states, labels, and the design fixture.
- [Frontend architecture](frontend-architecture.md): the `src/` layout, the shared files, and the chain module.
- [Transaction recovery](recovery.md): saved transactions, confirmation, expiry, and retry.
- [Comparison](comparison.md): where each concept lives in each implementation, and the native differences.
- [Testing](testing.md): the shared scenario, contract tests, browser tests, and evidence.

## Implementations

| Implementation     | Networks                                                               | Folder                                                                              |
| ------------------ | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Ethereum / Foundry | Ethereum Sepolia, Base Sepolia, Robinhood Chain Testnet, Monad Testnet | [`implementations/ethereum/foundry`](../implementations/ethereum/foundry/README.md) |
| Solana / Anchor    | Solana Devnet                                                          | [`implementations/solana/anchor`](../implementations/solana/anchor/README.md)       |
| Stellar / Soroban  | Stellar Testnet                                                        | [`implementations/stellar/soroban`](../implementations/stellar/soroban/README.md)   |
| Sui / Move         | Sui Testnet                                                            | [`implementations/sui/move`](../implementations/sui/move/README.md)                 |
| Aptos / Move       | Aptos Testnet                                                          | [`implementations/aptos/move`](../implementations/aptos/move/README.md)             |
| Thruput / Rust     | Thruput Futurenet                                                      | [`implementations/thruput/rust`](../implementations/thruput/rust/README.md)         |
