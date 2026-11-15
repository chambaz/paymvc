import { beforeEach, expect, it, vi } from "vitest";
import { parseEther } from "viem";
import { parseDeployment } from "../../src/chain/config";
import { fundingBudget } from "../../src/chain/payments";

const mocks = vi.hoisted(() => ({ fees: vi.fn(), balance: vi.fn() }));
vi.mock("../../src/chain/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/chain/config")>()),
  publicClient: () => ({
    estimateFeesPerGas: mocks.fees,
    getBalance: mocks.balance,
  }),
}));
const address = `0x${"1".repeat(40)}` as const;
function config(chainId: number) {
  return parseDeployment({
    chainId,
    rpcUrl: "https://example.com",
    address,
    token: `0x${"2".repeat(40)}`,
    codeHash: `0x${"3".repeat(64)}`,
    deploymentBlock: "1",
    faucetUrl: "https://example.com/faucet",
  });
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.fees.mockResolvedValue({ maxFeePerGas: 7_000_000n });
  mocks.balance.mockResolvedValue(parseEther("0.002"));
});
it("budgets Base separately while preserving the Sepolia reserve", async () => {
  const base = await fundingBudget(config(84532), address);
  expect(base.required).toBe(parseEther("0.00005"));
  expect(base.balance).toBe(parseEther("0.002"));
  expect((await fundingBudget(config(11155111), address)).required).toBe(
    parseEther("0.0005"),
  );
});
it("raises the budget with fees, for each network's scenario gas", async () => {
  mocks.fees.mockResolvedValue({ maxFeePerGas: 200_000_000n });
  // 1.5M gas on Base and 5M gas on Sepolia, at 0.2 gwei.
  expect((await fundingBudget(config(84532), address)).required).toBe(
    parseEther("0.0003"),
  );
  expect((await fundingBudget(config(11155111), address)).required).toBe(
    parseEther("0.001"),
  );
});
