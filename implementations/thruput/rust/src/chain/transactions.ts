import {
  createDefaultWalletBatchInvocation,
  createSubmissionEvidence,
  createWalletClient,
  fromHex0x,
  gasAmount,
  hashFromBase58,
  toBase58,
  toHex0x,
  TransactionReceiptObservationError,
  walletGasLimit,
  type Invocation,
  type TransactionReceipt,
} from "@thruputchain/client";
import {
  deserializeSignedTransaction,
  serializeSignedTransaction,
} from "@thruputchain/client/transaction";
import { deploymentKey, type Client, type Deployment } from "./config";
import { signerFor, type Session } from "./session";

/** Gas for the wallet's own work. The root gas limit adds the PayMVC call's gas to it. */
const WALLET_GAS = gasAmount(2_000_000n);
/** A signed transaction can be included for this many blocks after preparation. */
const EXPIRY_BLOCKS = 200n;

export class UnknownOutcome extends Error {
  constructor() {
    super(
      "Outcome unknown. Recheck the original operation before trying another payment.",
    );
  }
}
export class ResultPending extends UnknownOutcome {}
export class BroadcastUnavailable extends UnknownOutcome {}
export class RevertedTransaction extends Error {
  constructor() {
    super(
      "The transaction failed on chain. Your credits were not moved. Check funding and retry explicitly.",
    );
  }
}
export class ExpiredTransaction extends Error {
  constructor() {
    super(
      "The transaction expired, and a later chain read proves it did not change this operation. Retry explicitly.",
    );
  }
}

/**
 * Sign, save, broadcast, and confirm one transaction for `label`. The
 * wallet runs `calls` in order as one atomic batch.
 *
 * A saved transaction is always reconciled first. Its record is deleted only
 * after proof of failure: a failed receipt, or expiry plus `proveAbsent`
 * showing that the operation did not happen. Only then can a later call sign
 * a new transaction.
 */
export async function transact(
  c: Deployment,
  s: Session,
  client: Client,
  label: string,
  calls: readonly Invocation[],
  persist: () => void,
  progress: (message: string) => void,
  proveAbsent: (minStateBlockHeight: bigint) => Promise<boolean>,
) {
  if (s.deployment !== deploymentKey(c))
    throw new Error("This wallet belongs to another deployment.");
  let record = s.journal[label];
  if (record?.confirmed) return;

  const finish = (receipt: TransactionReceipt) => {
    record!.blockHeight = receipt.blockHeight.toString();
    if (!("result" in receipt.execution)) {
      persist();
      throw new UnknownOutcome();
    }
    if (receipt.execution.result !== "return") {
      delete s.journal[label];
      persist();
      throw new RevertedTransaction();
    }
    record!.confirmed = true;
    if (receipt.blockHeight > BigInt(s.stateHeight))
      s.stateHeight = receipt.blockHeight.toString();
    persist();
  };

  if (record) {
    progress("Checking the original transaction");
    const transactionHash = hashFromBase58(record.hash);
    const receipt = await client.getTransactionReceipt({ transactionHash });
    if (receipt) return finish(receipt);
    const status = await client.getTransactionStatus({ transactionHash });
    if ("status" in status && status.status === "committed") {
      record.blockHeight = status.blockHeight.toString();
      persist();
    }
    if (!record.blockHeight) {
      const signed = deserializeSignedTransaction(fromHex0x(record.raw));
      const expiry = signed.tx.uniquifier.block_expiry_height;
      const tip = await client.getChainTip();
      if (tip.blockHeight > expiry && (await proveAbsent(tip.blockHeight))) {
        delete s.journal[label];
        persist();
        throw new ExpiredTransaction();
      }
      // The scheduler may ask for the same bytes again. Never sign new ones here.
      if (
        tip.blockHeight <= expiry &&
        "status" in status &&
        ["retry", "dropped"].includes(status.status)
      )
        await client.sendTransaction({
          signedTransaction: fromHex0x(record.raw),
        });
    }
  } else {
    progress("Preparing transaction");
    const wallet = createWalletClient({ client, account: signerFor(s) });
    const unsigned = await wallet.prepareTransaction({
      invocation: createDefaultWalletBatchInvocation(wallet.account.address, {
        invocations: calls,
        gasLimit: walletGasLimit(calls, WALLET_GAS),
      }),
      expiryBlocks: EXPIRY_BLOCKS,
    });
    const bytes = serializeSignedTransaction(
      await wallet.signTransaction(unsigned),
    );
    const evidence = createSubmissionEvidence(
      bytes,
      hashFromBase58(c.networkHash),
    );
    record = {
      raw: toHex0x(bytes),
      hash: toBase58(evidence.transactionHash),
      confirmed: false,
    };
    s.journal[label] = record;
    persist(); // If the save fails, nothing is broadcast.
    try {
      await client.sendTransaction({ signedTransaction: bytes });
    } catch {
      throw new BroadcastUnavailable();
    }
  }

  progress("Pending confirmation");
  let receipt: TransactionReceipt;
  try {
    receipt = await client.waitForTransactionReceipt(
      hashFromBase58(record.hash),
      {
        timeoutMs: 30_000,
        expectedNetworkHash: hashFromBase58(c.networkHash),
        knownCommitment: record.blockHeight
          ? {
              networkHash: hashFromBase58(c.networkHash),
              transactionHash: hashFromBase58(record.hash),
              blockHeight: BigInt(record.blockHeight),
            }
          : undefined,
      },
    );
  } catch (error) {
    if (
      error instanceof TransactionReceiptObservationError &&
      error.knownCommitment
    ) {
      record.blockHeight = error.knownCommitment.blockHeight.toString();
      persist();
    }
    throw new UnknownOutcome();
  }
  finish(receipt);
}
