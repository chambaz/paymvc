import { describe, expect, it } from "vitest";
import { readableError, simulationError } from "../../src/chain/errors";

/** An error from the SDK's HTTP client, which attaches the response. */
const httpError = (status: number) =>
  Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status },
  });

describe("RPC failures", () => {
  it("names rate limits and outages", () => {
    expect(readableError(httpError(429))).toMatch(/rate-limiting/);
    expect(readableError(httpError(503))).toMatch(/temporarily unavailable/);
    expect(readableError(httpError(404))).toMatch(/could not complete/);
  });

  it("explains a timeout, a failed fetch, and a JSON-RPC error", () => {
    expect(readableError(new Error("timeout of 30000ms exceeded"))).toMatch(
      /did not respond in time/,
    );
    expect(readableError(new TypeError("Failed to fetch"))).toMatch(
      /could not complete/,
    );
    expect(readableError({ code: -32600, message: "invalid" })).toMatch(
      /could not complete/,
    );
  });

  it("hides any message with a URL", () => {
    expect(
      readableError(new Error("POST https://rpc.example/secret-key failed")),
    ).not.toContain("secret-key");
  });

  it("keeps the chain module's own messages", () => {
    expect(
      readableError(new Error(simulationError("Error(Contract, #2)"))),
    ).toBe("Choose a different, registered PayMVC account.");
  });
});
