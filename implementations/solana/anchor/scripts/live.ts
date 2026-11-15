import { readFileSync, writeFileSync } from "node:fs";
import { getTransferCheckedInstruction } from "@solana-program/token";
import { deploymentKey, pda } from "../src/chain/config";
import {
  newSession,
  accountFor,
  signerFor,
  operationId,
  type Session,
  type Intent,
} from "../src/chain/session";
import { payments, entryAddress, tokenAddress } from "../src/chain/payments";
import { transact } from "../src/chain/transactions";
import { liveDirectory } from "./live-directory";
import { fund, liveDeployment } from "./live-network";
import { finishRun, writeEvidence, type Step } from "./evidence";

const c = liveDeployment();
const transactions: Step[] = [];

async function user(label: "a" | "b") {
  const path = `${liveDirectory}/session-${c.genesisHash}-${c.program}-${label}.json`;
  let session: Session;
  try {
    session = JSON.parse(readFileSync(path, "utf8"));
    if (session.version !== 2 || session.deployment !== deploymentKey(c))
      throw new Error("Session deployment mismatch.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    session = await newSession(c);
  }
  const persist = () =>
    writeFileSync(path, JSON.stringify(session), { mode: 0o600 });
  persist();
  const address = accountFor(session).address;
  console.log(`User ${label}: ${address}`);
  return {
    label,
    session,
    persist,
    address,
    app: payments(c, session, persist, console.log),
  };
}
type User = Awaited<ReturnType<typeof user>>;

/** Record the confirmed signature of a journal entry in scenario order. */
function record(user: User, step: string, journal: string) {
  transactions.push({
    step: `${user.label}:${step}`,
    hash: user.session.journal[journal]!.hash,
  });
}
async function start(user: User) {
  // Setup funding is needed only before the first signature, as in the app.
  if (!Object.keys(user.session.journal).length) await fund(c, user.address);
  await user.app.setup();
  record(user, "register", "register");
}
async function execute(
  user: User,
  other: User,
  label: string,
  action: Intent["action"],
  amount: string,
  id = "",
) {
  const operation = operationId(label);
  await user.app.execute({
    action,
    recipient: other.address,
    amount,
    id,
    operation,
  });
  record(user, `${action} ${amount}`, operation);
}
async function request(
  requester: User,
  payer: User,
  label: string,
  amount: string,
  action: "approve" | "decline",
) {
  await execute(requester, payer, label, "request", amount);
  const id = await entryAddress(c, requester.address, operationId(label));
  await execute(payer, requester, `${label}:${action}`, action, amount, id);
}

const a = await user("a");
const b = await user("b");
let failure: unknown;
try {
  await start(a);
  await start(b);
  await execute(a, b, "send-7", "send", "7");
  await request(b, a, "request-20", "20", "approve");
  await request(b, a, "request-5", "5", "decline");
  await request(a, b, "request-9", "9", "approve");
  await transact(c, b.session, b.persist, console.log, "external", async () => [
    getTransferCheckedInstruction({
      source: await tokenAddress(c, b.address),
      mint: await pda(c, "mint"),
      destination: await tokenAddress(c, a.address),
      authority: await signerFor(b.session),
      amount: 3n,
      decimals: 0,
    }),
  ]);
  record(b, "external transfer 3", "external");
} catch (error) {
  failure = error;
}
const run = await finishRun(
  c,
  { a: a.address, b: b.address },
  transactions,
  failure,
);
await writeEvidence(c, { chain: run });
if (run.failure) throw new Error(run.failure);
console.log(`Independent-user ${c.network} scenario passed.`);
