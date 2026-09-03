import type { ActivationConfig, FetchFn } from "./activation";
import type { TestMethodRef, TestOutcome, TestVerdict } from "./backend";
import { bcFetch } from "./bc-fetch";
import { describeThrown } from "./describe-error";
import { assertAttemptId, parseOperationStatus } from "./lease";
import type { LeaseTuple, OperationStatus } from "./lease";
import { runMutantLineCountMessage } from "./stale-test-app";

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
  /**
   * R53 (opt-in, `--stop-hung-sessions`). Absent ⇒ today's behaviour EXACTLY: abort at `timeoutMs`
   * and classify `in-flight-unknown`.
   *
   * When present, the request is NOT aborted at the budget. Instead this hook fires — the caller
   * wires it to `StopHungRun` on a SECOND connection — and this request stays open to receive BC's
   * answer. That inversion is the whole mechanism:
   *
   *   MEASURED (`scripts/r53-probe/`): stopping the session makes BC answer the still-open original
   *   request with HTTP 408 naming the AL `StopSession` call. Aborting first throws that answer
   *   away and leaves only `StopHungRun`'s own return value — which is worth nothing, because
   *   `StopSession` returns without throwing for an id that never existed, for 0, and for -1. It
   *   cannot report failure.
   *
   * So the 408 on THIS request is the only signal that proves the session stopped was the session
   * serving THIS request. It is also what makes the finish-just-after-budget case honest: if the
   * run completed instead, this request returns the real result and that is what gets scored.
   */
  readonly onBudgetExceeded?: () => Promise<void>;
  /**
   * How long to keep waiting after `onBudgetExceeded` fires before giving up and aborting. Bounds
   * the hold-open: if BC answers neither the stop nor this request, the run must still end.
   * Ignored when `onBudgetExceeded` is absent.
   */
  readonly stopGraceMs?: number;
}

/**
 * BC's answer on the stopped request. Both halves are required: a bare 408 is an ordinary request
 * timeout (a proxy emits one), and only the AL-stop wording proves the session was ended by our
 * own `StopHungRun` rather than by a hosting layer that timed the socket out.
 */
const AL_STOP_408 = /stopped the session/i;
const AL_STOP_408_CAUSE = /StopSession/i;

/** True only for BC's "this session was stopped by an AL StopSession call" 408. */
export function isAlStopResponse(status: number, body: string): boolean {
  return status === 408 && AL_STOP_408.test(body) && AL_STOP_408_CAUSE.test(body);
}

/** R198: how often `runMany`'s watchdog reads the op's progress while its request is open. */
export const WATCHDOG_POLL_MS = 5_000;

/** Parsed `LethALControl_RunMutantMany` result. */
interface RunMutantManyAnswer {
  readonly status?: unknown;
  readonly reason?: unknown;
  readonly targetAppId?: unknown;
  readonly artifactId?: unknown;
  readonly attemptId?: unknown;
  readonly mutantId?: unknown;
  readonly observedAny?: unknown;
  readonly identityMismatch?: unknown;
  readonly runError?: unknown;
  readonly endedBy?: unknown;
  readonly ranCount?: unknown;
  readonly methods?: unknown;
}

interface GroupEntry {
  readonly index: unknown;
  readonly codeunitId: unknown;
  readonly method: unknown;
  readonly codeunitResults: unknown;
  readonly durationMs: unknown;
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

/** R198: one method of a `RunMutantMany` call, with the per-test budget the watchdog holds it to. */
export interface GroupMethod {
  readonly ref: TestMethodRef;
  readonly budgetMs: number;
}

/**
 * R198: one call that runs N methods against one mutant, as a server-side loop of today's
 * single-method run (design: `docs/superpowers/specs/2026-09-03-r198-run-mutant-loop.md`).
 * The watchdog lives INSIDE `runMany` and is the sole writer of its stop decision.
 */
export interface RunMutantManyRequest {
  readonly mutantId: string;
  readonly attemptId: string;
  readonly lease: LeaseTuple & { readonly opSeq: number };
  /** In the order to run; `index` on the wire is 1-based position here. At least one. */
  readonly methods: readonly GroupMethod[];
  /** The whole call must answer inside this (server-side elapsed); the server caps STARTS by it. */
  readonly requestCeilingMs: number;
  readonly stopGraceMs: number;
  /** `--stop-hung-sessions`: fire `StopHungRunAt` at a method's budget instead of aborting. */
  readonly stopHungSessions: boolean;
  /** How often the watchdog reads `GetOperationStatus` while the request is open. */
  readonly watchdogPollMs?: number;
}

export type GroupEndedBy = "complete" | "failure" | "cap";

/**
 * R198: the per-MUTANT causes a group call can end in, which the orchestrator records as
 * `error` with that cause and then scores the NEXT mutant (never a session abort, never a
 * lease-loss latch, never a verdict).
 */
export type GroupCause = "group-run-error" | "group-answer-malformed" | "stopped-after-completion";

export type RunMutantManyResult =
  | {
      /** The server ran a prefix of the request; one verdict per method that ran, in order. */
      readonly kind: "verdicts";
      readonly endedBy: GroupEndedBy;
      readonly ranCount: number;
      readonly verdicts: readonly TestVerdict[];
      readonly durationMs: number;
    }
  | {
      /**
       * The CALL ended without per-method verdicts. `verdict` is attributed to the method the
       * outcome is about (the stopped one for `timeout`, the watched one for an abort, the first
       * of the chunk otherwise) and carries the same `operation`/`fencedOp`/`leaseInvalidReason`
       * shapes `run` produces, so the orchestrator classifies it with today's branches.
       */
      readonly kind: "call";
      readonly verdict: TestVerdict;
      /** Present for a per-mutant error; absent when `verdict` classifies itself. */
      readonly cause?: GroupCause;
      /** Present when, after the orchestrator's own handling, the SESSION must abort with this text. */
      readonly abortSession?: string;
    };

/** R198: what `StopHungRunAt` answered. `rowIndex`/`rowState` travel on a refusal. */
export interface StopAtAnswer {
  readonly stopped: boolean;
  readonly sessionId?: number;
  readonly reason?: string;
  readonly rowIndex?: number;
  readonly rowState?: string;
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
    private readonly fetchFn: FetchFn = bcFetch,
  ) {}

