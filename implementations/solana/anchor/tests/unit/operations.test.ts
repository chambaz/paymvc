import { expect, it } from "vitest";
import { address } from "@solana/kit";
import { operationId, parseIntent } from "../../src/chain/session";

const intent = (operation: string) => ({
  action: "send" as const,
  recipient: address("C1Xhdt88ESirspBUY9jWGoDH8auRo3URJqjt4dqtZZcG"),
  amount: "5",
  id: "0",
  operation,
});

it("rejects a zero operation ID and accepts new ones", () => {
  expect(() => parseIntent(intent("0".repeat(64)))).toThrow("invalid");
  expect(parseIntent(intent(operationId())).amount).toBe(5n);
  expect(() => parseIntent(intent(operationId()))).not.toThrow();
});

it("rejects an out-of-range amount before signing", () => {
  for (const amount of ["0", "01", "1000001"])
    expect(() => parseIntent({ ...intent(operationId()), amount })).toThrow(
      "invalid",
    );
});
