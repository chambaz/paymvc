import { beforeEach, expect, it, vi } from "vitest";
import {
  AccountAddress,
  AptosApiError,
  AptosApiType,
  ChainId,
  EntryFunction,
  RawTransaction,
  SimpleTransaction,
  TransactionPayloadEntryFunction,
  generateSignedTransaction,
  generateUserTransactionHash,
  Hex,
} from "@aptos-labs/ts-sdk";
import {
  newSession,
  signerFor,
  accountFor,
  loadSession,
  saveSession,
} from "../../src/chain/session";
import type { Deployment } from "../../src/chain/config";
import {
  transact,
  UnknownOutcome,
  ExpiredTransaction,
  RevertedTransaction,
  ReplacedTransaction,
  GasFundsRequired,
} from "../../src/chain/transactions";

const client = vi.hoisted(() => ({
  getLedgerInfo: vi.fn(),
  getTransactionByHash: vi.fn(),
  getAccountTransactions: vi.fn(),
  waitForTransaction: vi.fn(),
  transaction: { submit: { simple: vi.fn() } },
}));
vi.mock("../../src/chain/config", async (original) => ({
  ...(await original<typeof import("../../src/chain/config")>()),
  server: () => client,
}));
const c: Deployment = {
  network: "testnet",
  rpcUrl: "https://api.testnet.aptoslabs.com/v1",
  chainId: 2,
  package: AccountAddress.fromString("0xa").toStringLong(),
  metadata: AccountAddress.fromString("0xb").toStringLong(),
  publishHash: `0x${"1".repeat(64)}`,
  modules: { credits: "2".repeat(64), paymvc: "3".repeat(64) },
  faucetUrl: "https://aptos.dev/network/faucet",
};
function missing() {
  return new AptosApiError({
    apiType: AptosApiType.FULLNODE,
    aptosRequest: { url: c.rpcUrl, method: "GET" },
    aptosResponse: {
      status: 404,
      statusText: "Not Found",
      data: {
        message: "Transaction not found",
        error_code: "transaction_not_found",
      },
      url: c.rpcUrl,
      headers: {},
    },
  });
}
function saved() {
  const s = newSession(c);
  const transaction = new SimpleTransaction(
    new RawTransaction(
      AccountAddress.fromString(accountFor(s).address),
      0n,
      new TransactionPayloadEntryFunction(
        EntryFunction.build(`${c.package}::paymvc`, "register", [], []),
      ),
      20000n,
      100n,
      1000n,
      new ChainId(2),
    ),
  );
  const senderAuthenticator =
    signerFor(s).signTransactionWithAuthenticator(transaction);
  const signed = { transaction, senderAuthenticator };
  s.journal.payment = {
    raw: Hex.fromHexInput(generateSignedTransaction(signed)).toString(),
    hash: generateUserTransactionHash(signed),
    preparedVersion: "10",
    confirmed: false,
  };
  return s;
}
beforeEach(() => {
  vi.resetAllMocks();
  client.getLedgerInfo.mockResolvedValue({
    chain_id: 2,
    ledger_timestamp: "900000000",
    oldest_ledger_version: "0",
  });
  client.getTransactionByHash.mockRejectedValue(missing());
  // The saved sequence number is unused until a test says otherwise.
  client.getAccountTransactions.mockResolvedValue([]);
  client.transaction.submit.simple.mockResolvedValue({});
  client.waitForTransaction.mockResolvedValue({
    type: "user_transaction",
    success: true,
    version: "50",
  });
});
it("round-trips a signed session and rejects substituted transaction hashes", () => {
  const s = saved();
  let raw = "";
  const storage = {
    setItem: (_: string, value: string) => {
      raw = value;
    },
    getItem: () => raw,
  } as unknown as Storage;
  saveSession(s, storage);
  expect(loadSession(c, storage)).toEqual(s);
  s.journal.payment!.hash = `0x${"3".repeat(64)}`;
  saveSession(s, storage);
  expect(() => loadSession(c, storage)).toThrow("incompatible");
});
it("rebroadcasts saved bytes only after persistence", async () => {
  const s = saved(),
    build = vi.fn(),
    persist = vi.fn();
  await transact(c, s, persist, () => {}, "payment", build);
  expect(build).not.toHaveBeenCalled();
  expect(client.transaction.submit.simple).toHaveBeenCalledOnce();
  expect(persist.mock.invocationCallOrder[0]).toBeLessThan(
    client.transaction.submit.simple.mock.invocationCallOrder[0]!,
  );
  expect(s.journal.payment?.confirmed).toBe(true);
});
it("stops before submission when storage fails", async () => {
  const s = saved();
  await expect(
    transact(
      c,
      s,
      () => {
        throw new Error("quota");
      },
      () => {},
      "payment",
      vi.fn(),
    ),
  ).rejects.toThrow("quota");
  expect(client.transaction.submit.simple).not.toHaveBeenCalled();
});
it("retains uncertain submission evidence", async () => {
  const s = saved(),
    original = { ...s.journal.payment };
  client.transaction.submit.simple.mockRejectedValue(new Error("offline"));
  await expect(
    transact(c, s, vi.fn(), () => {}, "payment", vi.fn()),
  ).rejects.toBeInstanceOf(UnknownOutcome);
  expect(s.journal.payment).toEqual(original);
});
it("does not submit after an unavailable lookup", async () => {
  const s = saved();
  client.getTransactionByHash.mockRejectedValue(new Error("offline"));
  await expect(
    transact(c, s, vi.fn(), () => {}, "payment", vi.fn()),
  ).rejects.toBeInstanceOf(UnknownOutcome);
  expect(client.transaction.submit.simple).not.toHaveBeenCalled();
});

