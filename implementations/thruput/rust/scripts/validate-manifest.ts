import { readFile } from "node:fs/promises";
import Ajv from "ajv";
const schema = JSON.parse(await readFile("implementation.schema.json", "utf8"));
const manifest = JSON.parse(await readFile("implementation.json", "utf8"));
const validate = new Ajv({ strict: true }).compile(schema);
if (!validate(manifest)) throw new Error(JSON.stringify(validate.errors));
console.log("Implementation manifest is valid.");
