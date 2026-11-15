import { expect, test } from "@playwright/test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";

// A missing file falls back to index.html, so create a harmless file to probe.
const probe = ".local/private-files-probe.json";

test("development server refuses private signing files", async ({
  request,
}) => {
  mkdirSync(".local", { recursive: true, mode: 0o700 });
  writeFileSync(probe, '{"probe":true}', { mode: 0o600 });
  try {
    const response = await request.get(`/${probe}`);
    expect(response.status()).toBe(403);
    expect(await response.text()).not.toContain('"probe":true');
  } finally {
    rmSync(probe, { force: true });
  }
});
