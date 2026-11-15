import { beforeEach, expect, it, vi } from "vitest";
import {
  AccountAddress,
  ChainId,
  EntryFunction,
  RawTransaction,
  SimpleTransaction,
  TransactionPayloadEntryFunction,
  generateSignedTransaction,
  generateUserTransactionHash,
  Hex,
} from "@aptos-labs/ts-sdk";
import {
  buildCall,
  moduleHash,
  operationBytes,
  payments,
  readDashboard,
} from "../../src/chain/payments";
import { normalizeAddress, type Deployment } from "../../src/chain/config";
import {
  accountFor,
  entryId,
  newSession,
  signerFor,
  type Intent,
  type Session,
} from "../../src/chain/session";

const client = vi.hoisted(() => ({
  getLedgerInfo: vi.fn(),
  getAccountModule: vi.fn(),
  getAccountResource: vi.fn(),
  getTransactionByHash: vi.fn(),
  view: vi.fn(),
  transaction: { build: { simple: vi.fn() } },
}));
vi.mock("../../src/chain/config", async (original) => ({
  ...(await original<typeof import("../../src/chain/config")>()),
  server: () => client,
  latestLedger: () => client.getLedgerInfo(),
}));

const recipient = normalizeAddress("0xc");
let c: Deployment;
let views: Record<string, unknown>;

function viewNames() {
  return client.view.mock.calls.map(([args]) =>
    (args.payload.function as string).split("::").at(-1)!,
  );
}
const operation = "1".repeat(64);
function sendIntent(s: Session): Intent {
  return {
    action: "send",
    recipient,
    amount: "10",
    id: entryId(accountFor(s).address, operation),
    operation,
  };
}
function chainEntry(from: string, to: string, kind: string, state: string) {
  return {
    from,
    to,
    operation: `0x${operation}`,
    amount: "10",
    kind: { __variant__: kind },
    state: { __variant__: state },
  };
}
function savedSend(s: Session, label: string) {
  const transaction = new SimpleTransaction(
    new RawTransaction(
      AccountAddress.fromString(accountFor(s).address),
      0n,
      new TransactionPayloadEntryFunction(
        EntryFunction.build(`${c.package}::paymvc`, "send", [], []),
      ),
      20000n,
      100n,
      1000n,
      new ChainId(2),
    ),
  );
  const senderAuthenticator =
    signerFor(s).signTransactionWithAuthenticator(transaction);
  const signed = { transaction, senderAuthenticator };
  s.journal[label] = {
    raw: Hex.fromHexInput(generateSignedTransaction(signed)).toString(),
    hash: generateUserTransactionHash(signed),
    preparedVersion: "10",
    confirmed: false,
  };
}

beforeEach(async () => {
  vi.resetAllMocks();
  c = {
    network: "testnet",
    rpcUrl: "https://api.testnet.aptoslabs.com/v1",
    chainId: 2,
    package: normalizeAddress("0xa"),
    metadata: normalizeAddress("0xb"),
    modules: {
      credits: await moduleHash("0x1234"),
      paymvc: await moduleHash("0x1234"),
    },
    publishHash: `0x${"1".repeat(64)}`,
    faucetUrl: "https://aptos.dev/network/faucet",
  };
  views = {
    metadata: { inner: "0xb" },
    registered: true,
    balance: "5",
    entry: { vec: [] },
  };
  client.getLedgerInfo.mockResolvedValue({
    chain_id: 2,
    ledger_version: "42",
    ledger_timestamp: "1700000000123456",
    oldest_ledger_version: "0",
  });
  client.getAccountModule.mockResolvedValue({ bytecode: "0x1234" });
  client.getAccountResource.mockResolvedValue({
    packages: [{ name: "paymvc", upgrade_policy: { policy: 2 } }],
  });
  client.view.mockImplementation(
    async (args: { payload: { function: string } }) => [
      views[args.payload.function.split("::").at(-1)!],
    ],
  );
});