it("keeps the outcome unknown when the ledger lookup fails", async () => {
  const s = saved();
  client.getLedgerInfo.mockRejectedValue(new Error("offline"));
  await expect(
    transact(c, s, vi.fn(), () => {}, "payment", vi.fn()),
  ).rejects.toBeInstanceOf(UnknownOutcome);
  expect(s.journal.payment?.confirmed).toBe(false);
  expect(client.transaction.submit.simple).not.toHaveBeenCalled();
});
it("requires retained history to prove expiry", async () => {
  const s = saved();
  client.getLedgerInfo.mockResolvedValue({
    chain_id: 2,
    ledger_timestamp: "1001000000",
    oldest_ledger_version: "11",
  });
  await expect(
    transact(c, s, vi.fn(), () => {}, "payment", vi.fn()),
  ).rejects.toBeInstanceOf(UnknownOutcome);
  expect(s.journal.payment).toBeDefined();
});
it("checks absence again after observed ledger expiry", async () => {
  const s = saved();
  client.getLedgerInfo.mockResolvedValue({
    chain_id: 2,
    ledger_timestamp: "1001000000",
    oldest_ledger_version: "0",
  });
  await expect(
    transact(c, s, vi.fn(), () => {}, "payment", vi.fn()),
  ).rejects.toBeInstanceOf(ExpiredTransaction);
  expect(client.getTransactionByHash).toHaveBeenCalledTimes(2);
  expect(s.journal.payment).toBeUndefined();
});
it("reconciles a committed failure without rebroadcast", async () => {
  const s = saved();
  client.getTransactionByHash.mockResolvedValue({
    type: "user_transaction",
    success: false,
  });
  await expect(
    transact(c, s, vi.fn(), () => {}, "payment", vi.fn()),
  ).rejects.toBeInstanceOf(RevertedTransaction);
  expect(s.journal.payment).toBeUndefined();
  expect(client.transaction.submit.simple).not.toHaveBeenCalled();
});

it("accepts a transaction found at the expiry boundary", async () => {
  const s = saved();
  client.getLedgerInfo.mockResolvedValue({
    chain_id: 2,
    ledger_timestamp: "1001000000",
    oldest_ledger_version: "0",
  });
  client.getTransactionByHash
    .mockRejectedValueOnce(missing())
    .mockResolvedValueOnce({ type: "user_transaction", success: true });
  await transact(c, s, vi.fn(), () => {}, "payment", vi.fn());
  expect(s.journal.payment?.confirmed).toBe(true);
  expect(client.transaction.submit.simple).not.toHaveBeenCalled();
});

it("retains evidence when the final expiry lookup is unavailable", async () => {
  const s = saved();
  client.getLedgerInfo.mockResolvedValue({
    chain_id: 2,
    ledger_timestamp: "1001000000",
    oldest_ledger_version: "0",
  });
  client.getTransactionByHash
    .mockRejectedValueOnce(missing())
    .mockRejectedValueOnce(new Error("offline"));
  await expect(
    transact(c, s, vi.fn(), () => {}, "payment", vi.fn()),
  ).rejects.toBeInstanceOf(UnknownOutcome);
  expect(s.journal.payment?.confirmed).toBe(false);
  expect(client.transaction.submit.simple).not.toHaveBeenCalled();
});

