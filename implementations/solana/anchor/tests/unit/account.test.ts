import { beforeEach, expect, it, vi } from "vitest";
import { address } from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { parseDeployment, pda } from "../../src/chain/config";

// The app spends from the owner's associated token account. A wallet can close an
// empty one; the account then reads as 0 credits instead of failing the dashboard.

const config = parseDeployment({
  network: "localnet",
  rpcUrl: "http://127.0.0.1:8899",
  program: "2LqK3mU8MZ1Hc3nBHqwhpFvH44bqbJJ9YQyEJLH6mywa",
  genesisHash: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
  faucetUrl: "https://faucet.solana.com",
});
const owner = address("9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin");
const mocks = vi.hoisted(() => ({ token: vi.fn() }));
vi.mock("../../src/chain/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/chain/config")>()),
  rpc: () => ({}),
}));
vi.mock("@solana-program/token", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@solana-program/token")>()),
  fetchMaybeToken: mocks.token,
}));
vi.mock("../../src/chain/generated", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/chain/generated")>()),
  fetchProfile: async () => ({
    programAddress: config.program,
    data: { activityCount: 3n },
  }),
}));
const { readAccount } = await import("../../src/chain/payments");

beforeEach(() => mocks.token.mockReset());

it("reads a closed token account as 0 credits", async () => {
  mocks.token.mockResolvedValue({ exists: false });
  expect(await readAccount(config, owner)).toEqual({ balance: 0n, count: 3n });
});

it("reads the credits of an open token account", async () => {
  mocks.token.mockResolvedValue({
    exists: true,
    programAddress: TOKEN_PROGRAM_ADDRESS,
    data: { owner, mint: await pda(config, "mint"), amount: 42n },
  });
  expect(await readAccount(config, owner)).toEqual({ balance: 42n, count: 3n });
});

it("rejects a token account for another mint", async () => {
  mocks.token.mockResolvedValue({
    exists: true,
    programAddress: TOKEN_PROGRAM_ADDRESS,
    data: { owner, mint: owner, amount: 42n },
  });
  await expect(readAccount(config, owner)).rejects.toThrow(
    "Token account verification failed.",
  );
});
