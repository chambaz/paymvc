import { describe, expect, it } from "vitest";
import { AptosApiError, AptosApiType } from "@aptos-labs/ts-sdk";
import { readableError } from "../../src/chain/errors";

// A keyed provider URL. The SDK puts it in its error messages.
const url = "https://aptos-testnet.example/v2/secret-key/v1/accounts/0x1";
const apiError = (status: number) =>
  new AptosApiError({
    apiType: AptosApiType.FULLNODE,
    aptosRequest: { url, method: "GET" },
    aptosResponse: {
      status,
      statusText: "Error",
      data: { message: "failed", error_code: "web_framework_error" },
      url,
      headers: {},
      config: {},
      request: {},
    },
  });

describe("RPC failures", () => {
  it("never shows the provider URL", () => {
    const error = apiError(429);
    expect(error.message).toContain("secret-key");
    for (const status of [400, 429, 500, 503])
      expect(readableError(apiError(status))).not.toContain("secret-key");
  });

  it("names rate limits and outages", () => {
    expect(readableError(apiError(429))).toMatch(/rate-limiting/);
    expect(readableError(apiError(503))).toMatch(/temporarily unavailable/);
    expect(readableError(apiError(400))).toMatch(/could not complete/);
  });

  it("explains a failed fetch and hides any other message with a URL", () => {
    expect(readableError(new TypeError("Failed to fetch"))).toMatch(
      /could not complete/,
    );
    expect(readableError(new Error(`GET ${url} failed`))).not.toContain(
      "secret-key",
    );
  });

  it("keeps the chain module's own messages", () => {
    expect(readableError(new Error("Not enough demo credits."))).toBe(
      "Not enough demo credits.",
    );
  });
});
