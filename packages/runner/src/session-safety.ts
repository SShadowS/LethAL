/** Thrown when a work-plane call is attempted after the session has latched unsafe. */
export class SessionUnsafeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionUnsafeError";
  }
}

/**
 * A per-session, one-way latch (spec §8). Once any operation resolves to `in-flight-unknown`,
 * the session is unsafe: from that point NO work-plane call (deploy/activate/test/verify/status/
 * readiness/final ClearActive) may run — only local teardown. The latch never resets and keeps
 * the FIRST reason, which is the real cause; later reasons are downstream noise.
 */
export class SessionSafety {
  #unsafe = false;
  #reason: string | undefined;

  latchUnsafe(reason: string): void {
    if (this.#unsafe) return;
    this.#unsafe = true;
    this.#reason = reason;
  }

  get isUnsafe(): boolean {
    return this.#unsafe;
  }

  get reason(): string | undefined {
    return this.#reason;
  }

  /** Guard every work-plane call site. No-op while safe; throws once latched. */
  assertSafe(op: string): void {
    if (this.#unsafe) {
      throw new SessionUnsafeError(
        `refusing work-plane call ${op}: session latched unsafe (${this.#reason ?? "unknown"})`,
      );
    }
  }
}
