import { afterEach, expect, it, vi } from "vitest";
import { JsonRpcError, NativeRpcErrorCode } from "@thruputchain/client";
import { waitForHeight } from "../../src/chain/config";

afterEach(() => vi.useRealTimers());

const unavailable = () =>
  new JsonRpcError(
    NativeRpcErrorCode.StateHeightUnavailable,
    "view height unavailable: requested 138, observed 137",
  );

it("waits until the node serves the requested height", async () => {
  vi.useFakeTimers();
  const read = vi
    .fn()
    .mockRejectedValueOnce(unavailable())
    .mockRejectedValueOnce(new Error("wrapped", { cause: unavailable() }))
    .mockResolvedValue("ok");
  const result = waitForHeight(read);
  await vi.advanceTimersByTimeAsync(500);
  await expect(result).resolves.toBe("ok");
  expect(read).toHaveBeenCalledTimes(3);
});

it("throws any other error at once", async () => {
  const error = new JsonRpcError(-32000, "server error");
  const read = vi.fn().mockRejectedValue(error);
  await expect(waitForHeight(read)).rejects.toBe(error);
  expect(read).toHaveBeenCalledTimes(1);
});

it("gives up after about five seconds", async () => {
  vi.useFakeTimers();
  const read = vi.fn().mockRejectedValue(unavailable());
  const result = waitForHeight(read);
  result.catch(() => {});
  await vi.runAllTimersAsync();
  await expect(result).rejects.toBeInstanceOf(JsonRpcError);
  expect(read).toHaveBeenCalledTimes(21);
});
