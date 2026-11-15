import { expect, it } from "vitest";
import {
  parseAmount,
  validateOperation,
  operationId,
  entryId,
  parseEntryId,
} from "../../src/chain/session";
it.each(["0", "-1", "1.5", "1e3", "01", "1000001", " 2", "NaN"])(
  "rejects malformed amount %s",
  (amount) => {
    expect(() => parseAmount(amount)).toThrow();
  },
);
it("preserves exact whole credit amounts", () => {
  expect(parseAmount("1000000")).toBe(1000000n);
});
it("requires nonzero 32-byte operation IDs", () => {
  expect(() => validateOperation(operationId())).not.toThrow();
  expect(() => validateOperation("0".repeat(64))).toThrow();
  expect(() => validateOperation("f".repeat(32))).toThrow();
  expect(() => validateOperation("f".repeat(66))).toThrow();
});
it("round-trips an entry ID from its key", () => {
  const from = `0x${"a".repeat(64)}`;
  const operation = operationId();
  expect(parseEntryId(entryId(from, operation))).toEqual({ from, operation });
});
