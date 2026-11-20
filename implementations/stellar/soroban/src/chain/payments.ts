import { Contract, Keypair, StrKey, xdr } from "@stellar/stellar-sdk";
import { Buffer } from "buffer";
import { server, type Deployment } from "./config";
import { creditsSpec, paymvcSpec } from "./generated/specs";
import {
  accountFor,
  parseAmount,
  validateOperation,
  type Intent,
  type Session,
} from "./session";
import {
  readContract,
  ResultPending,
  transact,
  type Progress,
} from "./transactions";

type Spec = typeof paymvcSpec;
/** Simulates a read-only call. The contract's spec encodes the arguments and decodes the result. */
async function call<T>(
  c: Deployment,
  source: string,
  spec: Spec,
  contract: string,
  method: string,
  args: object = {},
): Promise<T> {
  const retval = await readContract(
    c,
    source,
    contract,
    method,
    spec.funcArgsToScVals(method, args),
  );
  return spec.funcResToNative(method, retval) as T;
}
/** A read of contracts/paymvc. */
export const readApp = <T>(
  c: Deployment,
  source: string,
  method: string,
  args?: object,
) => call<T>(c, source, paymvcSpec, c.contract, method, args);
/** A read of contracts/credits, the SEP-41 token. */
export const readToken = <T>(
  c: Deployment,
  source: string,
  method: string,
  args?: object,
) => call<T>(c, source, creditsSpec, c.token, method, args);

/** `Entry` in contracts/paymvc, as the spec decodes it. Unit enum variants decode as `{ tag }`. */
interface RawEntry {
  from: string;
  to: string;
  operation: Buffer;
  amount: bigint;
  kind: { tag: "Transfer" | "Request" };
  state: { tag: "Pending" | "Paid" | "Declined" };
}
export function parseEntry(raw: RawEntry) {
  const operation = Buffer.from(raw.operation).toString("hex");
  return {
    from: raw.from,
    to: raw.to,
    amount: raw.amount,
    kind: raw.kind.tag,
    state: raw.state.tag,
    operation,
    id: `${raw.from}:${operation}`,
  };
}
export type ActivityEntry = ReturnType<typeof parseEntry>;
const operationBytes = (value: string) => Buffer.from(value, "hex");

export class FundingRequired extends Error {
  constructor() {
    super(
      "This wallet needs more testnet XLM for account reserves and fees. Fund its address and retry.",
    );
  }
}
// 1 XLM minimum balance for the account, up to 2.5 XLM to extend the contract
// TTL (a call pays this about every 15 days), and fees for the scenario.
const REQUIRED_STROOPS = 50_000_000n;
export async function fundingBudget(c: Deployment, owner: string) {
  // Read the account entry directly: the SDK's getAccountEntry reports every RPC
  // failure as "not found", which would look like an unfunded wallet.
  const key = xdr.LedgerKey.account(
    new xdr.LedgerKeyAccount({
      accountId: Keypair.fromPublicKey(owner).xdrPublicKey(),
    }),
  );
  const { entries } = await server(c)
    .getLedgerEntries(key)
    .catch(() => {
      throw new Error("Could not check XLM funding. Please retry.");
    });
  const entry = entries[0]?.val;
  return {
    // No entry: Friendbot has not created the account yet.
    balance: entry?.type === "account" ? entry.account.balance : 0n,
    required: REQUIRED_STROOPS,
  };
}

/** Deployments that passed verification in this page. The contracts cannot change. */
const verified = new Set<string>();

