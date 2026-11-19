import {
  createWalletClient,
  http,
  keccak256,
  parseTransaction,
  type Address,
  type Hex,
  type TransactionReceipt,
  BaseError,
  HttpRequestError,
  InsufficientFundsError,
  TransactionReceiptNotFoundError,
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
/** Another transaction used this one's nonce, so it can never be mined. */
export class ReplacedTransaction extends RevertedTransaction {
  constructor() {
    super();
    this.message =
      "Another transaction from this wallet took this one's place. No payment was completed.";
  }
}
export class BroadcastUnavailable extends Error {
  constructor(error: unknown) {
    const cause =
      error instanceof BaseError
        ? error.walk(
            (cause) =>
              cause instanceof HttpRequestError ||
              cause instanceof InsufficientFundsError,
          )
        : undefined;
    super(
      cause instanceof InsufficientFundsError
        ? "This wallet needs more native tokens for fees. The transaction is saved. Fund the wallet, then retry."
        : cause instanceof HttpRequestError && cause.status === 429
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

type Record = Session["journal"][string];

/**
 * Persist the exact signed bytes before broadcast. Retries reuse the same nonce. A
 * transaction is signed again only with the same nonce and higher fees, so at most one
 * version can be mined.
 */
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
  const wallet = createWalletClient({
    account: accountFor(session),
    chain: chainFor(config),
    transport: http(config.rpcUrl),
  });
  let record: Record | undefined = session.journal[label];
  const retry = Boolean(record);
  if (!record) {
    progress("Preparing transaction");
    const request = await wallet.prepareTransactionRequest({ to, data, value });
    const raw = await wallet.signTransaction(request);
    record = { raw, hash: keccak256(raw), confirmed: false };
    session.journal[label] = record;
  }
  // Also persist on retries: a previous storage write may have failed after creating the in-memory record.
  persist(); // If storage fails, nothing is broadcast.
  progress("Waiting for confirmation");
  return settle(config, session, persist, label, record, retry);
}

async function settle(
  config: Deployment,
  session: Session,
  persist: () => void,
  label: string,
  saved: Record,
  retry: boolean,
) {
  const client = publicClient(config);
  let record = saved;
  const versions = () => [record.hash, ...(record.earlier ?? [])];
  // Only "not found" means no receipt. Any other read error proves nothing, so it
  // propagates and the outcome stays unknown.
  const minedVersion = async () => {
    for (const hash of versions()) {
      const receipt = await client
        .getTransactionReceipt({ hash })
        .catch((error: unknown) => {
          if (error instanceof TransactionReceiptNotFoundError) return null;
          throw error;
        });
      if (receipt) return receipt;
    }
    return null;
  };
  // A used nonce with no receipt for any version proves that no version can be mined.
  // Returns a version's receipt if one appears. Checks twice, because the reads can
  // reach different RPC nodes.
  const replacement = async () => {
    const { nonce } = parseTransaction(record.raw);
    for (let check = 0; check < 2; check++) {
      const used = await client.getTransactionCount({
        address: accountFor(session).address,
        blockTag: "latest",
      });
      if (used <= nonce!) return null;
      const receipt = await minedVersion();
      if (receipt) return receipt;
      if (check === 0) await delay(config.chainId === 31337 ? 100 : 3_000);
    }
    return "replaced" as const;
  };
  const fail = (error: Error) => {
    // Only proof from the chain reaches here, so a new attempt cannot pay twice.
    delete session.journal[label];
    persist();
    return error;
  };
  let receipt: TransactionReceipt | null = null;
  try {
    // A saved transaction may already be mined, replaced, or priced below the base fee.
    // Even previously confirmed entries are checked again when replaying setup after a reload.
    if (retry) {
      receipt = await minedVersion();
      if (!receipt) {
        const found = await replacement();
        if (found === "replaced") throw fail(new ReplacedTransaction());
        receipt = found;
      }
      if (!receipt) record = await repriced(config, session, record, persist);
    }
    if (!receipt) {
      let broadcastError: unknown;
      try {
        await client.sendRawTransaction({ serializedTransaction: record.raw });
      } catch (error) {
        broadcastError = error;
      }
      receipt = await minedVersion();
      // A retry of a transaction still in the mempool gets "already known". Wait for it instead.
      const known =
        Boolean(receipt) ||
        !broadcastError ||
        (await client
          .getTransaction({ hash: record.hash })
          .then(() => true)
          .catch(() => false));
      if (!known) {
        const found = await replacement();
        if (found === "replaced") throw fail(new ReplacedTransaction());
        if (!found) throw new BroadcastUnavailable(broadcastError);
        receipt = found;
      }
      receipt ??= await client.waitForTransactionReceipt({
        hash: record.hash,
        confirmations: 1,
        timeout: 90_000,
      });
    }
  } catch (error) {
    if (
      error instanceof BroadcastUnavailable ||
      error instanceof RevertedTransaction
    )
      throw error;
    throw new UnknownOutcome(record.hash);
  }
  // viem returns a replacement's receipt. Only our own versions count.
  if (!versions().includes(receipt.transactionHash)) {
    const found = await replacement().catch(() => null);
    if (found === "replaced") throw fail(new ReplacedTransaction());
    if (!found) throw new UnknownOutcome(record.hash);
    receipt = found;
  }
  if (receipt.status !== "success")
    // A mined revert proves that this attempt cannot later pay. Explicit retry may prepare a new transaction.
    throw fail(new RevertedTransaction());
  record.confirmed = true;
  persist();
  return receipt;
}

/**
 * Signs the same transaction again with higher fees when its fee cap is below the current
 * base fee, so that it can be mined. It keeps the nonce, so only one version can succeed.
 */
async function repriced(
  config: Deployment,
  session: Session,
  record: Record,
  persist: () => void,
) {
  const saved = parseTransaction(record.raw);
  if (saved.maxFeePerGas === undefined) return record;
  const block = await publicClient(config).getBlock({ blockTag: "latest" });
  if (!block.baseFeePerGas || saved.maxFeePerGas >= block.baseFeePerGas)
    return record;
  const fees = await publicClient(config).estimateFeesPerGas();
  // Nodes accept a same-nonce replacement only with both fees at least 10% higher.
  const bump = (old: bigint, next: bigint) =>
    next > (old * 11n) / 10n ? next : (old * 11n) / 10n + 1n;
  const raw = await accountFor(session).signTransaction({
    chainId: config.chainId,
    type: "eip1559",
    to: saved.to!,
    data: saved.data,
    value: saved.value,
    nonce: saved.nonce!,
    gas: saved.gas!,
    maxFeePerGas: bump(saved.maxFeePerGas, fees.maxFeePerGas),
    maxPriorityFeePerGas: bump(
      saved.maxPriorityFeePerGas ?? 0n,
      fees.maxPriorityFeePerGas,
    ),
  });
  record.earlier = [record.hash, ...(record.earlier ?? [])];
  record.raw = raw;
  record.hash = keccak256(raw);
  persist(); // The new version is saved before broadcast, like the first.
  return record;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
