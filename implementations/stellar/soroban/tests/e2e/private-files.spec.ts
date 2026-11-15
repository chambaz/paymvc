import { mkdirSync, writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

test("development server refuses private signing files", async ({
  request,
}) => {
  mkdirSync(".local", { recursive: true, mode: 0o700 });
  writeFileSync(".local/access-test.txt", "private test marker", {
    mode: 0o600,
  });
  const response = await request.get("/.local/access-test.txt");
  expect(response.status()).toBe(403);
  expect(await response.text()).not.toContain("private test marker");
});
