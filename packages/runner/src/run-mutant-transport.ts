import type { ActivationConfig, FetchFn } from "./activation";
import type { TestMethodRef, TestOutcome, TestVerdict } from "./backend";
import { assertAttemptId } from "./lease";
import type { LeaseTuple } from "./lease";

/**
 * OData client for the `LethALControl_RunMutant` action (Layer 5C-A). One call does
 * activate + run-exactly-one-method + clear server-side (spec §5); this transport shapes the
 * request, classifies dispatch/effect state the 5B way, validates the echoed identity tuple, and
 * maps the terminal result to a `TestVerdict`.
 *
 * Request-shaping (Basic auth, `company`/`tenant` query params, manual AbortController timeout)
 * mirrors `postOData` in activation.ts — deliberately NOT reused: `postOData` classifies a
 * non-2xx as `completed-effect-unknown`, but a `RunMutant` that answered non-2xx may have
 * activated a mutant and never confirmed its run-scoped clear, so the container could be left
 * mutated. That is an `in-flight-unknown` (quarantine), not a benign effect-unknown — the mapping
 * below is RunMutant-specific and must not drift back onto `postOData`'s.
 */
export interface RunMutantRequest {
  readonly ref: TestMethodRef;
  /** The mutant to activate. `""` = baseline (nothing active). */
  readonly mutantId: string;
  readonly attemptId: string;
  readonly timeoutMs: number;
  /**
   * Layer 5C-B1's machine-global lease fence (design §5/§6): the tuple this call claims under,
   * plus the caller-supplied, exactly-next `opSeq` for THIS attempt. `RunMutantTransport` does
   * not mint or track `opSeq` — the backend seeds/increments it per RunMutant call (see
   * `bcdev-backend.ts`).
   */
  readonly lease: LeaseTuple & { readonly opSeq: number };
}

/** Parsed `LethALControl_RunMutant` result (the JSON string inside OData's scalar `value`). */
interface RunMutantResult {
  readonly status?: unknown;
  readonly reason?: unknown;
  readonly targetAppId?: unknown;
  readonly artifactId?: unknown;
  readonly attemptId?: unknown;
  readonly mutantId?: unknown;
  readonly codeunitId?: unknown;
  readonly method?: unknown;
  readonly codeunitResults?: unknown;
  readonly observedAny?: unknown;
  readonly identityMismatch?: unknown;
}

/** The BC `Test Method Line.Result` enum ints — confirmed live on Cronus281 (mem:runmutant_odata). */
const RESULT_SUCCESS = 2;
const RESULT_FAILURE = 1;

export class RunMutantTransport {
  constructor(
    private readonly cfg: ActivationConfig,
    private readonly targetAppId: string,
    private readonly artifactId: string,
    private readonly fetchFn: FetchFn = fetch,
  ) {}

