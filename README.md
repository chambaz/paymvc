# PayMVC

**Smart contract platform explorer and test harness for blockchain developers.**

PayMVC is a small payments app built on different blockchains. The interface and behavior are the same everywhere; the contracts, accounts, signing, and transaction handling use each platform's native tools. Compare two implementations to see how the platforms differ. Inspired by [TodoMVC](https://todomvc.com/).

Try it live at **[paymvc.com](https://paymvc.com)**. Each network has its own subdomain, for example [base.paymvc.com](https://base.paymvc.com). All networks are testnets.

## Implementations

| Implementation                                                   | Networks                                                               | Port                   |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------- | ---------------------- |
| [Ethereum / Foundry](implementations/ethereum/foundry/README.md) | Ethereum Sepolia, Base Sepolia, Robinhood Chain Testnet, Monad Testnet | 5173, 5177, 5187, 5179 |
| [Solana / Anchor](implementations/solana/anchor/README.md)       | Solana Devnet                                                          | 5175                   |
| [Stellar / Soroban](implementations/stellar/soroban/README.md)   | Stellar Testnet                                                        | 5181                   |
| [Sui / Move](implementations/sui/move/README.md)                 | Sui Testnet                                                            | 5183                   |
| [Aptos / Move](implementations/aptos/move/README.md)             | Aptos Testnet                                                          | 5185                   |
| [Thruput / Rust](implementations/thruput/rust/README.md)         | Thruput Futurenet                                                      | 5189                   |

Each folder is a complete, independent example: contract, frontend, signing, tests, and deployment scripts. The four EVM networks share one implementation with separate network configurations.

The project landing page is in [`web/`](web/README.md). It has no chain code and runs on port 5170.

## Try it

Each implementation runs on its own from its folder. For example, Ethereum needs Node 24 and Foundry 1.7.1:

```sh
cd implementations/ethereum/foundry
npm ci
npm run dev
```

Open <http://127.0.0.1:5173>. Select **Create demo wallet**, copy your address, get Sepolia ETH from the linked faucet, then select **Start demo**. Registration gives you 100 credits. Send credits to another registered address, or request a payment. Use a second browser profile for a second user.

To run the landing page on <http://127.0.0.1:5170>:

```sh
npm --prefix web ci
npm run web
```

`npm run verify` checks that the shared files are identical in every implementation.

To run another implementation, follow its README. Start each frontend that you want the implementation selector to reach.

The demo keeps disposable keys in browser storage. All credits and networks are test-only. Do not use these wallets for valuable assets.

## Documentation

- [Specification](SPEC.md)
- [Documentation index](docs/README.md)
- [Add an implementation](docs/adding-an-implementation.md)
- [Comparison](docs/comparison.md)
- [Contributing](CONTRIBUTING.md)

## License

MIT. Third-party libraries keep their own licenses. shadcn/ui components are adapted from its MIT-licensed registry. OpenZeppelin contracts are a pinned MIT dependency.
