import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { Address } from "@stellar/stellar-sdk";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { z } from "zod";
import type { Deployment } from "../src/chain/config";
import { readContract } from "../src/chain/transactions";

export type Viewport = "desktop" | "mobile";
type Run = {
  revision: string;
  date: string;
  viewport?: Viewport;
  result: "passed" | "failed";
  failure?: string;
  balances: { a: string; b: string };
  activity: { a: number; b: number };
  transactions: { step: string; hash: string }[];
};
type Evidence = {
  specVersion: string;
  implementation: string;
  network: string;
  deployment: Record<string, string>;
  chain?: Run;
  browser?: Run[];
};

/** The scenario transactions in order, with the user who signs each one. */
const steps = [
  ["register-a", "a"],
  ["register-b", "b"],
  ["send-7", "a"],
  ["request-20", "b"],
  ["approve-20", "a"],
  ["request-5", "b"],
  ["decline-5", "a"],
  ["request-9", "a"],
  ["approve-9", "b"],
  ["external-transfer-3", "b"],
] as const;

const git = (...args: string[]) =>
  execFileSync("git", args, { encoding: "utf8" }).trim();

/** True if this implementation has uncommitted changes outside evidence/. */
const dirty = () =>
  git("status", "--porcelain", "--", ".", ":!evidence") !== "";

/** Successful transactions that each user signed, merged in ledger order. */
async function transactions(c: Deployment, users: { a: string; b: string }) {
  const signed = await Promise.all(
    (["a", "b"] as const).map(async (user) => {
      const url = `${c.horizonUrl}/accounts/${users[user]}/transactions?order=asc&limit=200`;
      const response = await fetch(url, {
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok)
        throw new Error(`Horizon returned ${response.status} for ${url}.`);
      const body = (await response.json()) as {
        _embedded: {
          records: {
            hash: string;
            source_account: string;
            paging_token: string;
          }[];
        };
      };
      return body._embedded.records
        .filter((record) => record.source_account === users[user])
        .map((record) => ({ ...record, user }));
    }),
  );
  const ordered = signed
    .flat()
    .sort((x, y) => Number(BigInt(x.paging_token) - BigInt(y.paging_token)));
  return ordered.slice(0, steps.length).map((record, index) => {
    const [step, user] = steps[index]!;
    if (record.user !== user)
      throw new Error(`Transaction ${record.hash} is not step ${step}.`);
    return { step, hash: record.hash };
  });
}

async function state(c: Deployment, owner: string) {
  const address = new Address(owner).toScVal();
  const [balance, count] = await Promise.all([
    readContract(c, owner, c.token, "balance", [address]),
    readContract(c, owner, c.contract, "activity_count", [address]),
  ]);
  return { balance: z.bigint().parse(balance), count: z.bigint().parse(count) };
}

/**
 * Records one scenario run for users A and B. `viewport` selects the browser
 * section; without it the run replaces the chain section. Public evidence is
 * written only on a public network with no uncommitted changes in this folder.
 */
export async function recordEvidence(
  c: Deployment,
  users: { a: string; b: string },
  options: { viewport?: Viewport; failure?: unknown } = {},
) {
  const [a, b] = await Promise.all([state(c, users.a), state(c, users.b)]);
  let hashes = await transactions(c, users);
  // Horizon can lag the RPC by a few ledgers.
  for (
    let i = 0;
    !options.failure && hashes.length < steps.length && i < 15;
    i++
  ) {
    await sleep(2_000);
    hashes = await transactions(c, users);
  }
  const passed =
    !options.failure &&
    a.balance === 85n &&
    b.balance === 115n &&
    a.count === 4n &&
    b.count === 4n &&
    hashes.length === steps.length;
  const run: Run = {
    revision: git("rev-parse", "HEAD"),
    date: new Date().toISOString(),
    ...(options.viewport && { viewport: options.viewport }),
    result: passed ? "passed" : "failed",
    ...(!passed && {
      failure:
        options.failure instanceof Error
          ? options.failure.message.split("\n")[0]!
          : "The final state does not match the scenario.",
    }),
    balances: { a: String(a.balance), b: String(b.balance) },
    activity: { a: Number(a.count), b: Number(b.count) },
    transactions: hashes,
  };

  const manifest = JSON.parse(await readFile("implementation.json", "utf8"));
  const deployment = { contract: c.contract, token: c.token };
  const local = c.network === "localnet";
  const path =
    local || dirty()
      ? `.local/evidence-${c.network}.json`
      : `evidence/${c.network}.json`;
  let evidence: Evidence = {
    specVersion: manifest.specVersion,
    implementation: manifest.id,
    network: c.network,
    deployment,
  };
  try {
    const saved: Evidence = JSON.parse(await readFile(path, "utf8"));
    if (
      saved.specVersion === evidence.specVersion &&
      isDeepStrictEqual(saved.deployment, deployment)
    )
      evidence = saved;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (run.viewport)
    evidence.browser = [
      ...(evidence.browser ?? []).filter((r) => r.viewport !== run.viewport),
      run,
    ].sort((x, y) => x.viewport!.localeCompare(y.viewport!));
  else evidence.chain = run;

  validateEvidence(evidence);
  await mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  await writeFile(path, `${JSON.stringify(evidence, null, 2)}\n`);
  if (path.startsWith(".local/"))
    console.log(
      `Evidence written to ${path} (${local ? "local network" : "uncommitted changes"}); public evidence needs a public network and no uncommitted changes in this folder.`,
    );
  else console.log(`Evidence written to ${path}.`);
  return run;
}

const ajv = new Ajv({ strict: true });
addFormats(ajv);
const validate = ajv.compile(
  JSON.parse(await readFile("evidence.schema.json", "utf8")),
);
/** Throws if `evidence` does not follow evidence.schema.json. */
export function validateEvidence(evidence: unknown, name = "Evidence") {
  if (!validate(evidence))
    throw new Error(`${name} is invalid: ${ajv.errorsText(validate.errors)}`);
}
