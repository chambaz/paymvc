# Security

PayMVC is a demo on public testnets. Its credits and native tokens have no value, and its wallets are disposable keys in browser storage. Do not use these wallets for valuable assets.

## Report a vulnerability

Report a vulnerability privately with [GitHub's private vulnerability reporting](https://github.com/chambaz/paymvc/security/advisories/new). Include the implementation, the network, and the steps to reproduce. Do not open a public issue for a vulnerability.

Report these:

- a way to move or create credits that the contract rules do not allow
- a way to pay twice, or to lose a payment, through the transaction recovery code
- a way for a key or a signed transaction to leave the browser
- a weakness in a hosted site at paymvc.com

Testnet outages, faucet limits, and RPC rate limits are not vulnerabilities. Open a normal issue for those.

## Scope

The contracts are deployed on public testnets only and cannot be upgraded. A fix ships as a new deployment, which gives every browser a new session.
