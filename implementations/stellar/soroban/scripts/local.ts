import { spawnSync } from "node:child_process";

const name = "paymvc-stellar";
const image =
  "stellar/quickstart@sha256:91c30991141f6983d151577d3b7cea12eff046b5703520557a8b06aca4db1f0c";
const inspect = spawnSync(
  "docker",
  ["inspect", "--format", "{{.State.Running}}", name],
  { encoding: "utf8" },
);
const args =
  inspect.status === 0
    ? ["start", name]
    : [
        "run",
        "-d",
        "--name",
        name,
        "-p",
        "127.0.0.1:8000:8000",
        image,
        "--local",
        "--enable",
        "rpc,horizon",
      ];
if (inspect.stdout.trim() !== "true") {
  const result = spawnSync("docker", args, { stdio: "inherit" });
  if (result.status !== 0)
    throw new Error(
      "Could not start the local Stellar network. Check Docker access.",
    );
}
console.log(
  "Local Stellar container is running. RPC: http://127.0.0.1:8000/rpc",
);
console.log(
  "Wait for getHealth to report healthy, then run LOCAL=1 npm run deploy.",
);
