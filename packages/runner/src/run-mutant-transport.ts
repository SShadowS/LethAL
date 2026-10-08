import { AsyncLocalStorage } from "node:async_hooks";
import { appendFileSync } from "node:fs";
import type { ActivationConfig, FetchFn } from "./activation";
import type { StopState, TestMethodRef, TestOutcome, TestVerdict } from "./backend";
import { bcFetch } from "./bc-fetch";
import { describeThrown } from "./describe-error";
import { UnfilteredExtensionsQueryError } from "./harness";
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
   *
   * R-204b: the hook is handed its own bound (the grace) and RESOLVES with the stop's answer; a
   * refusal is `{ stopped: false }`, never a rejection. A rejection means the answer is unknown
   * (the reply was lost), which is not the same thing and is not retry-safe.
   */
  readonly onBudgetExceeded?: (boundMs: number) => Promise<StopHookAnswer>;
  /**
   * How long to keep waiting after `onBudgetExceeded` fires before giving up and aborting. Bounds
   * the hold-open: if BC answers neither the stop nor this request, the run must still end.
   * Ignored when `onBudgetExceeded` is absent.
   */
  readonly stopGraceMs?: number;
}

/** R-204b: what the single path's stop hook resolves with. */
export interface StopHookAnswer {
  readonly stopped: boolean;
  readonly reason?: string;
}

/** R-204b: `p`, or a rejection once `ms` has passed, for a fetch that ignores its abort signal. */
function bounded<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let guard: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<never>((_resolve, reject) => {
      guard = setTimeout(() => reject(new Error(`${what} gave no answer within ${ms} ms`)), ms);
    }),
  ]).finally(() => {
    if (guard !== undefined) clearTimeout(guard);
  });
}

/**
 * R-204b: a grouped call's stop state from its attempts. `refused` only if EVERY attempt was
 * refused; otherwise the last attempt that was not. Absent when no stop was sent.
 */
export function callStopState(attempts: readonly StopState[]): StopState | undefined {
  if (attempts.length === 0) return undefined;
  return attempts.filter((s) => s !== "refused").at(-1) ?? "refused";
}

/** R-204b: copy the call's stop state onto every verdict it carries, as data. */
function stampManyStop(
  r: RunMutantManyResult,
  attempts: readonly StopState[],
): RunMutantManyResult {
  const stopState = callStopState(attempts);
  if (stopState === undefined) return r;
  return r.kind === "call"
    ? { ...r, verdict: { ...r.verdict, stopState } }
    : { ...r, verdicts: r.verdicts.map((v) => ({ ...v, stopState })) };
}

/** R-204b: the single path's stop, per call. `done` settles `state`; it never rejects. */
interface StopTracker {
  fired: boolean;
  state?: StopState;
  error?: unknown;
  refusal?: string;
  done?: Promise<void>;
}

/**
 * R-204b: waits for the single path's stop to settle, but only until `deadline` (the REMAINING
 * grace), then stamps its state on the verdict. Still unanswered then: `unknown`.
 */
async function settleStop(
  v: TestVerdict,
  stop: StopTracker,
  deadline: number,
): Promise<TestVerdict> {
  if (!stop.fired) return v;
  const left = deadline - Date.now();
  if (stop.state === "issued" && stop.done !== undefined && left > 0) {
    await bounded(stop.done, left, "the stop").catch(() => {});
  }
  const stopState: StopState =
    stop.state === "issued" || stop.state === undefined ? "unknown" : stop.state;
  const why =
    stopState === "refused"
      ? ` (${stop.refusal ?? "no reason given"})`
      : stop.error !== undefined
        ? ` (${describeThrown(stop.error)})`
        : "";
  return {
    ...v,
    stopState,
    ...(v.operation === "in-flight-unknown"
      ? { failureMessage: `${v.failureMessage ?? "no detail"}; LethAL's stop: ${stopState}${why}` }
      : {}),
  };
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

/** R236b: the upper bound on one `GetOpAnswer` readback; a call's own smaller budget wins. */
export const KEPT_ANSWER_READ_MS = 15_000;

/** R236b: what `GetOpAnswer` holds for one op. `found: false` names the op the server holds, if any. */
export type KeptAnswer =
  | { readonly found: true; readonly answer: string }
  | { readonly found: false; readonly keptAttemptId?: string; readonly keptOpSeq?: number };

/**
 * R206 §2.1: the two session keys a `ran` answer must carry (control app 1.0.0.18), or the reason
 * it is malformed. `testRunsBefore` is the guard's predicate (0 = a fresh session); `sessionId`
 * is recorded as data and asserted constant across a group call's entries.
 */
function sessionKeysOf(
  result: Pick<RunMutantResult, "testRunsBefore" | "sessionId">,
): { readonly sessionId: number; readonly testRunsBefore: number } | string {
  const { sessionId, testRunsBefore } = result;
  if (typeof sessionId !== "number" || !Number.isInteger(sessionId)) {
    return `answer ran but carries no integer sessionId (got ${JSON.stringify(sessionId)}); control app 1.0.0.18 stamps it on every answer that ran`;
  }
  if (
    typeof testRunsBefore !== "number" ||
    !Number.isInteger(testRunsBefore) ||
    testRunsBefore < 0
  ) {
    return `answer ran but carries no integer testRunsBefore >= 0 (got ${JSON.stringify(testRunsBefore)}); control app 1.0.0.18 stamps it on every answer that ran`;
  }
  return { sessionId, testRunsBefore };
}

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
  /** R206 §2.1: see `RunMutantResult`. */
  readonly testRunsBefore?: unknown;
  readonly sessionId?: unknown;
}

