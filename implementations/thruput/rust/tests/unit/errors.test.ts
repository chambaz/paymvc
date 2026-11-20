import { describe, expect, it } from "vitest";
import {
  HttpRequestError,
  HttpResponseError,
  JsonRpcError,
} from "@thruputchain/client";
import { readableError } from "../../src/chain/errors";

const endpoint = "https://rpc.example/secret-key";

describe("RPC failures", () => {
  it("names rate limits and outages", () => {
    const status = (code: number) =>
      readableError(
        new HttpResponseError(code, "Error", endpoint, "getChainTip"),
      );
    expect(status(429)).toMatch(/rate-limiting/);
    expect(status(503)).toMatch(/temporarily unavailable/);
    expect(status(400)).toMatch(/could not complete/);
  });

  it("explains a network or JSON-RPC failure without SDK text", () => {
    const network = new HttpRequestError(
      endpoint,
      "getChainTip",
      new TypeError("Failed to fetch"),
    );
    expect(readableError(network)).toMatch(/could not complete/);
    expect(readableError(network)).not.toContain("secret-key");
    expect(
      readableError(
        Object.assign(Object.create(JsonRpcError.prototype), {
          message: "internal",
        }),
      ),
    ).toMatch(/could not complete/);
  });

  it("hides any message with a URL", () => {
    expect(readableError(new Error(`POST ${endpoint} failed`))).not.toContain(
      "secret-key",
    );
  });

  it("keeps the chain module's own messages", () => {
    expect(readableError(new Error("Not enough demo credits."))).toBe(
      "Not enough demo credits.",
    );
  });
});
