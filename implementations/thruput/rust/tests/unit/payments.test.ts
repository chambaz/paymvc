import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  addressFromBase58,
  fixedBytes,
  fromHex0x,
  toBase58,
  toHex0x,
} from "@thruputchain/client";
import { ERC20, ERC20Metadata } from "../../src/chain/generated/credits";
import { PayMVC } from "../../src/chain/generated/paymvc";
import {
  entryId,
  FundingRequired,
  payments,
  readContacts,
  readDashboard,
  verifyDeployment,
} from "../../src/chain/payments";
import {
  accountFor,
  newSession,
  operationId,
  type Intent,
  type Session,
} from "../../src/chain/session";
import { ResultPending } from "../../src/chain/transactions";
import { config } from "./fixture";

const { clientFor, transact } = vi.hoisted(() => ({
  clientFor: vi.fn(),
  transact: vi.fn(),
}));
vi.mock("../../src/chain/config", async (original) => ({
  ...(await original<typeof import("../../src/chain/config")>()),
  clientFor,
}));
vi.mock("../../src/chain/transactions", async (original) => ({
  ...(await original<typeof import("../../src/chain/transactions")>()),
  transact,
}));

const app = PayMVC.v0_1;
const contact = (n: number) => toBase58(new Uint8Array(32).fill(n));
const ok = (value: unknown) => ({ kind: "return", value });
let session: Session;
let directory: string[];
/** What the deployment check reads: PayMVC's token and the token's decimals. */
let deployed: { token: string; decimals: bigint; hashes: string[] };
const client = {
  getNetworkInfo: vi.fn(),
  getContractDeployment: vi.fn(),
  readViews: vi.fn(),
  getBalance: vi.fn(),
};
const deploymentCheck = (calls: unknown[]) => calls[0] === "credits";
const deploymentViews = () => ({
  results: [ok(addressFromBase58(deployed.token)), ok(deployed.decimals)],
});

beforeEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
  session = newSession(config);
  directory = [];
  deployed = {
    token: config.credits,
    decimals: 0n,
    hashes: [config.contractHash, config.creditsHash],
  };
  clientFor.mockResolvedValue(client);
  client.getNetworkInfo.mockResolvedValue({
    networkHash: addressFromBase58(config.networkHash),
  });
  client.getContractDeployment.mockImplementation(async ({ address }) => {
    const index = toBase58(address) === config.address ? 0 : 1;
    return { deployment: { hash: addressFromBase58(deployed.hashes[index]!) } };
  });
  vi.spyOn(app.credits, "viewRequest").mockReturnValue("credits" as never);
  vi.spyOn(ERC20Metadata.v0_1.decimals, "viewRequest").mockReturnValue(
    "decimals" as never,
  );
  // Each view request carries its arguments, so the fake RPC can slice the
  // directory exactly as the contract does.
  vi.spyOn(app.profileCount, "viewRequest").mockReturnValue(
    "profileCount" as never,
  );
  vi.spyOn(app.profiles, "viewRequest").mockImplementation(
    (request) => request.args as never,
  );
  client.readViews.mockImplementation(async ({ calls }) => {
    if (deploymentCheck(calls)) return deploymentViews();
    const { start, limit } = calls[1];
    const page = directory.slice(Number(start), Number(start + limit));
    return {
      results: [ok(BigInt(directory.length)), ok(page.map(addressFromBase58))],
    };
  });
});

describe("deployment", () => {
  it("accepts the saved network, code, token, and decimals", async () => {
    await expect(verifyDeployment(config)).resolves.toBe(client);
  });

  it("rejects a different network", async () => {
    client.getNetworkInfo.mockResolvedValue({
      networkHash: addressFromBase58(config.address),
    });
    await expect(verifyDeployment(config)).rejects.toThrow("network changed");
  });

  it("rejects different PayMVC code or a missing contract", async () => {
    deployed.hashes[0] = contact(9);
    await expect(verifyDeployment(config)).rejects.toThrow("not found");
    client.getContractDeployment.mockResolvedValue({ deployment: null });
    await expect(verifyDeployment(config)).rejects.toThrow("not found");
  });

  it("rejects a PayMVC bound to another token", async () => {
    deployed.token = contact(9);
    await expect(verifyDeployment(config)).rejects.toThrow("not found");
  });

  it("rejects different token code or nonzero decimals", async () => {
    deployed.hashes[1] = contact(9);
    await expect(verifyDeployment(config)).rejects.toThrow("credits token");
    deployed.hashes[1] = config.creditsHash;
    deployed.decimals = 7n;
    await expect(verifyDeployment(config)).rejects.toThrow("credits token");
  });
});

