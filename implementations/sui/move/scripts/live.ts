import assert from "node:assert/strict";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  renameSync,
} from "node:fs";
import { Transaction } from "@mysten/sui/transactions";
import { deploymentKey, parseDeployment } from "../src/chain/config";
import {
  newSession,
  accountFor,
  type Session,
  type Intent,
} from "../src/chain/session";
import {
  payments,
  paymentCoin,
  readDashboard,
  readContacts,
} from "../src/chain/payments";
import { transact } from "../src/chain/transactions";
import { writeEvidence } from "./evidence";

const local = process.env.LOCAL === "1";
const c = parseDeployment(
  JSON.parse(
    readFileSync(
      local ? "public/local.json" : "public/deployment.json",
      "utf8",
    ),
  ),
);
const run = process.env.LIVE_RUN ?? "acceptance";
if (!/^[a-zA-Z0-9-]+$/.test(run))
  throw new Error("Use letters, digits, or hyphens for LIVE_RUN.");
const dir = `.local/live-${c.network}-${c.app}-${run}`;
mkdirSync(dir, { recursive: true, mode: 0o700 });
function save(file: string, value: unknown) {
  writeFileSync(`${file}.tmp`, JSON.stringify(value), { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}
function session(name: string): Session {
  const path = `${dir}/${name}.json`;
  if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8"));
  const value = newSession(c);
  save(path, value);
  return value;
}
const users = { a: session("a"), b: session("b") };
// The deployment wallet funds both users. Its journal resumes from funder.json.
const funderFile = `${dir}/funder.json`;
const deployer: Session = {
  version: 2,
  deployment: deploymentKey(c),
  key: JSON.parse(
    readFileSync(`.local/${local ? "local" : "testnet"}-deployer.json`, "utf8"),
  ).privateKey,
  ready: true,
  intent: null,
  journal: existsSync(funderFile)
    ? JSON.parse(readFileSync(funderFile, "utf8")).journal
    : {},
};
const statusFile = `${dir}/steps.json`;
const done: string[] = existsSync(statusFile)
  ? JSON.parse(readFileSync(statusFile, "utf8"))
  : [];
async function step(label: string, task: () => Promise<void>) {
  if (done.includes(label)) return;
  await task();
  done.push(label);
  save(statusFile, done);
  console.log(`Passed: ${label}`);
}
function persist(user: "a" | "b") {
  save(`${dir}/${user}.json`, users[user]);
}
async function state(user: "a" | "b", balance: bigint, count: number) {
  const dashboard = await readDashboard(c, users[user]);
  assert.equal(dashboard.balance, balance);
  assert.equal(dashboard.entries.length, count);
}
for (const user of ["a", "b"] as const) {
  const address = accountFor(users[user]).address;
  await step(`fund-${user}`, async () => {
    await transact(
      c,
      deployer,
      `fund:${user}`,
      async () => {
        const tx = new Transaction();
        tx.transferObjects(
          [tx.splitCoins(tx.gas, [tx.pure.u64(150_000_000)])[0]],
          tx.pure.address(address),
        );
        return tx;
      },
      () => save(funderFile, { journal: deployer.journal }),
    );
  });
  await step(`register-${user}`, async () => {
    await payments(
      c,
      users[user],
      () => persist(user),
      () => {},
    ).setup();
    await state(user, 100n, 0);
  });
}
await step("directory", async () => {
  assert.ok(
    (await readContacts(c, users.a, 0n)).addresses.includes(
      accountFor(users.b).address,
    ),
  );
  assert.ok(
    (await readContacts(c, users.b, 0n)).addresses.includes(
      accountFor(users.a).address,
    ),
  );
});
const operation = (label: string) =>
  Buffer.from(label.padEnd(32, "\0")).toString("hex");
async function act(
  label: string,
  user: "a" | "b",
  action: Intent["action"],
  amount: string,
  id = "",
) {
  const other = user === "a" ? "b" : "a";
  await step(label, async () => {
    await payments(
      c,
      users[user],
      () => persist(user),
      () => {},
    ).execute({
      action,
      amount,
      id,
      operation: operation(label),
      recipient: accountFor(users[other]).address,
    });
  });
}
async function latest(user: "a" | "b") {
  return (await readDashboard(c, users[user])).entries[0]!.id;
}
await act("send7", "a", "send", "7");
await step("after-send", async () => {
  await state("a", 93n, 1);
  await state("b", 107n, 1);
});
await act("request20", "b", "request", "20");
await act("approve20", "a", "approve", "20", await latest("a"));
await step("after-approve", async () => {
  await state("a", 73n, 2);
  await state("b", 127n, 2);
});
await act("request5", "b", "request", "5");
await act("decline5", "a", "decline", "5", await latest("a"));
await step("after-decline", async () => {
  await state("a", 73n, 3);
  await state("b", 127n, 3);
});
await act("request9", "a", "request", "9");
await act("approve9", "b", "approve", "9", await latest("b"));
await step("after-reverse", async () => {
  await state("a", 82n, 4);
  await state("b", 118n, 4);
});
await step("external3", async () => {
  await transact(
    c,
    users.b,
    "external:3",
    async () => {
      const tx = new Transaction();
      const coin = await paymentCoin(c, tx, accountFor(users.b).address, 3n);
      tx.transferObjects([coin], tx.pure.address(accountFor(users.a).address));
      return tx;
    },
    () => persist("b"),
  );
});
await state("a", 85n, 4);
await state("b", 115n, 4);
// Scenario steps, each with its signer and journal label.
const steps: [string, "a" | "b", string][] = [
  ["register-a", "a", "setup:register"],
  ["register-b", "b", "setup:register"],
  ["send7", "a", `${operation("send7")}:send`],
  ["request20", "b", `${operation("request20")}:request`],
  ["approve20", "a", `${operation("approve20")}:approve`],
  ["request5", "b", `${operation("request5")}:request`],
  ["decline5", "a", `${operation("decline5")}:decline`],
  ["request9", "a", `${operation("request9")}:request`],
  ["approve9", "b", `${operation("approve9")}:approve`],
  ["external3", "b", "external:3"],
];
writeEvidence(c, local, {
  result: "passed",
  balances: { a: "85", b: "115" },
  activity: { a: 4, b: 4 },
  transactions: steps.map(([step, user, label]) => {
    const record = users[user].journal[label];
    if (!record) throw new Error(`No saved transaction for ${step}.`);
    return { step, hash: record.hash };
  }),
});
console.log("Canonical balances 85/115, four activity records each.");
