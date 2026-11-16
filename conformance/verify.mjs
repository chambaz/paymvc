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
];

// Presentation and policy code that every implementation shares unchanged.
const shared = [
  "src/hooks/use-demo.ts",
  "src/components/payments-view.tsx",
  "src/components/theme-toggle.tsx",
  "src/chain/recovery.ts",
  "src/lib/utils.ts",
  "src/styles.css",
  "index.html",
  "public/theme.js",
  "public/favicon.svg",
  "public/favicon.ico",
  "public/apple-touch-icon.png",
  ...(await readdir(join(reference, "src/components/ui"))).map(
    (file) => `src/components/ui/${file}`,
  ),
];

const read = (path) => readFile(path, "utf8").catch(() => undefined);
const sameBytes = async (a, b) => {
  const [left, right] = await Promise.all([readFile(a), readFile(b)]);
  return left.equals(right);
};

async function implementations() {
  const cwd = process.cwd();
  if (cwd !== root) return [cwd];
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

// A light check; each implementation validates evidence fully against its schema copy.
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
  ])
    if (!(field in evidence)) problems.push(`${path} has no ${field}`);
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
  const ui = await readdir(join(folder, "src/components/ui")).catch(() => []);
  for (const file of ui)
    if (!shared.includes(`src/components/ui/${file}`))
      failures.push(`${name}/src/components/ui/${file} is not shared`);
}
if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log("Shared files and test snapshots match.");
