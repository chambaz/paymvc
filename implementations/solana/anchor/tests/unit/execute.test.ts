import { beforeEach, expect, it, vi } from "vitest";
import {
  address,
  getAddressEncoder,
  getBase64Decoder,
  getU32Encoder,
  getU64Encoder,
  some,
  none,
} from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { parseDeployment, pda } from "../../src/chain/config";
import { Kind, State } from "../../src/chain/generated";
import {
  accountFor,
  newSession,
  operationId,
  type Session,
} from "../../src/chain/session";
import { RevertedTransaction } from "../../src/chain/transactions";

// A confirmed failure can mean that an earlier attempt, which a lagging RPC did not
// show, already made the change. These tests cover execute's handling of that case.

const LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";
const programData = address("C1Xhdt88ESirspBUY9jWGoDH8auRo3URJqjt4dqtZZcG");
const config = parseDeployment({
  network: "localnet",
  rpcUrl: "http://127.0.0.1:8899",
  program: "2LqK3mU8MZ1Hc3nBHqwhpFvH44bqbJJ9YQyEJLH6mywa",
  genesisHash: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
  faucetUrl: "https://faucet.solana.com",
});
const mocks = vi.hoisted(() => ({
  accounts: new Map<string, unknown>(),
  mint: { value: undefined as unknown },
  transact: vi.fn(),
  maybeEntry: vi.fn(),
  entry: vi.fn(),
}));
vi.mock("../../src/chain/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/chain/config")>()),
  rpc: () => ({
    getGenesisHash: () => ({ send: async () => config.genesisHash }),
    getAccountInfo: (key: string) => ({
      send: async () => ({ value: mocks.accounts.get(key) ?? null }),
    }),
  }),
}));
vi.mock("@solana-program/token", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@solana-program/token")>()),
  fetchMint: async () => mocks.mint.value,
}));
vi.mock("../../src/chain/generated", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/chain/generated")>()),
  fetchMaybeEntry: mocks.maybeEntry,
  fetchEntry: mocks.entry,
}));
vi.mock("../../src/chain/transactions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/chain/transactions")>()),
  transact: mocks.transact,
}));
const { payments } = await import("../../src/chain/payments");

const base64 = (bytes: Uint8Array) => getBase64Decoder().decode(bytes);
const peer = address("9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin");
const requestId = address("SysvarRent111111111111111111111111111111111");
let s: Session;
let actor: string;
/** The read at the failure's slot carries `minContextSlot`. */
const atFailure = (options: { minContextSlot?: bigint }) =>
  options.minContextSlot === 42n;

beforeEach(async () => {
  vi.resetAllMocks();
  mocks.accounts.clear();
  const program = new Uint8Array(36);
  program.set(getU32Encoder().encode(2), 0);
  program.set(getAddressEncoder().encode(programData), 4);
  mocks.accounts.set(config.program, {
    owner: LOADER,
    executable: true,
    data: [base64(program), "base64"],
  });
  // ProgramData with no upgrade authority: the program cannot change.
  const data = new Uint8Array(45);
  data.set(getU32Encoder().encode(3), 0);
  data.set(getU64Encoder().encode(1n), 4);
  mocks.accounts.set(programData, {
    owner: LOADER,
    executable: false,
    data: [base64(data), "base64"],
  });
  mocks.mint.value = {
    programAddress: TOKEN_PROGRAM_ADDRESS,
    data: {
      decimals: 0,
      mintAuthority: some(await pda(config, "authority")),
      freezeAuthority: none(),
    },
  };
  s = await newSession(config);
  actor = accountFor(s).address;
  mocks.transact.mockRejectedValue(new RevertedTransaction(42n));
});

const send = () =>
  payments(
    config,
    s,
    () => {},
    () => {},
  ).execute({
    action: "send",
    recipient: peer,
    amount: "5",
    id: "",
    operation: operationId(),
  });
const sent = () => ({
  exists: true,
  programAddress: config.program,
  data: { from: actor, to: peer, amount: 5n, kind: Kind.Transfer },
});

it("reports a send as done when an earlier attempt made the entry", async () => {
  mocks.maybeEntry.mockImplementation(async (_rpc, _id, options) =>
    atFailure(options) ? sent() : { exists: false },
  );
  await expect(send()).resolves.toBeUndefined();
});

it("keeps a send's failure when the entry is absent", async () => {
  mocks.maybeEntry.mockResolvedValue({ exists: false });
  await expect(send()).rejects.toBeInstanceOf(RevertedTransaction);
});

it("keeps a send's failure when the read at the failure's slot fails", async () => {
  // Not ResultPending: the hook would recheck it automatically and sign again.
  mocks.maybeEntry.mockImplementation(async (_rpc, _id, options) => {
    if (atFailure(options)) throw new Error("Minimum context slot not reached");
    return { exists: false };
  });
  await expect(send()).rejects.toBeInstanceOf(RevertedTransaction);
});

it("does not read state for other errors", async () => {
  mocks.maybeEntry.mockResolvedValue({ exists: false });
  mocks.transact.mockRejectedValue(new Error("RPC down"));
  await expect(send()).rejects.toThrow("RPC down");
  expect(mocks.maybeEntry).toHaveBeenCalledOnce();
});

const approve = () =>
  payments(
    config,
    s,
    () => {},
    () => {},
  ).execute({
    action: "approve",
    recipient: peer,
    amount: "5",
    id: requestId,
    operation: operationId(),
  });
const request = (state: State) => ({
  programAddress: config.program,
  data: {
    from: peer,
    to: actor,
    amount: 5n,
    kind: Kind.Request,
    state,
    operation: new Uint8Array(32),
  },
});

it("reports an approval as done when an earlier attempt paid the request", async () => {
  mocks.entry.mockImplementation(async (_rpc, _id, options) =>
    request(atFailure(options) ? State.Paid : State.Pending),
  );
  await expect(approve()).resolves.toBeUndefined();
});

it("keeps an approval's failure when the request is still pending", async () => {
  mocks.entry.mockResolvedValue(request(State.Pending));
  await expect(approve()).rejects.toBeInstanceOf(RevertedTransaction);
});

it("keeps an approval's failure when the read at the failure's slot fails", async () => {
  mocks.entry.mockImplementation(async (_rpc, _id, options) => {
    if (atFailure(options)) throw new Error("Minimum context slot not reached");
    return request(State.Pending);
  });
  await expect(approve()).rejects.toBeInstanceOf(RevertedTransaction);
});
