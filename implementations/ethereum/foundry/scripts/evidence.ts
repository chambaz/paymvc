import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { dirname, join } from "node:path";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import type { Deployment } from "../src/chain/config";

export type Viewport = "desktop" | "mobile";
export type Step = { step: string; hash: string };
/** The result of one scenario run. The writer adds the revision and the date. */
export type Result = {
  balances: { a: string; b: string };
  activity: { a: number; b: number };
  transactions: Step[];
};
type Run = Result & {
  revision: string;
  date: string;
  result: "passed" | "failed";
  viewport?: Viewport;
};
type Evidence = {
  specVersion: string;
  implementation: string;
  network: string;
  deployment: Record<string, string>;
  chain?: Run;
  browser?: Run[];
};

const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const ajv = new Ajv({ strict: true, allErrors: true });
addFormats.default(ajv);
const validate = ajv.compile<Evidence>(read("evidence.schema.json"));

/** Throws when `evidence` does not follow `evidence.schema.json`. */
export function assertEvidence(evidence: unknown, path: string) {
  if (!validate(evidence))
    throw new Error(`${path}: ${ajv.errorsText(validate.errors)}`);
}

function git(...args: string[]) {
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

/** The tested commit, and whether this implementation has changes other than its evidence. */
function revision() {
  const changes = git("status", "--porcelain", "--", ".", ":!evidence");
  return { hash: git("rev-parse", "HEAD"), clean: changes === "" };
}

/**
 * Writes one run to `evidence/<network>.json`. A chain run replaces `chain`; a browser run
 * replaces the entry for its viewport. Other sections stay if the deployment is the same.
 * Local runs and runs from a changed working tree go to `.local/evidence-<network>.json`.
 */
export function writeEvidence(
  target: { network: string; local: boolean; deployment: Deployment },
  result: Result,
  viewport?: Viewport,
) {
  const manifest = read("implementation.json");
  const { hash, clean } = revision();
  const path =
    clean && !target.local
      ? join("evidence", `${target.network}.json`)
      : join(".local", `evidence-${target.network}.json`);
  if (path.startsWith(".local"))
    console.log(
      `Evidence is private because the ${target.local ? "chain is local" : "working tree has changes"}: ${path}`,
    );
  const deployment = {
    paymvc: target.deployment.address,
    token: target.deployment.token,
  };
  const previous: Evidence | undefined = existsSync(path)
    ? read(path)
    : undefined;
  // A new deployment starts a new file.
  const kept =
    previous && isDeepStrictEqual(previous.deployment, deployment)
      ? previous
      : undefined;
  const evidence: Evidence = {
    specVersion: manifest.specVersion,
    implementation: manifest.id,
    network: target.network,
    deployment,
    ...(kept?.chain && { chain: kept.chain }),
    ...(kept?.browser && { browser: kept.browser }),
  };
  const run: Run = {
    revision: hash,
    date: new Date().toISOString(),
    ...(viewport ? { viewport } : {}),
    result: "passed",
    ...result,
  };
  if (viewport)
    evidence.browser = [
      ...(evidence.browser ?? []).filter(
        (entry) => entry.viewport !== viewport,
      ),
      run,
    ].sort((a, b) => a.viewport!.localeCompare(b.viewport!));
  else evidence.chain = run;
  assertEvidence(evidence, path);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(evidence, null, 2) + "\n");
  console.log(`Evidence written: ${path}`);
}