it("waits for an already pending transaction without another submission", async () => {
  const s = saved();
  client.getTransactionByHash.mockResolvedValue({
    type: "pending_transaction",
  });
  client.waitForTransaction.mockRejectedValue(new Error("timeout"));
  await expect(
    transact(c, s, vi.fn(), () => {}, "payment", vi.fn()),
  ).rejects.toBeInstanceOf(UnknownOutcome);
  expect(s.journal.payment?.confirmed).toBe(false);
  expect(client.transaction.submit.simple).not.toHaveBeenCalled();
});

it("builds new transactions from the same ledger read that records preparation", async () => {
  const s = newSession(c),
    build = vi.fn().mockRejectedValue(new Error("stop"));
  client.getLedgerInfo.mockResolvedValue({
    chain_id: 2,
    ledger_version: "12",
    ledger_timestamp: "900000000",
  });
  await expect(
    transact(c, s, vi.fn(), () => {}, "payment", build),
  ).rejects.toThrow("stop");
  expect(build).toHaveBeenCalledWith(
    expect.objectContaining({ ledger_version: "12" }),
  );
});
it("separates blocked storage from an unreadable session", () => {
  const blocked = {
    getItem: () => {
      throw new Error("SecurityError");
    },
    setItem: () => {
      throw new Error("SecurityError");
    },
  } as unknown as Storage;
  expect(() => loadSession(c, blocked)).toThrow(
    "Browser storage is unavailable. Enable storage for this site, then reload. No wallet was created.",
  );
  expect(() => saveSession(newSession(c), blocked)).toThrow(
    "Browser storage is unavailable",
  );
  const corrupt = { getItem: () => "{" } as unknown as Storage;
  expect(() => loadSession(c, corrupt)).toThrow("incompatible");
});
it.each([
  { amount: "1000001", operation: "1".repeat(32) },
  { amount: "5", operation: "0".repeat(32) },
])("rejects a saved intent outside the amount and operation rules", (rule) => {
  const s = {
    ...newSession(c),
    intent: {
      action: "send" as const,
      recipient: `0x${"2".repeat(64)}`,
      id: "0",
      ...rule,
    },
  };
  const storage = { getItem: () => JSON.stringify(s) } as unknown as Storage;
  expect(() => loadSession(c, storage)).toThrow("incompatible");
});

it("fails early when another transaction used the saved sequence number", async () => {
  const s = saved();
  client.getAccountTransactions.mockResolvedValue([
    { type: "user_transaction", hash: `0x${"9".repeat(64)}`, version: "12" },
  ]);
  await expect(
    transact(
      c,
      s,
      vi.fn(),
      () => {},
      "payment",
      vi.fn(),
      async () => true,
    ),
  ).rejects.toBeInstanceOf(ReplacedTransaction);
  expect(s.journal.payment).toBeUndefined();
  expect(client.transaction.submit.simple).not.toHaveBeenCalled();
});

it("confirms the saved transaction found at its sequence number", async () => {
  const s = saved();
  client.getAccountTransactions.mockResolvedValue([
    {
      type: "user_transaction",
      hash: s.journal.payment!.hash,
      version: "12",
      success: true,
    },
  ]);
  await transact(c, s, vi.fn(), () => {}, "payment", vi.fn());
  expect(s.journal.payment!.confirmed).toBe(true);
  expect(s.journal.payment!.committedVersion).toBe("12");
  expect(client.transaction.submit.simple).not.toHaveBeenCalled();
});

it("keeps the saved bytes and asks for APT when gas cannot be paid", async () => {
  const s = saved();
  client.transaction.submit.simple.mockRejectedValue(
    new AptosApiError({
      apiType: AptosApiType.FULLNODE,
      aptosRequest: { url: c.rpcUrl, method: "POST" },
      aptosResponse: {
        status: 400,
        statusText: "Bad Request",
        data: {
          message: "Invalid transaction",
          error_code: "vm_error",
          vm_error_code: 5,
          vm_status: "INSUFFICIENT_BALANCE_FOR_TRANSACTION_FEE",
        },
        url: c.rpcUrl,
        headers: {},
      },
    }),
  );
  await expect(
    transact(c, s, vi.fn(), () => {}, "payment", vi.fn()),
  ).rejects.toBeInstanceOf(GasFundsRequired);
  expect(s.journal.payment).toBeDefined();
});

it("keeps an expired transaction whose effect is on chain", async () => {
  const s = saved();
  client.getLedgerInfo.mockResolvedValue({
    chain_id: 2,
    ledger_version: "77",
    ledger_timestamp: "2000000000",
    oldest_ledger_version: "0",
  });
  await transact(
    c,
    s,
    vi.fn(),
    () => {},
    "payment",
    vi.fn(),
    async () => false,
  );
  expect(s.journal.payment!.confirmed).toBe(true);
});
