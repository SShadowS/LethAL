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
  | "cancelled-confirmed" // proven terminated by an external terminal signal (reserved for 5C)
  /**
   * Layer 5C-B1: `RunMutant` answered `status:"lease-invalid"` — a confirmed server refusal,
   * distinct from `in-flight-unknown`'s client-side ambiguity (design §5/§8). Covers BOTH a
   * genuinely lost lease AND a still-active same-attempt duplicate claim ("op-in-flight" — see
   * `TestVerdict.leaseInvalidReason` on `backend.ts`), which the orchestrator must check BEFORE
   * treating this as genuine lease loss.
   */
  | "lease-lost";

/** The only state safe to re-issue: the request provably never reached the server. */
export function isRetrySafe(o: OperationOutcome): boolean {
  return o === "pre-dispatch-rejected";
}

/** The states that force the unsafe latch (spec §8): the server may still be executing
 * (`in-flight-unknown`), or the caller can no longer prove it holds the lease (`lease-lost`). */
export function requiresUnsafeLatch(o: OperationOutcome): boolean {
  return o === "in-flight-unknown" || o === "lease-lost";
}
