/** Normalises anything thrown into the message shown to the person using the app. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
