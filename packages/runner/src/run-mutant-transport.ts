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
  /**
   * R58, `runWithCoverage` only: an AL `SetFilter` expression over the `Code Coverage` table's
   * `"Object ID"` — the compiled artifact's own `idRanges`, e.g. `79000..79199`.
   *
   * Required rather than optional on that path, and NOT defaulted to `""`. Measured 2026-07-28:
   * unfiltered, `RunMutantWithCoverage` does not return headers within 300 s even for a
   * three-line fixture test, because the table holds every line the platform recorded during the
   * run — the whole Test Runner and Base App machinery, not just the target. An accidentally
   * empty filter is therefore not a benign default, it is a hang.
   */
  readonly coverageObjectIdFilter?: string;
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
  /** R58: present only on the `RunMutantWithCoverage` action — see `FencedCoverageRow`. */
  readonly coverage?: unknown;
}

/**
 * One row of BC's `Code Coverage` table, as `RunMutantWithCoverage` serializes it (control app
 * 1.0.0.9). Zero-hit rows are dropped server-side, as is every object outside the requested
 * `coverageObjectIdFilter`.
 *
 * `objectType` is BC's own numeric object-type value (`app-package.ts`'s `objectTypeName` maps it);
 * `lineNo` is a 1-based OBJECT-RELATIVE SOURCE line, and `0` is BC's object-level row (both
 * measured — see `line-map.ts`).
 */
export interface FencedCoverageRow {
  readonly objectType: number;
  readonly objectId: number;
  readonly lineNo: number;
  readonly hits: number;
}

/**
 * A `RunMutantWithCoverage` answer whose `ran` result carried no readable `coverage` array.
 *
 * A distinct class, extending `Error` DIRECTLY (never another typed error — see CLAUDE.md), and
 * THROWN rather than mapped to an `error` verdict. The alternative is the project's signature bug:
 * a baseline test that silently contributes no coverage looks exactly like a test that genuinely
 * covered nothing, its mutants fall to `no-coverage`, and the whole thing reads as a mutation-
 * scoring problem instead of "the server's answer was malformed" — the same disguise R31 cost two
 * debugging sessions to see through.
 *
 * Deliberately NOT raised for absent coverage on a non-`ran` status: a refusal (`lease-invalid`,
 * `artifact-mismatch`, `reserved-params`) legitimately carries none, and the AL returns `RunMutant`'s
 * inner payload UNTOUCHED when it cannot re-parse it, so "no coverage key" is a normal shape there.
 */
export class FencedCoverageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FencedCoverageError";
  }
}

/**
 * What the server says the coverage step COST, and how much the filter removed.
 *
 * Reported because the two costs behind a fenced-coverage timeout — the platform RECORDING every
 * executed line, and the control app SERIALIZING the table — look identical from the client (a
 * fetch that never returns) and only one of them is fixable by filtering. `scannedRows` versus
 * `emittedRows` separately distinguishes "the filter correctly matched a small set" from "the
 * filter matched nothing", which are the same empty array otherwise.
 */
export interface FencedCoverageStats {
  readonly runMs: number;
  readonly serializeMs: number;
  readonly scannedRows: number;
  readonly emittedRows: number;
}

/** What `runWithCoverage` returns: the verdict, plus the raw rows behind it. */
export interface RunMutantWithCoverageResult {
  readonly verdict: TestVerdict;
  /**
   * The RAW line rows, kept as a diagnostic artifact rather than only their collapsed
   * `CoverageMap` form. The first time a line falls in no known procedure range on a real project
   * — and it will — these are the only evidence of what BC actually said. Absent whenever the run
   * did not reach a `ran` status.
   */
  readonly coverageRows?: readonly FencedCoverageRow[];
  /** Absent on the same paths `coverageRows` is, and on a server that reports no timing. */
  readonly coverageStats?: FencedCoverageStats;
}

/** The BC `Test Method Line.Result` enum ints — confirmed live on Cronus281 (mem:runmutant_odata). */
const RESULT_SUCCESS = 2;
const RESULT_FAILURE = 1;

/**
 * Validates the `coverage` array on a `ran` result, or throws `FencedCoverageError`.
 *
 * Every field is checked to be a real number rather than coerced: a row whose `lineNo` arrived as
 * `"12"` or `null` would silently miss every procedure range and downgrade a member-level
 * observation to object-level — a quieter, subtler version of the wrong-attribution failure the
 * whole line map exists to prevent. An EMPTY array is valid and means what it says: this test
 * executed nothing that BC recorded with a hit.
 */
