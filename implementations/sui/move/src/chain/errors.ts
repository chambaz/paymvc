/** Messages for the abort codes in contracts/sources/paymvc.move. */
const abortCodes: Record<number, string> = {
  1: "This wallet is already registered.",
  2: "Choose a different, registered PayMVC account.",
  3: "Choose a different, registered PayMVC account.",
  4: "Enter a whole amount from 1 to 1,000,000.",
  5: "The operation ID is invalid. Start the operation again.",
  6: "This operation is already recorded. Refresh to see it.",
  7: "This request was not found. Refresh and try again.",
  8: "Only the requested payer can respond to this request.",
  9: "This request has already been resolved. Refresh its status.",
};

/**
 * A fixed message for an RPC failure. SDK messages can hold the endpoint URL, which
 * can hold a provider key, so the user never sees them.
 */
function rpcFailure(code?: string) {
  if (code === "RESOURCE_EXHAUSTED")
    return "The RPC is rate-limiting requests. Your progress is saved. Wait a moment, then retry.";
  if (code === "UNAVAILABLE")
    return "The RPC is temporarily unavailable. Your progress is saved. Retry when it responds.";
  if (code === "DEADLINE_EXCEEDED")
    return "The RPC did not respond in time. Your progress is saved. Retry to check the same transactions.";
  return "The RPC could not complete this step. Your progress is saved. Retry to check the original transactions.";
}

/** True for a browser fetch that failed before any response. */
const networkFailure = (error: Error) =>
  error instanceof TypeError &&
  /fetch|network|load failed/i.test(error.message);

/** True when a message names a URL. It is not shown, because a URL can hold a key. */
const hasUrl = (message: string) => /[a-z][a-z0-9+.-]*:\/\//i.test(message);

/** Turn an error into a short message for the user. Never includes RPC URLs or signed data. */
export function readableError(error: unknown) {
  if (!(error instanceof Error))
    return "This step could not be completed. Please retry.";
  // The SDK reports a Move abort as "MoveAbort …, abort code: N, in '0x…::paymvc::…'".
  const abort = /abort code: (\d+), in '0x[0-9a-f]+::paymvc::/.exec(
    error.message,
  );
  const failed =
    "The transaction would fail on-chain. Nothing was sent. Check your credits and SUI, then retry.";
  if (abort) return abortCodes[Number(abort[1])] ?? failed;
  if (/MoveAbort/.test(error.message)) return failed;
  // The gRPC transport reports a failed call as an RpcError with a status code.
  if (error.name === "RpcError")
    return rpcFailure((error as { code?: string }).code);
  if (networkFailure(error) || hasUrl(error.message)) return rpcFailure();
  // The chain module's own errors carry user-facing text.
  return error.message;
}
