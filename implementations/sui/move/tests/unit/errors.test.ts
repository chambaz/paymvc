import { expect, it } from "vitest";
import { readableError } from "../../src/chain/errors";

it("names a PayMVC abort from a failed dry run", () => {
  const error = new Error(
    `MoveAbort in 1st command, abort code: 2, in '0x${"a".repeat(64)}::paymvc::send' (instruction 12)`,
  );
  expect(readableError(error)).toBe(
    "Choose a different, registered PayMVC account.",
  );
});

it("explains an abort in another module without raw codes", () => {
  const error = new Error(
    `MoveAbort in 2nd command, abort code: 2, in '0x2::balance::split' (instruction 7)`,
  );
  expect(readableError(error)).toMatch(/would fail on-chain/);
});

it("explains an unmapped PayMVC abort without raw codes", () => {
  const error = new Error(
    `MoveAbort in 1st command, abort code: 10, in '0x${"a".repeat(64)}::paymvc::profiles' (instruction 3)`,
  );
  expect(readableError(error)).toMatch(/would fail on-chain/);
});

it("keeps the chain module's own messages", () => {
  expect(readableError(new Error("Not enough demo credits."))).toBe(
    "Not enough demo credits.",
  );
});

/** A failed gRPC call, as the transport reports it. */
const rpcError = (code: string) =>
  Object.assign(new Error("call failed"), { name: "RpcError", code });

it("names rate limits, outages, and timeouts", () => {
  expect(readableError(rpcError("RESOURCE_EXHAUSTED"))).toMatch(
    /rate-limiting/,
  );
  expect(readableError(rpcError("UNAVAILABLE"))).toMatch(
    /temporarily unavailable/,
  );
  expect(readableError(rpcError("DEADLINE_EXCEEDED"))).toMatch(
    /did not respond in time/,
  );
  expect(readableError(rpcError("INTERNAL"))).toMatch(/could not complete/);
});

it("explains a failed fetch and hides any message with a URL", () => {
  expect(readableError(new TypeError("Failed to fetch"))).toMatch(
    /could not complete/,
  );
  expect(
    readableError(new Error("POST https://rpc.example/secret-key failed")),
  ).not.toContain("secret-key");
});