  async run(req: RunMutantRequest): Promise<TestVerdict> {
    const { ref, mutantId, attemptId, timeoutMs, lease } = req;
    // Layer 5C-B1: the SAME bound every lease action is held to (`lease.ts`), applied here because
    // `RunMutant` writes the same Text[64] column. Deliberately a THROW, not a `TestVerdict` —
    // an over-long id is a caller-contract violation, and every verdict-shaped alternative is
    // worse: phase 1 would store a truncated id that phase 3 could never match, refusing with
    // `lease-invalid` while leaving `Op Kind = run` set, which quarantines the whole tier.
    assertAttemptId(attemptId);
    const started = Date.now();

    const params = new URLSearchParams({ company: this.cfg.company });
    if (this.cfg.tenant !== undefined) params.set("tenant", this.cfg.tenant);
    const url = `${this.cfg.baseUrl}/ODataV4/LethALControl_RunMutant?${params.toString()}`;

    // Request construction (auth header encoding, JSON body serialization) is synchronous and
    // can throw (e.g. `btoa` on a credential char with code unit >255) BEFORE fetchFn is ever
    // invoked — genuinely pre-dispatch-rejected (retry-safe), per design §H. Hoisted out of the
    // fetch try/catch below so that catch covers ONLY failures after fetchFn was called.
    let authHeader: string;
    let bodyJson: string;
    try {
      authHeader = `Basic ${btoa(`${this.cfg.username}:${this.cfg.password}`)}`;
      bodyJson = JSON.stringify({
        targetAppId: this.targetAppId,
        artifactId: this.artifactId,
        attemptId,
        mutantId,
        testCodeunitId: ref.codeunitId,
        testMethod: ref.method,
        // Layer 5C-B1: the two-phase RunMutant fence (design §5) — leaseEpoch is an Integer on
        // the wire (v1's reserved empty string is OData-rejected by the v2 server).
        leaseEpoch: lease.epoch,
        leaseToken: lease.token,
        serverGeneration: lease.serverGeneration,
        opSeq: lease.opSeq,
      });
    } catch (err) {
      return {
        ref,
        outcome: "error",
        durationMs: Date.now() - started,
        failureMessage: `RunMutant request construction failed: ${String(err)}`,
        operation: "pre-dispatch-rejected",
      };
    }

    // AbortSignal.timeout() is unreliable in this Bun/Windows env (see activation.ts) — manual
    // AbortController + setTimeout instead.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await this.fetchFn(url, {
        method: "POST",
        headers: {
          authorization: authHeader,
          "content-type": "application/json",
        },
        body: bodyJson,
        signal: controller.signal,
      });
    } catch (err) {
      const durationMs = Date.now() - started;
      // Our own timeout aborted it → the call may have reached the server and left a mutant
      // active (clear unconfirmed): in-flight-unknown, the orchestrator quarantines.
      if (controller.signal.aborted) {
        return {
          ref,
          outcome: "deadline-exceeded",
          durationMs,
          failureMessage: `RunMutant timed out: ${String(err)}`,
          operation: "in-flight-unknown",
        };
      }
      // fetchFn was already invoked; a rejection here (e.g. connection reset) may have reached BC
      // AFTER the request was fully sent and left a mutant active — never retry-safe (parent §7).
      return {
        ref,
        outcome: "error",
        durationMs,
        failureMessage: `RunMutant connection failed after dispatch: ${String(err)}`,
        operation: "in-flight-unknown",
      };
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      // Dispatched, then a non-2xx: RunMutant may have activated a mutant and not confirmed its
      // clear — the container could be left mutated. in-flight-unknown, never a verdict.
      return {
        ref,
        outcome: "error",
        durationMs: Date.now() - started,
        failureMessage: `RunMutant failed: HTTP ${res.status}`,
        operation: "in-flight-unknown",
      };
    }

    const durationMs = Date.now() - started;
    // Read the body as text FIRST, then parse. `res.json()` inside a try that collapses to
    // `undefined` cannot distinguish "the body was not JSON at all" from "the JSON had no
    // `value` key" — and this branch quarantines a tier, so the operator needs to know which.
    // Live-earned: this fired repeatedly on one mutant with no way to see what BC actually sent.
    let rawBody: string;
    try {
      rawBody = await res.text();
    } catch (err) {
      return this.inFlightUnknown(
        ref,
        durationMs,
        `RunMutant 2xx body could not be read: ${String(err)}`,
      );
    }
    let value: unknown;
    let parseError: string | undefined;
    try {
      value = (JSON.parse(rawBody) as { value?: unknown }).value;
    } catch (err) {
      parseError = String(err);
    }
    if (typeof value !== "string") {
      // 2xx with a malformed body: the run happened but we can't read its result or confirm the
      // clear — same possibly-stranded risk as a non-2xx. Carry the evidence: HTTP status, why
      // parsing failed (if it did), and the body itself, truncated.
      const excerpt =
        rawBody.length > 400 ? `${rawBody.slice(0, 400)}…[${rawBody.length} bytes]` : rawBody;
      return this.inFlightUnknown(
        ref,
        durationMs,
        `RunMutant returned no string \`value\` (HTTP ${res.status}${parseError !== undefined ? `, body was not JSON: ${parseError}` : ""}), body: ${JSON.stringify(excerpt)}`,
      );
    }
    let result: RunMutantResult;
    try {
      result = JSON.parse(value) as RunMutantResult;
    } catch {
      return this.inFlightUnknown(ref, durationMs, `RunMutant \`value\` is not JSON: ${value}`);
    }

    // Identity guard (spec §I5): the echoed tuple MUST equal what we sent. A mismatch means the
    // server ran something other than what we asked — reject it, never map it to a verdict.
    const identityError = this.identityMismatch(result, req);
    if (identityError !== null) {
      return {
        ref,
        outcome: "error",
        durationMs,
        failureMessage: identityError,
        operation: "completed-effect-unknown",
      };
    }

    if (result.status === "artifact-mismatch") {
      // The registered artifact ≠ ours: the deployed target was replaced. Ran nothing (container
      // clean), but our whole deployment assumption is broken — a typed error, never `survived`.
      return {
        ref,
        outcome: "error",
        durationMs,
        failureMessage: `RunMutant artifact-mismatch: deployed artifact ${this.artifactId} was replaced`,
      };
    }
    if (result.status === "reserved-params") {
      // We always send empty lease params in 5C-A, so this is a protocol/version fault.
      return {
        ref,
        outcome: "error",
        durationMs,
        failureMessage: "RunMutant rejected reserved lease params (protocol mismatch)",
      };
    }
    if (result.status === "lease-invalid") {
      // Layer 5C-B1 (design §5/§8): a confirmed refusal — never map to `in-flight-unknown`
      // (client-side ambiguity) or a bare error (the orchestrator must latch/invalidate). `reason`
      // is preserved verbatim: `"op-in-flight"` means THIS caller's own attempt is still active
      // server-side (poll, do not retry, not a real loss); anything else (or absent, on the
      // phase-3 verify-and-clear refusal) is a genuine lost lease. See `TestVerdict.leaseInvalidReason`.
      const reason = typeof result.reason === "string" ? result.reason : undefined;
      return {
        ref,
        outcome: "error",
        durationMs,
        failureMessage:
          reason !== undefined
            ? `RunMutant lease-invalid (reason: ${reason})`
            : "RunMutant lease-invalid",
        operation: "lease-lost",
        ...(reason !== undefined ? { leaseInvalidReason: reason } : {}),
      };
    }
    if (result.status !== "ran") {
      return this.inFlightUnknown(
        ref,
        durationMs,
        `RunMutant unexpected status: ${JSON.stringify(result.status)}`,
      );
    }

    return this.mapRanResult(ref, durationMs, result);
  }

  private mapRanResult(
    ref: TestMethodRef,
    durationMs: number,
    result: RunMutantResult,
  ): TestVerdict {
    if (typeof result.codeunitResults !== "string") {
      return this.inFlightUnknown(ref, durationMs, "RunMutant status=ran but no codeunitResults");
    }
    let parsed: { testResults?: unknown };
    try {
      parsed = JSON.parse(result.codeunitResults) as { testResults?: unknown };
    } catch {
      return this.inFlightUnknown(ref, durationMs, "RunMutant codeunitResults is not JSON");
    }
    const lines = Array.isArray(parsed.testResults) ? parsed.testResults : [];
    // Fail closed: RunMutant selects exactly one method server-side, so exactly one line is the
    // only acceptable shape (spec §5.7). Zero or many is a protocol fault, never a verdict.
    if (lines.length !== 1) {
      return {
        ref,
        outcome: "error",
        durationMs,
        failureMessage: `RunMutant returned ${lines.length} test lines, expected exactly 1`,
      };
    }
    const line = lines[0] as {
      method?: unknown;
      result?: unknown;
      message?: unknown;
      stackTrace?: unknown;
    };
    if (line.method !== ref.method) {
      return {
        ref,
        outcome: "error",
        durationMs,
        failureMessage: `RunMutant ran method ${JSON.stringify(line.method)}, expected ${ref.method}`,
      };
    }
    const outcome = this.outcomeOfResultEnum(line.result);
    if (outcome === null) {
      return {
        ref,
        outcome: "error",
        durationMs,
        failureMessage: `RunMutant unexpected result enum ${JSON.stringify(line.result)} for ${ref.method}`,
      };
    }
    // Per-run binary-identity attestation (spec §G): observedAny=false is allowed (no
    // instrumented site executed this run — coverage over-approximates); identityMismatch=true
    // means SOME instrumented site during this run presented a non-matching (targetAppId,
    // artifactId) — a wrong/stale binary is live. Reject it, never map it to a verdict.
    const attestation = {
      observedAny: result.observedAny === true,
      identityMismatch: result.identityMismatch === true,
    };
    if (attestation.identityMismatch) {
      return {
        ref,
        outcome: "error",
        durationMs,
        failureMessage:
          "RunMutant attestation identity mismatch: a selector with a non-matching (targetAppId, artifactId) ran — wrong/stale binary",
      };
    }
    const failureMessage = this.failureTextOf(line);
    return {
      ref,
      outcome,
      durationMs,
      attestation,
      ...(outcome === "fail" && failureMessage !== undefined ? { failureMessage } : {}),
    };
  }

  /** 2→pass, 1→fail. Any other value is unknown (fail closed) — skip's enum is confirmed in Task 6. */
  private outcomeOfResultEnum(result: unknown): TestOutcome | null {
    if (result === RESULT_SUCCESS) return "pass";
    if (result === RESULT_FAILURE) return "fail";
    return null;
  }

  private failureTextOf(line: { message?: unknown; stackTrace?: unknown }): string | undefined {
    const parts: string[] = [];
    if (typeof line.message === "string" && line.message.length > 0) parts.push(line.message);
    if (typeof line.stackTrace === "string" && line.stackTrace.length > 0)
      parts.push(line.stackTrace);
    return parts.length > 0 ? parts.join("\n") : undefined;
  }

  private identityMismatch(result: RunMutantResult, req: RunMutantRequest): string | null {
    const mismatches: string[] = [];
    if (result.targetAppId !== this.targetAppId)
      mismatches.push(`targetAppId ${JSON.stringify(result.targetAppId)}≠${this.targetAppId}`);
    if (result.artifactId !== this.artifactId)
      mismatches.push(`artifactId ${JSON.stringify(result.artifactId)}≠${this.artifactId}`);
    if (result.attemptId !== req.attemptId)
      mismatches.push(`attemptId ${JSON.stringify(result.attemptId)}≠${req.attemptId}`);
    if (result.mutantId !== req.mutantId)
      mismatches.push(`mutantId ${JSON.stringify(result.mutantId)}≠${req.mutantId}`);
    if (result.codeunitId !== req.ref.codeunitId)
      mismatches.push(`codeunitId ${JSON.stringify(result.codeunitId)}≠${req.ref.codeunitId}`);
    if (result.method !== req.ref.method)
      mismatches.push(`method ${JSON.stringify(result.method)}≠${req.ref.method}`);
    return mismatches.length > 0 ? `RunMutant identity mismatch: ${mismatches.join(", ")}` : null;
  }

  private inFlightUnknown(ref: TestMethodRef, durationMs: number, detail: string): TestVerdict {
    return {
      ref,
      outcome: "error",
      durationMs,
      failureMessage: detail,
      operation: "in-flight-unknown",
    };
  }
}
