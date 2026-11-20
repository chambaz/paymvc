import { describe, expect, it } from "vitest";
import {
  address,
  SolanaError,
  SOLANA_ERROR__ACCOUNTS__ACCOUNT_NOT_FOUND,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_NODE_UNHEALTHY,
  SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR,
} from "@solana/kit";
import { readableError } from "../../src/chain/errors";

const httpError = (statusCode: number) =>
  new SolanaError(SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, {
    headers: new Headers(),
    message: "Error",
    statusCode,
  });

describe("RPC failures", () => {
  it("names rate limits and outages", () => {
    expect(readableError(httpError(429))).toMatch(/rate-limiting/);
    expect(readableError(httpError(503))).toMatch(/temporarily unavailable/);
    expect(readableError(httpError(403))).toMatch(/could not complete/);
  });

  it("does not show SDK error codes", () => {
    const error = new SolanaError(
      SOLANA_ERROR__JSON_RPC__SERVER_ERROR_NODE_UNHEALTHY,
      { numSlotsBehind: 10 },
    );
    expect(readableError(error)).toMatch(/could not complete/);
  });

  it("names a missing account instead of an RPC failure", () => {
    const error = new SolanaError(SOLANA_ERROR__ACCOUNTS__ACCOUNT_NOT_FOUND, {
      address: address("11111111111111111111111111111111"),
    });
    expect(readableError(error)).toMatch(/was not found/);
  });

  it("explains a failed fetch and hides any message with a URL", () => {
    expect(readableError(new TypeError("Failed to fetch"))).toMatch(
      /could not complete/,
    );
    expect(
      readableError(new Error("POST https://rpc.example/?api-key=secret")),
    ).not.toContain("secret");
  });

  it("keeps the chain module's own messages", () => {
    expect(readableError(new Error("Not enough demo credits."))).toBe(
      "Not enough demo credits.",
    );
  });
});