describe("contacts", () => {
  const all = async () => {
    const pages: string[][] = [];
    let start: bigint | undefined = 0n;
    while (start !== undefined) {
      const result = await readContacts(config, session, start);
      pages.push(result.addresses);
      start = result.next;
    }
    return pages;
  };

  it("ends when only the owner remains", async () => {
    const owner = accountFor(session).address;
    directory = [1, 2, 3, 4, 5].map(contact).concat(owner);
    expect(await all()).toEqual([[1, 2, 3, 4, 5].map(contact)]);
  });

  it("skips the owner in the middle without skipping a contact", async () => {
    const owner = accountFor(session).address;
    directory = [1, 2, owner, 3, 4, 5, 6, 7].map((entry) =>
      typeof entry === "number" ? contact(entry) : entry,
    );
    expect(await all()).toEqual([
      [1, 2, 3, 4, 5].map(contact),
      [6, 7].map(contact),
    ]);
  });

  it("keeps the next contact when the owner follows it", async () => {
    const owner = accountFor(session).address;
    directory = [1, 2, 3, 4, 5, 6].map(contact).concat(owner);
    expect(await all()).toEqual([[1, 2, 3, 4, 5].map(contact), [contact(6)]]);
  });

  it("returns an empty final page", async () => {
    directory = [contact(1)];
    expect(await readContacts(config, session, 1n)).toEqual({
      addresses: [],
      next: undefined,
    });
  });

  it("reads registrations that arrive between pages", async () => {
    directory = [1, 2, 3, 4, 5, 6].map(contact);
    const first = await readContacts(config, session, 0n);
    expect(first.next).toBe(5n);
    directory.push(contact(7));
    expect(await readContacts(config, session, first.next!)).toEqual({
      addresses: [6, 7].map(contact),
      next: undefined,
    });
  });
});

describe("dashboard", () => {
  it("reads absolute activity pages in batches at the balance's state height", async () => {
    vi.spyOn(ERC20.v0_1.getBalanceOf, "viewRequest").mockImplementation(
      (request) => ({ balanceOf: request.address }) as never,
    );
    vi.spyOn(app.activityCount, "viewRequest").mockReturnValue(
      "activityCount" as never,
    );
    vi.spyOn(app.activity, "viewRequest").mockImplementation(
      (request) => request.args as never,
    );
    const operation = fixedBytes(new Uint8Array(32).fill(7), 32);
    const entry = {
      from: addressFromBase58(contact(1)),
      to: addressFromBase58(contact(2)),
      operation,
      amount: 1n,
      kind: 0n,
      state: 1n,
    };
    const batches: { size: number; minStateBlockHeight?: bigint }[] = [];
    const cursors: bigint[] = [];
    client.readViews.mockImplementation(async (request) => {
      const { calls, minStateBlockHeight } = request;
      if (deploymentCheck(calls)) return deploymentViews();
      if (calls[1] === "activityCount") {
        expect(toBase58(calls[0].balanceOf)).toBe(config.credits);
        return { stateBlockHeight: 120n, results: [ok(100n), ok(103n)] };
      }
      batches.push({ size: calls.length, minStateBlockHeight });
      return {
        results: calls.map(({ before, limit }: Record<string, bigint>) => {
          cursors.push(before!);
          return ok(Array.from({ length: Number(limit) }, () => entry));
        }),
      };
    });
    const result = await readDashboard(config, session, 100);
    expect(result.balance).toBe(100n);
    expect(result.count).toBe(103n);
    expect(result.entries).toHaveLength(100);
    expect(result.entries[0]!.id).toBe(entryId(contact(1), toHex0x(operation)));
    // Each page starts at an absolute history index, newest first.
    expect(cursors).toEqual(
      Array.from({ length: 20 }, (_, i) => 103n - 5n * BigInt(i)),
    );
    expect(batches).toEqual([
      { size: 16, minStateBlockHeight: 120n },
      { size: 4, minStateBlockHeight: 120n },
    ]);
  });
});

