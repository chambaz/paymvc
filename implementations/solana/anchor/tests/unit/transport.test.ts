import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR,
  SolanaError,
  type RpcTransport,
} from "@solana/kit";
import { withRetry } from "../../src/chain/config";

const httpError = (statusCode: number, headers: Record<string, string> = {}) =>
  new SolanaError(SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, {
    headers: new Headers(headers),
    message: "",
    statusCode,
  });
const request = { payload: { method: "getHealth" } };
let inner: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.useFakeTimers();
  inner = vi.fn();
});
afterEach(() => {
  vi.useRealTimers();
});
const send = () => withRetry(inner as unknown as RpcTransport)(request);

it("retries a rate-limited request with backoff and returns the response", async () => {
  inner
    .mockRejectedValueOnce(httpError(429))
    .mockRejectedValueOnce(httpError(503))
    .mockResolvedValue("ok");
  const result = send();
  await vi.advanceTimersByTimeAsync(999);
  expect(inner).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(inner).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(2_000);
  await expect(result).resolves.toBe("ok");
  expect(inner).toHaveBeenCalledTimes(3);
});
it("waits for Retry-After when the RPC sends it", async () => {
  inner
    .mockRejectedValueOnce(httpError(429, { "Retry-After": "3" }))
    .mockResolvedValue("ok");
  const result = send();
  await vi.advanceTimersByTimeAsync(2_999);
  expect(inner).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  await expect(result).resolves.toBe("ok");
});
it("throws the original error after four retries", async () => {
  const error = httpError(429);
  inner.mockRejectedValue(error);
  const result = send();
  result.catch(() => {});
  await vi.runAllTimersAsync();
  await expect(result).rejects.toBe(error);
  expect(inner).toHaveBeenCalledTimes(5);
});
it("does not retry other errors", async () => {
  for (const error of [httpError(500), new Error("offline")]) {
    inner.mockReset().mockRejectedValue(error);
    await expect(send()).rejects.toBe(error);
    expect(inner).toHaveBeenCalledTimes(1);
  }
});
