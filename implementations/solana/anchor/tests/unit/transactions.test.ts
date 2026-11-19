import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { newSession, type Session } from "../../src/chain/session";
import { parseDeployment } from "../../src/chain/config";
import {
  ExpiredTransaction,
  RevertedTransaction,
  transact,
  UnknownOutcome,
  BroadcastUnavailable,
} from "../../src/chain/transactions";

const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  height: vi.fn(),
  slot: vi.fn(),
  broadcast: vi.fn(),
}));
vi.mock("../../src/chain/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/chain/config")>()),
  rpc: () => ({
    getSignatureStatuses: (...args: unknown[]) => ({
      send: () => mocks.status(...args),
    }),
    getBlockHeight: (...args: unknown[]) => ({
      send: () => mocks.height(...args),
    }),
    getSlot: (...args: unknown[]) => ({
      send: () => mocks.slot(...args),
    }),
    sendTransaction: (...args: unknown[]) => ({
      send: () => mocks.broadcast(...args),
    }),
  }),
}));
const config = parseDeployment({
  network: "localnet",
  rpcUrl: "http://127.0.0.1:8899",
  program: "C1Xhdt88ESirspBUY9jWGoDH8auRo3URJqjt4dqtZZcG",
  genesisHash: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
  faucetUrl: "https://faucet.solana.com",
});
let session: Session;
afterEach(() => {
  vi.useRealTimers();
});
beforeEach(async () => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  mocks.slot.mockResolvedValue(150n);
  session = {
    ...(await newSession(config)),
    journal: {
      send: {
        raw: "saved-wire-bytes",
        hash: "1".repeat(64),
        confirmed: false,
        lastValidBlockHeight: "100",
      },
    },
  };
});
/** Run the confirmation loop to completion on fake timers. */
async function finish<T>(promise: Promise<T>) {
  promise.catch(() => {});
  await vi.runAllTimersAsync();
  return promise;
}
const run = (persist = () => {}, c = config) =>
  finish(
    transact(
      c,
      session,
      persist,
      () => {},
      "send",
      async () => {
        throw new Error("Must not reconstruct a saved transaction");
      },
    ),
  );
const confirmed = { confirmationStatus: "confirmed", err: null, slot: 7n };
it("reconciles a confirmed payment without rebroadcast or a second signature", async () => {
  mocks.status.mockResolvedValue({
    value: [{ confirmationStatus: "confirmed", err: null, slot: 7n }],
  });
  await run();
  expect(session.journal.send!.confirmed).toBe(true);
  expect(mocks.broadcast).not.toHaveBeenCalled();
});
it("accepts confirmation found by the final expiry lookup", async () => {
  mocks.status
    .mockResolvedValueOnce({ context: { slot: 200n }, value: [null] })
    .mockResolvedValueOnce({
      value: [{ confirmationStatus: "confirmed", err: null, slot: 7n }],
    });
  mocks.height.mockResolvedValue(101n);
  await run();
  expect(session.journal.send!.confirmed).toBe(true);
  expect(mocks.height).toHaveBeenCalledWith({ commitment: "finalized" });
  expect(mocks.status).toHaveBeenCalledWith(["1".repeat(64)], {
    searchTransactionHistory: true,
  });
  expect(mocks.broadcast).not.toHaveBeenCalled();
});
it("retains evidence if the final expiry lookup fails", async () => {
  mocks.status
    .mockResolvedValueOnce({ context: { slot: 200n }, value: [null] })
    .mockRejectedValueOnce(new Error("RPC unavailable"));
  mocks.height.mockResolvedValue(101n);
  await expect(run()).rejects.toBeInstanceOf(UnknownOutcome);
  expect(session.journal.send).toBeDefined();
  expect(mocks.broadcast).not.toHaveBeenCalled();
});
it("persists before rebroadcasting the exact saved bytes at the expiry boundary", async () => {
  const persist = vi.fn();
  mocks.status
    .mockResolvedValueOnce({ context: { slot: 200n }, value: [null] })
    .mockResolvedValueOnce({
      value: [{ confirmationStatus: "confirmed", err: null, slot: 7n }],
    });
  mocks.height.mockResolvedValue(100n);
  mocks.broadcast.mockImplementation(async (raw) => {
    expect(persist).toHaveBeenCalled();
    expect(raw).toBe("saved-wire-bytes");
  });
  await run(persist);
  expect(mocks.broadcast).toHaveBeenCalledTimes(1);
});
it("keeps saved evidence after an RPC failure", async () => {
  mocks.status.mockRejectedValue(new Error("RPC unavailable"));
  mocks.height.mockRejectedValue(new Error("RPC unavailable"));
  await expect(run()).rejects.toBeInstanceOf(UnknownOutcome);
  expect(session.journal.send).toBeDefined();
  expect(mocks.broadcast).not.toHaveBeenCalled();
});
it("requires finalized expiry and a second history lookup before explicit retry", async () => {
  mocks.status.mockResolvedValue({ context: { slot: 200n }, value: [null] });
  mocks.height.mockResolvedValue(101n);
  await expect(run()).rejects.toBeInstanceOf(ExpiredTransaction);
  expect(mocks.status).toHaveBeenCalledTimes(2);
  expect(session.journal.send).toBeUndefined();
  expect(mocks.broadcast).not.toHaveBeenCalled();
});
it("never proves expiry from a node behind the finalized slot", async () => {
  // The node answers "not found" from slot 120, but slot 150 is finalized.
  mocks.status.mockResolvedValue({ context: { slot: 120n }, value: [null] });
  mocks.height.mockResolvedValue(101n);
  await expect(run()).rejects.toBeInstanceOf(UnknownOutcome);
  expect(session.journal.send).toBeDefined();
});
it("never discards a previously confirmed transaction when history is unavailable", async () => {
  session.journal.send!.confirmed = true;
  mocks.status
    .mockResolvedValueOnce({ context: { slot: 200n }, value: [null] })
    .mockResolvedValueOnce({ context: { slot: 200n }, value: [null] })
    .mockRejectedValueOnce(new Error("RPC unavailable"));
  mocks.height.mockResolvedValue(101n);
  await expect(run()).rejects.toBeInstanceOf(UnknownOutcome);
  expect(session.journal.send).toBeDefined();
});
it("a confirmed on-chain error permits explicit retry", async () => {
  mocks.status.mockResolvedValue({
    value: [
      {
        confirmationStatus: "confirmed",
        err: { InstructionError: [0, "InsufficientFunds"] },
      },
    ],
  });
  await expect(run()).rejects.toBeInstanceOf(RevertedTransaction);
  expect(session.journal.send).toBeUndefined();
});
it("a stale transaction lands as a failure, clears the journal, and allows a rebuild", async () => {
  mocks.status
    .mockResolvedValueOnce({ context: { slot: 200n }, value: [null] })
    .mockResolvedValueOnce({
      value: [
        {
          confirmationStatus: "confirmed",
          err: { InstructionError: [0, { Custom: 6000 }] },
        },
      ],
    });
  mocks.height.mockResolvedValue(100n);
  mocks.broadcast.mockResolvedValue("1".repeat(64));
  await expect(run()).rejects.toBeInstanceOf(RevertedTransaction);
  expect(mocks.broadcast).toHaveBeenCalledWith(
    "saved-wire-bytes",
    expect.objectContaining({ skipPreflight: true }),
  );
  expect(session.journal.send).toBeUndefined();

  const rebuild = vi.fn(async () => {
    throw new Error("rebuilt");
  });
  await expect(
    finish(
      transact(
        config,
        session,
        () => {},
        () => {},
        "send",
        rebuild,
      ),
    ),
  ).rejects.toThrow("rebuilt");
  expect(rebuild).toHaveBeenCalledTimes(1);
});
it("storage failure stops all network work", async () => {
  await expect(
    run(() => {
      throw new Error("Storage unavailable");
    }),
  ).rejects.toThrow("Storage unavailable");
  expect(mocks.status).not.toHaveBeenCalled();
  expect(mocks.broadcast).not.toHaveBeenCalled();
});

