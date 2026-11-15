import { existsSync, readdirSync, readFileSync } from "node:fs";
import Ajv from "ajv";
import { validateEvidence } from "./evidence";

const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const validate = new Ajv({ strict: true }).compile(
  read("implementation.schema.json"),
);
if (!validate(read("implementation.json")))
  throw new Error(JSON.stringify(validate.errors));
const files = existsSync("evidence")
  ? readdirSync("evidence").filter((name) => name.endsWith(".json"))
  : [];
for (const file of files)
  validateEvidence(read(`evidence/${file}`), `evidence/${file}`);
console.log(
  `Implementation manifest and ${files.length} evidence files are valid.`,
);
