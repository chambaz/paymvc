import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { encodeFunctionData, erc20Abi, formatEther } from "viem";
import { deploymentKey } from "../src/chain/config";
import {
  newSession,
  accountFor,
  operationId,
  type Session,
  type Intent,
} from "../src/chain/session";
import { entryId, payments, readDashboard } from "../src/chain/payments";
import { transact } from "../src/chain/transactions";
import { liveDirectory } from "./live-directory";
import { writeEvidence, type Step } from "./evidence";
import {
  config,
  fund,
  saveSession,
  scenarioBudget,
  target,
} from "./live-target";

const steps: Step[] = [];
async function user(label: "a" | "b") {
  const path = join(liveDirectory, `v2-${config.address}-${label}.json`);
  const session: Session = existsSync(path)
    ? JSON.parse(readFileSync(path, "utf8"))
    : newSession(config);
  if (session.version !== 2 || session.deployment !== deploymentKey(config))
    throw new Error("The saved session belongs to another deployment.");
  const persist = () => saveSession(path, session);
  persist();
  const address = accountFor(session).address;
  const budget = await scenarioBudget(address);
  console.log(`User ${label}: ${address}, budget ${formatEther(budget)}.`);
  await fund(address, budget);
  return {
    label,
    session,
    persist,
    address,
    engine: payments(config, session, persist, console.log),
    /** Records the transaction saved under `journal` for this scenario step. */
    record(step: string, journal: string) {
      const saved = session.journal[journal];
      if (saved) steps.push({ step: `${label} ${step}`, hash: saved.hash });
    },
  };
}
type User = Awaited<ReturnType<typeof user>>;

async function execute(
  from: User,
  to: User,
  label: string,
  action: Intent["action"],
  amount: string,
  id = "",
) {
  const operation = operationId(label);
  await from.engine.execute({
    action,
    recipient: to.address,
    amount,
    id,
    operation,
  });
  from.record(`${action} ${amount}`, operation);
}
async function request(
  requester: User,
  payer: User,
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
    entryId(requester.address, operationId(label)),
  );
}

const a = await user("a");
const b = await user("b");
for (const each of [a, b]) {
  await each.engine.setup();
  each.record("register", "register");
}
await execute(a, b, "send-7", "send", "7");
await request(b, a, "request-20", "20", "approve");
await request(b, a, "request-5", "5", "decline");
await request(a, b, "request-9", "9", "approve");
await transact(
  config,
  b.session,
  b.persist,
  console.log,
  "external-transfer",
  config.token,
  encodeFunctionData({
    abi: erc20Abi,
    functionName: "transfer",
    args: [a.address, 3n],
  }),
);
b.record("external transfer 3", "external-transfer");

const [dashboardA, dashboardB] = await Promise.all([
  readDashboard(config, a.session, 50),
  readDashboard(config, b.session, 50),
]);
if (
  dashboardA.balance !== 85n ||
  dashboardB.balance !== 115n ||
  dashboardA.count !== 4n ||
  dashboardB.count !== 4n
)
  throw new Error(
    "Expected balances 85/115 and four activity records per user.",
  );
writeEvidence(target, {
  balances: {
    a: dashboardA.balance.toString(),
    b: dashboardB.balance.toString(),
  },
  activity: { a: Number(dashboardA.count), b: Number(dashboardB.count) },
  transactions: steps,
});
console.log("Independent-user live scenario passed.");
