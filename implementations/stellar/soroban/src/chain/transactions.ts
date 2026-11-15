import {
  Account,
  Contract,
  rpc,
  scValToNative,
  Transaction,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import { Buffer } from "buffer";
import { server, type Deployment } from "./config";
import { signerFor, type Session } from "./session";

export class UnknownOutcome extends Error {
  constructor() {
    super(
      "The transaction outcome is unknown. Progress saved. Retry to check it.",
    );
  }
}
export class BroadcastUnavailable extends Error {
  constructor(
    message = "The RPC is busy or unavailable. Progress saved. Please retry.",
  ) {
    super(message);
  }
}
// The broadcast did not land. Evidence stays saved and Retry stays available.
export class RejectedTransaction extends BroadcastUnavailable {
  constructor() {
    super(
      "The network rejected this transaction. Your progress is saved; retry after it expires to prepare a new one.",
    );
  }
}
export class RevertedTransaction extends Error {
  constructor() {
    super("The transaction failed. Check funding and retry.");
  }
}
export class ExpiredTransaction extends Error {
  constructor() {
    super(
      "The saved transaction expired without confirmation. Retry to prepare it again.",
    );
  }
}
export class ResultPending extends Error {
  constructor() {
    super("The network is still updating this result. Your progress is saved.");
  }
}
export async function readContract(
  c: Deployment,
  source: string,
  contract: string,
  method: string,
  args: xdr.ScVal[] = [],
): Promise<unknown> {
  // Simulation does not consume the account sequence or broadcast a transaction.
  const tx = new TransactionBuilder(new Account(source, "0"), {
    fee: "100",
    networkPassphrase: c.passphrase,
  })
    .addOperation(new Contract(contract).call(method, ...args))
    .setTimeout(120)
    .build();
  const result = await server(c).simulateTransaction(tx);
  if (!rpc.Api.isSimulationSuccess(result) || !result.result)
    throw new Error("The contract read could not be completed. Please retry.");
  return scValToNative(result.result.retval);
}

export async function transact(
  c: Deployment,
  s: Session,
  persist: () => void,
  label: string,
  operations: () => Promise<xdr.Operation[]>,
) {
  const client = server(c);
  let record = s.journal[label];
  if (!record) {
    const signer = signerFor(s);
    const ledger = await client.getLatestLedger();
    const account = await client.getAccount(signer.publicKey());
    const builder = new TransactionBuilder(account, {
      fee: "10000",
      networkPassphrase: c.passphrase,
    });
    for (const op of await operations()) builder.addOperation(op);
    const draft = builder
      .setTimebounds(0, Number(ledger.closeTime) + 180)
      .build();
    // Simulation returns the resources, fee, and footprint the network requires.
    const sim = await client.simulateTransaction(draft);
    if (!rpc.Api.isSimulationSuccess(sim))
      throw new Error(
        "The contract could not prepare this step. Check credits and XLM funding, then retry.",
      );
    if (rpc.Api.isSimulationRestore(sim))
      throw new Error(
        "This contract needs a separate storage restore. Restore its footprint before retrying.",
      );
    const tx = rpc.assembleTransaction(draft, sim).build();
    tx.sign(signer);
    record = {
      raw: tx.toXDR(),
      hash: Buffer.from(tx.hash()).toString("hex"),
      preparedLedger: ledger.sequence,
      confirmed: false,
    };
    s.journal[label] = record;
  }
  // Retry storage too: a previous save may have failed after updating memory.
  persist();
  if (record.confirmed) return;
  const tx = TransactionBuilder.fromXDR(record.raw, c.passphrase);
  if (!(tx instanceof Transaction))
    throw new Error("Unsupported saved transaction.");
  // Returns true when confirmed. Throws when the chain proves failure or expiry.
  const reconcile = async () => {
    const result = await client.getTransaction(record.hash);
    if (result.status === rpc.Api.GetTransactionStatus.SUCCESS) {
      record.confirmed = true;
      persist();
      return true;
    }
    if (result.status === rpc.Api.GetTransactionStatus.FAILED) {
      delete s.journal[label];
      persist();
      throw new RevertedTransaction();
    }
    // NOT_FOUND proves absence only while the RPC still covers the entire signed lifetime.
    if (
      result.latestLedgerCloseTime > Number(tx.timeBounds!.maxTime) &&
      result.oldestLedger <= record.preparedLedger
    ) {
      delete s.journal[label];
      persist();
      throw new ExpiredTransaction();
    }
    return false;
  };
  try {
    if (await reconcile()) return;
    const status = await client.sendTransaction(tx).then(
      (response) => response.status,
      () => "UNAVAILABLE" as const,
    );
    // The broadcast did not land now, but an earlier one may have. Reconcile first.
    // ERROR means the network refused these bytes (for example a stale sequence).
    // Keep the evidence: only proven expiry or failure allows a new transaction.
    if (
      status === "ERROR" ||
      status === "TRY_AGAIN_LATER" ||
      status === "UNAVAILABLE"
    ) {
      if (await reconcile()) return;
      throw status === "ERROR"
        ? new RejectedTransaction()
        : new BroadcastUnavailable();
    }
    for (let attempt = 0; attempt < 30; attempt++) {
      if (await reconcile()) return;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new UnknownOutcome();
  } catch (error) {
    // RejectedTransaction is a BroadcastUnavailable. Any other error, such as a
    // failed lookup, leaves the outcome unknown.
    if (
      error instanceof RevertedTransaction ||
      error instanceof ExpiredTransaction ||
      error instanceof BroadcastUnavailable
    )
      throw error;
    throw new UnknownOutcome();
  }
}
