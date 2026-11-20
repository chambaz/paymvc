import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import Ajv from "ajv";
import type { Address } from "@solana/kit";
import { pda, type Deployment } from "../src/chain/config";
import { readAccount } from "../src/chain/payments";

export type Step = { step: string; hash: string };
export type Run = {
  revision: string;
  date: string;
  viewport?: "desktop" | "mobile";
  result: "passed" | "failed";
  failure?: string;
  balances: { a: string; b: string };
  activity: { a: number; b: number };
  transactions: Step[];
};
type Section = { chain: Run } | { browser: Run[] };

/** Check evidence against the local copy of the shared schema. */
export function validateEvidence(evidence: unknown, path: string) {
  const validate = new Ajv({
    strict: true,
    formats: {
      "date-time": (value: string) => !Number.isNaN(Date.parse(value)),
    },
  }).compile(JSON.parse(readFileSync("evidence.schema.json", "utf8")));
  if (!validate(evidence))
    throw new Error(`${path} is invalid: ${JSON.stringify(validate.errors)}`);
}

const git = (...args: string[]) =>
  execFileSync("git", args, { encoding: "utf8" }).trim();

/** Read the final state of users A and B from the chain and judge the result. */
export async function finishRun(
  c: Deployment,
  owners: Partial<Record<"a" | "b", Address>>,
  transactions: Step[],
  error?: unknown,
): Promise<Run> {
  const read = async (owner?: Address) =>
    owner ? await readAccount(c, owner).catch(() => undefined) : undefined;
  const [a, b] = await Promise.all([read(owners.a), read(owners.b)]);
  const passed =
    a?.balance === 85n &&
    b?.balance === 115n &&
    a.count === 4n &&
    b.count === 4n;
  const failure = error
    ? // The first line, without terminal colors, is enough to identify a failure.
      (error instanceof Error ? error.message : String(error))
        .replace(/\u001b\[[0-9;]*m/g, "")
        .split("\n")[0]
    : passed
      ? undefined
      : "Expected balances 85/115 and four activity rows per user.";
  return {
    revision: git("rev-parse", "HEAD"),
    date: new Date().toISOString(),
    result: failure ? "failed" : "passed",
    ...(failure && { failure }),
    balances: { a: String(a?.balance ?? 0n), b: String(b?.balance ?? 0n) },
    activity: { a: Number(a?.count ?? 0n), b: Number(b?.count ?? 0n) },
    transactions,
  };
}

/**
 * Replace one section of `evidence/<network>.json` and keep the others while
 * the deployment is unchanged. Local runs and runs with uncommitted changes in
 * this implementation go to `.local/evidence-<network>.json` instead.
 */
export async function writeEvidence(c: Deployment, section: Section) {
  const manifest = JSON.parse(readFileSync("implementation.json", "utf8"));
  const deployment = { program: c.program, mint: await pda(c, "mint") };
  // Check this implementation only. Evidence files are results, not tested code.
  const dirty = git("status", "--porcelain", "--", ".", ":!evidence");
  const draft = c.network === "localnet" || dirty !== "";
  const path = draft
    ? `.local/evidence-${c.network}.json`
    : `evidence/${c.network}.json`;
  const base = {
    specVersion: manifest.specVersion,
    implementation: manifest.id,
    network: c.network,
    deployment,
  };
  const previous = existsSync(path)
    ? JSON.parse(readFileSync(path, "utf8"))
    : undefined;
  const same =
    previous &&
    isDeepStrictEqual(
      [
        previous.specVersion,
        previous.implementation,
        previous.network,
        previous.deployment,
      ],
      Object.values(base),
    );
  const evidence = {
    ...base,
    chain: same ? previous.chain : undefined,
    browser: same ? previous.browser : undefined,
    ...section,
  };
  validateEvidence(evidence, path);
  mkdirSync(draft ? ".local" : "evidence", { recursive: true });
  writeFileSync(path, JSON.stringify(evidence, null, 2) + "\n");
  console.log(
    draft
      ? `Wrote ${path}. Public evidence needs a clean tree on a public network.`
      : `Wrote ${path}.`,
  );
}