function parseCoverageRows(raw: unknown): readonly FencedCoverageRow[] {
  if (!Array.isArray(raw)) {
    const got = raw === undefined ? "absent" : JSON.stringify(raw).slice(0, 200);
    const why =
      "the control app must be 1.0.0.9 or newer (MIN_CONTROL_VERSION), and a baseline " +
      "measured without coverage would silently report every mutant as no-coverage";
    throw new FencedCoverageError(
      `RunMutantWithCoverage status=ran but \`coverage\` is ${got}, expected an array — ${why}`,
    );
  }
  const rows: FencedCoverageRow[] = [];
  for (const [i, r] of raw.entries()) {
    const row = r as Partial<Record<keyof FencedCoverageRow, unknown>>;
    const { objectType, objectId, lineNo, hits } = row ?? {};
    if (
      typeof objectType !== "number" ||
      typeof objectId !== "number" ||
      typeof lineNo !== "number" ||
      typeof hits !== "number"
    ) {
      const expected = "expected {objectType, objectId, lineNo, hits} all numeric";
      throw new FencedCoverageError(
        `RunMutantWithCoverage coverage row ${i} is malformed: ${JSON.stringify(r).slice(0, 200)} — ${expected}`,
      );
    }
    rows.push({ objectType, objectId, lineNo, hits });
  }
  return rows;
}

/** Best-effort: a server that reports no timing yields `undefined` rather than fabricated zeros. */
function parseCoverageStats(result: RunMutantResult): FencedCoverageStats | undefined {
  const r = result as Record<string, unknown>;
  const num = (k: string): number | undefined =>
    typeof r[k] === "number" ? (r[k] as number) : undefined;
  const runMs = num("coverageRunMs");
  const serializeMs = num("coverageSerializeMs");
  const scannedRows = num("coverageScannedRows");
  const emittedRows = num("coverageEmittedRows");
  if (
    runMs === undefined ||
    serializeMs === undefined ||
    scannedRows === undefined ||
    emittedRows === undefined
  ) {
    return undefined;
  }
  return { runMs, serializeMs, scannedRows, emittedRows };
}

export class RunMutantTransport {
  constructor(
    private readonly cfg: ActivationConfig,
    private readonly targetAppId: string,
    private readonly artifactId: string,
    private readonly fetchFn: FetchFn = fetch,
  ) {}

  /** One fenced mutant/baseline execution, no coverage collected — the unchanged Layer 5C-A path. */
  async run(req: RunMutantRequest): Promise<TestVerdict> {
    return (await this.execute(req, false)).verdict;
  }

  /**
   * R58: the same call routed at `LethALControl_RunMutantWithCoverage`, which wraps `RunMutant` in
   * `StartApplicationCoverage`/`StopApplicationCoverage` and attaches the `Code Coverage` table.
   *
   * A SEPARATE OData action rather than a parameter on `RunMutant`, deliberately (control app
   * 1.0.0.9): BC validates an action's request shape before its body runs, so adding a parameter
   * would make every stale-control-app failure present as a request-shape rejection — exactly how
   * R25 presented. Existing callers are untouched.
   *
   * `StartApplicationCoverage` CLEARS rather than accumulates (measured), so each call's rows
   * describe only its own execution and per-test attribution is sound.
   */
  async runWithCoverage(req: RunMutantRequest): Promise<RunMutantWithCoverageResult> {
    return this.execute(req, true);
  }

  /**
   * The one dispatch path both entry points share. The coverage rows come back through `sink`
   * rather than the return type so that every one of `dispatch`'s ~15 classified exits — each of
   * which encodes a hard-won dispatch/effect distinction — keeps returning a bare `TestVerdict`
   * and needed no edit to gain a coverage mode it does not participate in.
   */
  private async execute(
    req: RunMutantRequest,
    collectCoverage: boolean,
  ): Promise<RunMutantWithCoverageResult> {
    const sink: { rows?: readonly FencedCoverageRow[]; stats?: FencedCoverageStats } = {};
    const verdict = await this.dispatch(req, collectCoverage, sink);
    return {
      verdict,
      ...(sink.rows !== undefined ? { coverageRows: sink.rows } : {}),
      ...(sink.stats !== undefined ? { coverageStats: sink.stats } : {}),
    };
  }

