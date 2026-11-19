import {
  addressFromBase58,
  fixedBytes,
  fromHex0x,
  gasAmount,
  toBase58,
  toHex0x,
  type Invocation,
} from "@thruputchain/client";
import { ERC20, ERC20Metadata } from "./generated/credits";
import { PayMVC, type paymvc } from "./generated/paymvc";
import {
  clientFor,
  formatNative,
  normalizeAddress,
  type Deployment,
  waitForHeight,
} from "./config";
import {
  accountFor,
  confirmedHeight,
  parseAmount,
  type Intent,
  type Session,
} from "./session";
import { ResultPending, transact } from "./transactions";

const app = PayMVC.v0_1;
const token = ERC20.v0_1;
/** Gas for one PayMVC call, including its call into the token. */
const CALL_GAS = gasAmount(8_000_000n);
/** Gas for one token allowance change. */
const ALLOWANCE_GAS = gasAmount(2_000_000n);
/** Native-token base units a new wallet needs before registration: 10 native tokens. */
const FUNDING_REQUIRED = 100_000_000n;
/** The contract's largest `activity` page. A page must fit the runtime's return buffer. */
const ACTIVITY_PAGE = 5n;
/** Six profiles fill five contacts even when one is the owner. */
const PROFILE_PAGE = 6n;
/** The RPC accepts at most 16 views in one batch. */
const MAX_VIEWS = 16;

export class FundingRequired extends Error {
  constructor(c: Deployment) {
    super(
      `Fund this wallet with at least ${formatNative(c, FUNDING_REQUIRED)} native tokens, then start your demo.`,
    );
  }
}

/** The stable row ID of an entry: its key `(from, operation)`. */
export const entryId = (from: string, operation: string) =>
  `${from}:${operation}`;
function parseEntryId(id: string) {
  const [from, operation] = id.split(":");
  return {
    from: addressFromBase58(normalizeAddress(from ?? "")),
    operation: fixedBytes(fromHex0x(operation ?? ""), 32),
  };
}

/**
 * Check the network, both contracts' code hashes, the token that PayMVC
 * uses, and the token's zero decimals. Futurenet can reset, so this runs
 * before every read and write.
 */
export async function verifyDeployment(c: Deployment) {
  const client = await clientFor(c);
  const address = addressFromBase58(c.address);
  const credits = addressFromBase58(c.credits);
  const [network, paymvcCode, creditsCode, { results }] = await Promise.all([
    client.getNetworkInfo(),
    client.getContractDeployment({ address }),
    client.getContractDeployment({ address: credits }),
    client.readViews({
      calls: [
        app.credits.viewRequest({ address }),
        ERC20Metadata.v0_1.decimals.viewRequest({ address: credits }),
      ],
    }),
  ]);
  if (toBase58(network.networkHash) !== c.networkHash)
    throw new Error(
      "The network changed. This saved deployment cannot be used.",
    );
  const [boundToken, decimals] = results;
  if (
    paymvcCode.deployment?.hash === undefined ||
    toBase58(paymvcCode.deployment.hash) !== c.contractHash ||
    boundToken!.kind !== "return" ||
    toBase58(boundToken!.value) !== c.credits
  )
    throw new Error("The PayMVC contract was not found at the saved address.");
  if (
    creditsCode.deployment?.hash === undefined ||
    toBase58(creditsCode.deployment.hash) !== c.creditsHash ||
    decimals!.kind !== "return" ||
    decimals!.value !== 0n
  )
    throw new Error("The credits token does not match this deployment.");
  return client;
}

export async function fundingBudget(c: Deployment, owner: string) {
  const client = await verifyDeployment(c);
  const balance = await client.getBalance({
    address: addressFromBase58(owner),
  });
  return { balance: balance.rawBalance, required: FUNDING_REQUIRED };
}

export async function readContacts(c: Deployment, s: Session, start: bigint) {
  const client = await verifyDeployment(c);
  const address = addressFromBase58(c.address);
  const owner = accountFor(s).address;
  const { results } = await client.readViews({
    calls: [
      app.profileCount.viewRequest({ address }),
      app.profiles.viewRequest({
        address,
        args: { start, limit: PROFILE_PAGE },
      }),
    ],
  });
  const [count, page] = results;
  if (count!.kind !== "return" || page!.kind !== "return")
    throw new Error("Contacts are unavailable.");
  // The page holds six entries, so it fills five contacts even when one is
  // the owner. The owner's entry is consumed wherever it appears; the loop
  // stops at the first contact that does not fit. This never skips a contact
  // and never leaves only the owner for the next page.
  const addresses: string[] = [];
  let next = start;
  for (const entry of page!.value) {
    const text = toBase58(entry);
    if (text !== owner) {
      if (addresses.length === 5) break;
      addresses.push(text);
    }
    next++;
  }
  return { addresses, next: next < count!.value ? next : undefined };
}

type ChainEntry = paymvc.v0_1.implementation.Entry;
function displayEntry(entry: ChainEntry) {
  const from = toBase58(entry.from);
  const operation = toHex0x(entry.operation);
  return {
    id: entryId(from, operation),
    from,
    to: toBase58(entry.to),
    operation,
    amount: entry.amount,
    kind: Number(entry.kind),
    state: Number(entry.state),
  };
}
export type DisplayEntry = ReturnType<typeof displayEntry>;

/**
 * Read the balance and the newest `limit` activity entries. `before` is an
 * absolute history index, so a new entry never shifts a later page.
 */
