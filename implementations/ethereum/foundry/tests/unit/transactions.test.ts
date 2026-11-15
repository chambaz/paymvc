import { beforeEach, expect, it, vi } from "vitest";
import { HttpRequestError } from "viem";
import { newSession, type Session } from "../../src/chain/session";
import { parseDeployment } from "../../src/chain/config";
import {
  RevertedTransaction,
  transact,
  UnknownOutcome,
  BroadcastUnavailable,
} from "../../src/chain/transactions";

const mocks = vi.hoisted(() => ({
  receipt: vi.fn(),
  broadcast: vi.fn(),
  wait: vi.fn(),
  pending: vi.fn(),
}));
vi.mock("../../src/chain/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/chain/config")>()),
  publicClient: () => ({
    getTransactionReceipt: mocks.receipt,
    sendRawTransaction: mocks.broadcast,
    waitForTransactionReceipt: mocks.wait,
    getTransaction: mocks.pending,
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
let session: Session;
beforeEach(() => {
  vi.resetAllMocks();
  mocks.pending.mockRejectedValue(new Error("Not found"));
  session = newSession(config);
  session.journal.send = {
    raw: "0x1234",
    hash: `0x${"3".repeat(64)}`,
    confirmed: false,
  };
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
    .mockResolvedValueOnce({ status: "success" });
  mocks.broadcast.mockImplementation(async ({ serializedTransaction }) => {
    expect(persist).toHaveBeenCalled();
    expect(serializedTransaction).toBe("0x1234");
  });
  await run(persist);
  expect(session.journal.send!.confirmed).toBe(true);
  expect(mocks.broadcast).toHaveBeenCalledTimes(1);
});
it("retains unknown evidence and reconciles without a second broadcast", async () => {
  mocks.receipt.mockRejectedValue(new Error("Unavailable"));
  mocks.wait.mockRejectedValue(new Error("Timeout"));
  await expect(run()).rejects.toBeInstanceOf(UnknownOutcome);
  expect(session.journal.send!.raw).toBe("0x1234");
  mocks.receipt.mockResolvedValue({ status: "success" });
  await run();
  expect(mocks.broadcast).toHaveBeenCalledTimes(1);
  expect(session.journal.send!.confirmed).toBe(true);
});
it("permits a new attempt only after a confirmed revert", async () => {
  mocks.receipt.mockResolvedValue({ status: "reverted" });
  await expect(run()).rejects.toBeInstanceOf(RevertedTransaction);
  expect(session.journal.send).toBeUndefined();
  expect(mocks.broadcast).not.toHaveBeenCalled();
});

it("reports a failed broadcast promptly and retries the exact saved bytes", async () => {
  mocks.receipt.mockRejectedValue(new Error("Not found"));
  mocks.broadcast.mockRejectedValueOnce(new Error("RPC unavailable"));
  await expect(run()).rejects.toBeInstanceOf(BroadcastUnavailable);
  expect(mocks.wait).not.toHaveBeenCalled();
  expect(session.journal.send!.raw).toBe("0x1234");
  mocks.wait.mockResolvedValue({ status: "success" });
  await run();
  expect(
    mocks.broadcast.mock.calls.map(
      ([request]) => request.serializedTransaction,
    ),
  ).toEqual(["0x1234", "0x1234"]);
  expect(session.journal.send!.confirmed).toBe(true);
});

it("accepts a confirmed receipt even if broadcast returned an error", async () => {
  mocks.receipt
    .mockRejectedValueOnce(new Error("Not found"))
    .mockResolvedValueOnce({ status: "success" });
  mocks.broadcast.mockRejectedValue(new Error("Already known"));
  await run();
  expect(session.journal.send!.confirmed).toBe(true);
});

it("reports rate limits without exposing the RPC URL or signed bytes", async () => {
  mocks.receipt.mockRejectedValue(new Error("Not found"));
  mocks.broadcast.mockRejectedValue(
    new HttpRequestError({
      url: "https://example.com/private-key",
      status: 429,
      body: { params: ["0x1234"] },
    }),
  );
  await expect(run()).rejects.toThrow(
    "The RPC is busy. Progress saved. Please retry.",
  );
  expect(mocks.wait).not.toHaveBeenCalled();
  expect(session.journal.send!.confirmed).toBe(false);
});

it("waits for a transaction that is still pending after a timeout", async () => {
  mocks.receipt.mockRejectedValue(new Error("Not found"));
  mocks.broadcast.mockRejectedValue(new Error("already known"));
  mocks.pending.mockResolvedValue({ hash: session.journal.send!.hash });
  mocks.wait.mockResolvedValue({ status: "success" });
  await run();
  expect(mocks.wait).toHaveBeenCalledTimes(1);
  expect(session.journal.send!.confirmed).toBe(true);
});
