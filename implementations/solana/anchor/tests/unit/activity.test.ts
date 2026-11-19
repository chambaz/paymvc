import { beforeEach, expect, it, vi } from "vitest";
import { address, getU64Encoder, type Address } from "@solana/kit";
import { parseDeployment, pda } from "../../src/chain/config";
import {
  ACTIVITY_PAGE,
  activityAddress,
  readActivity,
} from "../../src/chain/payments";

const program = address("2LqK3mU8MZ1Hc3nBHqwhpFvH44bqbJJ9YQyEJLH6mywa");
const owner = address("C1Xhdt88ESirspBUY9jWGoDH8auRo3URJqjt4dqtZZcG");
const config = parseDeployment({
  network: "localnet",
  rpcUrl: "http://127.0.0.1:8899",
  program,
  genesisHash: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
  faucetUrl: "https://faucet.solana.com",
});
/** A stand-in entry address for activity record `index`, so a test can follow each record. */
const records: Address[] = [];
const record = (index: bigint) => records[Number(index)]!;
const requested = vi.hoisted(() => ({ pages: [] as Address[] }));
const pageAddresses = new Map<Address, bigint>();
vi.mock("../../src/chain/generated", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/chain/generated")>()),
  fetchAllActivity: async (_: unknown, addresses: Address[]) => {
    requested.pages = addresses;
    return addresses.map((page) => {
      const first = pageAddresses.get(page)! * ACTIVITY_PAGE;
      return {
        address: page,
        programAddress: program,
        data: {
          entries: Array.from({ length: Number(ACTIVITY_PAGE) }, (_, i) =>
            record(first + BigInt(i)),
          ),
        },
      };
    });
  },
  fetchAllEntry: async (_: unknown, addresses: Address[]) =>
    addresses.map((address) => ({ address })),
}));
beforeEach(async () => {
  requested.pages = [];
  for (let i = records.length; i < 4 * Number(ACTIVITY_PAGE); i++)
    records.push(await pda(config, "record", getU64Encoder().encode(i)));
  for (let page = 0n; page < 4n; page++)
    pageAddresses.set(
      await activityAddress(config, owner, page * ACTIVITY_PAGE),
      page,
    );
});

it("reads the records below the absolute cursor, newest first", async () => {
  const page = await readActivity(config, owner, 5n, 3);
  expect(requested.pages).toEqual([await activityAddress(config, owner, 0n)]);
  expect(page.map((entry) => entry.address)).toEqual([4n, 3n, 2n].map(record));
});

it("reads each activity account once across a page boundary", async () => {
  const before = ACTIVITY_PAGE + 3n;
  const page = await readActivity(config, owner, before, 10);
  expect(requested.pages).toEqual(
    await Promise.all(
      [ACTIVITY_PAGE, 0n].map((index) => activityAddress(config, owner, index)),
    ),
  );
  expect(page.map((entry) => entry.address)).toEqual(
    Array.from({ length: 10 }, (_, i) => record(before - 1n - BigInt(i))),
  );
});

it("stops at the oldest record", async () => {
  const page = await readActivity(config, owner, 2n, 50);
  expect(page.map((entry) => entry.address)).toEqual([1n, 0n].map(record));
  expect(await readActivity(config, owner, 0n, 50)).toEqual([]);
});

it("rejects a page size outside 1 to 50", async () => {
  for (const limit of [0, 51, 1.5])
    await expect(readActivity(config, owner, 5n, limit)).rejects.toThrow(
      "1 to 50",
    );
});