describe("registration", () => {
  const setup = () =>
    payments(
      config,
      session,
      () => {},
      () => {},
    ).setup();
  const registered = (value: boolean) =>
    vi.spyOn(app.registered, "view").mockResolvedValue({ value } as never);

  beforeEach(() => {
    client.getBalance.mockResolvedValue({ rawBalance: 0n });
    registered(true);
  });

  it("requires funds before a new registration", async () => {
    await expect(setup()).rejects.toBeInstanceOf(FundingRequired);
    expect(transact).not.toHaveBeenCalled();
  });

  it("reconciles a saved registration without a funding check", async () => {
    session.journal.registration = {
      raw: "0x00",
      hash: "saved",
      confirmed: false,
    };
    await setup();
    expect(client.getBalance).not.toHaveBeenCalled();
    expect(transact).toHaveBeenCalledOnce();
    expect(session.ready).toBe(true);
  });

  it("reports a pending result until the registration is visible", async () => {
    client.getBalance.mockResolvedValue({ rawBalance: 100_000_000n });
    registered(false);
    await expect(setup()).rejects.toBeInstanceOf(ResultPending);
    expect(transact).toHaveBeenCalledOnce();
    expect(session.ready).toBe(false);
  });
});

describe("payments", () => {
  const peer = contact(8);
  const execute = (intent: Intent) =>
    payments(
      config,
      session,
      () => {},
      () => {},
    ).execute(intent);
  /** The batch passed to `transact`, as entrypoint names. */
  const batch = () =>
    (transact.mock.calls[0]![6] as { entrypoint: Uint8Array }[]).map(
      (call) =>
        Object.entries({
          adjustAllowance: ERC20.v0_1.adjustAllowance,
          send: app.send,
          request: app.request,
          approve: app.approve,
          decline: app.decline,
        }).find(
          ([, method]) =>
            toHex0x(method.entrypoint) === toHex0x(call.entrypoint),
        )?.[0],
    );
  const chainEntry = (from: string, to: string, kind: bigint, state: bigint) =>
    ({
      from: addressFromBase58(from),
      to: addressFromBase58(to),
      amount: 5n,
      kind,
      state,
    }) as never;
  const entryView = (value: unknown) =>
    vi.spyOn(app.entry, "view").mockResolvedValue({ value } as never);

  it("allows exactly the amount and sends in one atomic batch", async () => {
    const owner = accountFor(session).address;
    const operation = operationId();
    const view = entryView(chainEntry(owner, peer, 0n, 1n));
    await execute({
      action: "send",
      recipient: peer,
      amount: "5",
      id: "",
      operation,
    });
    expect(batch()).toEqual(["adjustAllowance", "send"]);
    expect(transact.mock.calls[0]![4]).toBe(`${operation}:send`);
    const { args } = view.mock.calls[0]![0] as never as {
      args: { from: Uint8Array; operation: Uint8Array };
    };
    expect(toBase58(args.from)).toBe(owner);
    expect(toHex0x(args.operation)).toBe(operation);
  });

  it("creates a request without an allowance", async () => {
    entryView(chainEntry(accountFor(session).address, peer, 1n, 0n));
    await execute({
      action: "request",
      recipient: peer,
      amount: "5",
      id: "",
      operation: operationId(),
    });
    expect(batch()).toEqual(["request"]);
  });

  it("approves the request named by its row ID with an exact allowance", async () => {
    const requestOperation = operationId();
    const view = entryView(
      chainEntry(peer, accountFor(session).address, 1n, 1n),
    );
    await execute({
      action: "approve",
      recipient: peer,
      amount: "5",
      id: entryId(peer, requestOperation),
      operation: operationId(),
    });
    expect(batch()).toEqual(["adjustAllowance", "approve"]);
    const { args } = view.mock.calls[0]![0] as never as {
      args: { from: Uint8Array; operation: Uint8Array };
    };
    expect(toBase58(args.from)).toBe(peer);
    expect(args.operation).toEqual(fixedBytes(fromHex0x(requestOperation), 32));
  });

  it("declines without an allowance", async () => {
    entryView(chainEntry(peer, accountFor(session).address, 1n, 2n));
    await execute({
      action: "decline",
      recipient: peer,
      amount: "5",
      id: entryId(peer, operationId()),
      operation: operationId(),
    });
    expect(batch()).toEqual(["decline"]);
  });

  it("reports a pending result until the expected entry is visible", async () => {
    entryView(null);
    await expect(
      execute({
        action: "send",
        recipient: peer,
        amount: "5",
        id: "",
        operation: operationId(),
      }),
    ).rejects.toBeInstanceOf(ResultPending);
    entryView(chainEntry(peer, accountFor(session).address, 1n, 0n));
    await expect(
      execute({
        action: "approve",
        recipient: peer,
        amount: "5",
        id: entryId(peer, operationId()),
        operation: operationId(),
      }),
    ).rejects.toBeInstanceOf(ResultPending);
  });
});
