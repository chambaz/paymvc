import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import Ajv from "ajv";
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

function git(...args: string[]) {
  try {
    return execFileSync("git", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Records one run in `evidence/<network>.json`. Other sections stay when the
 * deployment is the same. A local chain or a working tree with uncommitted
 * changes writes `.local/evidence-<network>.json` instead.
 */
export function writeEvidence(
  c: Deployment,
  local: boolean,
  result: Result,
  viewport?: Viewport,
) {
  const revision = git("rev-parse", "HEAD");
  if (!revision) {
    console.log("Evidence not saved: this folder is not a Git checkout.");
    return;
  }
  const manifest = read("implementation.json");
  // Only this implementation counts. Earlier runs update `evidence/`, so it is excluded.
  const dirty = git("status", "--porcelain", "--", ".", ":!evidence") !== "";
  const path =
    local || dirty
      ? `.local/evidence-${c.network}.json`
      : `evidence/${c.network}.json`;
  const deployment = { package: c.package, app: c.app };
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
    revision,
    date: new Date().toISOString(),
    ...result,
  };
  if (viewport) {
    const browser = (evidence.browser ?? []).filter(
      (entry) => entry.viewport !== viewport,
    );
    browser.push({ ...run, viewport });
    browser.sort((x, y) => x.viewport.localeCompare(y.viewport));
    evidence.browser = browser;
  } else evidence.chain = run;
  validateEvidence(evidence, path);
  mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  writeFileSync(path, JSON.stringify(evidence, null, 2) + "\n");
  if (path.startsWith(".local/"))
    console.log(
      `Evidence saved to ${path}: ${local ? "local chain" : "uncommitted changes"}, not public evidence.`,
    );
  else console.log(`Evidence saved to ${path}.`);
}