  /** One fenced mutant/baseline execution, no coverage collected — the unchanged Layer 5C-A path. */
  /**
   * R53: ask the server to end the session running THIS attempt's mutant.
   *
   * Called on a SECOND connection while the original RunMutant request is still open — never
   * instead of it. The answer here is deliberately NOT the evidence a verdict rests on: measured,
   * `StopSession` returns without throwing for an id that never existed, for 0 and for -1, so the
   * server cannot tell us it failed. The verdict comes from the 408 BC delivers to the held
   * request (see `isAlStopResponse`); this call exists to CAUSE that, and its return value is
   * diagnostic only.
   *
   * The "is this op still running?" check lives SERVER-side, in `TryStopHungRun`'s tombstone
   * branch, rather than as a separate client read-then-act: the server holds the lease lock while
   * it checks and stops, so there is no window in which the run completes between our check and
   * our stop. A client-side pre-check would have exactly that window, and the thing it would let
   * through — stopping a run that already finished, whose recorded session id now names a live
   * pooled session — is the false kill this feature must not produce.
   *
   * Throws on transport failure; the caller surfaces that in the quarantine note.
   */
  async stopHungRun(req: {
    readonly attemptId: string;
    readonly lease: LeaseTuple & { readonly opSeq: number };
  }): Promise<{ stopped: boolean; sessionId?: number; reason?: string }> {
    assertAttemptId(req.attemptId);
    const params = new URLSearchParams({ company: this.cfg.company });
    if (this.cfg.tenant !== undefined) params.set("tenant", this.cfg.tenant);
    const url = `${this.cfg.baseUrl}/ODataV4/LethALControl_StopHungRun?${params.toString()}`;
    const res = await this.fetchFn(url, {
      method: "POST",
      headers: {
        authorization: `Basic ${btoa(`${this.cfg.username}:${this.cfg.password}`)}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        epoch: req.lease.epoch,
        token: req.lease.token,
        generation: req.lease.serverGeneration,
        attemptId: req.attemptId,
        opSeq: req.lease.opSeq,
      }),
    });
    if (!res.ok) {
      throw new Error(`StopHungRun failed: HTTP ${res.status} ${await res.text().catch(() => "")}`);
    }
    const outer: unknown = await res.json();
    const value = (outer as { value?: unknown }).value;
    if (typeof value !== "string") {
      throw new Error(`StopHungRun returned no string \`value\`: ${JSON.stringify(outer)}`);
    }
    const parsed: unknown = JSON.parse(value);
    const stopped = (parsed as { stopped?: unknown }).stopped;
    if (typeof stopped !== "boolean") {
      throw new Error(`StopHungRun returned no boolean \`stopped\`: ${value}`);
    }
    const sessionId = (parsed as { sessionId?: unknown }).sessionId;
    const reason = (parsed as { reason?: unknown }).reason;
    return {
      stopped,
      ...(typeof sessionId === "number" ? { sessionId } : {}),
      ...(typeof reason === "string" ? { reason } : {}),
    };
  }

  /**
   * R198: the watchdog's status read, on this transport's own connection rather than through
   * `LeaseClient`, so `runMany` is testable with one fake fetch. Same wire shape, same parser.
   */
  async getOperationStatus(
    lease: LeaseTuple,
    attemptId: string,
    opSeq: number,
  ): Promise<OperationStatus> {
    const json = await this.postAction("GetOperationStatus", {
      epoch: lease.epoch,
      token: lease.token,
      generation: lease.serverGeneration,
      attemptId,
      opSeq,
    });
    return parseOperationStatus(json);
  }

  /**
   * R198: the per-METHOD stop. Refused server-side unless the op's progress row reads exactly
   * (`methodIndex`, `methodToken`) in state `running`, read locked under the lease lock, so a
   * decision taken from a poll up to one interval stale cannot land on the next method. Its answer
   * is a DECISION, not a termination: the verdict still comes only from the 408 BC delivers to the
   * held request. Throws on transport failure, like `stopHungRun`.
   */
  async stopHungRunAt(req: {
    readonly attemptId: string;
    readonly lease: LeaseTuple & { readonly opSeq: number };
    readonly methodIndex: number;
    readonly methodToken: string;
  }): Promise<StopAtAnswer> {
    assertAttemptId(req.attemptId);
    const parsed = await this.postAction("StopHungRunAt", {
      epoch: req.lease.epoch,
      token: req.lease.token,
      generation: req.lease.serverGeneration,
      attemptId: req.attemptId,
      opSeq: req.lease.opSeq,
      methodIndex: req.methodIndex,
      methodToken: req.methodToken,
    });
    const stopped = parsed.stopped;
    if (typeof stopped !== "boolean") {
      throw new Error(`StopHungRunAt returned no boolean \`stopped\`: ${JSON.stringify(parsed)}`);
    }
    const { sessionId, reason, rowIndex, rowState } = parsed;
    return {
      stopped,
      ...(typeof sessionId === "number" ? { sessionId } : {}),
      ...(typeof reason === "string" ? { reason } : {}),
      ...(typeof rowIndex === "number" ? { rowIndex } : {}),
      ...(typeof rowState === "string" ? { rowState } : {}),
    };
  }

  /** One POST to a control-app action whose `value` is a JSON object; throws on any non-2xx. */
  private async postAction(
    action: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const params = new URLSearchParams({ company: this.cfg.company });
    if (this.cfg.tenant !== undefined) params.set("tenant", this.cfg.tenant);
    const url = `${this.cfg.baseUrl}/ODataV4/LethALControl_${action}?${params.toString()}`;
    const res = await this.fetchFn(url, {
      method: "POST",
      headers: {
        authorization: `Basic ${btoa(`${this.cfg.username}:${this.cfg.password}`)}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`${action} failed: HTTP ${res.status} ${await res.text().catch(() => "")}`);
    }
    const outer: unknown = await res.json();
    const value = (outer as { value?: unknown }).value;
    if (typeof value !== "string") {
      throw new Error(`${action} returned no string \`value\`: ${JSON.stringify(outer)}`);
    }
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`${action} \`value\` is not a JSON object: ${value}`);
    }
    return parsed as Record<string, unknown>;
  }

