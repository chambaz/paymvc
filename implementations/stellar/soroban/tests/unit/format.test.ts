import { expect, it } from "vitest";
import { formatNative, type Deployment } from "../../src/chain/config";

const config = {} as Deployment;

it("formats exact XLM amounts without trailing zeros", () => {
  expect(formatNative(config, 20000000n)).toBe("2");
  expect(formatNative(config, 1000000n)).toBe("0.1");
  expect(formatNative(config, 12345678n)).toBe("1.2345678");
  expect(formatNative(config, 0n)).toBe("0");
});
