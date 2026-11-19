import assert from "node:assert/strict";
import { failureText, writeEvidence } from "./evidence";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
} from "node:fs";
import { parseDeployment, server } from "../src/chain/config";
import {
  newSession,
  accountFor,
  entryId,
  type Session,
  type Intent,
} from "../src/chain/session";
import { MAX_GAS_AMOUNT, payments, readDashboard } from "../src/chain/payments";
import { transact } from "../src/chain/transactions";

const local = process.env.LOCAL === "1";
const c = parseDeployment(
  JSON.parse(
    readFileSync(
      local ? "public/local.json" : "public/deployment.json",
      "utf8",
    ),
  ),
  local ? undefined : process.env.VITE_RPC_URL,
);
const dir = `.local/live-${c.publishHash}`;
mkdirSync(dir, { recursive: true, mode: 0o700 });
function save(path: string, value: unknown) {
  writeFileSync(`${path}.tmp`, JSON.stringify(value), { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}
function session(name: string, key?: string): Session {
  const path = `${dir}/${name}.json`;
  if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8"));
  const s = key ? { ...newSession(c), key } : newSession(c);
  save(path, s);
  return s;
}
const users = { a: session("a"), b: session("b") };
// The funder signs with the deployment wallet and keeps its own journal.
const deployer = session(
  "funder",
  JSON.parse(
    readFileSync(`.local/${local ? "local" : "testnet"}-deployer.json`, "utf8"),
  ).privateKey,
);
const stepsFile = `${dir}/steps.json`;
const done: string[] = existsSync(stepsFile)
  ? JSON.parse(readFileSync(stepsFile, "utf8"))
  : [];
// Transaction hashes in scenario order, also for steps that a resumed run skips.
const transactions: { step: string; hash: string }[] = [];
async function step(
  label: string,
  task: () => Promise<void>,
  tx?: [Session, string],
) {
  if (!done.includes(label)) {
    await task();
    done.push(label);
    save(stepsFile, done);
    console.log(`Passed: ${label}`);
  }
  const record = tx && tx[0].journal[tx[1]];
  if (record) transactions.push({ step: label, hash: record.hash });
}
function persist(user: "a" | "b") {
  save(`${dir}/${user}.json`, users[user]);
}
async function state(a: bigint, b: bigint, count: number) {
  for (const user of ["a", "b"] as const) {
    const dashboard = await readDashboard(c, users[user]);
    assert.equal(dashboard.balance, user === "a" ? a : b);
    assert.equal(dashboard.entries.length, count);
  }
}
async function scenario() {
  for (const user of ["a", "b"] as const) {
    await step(
      `fund-${user}`,
      async () => {
        await transact(
          c,
          deployer,
          () => save(`${dir}/funder.json`, deployer),
          () => {},
          `fund:${user}`,
          () =>
            server(c).transaction.build.simple({
              sender: accountFor(deployer).address,
              data: {
                function: "0x1::aptos_account::transfer",
                functionArguments: [
                  accountFor(users[user]).address,
                  30_000_000n,
                ],
              },
              options: { maxGasAmount: MAX_GAS_AMOUNT },
            }),
        );
      },
      [deployer, `fund:${user}`],
    );
    await step(
      `register-${user}`,
      () =>
        payments(
          c,
          users[user],
          () => persist(user),
          () => {},
        ).setup(),
      [users[user], "setup:register"],
    );
  }
  await step("initial", () => state(100n, 100n, 0));
  async function act(
    label: string,
    user: "a" | "b",
    action: Intent["action"],
    amount: string,
    id?: string,
  ) {
    const operation = Buffer.from(label.padEnd(32, "\0")).toString("hex");
    await step(
      label,
      () =>
        payments(
          c,
          users[user],
          () => persist(user),
          () => {},
        ).execute({
          action,
          amount,
          id: id ?? entryId(accountFor(users[user]).address, operation),
          operation,
          recipient: accountFor(users[user === "a" ? "b" : "a"]).address,
        }),
      [users[user], `${operation}:${action}`],
    );
  }
  const latest = async (user: "a" | "b") =>
    (await readDashboard(c, users[user])).entries[0]!.id;
  await act("send7", "a", "send", "7");
  await step("after-send", () => state(93n, 107n, 1));
  await act("request20", "b", "request", "20");
  await act("approve20", "a", "approve", "20", await latest("a"));
  await step("after-approve", () => state(73n, 127n, 2));
  await act("request5", "b", "request", "5");
  await act("decline5", "a", "decline", "5", await latest("a"));
  await step("after-decline", () => state(73n, 127n, 3));
  await act("request9", "a", "request", "9");
  await act("approve9", "b", "approve", "9", await latest("b"));
  await step("after-reverse", () => state(82n, 118n, 4));
  await step(
    "external3",
    async () => {
      await transact(
        c,
        users.b,
        () => persist("b"),
        () => {},
        "external:3",
        () =>
          server(c).transaction.build.simple({
            sender: accountFor(users.b).address,
            data: {
              function: "0x1::primary_fungible_store::transfer",
              typeArguments: ["0x1::fungible_asset::Metadata"],
              functionArguments: [c.metadata, accountFor(users.a).address, 3n],
            },
            options: { maxGasAmount: MAX_GAS_AMOUNT },
          }),
      );
    },
    [users.b, "external:3"],
  );
  await state(85n, 115n, 4);
}
let failure: unknown;
try {
  await scenario();
} catch (error) {
  failure = error;
}
// Record what the chain shows now, for a pass or a failure. If the chain
// cannot be read, report the original failure without evidence.
const [a, b] = await Promise.all([
  readDashboard(c, users.a),
  readDashboard(c, users.b),
]).catch((error: unknown) => {
  throw failure ?? error;
});
writeEvidence(c, local, {
  result: failure ? "failed" : "passed",
  ...(failure ? { failure: failureText(failure) } : {}),
  balances: { a: a.balance.toString(), b: b.balance.toString() },
  activity: { a: Number(a.count), b: Number(b.count) },
  transactions,
});
if (failure) throw failure;
console.log("Canonical balances 85/115, four activity records each.");
