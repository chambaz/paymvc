import {
  BaseError,
  ContractFunctionRevertedError,
  encodeFunctionData,
  erc20Abi,
  formatEther,
  isAddress,
  keccak256,
  maxUint256,
  parseEther,
  parseSignature,
  type Address,
  type Hex,
} from "viem";
import { chainFor, publicClient, type Deployment } from "./config";
import { creditsAbi } from "./generated/creditsAbi";
import { paymvcAbi } from "./generated/paymvcAbi";
import { networkFor } from "../networks";
import {
  accountFor,
  parseAmount,
  validateOperation,
  type Session,
  type Intent,
} from "./session";
import { transact, ResultPending, type Progress } from "./transactions";

/** The Kind and State enums in contracts/PayMVC.sol. */
export const Kind = { Transfer: 0, Request: 1 } as const;
export const State = { Pending: 0, Paid: 1, Declined: 2 } as const;

/** An entry's stable ID: its creator and operation ID, as "from:operation". */
export function entryId(from: Address, operation: Hex) {
  return `${from.toLowerCase()}:${operation.toLowerCase()}`;
}
function parseEntryId(id: string) {
  const [from, operation] = id.split(":") as [Address, Hex];
  return { from, operation };
}

export class FundingRequired extends Error {
  constructor(
    public address: Address,
    required: bigint,
    symbol = "ETH",
  ) {
    super(
      `Fund this wallet with at least ${formatEther(required)} testnet ${symbol}, then check funding again.`,
    );
  }
}

export async function fundingBudget(config: Deployment, address: Address) {
  const client = publicClient(config);
  const [fees, balance] = await Promise.all([
    client.estimateFeesPerGas(),
    client.getBalance({ address }),
  ]);
  // The gas for registration and the four payments of the shared scenario, with a margin.
  const { fundingGas, fundingMinimum } = networkFor(config.chainId);
  const estimated = fees.maxFeePerGas * fundingGas;
  const minimum = parseEther(fundingMinimum);
  return { required: estimated > minimum ? estimated : minimum, balance };
}

export async function verifyDeployment(config: Deployment) {
  const client = publicClient(config);
  const [chain, code, token] = await Promise.all([
    client.getChainId(),
    client.getCode({ address: config.address }),
    client.readContract({
      address: config.address,
      abi: paymvcAbi,
      functionName: "token",
    }),
  ]);
  if (
    chain !== config.chainId ||
    !code ||
    keccak256(code) !== config.codeHash ||
    token.toLowerCase() !== config.token.toLowerCase()
  )
    throw new Error(
      "Deployment verification failed. Check the network configuration before starting.",
    );
}

/** Reads the entry `(from, operation)`. Returns undefined when the contract reverts with NotFound. */
export async function readEntry(
  config: Deployment,
  from: Address,
  operation: Hex,
) {
  try {
    return await publicClient(config).readContract({
      address: config.address,
      abi: paymvcAbi,
      functionName: "entry",
      args: [from, operation],
    });
  } catch (error) {
    const notFound =
      error instanceof BaseError &&
      error.walk(
        (cause) =>
          cause instanceof ContractFunctionRevertedError &&
          cause.data?.errorName === "NotFound",
      );
    if (notFound) return undefined;
    throw error;
  }
}

