import { bcs } from "@mysten/sui/bcs";
import {
  Transaction,
  type TransactionArgument,
  type TransactionResult,
} from "@mysten/sui/transactions";
import { fromHex, toHex } from "@mysten/sui/utils";
import { server, coinType, type Deployment } from "./config";
import {
  accountFor,
  entryId,
  parseAmount,
  validateOperation,
  type Session,
  type Intent,
} from "./session";
import { transact, ResultPending } from "./transactions";

const entrySchema = bcs.struct("Entry", {
  from: bcs.Address,
  to: bcs.Address,
  operation: bcs.byteVector(),
  amount: bcs.u64(),
  kind: bcs.enum("Kind", { Transfer: null, Request: null }),
  state: bcs.enum("State", { Pending: null, Paid: null, Declined: null }),
});
export type Entry = ReturnType<typeof toEntry>;
const toEntry = (e: typeof entrySchema.$inferType) => ({
  id: entryId(e.from, toHex(e.operation)),
  from: e.from,
  to: e.to,
  operation: toHex(e.operation),
  amount: BigInt(e.amount),
  kind: e.kind.$kind,
  state: e.state.$kind,
});
const PAGE_LIMIT = 50;
type Read = (name: string, ...args: TransactionArgument[]) => TransactionResult;

/**
 * Call the contract's read-only functions in one simulated transaction. Nothing
 * is signed or sent. The node runs every call against the same state, so a
 * count and its rows always agree. `reads` returns the calls whose BCS results
 * are wanted; their order is the order of the returned values.
 */
async function view(
  c: Deployment,
  reads: (read: Read, tx: Transaction) => TransactionResult[],
) {
  const tx = new Transaction();
  const read: Read = (name, ...args) =>
    tx.moveCall({
      target: `${c.package}::paymvc::${name}`,
      typeArguments: [coinType(c)],
      arguments: [tx.object(c.app), ...args],
    });
  const wanted = reads(read, tx);
  // Without checks, the node uses mocked gas, so an unfunded wallet can read.
  const result = await server(c).simulateTransaction({
    transaction: tx,
    include: { commandResults: true },
    checksEnabled: false,
  });
  if (result.$kind === "FailedTransaction")
    throw new Error("Could not read the application state.");
  return wanted.map(
    (call) => result.commandResults[call.Result]!.returnValues[0]!.bcs,
  );
}
const registered = async (c: Deployment, ...accounts: string[]) =>
  (
    await view(c, (read, tx) =>
      accounts.map((account) => read("registered", tx.pure.address(account))),
    )
  )
    .map((value) => bcs.bool().parse(value))
    .every(Boolean);
async function readEntry(c: Deployment, from: string, operation: string) {
  const [value] = await view(c, (read, tx) => [
    read(
      "entry",
      tx.pure.address(from),
      tx.pure.vector("u8", fromHex(operation)),
    ),
  ]);
  const found = bcs.option(entrySchema).parse(value!);
  return found ? toEntry(found) : null;
}

export class FundingRequired extends Error {
  constructor() {
    super(
      "Fund this wallet with testnet SUI for registration and transaction fees, then retry.",
    );
  }
}
export async function fundingBudget(c: Deployment, owner: string) {
  const { balance } = await server(c).getBalance({ owner });
  return { balance: BigInt(balance.balance), required: 100_000_000n };
}
/** Deployments that passed verification in this page. The package cannot change. */
const verified = new Set<string>();

/**
 * Checks the network, the package bytes (its digest), and the shared `App` object. Every
 * Sui package object is immutable; whether a package can be upgraded depends on its
 * `UpgradeCap`. The deploy script destroys the cap in the publish transaction
 * (`immutableDigest`). Public nodes keep about two weeks of history, so the browser cannot
 * re-check that transaction later; anyone can audit it on an explorer.
 */
