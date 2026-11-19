import { beforeEach, expect, it, vi } from "vitest";
import { HttpRequestError, keccak256, parseTransaction, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { newSession, type Session } from "../../src/chain/session";
import { parseDeployment } from "../../src/chain/config";
import {
  RevertedTransaction,
  ReplacedTransaction,
  transact,
  UnknownOutcome,
  BroadcastUnavailable,
} from "../../src/chain/transactions";

const mocks = vi.hoisted(() => ({
  receipt: vi.fn(),
  broadcast: vi.fn(),
  wait: vi.fn(),
  pending: vi.fn(),
  count: vi.fn(),
  block: vi.fn(),
  fees: vi.fn(),
}));
vi.mock("../../src/chain/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/chain/config")>()),
  publicClient: () => ({
    getTransactionReceipt: mocks.receipt,
    sendRawTransaction: mocks.broadcast,
    waitForTransactionReceipt: mocks.wait,
    getTransaction: mocks.pending,
    getTransactionCount: mocks.count,
    getBlock: mocks.block,
    estimateFeesPerGas: mocks.fees,
  }),
}));
const config = parseDeployment({
  chainId: 31337,
  rpcUrl: "http://127.0.0.1:8545",
  address: `0x${"1".repeat(40)}`,
  token: `0x${"2".repeat(40)}`,
  deploymentBlock: "1",
  codeHash: `0x${"4".repeat(64)}`,
  faucetUrl: "https://example.com",
});
const NONCE = 5;
let session: Session;
let raw: Hex;
let hash: Hex;
const success = (transactionHash: Hex = hash) => ({
  status: "success",
  transactionHash,
});
beforeEach(async () => {
  vi.resetAllMocks();
  mocks.pending.mockRejectedValue(new Error("Not found"));
  mocks.receipt.mockRejectedValue(new Error("Not found"));
  mocks.count.mockResolvedValue(NONCE);
  mocks.block.mockResolvedValue({ baseFeePerGas: 1n });
  session = newSession(config);
  raw = await privateKeyToAccount(session.key).signTransaction({
    chainId: config.chainId,
    type: "eip1559",
    to: config.address,
    nonce: NONCE,
    gas: 100_000n,
    maxFeePerGas: 10n,
    maxPriorityFeePerGas: 1n,
  });
  hash = keccak256(raw);
  session.journal.send = { raw, hash, confirmed: false };
});
const run = (persist = () => {}) =>
  transact(config, session, persist, () => {}, "send", config.address);

it("stops before all RPC calls when saving evidence fails", async () => {
  await expect(
    run(() => {
      throw new Error("Storage unavailable");
    }),
  ).rejects.toThrow("Storage unavailable");
  expect(mocks.receipt).not.toHaveBeenCalled();
  expect(mocks.broadcast).not.toHaveBeenCalled();
});
it("retries the original signed bytes and reconciles a mined result", async () => {
  const persist = vi.fn();
  mocks.receipt
    .mockRejectedValueOnce(new Error("Not found"))
    .mockResolvedValueOnce(success());
  mocks.broadcast.mockImplementation(async ({ serializedTransaction }) => {
    expect(persist).toHaveBeenCalled();
    expect(serializedTransaction).toBe(raw);
  });
  await run(persist);
  expect(session.journal.send!.confirmed).toBe(true);
  expect(mocks.broadcast).toHaveBeenCalledTimes(1);
});
it("retains unknown evidence and reconciles without a second broadcast", async () => {
  mocks.wait.mockRejectedValue(new Error("Timeout"));
  mocks.broadcast.mockResolvedValue(hash);
  await expect(run()).rejects.toBeInstanceOf(UnknownOutcome);
  expect(session.journal.send!.raw).toBe(raw);
  mocks.receipt.mockResolvedValue(success());
  await run();
  expect(mocks.broadcast).toHaveBeenCalledTimes(1);
  expect(session.journal.send!.confirmed).toBe(true);
});
it("permits a new attempt only after a confirmed revert", async () => {
  mocks.receipt.mockResolvedValue({
    status: "reverted",
    transactionHash: hash,
  });
  await expect(run()).rejects.toBeInstanceOf(RevertedTransaction);
  expect(session.journal.send).toBeUndefined();
  expect(mocks.broadcast).not.toHaveBeenCalled();
});

