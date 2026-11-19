import { spawnSync } from "node:child_process";

// `anchor build` reports a stack frame above the 4 KB SBF limit as an error but still exits
// with success. An oversized frame can corrupt memory at run time, so fail the build here.
const result = spawnSync(
  "anchor",
  ["build", "--ignore-keys", "--tools-version", "v1.57"],
  { encoding: "utf8", stdio: ["inherit", "pipe", "pipe"] },
);
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
if (result.status !== 0) process.exit(result.status ?? 1);
if (
  /overflows the maximum allowed frame space/.test(
    result.stdout + result.stderr,
  )
) {
  console.error(
    "A program function uses more than the 4 KB stack frame. Box large accounts.",
  );
  process.exit(1);
}
