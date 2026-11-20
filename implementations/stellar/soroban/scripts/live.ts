import { mkdir, readFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import assert from "node:assert/strict";
import { Address, Contract, nativeToScVal } from "@stellar/stellar-sdk";
import { deploymentKey, parseDeployment } from "../src/chain/config";
import {
  accountFor,
  newSession,
  operationId,
  type Session,
  type Intent,
} from "../src/chain/session";
import { payments, readDashboard } from "../src/chain/payments";
import { transact } from "../src/chain/transactions";
import { recordEvidence } from "./evidence";

const local = process.env.LOCAL === "1";
const c = parseDeployment(
  JSON.parse(
    await readFile(
      local ? "public/local.json" : "public/deployment.json",
      "utf8",
    ),
  ),
);
const name = process.env.LIVE_RUN ?? "default";
if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error("Invalid LIVE_RUN name.");
const directory = `.local/live-v2-${c.network}-${c.contract}-${name}`;
await mkdir(directory, { recursive: true, mode: 0o700 });
async function user(label: string) {
  const path = `${directory}/${label}.json`;
  let session: Session;
  try {
    session = JSON.parse(await readFile(path, "utf8"));
    if (session.version !== 2 || session.deployment !== deploymentKey(c))
      throw new Error("Session deployment mismatch.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    session = newSession(c);
  }
  const persist = () =>
    writeFileSync(path, JSON.stringify(session), { mode: 0o600 });
  persist();
  const address = accountFor(session).address;
  console.log(`Test user ${label}: ${address}`);
  const account = await fetch(`${c.horizonUrl}/accounts/${address}`);
  if (account.status === 404) {
    const funded = await fetch(`${c.faucetUrl}?addr=${address}`);
    if (!funded.ok) throw new Error("Fund the test wallet and retry.");
  } else if (!account.ok) throw new Error("Cannot read test account.");
  return {
    session,
    address,
    persist,
    app: payments(c, session, persist, console.log),
  };
}
const a = await user("a");
const b = await user("b");
await a.app.setup();
await b.app.setup();
async function execute(
  user: typeof a,
  other: typeof a,
  label: string,
  action: Intent["action"],
  amount: string,
  id = "0",
) {
  await user.app.execute({
    action,
    recipient: other.address,
    amount,
    id,
    operation: operationId(label),
  });
}
async function request(
  requester: typeof a,
  payer: typeof a,
  label: string,
  amount: string,
  action: "approve" | "decline",
) {
  await execute(requester, payer, label, "request", amount);
  await execute(
    payer,
    requester,
    `${label}:${action}`,
    action,
    amount,
    `${requester.address}:${operationId(label)}`,
  );
}
const users = { a: a.address, b: b.address };
try {
  await execute(a, b, "send-7", "send", "7");
  await request(b, a, "request-20", "20", "approve");
  await request(b, a, "request-5", "5", "decline");
  await request(a, b, "request-9", "9", "approve");
  await transact(
    c,
    b.session,
    b.persist,
    () => {},
    "external",
    async () => [
      new Contract(c.token).call(
        "transfer",
        new Address(b.address).toScVal(),
        new Address(a.address).toScVal(),
        nativeToScVal(3n, { type: "i128" }),
      ),
    ],
  );
  const dashboards = await Promise.all([
    readDashboard(c, a.session),
    readDashboard(c, b.session),
  ]);
  assert.equal(dashboards[0]!.balance, 85n);
  assert.equal(dashboards[1]!.balance, 115n);
  for (const dashboard of dashboards) assert.equal(dashboard.count, 4n);
} catch (failure) {
  await recordEvidence(c, users, { failure }).catch((error) =>
    console.error(`Could not record evidence: ${error}`),
  );
  throw failure;
}
const run = await recordEvidence(c, users);
if (run.result !== "passed") throw new Error(run.failure);
console.log(
  "Independent-user chain scenario passed: 85/115 credits, four records each.",
);
