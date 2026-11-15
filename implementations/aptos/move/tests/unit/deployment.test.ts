import { beforeEach, expect, it, vi } from "vitest";
import { moduleHash, verifyDeployment } from "../../src/chain/payments";
import { normalizeAddress, type Deployment } from "../../src/chain/config";

const client = vi.hoisted(() => ({
  getLedgerInfo: vi.fn(),
  getAccountModule: vi.fn(),
  getAccountResource: vi.fn(),
  view: vi.fn(),
}));
vi.mock("../../src/chain/config", async (original) => ({
  ...(await original<typeof import("../../src/chain/config")>()),
  server: () => client,
}));
async function config(): Promise<Deployment> {
  const hash = await moduleHash("0x1234");
  return {
    network: "testnet",
    rpcUrl: "https://api.testnet.aptoslabs.com/v1",
    chainId: 2,
    package: normalizeAddress("0xa"),
    metadata: normalizeAddress("0xb"),
    modules: { credits: hash, paymvc: hash },
    publishHash: `0x${"1".repeat(64)}`,
    faucetUrl: "https://aptos.dev/network/faucet",
  };
}
beforeEach(() => {
  vi.resetAllMocks();
  client.getLedgerInfo.mockResolvedValue({ chain_id: 2 });
  client.getAccountModule.mockResolvedValue({ bytecode: "0x1234" });
  client.getAccountResource.mockResolvedValue({
    packages: [{ name: "paymvc", upgrade_policy: { policy: 2 } }],
  });
  client.view.mockResolvedValue([{ inner: "0xb" }]);
});
it("shares successful immutable verification and rechecks a new configuration", async () => {
  const c = await config();
  await Promise.all([verifyDeployment(c), verifyDeployment(c)]);
  await verifyDeployment(c);
  // One read for each module: credits and paymvc.
  expect(client.getAccountModule).toHaveBeenCalledTimes(2);
  await verifyDeployment({ ...c });
  expect(client.getAccountModule).toHaveBeenCalledTimes(4);
});
it("does not cache failed verification or accept an upgradeable package", async () => {
  const c = await config();
  client.getAccountResource.mockResolvedValueOnce({
    packages: [{ name: "paymvc", upgrade_policy: { policy: 1 } }],
  });
  await expect(verifyDeployment(c)).rejects.toThrow("verification failed");
  await verifyDeployment(c);
  expect(client.getAccountModule).toHaveBeenCalledTimes(4);
});
it("rejects a different network, bytecode, or asset identity", async () => {
  const c = await config();
  for (const change of [
    { chainId: 3 },
    { modules: { ...c.modules, credits: "0".repeat(64) } },
    { modules: { ...c.modules, paymvc: "0".repeat(64) } },
    { metadata: normalizeAddress("0xc") },
  ]) {
    await expect(verifyDeployment({ ...c, ...change })).rejects.toThrow(
      "verification failed",
    );
  }
});
