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
  await transact(config, s, "payment", build, persist);
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
    transact(config, s, "payment", vi.fn(), () => {
      throw new Error("quota");
    }),
  ).rejects.toThrow("quota");
  expect(client.executeTransaction).not.toHaveBeenCalled();
  expect(s.journal.payment).toBeDefined();
});
it("retains evidence after an uncertain broadcast", async () => {
  const s = await saved();
  const evidence = { ...s.journal.payment };
  client.executeTransaction.mockRejectedValue(new Error("connection lost"));
  await expect(
    transact(config, s, "payment", vi.fn(), vi.fn()),
  ).rejects.toBeInstanceOf(UnknownOutcome);
  expect(s.journal.payment).toEqual(evidence);
});
it("does not rebroadcast after a failed lookup", async () => {
  const s = await saved();
  client.getTransaction.mockRejectedValue(new Error("offline"));
  await expect(
    transact(config, s, "payment", vi.fn(), vi.fn()),
  ).rejects.toBeInstanceOf(UnknownOutcome);
  expect(client.executeTransaction).not.toHaveBeenCalled();
});
it("requires retained history before declaring expiry", async () => {
  const s = await saved();
  client.getCurrentSystemState.mockResolvedValue({
    systemState: { epoch: "3" },
  });
  client.ledgerService.getServiceInfo.mockResolvedValue({
    response: { lowestAvailableCheckpoint: 11n },
  });
  await expect(
    transact(config, s, "payment", vi.fn(), vi.fn()),
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
    transact(config, s, "payment", vi.fn(), vi.fn()),
  ).rejects.toBeInstanceOf(ExpiredTransaction);
  expect(client.getTransaction).toHaveBeenCalledTimes(2);
  expect(s.journal.payment).toBeUndefined();
});
it("accepts a transaction found at the expiry boundary", async () => {
  const s = await saved();
  client.getCurrentSystemState.mockResolvedValue({
    systemState: { epoch: "3" },
  });
  client.getTransaction
    .mockRejectedValueOnce(new TransactionError("notFound", "test"))
    .mockResolvedValueOnce({ $kind: "Transaction" });
  await transact(config, s, "payment", vi.fn(), vi.fn());
  expect(s.journal.payment?.confirmed).toBe(true);
  expect(client.executeTransaction).not.toHaveBeenCalled();
});
it("releases a definitively failed transaction for explicit retry", async () => {
  const s = await saved();
  client.getTransaction.mockResolvedValue({ $kind: "FailedTransaction" });
  await expect(
    transact(config, s, "payment", vi.fn(), vi.fn()),
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
  const result = transact(config, s, "payment", vi.fn(), persist);
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
    transact(config, s, "payment", vi.fn(), vi.fn()),
  ).rejects.toBeInstanceOf(UnknownOutcome);
  expect(s.journal.payment).toEqual(evidence);
});