export async function readDashboard(c: Deployment, s: Session, limit = 50) {
  const client = await verifyDeployment(c);
  const address = addressFromBase58(c.address);
  const owner = addressFromBase58(accountFor(s).address);
  const head = await waitForHeight(() =>
    client.readViews({
      minStateBlockHeight: confirmedHeight(s),
      calls: [
        token.getBalanceOf.viewRequest({
          address: addressFromBase58(c.credits),
          args: { addr: owner },
        }),
        app.activityCount.viewRequest({ address, args: { account: owner } }),
      ],
    }),
  );
  const [balance, count] = head.results;
  if (balance!.kind !== "return" || count!.kind !== "return")
    throw new Error("Account reads are unavailable.");
  const pages = [];
  let before = count!.value;
  let remaining = BigInt(limit);
  while (before > 0n && remaining > 0n) {
    const size = remaining < ACTIVITY_PAGE ? remaining : ACTIVITY_PAGE;
    pages.push(
      app.activity.viewRequest({
        address,
        args: { account: owner, before, limit: size },
      }),
    );
    before = before > size ? before - size : 0n;
    remaining -= size;
  }
  const entries: DisplayEntry[] = [];
  for (let i = 0; i < pages.length; i += MAX_VIEWS) {
    const calls = pages.slice(i, i + MAX_VIEWS);
    const { results } = await waitForHeight(() =>
      client.readViews({ minStateBlockHeight: head.stateBlockHeight, calls }),
    );
    for (const page of results) {
      if (page.kind !== "return") throw new Error("Activity is unavailable.");
      entries.push(...page.value.map(displayEntry));
    }
  }
  return { balance: balance!.value, count: count!.value, entries };
}

export function payments(
  c: Deployment,
  s: Session,
  persist: () => void,
  progress: (message: string) => void,
) {
  const address = addressFromBase58(c.address);
  const credits = addressFromBase58(c.credits);
  const owner = addressFromBase58(accountFor(s).address);
  /** Allow PayMVC to move exactly `amount` of this wallet's credits. */
  const allow = (amount: bigint) =>
    token.adjustAllowance.invocation(credits, ALLOWANCE_GAS, {
      spender: address,
      difference: amount,
    });
  return {
    async setup() {
      const client = await verifyDeployment(c);
      const isRegistered = async (minStateBlockHeight: bigint) =>
        (
          await waitForHeight(() =>
            app.registered.view({
              client,
              address,
              args: { account: owner },
              minStateBlockHeight,
            }),
          )
        ).value;
      // Only a new registration needs funds. A saved one is reconciled first,
      // whatever the current balance is.
      if (!s.journal.registration) {
        const budget = await fundingBudget(c, accountFor(s).address);
        if (budget.balance < budget.required) throw new FundingRequired(c);
      }
      await transact(
        c,
        s,
        persist,
        progress,
        "registration",
        client,
        [app.register.invocation(address, CALL_GAS)],
        async (height) => !(await isRegistered(height)),
      );
      if (!(await isRegistered(confirmedHeight(s)))) throw new ResultPending();
      s.ready = true;
      persist();
    },
    async execute(intent: Intent) {
      const client = await verifyDeployment(c);
      const amount = parseAmount(intent.amount);
      const recipient = addressFromBase58(normalizeAddress(intent.recipient));
      const creating = intent.action === "send" || intent.action === "request";
      // A new entry is keyed by this wallet and the intent's operation. A
      // resolution targets the request named by the intent's row ID.
      const key = creating
        ? {
            from: owner,
            operation: fixedBytes(fromHex0x(intent.operation), 32),
          }
        : parseEntryId(intent.id);
      // A payment allows PayMVC to move exactly its amount, in the same
      // atomic wallet transaction.
      const calls: Invocation[] =
        intent.action === "send"
          ? [
              allow(amount),
              app.send.invocation(address, CALL_GAS, {
                to: recipient,
                amount,
                operation: key.operation,
              }),
            ]
          : intent.action === "request"
            ? [
                app.request.invocation(address, CALL_GAS, {
                  payer: recipient,
                  amount,
                  operation: key.operation,
                }),
              ]
            : intent.action === "approve"
              ? [allow(amount), app.approve.invocation(address, CALL_GAS, key)]
              : [app.decline.invocation(address, CALL_GAS, key)];
      const entry = async (minStateBlockHeight: bigint) =>
        (
          await waitForHeight(() =>
            app.entry.view({
              client,
              address,
              args: key,
              minStateBlockHeight,
            }),
          )
        ).value;
      // A send or request is absent while its key has no entry. An approval
      // or decline is absent while the request is still pending.
      await transact(
        c,
        s,
        persist,
        progress,
        `${intent.operation}:${intent.action}`,
        client,
        calls,
        async (height) => {
          const value = await entry(height);
          return creating ? value === null : value?.state === 0n;
        },
      );
      const value = await entry(confirmedHeight(s));
      const self = accountFor(s).address;
      if (
        !value ||
        value.amount !== amount ||
        toBase58(creating ? value.from : value.to) !== self ||
        toBase58(creating ? value.to : value.from) !== intent.recipient ||
        (intent.action === "send" &&
          (value.kind !== 0n || value.state !== 1n)) ||
        (intent.action === "request" && value.kind !== 1n) ||
        (intent.action === "approve" && value.state !== 1n) ||
        (intent.action === "decline" && value.state !== 2n)
      )
        throw new ResultPending();
    },
  };
}