  private async dispatch(
    req: RunMutantRequest,
    collectCoverage: boolean,
    sink: { rows?: readonly FencedCoverageRow[]; stats?: FencedCoverageStats },
  ): Promise<TestVerdict> {
    const { ref, mutantId, attemptId, timeoutMs, lease } = req;
    // Layer 5C-B1: the SAME bound every lease action is held to (`lease.ts`), applied here because
    // `RunMutant` writes the same Text[64] column. Deliberately a THROW, not a `TestVerdict` —
    // an over-long id is a caller-contract violation, and every verdict-shaped alternative is
    // worse: phase 1 would store a truncated id that phase 3 could never match, refusing with
    // `lease-invalid` while leaving `Op Kind = run` set, which quarantines the whole tier.
    assertAttemptId(attemptId);
    const started = Date.now();
    // Layer 5C-B2 (design §5): every exit below that can only say "the server's answer was
    // unreadable" carries these, so the orchestrator can ask the lease row what actually happened
    // to THIS attempt instead of quarantining the tier on an unreadable response. Terminal and
    // pre-dispatch exits deliberately omit them — see `TestVerdict.fencedOp`.
    const fencedOp = { attemptId, opSeq: lease.opSeq } as const;

    const params = new URLSearchParams({ company: this.cfg.company });
    if (this.cfg.tenant !== undefined) params.set("tenant", this.cfg.tenant);
    const action = collectCoverage
      ? "LethALControl_RunMutantWithCoverage"
      : "LethALControl_RunMutant";
    const url = `${this.cfg.baseUrl}/ODataV4/${action}?${params.toString()}`;

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
        // Sent ONLY on the coverage action: `RunMutant`'s OData signature has no such parameter,
        // and BC validates an action's request shape before its body runs (R25).
        ...(collectCoverage ? { coverageObjectIdFilter: req.coverageObjectIdFilter ?? "" } : {}),
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
          fencedOp,
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
        fencedOp,
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
        fencedOp,
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
        fencedOp,
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
        fencedOp,
      );
    }
    let result: RunMutantResult;
    try {
      result = JSON.parse(value) as RunMutantResult;
    } catch {
      return this.inFlightUnknown(
        ref,
        durationMs,
        `RunMutant \`value\` is not JSON: ${value}`,
        fencedOp,
      );
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
        fencedOp,
      );
    }

    // Status is `ran`, so the server both executed and cleared. Only NOW is a missing/malformed
    // `coverage` array a contract violation — every exit above is a refusal or an unreadable
    // answer, and `RunMutantWithCoverage` returns `RunMutant`'s inner payload untouched when it
    // cannot re-parse it, so those legitimately carry no coverage at all.
    if (collectCoverage) {
      sink.rows = parseCoverageRows(result.coverage);
      const stats = parseCoverageStats(result);
      if (stats !== undefined) sink.stats = stats;
    }

    return this.mapRanResult(ref, durationMs, result, fencedOp);
  }

  private mapRanResult(
    ref: TestMethodRef,
    durationMs: number,
    result: RunMutantResult,
    fencedOp: { readonly attemptId: string; readonly opSeq: number },
  ): TestVerdict {
    if (typeof result.codeunitResults !== "string") {
      return this.inFlightUnknown(
        ref,
        durationMs,
        "RunMutant status=ran but no codeunitResults",
        fencedOp,
      );
    }
    let parsed: { testResults?: unknown };
    try {
      parsed = JSON.parse(result.codeunitResults) as { testResults?: unknown };
    } catch {
      return this.inFlightUnknown(
        ref,
        durationMs,
        "RunMutant codeunitResults is not JSON",
        fencedOp,
      );
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

  /** `fencedOp` is REQUIRED, not optional: every caller is an unreadable-answer exit, and design
   *  §5's reconciliation can only name an op the verdict actually carries. Making it a parameter
   *  (rather than defaulting it away) means a future exit cannot silently ship uncoordinated. */
  private inFlightUnknown(
    ref: TestMethodRef,
    durationMs: number,
    detail: string,
    fencedOp: { readonly attemptId: string; readonly opSeq: number },
  ): TestVerdict {
    return {
      ref,
      outcome: "error",
      durationMs,
      failureMessage: detail,
      operation: "in-flight-unknown",
      fencedOp,
    };
  }
}
