import { readdir, readFile } from "node:fs/promises";
import Ajv from "ajv";
import { validateEvidence } from "./evidence";
const schema = JSON.parse(await readFile("implementation.schema.json", "utf8"));
const manifest = JSON.parse(await readFile("implementation.json", "utf8"));
const validate = new Ajv({ strict: true }).compile(schema);
if (!validate(manifest)) throw new Error(JSON.stringify(validate.errors));
console.log("Implementation manifest is valid.");

const files = (
  await readdir("evidence").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  })
).filter((file) => file.endsWith(".json"));
for (const file of files)
  validateEvidence(
    JSON.parse(await readFile(`evidence/${file}`, "utf8")),
    `evidence/${file}`,
  );
console.log(`Evidence files are valid (${files.length}).`);
