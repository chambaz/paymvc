import { existsSync, readdirSync, readFileSync } from "node:fs";
import { validateEvidence, type Evidence } from "./evidence";

const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const manifest = read("implementation.json");
const files = existsSync("evidence")
  ? readdirSync("evidence").filter((name) => name.endsWith(".json"))
  : [];
for (const name of files) {
  const path = `evidence/${name}`;
  const evidence: Evidence = read(path);
  validateEvidence(evidence, path);
  if (evidence.implementation !== manifest.id)
    throw new Error(`${path} names another implementation.`);
  if (`${evidence.network}.json` !== name)
    throw new Error(`${path} records the ${evidence.network} network.`);
}
console.log(`Evidence files valid: ${files.length}.`);
