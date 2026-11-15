import { readdir, readFile } from "node:fs/promises";
import Ajv from "ajv";
import { assertEvidence } from "./evidence";
const schema = JSON.parse(await readFile("implementation.schema.json", "utf8"));
const manifest = JSON.parse(await readFile("implementation.json", "utf8"));
const validate = new Ajv({ strict: true }).compile<{ id: string }>(schema);
if (!validate(manifest)) throw new Error(JSON.stringify(validate.errors));
const evidence = await readdir("evidence").catch((error) => {
  if (error.code === "ENOENT") return [];
  throw error;
});
for (const file of evidence.filter((name) => name.endsWith(".json"))) {
  const record = JSON.parse(await readFile(`evidence/${file}`, "utf8"));
  assertEvidence(record, `evidence/${file}`);
  if (
    file !== `${record.network}.json` ||
    record.implementation !== manifest.id
  )
    throw new Error(
      `evidence/${file} does not match its file name or manifest.`,
    );
}
console.log("Implementation manifest and evidence files are valid.");
