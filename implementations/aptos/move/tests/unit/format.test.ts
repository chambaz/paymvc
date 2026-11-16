import { expect, it } from "vitest";
import { formatNative, type Deployment } from "../../src/chain/config";

const config = {} as Deployment;

it("formats exact APT amounts without trailing zeros", () => {
  expect(formatNative(config, 10000000n)).toBe("0.1");
  expect(formatNative(config, 100000000n)).toBe("1");
  expect(formatNative(config, 123456789n)).toBe("1.23456789");
  expect(formatNative(config, 0n)).toBe("0");
});