export function payments(
  config: Deployment,
  session: Session,
  persist: () => void,
  progress: Progress,
) {
  const client = publicClient(config);
  const account = accountFor(session);
  const owner = account.address;
  /** A saved transaction is never signed again, so `build` runs only for a new one. */
  const tx = async (label: string, build: () => Hex | Promise<Hex>) =>
    transact(
      config,
      session,
      persist,
      progress,
      label,
      config.address,
      session.journal[label] ? "0x" : await build(),
    );
  async function checkBalance(amount: bigint, operation: Hex) {
    if (session.journal[operation]) return;
    const balance = await client.readContract({
      address: config.token,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [owner],
    });
    if (balance < amount)
      throw new Error("Not enough demo credits. No payment was completed.");
  }
  /** Signs an EIP-2612 permit for the app to take exactly `amount` in the next payment. */
  async function permit(amount: bigint) {
    const [nonce, [, name, version]] = await Promise.all([
      client.readContract({
        address: config.token,
        abi: creditsAbi,
        functionName: "nonces",
        args: [owner],
      }),
      client.readContract({
        address: config.token,
        abi: creditsAbi,
        functionName: "eip712Domain",
      }),
    ]);
    // EVM transactions do not expire, so the permit does not either. Its nonce makes it single-use.
    const deadline = maxUint256;
    const signature = await account.signTypedData({
      domain: {
        name,
        version,
        chainId: config.chainId,
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
        value: amount,
        nonce,
        deadline,
      },
    });
    const { r, s, yParity } = parseSignature(signature);
    return [deadline, yParity + 27, r, s] as const;
  }
  async function execute(intent: Intent) {
    await verifyDeployment(config);
    validateOperation(intent.operation);
    const amount = parseAmount(intent.amount);
    if (!isAddress(intent.recipient))
      throw new Error("Choose a registered account.");
    const mismatch = () =>
      new Error("The saved operation does not match its on-chain record.");
    if (intent.action === "send" || intent.action === "request") {
      const { operation, recipient } = intent;
      let entry = await readEntry(config, owner, operation);
      if (!entry) {
        if (intent.action === "send") await checkBalance(amount, operation);
        await tx(operation, async () =>
          intent.action === "send"
            ? encodeFunctionData({
                abi: paymvcAbi,
                functionName: "send",
                args: [recipient, amount, operation, ...(await permit(amount))],
              })
            : encodeFunctionData({
                abi: paymvcAbi,
                functionName: "request",
                args: [recipient, amount, operation],
              }),
        );
        entry = await readEntry(config, owner, operation);
        if (!entry) throw new ResultPending();
      } else if (session.journal[operation]) await tx(operation, () => "0x");
      if (
        entry.to.toLowerCase() !== recipient.toLowerCase() ||
        entry.amount !== amount ||
        entry.kind !== (intent.action === "send" ? Kind.Transfer : Kind.Request)
      )
        throw mismatch();
    } else {
      const { from, operation } = parseEntryId(intent.id);
      const entry = await readEntry(config, from, operation);
      if (
        !entry ||
        entry.kind !== Kind.Request ||
        entry.to.toLowerCase() !== owner.toLowerCase() ||
        entry.from.toLowerCase() !== intent.recipient.toLowerCase() ||
        entry.amount !== amount
      )
        throw mismatch();
      const expected =
        intent.action === "approve" ? State.Paid : State.Declined;
      if (entry.state !== State.Pending && entry.state !== expected)
        throw new Error(
          "This request has already been resolved. Refresh its status.",
        );
      if (entry.state === expected) {
        if (session.journal[intent.operation])
          await tx(intent.operation, () => "0x");
        return;
      }
      if (intent.action === "approve")
        await checkBalance(amount, intent.operation);
      await tx(intent.operation, async () =>
        intent.action === "approve"
          ? encodeFunctionData({
              abi: paymvcAbi,
              functionName: "approve",
              args: [from, operation, ...(await permit(amount))],
            })
          : encodeFunctionData({
              abi: paymvcAbi,
              functionName: "decline",
              args: [from, operation],
            }),
      );
      if ((await readEntry(config, from, operation))?.state !== expected)
        throw new ResultPending();
    }
  }
  async function setup() {
    await verifyDeployment(config);
    const read = () =>
      client.readContract({
        address: config.address,
        abi: paymvcAbi,
        functionName: "registered",
        args: [owner],
      });
    if (session.journal.register || !(await read())) {
      progress("Checking testnet funding");
      const { required, balance } = await fundingBudget(config, owner);
      if (!session.journal.register && balance < required)
        throw new FundingRequired(
          owner,
          required,
          chainFor(config).nativeCurrency.symbol,
        );
      progress("Registering your wallet");
      await tx("register", () =>
        encodeFunctionData({ abi: paymvcAbi, functionName: "register" }),
      );
    }
    if (!(await read())) throw new ResultPending();
    // Membership, directory insertion and allocation are one atomic contract operation.
    session.ready = true;
    persist();
    progress("");
  }
  return { setup, execute };
}

export async function readContacts(
  config: Deployment,
  session: Session,
  start: bigint,
) {
  const client = publicClient(config);
  const blockNumber = await client.getBlockNumber({ cacheTime: 0 });
  const count = await client.readContract({
    address: config.address,
    abi: paymvcAbi,
    functionName: "profileCount",
    blockNumber,
  });
  const page = await client.readContract({
    address: config.address,
    abi: paymvcAbi,
    functionName: "profiles",
    args: [start, 5n],
    blockNumber,
  });
  const owner = accountFor(session).address.toLowerCase();
  let next = start + BigInt(page.length);
  const addresses = page.filter((address) => address.toLowerCase() !== owner);
  // At most one self entry exists. One bounded read fills its place without skipping a user.
  if (addresses.length < page.length && next < count) {
    const extra = await client.readContract({
      address: config.address,
      abi: paymvcAbi,
      functionName: "profiles",
      args: [next, 1n],
      blockNumber,
    });
    addresses.push(...extra);
    next += BigInt(extra.length);
  }
  return { addresses, next: next < count ? next : undefined };
}

/** Reads the balance and the newest `limit` entries at one block. */
export async function readDashboard(
  config: Deployment,
  session: Session,
  limit: number,
) {
  const client = publicClient(config);
  const owner = accountFor(session).address;
  const blockNumber = await client.getBlockNumber({ cacheTime: 0 });
  const [balance, count] = await Promise.all([
    client.readContract({
      address: config.token,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [owner],
      blockNumber,
    }),
    client.readContract({
      address: config.address,
      abi: paymvcAbi,
      functionName: "activityCount",
      args: [owner],
      blockNumber,
    }),
  ]);
  const shown = count < BigInt(limit) ? count : BigInt(limit);
  // Each page starts below an absolute history index, so pages never overlap.
  const pages = await Promise.all(
    Array.from({ length: Math.ceil(Number(shown) / 50) }, (_, page) =>
      client.readContract({
        address: config.address,
        abi: paymvcAbi,
        functionName: "activity",
        args: [owner, count - BigInt(page * 50), 50n],
        blockNumber,
      }),
    ),
  );
  const entries = pages
    .flat()
    .map((entry) => ({ ...entry, id: entryId(entry.from, entry.operation) }));
  return { balance, count, entries, blockNumber };
}
export type Dashboard = Awaited<ReturnType<typeof readDashboard>>;
export type ActivityEntry = Dashboard["entries"][number];