it("reads the whole dashboard at one ledger version with an absolute cursor", async () => {
  const s = newSession(c);
  const owner = accountFor(s).address;
  views.balance = "100";
  views.activity_count = "60";
  client.view.mockImplementation(
    async (args: {
      payload: { function: string; functionArguments: unknown[] };
    }) => {
      const name = args.payload.function.split("::").at(-1)!;
      if (name !== "activity") return [views[name]];
      const before = Number(args.payload.functionArguments[1]);
      const size = Math.min(before, Number(args.payload.functionArguments[2]));
      return [
        Array.from({ length: size }, (_, i) => ({
          ...chainEntry(owner, recipient, "Transfer", "Paid"),
          operation: `0x${(before - i).toString(16).padStart(64, "0")}`,
        })),
      ];
    },
  );
  const dashboard = await readDashboard(c, s, 100);
  expect(dashboard.balance).toBe(100n);
  expect(dashboard.entries).toHaveLength(60);
  expect(new Set(dashboard.entries.map((e) => e.id)).size).toBe(60);
  expect(viewNames()).toEqual([
    "balance",
    "activity_count",
    "activity",
    "activity",
  ]);
  const pages = client.view.mock.calls
    .map(([args]) => args.payload)
    .filter((p) => p.function.endsWith("::activity"));
  expect(pages.map((p) => p.functionArguments.slice(1))).toEqual([
    [60n, 50n],
    [10n, 50n],
  ]);
  for (const [args] of client.view.mock.calls)
    expect(args.options).toEqual({ ledgerVersion: 42n });
});

it("maps Move enums and the entry key to a stable row ID", async () => {
  const s = newSession(c);
  const owner = accountFor(s).address;
  views.activity_count = "1";
  views.activity = [chainEntry(recipient, owner, "Request", "Pending")];
  const [entry] = (await readDashboard(c, s)).entries;
  expect(entry).toEqual({
    id: entryId(recipient, operation),
    from: recipient,
    to: owner,
    operation,
    amount: 10n,
    kind: "Request",
    state: "Pending",
  });
});

it("sets expiry from ledger time, not the device clock", async () => {
  vi.spyOn(Date, "now").mockReturnValue(0);
  const s = newSession(c);
  await buildCall(c, s, await client.getLedgerInfo(), "send", [
    recipient,
    1n,
    operationBytes(operation),
  ]);
  expect(
    client.transaction.build.simple.mock.calls[0]![0].options.expireTimestamp,
  ).toBe(1700000000 + 600);
  vi.restoreAllMocks();
});

it("blocks a send without enough credits before signing", async () => {
  const s = newSession(c);
  await expect(
    payments(c, s, vi.fn(), vi.fn()).execute(sendIntent(s)),
  ).rejects.toThrow("Not enough demo credits. No payment was completed.");
  expect(client.transaction.build.simple).not.toHaveBeenCalled();
  expect(s.journal).toEqual({});
});

it("skips the balance check when a saved transaction exists", async () => {
  const s = newSession(c);
  const intent = sendIntent(s);
  savedSend(s, `${intent.operation}:send`);
  views.entry = {
    vec: [chainEntry(accountFor(s).address, recipient, "Transfer", "Paid")],
  };
  client.getTransactionByHash.mockResolvedValue({
    type: "user_transaction",
    success: true,
  });
  await payments(c, s, vi.fn(), vi.fn()).execute(intent);
  expect(viewNames()).not.toContain("balance");
  expect(client.transaction.build.simple).not.toHaveBeenCalled();
  expect(s.journal[`${intent.operation}:send`]?.confirmed).toBe(true);
});

it("rejects an intent whose entry ID does not match its operation", async () => {
  const s = newSession(c);
  const intent = { ...sendIntent(s), id: entryId(recipient, operation) };
  await expect(
    payments(c, s, vi.fn(), vi.fn()).execute(intent),
  ).rejects.toThrow("This operation is invalid");
  expect(client.view).not.toHaveBeenCalled();
});

it("resolves a request by its (from, operation) key", async () => {
  const s = newSession(c);
  const owner = accountFor(s).address;
  views.entry = { vec: [chainEntry(recipient, owner, "Request", "Pending")] };
  views.balance = "100";
  client.transaction.build.simple.mockRejectedValue(new Error("stop"));
  await expect(
    payments(c, s, vi.fn(), vi.fn()).execute({
      action: "approve",
      recipient,
      amount: "10",
      id: entryId(recipient, operation),
      operation: "2".repeat(64),
    }),
  ).rejects.toThrow("stop");
  const call = client.transaction.build.simple.mock.calls[0]![0].data;
  expect(call.function).toBe(`${c.package}::paymvc::approve`);
  expect(call.functionArguments).toEqual([
    recipient,
    operationBytes(operation),
  ]);
});

it("refuses to resolve a request for another payer", async () => {
  const s = newSession(c);
  views.entry = {
    vec: [chainEntry(recipient, normalizeAddress("0xd"), "Request", "Pending")],
  };
  await expect(
    payments(c, s, vi.fn(), vi.fn()).execute({
      action: "decline",
      recipient,
      amount: "10",
      id: entryId(recipient, operation),
      operation: "2".repeat(64),
    }),
  ).rejects.toThrow("Only the intended payer");
  expect(client.transaction.build.simple).not.toHaveBeenCalled();
});