export async function verifyDeployment(c: Deployment) {
  if (verified.has(c.app)) return;
  const client = server(c);
  const [chain, pkg, app] = await Promise.all([
    client.getChainIdentifier(),
    client.getObject({ objectId: c.package }),
    client.getObject({ objectId: c.app }),
  ]);
  if (
    chain.chainIdentifier !== c.chainIdentifier ||
    pkg.object.digest !== c.packageDigest ||
    app.object.type !== `${c.package}::paymvc::App<${coinType(c)}>` ||
    app.object.owner.$kind !== "Shared"
  ) {
    throw new Error(
      "Deployment verification failed. Check the network and application configuration.",
    );
  }
  verified.add(c.app);
}
export async function readContacts(c: Deployment, s: Session, start: bigint) {
  const owner = accountFor(s).address;
  // One extra address covers the case where the page contains the owner.
  const [count, page] = await view(c, (read, tx) => [
    read("profile_count"),
    read("profiles", tx.pure.u64(start), tx.pure.u64(6)),
  ]);
  const total = BigInt(bcs.u64().parse(count!));
  let cursor = start;
  const addresses: string[] = [];
  for (const value of bcs.vector(bcs.Address).parse(page!)) {
    if (addresses.length === 5) break;
    cursor++;
    if (value !== owner) addresses.push(value);
  }
  return { addresses, next: cursor < total ? cursor : undefined };
}
export async function readDashboard(c: Deployment, s: Session, limit = 50) {
  const owner = accountFor(s).address;
  const [[member, count, ...pages], { balance }] = await Promise.all([
    view(c, (read, tx) => {
      const account = tx.pure.address(owner);
      const count = read("activity_count", account);
      // Each page starts at an absolute history index, so pages never overlap.
      // Page n reads before `count - 50n`, computed on chain from the same count.
      const pages: TransactionResult[] = [];
      for (let offset = 0; offset < limit; offset += PAGE_LIMIT) {
        const before =
          offset === 0
            ? count
            : tx.moveCall({
                target: "0x1::u64::saturating_sub",
                arguments: [count, tx.pure.u64(offset)],
              });
        pages.push(
          read(
            "activity",
            account,
            before,
            tx.pure.u64(Math.min(PAGE_LIMIT, limit - offset)),
          ),
        );
      }
      return [read("registered", account), count, ...pages];
    }),
    server(c).getBalance({ owner, coinType: coinType(c) }),
  ]);
  if (!bcs.bool().parse(member!))
    throw new Error("This wallet is not registered in this deployment.");
  return {
    balance: BigInt(balance.balance),
    count: BigInt(bcs.u64().parse(count!)),
    entries: pages
      .flatMap((page) => bcs.vector(entrySchema).parse(page))
      .map(toEntry),
  };
}
export async function paymentCoin(
  c: Deployment,
  tx: Transaction,
  owner: string,
  amount: bigint,
) {
  const { balance } = await server(c).getBalance({
    owner,
    coinType: coinType(c),
  });
  if (BigInt(balance.balance) < amount)
    throw new Error("Not enough demo credits.");
  const available = BigInt(balance.addressBalance);
  const withdrawalAmount = available < amount ? available : amount;
  const withdrawal =
    withdrawalAmount > 0n
      ? tx.moveCall({
          target: "0x2::coin::redeem_funds",
          typeArguments: [coinType(c)],
          arguments: [
            tx.withdrawal({ type: coinType(c), amount: withdrawalAmount }),
          ],
        })
      : undefined;
  if (withdrawalAmount === amount) return withdrawal!;
  let cursor: string | null | undefined;
  let total = withdrawalAmount;
  const ids: string[] = [];
  do {
    const page = await server(c).listCoins({
      owner,
      coinType: coinType(c),
      limit: 50,
      cursor,
    });
    for (const coin of page.objects) {
      ids.push(coin.objectId);
      total += BigInt(coin.balance);
      if (total >= amount) break;
    }
    cursor = page.hasNextPage ? page.cursor : null;
  } while (total < amount && cursor && ids.length < 200);
  if (total < amount)
    throw new Error(
      cursor
        ? "Too many small credit coins. Consolidate them before retrying."
        : "Not enough demo credits.",
    );
  const first = tx.object(ids[0]!);
  if (withdrawal) tx.mergeCoins(first, [withdrawal]);
  if (ids.length > 1)
    tx.mergeCoins(
      first,
      ids.slice(1).map((id) => tx.object(id)),
    );
  return tx.splitCoins(first, [tx.pure.u64(amount)])[0];
}
export function payments(
  c: Deployment,
  s: Session,
  persist: () => void,
  progress: (value: string) => void,
) {
  const owner = accountFor(s).address;
  /** The chain shows the effect of a saved transaction, so it is confirmed. */
  const confirmSaved = (label: string) => {
    const record = s.journal[label];
    if (record && !record.confirmed) {
      record.confirmed = true;
      persist();
    }
  };
  return {
    async setup() {
      await verifyDeployment(c);
      const saved = s.journal["setup:register"];
      // Only this wallet can register itself, so membership proves the saved transaction,
      // even after node history no longer has it.
      if (await registered(c, owner)) confirmSaved("setup:register");
      else {
        if (!saved) {
          const funding = await fundingBudget(c, owner);
          if (funding.balance < funding.required) throw new FundingRequired();
        }
        progress("Registering your address and allocating 100 credits");
        await transact(
          c,
          s,
          persist,
          progress,
          "setup:register",
          async () => {
            const tx = new Transaction();
            tx.moveCall({
              target: `${c.package}::paymvc::register`,
              typeArguments: [coinType(c)],
              arguments: [tx.object(c.app)],
            });
            return tx;
          },
          async () => !(await registered(c, owner)),
        );
        if (!(await registered(c, owner))) throw new ResultPending();
      }
      s.ready = true;
      persist();
    },
    async execute(intent: Intent) {
      validateOperation(intent.operation);
      const amount = parseAmount(intent.amount);
      await verifyDeployment(c);
      const transfer = intent.action === "send" || intent.action === "request";
      // A send or request creates the entry (owner, operation). An approval or
      // decline resolves the request named by `intent.id`.
      const [from, operation] = transfer
        ? [owner, intent.operation]
        : (intent.id.split(":") as [string, string]);
      if (!transfer && from !== intent.recipient)
        throw new Error("Only the intended payer can resolve this request.");
      const check = async () => {
        const found = await readEntry(c, from, operation);
        if (transfer) {
          if (!found) return false;
          if (
            found.to !== intent.recipient ||
            found.amount !== amount ||
            found.kind !== (intent.action === "send" ? "Transfer" : "Request")
          )
            throw new Error(
              "Saved operation does not match the on-chain record.",
            );
          return true;
        }
        if (
          !found ||
          found.kind !== "Request" ||
          found.to !== owner ||
          found.amount !== amount
        )
          throw new Error("Only the intended payer can resolve this request.");
        const expected = intent.action === "approve" ? "Paid" : "Declined";
        if (found.state !== "Pending" && found.state !== expected)
          throw new Error("This request was already resolved differently.");
        return found.state === expected;
      };
      const label = `${intent.operation}:${intent.action}`;
      // The entry proves the effect, even after node history no longer has the transaction.
      if (await check()) return confirmSaved(label);
      if (
        owner === intent.recipient ||
        !(await registered(c, owner, intent.recipient))
      )
        throw new Error("Choose a different, registered PayMVC account.");
      await transact(
        c,
        s,
        persist,
        progress,
        label,
        async () => {
          const tx = new Transaction();
          // The counterparty: recipient, payer, or requester (checked above).
          const args = [tx.object(c.app), tx.pure.address(intent.recipient)];
          if (intent.action === "request") args.push(tx.pure.u64(amount));
          args.push(tx.pure.vector("u8", fromHex(operation)));
          if (intent.action === "send" || intent.action === "approve")
            args.push(await paymentCoin(c, tx, owner, amount));
          tx.moveCall({
            target: `${c.package}::paymvc::${intent.action}`,
            typeArguments: [coinType(c)],
            arguments: args,
          });
          return tx;
        },
        async () => !(await check()),
      );
      if (!(await check())) throw new ResultPending();
    },
  };
}
