import { beforeEach, expect, it, vi } from "vitest";
import {
  Account,
  Networks,
  Operation,
  StrKey,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { Buffer } from "buffer";
import { newSession, signerFor, type Session } from "../../src/chain/session";
import {
  BroadcastUnavailable,
  ExpiredTransaction,
  RejectedTransaction,
  transact,
  UnknownOutcome,
} from "../../src/chain/transactions";
import type { Deployment } from "../../src/chain/config";

const mocks = vi.hoisted(() => ({ get: vi.fn(), send: vi.fn() }));
vi.mock("../../src/chain/config", async (original) => ({
  ...(await original<typeof import("../../src/chain/config")>()),
  server: () => ({ getTransaction: mocks.get, sendTransaction: mocks.send }),
}));
const c: Deployment = {
  network: "localnet",
  passphrase: Networks.STANDALONE,
  rpcUrl: "http://127.0.0.1:8000/rpc",
  horizonUrl: "http://127.0.0.1:8000",
  faucetUrl: "http://127.0.0.1:8000/friendbot",
  contract: StrKey.encodeContract(Buffer.alloc(32, 1)),
  token: StrKey.encodeContract(Buffer.alloc(32, 2)),
  codeHash: "1".repeat(64),
  tokenHash: "2".repeat(64),
};
let s: Session;
const missing = {
  status: "NOT_FOUND",
  latestLedgerCloseTime: 100,
  oldestLedger: 1,
};
beforeEach(() => {
  vi.resetAllMocks();
  s = newSession(c);
  const signer = signerFor(s);
  const tx = new TransactionBuilder(new Account(signer.publicKey(), "1"), {
    fee: "100",
    networkPassphrase: c.passphrase,
  })
    .addOperation(Operation.manageData({ name: "test", value: "x" }))
    .setTimebounds(0, 200)
    .build();
  tx.sign(signer);
  s.journal.test = {
    raw: tx.toXDR(),
    hash: Buffer.from(tx.hash()).toString("hex"),
    confirmed: false,
    preparedLedger: 10,
  };
});
const run = () =>
  transact(
    c,
    s,
    () => {},
    () => {},
    "test",
    async () => {
      throw new Error("Must reuse saved bytes");
    },
  );
it("preserves bytes after a failed submission and reconciles later success", async () => {
  mocks.get.mockResolvedValue(missing);
  mocks.send.mockRejectedValue(new Error("busy"));
  const raw = s.journal.test!.raw;
  await expect(run()).rejects.toBeInstanceOf(BroadcastUnavailable);
  expect(s.journal.test!.raw).toBe(raw);
  mocks.get.mockResolvedValue({ status: "SUCCESS" });
  await run();
  expect(s.journal.test!.confirmed).toBe(true);
  expect(mocks.send).toHaveBeenCalledTimes(1);
});
it("requires closed-ledger expiry and full RPC history before replacing evidence", async () => {
  mocks.get.mockResolvedValue({ ...missing, latestLedgerCloseTime: 201 });
  await expect(run()).rejects.toBeInstanceOf(ExpiredTransaction);
  expect(s.journal.test).toBeUndefined();
  expect(mocks.send).not.toHaveBeenCalled();
});
it("retains evidence when history no longer covers its submission", async () => {
  mocks.get.mockResolvedValue({
    ...missing,
    latestLedgerCloseTime: 201,
    oldestLedger: 11,
  });
  mocks.send.mockRejectedValue(new Error("expired"));
  await expect(run()).rejects.toBeInstanceOf(BroadcastUnavailable);
  expect(s.journal.test).toBeDefined();
});
it("stops before broadcast when signed evidence cannot be saved", async () => {
  await expect(
    transact(
      c,
      s,
      () => {
        throw new Error("storage unavailable");
      },
      () => {},
      "test",
      async () => [],
    ),
  ).rejects.toThrow("storage unavailable");
  expect(mocks.get).not.toHaveBeenCalled();
  expect(mocks.send).not.toHaveBeenCalled();
});
it("retains evidence when reconciliation is unavailable", async () => {
  mocks.get.mockRejectedValue(new Error("offline"));
  await expect(run()).rejects.toBeInstanceOf(UnknownOutcome);
  expect(s.journal.test).toBeDefined();
  expect(mocks.send).not.toHaveBeenCalled();
});
it("reports a network rejection without discarding evidence", async () => {
  mocks.get.mockResolvedValue(missing);
  mocks.send.mockResolvedValue({ status: "ERROR" });
  const error = await run().catch((error: unknown) => error);
  expect(error).toBeInstanceOf(RejectedTransaction);
  expect((error as Error).message).toContain(
    "The network rejected this transaction",
  );
  expect(s.journal.test).toBeDefined();
});
it("reports a busy RPC for TRY_AGAIN_LATER", async () => {
  mocks.get.mockResolvedValue(missing);
  mocks.send.mockResolvedValue({ status: "TRY_AGAIN_LATER" });
  const error = await run().catch((error: unknown) => error);
  expect(error).toBeInstanceOf(BroadcastUnavailable);
  expect(error).not.toBeInstanceOf(RejectedTransaction);
  expect(s.journal.test).toBeDefined();
});
