/** Turn an error into a short message for the user. The chain module's errors already carry user-facing text. */
export function readableError(error: unknown) {
  return error instanceof Error
    ? error.message
    : "This step could not be completed. Please retry.";
}
