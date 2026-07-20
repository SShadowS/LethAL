/**
 * The dispatch/effect state of a single backend operation. This — not whether an
 * exception was thrown — is what decides retry-safety and quarantine (spec §7).
 * "not still running" is NOT "safe to retry": the three questions (dispatched?
 * executing? committed an effect?) are distinct, so the states are distinct.
 */
export type OperationOutcome =
  | "pre-dispatch-rejected" // provably never reached the server — the ONLY retryable state
  | "completed-accepted" // terminal, well-formed server success
  | "completed-effect-unknown" // server work ended, effect-commit unknown (2xx malformed body, 500 after send)
  | "in-flight-unknown" // server may still be executing — latch unsafe + quarantine
  | "cancelled-confirmed"; // proven terminated by an external terminal signal (reserved for 5C)

/** The only state safe to re-issue: the request provably never reached the server. */
export function isRetrySafe(o: OperationOutcome): boolean {
  return o === "pre-dispatch-rejected";
}

/** The state that means "server may still be executing" — forces the unsafe latch (spec §8). */
export function requiresUnsafeLatch(o: OperationOutcome): boolean {
  return o === "in-flight-unknown";
}
