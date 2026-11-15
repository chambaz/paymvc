/**
 * Run the Thruput CLI with a private configuration directory, so project
 * keys never mix with global keys.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

export class CliError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

/** The private CLI configuration for one network, in `.local/<network>-cli/`. */
export function cliConfig(network: "local" | "futurenet") {
  const dir = resolve(`.local/${network}-cli`);
  mkdirSync(`${dir}/thruput`, { recursive: true, mode: 0o700 });
  return {
    dir,
    env: { ...process.env, XDG_CONFIG_HOME: dir },
    keyName: `${network}-deployer`,
  };
}

/** Run one CLI command with JSON output and return its `data`. */
export function thruput(args: string[], env: NodeJS.ProcessEnv) {
  const run = spawnSync("thruput", [...args, "--json", "--non-interactive"], {
    encoding: "utf8",
    env,
  });
  if (run.error) throw run.error;
  const output = run.stdout.trim() || run.stderr.trim();
  let result;
  try {
    result = JSON.parse(output);
  } catch {
    throw new CliError(`thruput ${args[0]} failed: ${output}`);
  }
  if (!result.ok)
    throw new CliError(
      `thruput ${args[0]} failed: ${JSON.stringify(result.error)}`,
      result.error?.code,
    );
  return result.data;
}

/** Return the address of a stored key, generating the key once. */
export function ensureKey(name: string, env: NodeJS.ProcessEnv): string {
  const keys: { name: string; address: string }[] = thruput(
    ["keys", "ls"],
    env,
  ).keys;
  return (
    keys.find((key) => key.name === name)?.address ??
    thruput(["keys", "generate", name], env).key.address
  );
}
