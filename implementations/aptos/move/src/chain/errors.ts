import { AptosApiError } from "@aptos-labs/ts-sdk";

/** Messages for the error constants in contracts/sources/paymvc.move. */
const contractErrors: Record<string, string> = {
  E_ALREADY_REGISTERED: "This wallet is already registered.",
  E_NOT_REGISTERED: "Choose a different, registered PayMVC account.",
  E_INVALID_PARTICIPANTS: "Choose a different, registered PayMVC account.",
  E_INVALID_AMOUNT: "Enter a whole amount from 1 to 1,000,000.",
  E_INVALID_OPERATION:
    "The operation ID is invalid. Start the operation again.",
  E_OPERATION_USED: "This operation is already recorded. Refresh to see it.",
  E_NOT_FOUND: "This request was not found. Refresh and try again.",
  E_UNAUTHORIZED: "Only the requested payer can respond to this request.",
  E_NOT_PENDING: "This request has already been resolved. Refresh its status.",
};

/**
 * The message for a failed simulation. Nothing was signed, so nothing changed. The node
 * reports a PayMVC abort as "Move abort in 0x…::paymvc: E_NAME(0x2): …".
 */
export function simulationError(vmStatus: string) {
  const name = /::paymvc: (E_[A-Z_]+)\(/.exec(vmStatus)?.[1];
  if (name && contractErrors[name]) return contractErrors[name];
  if (/INSUFFICIENT_BALANCE/.test(vmStatus))
    return "Not enough demo credits or APT for gas. Nothing was sent.";
  return "The transaction would fail on-chain. Nothing was sent. Refresh and retry.";
}

/**
 * A fixed message for an RPC failure. SDK messages can hold the endpoint URL, which
 * can hold a provider key, so the user never sees them.
 */
function rpcFailure(status?: number) {
  if (status === 429)
    return "The RPC is rate-limiting requests. Your progress is saved. Wait a moment, then retry.";
  if (status && status >= 500)
    return "The RPC is temporarily unavailable. Your progress is saved. Retry when it responds.";
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
  if (error instanceof AptosApiError) return rpcFailure(error.status);
  if (!(error instanceof Error))
    return "This step could not be completed. Please retry.";
  if (networkFailure(error) || hasUrl(error.message)) return rpcFailure();
  // The chain module's own errors carry user-facing text.
  return error.message;
}
