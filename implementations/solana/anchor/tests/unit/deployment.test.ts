import { beforeEach, expect, it, vi } from "vitest";
import {
  address,
  getAddressEncoder,
  getBase64Decoder,
  getU32Encoder,
  getU64Encoder,
  some,
  none,
} from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { parseDeployment, pda } from "../../src/chain/config";

const LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";
const programData = address("C1Xhdt88ESirspBUY9jWGoDH8auRo3URJqjt4dqtZZcG");
const config = parseDeployment({
  network: "localnet",
  rpcUrl: "http://127.0.0.1:8899",
  program: "2LqK3mU8MZ1Hc3nBHqwhpFvH44bqbJJ9YQyEJLH6mywa",
  genesisHash: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
  faucetUrl: "https://faucet.solana.com",
});
const accounts = vi.hoisted(() => new Map<string, unknown>());
const mint = vi.hoisted(() => ({ value: undefined as unknown }));
vi.mock("../../src/chain/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/chain/config")>()),
  rpc: () => ({
    getGenesisHash: () => ({ send: async () => config.genesisHash }),
    getAccountInfo: (key: string) => ({
      send: async () => ({ value: accounts.get(key) ?? null }),
    }),
  }),
}));
vi.mock("@solana-program/token", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@solana-program/token")>()),
  fetchMint: async () => mint.value,
}));
const base64 = (bytes: Uint8Array) => getBase64Decoder().decode(bytes);
/** A loader-v3 ProgramData account with the given upgrade authority option. */
function programDataAccount(authority: Uint8Array) {
  const bytes = new Uint8Array(45);
  bytes.set(getU32Encoder().encode(3), 0);
  bytes.set(getU64Encoder().encode(1n), 4);
  bytes.set(authority, 12);
  return { owner: LOADER, executable: false, data: [base64(bytes), "base64"] };
}
async function load() {
  vi.resetModules();
  return import("../../src/chain/payments");
}
beforeEach(async () => {
  accounts.clear();
  const program = new Uint8Array(36);
  program.set(getU32Encoder().encode(2), 0);
  program.set(getAddressEncoder().encode(programData), 4);
  accounts.set(config.program, {
    owner: LOADER,
    executable: true,
    data: [base64(program), "base64"],
  });
  mint.value = {
    programAddress: TOKEN_PROGRAM_ADDRESS,
    data: {
      decimals: 0,
      mintAuthority: some(await pda(config, "authority")),
      freezeAuthority: none(),
    },
  };
});

it("accepts a program without an upgrade authority", async () => {
  accounts.set(programData, programDataAccount(new Uint8Array([0])));
  await expect((await load()).verifyDeployment(config)).resolves.toBe(
    undefined,
  );
});

it("accepts a local program frozen with the all-zero authority", async () => {
  const frozen = new Uint8Array(33);
  frozen[0] = 1;
  accounts.set(programData, programDataAccount(frozen));
  await expect((await load()).verifyDeployment(config)).resolves.toBe(
    undefined,
  );
});

it("refuses a program that can still be upgraded", async () => {
  const upgradeable = new Uint8Array(33);
  upgradeable[0] = 1;
  upgradeable.set(getAddressEncoder().encode(programData), 1);
  accounts.set(programData, programDataAccount(upgradeable));
  await expect((await load()).verifyDeployment(config)).rejects.toThrow(
    "Deployment verification failed",
  );
});

it("refuses a mint with a freeze authority", async () => {
  accounts.set(programData, programDataAccount(new Uint8Array([0])));
  (mint.value as { data: { freezeAuthority: unknown } }).data.freezeAuthority =
    some(programData);
  await expect((await load()).verifyDeployment(config)).rejects.toThrow(
    "Deployment verification failed",
  );
});
