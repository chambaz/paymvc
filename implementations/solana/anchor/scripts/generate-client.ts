import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createFromRoot } from "codama";
import { rootNodeFromAnchor } from "@codama/nodes-from-anchor";
import { renderVisitor } from "@codama/renderers-js";

const idl = JSON.parse(await readFile("target/idl/paymvc.json", "utf8"));
await mkdir("idl", { recursive: true });
await writeFile("idl/paymvc.json", JSON.stringify(idl, null, 2) + "\n");
const codama = createFromRoot(rootNodeFromAnchor(idl));
await codama.accept(
  renderVisitor(".", {
    generatedFolder: "src/chain/generated",
    syncPackageJson: false,
    erasableSyntax: true,
    kitImportStrategy: "rootOnly",
  }),
);
