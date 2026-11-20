import { beforeEach, expect, it, vi } from "vitest";
import {
  ContractFunctionRevertedError,
  decodeFunctionData,
  encodeErrorResult,
  keccak256,
  maxUint256,
  recoverTypedDataAddress,
  serializeSignature,
  type Hex,
} from "viem";
import { parseDeployment } from "../../src/chain/config";
import { paymvcAbi } from "../../src/chain/generated/paymvcAbi";
import { entryId, Kind, payments, State } from "../../src/chain/payments";
import {
  accountFor,
  newSession,
  operationId,
  validateOperation,
  type Intent,
} from "../../src/chain/session";

const mocks = vi.hoisted(() => ({ read: vi.fn(), transact: vi.fn() }));
vi.mock("../../src/chain/config", async (original) => ({
  ...(await original<typeof import("../../src/chain/config")>()),
  publicClient: () => ({
    getChainId: async () => 31337,
    getCode: async () => "0x1234",
    readContract: mocks.read,
  }),
}));
vi.mock("../../src/chain/transactions", async (original) => ({
  ...(await original<typeof import("../../src/chain/transactions")>()),
  transact: mocks.transact,
}));
const config = parseDeployment({
  chainId: 31337,
  rpcUrl: "http://127.0.0.1:8545",
  address: `0x${"1".repeat(40)}`,
  token: `0x${"2".repeat(40)}`,
  codeHash: keccak256("0x1234"),
  deploymentBlock: "1",
  faucetUrl: "https://example.com",
});
const session = newSession(config);
const owner = accountFor(session).address;
const intent: Intent = {
  action: "send",
  recipient: accountFor(newSession(config)).address,
  amount: "7",
  id: "",
  operation: operationId(),
};
const notFound = new ContractFunctionRevertedError({
  abi: paymvcAbi,
  data: encodeErrorResult({ abi: paymvcAbi, errorName: "NotFound" }),
  functionName: "entry",
});
let entry:
  | {
      from: string;
      to: string;
      operation: Hex;
      amount: bigint;
      kind: number;
      state: number;
    }
  | undefined;
const run = (next: Intent = intent) =>
  payments(
    config,
    session,
    () => {},
    () => {},
  ).execute(next);
/** The calldata of the transaction that `execute` asked to sign. */
const signed = () =>
  decodeFunctionData({
    abi: paymvcAbi,
    data: mocks.transact.mock.calls[0]![6] as Hex,
  });
beforeEach(() => {
  vi.resetAllMocks();
  session.journal = {};
  entry = {
    from: owner,
    to: intent.recipient,
    operation: intent.operation,
    amount: 7n,
    kind: Kind.Transfer,
    state: State.Paid,
  };
  mocks.read.mockImplementation(async ({ functionName }) => {
    if (functionName === "token") return config.token;
    if (functionName === "decimals") return 0;
    if (functionName === "entry") {
      if (!entry) throw notFound;
      return entry;
    }
    if (functionName === "balanceOf") return 100n;
    if (functionName === "nonces") return 4n;
    if (functionName === "eip712Domain")
      return ["0x0f", "PayMVC Demo Credits", "1", 31337n, config.token];
    throw new Error(`Unexpected read: ${functionName}`);
  });
});
it("reconciles the saved transaction and verifies the existing entry", async () => {
  session.journal[intent.operation] = {
    raw: "0x1234",
    hash: keccak256("0x1234"),
    confirmed: false,
  };
  await run();
  expect(mocks.transact).toHaveBeenCalledTimes(1);
  expect(mocks.read).toHaveBeenCalledWith(
    expect.objectContaining({
      functionName: "entry",
      args: [owner, intent.operation],
    }),
  );
});
it.each(["to", "amount", "kind"] as const)(
  "rejects a mismatched %s on an existing entry",
  async (field) => {
    if (field === "amount") entry!.amount = 8n;
    else if (field === "kind") entry!.kind = Kind.Request;
    else entry!.to = `0x${"9".repeat(40)}`;
    await expect(run()).rejects.toThrow("does not match");
  },
);
it("signs one send with a permit for exactly this payment", async () => {
  const created = entry;
  entry = undefined;
  mocks.transact.mockImplementation(async () => {
    entry = created;
  });
  await run();
  expect(mocks.transact).toHaveBeenCalledTimes(1);
  const { functionName, args } = signed();
  expect(functionName).toBe("send");
  const [to, amount, operation, deadline, v, r, s] = args as [
    string,
    bigint,
    Hex,
    bigint,
    number,
    Hex,
    Hex,
  ];
  expect([to, amount, operation]).toEqual([
    intent.recipient,
    7n,
    intent.operation,
  ]);
  expect(deadline).toBe(maxUint256);
  const signer = await recoverTypedDataAddress({
    domain: {
      name: "PayMVC Demo Credits",
      version: "1",
      chainId: 31337,
      verifyingContract: config.token,
    },
    types: {
      Permit: [
        { name: "owner", type: "address" },
        { name: "spender", type: "address" },
        { name: "value", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "Permit",
    message: {
      owner,
      spender: config.address,
      value: 7n,
      nonce: 4n,
      deadline,
    },
    signature: serializeSignature({ r, s, v: BigInt(v) }),
  });
  expect(signer).toBe(owner);
});
it("never signs a new permit for a saved transaction", async () => {
  session.journal[intent.operation] = {
    raw: "0x1234",
    hash: keccak256("0x1234"),
    confirmed: false,
  };
  const created = entry;
  entry = undefined;
  mocks.transact.mockImplementation(async () => {
    entry = created;
  });
  await run();
  expect(mocks.transact.mock.calls[0]![6]).toBe("0x");
  expect(mocks.read).not.toHaveBeenCalledWith(
    expect.objectContaining({ functionName: "nonces" }),
  );
});
it("reports a pending result when the entry is not visible yet", async () => {
  entry = undefined;
  await expect(run()).rejects.toThrow("still updating");
});
it("approves a request by its creator and operation ID", async () => {
  const requester = intent.recipient;
  const request = operationId();
  entry = {
    from: requester,
    to: owner,
    operation: request,
    amount: 7n,
    kind: Kind.Request,
    state: State.Pending,
  };
  mocks.transact.mockImplementation(async () => {
    entry!.state = State.Paid;
  });
  await run({
    ...intent,
    action: "approve",
    id: entryId(requester, request),
  });
  const { functionName, args } = signed();
  expect(functionName).toBe("approve");
  expect(args.slice(0, 2)).toEqual([requester, request]);
  expect(mocks.read).toHaveBeenCalledWith(
    expect.objectContaining({
      functionName: "entry",
      args: [requester.toLowerCase(), request],
    }),
  );
});
it("declines without a permit or a balance check", async () => {
  const request = operationId();
  entry = {
    from: intent.recipient,
    to: owner,
    operation: request,
    amount: 7n,
    kind: Kind.Request,
    state: State.Pending,
  };
  mocks.transact.mockImplementation(async () => {
    entry!.state = State.Declined;
  });
  await run({
    ...intent,
    action: "decline",
    id: entryId(intent.recipient, request),
  });
  expect(signed().functionName).toBe("decline");
  for (const functionName of ["nonces", "balanceOf"])
    expect(mocks.read).not.toHaveBeenCalledWith(
      expect.objectContaining({ functionName }),
    );
});
it("uses nonzero operation IDs without changing saved ID generation", () => {
  expect(() => validateOperation(`0x${"0".repeat(64)}`)).toThrow("nonzero");
  expect(() => validateOperation(operationId())).not.toThrow();
});
