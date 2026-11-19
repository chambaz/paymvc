import {
  Hex,
  type LedgerInfo,
  type SimpleTransaction,
} from "@aptos-labs/ts-sdk";
import { z } from "zod";
import {
  latestLedger,
  normalizeAddress,
  server,
  type Deployment,
} from "./config";
import {
  accountFor,
  entryId,
  parseAmount,
  parseEntryId,
  validateOperation,
  type Session,
  type Intent,
} from "./session";
import { transact, ResultPending } from "./transactions";

type Argument = string | bigint | Uint8Array;
const integer = z.string().regex(/^\d+$/);
/** Operation IDs are `vector<u8>` arguments. The SDK encodes a string as UTF-8, so pass bytes. */
export const operationBytes = (operation: string) =>
  Hex.fromHexString(operation).toUint8Array();
const address = z.string().transform(normalizeAddress);
// Move 2 enum values arrive as { __variant__: "Name" }.
const variant = <const T extends readonly [string, ...string[]]>(names: T) =>
  z.object({ __variant__: z.enum(names) }).transform((v) => v.__variant__);
const entrySchema = z
  .object({
    from: address,
    to: address,
    operation: z.string().regex(/^0x[0-9a-f]{64}$/),
    amount: integer,
    kind: variant(["Transfer", "Request"]),
    state: variant(["Pending", "Paid", "Declined"]),
  })
  .transform((e) => {
    const operation = e.operation.slice(2);
    return {
      ...e,
      id: entryId(e.from, operation),
      operation,
      amount: BigInt(e.amount),
    };
  });
export type Entry = z.output<typeof entrySchema>;
export class FundingRequired extends Error {
  constructor() {
    super(
      "Fund this wallet with testnet APT for registration and transaction fees, then retry.",
    );
  }
}
/** Call a view function, such as "paymvc::entry", optionally at one ledger version. */
export async function view(
  c: Deployment,
  name: `${"paymvc" | "credits"}::${string}`,
  args: Argument[] = [],
  ledgerVersion?: bigint,
) {
  return (
    await server(c).view({
      payload: { function: `${c.package}::${name}`, functionArguments: args },
      options: { ledgerVersion },
    })
  )[0];
}
const registered = async (c: Deployment, account: string) =>
  z.boolean().parse(await view(c, "paymvc::registered", [account]));
/** The entry `(from, operation)`, or undefined if it does not exist. */
export async function readEntry(
  c: Deployment,
  from: string,
  operation: string,
) {
  const found = z
    .object({ vec: z.array(entrySchema).max(1) })
    .parse(await view(c, "paymvc::entry", [from, operationBytes(operation)]));
  return found.vec[0];
}
export async function readBalance(
  c: Deployment,
  owner: string,
  ledgerVersion?: bigint,
) {
  const balance = await server(c).view({
    payload: {
      function: "0x1::primary_fungible_store::balance",
      typeArguments: ["0x1::fungible_asset::Metadata"],
      functionArguments: [owner, c.metadata],
    },
    options: { ledgerVersion },
  });
  return BigInt(integer.parse(balance[0]));
}
export async function fundingBudget(c: Deployment, owner: string) {
  // The node reports 0 for an account that does not exist yet.
  const balance = await server(c).getBalance({
    accountAddress: owner,
    asset: "0x1::aptos_coin::AptosCoin",
  });
  return { balance: BigInt(balance), required: 10_000_000n };
}
export async function moduleHash(bytecode: string) {
  return Hex.fromHexInput(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new Uint8Array(Hex.fromHexInput(bytecode).toUint8Array()),
      ),
    ),
  ).toStringWithoutPrefix();
}
const verifiedDeployments = new WeakMap<Deployment, Promise<void>>();
export function verifyDeployment(c: Deployment) {
  let verification = verifiedDeployments.get(c);
  if (!verification) {
    // The package policy is immutable. Recheck after reload or config replacement.
    verification = checkDeployment(c).catch((error: unknown) => {
      verifiedDeployments.delete(c);
      throw error;
    });
    verifiedDeployments.set(c, verification);
  }
  return verification;
}
async function checkDeployment(c: Deployment) {
  const client = server(c);
  const hash = async (moduleName: string) =>
    moduleHash(
      (await client.getAccountModule({ accountAddress: c.package, moduleName }))
        .bytecode,
    );
  const [ledger, credits, paymvc, registry, metadata] = await Promise.all([
    client.getLedgerInfo(),
    hash("credits"),
    hash("paymvc"),
    client.getAccountResource({
      accountAddress: c.package,
      resourceType: "0x1::code::PackageRegistry",
    }),
    view(c, "credits::metadata"),
  ]);
  const packages = z
    .object({
      packages: z.array(
        z.object({
          name: z.string(),
          upgrade_policy: z.object({ policy: z.number() }),
        }),
      ),
    })
    .parse(registry);
  const asset = z.object({ inner: address }).parse(metadata);
  if (
    ledger.chain_id !== c.chainId ||
    credits !== c.modules.credits ||
    paymvc !== c.modules.paymvc ||
    asset.inner !== c.metadata ||
    // Policy 2 is immutable: the code at this address can never change.
    !packages.packages.some(
      (p) => p.name === "paymvc" && p.upgrade_policy.policy === 2,
    )
  )
    throw new Error(
      "Deployment verification failed. Check the network and application configuration.",
    );
}
export async function readContacts(c: Deployment, s: Session, start: bigint) {
  const count = BigInt(integer.parse(await view(c, "paymvc::profile_count")));
  const owner = accountFor(s).address;
  let cursor = start;
  const addresses: string[] = [];
  while (cursor < count && addresses.length < 5) {
    const page = z
      .array(address)
      .parse(
        await view(c, "paymvc::profiles", [
          cursor,
          BigInt(5 - addresses.length),
        ]),
      );
    cursor += BigInt(page.length);
    addresses.push(...page.filter((value) => value !== owner));
  }
  return { addresses, next: cursor < count ? cursor : undefined };
}
export async function readDashboard(c: Deployment, s: Session, limit = 50) {
  const owner = accountFor(s).address;
  // Read every view at one ledger version, so the balance, count, and pages agree.
  const version = BigInt((await latestLedger(c)).ledger_version);
  const [balance, count] = await Promise.all([
    readBalance(c, owner, version),
    view(c, "paymvc::activity_count", [owner], version),
  ]);
  const total = BigInt(integer.parse(count));
  const entries: Entry[] = [];
  // `before` is an absolute history index, so a new entry cannot shift a later page.
  let before = total;
  while (before > 0n && entries.length < limit) {
    const page = z
      .array(entrySchema)
      .parse(
        await view(
          c,
          "paymvc::activity",
          [owner, before, BigInt(Math.min(50, limit - entries.length))],
          version,
        ),
      );
    if (!page.length) break;
    entries.push(...page);
    before -= BigInt(page.length);
  }
  return { balance, count: total, entries };
}
/**
 * Aptos rejects a transaction unless the sender holds maxGasAmount × gas price.
 * The SDK default (2,000,000 units) would exceed the funding budget, so cap it.
 * Registration uses about 19,000 units; 50,000 leaves room for fee changes.
 */
