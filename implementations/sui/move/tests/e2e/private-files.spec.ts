import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

// Probe files stand in for keys, so the check also works on a fresh checkout.
// Real key files are never written or read here.
const probes = [
  ".local/access-test.txt",
  ".local/sui-localnet/access-test.txt",
];

test("development server refuses private signing files", async ({
  request,
}) => {
  for (const path of probes) {
    mkdirSync(path.slice(0, path.lastIndexOf("/")), {
      recursive: true,
      mode: 0o700,
    });
    writeFileSync(path, "private test marker", { mode: 0o600 });
  }
  try {
    for (const path of probes) {
      const response = await request.get(`/${path}`);
      expect(response.status()).toBe(403);
      expect(await response.text()).not.toContain("private test marker");
    }
  } finally {
    for (const path of probes) rmSync(path, { force: true });
  }
});
