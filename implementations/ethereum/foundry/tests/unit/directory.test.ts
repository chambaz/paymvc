import { beforeEach, expect, it, vi } from "vitest";
import { readContacts } from "../../src/chain/payments";
import { parseDeployment } from "../../src/chain/config";
import { accountFor, newSession } from "../../src/chain/session";
import type { Address } from "viem";

const mocks = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("../../src/chain/config", async (original) => ({
  ...(await original<typeof import("../../src/chain/config")>()),
  publicClient: () => ({
    getBlockNumber: async () => 42n,
    readContract: mocks.read,
  }),
}));
const config = parseDeployment({
  chainId: 31337,
  rpcUrl: "http://127.0.0.1:8545",
  address: `0x${"1".repeat(40)}`,
  token: `0x${"2".repeat(40)}`,
  codeHash: `0x${"3".repeat(64)}`,
  deploymentBlock: "1",
  faucetUrl: "https://example.com",
});
const session = newSession(config);
const owner = accountFor(session).address;
const others = Array.from(
  { length: 12 },
  (_, index) => `0x${(index + 1).toString(16).padStart(40, "0")}` as Address,
);
let directory: Address[];
beforeEach(() => {
  directory = [...others];
  mocks.read.mockReset();
  mocks.read.mockImplementation(async ({ functionName, args, blockNumber }) => {
    expect(blockNumber).toBe(42n);
    if (functionName === "profileCount") return BigInt(directory.length);
    expect(functionName).toBe("profiles");
    const [offset, limit] = args as [bigint, bigint];
    expect(limit).toBeLessThanOrEqual(5n);
    return directory.slice(Number(offset), Number(offset + limit));
  });
});
it.each([0, 4, 5, 9, 12])(
  "does not skip addresses when self is at index %i",
  async (index) => {
    directory.splice(index, 0, owner);
    const found: Address[] = [];
    let offset: bigint | undefined = 0n;
    do {
      const page = await readContacts(config, session, offset);
      found.push(...page.addresses);
      offset = page.next;
    } while (offset !== undefined);
    expect(found).toEqual(others);
    expect(new Set(found).size).toBe(others.length);
  },
);
it("keeps the cursor stable when new users register between pages", async () => {
  directory = [owner, ...others.slice(0, 6)];
  const first = await readContacts(config, session, 0n);
  expect(first.addresses).toEqual(others.slice(0, 5));
  directory.push(...others.slice(6));
  const next = await readContacts(config, session, first.next!);
  expect(next.addresses).toEqual(others.slice(5, 10));
});
it("returns an empty page for an isolated user", async () => {
  directory = [owner];
  expect(await readContacts(config, session, 0n)).toEqual({
    addresses: [],
    next: undefined,
  });
});
it("does not turn an RPC failure into an empty directory", async () => {
  mocks.read.mockRejectedValueOnce(new Error("Unavailable"));
  await expect(readContacts(config, session, 0n)).rejects.toThrow(
    "Unavailable",
  );
});
