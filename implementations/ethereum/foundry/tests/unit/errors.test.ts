import { expect, it } from "vitest";
import {
  BaseError,
  EstimateGasExecutionError,
  InsufficientFundsError,
  RpcRequestError,
  encodeErrorResult,
} from "viem";
import { readableError } from "../../src/chain/errors";
import { paymvcAbi } from "../../src/chain/generated/paymvcAbi";
import { BroadcastUnavailable } from "../../src/chain/transactions";

/** A gas estimate that reverted: viem keeps the raw revert data on the RPC error. */
function reverted(data: `0x${string}`) {
  const rpc = new RpcRequestError({
    body: {},
    url: "https://rpc.example",
    error: { code: 3, message: "execution reverted", data },
  });
  return new EstimateGasExecutionError(rpc, {});
}

it("names a contract error found while estimating gas", () => {
  const data = encodeErrorResult({
    abi: paymvcAbi,
    errorName: "NotRegistered",
  });
  expect(readableError(reverted(data))).toBe(
    "Choose a different, registered PayMVC account.",
  );
});

it("falls back to a general message for unknown revert data", () => {
  expect(readableError(reverted("0xdeadbeef"))).toMatch(/^The RPC could not/);
});

it("asks for native tokens when the wallet cannot pay fees", () => {
  const error = new BaseError("send failed", {
    cause: new InsufficientFundsError(),
  });
  expect(readableError(error)).toMatch(/needs more native tokens/);
  expect(new BroadcastUnavailable(error).message).toMatch(
    /needs more native tokens.*saved/,
  );
});
