import {
  Address,
  Contract,
  Horizon,
  nativeToScVal,
  StrKey,
  xdr,
} from "@stellar/stellar-sdk";
import { Buffer } from "buffer";
import { z } from "zod";
import { server, type Deployment } from "./config";
import {
  accountFor,
  isAddress,
  parseAmount,
  validateOperation,
  type Intent,
  type Session,
} from "./session";
import { readContract, ResultPending, transact } from "./transactions";

const addr = (value: string) => new Address(value).toScVal();
const bytes = (value: string) =>
  nativeToScVal(Buffer.from(value, "hex"), { type: "bytes" });
const num = (value: bigint, type: "i128" | "u64" = "i128") =>
  nativeToScVal(value, { type });
// contracts/paymvc stores Kind and State as `#[contracttype]` enums. A unit
// variant reads as a one-item list with its name, for example ["Paid"].
const variant = <const T extends readonly [string, ...string[]]>(names: T) =>
  z.tuple([z.enum(names)]).transform(([name]) => name);
const entrySchema = z.object({
  from: z.string().refine(isAddress),
  to: z.string().refine(isAddress),
  operation: z.instanceof(Uint8Array),
  amount: z.bigint(),
  kind: variant(["Transfer", "Request"]),
  state: variant(["Pending", "Paid", "Declined"]),
});
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
  const response = await fetch(`${c.horizonUrl}/accounts/${owner}`, {
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 404)
    return { balance: 0n, required: REQUIRED_STROOPS };
  if (!response.ok)
    throw new Error("Could not check XLM funding. Please retry.");
  const data = (await response.json()) as Horizon.ServerApi.AccountRecord;
  const balance = data.balances.find(
    (item) => item.asset_type === "native",
  )?.balance;
  if (!balance || !/^\d+\.\d{7}$/.test(balance))
    throw new Error("Invalid XLM balance response.");
  return {
    balance: BigInt(balance.replace(".", "")),
    required: REQUIRED_STROOPS,
  };
}
export async function verifyDeployment(c: Deployment) {
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
    readContract(c, source, c.contract, "token"),
    readContract(c, source, c.token, "decimals"),
  ]);
  if (token !== c.token || decimals !== 0)
    throw new Error("Deployment token configuration does not match the app.");
}
export function parseEntry(raw: unknown) {
  const entry = entrySchema.parse(raw);
  const operation = Buffer.from(entry.operation).toString("hex");
  return { ...entry, operation, id: `${entry.from}:${operation}` };
}
// Reads the newest `limit` entries. `before` is an absolute history index, so a
// record that lands between page reads cannot shift or repeat a row.
export async function readDashboard(c: Deployment, s: Session, limit = 50) {
  const owner = accountFor(s).address;
  const read = (contract: string, method: string, args: xdr.ScVal[]) =>
    readContract(c, owner, contract, method, args);
  const [balance, count] = await Promise.all([
    read(c.token, "balance", [addr(owner)]),
    read(c.contract, "activity_count", [addr(owner)]),
  ]);
  const total = z.bigint().parse(count);
  const entries: ReturnType<typeof parseEntry>[] = [];
  for (let before = total; before > 0n && entries.length < limit;) {
    const page = z
      .array(z.unknown())
      .parse(
        await read(c.contract, "activity", [
          addr(owner),
          num(before, "u64"),
          nativeToScVal(Math.min(50, limit - entries.length), { type: "u32" }),
        ]),
      )
      .map(parseEntry);
    if (!page.length) break;
    entries.push(...page);
    before -= BigInt(page.length);
  }
  return { balance: z.bigint().parse(balance), count: total, entries };
}
export function payments(
  c: Deployment,
  s: Session,
  persist: () => void,
  report: (message: string) => void,
) {
  const read = (method: string, args: xdr.ScVal[]) =>
    readContract(c, accountFor(s).address, c.contract, method, args);
  const invoke = (label: string, method: string, args: xdr.ScVal[]) =>
    transact(c, s, persist, label, async () => [
      new Contract(c.contract).call(method, ...args),
    ]);
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
      const raw = await read("entry", [addr(from), bytes(operation)]);
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
    if ((await check()) && !s.journal[intent.operation]) return;
    report(
      creating ? "Submitting your payment operation" : "Updating this request",
    );
    // Soroban has no implicit caller: the signer is an explicit, authorized argument.
    await invoke(
      intent.operation,
      intent.action,
      creating
        ? [addr(actor), addr(intent.recipient), num(amount), bytes(operation)]
        : [addr(actor), addr(from), bytes(operation)],
    );
    if (!(await check())) throw new ResultPending();
  }
  async function setup() {
    report("Checking deployment and XLM funding");
    await verifyDeployment(c);
    const visitor = accountFor(s).address;
    const budget = await fundingBudget(c, visitor);
    if (!Object.keys(s.journal).length && budget.balance < budget.required)
      throw new FundingRequired();
    report("Registering your wallet");
    if (!(await read("registered", [addr(visitor)])) || s.journal.register)
      await invoke("register", "register", [addr(visitor)]);
    if ((await read("registered", [addr(visitor)])) !== true)
      throw new ResultPending();
    s.ready = true;
    persist();
  }
  return { setup, execute };
}

export async function readContacts(c: Deployment, s: Session, start: bigint) {
  const owner = accountFor(s).address;
  const total = z
    .bigint()
    .parse(await readContract(c, owner, c.contract, "profile_count"));
  const page = z
    .array(z.string().refine(isAddress))
    .parse(
      await readContract(c, owner, c.contract, "profiles", [
        num(start, "u64"),
        nativeToScVal(6, { type: "u32" }),
      ]),
    );
  const addresses: string[] = [];
  let next = start;
  for (const address of page) {
    next++;
    if (address !== owner) addresses.push(address);
    if (addresses.length === 5) break;
  }
  return { addresses, next: next < total ? next : undefined };
}
