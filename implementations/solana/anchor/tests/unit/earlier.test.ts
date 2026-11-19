import { expect, it, vi } from "vitest";
import { landedEarlier } from "../../src/chain/payments";
import {
  ResultPending,
  RevertedTransaction,
} from "../../src/chain/transactions";

const reverted = new RevertedTransaction(42n);
const entry = (exists: boolean) =>
  vi
    .fn<(slot: bigint) => Promise<{ exists: boolean }>>()
    .mockResolvedValue({ exists });

it("reports an earlier success when state at the failure's slot shows the effect", async () => {
  const read = entry(true);
  await expect(
    landedEarlier(reverted, read, (state) => state.exists),
  ).resolves.toBe(true);
  expect(read).toHaveBeenCalledWith(42n);
});

it("keeps the failure when the effect is absent", async () => {
  const read = entry(false);
  await expect(
    landedEarlier(reverted, read, (state) => state.exists),
  ).resolves.toBe(false);
});

it("ignores other errors without reading state", async () => {
  const read = vi.fn();
  await expect(
    landedEarlier(new Error("RPC down"), read, () => true),
  ).resolves.toBe(false);
  await expect(
    landedEarlier(new RevertedTransaction(), read, () => true),
  ).resolves.toBe(false);
  expect(read).not.toHaveBeenCalled();
});

it("leaves the result pending when the node cannot serve that slot", async () => {
  const read = vi.fn().mockRejectedValue(new Error("Minimum context slot"));
  await expect(
    landedEarlier(reverted, read, () => true),
  ).rejects.toBeInstanceOf(ResultPending);
});
