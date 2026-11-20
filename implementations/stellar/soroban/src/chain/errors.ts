/** Messages for contract error codes. contracts/credits numbers its errors from 100. */
const contractErrors: Record<number, string> = {
  1: "This wallet is already registered.",
  2: "Choose a different, registered PayMVC account.",
  3: "Choose a different, registered PayMVC account.",
  4: "Enter a whole amount from 1 to 1,000,000.",
  5: "The operation ID is invalid. Start the operation again.",
  6: "This operation is already recorded. Refresh to see it.",
  7: "This request was not found. Refresh and try again.",
  8: "Only the requested payer can respond to this request.",
  9: "This request has already been resolved. Refresh its status.",
  101: "Not enough demo credits. No payment was completed.",
};

/**
 * The message for a failed simulation. Nothing was signed, so nothing changed. The RPC
 * reports a contract error as `Error(Contract, #code)`.
 */
export function simulationError(detail: string) {
  const code = /Error\(Contract, #(\d+)\)/.exec(detail)?.[1];
  return (
    (code && contractErrors[Number(code)]) ??
    "The contract could not prepare this step. Check credits and XLM funding, then retry."
  );
}

/**
 * A fixed message for an RPC failure. SDK messages can hold the endpoint URL, which
 * can hold a provider key, so the user never sees them. The failure can come before
 * anything is signed, so the message does not say that progress is saved: the view
 * shows the recovery actions when an operation is saved.
 */
function rpcFailure(status?: number) {
  if (status === 429)
    return "The RPC is rate-limiting requests. Wait a moment, then retry.";
  if (status && status >= 500)
    return "The RPC is temporarily unavailable. Retry when it responds.";
  return "The RPC could not complete this step. Please retry.";
}

/** True for a browser fetch that failed before any response. */
const networkFailure = (error: Error) =>
  error instanceof TypeError &&
  /fetch|network|load failed/i.test(error.message);

/** True when a message names a URL. It is not shown, because a URL can hold a key. */
const hasUrl = (message: string) => /[a-z][a-z0-9+.-]*:\/\//i.test(message);

/** Turn an error into a short message for the user. Never includes RPC URLs or signed data. */
export function readableError(error: unknown) {
  // The RPC reports a JSON-RPC error as a plain object, not an Error.
  if (!(error instanceof Error)) return rpcFailure();
  // The SDK's HTTP client attaches the response to its errors.
  const status = (error as { response?: { status?: unknown } }).response
    ?.status;
  if (typeof status === "number") return rpcFailure(status);
  if (/^timeout of \d+ms exceeded$/.test(error.message))
    return "The RPC did not respond in time. Please retry.";
  if (networkFailure(error) || hasUrl(error.message)) return rpcFailure();
  // The chain module's own errors carry user-facing text.
  return error.message;
}