  async run(req: RunMutantRequest): Promise<TestVerdict> {
    return (await this.execute(req, false)).verdict;
  }

  /**
   * R198: `LethALControl_RunMutantMany`. One POST for N methods; the watchdog below polls
   * `GetOperationStatus` while the request is open and is the SOLE writer of `stopFired`.
   *
   * What it does, in order: act only on a status whose marker AND progress row name OUR op
   * ("ours first": a start-up poll, another op's residual row, or an idle marker is "nothing
   * yet"); check the row's (index, codeunitId, method) against the CLIENT's request array
   * ("identity second": a disagreement aborts and, after the orchestrator's reconciliation,
   * the session); compute the running method's elapsed time from `serverNow - startedAt`
   * (server clocks only; an unparseable pair never fires); at the method's budget either fire
   * `StopHungRunAt(index, token)` once (with `--stop-hung-sessions`) or abort the request
   * (without). Scoring afterwards is today's rule: only BC's 408 naming the AL StopSession call
   * is a `timeout`, narrowed for R204 by one status read; every other non-2xx after a stop is
   * `in-flight-unknown`; a 2xx is parsed and scored as if no stop had fired.
   */
  async runMany(req: RunMutantManyRequest): Promise<RunMutantManyResult> {
    const { mutantId, attemptId, lease, methods } = req;
    assertAttemptId(attemptId);
    if (methods.length === 0) {
      throw new Error("RunMutantMany: a call with no methods is a caller-contract violation");
    }
    const firstMethod = methods[0];
    if (firstMethod === undefined) throw new Error("unreachable: methods is non-empty");
    const started = Date.now();
    const fencedOp = { attemptId, opSeq: lease.opSeq } as const;
    const pollMs = req.watchdogPollMs ?? WATCHDOG_POLL_MS;
    const call = (verdict: TestVerdict, extra?: { cause?: GroupCause; abortSession?: string }) =>
      ({
        kind: "call",
        verdict,
        ...(extra?.cause !== undefined ? { cause: extra.cause } : {}),
        ...(extra?.abortSession !== undefined ? { abortSession: extra.abortSession } : {}),
      }) as const;

    const params = new URLSearchParams({ company: this.cfg.company });
    if (this.cfg.tenant !== undefined) params.set("tenant", this.cfg.tenant);
    const url = `${this.cfg.baseUrl}/ODataV4/LethALControl_RunMutantMany?${params.toString()}`;
    let authHeader: string;
    let bodyJson: string;
    try {
      authHeader = `Basic ${btoa(`${this.cfg.username}:${this.cfg.password}`)}`;
      bodyJson = JSON.stringify({
        targetAppId: this.targetAppId,
        artifactId: this.artifactId,
        attemptId,
        mutantId,
        testMethods: JSON.stringify(
          methods.map((m, i) => ({
            index: i + 1,
            codeunitId: m.ref.codeunitId,
            method: m.ref.method,
            budgetMs: m.budgetMs,
          })),
        ),
        stopAtFirstFailure: true,
        requestCeilingMs: req.requestCeilingMs,
        stopGraceMs: req.stopGraceMs,
        leaseEpoch: lease.epoch,
        leaseToken: lease.token,
        serverGeneration: lease.serverGeneration,
        opSeq: lease.opSeq,
      });
    } catch (err) {
      return call({
        ref: firstMethod.ref,
        outcome: "error",
        durationMs: Date.now() - started,
        failureMessage: `RunMutantMany request construction failed: ${String(err)}`,
        operation: "pre-dispatch-rejected",
      });
    }

    // ---- the watchdog ----
    const controller = new AbortController();
    let settled = false;
    let stopFired = false;
    let stopConfirmed = false;
    let stopHookError: unknown;
    let stopDecision: { methodIndex: number; token: string; ref: TestMethodRef } | undefined;
    let watchedRef: TestMethodRef = firstMethod.ref;
    let lastRefusal: string | undefined;
    let lastRow: string | undefined;
    let abortReason: "budget" | "identity" | "hard-cap" | undefined;
    let identityDetail: string | undefined;
    const hardCapMs = req.requestCeilingMs + req.stopGraceMs;
    const hardTimer = setTimeout(() => {
      abortReason ??= "hard-cap";
      controller.abort();
    }, hardCapMs);
    // The poll interval must NOT outlive the request: `settle()` wakes a sleeping watchdog so the
    // call returns when BC answers, not up to one interval later. Measured before this existed:
    // the tables gate went from 3.5 to 32 minutes, ~4.7 s per grouped call, all of it this sleep.
    let wake: (() => void) | undefined;
    const sleep = (ms: number) =>
      new Promise<void>((r) => {
        const t = setTimeout(() => {
          wake = undefined;
          r();
        }, ms);
        wake = () => {
          clearTimeout(t);
          wake = undefined;
          r();
        };
      });
    const watchdog = (async () => {
      while (!settled) {
        await sleep(pollMs);
        if (settled) return;
        let status: OperationStatus;
        try {
          status = await this.getOperationStatus(lease, attemptId, lease.opSeq);
        } catch {
          continue; // a failed poll is "nothing yet"
        }
        if (settled) return;
        const row = status.opProgress;
        const ours =
          status.opKind === "run" &&
          status.opAttemptId === attemptId &&
          status.opSeq === lease.opSeq &&
          row !== undefined &&
          row.attemptId === attemptId &&
          row.opSeq === lease.opSeq;
        if (!ours || row === undefined) continue;
        const entry = methods[row.methodIndex - 1];
        if (
          row.methodIndex < 1 ||
          row.methodIndex > methods.length ||
          entry === undefined ||
          entry.ref.codeunitId !== row.codeunitId ||
          entry.ref.method !== row.method
        ) {
          identityDetail = `the server's progress row names method ${row.methodIndex} = ${row.codeunitId}.${row.method}, which is not what this request asked for at that index (${entry === undefined ? "no such index" : `${entry.ref.codeunitId}.${entry.ref.method}`})`;
          abortReason ??= "identity";
          controller.abort();
          return;
        }
        watchedRef = entry.ref;
        lastRow = `${row.state} at method ${row.methodIndex}, last completed ${row.lastCompletedIndex}`;
        if (row.state !== "running") continue;
        const startedAt = Date.parse(row.startedAt);
        const now = status.serverNow === undefined ? Number.NaN : Date.parse(status.serverNow);
        const elapsed = now - startedAt;
        // Written as `elapsed > budget` on purpose: a NaN from an unparseable timestamp never fires.
        if (!(elapsed > entry.budgetMs)) continue;
        if (!req.stopHungSessions) {
          abortReason ??= "budget";
          controller.abort();
          return;
        }
        if (stopFired) continue; // decided already; waiting for the held request
        stopFired = true;
        stopDecision = { methodIndex: row.methodIndex, token: row.token, ref: entry.ref };
        let answer: StopAtAnswer;
        try {
          answer = await this.stopHungRunAt({
            attemptId,
            lease,
            methodIndex: row.methodIndex,
            methodToken: row.token,
          });
        } catch (err) {
          stopHookError = err;
          continue;
        }
        if (answer.stopped) {
          stopConfirmed = true;
          continue;
        }
        lastRefusal = answer.reason ?? "no reason given";
        if (answer.rowState !== undefined) {
          lastRow = `${answer.rowState} at method ${answer.rowIndex ?? "?"}`;
        }
        if (answer.reason === "method-completed" || answer.reason === "no-progress-row") {
          // The loop moved on between the poll and the stop: clear and re-decide later.
          stopFired = false;
          stopDecision = undefined;
          continue;
        }
        if (answer.reason === "already-completed") continue; // the op finished; wait for its answer
        stopHookError = new Error(
          `StopHungRunAt refused: ${lastRefusal} (attempt ${attemptId}, opSeq ${lease.opSeq}, method ${row.methodIndex})`,
        );
      }
    })();
    const settle = () => {
      settled = true;
      clearTimeout(hardTimer);
      wake?.();
    };
    const stopDetail = () =>
      `${lastRefusal !== undefined ? ` last stop refusal: ${lastRefusal};` : ""}${lastRow !== undefined ? ` progress row: ${lastRow};` : ""}${stopHookError !== undefined ? ` stop hook: ${describeThrown(stopHookError)};` : ""}`;
    const abortedVerdict = (err: unknown, phase: string): RunMutantManyResult => {
      const why =
        abortReason === "identity"
          ? `RunMutantMany aborted: ${identityDetail ?? "identity disagreement"}`
          : abortReason === "budget"
            ? `RunMutantMany aborted at ${watchedRef.method}'s budget ${phase} (our timer, not BC's stop)`
            : `RunMutantMany aborted at the hard cap (${hardCapMs} ms) ${phase}, watching ${watchedRef.method}`;
      const verdict: TestVerdict = {
        ref: watchedRef,
        outcome: "deadline-exceeded",
        durationMs: Date.now() - started,
        failureMessage: `${why}: ${String(err)}.${stopDetail()}`,
        operation: "in-flight-unknown",
        fencedOp,
      };
      return abortReason === "identity"
        ? call(verdict, {
            abortSession: `RunMutantMany identity disagreement: ${identityDetail ?? ""}`,
          })
        : call(verdict);
    };

    let res: Response;
    try {
      res = await this.fetchFn(url, {
        method: "POST",
        headers: { authorization: authHeader, "content-type": "application/json" },
        body: bodyJson,
        signal: controller.signal,
      });
    } catch (err) {
      settle();
      await watchdog;
      if (controller.signal.aborted) return abortedVerdict(err, "before headers");
      return call({
        ref: watchedRef,
        outcome: "error",
        durationMs: Date.now() - started,
        failureMessage: `RunMutantMany connection failed after dispatch: ${String(err)}`,
        operation: "in-flight-unknown",
        fencedOp,
      });
    }
    let rawBody: string;
    try {
      rawBody = await res.text();
    } catch (err) {
      settle();
      await watchdog;
      if (controller.signal.aborted) return abortedVerdict(err, "after headers");
      return call(
        this.inFlightUnknown(
          watchedRef,
          Date.now() - started,
          `RunMutantMany 2xx body could not be read: ${String(err)}`,
          fencedOp,
        ),
      );
    }
    settle();
    await watchdog;
    const durationMs = Date.now() - started;

    if (stopFired && isAlStopResponse(res.status, rawBody)) {
      const decision = stopDecision;
      if (decision === undefined || !stopConfirmed) {
        // A 408 naming the AL stop with no confirmed decision of ours behind it: today's rule,
        // not scored.
        return call(
          this.inFlightUnknown(
            watchedRef,
            durationMs,
            `RunMutantMany answered BC's stop 408 but this transport's own stop was ${decision === undefined ? "never decided" : "not confirmed"}.${stopDetail()}`,
            fencedOp,
          ),
        );
      }
      // R204's narrowing: one status read; a `between` write that committed before the session
      // died proves the method finished. Unavailable evidence (throw, no row, not ours) keeps
      // today's answer, the timeout.
      let finished = false;
      try {
        const after = await this.getOperationStatus(lease, attemptId, lease.opSeq);
        const row = after.opProgress;
        finished =
          row !== undefined &&
          row.attemptId === attemptId &&
          row.opSeq === lease.opSeq &&
          row.lastCompletedIndex >= decision.methodIndex;
      } catch {
        finished = false;
      }
      if (finished) {
        return call(
          {
            ref: decision.ref,
            outcome: "error",
            durationMs,
            failureMessage: `RunMutantMany: the stop for ${decision.ref.method} was confirmed, but the method's own completion was recorded before the session died, so this run is not scored (R204)`,
          },
          { cause: "stopped-after-completion" },
        );
      }
      return call({
        ref: decision.ref,
        outcome: "timeout",
        durationMs,
        failureMessage:
          `RunMutantMany: ${decision.ref.method} exceeded its ${decision.ref.method === watchedRef.method ? "" : ""}budget and was stopped server-side so it could ` +
          `be scored rather than strand the tier. BC's own words: ${JSON.stringify(rawBody.slice(0, 400))}`,
      });
    }
    if (!res.ok) {
      const routeMissing = res.status === 404;
      const verdict: TestVerdict = {
        ref: watchedRef,
        outcome: "error",
        durationMs,
        failureMessage: `RunMutantMany failed: HTTP ${res.status}${stopFired ? ` after our stop${stopConfirmed ? " (confirmed)" : ""}` : ""}.${stopDetail()}`,
        operation: "in-flight-unknown",
        fencedOp,
      };
      return routeMissing
        ? call(verdict, {
            abortSession:
              "control-app-route-missing: LethALControl_RunMutantMany answered 404 after the version gate passed; the deployed control app is not the one the gate saw",
          })
        : call(verdict);
    }

    let value: unknown;
    let parseError: string | undefined;
    try {
      value = (JSON.parse(rawBody) as { value?: unknown }).value;
    } catch (err) {
      parseError = String(err);
    }
    if (typeof value !== "string") {
      const excerpt =
        rawBody.length > 400 ? `${rawBody.slice(0, 400)}…[${rawBody.length} bytes]` : rawBody;
      return call(
        this.inFlightUnknown(
          watchedRef,
          durationMs,
          `RunMutantMany returned no string \`value\` (HTTP ${res.status}${parseError !== undefined ? `, body was not JSON: ${parseError}` : ""}), body: ${JSON.stringify(excerpt)}`,
          fencedOp,
        ),
      );
    }
    let result: RunMutantManyAnswer;
    try {
      result = JSON.parse(value) as RunMutantManyAnswer;
    } catch {
      return call(
        this.inFlightUnknown(
          watchedRef,
          durationMs,
          `RunMutantMany \`value\` is not JSON: ${value}`,
          fencedOp,
        ),
      );
    }

    // Shared classification, in `dispatch`'s order: echo, artifact-mismatch, reserved-params,
    // lease-invalid (with its reason, `op-stopped` among them), then anything not `ran`.
    const echo = this.callEchoMismatch(result, attemptId, mutantId, "RunMutantMany");
    if (echo !== null) {
      return call({
        ref: firstMethod.ref,
        outcome: "error",
        durationMs,
        failureMessage: echo,
        operation: "completed-effect-unknown",
      });
    }
    const statusVerdict = this.classifyRefusal(
      result,
      firstMethod.ref,
      durationMs,
      "RunMutantMany",
    );
    if (statusVerdict !== null) return call(statusVerdict);
    if (result.status !== "ran") {
      return call(
        this.inFlightUnknown(
          firstMethod.ref,
          durationMs,
          `RunMutantMany unexpected status: ${JSON.stringify(result.status)}`,
          fencedOp,
        ),
      );
    }
    if (result.identityMismatch === true) {
      return call({
        ref: firstMethod.ref,
        outcome: "error",
        durationMs,
        failureMessage:
          "RunMutantMany attestation identity mismatch: a selector with a non-matching (targetAppId, artifactId) ran — wrong/stale binary",
      });
    }
    if (typeof result.runError === "string") {
      return call(
        {
          ref: firstMethod.ref,
          outcome: "error",
          durationMs,
          failureMessage: `RunMutantMany: the server's loop raised and the call was not scored — ${result.runError}`,
        },
        { cause: "group-run-error" },
      );
    }
    const attestation = { observedAny: result.observedAny === true, identityMismatch: false };
    const malformed = (why: string): RunMutantManyResult =>
      call(
        {
          ref: firstMethod.ref,
          outcome: "error",
          durationMs,
          failureMessage: `RunMutantMany answer malformed: ${why}; answer: ${value.slice(0, 600)}`,
        },
        { cause: "group-answer-malformed" },
      );
    const endedBy = result.endedBy;
    if (endedBy !== "complete" && endedBy !== "failure" && endedBy !== "cap") {
      return malformed(`endedBy is ${JSON.stringify(endedBy)}`);
    }
    const ranCount = result.ranCount;
    if (typeof ranCount !== "number" || !Number.isInteger(ranCount) || ranCount < 1) {
      return malformed(`ranCount is ${JSON.stringify(ranCount)}, expected an integer >= 1`);
    }
    const entries = Array.isArray(result.methods) ? result.methods : undefined;
    if (entries === undefined || entries.length !== ranCount) {
      return malformed(
        `methods holds ${entries === undefined ? "no array" : `${entries.length} entries`}, ranCount says ${ranCount}`,
      );
    }
    if (ranCount > methods.length) {
      return malformed(`ranCount ${ranCount} exceeds the ${methods.length} methods requested`);
    }
    if (endedBy === "complete" && ranCount !== methods.length) {
      return malformed(`endedBy complete but ${ranCount} of ${methods.length} methods ran`);
    }
    const verdicts: TestVerdict[] = [];
    for (let i = 0; i < entries.length; i++) {
      const raw = entries[i] as Partial<GroupEntry> | undefined;
      const want = methods[i];
      if (raw === undefined || want === undefined) return malformed(`entry ${i + 1} is absent`);
      if (raw.index !== i + 1)
        return malformed(`entry ${i + 1} carries index ${JSON.stringify(raw.index)}`);
      if (raw.codeunitId !== want.ref.codeunitId || raw.method !== want.ref.method) {
        return malformed(
          `entry ${i + 1} is ${JSON.stringify(raw.codeunitId)}.${JSON.stringify(raw.method)}, expected ${want.ref.codeunitId}.${want.ref.method}`,
        );
      }
      if (typeof raw.durationMs !== "number") return malformed(`entry ${i + 1} has no durationMs`);
      const results =
        typeof raw.codeunitResults === "string"
          ? raw.codeunitResults
          : raw.codeunitResults !== undefined && raw.codeunitResults !== null
            ? JSON.stringify(raw.codeunitResults)
            : undefined;
      if (results === undefined) return malformed(`entry ${i + 1} has no codeunitResults`);
      // The three per-entry faults that abort the session today keep doing so: the line count,
      // BC's own inner method name, and the result enum are checked by the SAME code `run` uses.
      const v = this.mapRanResult(
        want.ref,
        raw.durationMs,
        { codeunitResults: results, observedAny: attestation.observedAny, identityMismatch: false },
        fencedOp,
      );
      if (v.outcome === "error") return call(v);
      const isLast = i === entries.length - 1;
      if (endedBy === "failure") {
        if (isLast && v.outcome !== "fail")
          return malformed(`endedBy failure but entry ${i + 1} passed`);
        if (!isLast && v.outcome !== "pass")
          return malformed(`endedBy failure but entry ${i + 1} did not pass`);
      } else if (v.outcome !== "pass") {
        return malformed(`endedBy ${endedBy} but entry ${i + 1} did not pass`);
      }
      verdicts.push({ ...v, attestation });
    }
    return { kind: "verdicts", endedBy, ranCount, verdicts, durationMs };
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
    // R53: with the stop hook wired, the budget is a SOFT deadline — fire the stop and keep this
    // request open for BC's 408 — and the abort moves out to a hard cap so the run still ends if
    // neither the stop nor the answer arrives. Without the hook this is byte-for-byte the old
    // behaviour: one timer, abort at the budget.
    const stopHook = req.onBudgetExceeded;
    let stopFired = false;
    let stopHookError: unknown;
    const timer =
      stopHook === undefined
        ? setTimeout(() => controller.abort(), timeoutMs)
        : setTimeout(() => {
            stopFired = true;
            // Deliberately not awaited: this runs off a timer while the request is still open, and
            // the answer we care about arrives on the request, not from the hook.
            void stopHook().catch((err: unknown) => {
              stopHookError = err;
            });
          }, timeoutMs);
    const hardTimer =
      stopHook === undefined
        ? undefined
        : setTimeout(() => controller.abort(), timeoutMs + (req.stopGraceMs ?? 30_000));
    // R191: the timers stay armed until the BODY is in hand, not until the headers are. `fetch`
    // resolves on headers; BC can stall after them, and a stall there used to fall outside every
    // LethAL timer, so the R53 stop hook never fired and the run ended only when the runtime gave
    // up (measured: 272 s, then a quarantine). Bun honours the abort signal during `res.text()`
    // (measured), so one controller now covers both phases and every exit settles the timers.
    const settleTimers = () => {
      clearTimeout(timer);
      if (hardTimer !== undefined) clearTimeout(hardTimer);
    };
    /** Our own abort fired, in either phase: the call may have reached the server and left a
     *  mutant active (clear unconfirmed) → in-flight-unknown, the orchestrator quarantines. */
    const abortedVerdict = (
      err: unknown,
      phase: "before headers" | "after headers",
    ): TestVerdict => {
      // R53: if the stop hook fired and we still ended up aborting, BC never sent the 408 — so
      // name why. A hook that THREW is the likeliest cause and is otherwise invisible here,
      // which is R65's lesson: an unexplained quarantine costs a debugging session.
      const stopDetail = !stopFired
        ? ""
        : stopHookError !== undefined
          ? ` — the server-side stop was attempted and FAILED (${describeThrown(stopHookError)}), so this run could not be scored and is quarantined instead`
          : " — the server-side stop was attempted but BC never answered this request with its stop confirmation, so this run is quarantined rather than scored";
      return {
        ref,
        outcome: "deadline-exceeded",
        durationMs: Date.now() - started,
        failureMessage: `RunMutant timed out ${phase}: ${String(err)}${stopDetail}`,
        operation: "in-flight-unknown",
        fencedOp,
      };
    };
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
      settleTimers();
      if (controller.signal.aborted) return abortedVerdict(err, "before headers");
      // fetchFn was already invoked; a rejection here (e.g. connection reset) may have reached BC
      // AFTER the request was fully sent and left a mutant active — never retry-safe (parent §7).
      return {
        ref,
        outcome: "error",
        durationMs: Date.now() - started,
        failureMessage: `RunMutant connection failed after dispatch: ${String(err)}`,
        operation: "in-flight-unknown",
        fencedOp,
      };
    }

