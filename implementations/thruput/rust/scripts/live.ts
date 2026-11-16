/**
 * Run the canonical scenario with real transactions and record the result.
 *
 *   npm run test:live             # Futurenet, public/deployment.json
 *   LOCAL=1 npm run test:live     # the node from `npm run local`
 *
 * Users A and B are new wallets funded from the deployer key. Sessions,
 * signed transactions, and completed steps are saved in
 * `.local/live-<network hash>-<PayMVC address>/`, so a rerun reconciles the
 * saved transactions and resumes after the last completed step.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { parseDeployment } from "../src/chain/config";
import { entryId, payments, readDashboard } from "../src/chain/payments";
import {
  accountFor,
  newSession,
  type Intent,
  type Session,
} from "../src/chain/session";
import { failureText, writeEvidence } from "./evidence";
import { fund, funderSession, save, transferCredits } from "./transfers";

type User = "a" | "b";
const local = process.env.LOCAL === "1";
const c = parseDeployment(
  JSON.parse(
    readFileSync(
      local ? "public/local.json" : "public/deployment.json",
      "utf8",
    ),
  ),
);
const dir = `.local/live-${c.networkHash}-${c.address}`;
mkdirSync(dir, { recursive: true, mode: 0o700 });

function session(user: User): Session {
  const path = `${dir}/${user}.json`;
  if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8"));
  const s = newSession(c);
  save(path, s);
  return s;
}
const users = { a: session("a"), b: session("b") };
const address = (user: User) => accountFor(users[user]).address;
const persist = (user: User) => () => save(`${dir}/${user}.json`, users[user]);
const funder = funderSession(
  c,
  local ? "local" : "futurenet",
  `${dir}/funder.json`,
);

const stepsFile = `${dir}/steps.json`;
const done: string[] = existsSync(stepsFile)
  ? JSON.parse(readFileSync(stepsFile, "utf8"))
  : [];
// Transaction hashes in scenario order, also for steps that a resumed run skips.
const transactions: { step: string; hash: string }[] = [];
/** Run `task` once. `tx` names the journal record whose hash is evidence. */
async function step(
  label: string,
  task: () => Promise<unknown>,
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

/**
 * Read a user's dashboard at or after both users' confirmed transactions,
 * so a read never misses the other user's latest change.
 */
function dashboard(user: User) {
  const height = [users.a, users.b]
    .map((s) => BigInt(s.stateHeight))
    .reduce((x, y) => (x > y ? x : y));
  return readDashboard(c, { ...users[user], stateHeight: height.toString() });
}
async function state(a: bigint, b: bigint, count: number) {
  for (const [user, balance] of [
    ["a", a],
    ["b", b],
  ] as const) {
    const { balance: actual, entries } = await dashboard(user);
    assert.equal(actual, balance, `balance of ${user}`);
    assert.equal(entries.length, count, `activity of ${user}`);
  }
}

/** A stable 32-byte operation ID per step, so a rerun reuses its journal. */
const operationFor = (label: string) =>
  `0x${createHash("sha256").update(`${dir}:${label}`).digest("hex")}`;
/** Each request's row ID, for the approval or decline that follows. */
const requests = new Map<string, string>();

async function act(
  label: string,
  user: User,
  action: Intent["action"],
  amount: string,
  request?: string,
) {
  const operation = operationFor(label);
  if (action === "request")
    requests.set(label, entryId(address(user), operation));
  await step(
    label,
    () =>
      payments(c, users[user], persist(user), () => {}).execute({
        action,
        amount,
        recipient: address(user === "a" ? "b" : "a"),
        operation,
        id: request ? requests.get(request)! : "",
      }),
    [users[user], `${operation}:${action}`],
  );
}

async function scenario() {
  for (const user of ["a", "b"] as const) {
    await step(
      `fund-${user}`,
      () =>
        fund(c, funder, address(user), () =>
          save(`${dir}/funder.json`, funder),
        ),
      [funder, `fund:${address(user)}`],
    );
    await step(
      `register-${user}`,
      () => payments(c, users[user], persist(user), () => {}).setup(),
      [users[user], "registration"],
    );
  }
  await step("initial", () => state(100n, 100n, 0));
  await act("send7", "a", "send", "7");
  await step("after-send", () => state(93n, 107n, 1));
  await act("request20", "b", "request", "20");
  await act("approve20", "a", "approve", "20", "request20");
  await step("after-approve", () => state(73n, 127n, 2));
  await act("request5", "b", "request", "5");
  await act("decline5", "a", "decline", "5", "request5");
  await step("after-decline", () => state(73n, 127n, 3));
  await act("request9", "a", "request", "9");
  await act("approve9", "b", "approve", "9", "request9");
  await step("after-reverse", () => state(82n, 118n, 4));
  await step(
    "external3",
    () => transferCredits(c, users.b, address("a"), 3n, persist("b")),
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
const [a, b] = await Promise.all([dashboard("a"), dashboard("b")]).catch(
  (error: unknown) => {
    throw failure ?? error;
  },
);
writeEvidence(c, local, {
  result: failure ? "failed" : "passed",
  ...(failure ? { failure: failureText(failure) } : {}),
  balances: { a: a.balance.toString(), b: b.balance.toString() },
  activity: { a: Number(a.count), b: Number(b.count) },
  transactions,
});
if (failure) throw failure;
console.log("Canonical balances 85/115, four activity records each.");