it("reports a failed broadcast promptly and retries the exact saved bytes", async () => {
  mocks.broadcast.mockRejectedValueOnce(new Error("RPC unavailable"));
  await expect(run()).rejects.toBeInstanceOf(BroadcastUnavailable);
  expect(mocks.wait).not.toHaveBeenCalled();
  expect(session.journal.send!.raw).toBe(raw);
  mocks.wait.mockResolvedValue(success());
  await run();
  expect(
    mocks.broadcast.mock.calls.map(
      ([request]) => request.serializedTransaction,
    ),
  ).toEqual([raw, raw]);
  expect(session.journal.send!.confirmed).toBe(true);
});

it("accepts a confirmed receipt even if broadcast returned an error", async () => {
  mocks.receipt
    .mockRejectedValueOnce(new Error("Not found"))
    .mockResolvedValueOnce(success());
  mocks.broadcast.mockRejectedValue(new Error("Already known"));
  await run();
  expect(session.journal.send!.confirmed).toBe(true);
});

it("reports rate limits without exposing the RPC URL or signed bytes", async () => {
  mocks.broadcast.mockRejectedValue(
    new HttpRequestError({
      url: "https://example.com/private-key",
      status: 429,
      body: { params: [raw] },
    }),
  );
  await expect(run()).rejects.toThrow(
    "The RPC is busy. Progress saved. Please retry.",
  );
  expect(mocks.wait).not.toHaveBeenCalled();
  expect(session.journal.send!.confirmed).toBe(false);
});

it("waits for a transaction that is still pending after a timeout", async () => {
  mocks.broadcast.mockRejectedValue(new Error("already known"));
  mocks.pending.mockResolvedValue({ hash });
  mocks.wait.mockResolvedValue(success());
  await run();
  expect(mocks.wait).toHaveBeenCalledTimes(1);
  expect(session.journal.send!.confirmed).toBe(true);
});

it("allows a new attempt once another transaction has used the nonce", async () => {
  mocks.broadcast.mockRejectedValue(new Error("nonce too low"));
  mocks.count.mockResolvedValue(NONCE + 1);
  await expect(run()).rejects.toBeInstanceOf(ReplacedTransaction);
  expect(session.journal.send).toBeUndefined();
  // The nonce was read twice, so one lagging node cannot prove replacement alone.
  expect(mocks.count).toHaveBeenCalledTimes(2);
});

it("keeps the saved bytes while the nonce is unused", async () => {
  mocks.broadcast.mockRejectedValue(new Error("RPC unavailable"));
  await expect(run()).rejects.toBeInstanceOf(BroadcastUnavailable);
  expect(session.journal.send!.raw).toBe(raw);
});

it("keeps the saved bytes when a second check finds them mined", async () => {
  mocks.count.mockResolvedValue(NONCE + 1);
  mocks.receipt
    .mockRejectedValueOnce(new Error("Not found"))
    .mockRejectedValueOnce(new Error("Not found"))
    .mockResolvedValue(success());
  await run();
  expect(session.journal.send!.confirmed).toBe(true);
  expect(mocks.broadcast).not.toHaveBeenCalled();
});

it("does not accept a receipt for another transaction", async () => {
  mocks.broadcast.mockResolvedValue(hash);
  mocks.wait.mockResolvedValue(success(`0x${"9".repeat(64)}`));
  await expect(run()).rejects.toBeInstanceOf(UnknownOutcome);
  expect(session.journal.send!.confirmed).toBe(false);
  mocks.count.mockResolvedValue(NONCE + 1);
  await expect(run()).rejects.toBeInstanceOf(ReplacedTransaction);
});

it("signs a higher-fee version with the same nonce when the fee cap is too low", async () => {
  mocks.block.mockResolvedValue({ baseFeePerGas: 50n });
  mocks.fees.mockResolvedValue({
    maxFeePerGas: 120n,
    maxPriorityFeePerGas: 2n,
  });
  const persisted: string[] = [];
  mocks.broadcast.mockImplementation(async () => {
    expect(persisted.at(-1)).toBe(session.journal.send!.raw);
  });
  mocks.wait.mockImplementation(async () => success(hash));
  await run(() => persisted.push(session.journal.send!.raw));
  const record = session.journal.send!;
  const next = parseTransaction(record.raw);
  expect(next.nonce).toBe(NONCE);
  expect(next.maxFeePerGas).toBe(120n);
  expect(next.maxPriorityFeePerGas).toBe(2n);
  expect(record.earlier).toEqual([hash]);
  // The first version was mined, and it counts as this operation's result.
  expect(record.confirmed).toBe(true);
});
