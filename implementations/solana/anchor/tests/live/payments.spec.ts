import { test } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { canonicalScenario } from "../conformance/scenario";
import { browserScenario } from "../e2e/driver";
import { fund, liveDeployment } from "../../scripts/live-network";
import { browserResults } from "../../scripts/live-directory";
import { finishRun } from "../../scripts/evidence";

test("canonical scenario on the live network", async ({
  browser,
  viewport,
}, info) => {
  // Read the deployment here: the web server may write it after test discovery.
  const c = liveDeployment();
  const contexts = {
    a: await browser.newContext({ viewport }),
    b: await browser.newContext({ viewport }),
  };
  const pages = {
    a: await contexts.a.newPage(),
    b: await contexts.b.newPage(),
  };
  const { driver, owners, transactions } = browserScenario(c, pages, (owner) =>
    fund(c, owner),
  );
  let failure: unknown;
  try {
    await canonicalScenario(driver);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    await contexts.a.close();
    await contexts.b.close();
    const run = await finishRun(c, owners, transactions, failure);
    writeFileSync(
      `${browserResults}/${info.project.name}.json`,
      JSON.stringify({ ...run, viewport: info.project.name }),
    );
  }
});
