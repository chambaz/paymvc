import { beforeEach, expect, it, vi } from "vitest";
import { Transaction, TransactionDataBuilder } from "@mysten/sui/transactions";
import { TransactionError } from "@mysten/sui/client";
import { normalizeSuiAddress } from "@mysten/sui/utils";
import { newSession, signerFor, accountFor } from "../../src/chain/session";
import type { Deployment } from "../../src/chain/config";
import {
  transact,
  UnknownOutcome,
  ExpiredTransaction,
  RevertedTransaction,
  RejectedTransaction,
} from "../../src/chain/transactions";

const client = vi.hoisted(() => ({
  getTransaction: vi.fn(),
  getCurrentSystemState: vi.fn(),
  executeTransaction: vi.fn(),
  waitForTransaction: vi.fn(),
  ledgerService: { getServiceInfo: vi.fn() },
}));
vi.mock("../../src/chain/config", async (original) => ({
  ...(await original<typeof import("../../src/chain/config")>()),
  server: () => client,
}));
const config: Deployment = {
  network: "testnet",
  rpcUrl: "https://fullnode.testnet.sui.io:443",
  chainIdentifier: "69WiPg3DAQiwdxfncX6wYQ2siKwAe6L9BZthQea3JNMD",
  package: normalizeSuiAddress("1"),
  app: normalizeSuiAddress("2"),
  packageDigest: "test",
  immutableDigest: "publish",
  faucetUrl: "https://faucet.sui.io/",
};
async function saved() {
  const session = newSession(config);
  const tx = new Transaction();
  tx.setSender(accountFor(session).address);
  tx.setGasPrice(1);
  tx.setGasBudget(1000);
  tx.setGasPayment([]);
  tx.setExpiration({
    ValidDuring: {
      minEpoch: "1",
      maxEpoch: "2",
      minTimestamp: null,
      maxTimestamp: null,
      chain: config.chainIdentifier,
      nonce: 1,
    },
  });
  const bytes = await tx.build();
  const signed = await signerFor(session).signTransaction(bytes);
  session.journal.payment = {
    raw: signed.bytes,
    signature: signed.signature,
    hash: TransactionDataBuilder.getDigestFromBytes(bytes),
    epoch: "2",
    checkpoint: "10",
    confirmed: false,
  };
  return session;
}
beforeEach(() => {
  vi.resetAllMocks();
  client.getTransaction.mockRejectedValue(
    new TransactionError("notFound", "test"),
  );
  client.getCurrentSystemState.mockResolvedValue({
    systemState: { epoch: "2" },
  });
  client.ledgerService.getServiceInfo.mockResolvedValue({
    response: { lowestAvailableCheckpoint: 0n },
  });
  client.executeTransaction.mockResolvedValue({ $kind: "Transaction" });
  client.waitForTransaction.mockResolvedValue({ $kind: "Transaction" });
});
it("rebroadcasts the saved bytes without rebuilding, after persistence", async () => {
  const s = await saved();
  const build = vi.fn();
  const persist = vi.fn();
  await transact(config, s, persist, () => {}, "payment", build);
  expect(build).not.toHaveBeenCalled();
  expect(client.executeTransaction).toHaveBeenCalledOnce();
  expect(persist.mock.invocationCallOrder[0]).toBeLessThan(
    client.executeTransaction.mock.invocationCallOrder[0]!,
  );
  expect(s.journal.payment?.confirmed).toBe(true);
});
it("does not broadcast when storage fails", async () => {
  const s = await saved();
  await expect(
    transact(
      config,
      s,
      () => {
        throw new Error("quota");
      },
      () => {},
      "payment",
      vi.fn(),
    ),
  ).rejects.toThrow("quota");
  expect(client.executeTransaction).not.toHaveBeenCalled();
  expect(s.journal.payment).toBeDefined();
});
it("retains evidence after an uncertain broadcast", async () => {
  const s = await saved();
  const evidence = { ...s.journal.payment };
  client.executeTransaction.mockRejectedValue(new Error("connection lost"));
  await expect(
    transact(config, s, vi.fn(), () => {}, "payment", vi.fn()),
  ).rejects.toBeInstanceOf(UnknownOutcome);
  expect(s.journal.payment).toEqual(evidence);
});
it("does not rebroadcast after a failed lookup", async () => {
  const s = await saved();
  client.getTransaction.mockRejectedValue(new Error("offline"));
  await expect(
    transact(config, s, vi.fn(), () => {}, "payment", vi.fn()),
  ).rejects.toBeInstanceOf(UnknownOutcome);
  expect(client.executeTransaction).not.toHaveBeenCalled();
});
it("without a state check, requires retained history before declaring expiry", async () => {
  const s = await saved();
  client.getCurrentSystemState.mockResolvedValue({
    systemState: { epoch: "3" },
  });
  client.ledgerService.getServiceInfo.mockResolvedValue({
    response: { lowestAvailableCheckpoint: 11n },
  });
  await expect(
    transact(config, s, vi.fn(), () => {}, "payment", vi.fn()),
  ).rejects.toBeInstanceOf(UnknownOutcome);
  expect(s.journal.payment).toBeDefined();
  expect(client.executeTransaction).not.toHaveBeenCalled();
});
it("checks absence again after expiry before releasing evidence", async () => {
  const s = await saved();
  client.getCurrentSystemState.mockResolvedValue({
    systemState: { epoch: "3" },
  });
  await expect(
    transact(config, s, vi.fn(), () => {}, "payment", vi.fn()),
  ).rejects.toBeInstanceOf(ExpiredTransaction);
  expect(client.getTransaction).toHaveBeenCalledTimes(2);
  expect(s.journal.payment).toBeUndefined();
});
it("keeps a transaction whose effect is on chain when history no longer has it", async () => {
  const s = await saved();
  client.getCurrentSystemState.mockResolvedValue({
    systemState: { epoch: "3" },
  });
  client.ledgerService.getServiceInfo.mockResolvedValue({
    response: { lowestAvailableCheckpoint: 11n },
  });
  const persist = vi.fn();
  // The node reports "not found", but the state shows the payment happened.
  const hash = await transact(
    config,
    s,
    persist,
    () => {},
    "payment",
    vi.fn(),
    async () => false,
  );
  expect(hash).toBe(s.journal.payment!.hash);
  expect(s.journal.payment!.confirmed).toBe(true);
});
it("proves expiry from state when history no longer has the transaction", async () => {
  const s = await saved();
  client.getCurrentSystemState.mockResolvedValue({
    systemState: { epoch: "3" },
  });
  client.ledgerService.getServiceInfo.mockResolvedValue({
    response: { lowestAvailableCheckpoint: 11n },
  });
  await expect(
    transact(
      config,
      s,
      vi.fn(),
      () => {},
      "payment",
      vi.fn(),
      async () => true,
    ),
  ).rejects.toBeInstanceOf(ExpiredTransaction);
  expect(s.journal.payment).toBeUndefined();
});
it("keeps the transaction unconfirmed when the state read fails", async () => {
  const s = await saved();
  client.getCurrentSystemState.mockResolvedValue({
    systemState: { epoch: "3" },
  });
  const absent = async () => {
    throw new Error("429 Too Many Requests");
  };
  await expect(
    transact(config, s, vi.fn(), () => {}, "payment", vi.fn(), absent),
  ).rejects.toBeInstanceOf(UnknownOutcome);
  expect(s.journal.payment!.confirmed).toBe(false);
});
it("accepts a transaction found at the expiry boundary", async () => {
  const s = await saved();
  client.getCurrentSystemState.mockResolvedValue({
    systemState: { epoch: "3" },
  });
  client.getTransaction
    .mockRejectedValueOnce(new TransactionError("notFound", "test"))
    .mockResolvedValueOnce({ $kind: "Transaction" });
  await transact(config, s, vi.fn(), () => {}, "payment", vi.fn());
  expect(s.journal.payment?.confirmed).toBe(true);
  expect(client.executeTransaction).not.toHaveBeenCalled();
});
it("releases a definitively failed transaction for explicit retry", async () => {
  const s = await saved();
  client.getTransaction.mockResolvedValue({ $kind: "FailedTransaction" });
  await expect(
    transact(config, s, vi.fn(), () => {}, "payment", vi.fn()),
  ).rejects.toBeInstanceOf(RevertedTransaction);
  expect(s.journal.payment).toBeUndefined();
  expect(client.executeTransaction).not.toHaveBeenCalled();
});
it("releases bytes the network rejects permanently", async () => {
  const s = await saved();
  const persist = vi.fn();
  client.executeTransaction.mockRejectedValue(
    Object.assign(
      new Error("Transaction chain ID a does not match network chain ID b."),
      { code: "INVALID_ARGUMENT" },
    ),
  );
  const result = transact(config, s, persist, () => {}, "payment", vi.fn());
  await expect(result).rejects.toBeInstanceOf(RejectedTransaction);
  await expect(result).rejects.toBeInstanceOf(RevertedTransaction);
  expect(s.journal.payment).toBeUndefined();
  expect(persist).toHaveBeenCalledTimes(2);
});
it.each([
  "Transaction Expired",
  "Transaction needs to be rebuilt because object 0x1 version 4 is unavailable for consumption, current version: 5",
  "Could not find the referenced object 0x1",
])("keeps evidence after a rejection that can change: %s", async (text) => {
  const s = await saved();
  const evidence = { ...s.journal.payment };
  client.executeTransaction.mockRejectedValue(
    Object.assign(new Error(text), { code: "INVALID_ARGUMENT" }),
  );
  await expect(
    transact(config, s, vi.fn(), () => {}, "payment", vi.fn()),
  ).rejects.toBeInstanceOf(UnknownOutcome);
  expect(s.journal.payment).toEqual(evidence);
});

it("reports a failed epoch or history read as an unknown outcome", async () => {
  const s = await saved();
  client.getCurrentSystemState.mockRejectedValue(new Error("503"));
  await expect(
    transact(
      config,
      s,
      vi.fn(),
      () => {},
      "payment",
      vi.fn(),
      async () => true,
    ),
  ).rejects.toBeInstanceOf(UnknownOutcome);
  client.getCurrentSystemState.mockResolvedValue({
    systemState: { epoch: "3" },
  });
  client.ledgerService.getServiceInfo.mockRejectedValue(new Error("503"));
  await expect(
    transact(
      config,
      s,
      vi.fn(),
      () => {},
      "payment",
      vi.fn(),
      async () => true,
    ),
  ).rejects.toBeInstanceOf(UnknownOutcome);
  expect(s.journal.payment).toBeDefined();
});
