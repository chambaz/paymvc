import {
  appendTransactionMessageInstructions,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  signature,
  type Base64EncodedWireTransaction,
  type Instruction,
  isSolanaError,
  SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR,
} from "@solana/kit";
import { rpc, type Deployment } from "./config";
import { signerFor, type Session } from "./session";

export class UnknownOutcome extends Error {
  constructor(public hash: string) {
    super(
      "Outcome unknown. Recheck the original transaction before continuing.",
    );
  }
}
/** The transaction landed and failed, so nothing changed. `slot` is where it landed. */
export class RevertedTransaction extends Error {
  constructor(public slot?: bigint) {
    super("The transaction failed on-chain, so nothing changed.");
  }
}
export class ExpiredTransaction extends Error {
  constructor() {
    super(
      "The transaction expired without confirmation. Retry the saved operation.",
    );
  }
}
export type Progress = (message: string) => void;

export class BroadcastUnavailable extends Error {
  constructor(error: unknown) {
    super(
      isSolanaError(error, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR) &&
        error.context.statusCode === 429
        ? "The RPC is busy. Progress saved. Please retry."
        : "The RPC could not confirm submission. Progress saved. Retry to check the saved transaction.",
    );
  }
}

export class ResultPending extends Error {
  constructor() {
    super("The network is still updating this result. Your progress is saved.");
  }
}

/**
 * Persist signed bytes before broadcast. Only finalized expiry permits a new signature.
 * Returns the slot where the transaction confirmed, so that reads can wait for that state.
 */
export async function transact(
  c: Deployment,
  s: Session,
  persist: () => void,
  progress: Progress,
  label: string,
  instructions: () => Promise<Instruction[]>,
) {
  const client = rpc(c);
  let record = s.journal[label];
  if (!record) {
    progress("Preparing transaction");
    const signer = await signerFor(s);
    const ixs = await instructions();
    const { value: lifetime } = await client
      .getLatestBlockhash({ commitment: "confirmed" })
      .send();
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayer(signer.address, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(lifetime, m),
      (m) => appendTransactionMessageInstructions(ixs, m),
    );
    const tx = await signTransactionMessageWithSigners(message);
    record = {
      raw: getBase64EncodedWireTransaction(tx),
      hash: getSignatureFromTransaction(tx),
      lastValidBlockHeight: String(lifetime.lastValidBlockHeight),
      confirmed: false,
    };
    s.journal[label] = record;
  }
  persist();
  progress("Waiting for confirmation");
  const hash = signature(record.hash);
  const lookupAt = async () =>
    client
      .getSignatureStatuses([hash], { searchTransactionHistory: true })
      .send();
  const lookup = async () => (await lookupAt()).value[0];
  /** Settle a `confirmed` status: record success, or clear the journal and throw on a landed failure. */
  const settle = (status: Awaited<ReturnType<typeof lookup>>) => {
    if (
      status?.confirmationStatus !== "confirmed" &&
      status?.confirmationStatus !== "finalized"
    )
      return undefined;
    if (status.err) {
      delete s.journal[label];
      persist();
      throw new RevertedTransaction(status.slot);
    }
    record.confirmed = true;
    persist();
    return status.slot;
  };
  // Poll every 2 s and resend the saved bytes at most every 5 s. A failed read
  // proves nothing: keep waiting until the time limit, then report it unknown.
  const poll = c.network === "localnet" ? 100 : 2_000;
  const started = Date.now();
  let sentAt = -Infinity;
  while (Date.now() - started < 90_000) {
    // `undefined` means the read failed; `null` means no transaction was found.
    const landed = settle(await lookup().catch(() => undefined));
    if (landed !== undefined) return landed;
    const height = await client
      .getBlockHeight({ commitment: "finalized" })
      .send()
      .catch(() => undefined);
    if (height !== undefined && height > BigInt(record.lastValidBlockHeight)) {
      // Recheck after observing finalized expiry. A confirmed record is never discarded.
      // Public RPCs balance load across nodes, so a "not found" proves absence only
      // from a node that has reached the finalized slot read here.
      const finalized = await client
        .getSlot({ commitment: "finalized" })
        .send()
        .catch(() => undefined);
      const final = await lookupAt().catch(() => undefined);
      const found = settle(final?.value[0]);
      if (found !== undefined) return found;
      if (
        finalized !== undefined &&
        final?.value[0] === null &&
        final.context.slot >= finalized &&
        !record.confirmed
      ) {
        delete s.journal[label];
        persist();
        throw new ExpiredTransaction();
      }
    } else if (height !== undefined && Date.now() - sentAt >= 5_000) {
      sentAt = Date.now();
      try {
        // Skip preflight so the saved bytes can land even if they will fail.
        // A landed failure proves the outcome on-chain; a preflight rejection
        // proves nothing and leaves the saved transaction unresolved until expiry.
        // Inputs and balances are checked before signing to avoid wasted fees.
        await client
          .sendTransaction(record.raw as Base64EncodedWireTransaction, {
            encoding: "base64",
            skipPreflight: true,
            maxRetries: 0n,
          })
          .send();
      } catch (error) {
        // A rejected response does not prove absence. Reconcile before reporting it.
        const found = settle(await lookup().catch(() => undefined));
        if (found !== undefined) return found;
        throw new BroadcastUnavailable(error);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, poll));
  }
  throw new UnknownOutcome(record.hash);
}
