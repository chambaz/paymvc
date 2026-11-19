# Transaction recovery

A browser can close, an RPC can time out, and a network can drop a transaction. PayMVC must never lose a payment and never pay twice. Every implementation follows the same policy. Each chain proves confirmation and expiry with its own tools.

## Policy

1. **Save before broadcast.** Save the operation ID and the signed transaction (bytes and hash) to the session before the first broadcast. If the save fails, do not broadcast.
2. **Reconcile before retry.** A failed RPC response does not prove that nothing happened. Look up the saved transaction first.
3. **Retry with the same bytes.** An explicit retry looks up or rebroadcasts the saved transaction. It never signs a new payment while the outcome of the old one is unknown. A chain where fees can strand a transaction may sign the same transaction again with the same nonce and higher fees, because at most one version can succeed.
4. **A new attempt only after proof.** A new transaction for the same operation is allowed only after the chain proves that the old one failed, expired, or was replaced.
5. **Check the effect.** Confirmation needs chain evidence at the documented threshold **and** the expected application effect: the entry, its participants, amount, kind, and state.
6. **One automatic recheck.** Setup rechecks once after five seconds for an unknown outcome or a delayed result. Payments recheck once for a delayed result. After that, the user decides.
7. **Operation IDs prevent duplicates.** The contract rejects a second entry with the same sender and operation ID, so a retry cannot create a second payment.
8. **Reset is not recovery.** Reset removes local access. It cannot cancel a transaction.

## Outcomes

| Outcome         | Meaning                                                 | What the user can do              |
| --------------- | ------------------------------------------------------- | --------------------------------- |
| Preparing       | Building and signing                                    | Wait                              |
| Pending         | Broadcast; waiting for confirmation                     | Wait                              |
| Confirmed       | Chain evidence and the expected effect are both present | Continue                          |
| Failed          | The chain proved that the transaction failed or expired | Retry (a new attempt), or dismiss |
| Outcome unknown | No proof either way, for example after a timeout        | Recheck the original transaction  |

A timeout is never a failure. Never label a speculative state as confirmed.

## Reads

- A failed read keeps the last balance and shows a stale indicator. It never shows zero instead.
- A failed write keeps the form values.
- Balances come from the token. Never calculate a balance from activity.

## Per chain

Confirmation is the threshold at which the app reports success. It is not a claim of irreversible finality.

| Chain   | Confirmation                                                                  | Expiry and proof of absence                                                                                                                                                                                                                               |
| ------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| EVM     | One successful mined receipt for a saved version, plus the expected state     | No expiry. Proven replaced when the account nonce passes the transaction's nonce and no version has a receipt. A fee cap below the base fee gets a new version with the same nonce.                                                                       |
| Solana  | `confirmed` signature status, plus the expected state                         | Expired after `lastValidBlockHeight`. Proven when the finalized height passes it and a history lookup from a node at the finalized slot finds no transaction.                                                                                             |
| Stellar | A successful closed-ledger transaction, plus the expected effect              | Expires after 180 seconds. Proven when closed-ledger time passes the deadline and either the RPC history covers the preparation ledger or a later state read shows no effect.                                                                             |
| Sui     | Successful effects, plus the expected state                                   | `ValidDuring` through the next epoch. Proven by a later epoch and a later state read that shows no effect. While history covers it, a second lookup must also find no digest.                                                                             |
| Aptos   | A committed successful transaction, plus the expected state                   | Expires after 10 minutes. Proven by committed ledger time, retained history, a second lookup that finds no hash, and a state read that shows no effect. Also proven replaced when another transaction used its sequence number and state shows no effect. |
| Thruput | A successful committed receipt, plus the expected state at or after its block | Expires after 200 blocks. A new attempt needs a failed receipt, or expiry plus a later state read that shows the operation did not happen.                                                                                                                |

Reorganizations can change a confirmed result on chains without instant finality. Base and Robinhood Chain inclusion is not Ethereum L1 finality. Each implementation's README states its threshold, its expiry, and how it handles reorganizations.
