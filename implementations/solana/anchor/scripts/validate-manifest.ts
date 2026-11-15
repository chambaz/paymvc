import { readFile, readdir } from "node:fs/promises";
import Ajv from "ajv";
import { validateEvidence } from "./evidence";

const schema = JSON.parse(await readFile("implementation.schema.json", "utf8"));
const manifest = JSON.parse(await readFile("implementation.json", "utf8"));
const validate = new Ajv({ strict: true }).compile(schema);
if (!validate(manifest)) throw new Error(JSON.stringify(validate.errors));
const files = (await readdir("evidence").catch(() => [])).filter((file) =>
  file.endsWith(".json"),
);
for (const file of files)
  validateEvidence(
    `evidence/${file}`,
    JSON.parse(await readFile(`evidence/${file}`, "utf8")),
  );
console.log(
  `Implementation manifest and ${files.length} evidence files are valid.`,
);
