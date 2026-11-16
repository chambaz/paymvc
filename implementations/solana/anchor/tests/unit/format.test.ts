import { expect, it } from "vitest";
import { formatNative, type Deployment } from "../../src/chain/config";

const config = {} as Deployment;

it("formats exact SOL amounts without trailing zeros", () => {
  expect(formatNative(config, 50000000n)).toBe("0.05");
  expect(formatNative(config, 1000000000n)).toBe("1");
  expect(formatNative(config, 1500000001n)).toBe("1.500000001");
  expect(formatNative(config, 0n)).toBe("0");
});
