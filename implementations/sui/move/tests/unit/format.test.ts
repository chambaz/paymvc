import { expect, it } from "vitest";
import { formatNative, type Deployment } from "../../src/chain/config";

const config = {} as Deployment;

it("formats exact SUI amounts without trailing zeros", () => {
  expect(formatNative(config, 100000000n)).toBe("0.1");
  expect(formatNative(config, 2000000000n)).toBe("2");
  expect(formatNative(config, 130000000n)).toBe("0.13");
  expect(formatNative(config, 0n)).toBe("0");
});
