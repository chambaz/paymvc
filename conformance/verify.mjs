import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, relative, resolve } from "node:path";

// Checks that each implementation's shared files match. Run it from one
// implementation folder to check that folder, or from the repository root to
// check every implementation.
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const reference = join(root, "implementations/ethereum/foundry");

// Local copies of the test contract. They keep a copied folder runnable.
const snapshots = [
  ["conformance/scenario.ts", "tests/conformance/scenario.ts"],
  ["conformance/recovery.test.ts", "tests/conformance/recovery.test.ts"],
  ["conformance/manifest.schema.json", "implementation.schema.json"],
  ["conformance/evidence.schema.json", "evidence.schema.json"],
  // A copied folder keeps the license and the third-party notices.
  ["LICENSE", "LICENSE"],
  ["NOTICE.md", "NOTICE.md"],
];

// Every file in src/components/ is shared view code.
const components = async (folder) =>
  (
    await readdir(join(folder, "src/components"), {
      recursive: true,
      withFileTypes: true,
    }).catch(() => [])
  )
    .filter((entry) => entry.isFile())
    .map((entry) =>
      relative(folder, join(entry.parentPath, entry.name)).replaceAll(
        "\\",
        "/",
      ),
    );

// Presentation and policy code that every implementation shares unchanged.
const shared = [
  "src/hooks/use-demo.ts",
  "src/chain/recovery.ts",
  "scripts/validate-manifest.ts",
  "src/lib/utils.ts",
  "src/styles.css",
  "index.html",
  "public/theme.js",
  "public/favicon.svg",
  "public/favicon.ico",
  "public/apple-touch-icon.png",
  ...(await components(reference)),
];

const read = (path) => readFile(path, "utf8").catch(() => undefined);
const sameBytes = async (a, b) => {
  const [left, right] = await Promise.all([readFile(a), readFile(b)]);
  return left.equals(right);
};

async function implementations() {
  const cwd = process.cwd();
  if (cwd !== root) {
    if ((await read(join(cwd, "implementation.json"))) === undefined) {
      console.error(
        "Run this check from the repository root or from an implementation folder.",
      );
      process.exit(1);
    }
    return [cwd];
  }
  const folders = [];
  for (const chain of await readdir(join(root, "implementations")))
    for (const framework of await readdir(join(root, "implementations", chain)))
      folders.push(join(root, "implementations", chain, framework));
  // A folder is an implementation when it has a manifest.
  const manifests = await Promise.all(
    folders.map((folder) => read(join(folder, "implementation.json"))),
  );
  return folders.filter((_, index) => manifests[index] !== undefined);
}

const failures = [];