it("reports rejected submission and recovers with the exact saved bytes", async () => {
  mocks.status.mockResolvedValue({ context: { slot: 200n }, value: [null] });
  mocks.height.mockResolvedValue(100n);
  mocks.broadcast.mockRejectedValueOnce(new Error("RPC unavailable"));
  await expect(run()).rejects.toBeInstanceOf(BroadcastUnavailable);
  expect(session.journal.send!.raw).toBe("saved-wire-bytes");
  mocks.status
    .mockResolvedValueOnce({ context: { slot: 200n }, value: [null] })
    .mockResolvedValueOnce({
      value: [{ confirmationStatus: "confirmed", err: null, slot: 7n }],
    });
  await run();
  expect(mocks.broadcast.mock.calls.map(([raw]) => raw)).toEqual([
    "saved-wire-bytes",
    "saved-wire-bytes",
  ]);
  expect(session.journal.send!.confirmed).toBe(true);
});

it("accepts confirmation after a failed submission response", async () => {
  mocks.status
    .mockResolvedValueOnce({ context: { slot: 200n }, value: [null] })
    .mockResolvedValueOnce({
      value: [{ confirmationStatus: "confirmed", err: null, slot: 7n }],
    });
  mocks.height.mockResolvedValue(100n);
  mocks.broadcast.mockRejectedValue(new Error("Already processed"));
  await run();
  expect(session.journal.send!.confirmed).toBe(true);
});

it("keeps waiting through a failed read and still confirms", async () => {
  mocks.status
    .mockRejectedValueOnce(new Error("HTTP error (429)"))
    .mockResolvedValueOnce({ context: { slot: 200n }, value: [null] })
    .mockResolvedValue({ context: { slot: 200n }, value: [confirmed] });
  mocks.height.mockResolvedValue(100n);
  await run();
  expect(session.journal.send!.confirmed).toBe(true);
});
it("never treats a failed read as proof of expiry", async () => {
  mocks.status
    .mockResolvedValueOnce({ context: { slot: 200n }, value: [null] })
    .mockRejectedValueOnce(new Error("HTTP error (429)"))
    .mockResolvedValue({ context: { slot: 200n }, value: [confirmed] });
  mocks.height.mockResolvedValue(101n);
  await run();
  expect(session.journal.send!.confirmed).toBe(true);
});
it("polls every 2 s and resends the saved bytes at most every 5 s", async () => {
  const devnet = { ...config, network: "devnet" as const };
  const started = Date.now();
  mocks.status.mockImplementation(async () => ({
    value: [Date.now() - started >= 11_000 ? confirmed : null],
  }));
  mocks.height.mockResolvedValue(100n);
  await run(() => {}, devnet);
  // Polls at 0, 2, 4, 6, 8, 10, and 12 s. Resends at 0 and 6 s.
  expect(mocks.status).toHaveBeenCalledTimes(7);
  expect(mocks.broadcast).toHaveBeenCalledTimes(2);
  expect(session.journal.send!.confirmed).toBe(true);
});
