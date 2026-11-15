import {
  createWalletClient,
  http,
  keccak256,
  type Address,
  type Hex,
  BaseError,
  HttpRequestError,
} from "viem";
import { chainFor, publicClient, type Deployment } from "./config";
import { accountFor, type Session } from "./session";

export class UnknownOutcome extends Error {
  constructor(public hash: Hex) {
    super(
      "Outcome unknown. Recheck the original transaction before continuing.",
    );
  }
}
export class RevertedTransaction extends Error {
  constructor() {
    super("The transaction failed on-chain. No payment was completed.");
  }
}
export class BroadcastUnavailable extends Error {
  constructor(error: unknown) {
    const transport =
      error instanceof BaseError
        ? error.walk((cause) => cause instanceof HttpRequestError)
        : undefined;
    super(
      transport instanceof HttpRequestError && transport.status === 429
        ? "The RPC is busy. Progress saved. Please retry."
        : "The RPC could not confirm submission. Progress saved. Retry to check the saved transaction.",
    );
  }
}
export type Progress = (message: string) => void;

export class ResultPending extends Error {
  constructor() {
    super("The network is still updating this result. Your progress is saved.");
  }
}

/** Persist the exact signed bytes before broadcast. Retries always reuse the same hash and nonce. */
export async function transact(
  config: Deployment,
  session: Session,
  persist: () => void,
  progress: Progress,
  label: string,
  to: Address,
  data: Hex = "0x",
  value = 0n,
) {
  const client = publicClient(config);
  let record = session.journal[label];
  if (!record) {
    progress("Getting things ready");
    const wallet = createWalletClient({
      account: accountFor(session),
      chain: chainFor(config),
      transport: http(config.rpcUrl),
    });
    const request = await wallet.prepareTransactionRequest({ to, data, value });
    const raw = await wallet.signTransaction(request);
    record = { raw, hash: keccak256(raw), confirmed: false };
    session.journal[label] = record;
  }
  // Also persist on retries: a previous storage write may have failed after creating the in-memory record.
  persist(); // If storage fails, nothing is broadcast.
  progress("Waiting for the network");
  // Even previously confirmed entries are checked again when replaying setup after a reload.
  const existing = await client
    .getTransactionReceipt({ hash: record.hash })
    .catch(() => null);
  let broadcastError: unknown;
  if (!existing) {
    try {
      await client.sendRawTransaction({ serializedTransaction: record.raw });
    } catch (error) {
      broadcastError = error;
    }
  }
  let receipt;
  try {
    const mined =
      existing ??
      (await client
        .getTransactionReceipt({ hash: record.hash })
        .catch(() => null));
    // A retry of a transaction still in the mempool gets "already known". Wait for it instead.
    const known =
      Boolean(mined) ||
      !broadcastError ||
      (await client
        .getTransaction({ hash: record.hash })
        .then(() => true)
        .catch(() => false));
    if (!known) throw new BroadcastUnavailable(broadcastError);
    receipt = mined
      ? mined
      : await client.waitForTransactionReceipt({
          hash: record.hash,
          confirmations: 1,
          timeout: 90_000,
        });
  } catch (error) {
    if (error instanceof BroadcastUnavailable) throw error;
    throw new UnknownOutcome(record.hash);
  }
  if (receipt.status !== "success") {
    // A mined revert proves that this attempt cannot later pay. Explicit retry may prepare a new transaction.
    delete session.journal[label];
    persist();
    throw new RevertedTransaction();
  }
  record.confirmed = true;
  persist();
  return receipt;
}
