import {
  createCipheriv,
  randomBytes,
  randomUUID,
  scryptSync,
} from "node:crypto";
import { keccak256, toBytes, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

/**
 * Encrypts a private key as a Web3 Secret Storage (version 3) keystore, the format that
 * `forge --keystore` reads. Passing a keystore and a password file keeps the key out of
 * the process command line, which other local users can read.
 */
export function keystore(key: Hex, password: string) {
  const salt = randomBytes(32);
  const iv = randomBytes(16);
  const params = { dklen: 32, n: 1 << 14, r: 8, p: 1 };
  const derived = scryptSync(password, salt, params.dklen, {
    N: params.n,
    r: params.r,
    p: params.p,
    maxmem: 64 * 1024 * 1024,
  });
  const cipher = createCipheriv("aes-128-ctr", derived.subarray(0, 16), iv);
  const ciphertext = Buffer.concat([
    cipher.update(toBytes(key)),
    cipher.final(),
  ]);
  const mac = keccak256(Buffer.concat([derived.subarray(16, 32), ciphertext]));
  return {
    version: 3,
    id: randomUUID(),
    address: privateKeyToAccount(key).address.slice(2).toLowerCase(),
    crypto: {
      cipher: "aes-128-ctr",
      cipherparams: { iv: iv.toString("hex") },
      ciphertext: ciphertext.toString("hex"),
      kdf: "scrypt",
      kdfparams: { ...params, salt: salt.toString("hex") },
      mac: mac.slice(2),
    },
  };
}