    // R53: BC's answer to the request we deliberately held open. Checked BEFORE the generic
    // non-2xx branch below, which would otherwise classify this 408 as `in-flight-unknown` — the
    // exact quarantine this feature exists to replace.
    //
    // `outcome: "timeout"` reuses the existing rule (orchestrator: timeout ⇒ `timeout-killed`).
    // No new verdict is introduced; what is new is having EARNED it — BC states the session was
    // stopped, so the operation is over and the tier is not stranded. `operation` is deliberately
    // absent: this is terminal.
    if (stopFired && res.status === 408) {
      const body = await res.text().catch(() => "");
      settleTimers();
      if (isAlStopResponse(res.status, body)) {
        return {
          ref,
          outcome: "timeout",
          durationMs: Date.now() - started,
          failureMessage:
            `RunMutant exceeded its ${timeoutMs} ms budget and was stopped server-side so it could ` +
            `be scored rather than strand the tier. BC's own words: ${JSON.stringify(body.slice(0, 400))}`,
        };
      }
      // A 408 that is NOT BC's AL-stop answer (a proxy timing the socket out looks like this).
      // Falls through to the non-2xx branch → in-flight-unknown → quarantine, unchanged.
    }

    if (!res.ok) {
      settleTimers();
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

    // Read the body as text FIRST, then parse. `res.json()` inside a try that collapses to
    // `undefined` cannot distinguish "the body was not JSON at all" from "the JSON had no
    // `value` key" — and this branch quarantines a tier, so the operator needs to know which.
    // Live-earned: this fired repeatedly on one mutant with no way to see what BC actually sent.
    let rawBody: string;
    try {
      rawBody = await res.text();
    } catch (err) {
      settleTimers();
      // R191: the budget ran out while the body was still coming. Same answer as a stall before
      // the headers, and the stop hook has had its chance by now, so the message says which it was.
      if (controller.signal.aborted) return abortedVerdict(err, "after headers");
      return this.inFlightUnknown(
        ref,
        Date.now() - started,
        `RunMutant 2xx body could not be read: ${String(err)}`,
        fencedOp,
      );
    }
    settleTimers();
    // R191: taken AFTER the body, so a stall between headers and body is in the number a reader
    // sees. The R175 re-run recorded 2,800 ms for a mutant whose body read took 272 s.
    const durationMs = Date.now() - started;
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

    // Shared with `runMany` (R198): artifact-mismatch, reserved-params, lease-invalid with its
    // reason — one classifier, so the two paths cannot drift on a refusal's `operation`.
    const refusal = this.classifyRefusal(result, ref, durationMs, "RunMutant");
    if (refusal !== null) return refusal;
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
    result: Pick<RunMutantResult, "codeunitResults" | "observedAny" | "identityMismatch">,
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
    let parsed: { testResults?: unknown; error?: unknown };
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
      // R139: the server's own `error` key says WHY, and this branch used to throw it away. Both
      // producers of a line-count answer put their reason there — `RunOneMethod`'s fail-closed exit
      // for a method it could not select exactly once, and `BuildRunError` for every caught phase-2
      // terminal error — so "zero lines" alone cannot tell a stale published test app from a lock
      // timeout. `runMutantLineCountMessage` appends the text verbatim when there is one and leaves
      // the message byte-identical when there is not.
      return {
        ref,
        outcome: "error",
        durationMs,
        failureMessage: runMutantLineCountMessage(lines.length, parsed.error),
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

  /**
   * The three confirmed refusals `RunMutant` and `RunMutantMany` share, classified identically:
   * `artifact-mismatch` (the deployed target was replaced: a typed error, never `survived`),
   * `reserved-params` (a protocol/version fault), and `lease-invalid` — Layer 5C-B1 (design
   * §5/§8), a confirmed refusal that is never `in-flight-unknown` and never a bare error: the
   * orchestrator must latch/invalidate, EXCEPT for the reasons it reads first: `"op-in-flight"`
   * (this caller's own attempt is still active: poll, do not retry) and, since R198/R203,
   * `"op-stopped"` (our own stop tombstoned this op while its session was finishing: record an
   * error, do not latch). `reason` is preserved verbatim. `null` means "not a refusal".
   */
  private classifyRefusal(
    result: { readonly status?: unknown; readonly reason?: unknown },
    ref: TestMethodRef,
    durationMs: number,
    action: string,
  ): TestVerdict | null {
    if (result.status === "artifact-mismatch") {
      return {
        ref,
        outcome: "error",
        durationMs,
        failureMessage: `${action} artifact-mismatch: deployed artifact ${this.artifactId} was replaced`,
      };
    }
    if (result.status === "reserved-params") {
      return {
        ref,
        outcome: "error",
        durationMs,
        failureMessage: `${action} rejected reserved lease params (protocol mismatch)`,
      };
    }
    if (result.status === "lease-invalid") {
      const reason = typeof result.reason === "string" ? result.reason : undefined;
      return {
        ref,
        outcome: "error",
        durationMs,
        failureMessage:
          reason !== undefined
            ? `${action} lease-invalid (reason: ${reason})`
            : `${action} lease-invalid`,
        operation: "lease-lost",
        ...(reason !== undefined ? { leaseInvalidReason: reason } : {}),
      };
    }
    return null;
  }

  /** The CALL-level echo (`targetAppId`, `artifactId`, `attemptId`, `mutantId`); per-method fields
   *  are checked per entry by `runMany` and by `identityMismatch` for `run`. */
  private callEchoMismatch(
    result: {
      readonly targetAppId?: unknown;
      readonly artifactId?: unknown;
      readonly attemptId?: unknown;
      readonly mutantId?: unknown;
    },
    attemptId: string,
    mutantId: string,
    action: string,
  ): string | null {
    const mismatches: string[] = [];
    if (result.targetAppId !== this.targetAppId)
      mismatches.push(`targetAppId ${JSON.stringify(result.targetAppId)}≠${this.targetAppId}`);
    if (result.artifactId !== this.artifactId)
      mismatches.push(`artifactId ${JSON.stringify(result.artifactId)}≠${this.artifactId}`);
    if (result.attemptId !== attemptId)
      mismatches.push(`attemptId ${JSON.stringify(result.attemptId)}≠${attemptId}`);
    if (result.mutantId !== mutantId)
      mismatches.push(`mutantId ${JSON.stringify(result.mutantId)}≠${mutantId}`);
    return mismatches.length > 0 ? `${action} identity mismatch: ${mismatches.join(", ")}` : null;
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
