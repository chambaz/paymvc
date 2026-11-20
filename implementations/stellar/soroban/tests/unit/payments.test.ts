import { beforeEach, expect, it, vi } from "vitest";
import { Address, Keypair, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { Buffer } from "buffer";
import { parseDeployment } from "../../src/chain/config";
import { simulationError } from "../../src/chain/errors";
import {
  accountFor,
  newSession,
  operationId,
  type Session,
} from "../../src/chain/session";
import { inclusionFee } from "../../src/chain/transactions";

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  transact: vi.fn(),
  /** Replaces the ledger read for a test. */
  ledger: undefined as undefined | (() => Promise<unknown>),
}));
// A network that passes deployment verification: both instances run the expected WASM.
vi.mock("../../src/chain/config", async (original) => {
  const actual = await original<typeof import("../../src/chain/config")>();
  return {
    ...actual,
    server: (config: { passphrase: string; contract: string }) => ({
      getNetwork: async () => ({ passphrase: config.passphrase }),
      getLedgerEntries: async (...keys: { toXDR: (f: string) => string }[]) =>
        mocks.ledger?.() ?? {
          entries: keys.map((key) => ({
            key,
            val: {
              type: "contractData",
              contractData: {
                val: {
                  type: "scvContractInstance",
                  instance: {
                    executable: {
                      type: "contractExecutableWasm",
                      wasmHash: { toString: () => "0".repeat(64) },
                    },
                  },
                },
              },
            },
          })),
        },
    }),
  };
});
vi.mock("../../src/chain/transactions", async (original) => ({
  ...(await original<typeof import("../../src/chain/transactions")>()),
  readContract: mocks.read,
  transact: mocks.transact,
}));
const { fundingBudget, payments, readContacts } =
  await import("../../src/chain/payments");

const c = parseDeployment({
  network: "localnet",
  passphrase: "Standalone Network ; February 2017",
  rpcUrl: "http://127.0.0.1:8000/rpc",
  horizonUrl: "http://127.0.0.1:8000",
  faucetUrl: "http://127.0.0.1:8000/friendbot",
  contract: "CC23TODW7GXLDPJIPI3LVLAUVRQHXKW222GEEBPNJOLXTUGWOOHLHIY5",
  token: "CC23TODW7GXLDPJIPI3LVLAUVRQHXKW222GEEBPNJOLXTUGWOOHLHIY5",
  codeHash: "0".repeat(64),
  tokenHash: "0".repeat(64),
});
const peer = Keypair.random().publicKey();
let session: Session;
const operation = operationId();
const scEntry = (from: string, to: string) =>
  xdr.ScVal.scvMap(
    [
      ["amount", nativeToScVal(7n, { type: "i128" })],
      ["from", new Address(from).toScVal()],
      ["kind", xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Transfer")])],
      [
        "operation",
        nativeToScVal(Buffer.from(operation, "hex"), { type: "bytes" }),
      ],
      ["state", xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Paid")])],
      ["to", new Address(to).toScVal()],
    ].map(
      ([key, val]) =>
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol(key as string),
          val: val as xdr.ScVal,
        }),
    ),
  );
beforeEach(async () => {
  vi.resetAllMocks();
  mocks.ledger = undefined;
  session = await newSession(c);
});

it("names contract errors from a failed simulation", () => {
  expect(simulationError("HostError: Error(Contract, #2)")).toBe(
    "Choose a different, registered PayMVC account.",
  );
  expect(simulationError("HostError: Error(Contract, #101)")).toBe(
    "Not enough demo credits. No payment was completed.",
  );
  expect(simulationError("HostError: Error(Budget, ExceededLimit)")).toMatch(
    /could not prepare this step/,
  );
});

it("pays at least the minimum fee and at most 0.01 XLM", () => {
  expect(inclusionFee("100")).toBe("10000");
  expect(inclusionFee("25000")).toBe("25000");
  expect(inclusionFee("9999999")).toBe("100000");
  expect(inclusionFee("not a number")).toBe("10000");
});

it("confirms a saved payment from its entry when RPC history no longer has it", async () => {
  const owner = accountFor(session).address;
  session.journal[operation] = {
    raw: "saved",
    hash: "1".repeat(64),
    preparedLedger: 10,
    confirmed: false,
  };
  const persist = vi.fn();
  mocks.read.mockImplementation(async (_c, _source, contract, method) => {
    if (method === "entry") return scEntry(owner, peer);
    if (method === "token") return new Address(c.token).toScVal();
    if (method === "decimals") return nativeToScVal(0, { type: "u32" });
    throw new Error(`Unexpected read ${contract} ${method}`);
  });
  await payments(c, session, persist, () => {}).execute({
    action: "send",
    recipient: peer,
    amount: "7",
    id: "",
    operation,
  });
  // The entry proves the effect, so nothing is rebroadcast or signed again.
  expect(mocks.transact).not.toHaveBeenCalled();
  expect(session.journal[operation]!.confirmed).toBe(true);
  expect(persist).toHaveBeenCalled();
});

it("offers more contacts when a full page arrives after a stale count", async () => {
  const addresses = Array.from({ length: 6 }, () =>
    new Address(Keypair.random().publicKey()).toScVal(),
  );
  mocks.read.mockImplementation(async (_c, _source, _contract, method) =>
    method === "profile_count"
      ? nativeToScVal(5n, { type: "u64" })
      : xdr.ScVal.scvVec(addresses),
  );
  const page = await readContacts(c, session, 0n);
  expect(page.addresses).toHaveLength(5);
  expect(page.next).toBe(5n);
});

it("ends the list when a full page reaches the count", async () => {
  // The page includes the owner, so it yields five contacts and reaches the count of 6.
  const addresses = [
    new Address(accountFor(session).address).toScVal(),
    ...Array.from({ length: 5 }, () =>
      new Address(Keypair.random().publicKey()).toScVal(),
    ),
  ];
  let count = 6n;
  mocks.read.mockImplementation(async (_c, _source, _contract, method) =>
    method === "profile_count"
      ? nativeToScVal(count, { type: "u64" })
      : xdr.ScVal.scvVec(addresses),
  );
  expect((await readContacts(c, session, 0n)).next).toBeUndefined();
  // A registration between the reads leaves more to load.
  mocks.read.mockImplementation(async (_c, _source, _contract, method) =>
    method === "profile_count"
      ? nativeToScVal(count++, { type: "u64" })
      : xdr.ScVal.scvVec(addresses),
  );
  expect((await readContacts(c, session, 0n)).next).toBe(6n);
});

it("reads an account that does not exist yet as unfunded", async () => {
  mocks.ledger = async () => ({ entries: [] });
  const owner = Keypair.random().publicKey();
  await expect(fundingBudget(c, owner)).resolves.toMatchObject({ balance: 0n });
  mocks.ledger = async () => ({
    entries: [{ val: { type: "account", account: { balance: 70_000_000n } } }],
  });
  await expect(fundingBudget(c, owner)).resolves.toMatchObject({
    balance: 70_000_000n,
  });
});

it("reports a failed funding read instead of an unfunded account", async () => {
  mocks.ledger = async () => {
    throw new Error("503 Service Unavailable");
  };
  await expect(fundingBudget(c, Keypair.random().publicKey())).rejects.toThrow(
    "Could not check XLM funding",
  );
});