// Each site serves the landing page's Caddy configuration. Only the RPC hosts
// in `connect-src` change.
const withoutRpcHosts = (text) =>
  text?.replace(/connect-src 'self'[^;"]*/, "connect-src 'self'");
const caddyfile = await read(join(root, "web/Caddyfile.template"));
// The RPC origins that the hosted site's deployment records call.
async function rpcOrigins(folder) {
  const records = [
    join(folder, "public/deployment.json"),
    ...(await readdir(join(folder, "deployments")).catch(() => []))
      .filter((file) => file.endsWith(".json"))
      .map((file) => join(folder, "deployments", file)),
  ];
  const origins = [];
  for (const path of records) {
    const text = await read(path);
    const rpcUrl = text === undefined ? undefined : JSON.parse(text).rpcUrl;
    if (typeof rpcUrl === "string") origins.push(new URL(rpcUrl).origin);
  }
  return origins;
}

// Each evidence run records the commit it tested. That commit must be in this
// branch's history, so the evidence describes code that was merged. This needs the
// full history: a shallow clone cannot tell.
const git = (...args) =>
  execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
let history;
try {
  history = git("rev-parse", "--is-shallow-repository") === "false";
} catch {
  history = false;
}
const inHistory = (revision) => {
  try {
    git("merge-base", "--is-ancestor", revision, "HEAD");
    return true;
  } catch {
    return false;
  }
};

// Committed evidence is complete: one chain run and one browser run for each
// viewport. Each implementation validates the full shape against its schema copy.
function checkEvidence(path, text) {
  const problems = [];
  let evidence;
  try {
    evidence = JSON.parse(text);
  } catch {
    return [`${path} is not valid JSON`];
  }
  for (const field of [
    "specVersion",
    "implementation",
    "network",
    "deployment",
    "chain",
    "browser",
  ])
    if (!(field in evidence)) problems.push(`${path} has no ${field}`);
  const runs = [
    ["chain", evidence.chain],
    ...["desktop", "mobile"].map((viewport) => [
      `${viewport} browser`,
      Array.isArray(evidence.browser)
        ? evidence.browser.find((run) => run.viewport === viewport)
        : undefined,
    ]),
  ];
  for (const [name, run] of runs) {
    if (!run) {
      problems.push(`${path} has no ${name} run`);
      continue;
    }
    // The shared scenario ends at 85 and 115 credits with four activity rows each.
    if (
      run.result === "passed" &&
      (run.balances?.a !== "85" ||
        run.balances?.b !== "115" ||
        run.activity?.a !== 4 ||
        run.activity?.b !== 4 ||
        !run.transactions?.length)
    )
      problems.push(`${path} ${name} run passed without the scenario result`);
    if (!/^[0-9a-f]{40}$/.test(run.revision ?? ""))
      problems.push(`${path} ${name} run has no commit revision`);
    else if (history && !inHistory(run.revision))
      problems.push(
        `${path} ${name} run tested ${run.revision.slice(0, 8)}, which is not in this branch's history`,
      );
  }
  // Evidence is public. It must never hold keys or signed transactions.
  if (
    /"(seed|secret|privateKey|private_key|mnemonic|raw|signature|key)"\s*:/i.test(
      text,
    )
  )
    problems.push(`${path} contains a field that may hold private material`);
  return problems;
}
for (const folder of await implementations()) {
  const name = relative(root, folder);
  for (const [canonical, local] of snapshots)
    if (
      (await read(join(folder, local))) !== (await read(join(root, canonical)))
    )
      failures.push(`${name}/${local} differs from ${canonical}`);
  if (
    withoutRpcHosts(await read(join(folder, "Caddyfile.template"))) !==
    caddyfile
  )
    failures.push(
      `${name}/Caddyfile.template differs from web/Caddyfile.template outside connect-src`,
    );
  // The browser blocks any RPC host that connect-src does not list.
  const allowed = (
    /connect-src ([^;"]*)/.exec(
      (await read(join(folder, "Caddyfile.template"))) ?? "",
    )?.[1] ?? ""
  ).split(" ");
  for (const origin of await rpcOrigins(folder))
    if (!allowed.includes(origin))
      failures.push(
        `${name}/Caddyfile.template connect-src does not allow ${origin}`,
      );
  for (const file of await readdir(join(folder, "evidence")).catch(() => []))
    if (file.endsWith(".json"))
      failures.push(
        ...checkEvidence(
          `${name}/evidence/${file}`,
          await read(join(folder, "evidence", file)),
        ),
      );
  if (folder === reference) continue;
  for (const file of shared)
    if (
      !(await sameBytes(join(folder, file), join(reference, file)).catch(
        () => false,
      ))
    )
      failures.push(`${name}/${file} differs from the Ethereum implementation`);
  for (const file of await components(folder))
    if (!shared.includes(file))
      failures.push(`${name}/${file} is not in the Ethereum implementation`);
}
if (!history)
  failures.push(
    "Evidence revisions need the full git history. In CI, check out with fetch-depth: 0; locally, run git fetch --unshallow.",
  );
if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log("Shared files and test snapshots match.");