export const MAX_GAS_AMOUNT = 50_000;

export function buildCall(
  c: Deployment,
  s: Session,
  ledger: LedgerInfo,
  name: string,
  args: Argument[] = [],
): Promise<SimpleTransaction> {
  return server(c).transaction.build.simple({
    sender: accountFor(s).address,
    data: {
      function: `${c.package}::paymvc::${name}`,
      functionArguments: args,
    },
    options: {
      maxGasAmount: MAX_GAS_AMOUNT,
      // Expiry uses ledger time, the same clock that later proves expiry.
      expireTimestamp:
        Number(BigInt(ledger.ledger_timestamp) / 1_000_000n) + 600,
    },
  });
}
export function payments(
  c: Deployment,
  s: Session,
  persist: () => void,
  progress: (value: string) => void,
) {
  const owner = accountFor(s).address;
  return {
    async setup() {
      await verifyDeployment(c);
      const saved = s.journal["setup:register"];
      if (!(await registered(c, owner)) || (saved && !saved.confirmed)) {
        if (!saved) {
          const funding = await fundingBudget(c, owner);
          if (funding.balance < funding.required) throw new FundingRequired();
        }
        progress("Registering your address and allocating 100 credits");
        await transact(c, s, persist, progress, "setup:register", (ledger) =>
          buildCall(c, s, ledger, "register"),
        );
        if (!(await registered(c, owner))) throw new ResultPending();
      }
      s.ready = true;
      persist();
    },
    async execute(intent: Intent) {
      const { action, recipient } = intent;
      validateOperation(intent.operation);
      const amount = parseAmount(intent.amount);
      const creates = action === "send" || action === "request";
      // Send and request create the entry (owner, operation). Approve and
      // decline resolve the recipient's entry named by intent.id.
      const key = parseEntryId(intent.id);
      if (
        creates
          ? key.from !== owner || key.operation !== intent.operation
          : key.from !== recipient
      )
        throw new Error("This operation is invalid. Dismiss it and try again.");
      validateOperation(key.operation);
      await verifyDeployment(c);
      const label = `${intent.operation}:${action}`;
      const check = async () => {
        const found = await readEntry(c, key.from, key.operation);
        if (creates) {
          if (!found) return false;
          if (
            found.to !== recipient ||
            found.amount !== amount ||
            found.kind !== (action === "send" ? "Transfer" : "Request")
          )
            throw new Error(
              "Saved operation does not match the on-chain entry.",
            );
          return true;
        }
        if (
          found?.kind !== "Request" ||
          found.to !== owner ||
          found.amount !== amount
        )
          throw new Error("Only the intended payer can resolve this request.");
        const expected = action === "approve" ? "Paid" : "Declined";
        if (found.state !== "Pending" && found.state !== expected)
          throw new Error("This request was already resolved differently.");
        return found.state === expected;
      };
      if ((await check()) && !s.journal[label]) return;
      if (owner === recipient || !(await registered(c, recipient)))
        throw new Error("Choose a different, registered PayMVC account.");
      progress(
        action === "approve"
          ? "Approving and paying the request"
          : "Submitting your transaction",
      );
      await transact(
        c,
        s,
        persist,
        progress,
        label, // transact builds only when no saved transaction exists. A retry
        // reconciles the saved transaction and skips this balance check.
        async (ledger) => {
          if (
            (action === "send" || action === "approve") &&
            (await readBalance(c, owner)) < amount
          )
            throw new Error(
              "Not enough demo credits. No payment was completed.",
            );
          return buildCall(
            c,
            s,
            ledger,
            action,
            creates
              ? [recipient, amount, operationBytes(key.operation)]
              : [key.from, operationBytes(key.operation)],
          );
        },
      );
      if (!(await check())) throw new ResultPending();
    },
  };
}
