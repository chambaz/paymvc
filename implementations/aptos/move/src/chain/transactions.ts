import {
  AptosApiError,
  generateSignedTransaction,
  generateUserTransactionHash,
  Hex,
  type LedgerInfo,
  type SimpleTransaction,
  type TransactionResponse,
} from "@aptos-labs/ts-sdk";
import { server, type Deployment } from "./config";
import { signerFor, savedTransaction, type Session } from "./session";

export class UnknownOutcome extends Error {
  constructor() {
    super(
      "Outcome unknown. Recheck the saved transaction before trying another operation.",
    );
  }
}
export class BroadcastUnavailable extends UnknownOutcome {}
export class ResultPending extends UnknownOutcome {}
export class RevertedTransaction extends Error {
  constructor() {
    super(
      "The transaction failed on-chain. Your payment was not applied. Retry explicitly.",
    );
  }
}
export class ExpiredTransaction extends Error {
  constructor(
    message = "The saved transaction expired without execution. Retry explicitly.",
  ) {
    super(message);
  }
}
/** Another transaction from this wallet used the sequence number, so this one can never commit. */
export class ReplacedTransaction extends ExpiredTransaction {
  constructor() {
    super(
      "Another transaction from this wallet took this one's place. Nothing changed. Retry explicitly.",
    );
  }
}
/** The node refused the saved transaction because the wallet cannot pay its gas. */
export class GasFundsRequired extends BroadcastUnavailable {
  constructor() {
    super();
    this.message =
      "This wallet needs more testnet APT for gas. The transaction is saved. Fund the wallet, then retry.";
  }
}
export type Progress = (message: string) => void;

export async function transact(
  c: Deployment,
  s: Session,
  persist: () => void,
  progress: Progress,
  label: string,
  build: (ledger: LedgerInfo) => Promise<SimpleTransaction>,
  /**
   * True when the operation's effect is not on chain. Checked from current state before
   * an expiry is accepted, because a node can miss a committed transaction.
   */
  absent: () => Promise<boolean> = async () => true,
) {
  const client = server(c);
  let record = s.journal[label];
  if (!record) {
    progress("Preparing transaction");
    const ledger = await client.getLedgerInfo();
    if (ledger.chain_id !== c.chainId)
      throw new Error("Unexpected Aptos chain.");
    const transaction = await build(ledger);
    const senderAuthenticator = client.transaction.sign({
      signer: signerFor(s),
      transaction,
    });
    const signed = { transaction, senderAuthenticator };
    record = {
      raw: Hex.fromHexInput(generateSignedTransaction(signed)).toString(),
      hash: generateUserTransactionHash(signed),
      preparedVersion: ledger.ledger_version,
      confirmed: false,
    };
    s.journal[label] = record;
    persist();
  }
  if (record.confirmed) return record.hash;
  persist();
  progress("Waiting for confirmation");
  const saved = savedTransaction(record.raw);
  const raw = saved.transaction.rawTransaction;
  const finish = (version: string) => {
    record.confirmed = true;
    record.committedVersion = version;
    persist();
    return record.hash;
  };
  const release = (error: Error) => {
    delete s.journal[label];
    persist();
    return error;
  };
  /**
   * The committed transaction at the saved sequence number. A different hash proves that
   * the saved one can never commit; the same hash proves that it did.
   */
  const atSequence = async () => {
    const [found] = await client.getAccountTransactions({
      accountAddress: raw.sender,
      options: { offset: raw.sequence_number, limit: 1 },
    });
    return found?.type === "user_transaction" ? found : undefined;
  };
  let result: TransactionResponse | undefined;
  try {
    result = await client.getTransactionByHash({
      transactionHash: record.hash,
    });
  } catch (error) {
    if (!(error instanceof AptosApiError) || error.status !== 404)
      throw new UnknownOutcome();
    const used = await atSequence().catch(() => undefined);
    if (used && used.hash !== record.hash) {
      if (!(await absent().catch(() => false))) return finish(used.version);
      throw release(new ReplacedTransaction());
    }
    if (used) result = used;
    else {
      const ledger = await client.getLedgerInfo().catch(() => {
        throw new UnknownOutcome();
      });
      if (ledger.chain_id !== c.chainId) throw new UnknownOutcome();
      if (
        BigInt(ledger.ledger_timestamp) / 1000000n >
        raw.expiration_timestamp_secs
      ) {
        if (
          BigInt(ledger.oldest_ledger_version) > BigInt(record.preparedVersion)
        )
          throw new UnknownOutcome();
        try {
          result = await client.getTransactionByHash({
            transactionHash: record.hash,
          });
        } catch (error) {
          if (!(error instanceof AptosApiError) || error.status !== 404)
            throw new UnknownOutcome();
          // The effect may still be on chain if this node missed the commit.
          if (!(await absent().catch(() => false)))
            return finish(ledger.ledger_version);
          throw release(new ExpiredTransaction());
        }
      } else {
        try {
          await client.transaction.submit.simple(saved);
        } catch (error) {
          // A definite rejection keeps the saved bytes: they can still succeed later,
          // for example after the wallet is funded.
          if (
            error instanceof AptosApiError &&
            /INSUFFICIENT_BALANCE_FOR_TRANSACTION_FEE/.test(
              JSON.stringify(error.data),
            )
          )
            throw new GasFundsRequired();
          throw new BroadcastUnavailable();
        }
      }
    }
  }
  if (!result || result.type === "pending_transaction") {
    try {
      result = await client.waitForTransaction({
        transactionHash: record.hash,
        options: { timeoutSecs: 30, checkSuccess: false },
      });
    } catch {
      throw new ResultPending();
    }
  }
  if (result.type !== "user_transaction") throw new UnknownOutcome();
  if (!result.success) throw release(new RevertedTransaction());
  return finish(result.version);
}
