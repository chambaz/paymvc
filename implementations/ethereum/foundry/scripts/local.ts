import { spawn } from "node:child_process";
import { setTimeout } from "node:timers/promises";

// This launcher is never included in the production bundle. All local funding uses Anvil explicitly.
const anvil = spawn(
  "anvil",
  ["--host", "127.0.0.1", "--port", "8545", "--silent"],
  { stdio: ["ignore", "ignore", "inherit"] },
);
let vite: ReturnType<typeof spawn> | undefined;
const stop = () => {
  anvil.kill("SIGTERM");
  vite?.kill("SIGTERM");
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
anvil.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
  stop();
});
anvil.on("exit", (code) => {
  if (code) {
    process.exitCode = code;
    stop();
  }
});
try {
  let ready = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const res = await fetch("http://127.0.0.1:8545", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_chainId",
          params: [],
        }),
      });
      if (res.ok) {
        ready = true;
        break;
      }
    } catch {
      /* Wait for child startup. */
    }
    await setTimeout(100);
  }
  if (!ready) throw new Error("Anvil did not start.");
  const deploy = spawn(
    process.execPath,
    ["--import", "tsx", "scripts/deploy.ts", "--local"],
    { stdio: "inherit" },
  );
  const code = await new Promise<number | null>((resolve) =>
    deploy.on("exit", resolve),
  );
  if (code !== 0) throw new Error("Local deployment failed.");
  vite = spawn(
    "npm",
    ["run", "dev", "--", "--port", process.env.PAYMVC_DEV_PORT ?? "5173"],
    {
      stdio: "inherit",
      env: { ...process.env, VITE_DEPLOYMENT_URL: "/local.json" },
    },
  );
  await new Promise((resolve) => vite!.on("exit", resolve));
} finally {
  stop();
}
