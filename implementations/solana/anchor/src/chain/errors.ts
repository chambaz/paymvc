import {
  isSolanaError,
  SOLANA_ERROR__ACCOUNTS__ACCOUNT_NOT_FOUND,
  SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR,
} from "@solana/kit";

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
  if (isSolanaError(error, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR))
    return rpcFailure(error.context.statusCode);
  // The RPC answered: the account does not exist.
  if (isSolanaError(error, SOLANA_ERROR__ACCOUNTS__ACCOUNT_NOT_FOUND))
    return "A PayMVC account that this step needs was not found. Refresh and try again.";
  // Other SDK errors are codes for developers, not messages for users.
  if (isSolanaError(error)) return rpcFailure();
  if (!(error instanceof Error))
    return "This step could not be completed. Please retry.";
  if (networkFailure(error) || hasUrl(error.message)) return rpcFailure();
  // The chain module's own errors carry user-facing text.
  return error.message;
}