interface GroupEntry {
  readonly index: unknown;
  readonly codeunitId: unknown;
  readonly method: unknown;
  readonly codeunitResults: unknown;
  readonly durationMs: unknown;
  /** R206: the function line the entry ran (distinct across a call) and the session it ran in. */
  readonly lineNo: unknown;
  readonly sessionId: unknown;
  /** GH-24: per-entry reach attestation — see `TestVerdict.reachedActive`. */
  readonly observedActive: unknown;
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
  /** GH-24: per-test reach attestation — see `TestVerdict.reachedActive`. */
  readonly observedActive?: unknown;
  /** R58: present only on the `RunMutantWithCoverage` action — see `FencedCoverageRow`. */
  readonly coverage?: unknown;
  /**
   * R206 §2.1, on a `ran` answer only (control app 1.0.0.18): `testRunsBefore` is the server's
   * per-session count of test methods run BEFORE this call (0 = a fresh session; anything else
   * means the platform handed this call a session another call had run tests in), and `sessionId`
   * is that session's id, recorded as data. Checked inside the `ran` branch only: a refusal ran
   * nothing, carries neither, and keeps its own class.
   */
  readonly testRunsBefore?: unknown;
  readonly sessionId?: unknown;
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
      /** R206: the 1-based position in the request of the method `verdict` is about. */
      readonly methodIndex: number;
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

/**
 * R-496: the per-call record `refusalBoundary` reads; see there. R499: `pending` holds this call's
 * fetches still in flight (the recording wrapper's own promise, mapped to its action name).
 */
type RefusalHolder = {
  refusal?: UnfilteredExtensionsQueryError;
  closed?: boolean;
  readonly pending: Map<Promise<Response>, string>;
};
const refusalScope = new AsyncLocalStorage<RefusalHolder>();

/**
 * R499: the control-request state every transport of one backend shares, so a fetch left in flight
 * by one transport is drained by the next scored call on ANY of them, and once more at teardown.
 * `orphans`: fetches still in flight whose call already returned (or that had no call). `lateRefusal`:
 * a refusal recorded after its call exited; the next call's boundary (or the teardown) throws it.
 */
export type ControlState = {
  readonly orphans: Map<Promise<Response>, string>;
  lateRefusal?: UnfilteredExtensionsQueryError | undefined;
};

/** R499: a fresh, empty `ControlState`. */
export function newControlState(): ControlState {
  return { orphans: new Map() };
}

/** R499: how long a scored call (and the teardown) waits for in-flight control requests. */
export const CONTROL_DRAIN_MS = 5_000;

/**
 * R499: a scored call's control requests were still in flight when `CONTROL_DRAIN_MS` ran out. The
 * call publishes nothing and the session ends: a fetch that ignored its own abort this long means a
 * broken runtime, and a refusal could still land on it.
 */
export class ControlDrainTimeoutError extends Error {
  constructor(actions: readonly string[], boundMs: number) {
    super(
      `R499: ${actions.join(", ")} still outstanding after ${boundMs} ms; this call is not scored and the session ends`,
    );
    this.name = "ControlDrainTimeoutError";
  }
}

/** R-496: the error the teardown throws for a refusal no call has thrown yet. */
function lateRefusalError(late: UnfilteredExtensionsQueryError): UnfilteredExtensionsQueryError {
  return new UnfilteredExtensionsQueryError(
    `a BC redirect to an unfiltered extensions query arrived after a mutant's verdict was returned, so that verdict's session may not be trustworthy: ${late.message}`,
  );
}

/** R-496/R499: hand over (and clear) the refusal `state` holds that no call has thrown yet. */
export function takeLateRefusal(state: ControlState): UnfilteredExtensionsQueryError | undefined {
  const late = state.lateRefusal;
  state.lateRefusal = undefined;
  return late === undefined ? undefined : lateRefusalError(late);
}

/** R499: a single-path verdict that is a score (and so waits for in-flight control requests). */
function isScoredVerdict(v: TestVerdict): boolean {
  return (
    v.operation === undefined &&
    (v.outcome === "pass" || v.outcome === "fail" || v.outcome === "timeout")
  );
}

/** R499: the action name in a `.../LethALControl_<action>?...` URL, for messages. */
function actionOf(url: string | URL | Request): string {
  const s = url instanceof Request ? url.url : String(url);
  return /LethALControl_(\w+)/.exec(s)?.[1] ?? s;
}

/**
 * R499: wait until every promise in `maps` has settled (re-reading the maps, as a settling fetch
 * removes itself), or until `ms` runs out. Never throws.
 */
export async function drainPending(
  maps: readonly Map<Promise<Response>, string>[],
  ms: number,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expired = false;
  const expiry = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      expired = true;
      resolve();
    }, ms);
  });
  // `seen`: promises already awaited to settlement, so an entry that is never removed cannot spin
  // this loop on microtasks forever (the expiry timer would never get to run).
  const seen = new Set<Promise<Response>>();
  try {
    for (;;) {
      const open = maps.flatMap((m) => [...m.keys()]).filter((p) => !seen.has(p));
      if (open.length === 0 || expired) return;
      await Promise.race([Promise.allSettled(open), expiry]);
      if (!expired) for (const p of open) seen.add(p);
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export class RunMutantTransport {
  /** R289: `LETHAL_R289_TRACE`, read once here; an empty string counts as unset. */
  private readonly tracePath: string | undefined;
  private readonly traceWrite: (path: string, line: string) => void;
  private readonly fetchFn: FetchFn;
  private readonly state: ControlState;
  private readonly drainMs: number;

  /** R499: the shared control state; `BcDevMcpBackend.bindTransport` checks it is the backend's own. */
  get controlState(): ControlState {
    return this.state;
  }

  /** R-496: hand over (and clear) a refusal no call has thrown yet; the session teardown asks once. */
  takeLateRefusal(): UnfilteredExtensionsQueryError | undefined {
    return takeLateRefusal(this.state);
  }

  /**
   * R-496: run one public call; if any fetch inside it (a swallowed catch, a stop timer, the status
   * read) was refused as an unfiltered extensions query, throw that refusal at exit, whatever the
   * call would otherwise have returned or thrown.
   *
   * R499: before a SCORED result (`isScored`) is returned, wait up to `drainMs` for every fetch
   * still in flight, this call's and the orphans of earlier calls, so a refusal that lands
   * meanwhile is thrown here rather than after a verdict was published. A fetch still in flight
   * after the bound throws `ControlDrainTimeoutError`. A non-scored exit does not wait: its fetches
   * become orphans for the next scored call (or the teardown) to drain.
   */
  private async refusalBoundary<T>(fn: () => Promise<T>, isScored: (v: T) => boolean): Promise<T> {
    // A refusal that landed after an earlier call exited (a stop still pending past its bound) is
    // thrown here, before anything is sent, and cleared only by being thrown.
    const late = this.state.lateRefusal;
    if (late !== undefined) {
      this.state.lateRefusal = undefined;
      throw late;
    }
    const holder: RefusalHolder = { pending: new Map() };
    let outcome: { ok: true; value: T } | { ok: false; error: unknown };
    try {
      outcome = { ok: true, value: await refusalScope.run(holder, fn) };
    } catch (error) {
      outcome = { ok: false, error };
    }
    const scored = outcome.ok && isScored(outcome.value);
    if (scored) await drainPending([holder.pending, this.state.orphans], this.drainMs);
    holder.closed = true;
    const outstanding = [...holder.pending, ...this.state.orphans].map(([, action]) => action);
    for (const [p, action] of holder.pending) this.state.orphans.set(p, action);
    holder.pending.clear();
    if (holder.refusal !== undefined) throw holder.refusal;
    if (!outcome.ok) throw outcome.error;
    if (scored) {
      const lateNow = this.state.lateRefusal;
      if (lateNow !== undefined) {
        this.state.lateRefusal = undefined;
        throw lateNow;
      }
      if (outstanding.length > 0) throw new ControlDrainTimeoutError(outstanding, this.drainMs);
    }
    return outcome.value;
  }

  constructor(
    private readonly cfg: ActivationConfig,
    private readonly targetAppId: string,
    private readonly artifactId: string,
    injectedFetch: FetchFn = bcFetch,
    opts: {
      readonly traceWrite?: (path: string, line: string) => void;
      /** R499: the backend's shared state; a fresh one when absent (tests, probes). */
      readonly controlState?: ControlState;
      /** R499 test seam: the drain bound, `CONTROL_DRAIN_MS` when absent. */
      readonly drainMs?: number;
    } = {},
  ) {
    this.state = opts.controlState ?? newControlState();
    this.drainMs = opts.drainMs ?? CONTROL_DRAIN_MS;
    // R-496: every fetch this transport makes records an unfiltered-extensions refusal for the
    // CURRENT public call (async-local, so concurrent calls never share a record), then rethrows.
    // R499: the wrapper's OWN promise is registered as in flight and removed in its `finally`, so a
    // refusal is recorded before the entry leaves the map and a drain never sees it settled first.
    const recording = (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const holder = refusalScope.getStore();
      const map =
        holder !== undefined && holder.closed !== true ? holder.pending : this.state.orphans;
      // `self.p` rather than `p` in the `finally`: a fetch that throws synchronously reaches it
      // before `p` is assigned, and is then never registered.
      const self: { p?: Promise<Response>; settled?: boolean } = {};
      const p: Promise<Response> = (async () => {
        try {
          return await injectedFetch(url, init);
        } catch (err) {
          if (err instanceof UnfilteredExtensionsQueryError) {
            if (holder === undefined || holder.closed === true) {
              // outside any call, or after it exited: keep it for the next call (or the teardown)
              this.recordLate(err);
            } else if (holder.refusal === undefined) {
              holder.refusal = err;
            }
          }
          throw err;
        } finally {
          self.settled = true;
          if (self.p !== undefined) {
            holder?.pending.delete(self.p);
            this.state.orphans.delete(self.p);
          }
        }
      })();
      self.p = p;
      if (self.settled !== true) map.set(p, actionOf(url));
      return p;
    };
    this.fetchFn = Object.assign(recording, { preconnect: injectedFetch.preconnect });
    const p = process.env.LETHAL_R289_TRACE;
    this.tracePath = p === undefined || p === "" ? undefined : p;
    this.traceWrite = opts.traceWrite ?? appendFileSync;
  }

  /** R499: keep the first late refusal; a later one is warned, never dropped silently. */
  private recordLate(err: UnfilteredExtensionsQueryError): void {
    if (this.state.lateRefusal === undefined) {
      this.state.lateRefusal = err;
      return;
    }
    console.warn(
      `[lethal] a further refused unfiltered extensions query: ${lateRefusalError(err).message}`,
    );
  }

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
   * Throws on transport failure; the caller surfaces that in the quarantine note. R-204b:
   * `timeoutMs` bounds the headers AND the body, and holds even for a fetch that ignores its abort.
   */
  async stopHungRun(req: {
    readonly attemptId: string;
    readonly lease: LeaseTuple & { readonly opSeq: number };
    readonly timeoutMs: number;
  }): Promise<{ stopped: boolean; sessionId?: number; reason?: string }> {
    assertAttemptId(req.attemptId);
    const parsed = await bounded(
      this.postAction(
        "StopHungRun",
        {
          epoch: req.lease.epoch,
          token: req.lease.token,
          generation: req.lease.serverGeneration,
          attemptId: req.attemptId,
          opSeq: req.lease.opSeq,
        },
        req.timeoutMs,
      ),
      req.timeoutMs,
      "StopHungRun",
    );
    const { stopped, sessionId, reason } = parsed;
    if (typeof stopped !== "boolean") {
      throw new Error(`StopHungRun returned no boolean \`stopped\`: ${JSON.stringify(parsed)}`);
    }
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
    timeoutMs?: number,
  ): Promise<OperationStatus> {
    const json = await this.postAction(
      "GetOperationStatus",
      {
        epoch: lease.epoch,
        token: lease.token,
        generation: lease.serverGeneration,
        attemptId,
        opSeq,
      },
      timeoutMs,
    );
    return parseOperationStatus(json);
  }

  /**
   * R236b: the answer the control app committed as the last statement of an action that RAN, only if
   * it names exactly this op under this lease. The server's echo of all four key values is checked
   * here; any disagreement, transport fault or shape fault throws, and every caller fails closed on
   * a throw.
   */
  async readKeptAnswer(
    lease: LeaseTuple,
    attemptId: string,
    opSeq: number,
    timeoutMs: number,
  ): Promise<KeptAnswer> {
    assertAttemptId(attemptId);
    const parsed = await this.postAction(
      "GetOpAnswer",
      { epoch: lease.epoch, generation: lease.serverGeneration, attemptId, opSeq },
      timeoutMs,
    );
    if (parsed.found === false) {
      const { keptAttemptId, keptOpSeq } = parsed;
      return {
        found: false,
        ...(typeof keptAttemptId === "string" ? { keptAttemptId } : {}),
        ...(typeof keptOpSeq === "number" ? { keptOpSeq } : {}),
      };
    }
    if (parsed.found !== true) {
      throw new Error(
        `GetOpAnswer returned no boolean found: ${JSON.stringify(parsed).slice(0, 300)}`,
      );
    }
    const mismatches: string[] = [];
    if (parsed.attemptId !== attemptId)
      mismatches.push(`attemptId ${JSON.stringify(parsed.attemptId)}`);
    if (parsed.opSeq !== opSeq) mismatches.push(`opSeq ${JSON.stringify(parsed.opSeq)}`);
    if (parsed.epoch !== lease.epoch) mismatches.push(`epoch ${JSON.stringify(parsed.epoch)}`);
    if (parsed.generation !== lease.serverGeneration) {
      mismatches.push(`generation ${JSON.stringify(parsed.generation)}`);
    }
    if (mismatches.length > 0) {
      throw new Error(
        `GetOpAnswer echoed a different key (${mismatches.join(", ")}) for ${attemptId}/${opSeq}`,
      );
    }
    if (typeof parsed.answer !== "string") {
      throw new Error("GetOpAnswer said found but carried no string answer");
    }
    return { found: true, answer: parsed.answer };
  }

  /**
   * R236b: `readKeptAnswer` held to `bound`. The abort inside `postAction` ends the request; the
   * race holds the bound even for a fetch that ignores its abort signal.
   */
  private async readKeptAnswerBounded(
    lease: LeaseTuple,
    fencedOp: { readonly attemptId: string; readonly opSeq: number },
    bound: number,
  ): Promise<KeptAnswer> {
    return bounded(
      this.readKeptAnswer(lease, fencedOp.attemptId, fencedOp.opSeq, bound),
      bound,
      "GetOpAnswer",
    );
  }

  /**
   * R204: did the op's own progress row record method `methodIndex`'s completion before our stop
   * landed? One status read, shared by both grains so they cannot drift. Unavailable evidence
   * (the read throws, no row, a row that is not this attempt's) is `false`: today's answer stands.
   */
  private async completedBeforeStop(
    lease: LeaseTuple & { readonly opSeq: number },
    attemptId: string,
    methodIndex: number,
  ): Promise<boolean> {
    try {
      // Bounded like the R236b readback: an unanswered read is unavailable evidence, not a hang.
      const status = await bounded(
        this.getOperationStatus(lease, attemptId, lease.opSeq, KEPT_ANSWER_READ_MS),
        KEPT_ANSWER_READ_MS,
        "GetOperationStatus",
      );
      const row = status.opProgress;
      return (
        row !== undefined &&
        row.attemptId === attemptId &&
        row.opSeq === lease.opSeq &&
        row.lastCompletedIndex >= methodIndex
      );
    } catch {
      return false;
    }
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
    /** R-204b: bounds headers and body, like `stopHungRun`'s. */
    readonly timeoutMs: number;
  }): Promise<StopAtAnswer> {
    assertAttemptId(req.attemptId);
    const parsed = await bounded(
      this.postAction(
        "StopHungRunAt",
        {
          epoch: req.lease.epoch,
          token: req.lease.token,
          generation: req.lease.serverGeneration,
          attemptId: req.attemptId,
          opSeq: req.lease.opSeq,
          methodIndex: req.methodIndex,
          methodToken: req.methodToken,
        },
        req.timeoutMs,
      ),
      req.timeoutMs,
      "StopHungRunAt",
    );
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
    timeoutMs?: number,
  ): Promise<Record<string, unknown>> {
    const params = new URLSearchParams({ company: this.cfg.company });
    if (this.cfg.tenant !== undefined) params.set("tenant", this.cfg.tenant);
    const url = `${this.cfg.baseUrl}/ODataV4/LethALControl_${action}?${params.toString()}`;
    // Manual controller, not AbortSignal.timeout(): see the note in `dispatch`. When bounded, the
    // bound covers the body read too (R236b).
    const controller = new AbortController();
    const timer =
      timeoutMs === undefined ? undefined : setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await this.fetchFn(url, {
        method: "POST",
        headers: {
          authorization: `Basic ${btoa(`${this.cfg.username}:${this.cfg.password}`)}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        ...(timeoutMs !== undefined ? { signal: controller.signal } : {}),
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
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async run(req: RunMutantRequest): Promise<TestVerdict> {
    return this.refusalBoundary(
      async () => (await this.execute(req, false)).verdict,
      isScoredVerdict,
    );
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
    const trace = { failures: 0 };
    const r = await this.refusalBoundary(
      () => this.runManyScored(req, trace),
      (m) =>
        m.kind === "verdicts" ||
        (m.verdict.outcome === "timeout" &&
          m.verdict.operation === undefined &&
          m.cause === undefined),
    );
    // R289: a trace that stopped writing is named once per call on stderr, never in a verdict:
    // a verdict's `failureMessage` feeds `killingTestFailure`, the store and verify.ts's
    // callstack match, so a diagnostic suffix there would change what a kill is classified as.
    if (trace.failures > 0) {
      console.warn(
        `LETHAL_R289_TRACE=${this.tracePath ?? ""}: trace write failed ${trace.failures} times during ${req.mutantId} (attempt ${req.attemptId}, opSeq ${req.lease.opSeq}); tracing stopped for this call`,
      );
    }
    return r;
  }

  /** `runMany` before R289's trace warning: one dispatch plus R236b's readback. */
  private async runManyScored(
    req: RunMutantManyRequest,
    trace: { failures: number },
  ): Promise<RunMutantManyResult> {
    const stopAttempts: StopState[] = [];
    const first = stampManyStop(await this.runManyOnce(req, trace, stopAttempts), stopAttempts);
    // Review r2 ruling C2: a call that must abort the session is never replaced, whatever the
    // kept answer says.
    if (
      first.kind !== "call" ||
      first.abortSession !== undefined ||
      first.verdict.operation !== "in-flight-unknown" ||
      first.verdict.fencedOp === undefined
    ) {
      return first;
    }
    const lost = first.verdict;
    const fencedOp = first.verdict.fencedOp;
    const lostText = lost.failureMessage ?? "no detail";
    // Not accepted: the call goes on exactly as today, only the reason is appended.
    const keep = (why: string): RunMutantManyResult => ({
      ...first,
      verdict: { ...lost, failureMessage: `${lostText}; ${why}` },
    });
    const [firstMethod] = req.methods;
    if (firstMethod === undefined) {
      throw new Error("unreachable: runManyOnce refused an empty methods list");
    }
    let kept: KeptAnswer;
    try {
      // `KEPT_ANSWER_READ_MS` alone bounds this read: a group's budget is minutes.
      kept = await this.readKeptAnswerBounded(req.lease, fencedOp, KEPT_ANSWER_READ_MS);
    } catch (err) {
      // R-496: a refused extensions query is thrown, never folded into the unknown's message.
      if (err instanceof UnfilteredExtensionsQueryError) throw err;
      return keep(`answer readback failed: ${describeThrown(err)}`);
    }
    if (!kept.found) {
      const holds =
        kept.keptAttemptId !== undefined && kept.keptOpSeq !== undefined
          ? ` (it holds ${kept.keptAttemptId}/${kept.keptOpSeq})`
          : "";
      return keep(
        `answer readback: the server holds no committed answer for ${fencedOp.attemptId}/${fencedOp.opSeq}${holds}`,
      );
    }
    let r: RunMutantManyResult;
    try {
      r = this.scoreManyAnswer(kept.answer, {
        req,
        firstMethod,
        watchedRef: firstMethod.ref,
        call: this.callOf(req.methods),
        durationMs: lost.durationMs,
        fencedOp,
      });
    } catch (err) {
      return keep(`answer readback not accepted: ${describeThrown(err)}`);
    }
    // Ruling C1, grouped form: only a verdict set of completed, identity-checked passes and fails.
    if (
      r.kind !== "verdicts" ||
      r.verdicts.some(
        (v) => (v.outcome !== "pass" && v.outcome !== "fail") || v.operation !== undefined,
      )
    ) {
      return keep("answer readback not accepted: not a verdict set of completed passes and fails");
    }
    return { ...r, verdicts: r.verdicts.map((v) => ({ ...v, replyRecovered: lostText })) };
  }

  /**
   * One `RunMutantMany` dispatch and its scoring; `runMany` adds R236b's readback. R-204b: the
   * watchdog appends one state per stop attempt to `stopAttempts`, final by the time this returns.
   */
  private async runManyOnce(
    req: RunMutantManyRequest,
    traceState: { failures: number },
    stopAttempts: StopState[],
  ): Promise<RunMutantManyResult> {
    const { mutantId, attemptId, lease, methods } = req;
    assertAttemptId(attemptId);
    if (methods.length === 0) {
      throw new Error("RunMutantMany: a call with no methods is a caller-contract violation");
    }
    const tracePath = this.tracePath;
    if (tracePath !== undefined) {
      // R289: refuse an unwritable trace before anything is dispatched, not halfway through.
      // Calls the real `appendFileSync`, not the injected writer: the writer is a test seam for
      // LATER failures, and the preflight must check the actual file whatever the seam does.
      try {
        appendFileSync(tracePath, "");
      } catch (err) {
        throw new Error(`LETHAL_R289_TRACE=${tracePath} is not writable: ${String(err)}`);
      }
    }
    // R289: a diagnostic trace, kept on purpose (orchestrator ruling), documented in
    // docs/measurements/README.md. One failed write stops it; `runMany` warns once on stderr.
    // It never throws, so it cannot reject the watchdog and leave the main request open.
    const trace = (event: string, extra: Record<string, unknown> = {}) => {
      if (tracePath === undefined || traceState.failures > 0) return;
      try {
        this.traceWrite(
          tracePath,
          `${JSON.stringify({ at: Date.now(), event, mutantId, attemptId, opSeq: lease.opSeq, ...extra })}\n`,
        );
      } catch {
        traceState.failures++;
      }
    };
    const firstMethod = methods[0];
    if (firstMethod === undefined) throw new Error("unreachable: methods is non-empty");
    const started = Date.now();
    const fencedOp = { attemptId, opSeq: lease.opSeq } as const;
    const pollMs = req.watchdogPollMs ?? WATCHDOG_POLL_MS;
    const call = this.callOf(methods);

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
    // R289: the watchdog's own steps, relative to `started`, so a failure message tells them.
    let pollsOk = 0;
    let pollsFailed = 0;
    let pollSeq = 0;
    let lastPollOkAt: number | undefined;
    let stopSentAt: number | undefined;
    let stopAnsweredAt: number | undefined;
    let failedAt: number | undefined;
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
    // R-496: a watchdog request refused as an unfiltered extensions query stops the call: the main
    // request is aborted and the watchdog rejects with the refusal, which every return path below
    // reaches through its `await watchdog`.
    const refuseOnUnfiltered = (err: unknown) => {
      if (!(err instanceof UnfilteredExtensionsQueryError)) return;
      controller.abort();
      throw err;
    };
    const watchdog = (async () => {
      while (!settled) {
        await sleep(pollMs);
        if (settled) return;
        let status: OperationStatus;
        const seq = ++pollSeq;
        const sentAt = Date.now();
        trace("poll-sent", { seq });
        try {
          status = await this.getOperationStatus(lease, attemptId, lease.opSeq);
        } catch (err) {
          pollsFailed++;
          trace("poll-failed", { seq, sentAt, error: describeThrown(err) });
          refuseOnUnfiltered(err);
          continue; // a failed poll is "nothing yet"
        }
        pollsOk++;
        lastPollOkAt = Date.now() - started;
        trace("poll-ok", {
          seq,
          sentAt,
          state: status.opProgress?.state,
          methodIndex: status.opProgress?.methodIndex,
          rowAttemptId: status.opProgress?.attemptId,
          rowOpSeq: status.opProgress?.opSeq,
          startedAt: status.opProgress?.startedAt,
          serverNow: status.serverNow,
        });
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
        stopSentAt = Date.now() - started;
        trace("stop-sent", { methodIndex: row.methodIndex });
        // R-204b: each stop ends in a state, inside the EARLIER of send time + grace and the call's
        // own hard cap, so a stop sent late cannot buy a fresh grace after the cap.
        const attempt = stopAttempts.push("issued") - 1;
        const stopBound = Math.max(0, Math.min(req.stopGraceMs, hardCapMs - stopSentAt));
        try {
          answer = await this.stopHungRunAt({
            attemptId,
            lease,
            methodIndex: row.methodIndex,
            methodToken: row.token,
            timeoutMs: stopBound,
          });
        } catch (err) {
          stopAttempts[attempt] = "unknown";
          stopAnsweredAt = Date.now() - started;
          trace("stop-threw", { error: describeThrown(err) });
          refuseOnUnfiltered(err);
          stopHookError = err;
          continue;
        }
        stopAttempts[attempt] = answer.stopped ? "confirmed" : "refused";
        stopAnsweredAt = Date.now() - started;
        trace("stop-answered", { stopped: answer.stopped, reason: answer.reason });
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
    // Handled here so a refusal is not reported as unhandled before the `await watchdog` below
    // reads it; that await still rejects.
    watchdog.catch(() => {});
    const settle = () => {
      settled = true;
      clearTimeout(hardTimer);
      wake?.();
    };
    const stopDetail = () =>
      `${lastRefusal !== undefined ? ` last stop refusal: ${lastRefusal};` : ""}${lastRow !== undefined ? ` progress row: ${lastRow};` : ""}${stopHookError !== undefined ? ` stop hook: ${describeThrown(stopHookError)};` : ""} watchdog: polls ok ${pollsOk}, polls failed ${pollsFailed}${lastPollOkAt !== undefined ? `, last poll ok at +${lastPollOkAt}ms` : ""}${stopSentAt !== undefined ? `; stop sent at +${stopSentAt}ms, ${stopAnsweredAt !== undefined ? `answered at +${stopAnsweredAt}ms` : "unanswered"}` : ""}${failedAt !== undefined ? `; failed at +${failedAt}ms` : ""};`;
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
    trace("dispatch");
    try {
      res = await this.fetchFn(url, {
        method: "POST",
        headers: { authorization: authHeader, "content-type": "application/json" },
        body: bodyJson,
        signal: controller.signal,
      });
    } catch (err) {
      failedAt = Date.now() - started;
      settle();
      trace("settled", { how: controller.signal.aborted ? "aborted" : "connection-failed" });
      await watchdog;
      if (controller.signal.aborted) return abortedVerdict(err, "before headers");
      return call({
        ref: watchedRef,
        outcome: "error",
        durationMs: Date.now() - started,
        failureMessage: `RunMutantMany connection failed after dispatch: ${String(err)}.${stopDetail()}`,
        operation: "in-flight-unknown",
        fencedOp,
      });
    }
    let rawBody: string;
    try {
      rawBody = await res.text();
    } catch (err) {
      failedAt = Date.now() - started;
      settle();
      trace("settled", { how: controller.signal.aborted ? "aborted" : "body-failed" });
      await watchdog;
      if (controller.signal.aborted) return abortedVerdict(err, "after headers");
      return call(
        this.inFlightUnknown(
          watchedRef,
          Date.now() - started,
          `RunMutantMany 2xx body could not be read: ${String(err)}.${stopDetail()}`,
          fencedOp,
        ),
      );
    }
    settle();
    trace("settled", { how: "answer" });
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
      if (await this.completedBeforeStop(lease, attemptId, decision.methodIndex)) {
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
    return this.scoreManyAnswer(value, {
      req,
      firstMethod,
      watchedRef,
      call,
      durationMs,
      fencedOp,
    });
  }

  /**
   * R206: a `call` result names the request position of the method it is about, so the
   * orchestrator's warm confirmation can take the chunk's prefix without re-deriving it.
   */
  private callOf(
    methods: readonly GroupMethod[],
  ): (
    verdict: TestVerdict,
    extra?: { cause?: GroupCause; abortSession?: string },
  ) => RunMutantManyResult {
    const methodIndexOf = (ref: TestMethodRef): number => {
      const at = methods.findIndex(
        (m) => m.ref.codeunitId === ref.codeunitId && m.ref.method === ref.method,
      );
      return at < 0 ? 1 : at + 1;
    };
    return (verdict, extra) =>
      ({
        kind: "call",
        verdict,
        methodIndex: methodIndexOf(verdict.ref),
        ...(extra?.cause !== undefined ? { cause: extra.cause } : {}),
        ...(extra?.abortSession !== undefined ? { abortSession: extra.abortSession } : {}),
      }) as const;
  }

  /**
   * `RunMutantMany`'s answer `value`, scored. Everything it needs arrives in `ctx`, so a caller
   * other than the live reply (R236b's readback) scores by exactly the same rules.
   */
  private scoreManyAnswer(
    value: string,
    ctx: {
      readonly req: RunMutantManyRequest;
      readonly firstMethod: GroupMethod;
      /** The method the watchdog last saw running; names an unparseable `value`'s verdict. */
      readonly watchedRef: TestMethodRef;
      readonly call: (
        verdict: TestVerdict,
        extra?: { cause?: GroupCause; abortSession?: string },
      ) => RunMutantManyResult;
      readonly durationMs: number;
      readonly fencedOp: { readonly attemptId: string; readonly opSeq: number };
    },
  ): RunMutantManyResult {
    const { methods, attemptId, mutantId } = ctx.req;
    const { firstMethod, watchedRef, call, durationMs, fencedOp } = ctx;
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
    if (result.status === "suite-unresolved") {
      // R206 §4 item 1: a requested (codeunitId, method) pair matched zero or several function
      // lines, or two pairs matched one. Nothing ran; phase 3 tombstoned the op. A call-level
      // error with NO cause and NO operation, so the orchestrator's transport-error path aborts
      // the session with the server's words: a test app that does not resolve is not a
      // per-mutant fact (R139/R56's channel).
      const reason = typeof result.reason === "string" ? result.reason : "no reason given";
      return call({
        ref: firstMethod.ref,
        outcome: "error",
        durationMs,
        failureMessage: `RunMutantMany suite-unresolved: the server could not resolve this request's test methods to exactly one function line each, and ran nothing — ${reason}`,
      });
    }
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
    // R206 §2.1: the session keys, required on every answer that ran (control app 1.0.0.18) and
    // checked HERE, after the refusals and `runError` above, so a refusal keeps its own class.
    const session = sessionKeysOf(result);
    if (typeof session === "string") return malformed(session);
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
    const seenLineNos = new Set<number>();
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
      // R206: within-call constancy of the session is ASSERTED, and every entry must name a
      // distinct function line (the client-side half of §4 item 1's pair-keyed map).
      if (raw.sessionId !== session.sessionId)
        return malformed(
          `entry ${i + 1} carries sessionId ${JSON.stringify(raw.sessionId)}, the call's is ${session.sessionId}`,
        );
      if (typeof raw.lineNo !== "number" || !Number.isInteger(raw.lineNo))
        return malformed(`entry ${i + 1} has no integer lineNo`);
      if (seenLineNos.has(raw.lineNo))
        return malformed(
          `entry ${i + 1} ran function line ${raw.lineNo}, which an earlier entry also ran`,
        );
      seenLineNos.add(raw.lineNo);
      const results =
        typeof raw.codeunitResults === "string"
          ? raw.codeunitResults
          : raw.codeunitResults !== undefined && raw.codeunitResults !== null
            ? JSON.stringify(raw.codeunitResults)
            : undefined;
      if (results === undefined) return malformed(`entry ${i + 1} has no codeunitResults`);
      // GH-24: this entry's own reach attestation, checked here so the mapper never sees a
      // call-level stand-in — each entry's value comes from THAT entry.
      if (typeof raw.observedActive !== "boolean")
        return malformed(
          `entry ${i + 1} has no boolean observedActive (control app 1.0.0.19, GH-24)`,
        );
      // The three per-entry faults that abort the session today keep doing so: the line count,
      // BC's own inner method name, and the result enum are checked by the SAME code `run` uses.
      const v = this.mapRanResult(
        want.ref,
        raw.durationMs,
        {
          codeunitResults: results,
          observedAny: attestation.observedAny,
          identityMismatch: false,
          observedActive: raw.observedActive,
        },
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
      verdicts.push({ ...v, attestation, ...session });
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
    return this.refusalBoundary(
      () => this.execute(req, true),
      (r) => isScoredVerdict(r.verdict),
    );
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
    // R-204b: the grace ends at dispatch + budget + grace whatever happens in between, so an answer
    // arriving late in it cannot buy a fresh grace for the stop's reply.
    const stopDeadline = Date.now() + req.timeoutMs + (req.stopGraceMs ?? 30_000);
    const stop: StopTracker = { fired: false };
    const first = await settleStop(
      await this.dispatch(req, collectCoverage, sink, stop),
      stop,
      stopDeadline,
    );
    // R236b: every exit that could not read the server's answer asks for the answer the server
    // committed. One place, so no exit is forgotten.
    const verdict =
      first.operation === "in-flight-unknown" && first.fencedOp !== undefined
        ? await this.recoverKeptAnswer(req, collectCoverage, sink, first, first.fencedOp)
        : first;
    return {
      verdict,
      ...(sink.rows !== undefined ? { coverageRows: sink.rows } : {}),
      ...(sink.stats !== undefined ? { coverageStats: sink.stats } : {}),
    };
  }

  /**
   * R236b. Replaces a lost reply ONLY with an identity-checked `pass` or `fail` scored from the
   * server's committed answer for exactly this op and lease. Anything else keeps `lost`, with the
   * reason appended, and the caller handles it exactly as before (a baseline quarantines; a mutant
   * call goes to the unchanged lost-ack reconcile). Dispatches nothing itself.
   */
  private async recoverKeptAnswer(
    req: RunMutantRequest,
    collectCoverage: boolean,
    sink: { rows?: readonly FencedCoverageRow[]; stats?: FencedCoverageStats },
    lost: TestVerdict,
    fencedOp: { readonly attemptId: string; readonly opSeq: number },
  ): Promise<TestVerdict> {
    const lostText = lost.failureMessage ?? "no detail";
    // A readback that is not accepted changes nothing but the message: the verdict and whatever
    // `dispatch` put in `sink` go on exactly as today. The kept answer is scored into `scratch`,
    // which reaches `sink` only on acceptance.
    const keep = (why: string): TestVerdict => ({ ...lost, failureMessage: `${lostText}; ${why}` });
    const scratch: { rows?: readonly FencedCoverageRow[]; stats?: FencedCoverageStats } = {};
    // ponytail: one read, bounded by the call's own budget (15 s at most); a throttled server
    // fails closed. A second read is the upgrade if C1 shows closed-on-timeout readbacks.
    let kept: KeptAnswer;
    try {
      kept = await this.readKeptAnswerBounded(
        req.lease,
        fencedOp,
        Math.min(KEPT_ANSWER_READ_MS, req.timeoutMs),
      );
    } catch (err) {
      // R-496: a refused extensions query is thrown, never folded into the unknown's message.
      if (err instanceof UnfilteredExtensionsQueryError) throw err;
      return keep(`answer readback failed: ${describeThrown(err)}`);
    }
    if (!kept.found) {
      const holds =
        kept.keptAttemptId !== undefined && kept.keptOpSeq !== undefined
          ? ` (it holds ${kept.keptAttemptId}/${kept.keptOpSeq})`
          : "";
      return keep(
        `answer readback: the server holds no committed answer for ${fencedOp.attemptId}/${fencedOp.opSeq}${holds}`,
      );
    }
    let v: TestVerdict;
    try {
      // `parseCoverageRows` throws `FencedCoverageError` on a malformed coverage array; from a
      // readback that is one more answer not accepted, never a thrown session.
      v = this.scoreAnswer(kept.answer, req, collectCoverage, scratch, lost.durationMs, fencedOp);
    } catch (err) {
      return keep(`answer readback not accepted: ${describeThrown(err)}`);
    }
    // Ruling C1: only a completed, identity-checked pass or fail replaces an unknown.
    if ((v.outcome !== "pass" && v.outcome !== "fail") || v.operation !== undefined) {
      const op = v.operation !== undefined ? `, ${v.operation}` : "";
      return keep(
        `answer readback not accepted (${v.outcome}${op}): ${v.failureMessage ?? "no detail"}`,
      );
    }
    Object.assign(sink, scratch);
    return { ...v, replyRecovered: lostText };
  }

  private async dispatch(
    req: RunMutantRequest,
    collectCoverage: boolean,
    sink: { rows?: readonly FencedCoverageRow[]; stats?: FencedCoverageStats },
    stop: StopTracker,
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
    const graceMs = req.stopGraceMs ?? 30_000;
    const timer =
      stopHook === undefined
        ? setTimeout(() => controller.abort(), timeoutMs)
        : setTimeout(() => {
            stop.fired = true;
            stop.state = "issued";
            // Not awaited here: this runs off a timer while the request is still open, and the
            // answer we score arrives on the request. R-204b: `execute` awaits `done` (bounded by
            // the remaining grace) before anyone decides whether a retry is safe.
            stop.done = stopHook(graceMs).then(
              (a) => {
                if (a.stopped === true) stop.state = "confirmed";
                else if (a.stopped === false) {
                  stop.state = "refused";
                  stop.refusal = a.reason ?? "no reason given";
                } else stop.state = "unknown";
              },
              (err: unknown) => {
                stop.state = "unknown";
                stop.error = err;
              },
            );
          }, timeoutMs);
    const hardTimer =
      stopHook === undefined
        ? undefined
        : setTimeout(() => controller.abort(), timeoutMs + graceMs);
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
      const stopDetail = !stop.fired
        ? ""
        : stop.error !== undefined
          ? ` — the server-side stop was attempted and FAILED (${describeThrown(stop.error)}), so this run could not be scored and is quarantined instead`
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
    if (stop.fired && res.status === 408) {
      const body = await res.text().catch(() => "");
      settleTimers();
      if (isAlStopResponse(res.status, body)) {
        // R204 (R-204b Part A): the same narrowing the grouped call makes, through the same helper.
        if (await this.completedBeforeStop(lease, attemptId, 1)) {
          return {
            ref,
            outcome: "error",
            durationMs: Date.now() - started,
            failureMessage: `RunMutant: BC answered our stop for ${ref.method} with its 408, but the method's own completion was recorded before the session died, so this run is not scored (R204)`,
            stopRefusal: "stopped-after-completion",
          };
        }
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
    return this.scoreAnswer(value, req, collectCoverage, sink, durationMs, fencedOp);
  }

  /**
   * R236b: the answer parser, from the `value` string onward. Shared by the live reply and by a
   * readback of the answer the control app kept, so both are scored by the same unchanged rules.
   */
  private scoreAnswer(
    value: string,
    req: RunMutantRequest,
    collectCoverage: boolean,
    sink: { rows?: readonly FencedCoverageRow[]; stats?: FencedCoverageStats },
    durationMs: number,
    fencedOp: { readonly attemptId: string; readonly opSeq: number },
  ): TestVerdict {
    const ref = req.ref;
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

    // R206 §2.1: a `ran` answer without the session keys is a protocol fault (a control app the
    // version gate should have refused), answered as a bare error with no `operation` so the
    // session aborts with these words, never as `in-flight-unknown`, which would quarantine a
    // tier and latch a lease for a wire-shape mismatch.
    const session = sessionKeysOf(result);
    if (typeof session === "string") {
      return {
        ref,
        outcome: "error",
        durationMs,
        failureMessage: `RunMutant answer malformed: ${session}`,
      };
    }
    const v = this.mapRanResult(ref, durationMs, result, fencedOp);
    return v.outcome === "error" ? v : { ...v, ...session };
  }

  private mapRanResult(
    ref: TestMethodRef,
    durationMs: number,
    result: Pick<
      RunMutantResult,
      "codeunitResults" | "observedAny" | "identityMismatch" | "observedActive"
    >,
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
    // GH-24: a `ran` answer must carry a boolean `observedActive` for THIS test method. Never
    // defaulted to `false` — a missing value is refused rather than read as "not reached".
    if (typeof result.observedActive !== "boolean") {
      return {
        ref,
        outcome: "error",
        durationMs,
        failureMessage:
          "RunMutant answer ran but carries no boolean observedActive; control app 1.0.0.19 stamps it on every answer (GH-24). Refusing to read a missing value as unreached.",
      };
    }
    const failureMessage = this.failureTextOf(line);
    return {
      ref,
      outcome,
      durationMs,
      attestation,
      reachedActive: result.observedActive,
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
