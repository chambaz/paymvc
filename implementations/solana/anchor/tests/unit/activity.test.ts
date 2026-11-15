import { beforeEach, expect, it, vi } from "vitest";
import { address, type Address } from "@solana/kit";
import { parseDeployment } from "../../src/chain/config";
import { activityAddress, readActivity } from "../../src/chain/payments";

const program = address("Wn8Ma9d5nMPhZhqUCXKSJMJMSNGZ8bunifjkD84rA64");
const owner = address("C1Xhdt88ESirspBUY9jWGoDH8auRo3URJqjt4dqtZZcG");
const config = parseDeployment({
  network: "localnet",
  rpcUrl: "http://127.0.0.1:8899",
  program,
  genesisHash: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
  faucetUrl: "https://faucet.solana.com",
});
const requested = vi.hoisted(() => ({ activity: [] as Address[] }));
vi.mock("../../src/chain/generated", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/chain/generated")>()),
  fetchAllActivity: async (_: unknown, addresses: Address[]) => {
    requested.activity = addresses;
    return addresses.map((entry) => ({
      address: entry,
      programAddress: program,
      data: { entry },
    }));
  },
  fetchAllEntry: async (_: unknown, addresses: Address[]) =>
    addresses.map((address) => ({ address })),
}));
beforeEach(() => {
  requested.activity = [];
});

it("reads the records below the absolute cursor, newest first", async () => {
  const page = await readActivity(config, owner, 5n, 3);
  const expected = await Promise.all(
    [4n, 3n, 2n].map((index) => activityAddress(config, owner, index)),
  );
  expect(requested.activity).toEqual(expected);
  expect(page.map((entry) => entry.address)).toEqual(expected);
});

it("stops at the oldest record", async () => {
  const page = await readActivity(config, owner, 2n, 50);
  expect(page).toHaveLength(2);
  expect(requested.activity.at(-1)).toBe(
    await activityAddress(config, owner, 0n),
  );
  expect(await readActivity(config, owner, 0n, 50)).toEqual([]);
});

it("rejects a page size outside 1 to 50", async () => {
  for (const limit of [0, 51, 1.5])
    await expect(readActivity(config, owner, 5n, limit)).rejects.toThrow(
      "1 to 50",
    );
});
