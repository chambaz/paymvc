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

it("keeps the chain module's own messages", () => {
  expect(readableError(new Error("Not enough demo credits."))).toBe(
    "Not enough demo credits.",
  );
});
