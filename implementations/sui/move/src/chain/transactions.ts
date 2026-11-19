import { Transaction } from "@mysten/sui/transactions";
import { TransactionError } from "@mysten/sui/client";
import { verifyTransactionSignature } from "@mysten/sui/verify";
import { fromBase64 } from "@mysten/sui/utils";
import { server, type Deployment } from "./config";
import { signerFor, accountFor, type Session } from "./session";

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
  constructor(
    message = "The transaction failed on-chain. Your payment was not applied. Retry explicitly.",
  ) {
    super(message);
  }
}
export class RejectedTransaction extends RevertedTransaction {
  constructor() {
    super("The network rejected this transaction. No payment was completed.");
  }
}

/**
 * True only when the signed bytes can never execute on this network.
 *
 * A chain ID mismatch is permanent: the chain ID is fixed and is part of the
 * signed bytes. Most other rejections are not permanent. A missing object or a
 * low address balance can change, a lagging validator can report "Transaction
 * Expired" before the epoch starts, and a consumed object version can mean
 * that this same transaction already executed. Those stay unknown until the
 * expiry proof runs. If the node changes its wording, the safe default applies.
 */
function rejectedForever(error: unknown) {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === "INVALID_ARGUMENT" &&
    error.message.includes("does not match network chain ID")
  );
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
  build: () => Promise<Transaction>,
) {
  const client = server(c);
  let record = s.journal[label];
  if (!record) {
    progress("Preparing transaction");
    const tx = await build();
    const state = await client.getCurrentSystemState();
    const { response: service } = await client.ledgerService.getServiceInfo({});
    if (service.checkpointHeight === undefined)
      throw new Error("Could not establish transaction history coverage.");
    const epoch = (BigInt(state.systemState.epoch) + 1n).toString();
    tx.setSender(accountFor(s).address);
    // Validators reject timestamp windows ("not yet supported"), so expiry is by epoch only.
    tx.setExpiration({
      ValidDuring: {
        minEpoch: state.systemState.epoch,
        maxEpoch: epoch,
        minTimestamp: null,
        maxTimestamp: null,
        chain: c.chainIdentifier,
        nonce: crypto.getRandomValues(new Uint32Array(1))[0]!,
      },
    });
    const bytes = await tx.build({ client });
    const signed = await signerFor(s).signTransaction(bytes);
    record = {
      raw: signed.bytes,
      signature: signed.signature,
      hash: await tx.getDigest({ client }),
      epoch,
      checkpoint: service.checkpointHeight.toString(),
      confirmed: false,
    };
    s.journal[label] = record;
    persist();
  }
  if (record.confirmed) return record.hash;
  // A prior storage failure may have left evidence only in memory.
  persist();
  progress("Waiting for confirmation");
  const bytes = fromBase64(record.raw);
  await verifyTransactionSignature(bytes, record.signature, {
    address: accountFor(s).address,
  });
  let result;
  try {
    result = await client.getTransaction({ digest: record.hash });
  } catch (error) {
    if (!(error instanceof TransactionError) || error.reason !== "notFound")
      throw new UnknownOutcome();
    const state = await client.getCurrentSystemState();
    if (BigInt(state.systemState.epoch) > BigInt(record.epoch)) {
      const { response: service } = await client.ledgerService.getServiceInfo(
        {},
      );
      if (
        service.lowestAvailableCheckpoint === undefined ||
        service.lowestAvailableCheckpoint > BigInt(record.checkpoint)
      )
        throw new UnknownOutcome();
      // Check again after observing expiry, so a transaction finalized at the boundary is not missed.
      try {
        result = await client.getTransaction({ digest: record.hash });
      } catch (error) {
        if (!(error instanceof TransactionError) || error.reason !== "notFound")
          throw new UnknownOutcome();
        delete s.journal[label];
        persist();
        throw new ExpiredTransaction();
      }
    } else {
      try {
        result = await client.executeTransaction({
          transaction: bytes,
          signatures: [record.signature],
        });
      } catch (error) {
        if (!rejectedForever(error)) throw new BroadcastUnavailable();
        delete s.journal[label];
        persist();
        throw new RejectedTransaction();
      }
    }
  }
  if (result.$kind === "FailedTransaction") {
    delete s.journal[label];
    persist();
    throw new RevertedTransaction();
  }
  record.confirmed = true;
  persist();
  try {
    await client.waitForTransaction({ digest: record.hash, timeout: 30_000 });
  } catch {
    throw new ResultPending();
  }
  return record.hash;
}