export async function verifyDeployment(c: Deployment) {
  if (verified.has(c.contract)) return;
  const client = server(c);
  if ((await client.getNetwork()).passphrase !== c.passphrase)
    throw new Error("This RPC belongs to a different network.");
  const result = await client.getLedgerEntries(
    new Contract(c.contract).getFootprint(),
    new Contract(c.token).getFootprint(),
  );
  for (const [id, hash] of [
    [c.contract, c.codeHash],
    [c.token, c.tokenHash],
  ]) {
    const found = result.entries.find(
      (item) =>
        item.key.toXDR("base64") ===
        new Contract(id!).getFootprint().toXDR("base64"),
    );
    const value =
      found?.val.type === "contractData"
        ? found.val.contractData.val
        : undefined;
    const executable =
      value?.type === "scvContractInstance"
        ? value.instance.executable
        : undefined;
    if (
      executable?.type !== "contractExecutableWasm" ||
      executable.wasmHash.toString() !== hash
    )
      throw new Error(
        "Deployment verification failed or contract storage is archived. Restore the deployment before retrying.",
      );
  }
  const source = StrKey.encodeEd25519PublicKey(Buffer.alloc(32));
  const [token, decimals] = await Promise.all([
    readApp<string>(c, source, "token"),
    readToken<number>(c, source, "decimals"),
  ]);
  if (token !== c.token || decimals !== 0)
    throw new Error("Deployment token configuration does not match the app.");
  verified.add(c.contract);
}
// Reads the newest `limit` entries. `before` is an absolute history index, so a
// record that lands between page reads cannot shift or repeat a row.
export async function readDashboard(c: Deployment, s: Session, limit = 50) {
  const owner = accountFor(s).address;
  const [balance, count] = await Promise.all([
    readToken<bigint>(c, owner, "balance", { id: owner }),
    readApp<bigint>(c, owner, "activity_count", { account: owner }),
  ]);
  const entries: ActivityEntry[] = [];
  for (let before = count; before > 0n && entries.length < limit;) {
    const page = (
      await readApp<RawEntry[]>(c, owner, "activity", {
        account: owner,
        before,
        limit: Math.min(50, limit - entries.length),
      })
    ).map(parseEntry);
    if (!page.length) break;
    entries.push(...page);
    before -= BigInt(page.length);
  }
  return { balance, count, entries };
}
export function payments(
  c: Deployment,
  s: Session,
  persist: () => void,
  progress: Progress,
) {
  const read = <T>(method: string, args: object) =>
    readApp<T>(c, accountFor(s).address, method, args);
  const invoke = (
    label: string,
    method: string,
    args: object,
    absent: () => Promise<boolean>,
  ) =>
    transact(
      c,
      s,
      persist,
      progress,
      label,
      async () => [
        new Contract(c.contract).call(
          method,
          ...paymvcSpec.funcArgsToScVals(method, args),
        ),
      ],
      absent,
    );
  /** The chain shows the effect of a saved transaction, so it is confirmed. */
  const confirmSaved = (label: string) => {
    const record = s.journal[label];
    if (record && !record.confirmed) {
      record.confirmed = true;
      persist();
    }
  };
  async function execute(intent: Intent) {
    await verifyDeployment(c);
    validateOperation(intent.operation);
    const amount = parseAmount(intent.amount);
    const actor = accountFor(s).address;
    const creating = intent.action === "send" || intent.action === "request";
    // An entry is keyed by (from, operation). For a request, `from` is the requester.
    const from = creating ? actor : intent.recipient;
    const operation = creating ? intent.operation : intent.id.split(":")[1]!;
    validateOperation(operation);
    if (!creating && intent.id !== `${from}:${operation}`)
      throw new Error("The request ID does not match its requester.");
    const check = async () => {
      const raw = await read<RawEntry | null>("entry", {
        from,
        operation: operationBytes(operation),
      });
      if (raw === null || raw === undefined) return false;
      const entry = parseEntry(raw);
      if (
        entry.from !== from ||
        entry.to !== (creating ? intent.recipient : actor) ||
        entry.amount !== amount ||
        entry.kind !== (intent.action === "send" ? "Transfer" : "Request")
      )
        throw new Error(
          "The saved operation does not match its on-chain record.",
        );
      if (creating) return true;
      const expected = intent.action === "approve" ? "Paid" : "Declined";
      if (entry.state !== "Pending" && entry.state !== expected)
        throw new Error(
          "This request has already been resolved. Refresh its status.",
        );
      return entry.state === expected;
    };
    // The entry proves the effect, even after RPC history no longer has the transaction.
    if (await check()) return confirmSaved(intent.operation);
    // Soroban has no implicit caller: the signer is an explicit, authorized argument.
    await invoke(
      intent.operation,
      intent.action,
      intent.action === "send"
        ? {
            from: actor,
            to: intent.recipient,
            amount,
            operation: operationBytes(operation),
          }
        : intent.action === "request"
          ? {
              from: actor,
              payer: intent.recipient,
              amount,
              operation: operationBytes(operation),
            }
          : { payer: actor, from, operation: operationBytes(operation) },
      async () => !(await check()),
    );
    if (!(await check())) throw new ResultPending();
  }
  async function setup() {
    progress("Checking deployment and XLM funding");
    await verifyDeployment(c);
    const visitor = accountFor(s).address;
    const budget = await fundingBudget(c, visitor);
    if (!Object.keys(s.journal).length && budget.balance < budget.required)
      throw new FundingRequired();
    progress("Registering your wallet");
    const registered = () => read<boolean>("registered", { account: visitor });
    // Only this wallet's signature can register it, so membership proves the saved transaction.
    if (await registered()) confirmSaved("register");
    else
      await invoke(
        "register",
        "register",
        { owner: visitor },
        async () => !(await registered()),
      );
    if ((await registered()) !== true) throw new ResultPending();
    s.ready = true;
    persist();
  }
  return { setup, execute };
}

export async function readContacts(c: Deployment, s: Session, start: bigint) {
  const owner = accountFor(s).address;
  const total = await readApp<bigint>(c, owner, "profile_count");
  const page = await readApp<string[]>(c, owner, "profiles", {
    start,
    limit: 6,
  });
  const addresses: string[] = [];
  let next = start;
  for (const address of page) {
    next++;
    if (address !== owner) addresses.push(address);
    if (addresses.length === 5) break;
  }
  let more = next < total || next < start + BigInt(page.length);
  // The count and the page are separate reads. A registration between them can make a
  // full page reach past the count, so count again before ending the list.
  if (!more && page.length === 6)
    more = (await readApp<bigint>(c, owner, "profile_count")) > next;
  return { addresses, next: more ? next : undefined };
}
