import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { Ajv } from "ajv";
import addFormats from "ajv-formats";
import type { Deployment } from "../src/chain/config";

export type Viewport = "desktop" | "mobile";
export interface Run {
  revision: string;
  date: string;
  result: "passed" | "failed";
  failure?: string;
  balances: { a: string; b: string };
  activity: { a: number; b: number };
  transactions: { step: string; hash: string }[];
}
export interface Evidence {
  specVersion: string;
  implementation: string;
  network: string;
  deployment: Record<string, string>;
  chain?: Run;
  browser?: (Run & { viewport: Viewport })[];
}
export type Result = Omit<Run, "revision" | "date">;

const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const ajv = new Ajv({ strict: true });
addFormats(ajv);
const validate = ajv.compile<Evidence>(read("evidence.schema.json"));

export function validateEvidence(value: unknown, name: string) {
  if (!validate(value))
    throw new Error(`${name} is invalid: ${ajv.errorsText(validate.errors)}`);
}

/** The first line of an error, without terminal colors, for `failure`. */
export function failureText(error: unknown) {
  const text = error instanceof Error ? error.message : String(error);
  return text
    .replace(/\x1b\[[0-9;]*m/g, "")
    .trim()
    .split("\n")[0]!;
}

function git(...args: string[]) {
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

/**
 * Records one run in `evidence/<network>.json`. Other sections stay when the
 * deployment is the same. A local chain or uncommitted changes in this
 * implementation write `.local/evidence-<network>.json` instead.
 */
export function writeEvidence(
  c: Deployment,
  local: boolean,
  result: Result,
  viewport?: Viewport,
) {
  const manifest = read("implementation.json");
  // Earlier runs update `evidence/`, so those changes do not make the tree dirty.
  const dirty =
    git("status", "--porcelain", "--", ".", ":(exclude)evidence") !== "";
  const path =
    local || dirty
      ? `.local/evidence-${c.network}.json`
      : `evidence/${c.network}.json`;
  const deployment = { package: c.package, metadata: c.metadata };
  const previous: Evidence | null = existsSync(path) ? read(path) : null;
  const evidence: Evidence =
    previous && isDeepStrictEqual(previous.deployment, deployment)
      ? previous
      : {
          specVersion: manifest.specVersion,
          implementation: manifest.id,
          network: c.network,
          deployment,
        };
  evidence.specVersion = manifest.specVersion;
  const run: Run = {
    revision: git("rev-parse", "HEAD"),
    date: new Date().toISOString(),
    ...result,
  };
  if (viewport) {
    evidence.browser = [
      ...(evidence.browser ?? []).filter(
        (entry) => entry.viewport !== viewport,
      ),
      { ...run, viewport },
    ].sort((x, y) => x.viewport.localeCompare(y.viewport));
  } else evidence.chain = run;
  validateEvidence(evidence, path);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, JSON.stringify(evidence, null, 2) + "\n");
  renameSync(`${path}.tmp`, path);
  if (path.startsWith(".local/"))
    console.log(
      `Evidence saved to ${path}: ${local ? "local chain" : "uncommitted changes"}, not public evidence.`,
    );
  else console.log(`Evidence saved to ${path}.`);
}
