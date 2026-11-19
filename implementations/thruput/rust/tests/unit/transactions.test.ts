import { beforeEach, expect, it, vi } from "vitest";
import {
  addressFromBase58,
  gasAmount,
  hashFromBase58,
} from "@thruputchain/client";
import { networkHash } from "@thruputchain/protocol";
import type { Client } from "../../src/chain/config";
import { PayMVC } from "../../src/chain/generated/paymvc";
import { recheckOnce } from "../../src/chain/recovery";
import { newSession, type Session } from "../../src/chain/session";
import {
  transact,
  UnknownOutcome,
  ResultPending,
  RevertedTransaction,
  ExpiredTransaction,
} from "../../src/chain/transactions";
import { config } from "./fixture";

let session: Session;
let durable = "";
const network = {
  networkHash: networkHash(hashFromBase58(config.networkHash)),
};
const client = {
  discovery: { network },
  network,
  getBalance: vi.fn(),
  getChainTip: vi.fn(),
  sendTransaction: vi.fn(),
  getTransactionReceipt: vi.fn(),
  getTransactionStatus: vi.fn(),
  waitForTransactionReceipt: vi.fn(),
};
const call = PayMVC.v0_1.register.invocation(
  addressFromBase58(config.address),
  gasAmount(1_000_000n),
);
const persist = () => {
  durable = JSON.stringify(session);
};
const absent = vi.fn();
const run = (save = persist) =>
  transact(
    config,
    session,
    save,
    () => {},
    "registration",
    client as unknown as Client,
    [call],
    absent,
  );
const receipt = (result: "return" | "abort") => ({
  blockHeight: 110n,
  execution:
    result === "return" ? { result } : { result, abortData: new Uint8Array() },
});
const saved = () => session.journal.registration;

beforeEach(() => {
  vi.resetAllMocks();
  session = newSession(config);
  durable = "";
  absent.mockResolvedValue(false);
  client.getChainTip.mockResolvedValue({ blockHeight: 100n });
  client.getTransactionReceipt.mockResolvedValue(null);
  client.getTransactionStatus.mockResolvedValue({ status: "unknown" });
  client.waitForTransactionReceipt.mockRejectedValue(new Error("timeout"));
});

it("saves signed bytes before broadcast and resumes without replacing the transaction", async () => {
  client.sendTransaction.mockImplementation(async () => {
    expect(JSON.parse(durable).journal.registration).toBeDefined();
  });
  await expect(run()).rejects.toBeInstanceOf(UnknownOutcome);
  const before = saved()!.raw;
  client.getTransactionReceipt.mockResolvedValue(receipt("return"));
  await run();
  expect(saved()!.raw).toBe(before);
  expect(saved()!.confirmed).toBe(true);
  expect(session.stateHeight).toBe("110");
  expect(client.sendTransaction).toHaveBeenCalledOnce();
});

it("does not broadcast when durable storage fails", async () => {
  await expect(
    run(() => {
      throw new Error("storage failed");
    }),
  ).rejects.toThrow("storage failed");
  expect(client.sendTransaction).not.toHaveBeenCalled();
});

it("deletes a failed transaction so only an explicit retry signs a new one", async () => {
  client.waitForTransactionReceipt.mockResolvedValue(receipt("abort"));
  await expect(run()).rejects.toBeInstanceOf(RevertedTransaction);
  expect(saved()).toBeUndefined();
  expect(JSON.parse(durable).journal).toEqual({});
  await expect(run()).rejects.toBeInstanceOf(RevertedTransaction);
  expect(client.sendTransaction).toHaveBeenCalledTimes(2);
  const [first, second] = client.sendTransaction.mock.calls;
  expect(second).not.toEqual(first);
});

it("never signs again during the automatic recheck after a definitive failure", async () => {
  client.waitForTransactionReceipt.mockResolvedValue(receipt("abort"));
  await expect(
    recheckOnce(
      run,
      (error) =>
        error instanceof UnknownOutcome || error instanceof ResultPending,
      () => {},
      () => true,
    ),
  ).rejects.toBeInstanceOf(RevertedTransaction);
  expect(client.sendTransaction).toHaveBeenCalledOnce();
});

it("requires an after-expiry absence proof before a new attempt", async () => {
  await expect(run()).rejects.toBeInstanceOf(UnknownOutcome);
  client.getChainTip.mockResolvedValue({ blockHeight: 400n });
  absent.mockResolvedValue(true);
  await expect(run()).rejects.toBeInstanceOf(ExpiredTransaction);
  expect(absent).toHaveBeenCalledWith(400n);
  expect(saved()).toBeUndefined();
  expect(client.sendTransaction).toHaveBeenCalledOnce();
});

it("keeps an expired transaction whose effect exists", async () => {
  await expect(run()).rejects.toBeInstanceOf(UnknownOutcome);
  client.getChainTip.mockResolvedValue({ blockHeight: 400n });
  await expect(run()).rejects.toBeInstanceOf(UnknownOutcome);
  expect(absent).toHaveBeenCalledWith(400n);
  expect(saved()).toBeDefined();
  expect(client.sendTransaction).toHaveBeenCalledOnce();
});

it("never replaces a known commitment with a missing receipt", async () => {
  await expect(run()).rejects.toBeInstanceOf(UnknownOutcome);
  client.getTransactionStatus.mockResolvedValue({
    status: "committed",
    blockHeight: 110n,
  });
  client.getChainTip.mockResolvedValue({ blockHeight: 400n });
  absent.mockResolvedValue(true);
  await expect(run()).rejects.toBeInstanceOf(UnknownOutcome);
  expect(absent).not.toHaveBeenCalled();
  expect(saved()!.blockHeight).toBe("110");
  expect(client.waitForTransactionReceipt).toHaveBeenLastCalledWith(
    expect.anything(),
    expect.objectContaining({
      knownCommitment: expect.objectContaining({ blockHeight: 110n }),
    }),
  );
  expect(client.sendTransaction).toHaveBeenCalledOnce();
});

it("resubmits only the saved bytes when the scheduler asks for a retry", async () => {
  await expect(run()).rejects.toBeInstanceOf(UnknownOutcome);
  client.getTransactionStatus.mockResolvedValue({ status: "retry" });
  await expect(run()).rejects.toBeInstanceOf(UnknownOutcome);
  const [first, second] = client.sendTransaction.mock.calls;
  expect(second).toEqual(first);
  expect(Object.keys(session.journal)).toEqual(["registration"]);
});
