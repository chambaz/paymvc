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
  constructor() {
    super("The saved transaction expired without execution. Retry explicitly.");
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
  let result: TransactionResponse | undefined;
  try {
    result = await client.getTransactionByHash({
      transactionHash: record.hash,
    });
  } catch (error) {
    if (!(error instanceof AptosApiError) || error.status !== 404)
      throw new UnknownOutcome();
    const ledger = await client.getLedgerInfo().catch(() => {
      throw new UnknownOutcome();
    });
    if (ledger.chain_id !== c.chainId) throw new UnknownOutcome();
    if (
      BigInt(ledger.ledger_timestamp) / 1000000n >
      saved.transaction.rawTransaction.expiration_timestamp_secs
    ) {
      if (BigInt(ledger.oldest_ledger_version) > BigInt(record.preparedVersion))
        throw new UnknownOutcome();
      try {
        result = await client.getTransactionByHash({
          transactionHash: record.hash,
        });
      } catch (error) {
        if (!(error instanceof AptosApiError) || error.status !== 404)
          throw new UnknownOutcome();
        delete s.journal[label];
        persist();
        throw new ExpiredTransaction();
      }
    } else {
      try {
        await client.transaction.submit.simple(saved);
      } catch {
        throw new BroadcastUnavailable();
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
  if (!result.success) {
    delete s.journal[label];
    persist();
    throw new RevertedTransaction();
  }
  record.confirmed = true;
  persist();
  return record.hash;
}
