import type { V3EnvironmentChoice } from "./al-runner-v3-environment";
import type { CompiledArtifact } from "./artifact";
import type { MicrosoftMode } from "./digest-inputs";
import type { AlSource, RenamedMemberNames } from "./line-map";
import type { OperationOutcome } from "./operation-outcome";

/**
 * PR-340 §3: what a carry walk found. `killed`: test T went fail, pass, fail with complete rows and the
 * right echoes. `walked`: all three answers were sound and no test did. `failed`: anything else, the
 * reason named (never a verdict).
 */
export type CarryWalkResult =
  | {
      readonly kind: "killed";
      readonly codeunitId: number;
      readonly method: string;
      /** The failure text of T in the first request, and in the reproducing third one. */
      readonly failure: string | undefined;
      readonly reproduced: string | undefined;
    }
  | { readonly kind: "walked" }
  | { readonly kind: "failed"; readonly reason: string };

export interface TestMethodRef {
  readonly codeunitId: number;
  readonly codeunitName: string;
  readonly method: string;
  /**
   * Project-relative path of the file this test was discovered in. Set by `discoverTests`;
   * absent on refs a backend or a test constructs, which is why it is optional rather than
   * required — no execution path reads it.
   *
   * Carried so a report can tell a consumer WHERE to edit. A survivor's `coveringTests` are
   * qualified `Codeunit.method` names, and acting on one means opening the test file; without
   * this every survivor costs a project-wide grep.
   */
  readonly file?: string;
  /** R272: 1-based line of the method's NAME in `file`, set by `discoverTests` alongside `file`.
   *  Like `file`, no execution path reads it. */
  readonly line?: number;
}

/**
 * `timeout` means the TEST RUNNER confirmed the test did not terminate — real
 * evidence about the mutant (design.md §6.7).
 * `deadline-exceeded` means OUR client timer fired and we know nothing about
 * what the server did — infrastructure noise, never evidence about the mutant.
 */
export type TestOutcome = "pass" | "fail" | "skip" | "timeout" | "deadline-exceeded" | "error";

/**
 * One coverage observation: "this test executed code in this object", optionally narrowed to a
 * named member.
 *
 * `procedure` is OPTIONAL, and its absence is load-bearing rather than incidental. BC reports
 * coverage for code a compiled app's `SymbolReference.json` cannot name — it records no trigger
 * at all, so `AppMethodIndex.lookup` (app-package.ts) returns `undefined` for every trigger
 * methodId, and the local-procedure scan that normally covers the gap finds nothing in an object
 * whose procedures are all public. Such an observation is real evidence about the OBJECT while
 * carrying none about any member, so it is emitted with no `procedure`.
 *
 * Dropping it instead is how table-trigger mutants became false survivors: `byObject` lost the
 * covering test, `coverageFilter`'s object-level fallback returned a non-empty-but-WRONG set from
 * whichever sibling test happened to resolve, and the all-green-tests fallback therefore never
 * fired. Perversely, a table with public procedures scored worse than a table with none — the
 * latter's empty `byObject` fell through to the correct fallback.
 *
 * Absence is `procedure` being ABSENT, never `""`. An empty string would key `byMember` as
 * `"<type>:<id>::"` — the exact key `coverageFilter` builds for a trigger mutant (whose
 * `procedureName` is `""`) — so the two empties would collide and an object-level observation
 * would masquerade as an exact member match. `buildCoverageIndex` therefore skips an absent
 * `procedure` structurally and refuses a blank-but-present one loudly.
 */
/**
 * R175: an object in which coverage reported a line the resolver could place in NO known member,
 * procedure or trigger. Direct evidence that attribution failed for this object, as distinct from
 * an observation of a member we deliberately decline to name.
 */
export interface NamingGap {
  readonly objectType: string;
  readonly objectId: number;
}

export interface CoverageEntry {
  readonly objectType: string;
  readonly objectId: number;
  readonly procedure?: string;
  readonly line?: number;
  /**
   * R965: set only when `procedure` names SEVERAL same-named procedures of the object (overloads):
   * the 0-based source-order position of the one this observation ran in, from the line map. A
   * name alone cannot tell the overloads apart. Absent means "not known", never "the only one".
   * Matched against `MutantManifestEntry.procedureOverloadIndex` in `coverageFilter`.
   */
  readonly overloadIndex?: number;
}

export interface CoverageMap {
  readonly granularity: "procedure" | "line";
  readonly entries: readonly CoverageEntry[];
  /**
   * R175. Objects where a reported line fell inside nothing this backend could name.
   *
   * Optional because only the FENCED path can compute it: it resolves lines through a map built
   * from the source LethAL emitted, so it knows what it should have been able to place. The hub
   * path resolves an opaque `methodId` against `SymbolReference.json` and cannot tell a local (never
   * listed, expected) from a public whose id did not match (a real gap), so it reports none rather
   * than guess.
   */
  readonly namingGaps?: readonly NamingGap[];
}

export interface TestVerdict {
  readonly ref: TestMethodRef;
  readonly outcome: TestOutcome;
  /**
   * R963: the CALL's wall clock (round trip, plus a compile per call on al-runner one-shot; a whole
   * batch's on a grouped call), NOT the test's own time. It is the timeout budget's clock. Never read
   * it as how long the test took: that is `measuredDurationMs`, and when that is absent the test's
   * time is UNKNOWN (a batch's wall must not be charged to each of its rows).
   */
  readonly durationMs: number;
  /**
   * R963: the test's OWN duration, when the backend measured it; absent = unknown, never the call's
   * wall (R272/R934). R272: on a `pass` (and since R934, on al-runner, a `fail` too: a
   * mutant's summed time reads it; every reader that wants a pass checks the outcome). The timeout BUDGET still reads `durationMs`; this
   * figure is in the report and, since R517, it is what a position-1 timeout confirm is judged on
   * (`confirm.measuredDurationMs ?? confirm.durationMs`), because it is timed on the same clock as
   * al-runner's in-run stop. Since R914 the R912 estimate and window cut read it too. al-runner sets the runner's own per-test figure, since its
   * `durationMs` includes a compile per call (one-shot) or is the whole suite's (`--server`).
   * bcdev sets its per-test call's wall clock (`BcDevBackend.run`), equal to its `durationMs`.
   * Absent: not measured per test.
   */
  readonly measuredDurationMs?: number;
  /**
   * R963: INTERNAL, never in a report or an event. The identity of the al-runner call or serve
   * request this row came from, set only on a row with no `measuredDurationMs`: all rows of one call
   * share it, so their shared `durationMs` (the call's wall) is charged once, not once per row.
   */
  readonly callId?: string;
  /**
   * R907: on a `pass`, al-runner's `flagged: true`: the pass rests on an unprobed assumption (for
   * example a test that went through Confirm, StrMenu or a page under `--no-client`). Absent when
   * false or not reported. Only al-runner sets it.
   */
  readonly flagged?: true;
  /**
   * R949: on a `pass`, the answer came from a serve daemon, whose rows cannot carry `flagged`: the
   * flagged state is UNKNOWN (never read it as unflagged). Absent for a one-shot answer.
   */
  readonly flaggedUnknown?: true;
  /**
   * R517: on a `timeout`, the stop the runner says it ENFORCED, parsed from al-runner's row
   * (`Test exceeded {N}s timeout.`, or R534's OnRun-trigger wording, N x 1000). The position-1
   * confirm is judged against `min(budget, reportedStopMs, backend.inRunStopMs)`. Absent: the
   * runner did not say (bcdev, or a row whose wording did not parse); on a backend that declares
   * `inRunStopMs` that leaves the timeout unconfirmed.
   */
  readonly reportedStopMs?: number;
  /**
   * PR-43: on a `timeout`, set only by al-runner v3 when the row says `clock: "cpu"` and its
   * `durationMs` is below 10 x the stop (al-runner's wall backstop), so the stop is the test
   * thread's CPU time, which machine load cannot cause. The orchestrator still needs the unmutated
   * confirm to have passed quickly before it skips R577's reproduction. Absent: never set by bcdev.
   */
  readonly cpuStop?: true;
  /**
   * PR-387: the test body never ran (bcdev's hub tool-error and no-result rows). Never read from
   * message text. Internal; the orchestrator copies it to the baseline event's `notRun`.
   */
  readonly bodyNeverRan?: true;
  /**
   * R534: on a `timeout`, where the runner's stop fired. `body`: the test's own figure
   * (`measuredDurationMs`) is on the stop's clock. `onrun`: the test codeunit's OnRun trigger; no
   * pass row reports the OnRun's time (measured: 66 ms body beside a 4 s OnRun). Absent (bcdev,
   * whose measured figure IS its wall time): the confirm uses the wall time, so an unknown
   * location can only over-state the unmutated run. Internal only; not in the report.
   */
  readonly timeoutIn?: "body" | "onrun";
  /**
   * R534: al-runner ANSWERED with a row that is not a verdict about the mutant. Lifted into the
   * covering step's cause, like `stopRefusal`: a per-mutant `error`, never re-sent, never a
   * spec §11 abort. `runner-refused`: the test reached a surface al-runner refuses
   * (`<Type>: out-of-scope: ...`). `runner-test-error`: any other such row.
   */
  readonly runnerRow?: "runner-test-error" | "runner-refused";
  /**
   * R534 (D1b): al-runner proved this row was stopped at its timeout (an exit-3 TEST-TIMEOUT-ABORT
   * line names it), but its message is neither known timeout wording. Scored `runner-test-error`
   * (never a kill); the orchestrator warns once per session.
   */
  readonly timeoutWordingUnknown?: boolean;
  readonly failureMessage?: string;
  /**
   * R689 (control 1.0.0.24): on a found-0 line-count answer, the test codeunit's own OnRun error as
   * BC's discovery caught it, and the stack's first frame. Set only when the control app proved the
   * frame names the requested codeunit. `failureMessage` is unchanged by it.
   */
  readonly discoveryError?: { readonly text: string; readonly frame: string };
  readonly coverage?: CoverageMap;
  /**
   * The dispatch/effect state of this run (spec §7/§11). Absent ⇒ a terminal test outcome
   * (`completed-accepted`). Set on failure paths to distinguish a retry-safe pre-dispatch
   * failure from an `in-flight-unknown` one the orchestrator must quarantine.
   */
  readonly operation?: OperationOutcome;
  /**
   * Per-run binary-identity attestation (Layer 5C-A Task 8, design §G) — set by
   * `RunMutantTransport` on a bcdev RunMutant `ran` path. `observedAny` records whether any
   * instrumented selector executed during this run (false is allowed: coverage
   * over-approximates). `identityMismatch` is never true on a returned verdict — the transport
   * maps that case to an `error` outcome instead, so it is carried here already-false purely so
   * the orchestrator can require ≥1 clean observation per deployed artifact (fail-closed gate,
   * Task 5/10). Absent on al-runner (no such attestation exists) and on bcdev's non-`ran` paths
   * (hub-routed coverage runs, and any error/timeout verdict).
   */
  readonly attestation?: { readonly observedAny: boolean; readonly identityMismatch: boolean };
  /**
   * GH-24: the server's `observedActive` for THIS test method — whether the marker at the active
   * mutant's own statement fired during this run. A verdict field BESIDE `attestation`, not
   * inside it, so an absent value stays structurally distinct from `false`. Set on every verdict
   * `RunMutantTransport` maps from a `ran` answer (`RunMutant`'s top level and each
   * `RunMutantMany` entry, read from THAT entry, never a call-level stand-in); absent on every
   * other verdict and on al-runner, where no such attestation exists. Never defaulted to `false`:
   * a `ran` answer without a boolean `observedActive` is refused instead (control app 1.0.0.19).
   */
  readonly reachedActive?: boolean;
  /**
   * The raw server `reason` string on a Layer 5C-B1 `RunMutant` `lease-invalid` result — set ONLY
   * alongside `operation:"lease-lost"` (design §5/§8). `"op-in-flight"` means THIS caller's own
   * (attemptId, opSeq) is still active server-side — a duplicate claim on a still-running same
   * attempt, e.g. a retry after an ambiguous prior response — meaning "poll `getOperationStatus`,
   * do not retry, do not treat as lease loss." Any other value (or a phase-3 verify-and-clear
   * refusal, which carries none) is a genuine lost lease. The orchestrator (Task 8) MUST branch on
   * this field before applying `requiresUnsafeLatch("lease-lost")`'s generic abort-and-invalidate
   * path — that path is correct for a real loss, wrong for a same-attempt duplicate.
   */
  readonly leaseInvalidReason?: string;
  /**
   * Layer 5C-B2 (design §5): the fence coordinates of the `RunMutant` attempt behind this verdict,
   * set by `RunMutantTransport` on — and ONLY on — its `operation: "in-flight-unknown"` exits.
   *
   * Those exits mean the client could not read the server's answer, not that the server failed to
   * produce one. Naming the attempt is what lets the orchestrator ask
   * `GetOperationStatus(attemptId, opSeq)` whether phase 3 already ran (op tombstoned ⇒ only the
   * RESULT was lost and the container is clean) instead of durably condemning the tier on the
   * strength of an unreadable HTTP response. Live-earned: BC answered `RunMutant` with HTTP 200
   * and a zero-byte body on 3 of 8 bcdev gate runs, each one quarantining a container whose lease
   * row showed the op completed.
   *
   * Absent on every terminal verdict (the op resolved — nothing to reconcile), on
   * `pre-dispatch-rejected` (no op was ever claimed), and on every unfenced backend (al-runner,
   * the bc-dev hub's coverage runs). Absent therefore means "no op this client can name", and the
   * orchestrator must keep quarantining — never read a missing field as "nothing was stranded".
   */
  readonly fencedOp?: { readonly attemptId: string; readonly opSeq: number };
  /**
   * R236b: set when the HTTP reply was lost and this verdict was scored from the answer the control
   * app committed as the action's last statement (`GetOpAnswer`). Only ever set on an identity-checked
   * `pass` or `fail`. The value is the lost reply's own failure text, so the incident stays visible.
   * The readback dispatched nothing; the verdict is the original call's own.
   */
  readonly replyRecovered?: string;
  /**
   * R206 §2.1, bcdev `ran` answers only (control app 1.0.0.18): the server's per-session count of
   * test methods run BEFORE the call that produced this verdict (0 = a fresh session, the guard's
   * predicate) and that session's id (data, asserted constant within a group call). Absent on
   * al-runner (a process per test, cold by construction) and on every non-`ran` path.
   */
  readonly testRunsBefore?: number;
  readonly sessionId?: number;
  /**
   * R1131 (control app 1.0.0.28), bcdev answers that RAN a method (not hub mode): the start WorkDate the
   * method ran under, an ISO date text (`2026-11-19`). The backend compares it with the batch's baseline
   * date. Absent on al-runner, on hub mode and on every answer where no test ran.
   */
  readonly workDate?: string;
  /**
   * R1131: set (with outcome `error`) by the bcdev backend on an answer whose `workDate` differs from the
   * batch's baseline date, or that follows such an answer in the same batch. The orchestrator lifts it
   * into the step's cause, as it does `stopRefusal`; the row is `error` / `workdate-changed`, never a
   * kill, a survivor or `unstable`.
   */
  readonly workDateRefusal?: "workdate-changed";
  /**
   * R-204b (R202): what became of the stop LethAL sent for THIS call, settled before the call
   * returned. Absent: no stop was sent. On a grouped call, `refused` only if EVERY stop attempt in
   * it was refused. The orchestrator retries a lost answer only when this is absent or `refused`:
   * any other state means our stop may have ended the run, so a passing retry proves nothing.
   */
  readonly stopState?: StopState;
  /**
   * GitHub #49: on a `timeout` that OUR stop ended, which answer ended it. Set only where the
   * transport decides those two cases (single and grouped), absent on every other outcome.
   */
  readonly stopEvidence?: StopEvidence;
  /**
   * R-204b Part A: set on the single path's `error` when BC answered our stop with its 408 but the
   * op's progress row shows the method had already recorded its completion. Lifted into the step's
   * cause, exactly like the grouped call's `stopped-after-completion`.
   */
  readonly stopRefusal?: "stopped-after-completion";
  /**
   * R586 (I1): on a `fail` or `timeout` under a mutant, a tagged note the backend attaches to the
   * kill (`[v3-codeunit-state-possible] ...`). The orchestrator writes it into the KILLED mutant's
   * `failureNote`; it never moves a verdict. Internal only; absent on every backend but v3.
   */
  readonly backendNote?: string;
  /**
   * R639: on a `runner-refused` row under a mutant, the test whose timeout was the call's first
   * not-run row and came before this one (R978: or whose plain failure was the call's first row that
   * did not pass, before this one). The covering loop may then go on to the next test; a
   * loop that finds nothing else ends the mutant as this refusal. Internal only (v3); never a
   * `SessionReport` field.
   */
  readonly refusedAfterStop?: string;
  /**
   * PR-51 (F1): set on a verdict whose row came from an ALONE request (v3: one test selected by
   * itself, in a fresh daemon request). Such a row was not measured in its codeunit's context, so
   * its unmutated confirm and its reproduction must run it alone too (`RunOpts.alone`). Internal
   * only (v3); never a `SessionReport` field.
   */
  readonly selection?: "alone";
}

/** R-204b: see `TestVerdict.stopState`. */
export type StopState = "issued" | "pending" | "confirmed" | "refused" | "unknown";

/**
 * GitHub #49: what ended a held request after our confirmed stop. `bc-named-stop` is BC's 408 that
 * names the AL `StopSession` call; `begin-transaction-world` is BC 29's exact 400, which does not
 * name the stop and is the weaker of the two. PR-43: `v3-cpu-stop` is al-runner v3's provable
 * CPU-time stop whose unmutated confirm passed quickly; the kill was NOT reproduced (R577),
 * because machine load cannot cause a CPU-time stop. Count such kills by this row field.
 */
export type StopEvidence = "bc-named-stop" | "begin-transaction-world" | "v3-cpu-stop";

/**
 * GitHub #49: the evidence of a kill that ran twice (the kill, then its reproduction). Mixed runs
 * keep the WEAKER: any `begin-transaction-world` makes the row `begin-transaction-world`, because
 * the verdict then leans on our own stop in at least one of its two runs. A run without evidence
 * (not our stop) never upgrades the other to a claim it did not earn: the one that has it is kept.
 */
export function weakerStopEvidence(
  a: StopEvidence | undefined,
  b: StopEvidence | undefined,
): StopEvidence | undefined {
  if (a === "begin-transaction-world" || b === "begin-transaction-world") {
    return "begin-transaction-world";
  }
  return a ?? b;
}

/** R-204b: a lost answer may be retried only when no stop was sent, or every stop was refused. */
export function stopIsRetrySafe(s: StopState | undefined): boolean {
  return s === undefined || s === "refused";
}

/**
 * How a backend sources coverage — a ROUTING axis, not a granularity one. `"none"` already meant
 * "the baseline runs through the fenced RunMutant transport and every mutant runs against all green
 * tests"; `"fenced"` (R58) is the same runner with coverage collected on it.
 *
 * | value | baseline runner | per-procedure coverage |
 * |---|---|---|
 * | `"procedure"` | bc-dev-mcp hub (`GuiAllowed=Yes`, `ClientType=Web`) | yes |
 * | `"fenced"` | fenced `RunMutantWithCoverage` (`GuiAllowed=No`, `ClientType=ODataV4`) | yes |
 * | `"al-runner"` | al-runner `--coverage`, the same one-shot process that runs the mutants | yes |
 * | `"none"` | fenced `RunMutant` | no |
 *
 * `"al-runner"` (R220) sits on the `"fenced"` side of the axis this type is about: ONE runner
 * produces both the green set and every verdict, so it carries no runner-disagreement diagnosis,
 * and it resolves members by parsing the source through `line-map.ts`, so [[R175]]'s unnamed-member
 * widening must stay OFF for it. Both follow from `isHubCoverageMode`, which is the predicate to
 * branch on rather than a comparison against `"fenced"` by name.
 *
 * `"fenced"` exists because the mutants ALWAYS run fenced, so `"procedure"` measures the green set
 * on a different session type than the one that produces verdicts (R55: 12 of 56 Continia Document
 * Output tests fail on the hub and pass on the fence, taking their coverage with them).
 */
export type CoverageMode = "none" | "procedure" | "line" | "fenced" | "al-runner";

/**
 * R586 (C1): WHICH backend this is. Before R586 `!authoritative` meant "al-runner" everywhere
 * (`runSession`'s build backend, the run row's `backend`, resume, R557's stamp, the report), so a
 * second non-authoritative backend would have read as the frozen .NET al-runner. Every branch about
 * the backend's identity keys on this, through the predicates below; `authoritative` keeps only
 * its own meaning (a verdict to act on). `"al-runner-v3"` is the Rust al-runner (`3.0.0-alpha.N`,
 * plan `docs/superpowers/plans/2026-10-21-r586-alrunner-v3-backend.md`). R654 retired the .NET
 * al-runner (`"al-runner"`): a stored run or report that names it is refused by name
 * (`v2-retired.ts`).
 */
export type BackendKind = "bcdev" | "al-runner-v3";

/** R586: the backend publishes to a BC server (leases, attestation, quarantine, TestPage scan). */
export function isBcdev(kind: BackendKind): boolean {
  return kind === "bcdev";
}

/**
 * PR-315 (GitHub #52, R1171): what the run warning and `lethal doctor` both say when the stop is
 * off. The stop is off by default (R1064) because it ends a hung session on the user's server.
 */
export const STOP_HUNG_SESSIONS_OFF_TEXT =
  "a mutant that never ends will quarantine this server's tier instead of scoring timeout-killed. " +
  "On GitHub #52 this lost 12 of 17 mutants and needed `lethal clear-quarantine` and `lethal force-reset-lease` to recover. " +
  'Fix: pass --stop-hung-sessions, or set "stopHungSessions": true in the config\'s bcdev section ' +
  "(an envTool config ignores that field, so there only the flag works). " +
  "It is off by default because it ends a hung session on the server, which is the server owner's call.";

/** R586: a backend that publishes nothing and compiles the source it was given (v3, since R654). */
export function isLocalRunner(kind: BackendKind): boolean {
  return kind === "al-runner-v3";
}

export interface BackendCapabilities {
  /**
   * R586 (C1): see `BackendKind`. Required, so no backend can be mistaken for another. R553 keys
   * the assertion screen on it too: each backend sets it itself, and it is never inferred from
   * `authoritative` (an al-runner backend made authoritative one day is still al-runner).
   */
  readonly kind: BackendKind;
  readonly coverage: CoverageMode;
  /**
   * R907: the files that made LethAL turn coverage off for this whole run (v3 only). Non-empty when
   * present; absent when coverage is on or was configured off.
   */
  readonly coverageOffFiles?: readonly string[];
  readonly deploy: "publish" | "none";
  readonly isolation: "session" | "full-reset";
  readonly authoritative: boolean;
}

export interface BackendStatus {
  readonly ok: boolean;
  readonly details: string;
}

export interface RunOpts {
  readonly coverage: CoverageMode;
  readonly timeoutMs: number;
  /**
   * PR-51 (F1): run exactly this one test alone, under the currently activated selection (NONE
   * after `activate(null)`), whatever the backend's routing state says, and never cache the answer
   * as its codeunit's call. A backend that cannot do this refuses it by name; none ignores it.
   */
  readonly alone?: true;
}

/**
 * R198: one call that runs several test methods against the ACTIVE mutant, as a server-side loop
 * of the single-method run (design: `docs/superpowers/specs/2026-09-03-r198-run-mutant-loop.md`).
 * Each method carries its own budget; the call as a whole must answer inside `requestCeilingMs`.
 */
export interface RunManyOpts {
  readonly methods: readonly { readonly ref: TestMethodRef; readonly budgetMs: number }[];
  readonly requestCeilingMs: number;
  readonly stopGraceMs: number;
  /**
   * R206 §2.2: the warm confirmation's replay, an unmutated group run (`activate(null)` first).
   * REQUIRES no pending mutant; a backend throws otherwise. Absent (false) for a covering run,
   * which requires one.
   */
  readonly confirmation?: boolean;
}

export type RunManyEndedBy = "complete" | "failure" | "cap";

/** R198: the per-MUTANT causes a group call can end in; see `GroupCause` in the transport. */
export type RunManyCause =
  | "group-run-error"
  | "group-answer-malformed"
  | "stopped-after-completion"
  | "stop-outcome-unconfirmed"
  | "workdate-changed";

export type RunManyResult =
  | {
      readonly kind: "verdicts";
      readonly endedBy: RunManyEndedBy;
      readonly ranCount: number;
      readonly verdicts: readonly TestVerdict[];
      readonly durationMs: number;
      /** The op the call ran under, for the store's `op_kind` and the report's `groupedCalls`. */
      readonly fencedOp: { readonly attemptId: string; readonly opSeq: number };
    }
  | {
      readonly kind: "call";
      readonly verdict: TestVerdict;
      /** R206: the 1-based request position of the method `verdict` is about. */
      readonly methodIndex: number;
      readonly cause?: RunManyCause;
      readonly abortSession?: string;
      readonly fencedOp: { readonly attemptId: string; readonly opSeq: number };
    };

/**
 * C02-04b: an installed artifact whose stored .app and manifest matched the trusted store record
 * (`loadInstalledArtifact`; R360: read from the store's bundle, checked against the payload
 * digest). Identity comes from that record, never from the caller.
 *
 * The stored copy is read ONCE, by that preflight, and carried here: `attach` indexes `appBytes`
 * (the bytes whose hash matched) and the sources below, never the files again, so a file changed
 * after the check cannot reach the index. `appPath` and `instrumentedDir` are for messages only.
 */
export interface BoundArtifact {
  /** `runs.app_id` of the run that published it (every batch of a run publishes one app id). */
  readonly appId: string;
  readonly artifactId: string;
  readonly sha256: string;
  readonly appPath: string;
  readonly instrumentedDir: string;
  /** The .app bytes whose SHA-256 is `sha256`. */
  readonly appBytes: Uint8Array;
  /** `<instrumentedDir>/app.json`, verbatim. */
  readonly appJsonText: string;
  /** Every `.al` under `instrumentedDir` (`readAlSources`). */
  readonly alSources: readonly AlSource[];
  /** R318: the verified manifest's renamed-member coverage names (`renamedMemberNamesOf`). */
  readonly renamedMemberNames: RenamedMemberNames;
  /** R-307 section 4: the verified manifest's object keys (`manifestObjectKeys`), checked by `attach`. */
  readonly manifestObjectKeys: ReadonlySet<string>;
}

/** R630: the server was ASKED and gave no package. `unread` names why, for the operator. */
export interface PackageUnread {
  readonly unread: string;
}

/** What `fetchPublishedAppPackage` answers: bytes, a failed read with its cause, or `undefined`
 *  (never asked). */
export type PublishedPackageRead = Uint8Array | PackageUnread | undefined;

/** R630: whether `r` is a failed read. */
export const isUnread = (r: PublishedPackageRead): r is PackageUnread =>
  r !== undefined && !(r instanceof Uint8Array);

/**
 * PR-88: what the request-sized sink gets (`ExecutionBackend.setRequestSizedSink`), per serve request that
 * gave a reading; also the body of the `serve-request-sized` event. Bytes throughout. `g` is the peak less
 * the floor. `calls` lists each call with its test entries in the request and its recent price per entry
 * (max of the last K readings; PR-246) after the reading.
 */
export type V3RequestSized = {
  /** PR-99: the lane (0 = the owner's) whose daemon served the request. */
  readonly lane?: number;
  /** PR-103: the request's kind. */
  readonly kind?: "prefetch" | "live";
  /**
   * PR-103: the daemon's request count at this request (`daemon.requests`, as R952 counts it). A daemon
   * that warmed the whole union starts at 2, so read a daemon's first request from `fresh`, not from this.
   * A gap in the count is a discarded re-send, not a lost event.
   */
  readonly daemonRequest?: number;
  /** PR-103: present when `ensureDaemon` started a new daemon for this request. */
  readonly fresh?: true;
  /** PR-103: the codeunits `ensureDaemon` proved lazily for this request; present only when above 0. */
  readonly proved?: number;
  /** PR-103: the daemon's RSS just after those proofs less its RSS just before, bytes (same pid, both reads). */
  readonly proveGrowth?: number;
  /**
   * PR-103: running total of the codeunits proved lazily on this daemon AFTER its first request (the
   * `fresh` one). The first request's proofs sit below the floor (its start), so they are left out. It
   * also counts requests that gave no reading and so no event.
   */
  readonly daemonProved?: number;
  /** PR-103: running total of the `proveGrowth` bytes measured across those proofs (same exclusion). */
  readonly daemonProveGrowth?: number;
  readonly calls: readonly {
    readonly call: number;
    readonly entries: number;
    readonly cost: number;
  }[];
  readonly floor: number;
  readonly start: number;
  readonly sampledPeak: number;
  /** `VmHWM`, present only when its reset was verified and the daemon was still running. */
  readonly hwm?: number;
  readonly g: number;
  readonly peakSource: "hwm" | "sampled";
};

/**
 * PR-100: al-runner's own per-request timings (its `summary.timings`), only the known fields and only
 * when their type is right. Milliseconds, except `baselineSource` and `engineKept`.
 * PR-227: `extra` keeps every OTHER field as al-runner sent it (`setupParts`, `workspaceCache`, and any
 * field a later build adds), when it is a number, a string, a boolean, or one flat object of those.
 * Anything deeper is left out. Measurement runs read it; no verdict or rule does.
 */
export type V3TimingValue = number | string | boolean;
export type V3Timings = {
  readonly extra?: Readonly<
    Record<string, V3TimingValue | Readonly<Record<string, V3TimingValue>>>
  >;
  readonly setupMs?: number;
  readonly compileMs?: number;
  readonly engineMs?: number;
  readonly baselineMs?: number;
  readonly testsMs?: number;
  readonly coverageMs?: number;
  readonly otherMs?: number;
  readonly resetMs?: number;
  readonly baselineSource?: string;
  readonly engineKept?: true;
};

/**
 * PR-100: what the request-timed sink gets (`ExecutionBackend.setRequestTimedSink`), one per serve
 * `send()`; also the body of the `serve-request-timed` event. `wallMs` is LethAL's own clock around
 * the request. `cause` is set on warm-ups only.
 */
export type V3RequestTimed = {
  /** PR-113: `baseline` is a baseline `plain()` request (the daemon baseline fill), never a coverage or echo window. */
  readonly kind: "warmup" | "prefetch" | "live" | "baseline";
  readonly lane: number;
  readonly wallMs: number;
  readonly entries: number;
  readonly tests: number;
  readonly selectedOnly?: true;
  readonly cut?: true;
  readonly failed?: true;
  readonly cause?: string;
  readonly timings?: V3Timings;
};

/**
 * PR-113: one baseline one-shot process (a fresh `--codeunit` run during the daemon baseline), timed. `reason`:
 * `cross-check` (an R948/R951 sample), `too-slow` (R790's re-run) or `other`. Also the body of the
 * `baseline-one-shot-timed` event.
 */
export type V3BaselineOneShotTimed = {
  readonly codeunit: number;
  readonly wallMs: number;
  readonly reason: "cross-check" | "too-slow" | "other";
};

export interface ExecutionBackend {
  capabilities(): BackendCapabilities;
  /** Releases what the backend holds open (bcdev's MCP child, v3's serve daemon). R775: the CLI calls it. */
  close?(): Promise<void>;
  /**
   * PR-144: closes the backend's serve daemons now, before the withheld-kill recheck starts its own, and
   * nothing else: `close()` stays the one place that prints the stats line. Absent: nothing to close.
   */
  closeDaemons?(): Promise<void>;
  /**
   * PR-315: whether this backend was built with `--stop-hung-sessions` on. `runNamedMutants` (and so
   * `lethal verify`) has no stop setting of its own, so it asks the backend. Absent: read as off.
   */
  stopsHungSessions?(): boolean;
  /**
   * R516 I1: true when the run's own in-run stop is the budget it was sent (bcdev; al-runner
   * one-shot, static or resource selector), so a larger budget really lets the test run longer.
   * False on al-runner `--server` (and resource with `--server`): the daemon stops a test body at
   * the one stop it was started with (`inRunStopMs`, R517) whatever the budget, while every
   * duration is the suite's wall clock, so raising the budget from a confirm (R515) moves no stop.
   * Read only by R515's re-budget, which is skipped unless this is `true`; absent counts as false,
   * the safe direction. Kept off `BackendCapabilities` so the stream schema does not change.
   */
  readonly inRunStopIsBudget?: boolean;
  /**
   * R577: "a kill must reproduce". When `true`, a kill whose unmutated confirmation passed is
   * re-run UNDER THE MUTANT once more, in the kill's own context (a single run at position 1, the
   * call's prefix replayed at k > 1), at the budget the killing run was sent. Only a second `fail`
   * (any text), or for a timeout kill a second `timeout`, makes it `killed`/`timeout-killed`;
   * anything else is `error` `kill-not-reproduced`, or the reproduction's own non-verdict cause.
   * Absent counts as false: the rule is off and the confirm is exactly what it was before.
   * al-runner, al-runner-v3 and bcdev set it (bcdev since R582). Kept off `BackendCapabilities` so the stream schema does not
   * change, like `inRunStopIsBudget`.
   */
  readonly killsMustReproduce?: boolean;
  /**
   * R857: `--isolate-tests`, al-runner-v3 only: every test ran alone. Absent counts as false. The
   * session puts it in its fingerprint and in `runner_build`, so nothing of such a run reaches a
   * default run, or the other way (resume, history, baseline snapshot). Kept off
   * `BackendCapabilities` so a default run's stream does not change.
   */
  readonly isolatesTests?: boolean;
  /**
   * PR-235: `LETHAL_V3_BASELINE_BATCHING=off` (al-runner-v3, measure-only). The baseline snapshot key does not
   * say whether the baseline was batched, so such a run neither reuses nor records a snapshot (as R857).
   */
  readonly baselineBatchingKnobOff?: boolean;
  /**
   * R907: `--no-client`, al-runner-v3 only: tests run as a session without a client
   * (`GuiAllowed()` false, as on BC's web-service path). Absent counts as false. The session puts it
   * in its fingerprint, in `runner_build` and in the report's execution context, so nothing of such
   * a run reaches a default run, or the other way.
   */
  readonly noClient?: boolean;
  /**
   * R938, al-runner-v3 only: the `--environment` choice and where it came from. A stated value is in
   * the fingerprint, in `runner_build` and in the report, so nothing of a run under one environment
   * is resumed or lent under the other. Absent on every backend but al-runner v3, which always has one.
   */
  readonly environmentChoice?: V3EnvironmentChoice | undefined;
  /**
   * R956, al-runner-v3 only: `alRunnerV3.license`, the `.bclicense` file passed as `--license` on every
   * call that runs tests: its path and the sha256 of its bytes. In the fingerprint and the report.
   */
  readonly license?: { readonly path: string; readonly sha256: string } | undefined;
  /** PR-282, al-runner-v3 only: `alRunnerV3.companies`, passed as `--companies` on every call that runs tests. In the fingerprint and the report. */
  readonly companies?: string | undefined;
  /** PR-297, al-runner-v3 only: `alRunnerV3.refusedCutTail` is ON (PR-347: on unless `false`). In the fingerprint, the lending build and the report. Absent (a backend with no such getter) counts as off. */
  readonly refusedCutTail?: boolean | undefined;
  /** PR-256, al-runner-v3 only: `alRunnerV3.stopGroups` is ON. In the fingerprint, the lending build and the report. Absent counts as off. */
  readonly stopGroups?: boolean | undefined;
  /** PR-402 (R1182), al-runner-v3 only: `alRunnerV3.loginReplay` is ON (`ALRUNNER_LOGIN_REPLAY=1` on mutant daemons). In the fingerprint and the lending build. Absent counts as off. */
  readonly loginReplay?: boolean | undefined;
  /**
   * R907: one-shot mutant calls pass `--skip-after-timeout` (the build lists it). Absent counts as false.
   */
  readonly skipAfterTimeout?: boolean;
  /**
   * R919: the build lists `--skip-after-timeout`, on either transport. This, not `skipAfterTimeout`, goes in
   * `runner_build`, so a session with the flag and one without it lend each other nothing, while a run that fell
   * back from serve to one-shot at the warm-up (R786) is still found by a `--resume` that starts on serve.
   */
  readonly skipAfterTimeoutSupported?: boolean;
  /**
   * R890: `alRunnerV3.isolation: "method"`: every test runs alone (as `isolatesTests`) under
   * al-runner's codeunit isolation, so a fresh codeunit per test, as BC's one-method runner.
   * Absent counts as false. In `runner_build` like `isolatesTests`.
   */
  readonly methodIsolation?: boolean;
  /**
   * R896: `alRunnerV3.isolation: "auto"`: the baseline chooses each test codeunit's mode
   * (`chooseIsolation`). Absent counts as false. In `runner_build` (` isolation-auto`) and the
   * fingerprint; such a run neither lends nor borrows history or a baseline snapshot.
   */
  readonly isolationAuto?: boolean;
  /**
   * PR-144: the session runs the serve-entries transport (a daemon answers every request). Read after
   * `decideTransport`. Absent counts as false (one-shot, or a backend with no such choice).
   */
  readonly serveEntries?: boolean;
  /**
   * R517, OPTIONAL: the in-run stop LethAL configured for the whole session, timed on the test's
   * own body, enforced whatever budget a run is sent. al-runner `--server` answers it once
   * `useMutantBudgetFloor` was called; absent elsewhere (the stop is the budget). An upper bound
   * on the position-1 confirm's threshold only: the stop a run ENFORCED is its verdict's
   * `reportedStopMs`, which such a backend must give or the timeout stays unconfirmed.
   */
  readonly inRunStopMs?: number | undefined;
  status(): Promise<BackendStatus>;
  /**
   * Compile + publish + verify the instrumented project. Publishing backends return the
   * immutable `CompiledArtifact` they deployed (so the orchestrator can record provenance);
   * backends with `deploy: "none"` return null — they still need the per-batch instrumented
   * dir, they just have no compiled artifact to describe.
   */
  deploy(instrumentedDir: string): Promise<CompiledArtifact | null>;
  /**
   * Compile the instrumented directory and throw on a compiler rejection, WITHOUT publishing.
   * Bisection's only question is whether alc accepts a source subset (spec §8); publishing a
   * candidate would put a narrowed artifact on a live server and, because candidates share one
   * version and id, would make every candidate after the first fail as a version conflict.
   * Backends with no publish step may implement this as their existing deploy.
   */
  compileCheck(instrumentedDir: string): Promise<void>;
  /**
   * R461, OPTIONAL: compile a staged copy of the UNMUTATED target (no selector, no guards, no
   * Control dependency) with the same compiler, package cache and /define, and throw on a
   * rejection. No publish. Absent on al-runner, whose compile happens per test.
   */
  compilePlainCheck?(dir: string): Promise<void>;
  /**
   * R739, OPTIONAL: where the backend's user-facing notices go during a session. `runSession` and
   * `runNamedMutants` install a function that emits a warning event (`code` is the event's code),
   * and call this with `undefined` at the session's end. Installing a function also resets the
   * backend's once-per-process notice flags, so every session sees its own notices. A backend
   * with no notifier, or one that was never given one, prints to `console.warn`.
   */
  setNotify?(notify?: (code: string, message: string) => void): void;
  /**
   * R939, OPTIONAL: where the backend reports a serve daemon it closed before the session's end
   * (al-runner-v3 only). Installed and removed with `setNotify`; each call becomes a
   * `serve-daemon-closed` event. With no sink, closes are only counted (the close line).
   */
  setDaemonCloseSink?(
    sink?: (close: {
      /** PR-99: the lane whose daemon closed. */
      readonly lane?: number;
      readonly reason: string;
      readonly family?: string;
      /** R1009: a refusal's whole first line, and the refused row's test name. */
      readonly text?: string;
      readonly test?: string;
      /** PR-100: the request kind in flight on the lane when it closed, else `idle`. */
      readonly phase?: "warmup" | "prefetch" | "live" | "baseline" | "idle";
    }) => void,
  ): void;
  /**
   * PR-56, OPTIONAL: where the backend reports a request that drifted from the baseline right after a
   * kept refusal (al-runner-v3 only). Installed and removed with `setNotify`; each call becomes a
   * `serve-drift-after-kept-refusal` event.
   */
  setKeptDriftSink?(
    sink?: (drift: {
      readonly refusal: string;
      readonly test: string;
      readonly baselineRow: string;
      readonly row: string;
    }) => void,
  ): void;
  /**
   * PR-88, OPTIONAL: where the backend reports the size of a serve request that gave a memory reading
   * (al-runner-v3 only). Installed and removed with `setNotify`; each call becomes a `serve-request-sized`
   * event (events stream only, not the report). Bytes throughout.
   */
  setRequestSizedSink?(sink?: (sized: V3RequestSized) => void): void;
  /**
   * PR-100, OPTIONAL: where the backend reports each serve request's timing (al-runner-v3 only).
   * Installed and removed with `setNotify`; each call becomes a `serve-request-timed` event
   * (events stream only, not the report).
   */
  setRequestTimedSink?(sink?: (timed: V3RequestTimed) => void): void;
  /** PR-113, OPTIONAL: where the backend reports each baseline one-shot call (al-runner-v3 only); a `baseline-one-shot-timed` event. */
  setBaselineOneShotSink?(sink?: (timed: V3BaselineOneShotTimed) => void): void;
  activate(mutantId: string | null): Promise<void>;
  run(ref: TestMethodRef, opts: RunOpts): Promise<TestVerdict>;
  /**
   * R198, OPTIONAL: run several methods against the active mutant in ONE call, stopping at the
   * first failure. Absent on a backend that has no such call (al-runner), whose covering loop is
   * then byte-for-byte the sequential one. Present only for a MUTANT run: a baseline needs
   * coverage per test and keeps the single-method call.
   */
  runMany?(opts: RunManyOpts): Promise<RunManyResult>;
  /**
   * C02-04b, OPTIONAL: bind to an ALREADY-installed artifact. Never compiles or publishes.
   * Throws `InstalledArtifactError` when the server does not report that artifact (and may throw
   * `HarnessVerificationError` from its readiness check); on any throw it binds nothing, not even
   * a transport an earlier `attach` or `deploy` had bound. Absent on a backend that cannot
   * (al-runner, which has nothing installed).
   */
  attach?(artifact: BoundArtifact): Promise<void>;
  /**
   * R139 check 2, OPTIONAL: the bytes of the package this backend's server currently holds for
   * `app`.
   *
   * Three answers, and the difference between the last two is what keeps the check honest:
   *
   * - **bytes** — the server answered.
   * - **`{ unread }`** — it was ASKED and did not answer (refused connection, 404, timeout,
   *   non-200), and `unread` says which (R630). The caller says so, with the cause, because a check
   *   that fails silently reads exactly like a check that passed.
   * - **`undefined`** — it was never asked, because this configuration cannot form the request at
   *   all (no server named, no credentials). Check 2 stays silent: there is no failure to report,
   *   only a capability that does not apply here. R-372: the run then records no test digests
   *   (`test-digests-unavailable`), since the body the server runs was never seen.
   *
   * Optional for the same reason `undefined` exists: `al-runner` compiles and runs locally, so
   * there is no published app to ask about. Implementations must never throw — a proactive check
   * must not be able to stop a run.
   */
  fetchPublishedAppPackage?(app: {
    readonly publisher: string;
    readonly name: string;
  }): Promise<PublishedPackageRead>;

  /**
   * R-371, OPTIONAL: the folders a backend that publishes nothing loads dependency packages from
   * (al-runner's `--package-cache`), so a run can fingerprint the non-Microsoft dependencies that
   * RAN. Absent: none, and such a dependency cannot be read (the run records no test digests).
   */
  dependencyPackageDirs?(): readonly string[];

  /**
   * R435, OPTIONAL: the folder of `*.Source.zip` apps the backend loads Microsoft test libraries
   * from when no package folder holds them (al-runner v3's artifact cache), or `undefined` when
   * the backend cannot name it. The dependency fingerprint hashes those zips too.
   */
  dependencyArtifactAppsDir?(): string | undefined;

  /**
   * R-385, OPTIONAL: how a backend that PUBLISHES reads Microsoft dependencies for the dependency
   * fingerprint: the bytes the server holds (`System`, every Microsoft app in the closure, the
   * control app's dependencies) and each one's installed version. A run or verify on the
   * published path without it records no digests or refuses; it never falls back to declared
   * versions. Throws `DependencyUnreadableError` when it cannot be built.
   */
  microsoftMode?(): MicrosoftMode;

  /**
   * R389, OPTIONAL: how many published apps on the server declare `appId` as a dependency (the
   * control app's `DependentCount`). Present on bcdev only; absent means the closed-world guard
   * is never asked and falls back (`closed-world.ts`).
   */
  dependentCount?(appId: string): Promise<number>;

  /**
   * R733, OPTIONAL: the INSTALLED apps on the server that declare `appId` as a dependency, by name
   * (the control app's `InstalledDependents`, 1.0.0.24). Present on bcdev only; absent means R727's
   * dependents warning makes no call.
   */
  installedDependents?(appId: string): Promise<readonly import("./harness").InstalledDependent[]>;

  /**
   * R847, OPTIONAL: the versions of `appId`'s INSTALLED rows, read by id (R433). Present on bcdev
   * only. None means not installed (a first publish); two means there is no one installed base.
   */
  installedVersions?(appId: string): Promise<readonly string[]>;

  /**
   * R847, OPTIONAL (needs control app 1.0.0.25 or newer): who owns each object, read by key. Present on bcdev
   * only. One row per item read; a read cut short by `maxMs` answers fewer.
   */
  objectOwners?(
    items: readonly import("./harness").ObjectItem[],
    maxMs: number,
    timeoutMs: number,
  ): Promise<import("./harness").OwnersRead<import("./harness").ObjectOwnerRow>>;

  /** R847, OPTIONAL (needs control app 1.0.0.25 or newer): as `objectOwners`, for fields. */
  fieldOwners?(
    items: readonly import("./harness").FieldItem[],
    maxMs: number,
    timeoutMs: number,
  ): Promise<import("./harness").OwnersRead<import("./harness").FieldOwnerRow>>;

  /**
   * R488, OPTIONAL: every test the session discovered, every arm read, given before the baseline
   * and to every worker. A backend whose test selector is a substring match (al-runner one-shot)
   * excludes the look-alikes up front with it.
   */
  useDiscoveredTests?(tests: readonly TestMethodRef[]): void;

  /**
   * R761, OPTIONAL: called once, right after `useDiscoveredTests` and before the first deploy.
   * al-runner v3 picks its transport here (serve-entries by default where proven). `resume` is true
   * for a `--resume` / `--resume-run` session (the only sessions that reuse a baseline snapshot).
   */
  decideTransport?(facts: { readonly resume: boolean }): Promise<void>;

  /**
   * R557, OPTIONAL: the session's test suite (`chooseTestSuite`'s `tests`) and the tests kept in
   * an `#if` arm discovery could not decide (`preproc-undecided-kept`, R403), given next to
   * `useDiscoveredTests` and to every worker. al-runner reads them when a test has no row: an
   * undecided-kept test keeps a per-test `error`, any other session-suite test stops the session
   * (`AlRunnerTestNameError`), and a `--server` stop lists only missing session-suite tests.
   */
  useSessionTests?(suite: readonly TestMethodRef[], undecidedKept: readonly TestMethodRef[]): void;

  /**
   * R517, OPTIONAL: the session's `--mutant-timeout-ms` floor and baseline timeout, given once
   * both are known, before the first run, and to every worker. al-runner `--server` starts its
   * daemon with `--test-timeout ceil(max(floor, baseline) / 1000)` and refuses to start one
   * without it.
   */
  useMutantBudgetFloor?(floorMs: number, baselineTimeoutMs: number): void;

  /**
   * R954, OPTIONAL: al-runner v3 only, and only without `--mutant-timeout-ms`: the session's mutant
   * stop (`max(60 s, 20 x the largest green baseline + 5 s)`), given after the baseline and before
   * the mutant loop (again if a later batch raises it). From then on the serve daemon's stop is this,
   * not the baseline timeout.
   */
  useMutantStop?(ms: number): void;

  /**
   * R586 (F5), OPTIONAL: a mutant's covering tests and the budget the covering loop will send
   * each, given once per mutant after its activation and before its first run. al-runner v3 runs
   * a whole test codeunit per call, so it sends the call the LARGEST budget of the refs it serves.
   */
  useCoveringBudgets?(
    mutantId: string,
    budgets: readonly { readonly ref: TestMethodRef; readonly budgetMs: number }[],
  ): void;

  /**
   * PR-51 (Addendum 1), OPTIONAL: the backend's per-mutant state that a timeout leaves behind and
   * that routes later runs (v3: the set of tests its calls were cut at). The covering loop reads it
   * when it holds or notes a timeout step and puts it back (`restoreCutState`) before that step's
   * replay, so the replay's reproduction routes as it did when the step was met. Opaque to the
   * loop. bcdev has no such state and implements neither.
   */
  cutState?(mutantId: string): unknown;
  restoreCutState?(mutantId: string, state: unknown): void;

  /**
   * PR-340, OPTIONAL (al-runner-v3 only): the carry walk for a SURVIVOR whose PR-327 (a) label would be
   * added. Three batch-shaped `strictOrder` requests on the SAME lane's daemon (the mutant, none, the
   * mutant) over the covering test codeunits run in one session, in order. `undefined`: no walk (the
   * survivor would not be labelled). Never moves a verdict by itself; the orchestrator scores it.
   */
  carryWalk?(
    mutantId: string,
    covering: readonly TestMethodRef[],
    site?: { readonly objectType: string; readonly codeunitId: number },
  ): Promise<CarryWalkResult | undefined>;

  /**
   * R586 (I3), OPTIONAL: a tagged note for a SURVIVOR with these covering tests
   * (`[v3-refused-test-nearby] ...`), written into its `failureNote`. Never moves a verdict.
   */
  survivorNote?(
    covering: readonly TestMethodRef[],
    site?: { readonly objectType: string; readonly codeunitId: number },
  ): string | undefined;

  /**
   * R885, OPTIONAL: one line for the "no green baseline tests" note when the backend saw why
   * (v3: its "test data is off" note), else `undefined`.
   */
  baselineNote?(): string | undefined;

  /**
   * R678, OPTIONAL: a batch's baseline came from a reused `--resume` snapshot (R192), so no
   * baseline call ran. Called once, inside the baseline bracket, with the reused verdicts, so the
   * backend can record what a baseline call would have (v3: its refused tests, for `survivorNote`).
   */
  noteReusedBaseline?(
    baseline: readonly { readonly ref: TestMethodRef; readonly verdict: TestVerdict }[],
  ): void;

  /**
   * PR-21 (L5), OPTIONAL (al-runner v3 on serve-entries): the backend's own baseline state, stored
   * with the batch's snapshot so a resumed session can take it back. `undefined`: nothing to store.
   */
  baselineState?(): Promise<unknown>;

  /**
   * PR-21 (L5), OPTIONAL: a resumed session's re-check of a reused snapshot (`state`, from
   * `baselineState`), inside the baseline bracket; on success the backend holds that state as its
   * own. Returns why the snapshot is NOT reused, or `undefined` when it is. A backend that
   * implements it reuses snapshots although `resumeRunsBaseline` is true.
   */
  recheckReusedBaseline?(
    state: unknown,
    storedCoverage: ReadonlyMap<string, string>,
    timeoutMs: number,
  ): Promise<string | undefined>;

  /**
   * R896, OPTIONAL (al-runner v3, `isolation: "auto"` only): fixes test codeunit `codeunitId`'s
   * mode for the session: `"method"` runs each of its tests alone under codeunit isolation, `"test"`
   * runs it whole, as always. Clears the codeunit's baseline refusals (the orchestrator notes them
   * again from the CHOSEN rows, `noteReusedBaseline`). Called by the orchestrator inside the
   * baseline bracket of the first batch that runs a live baseline, and never again.
   */
  chooseIsolation?(codeunitId: number, mode: "test" | "method"): void;

  /**
   * R926, OPTIONAL (al-runner v3): the mode test codeunit `codeunitId` runs under right now. The
   * orchestrator reads it when a baseline ends and again for each mutant, and decides a mutant's
   * reach from baseline coverage only when the two agree. Absent means one mode for everything.
   */
  isolationOf?(codeunitId: number): "test" | "method";

  /**
   * R635 §4, OPTIONAL: `true` right before a batch's baseline step (`activateOnce(null)`), `false`
   * in a `finally` after its baseline loop. al-runner v3's serve-entries transport reads its
   * baseline (one-shot, coverage, baseline refusals) from this bracket ONLY, never from "no mutant
   * active", so the kill confirm and Decision 11's rerun are not baseline calls.
   */
  baselinePhase?(on: boolean, completed?: boolean): void | Promise<void>;

  /**
   * R1131, OPTIONAL (bcdev outside hub mode): the start WorkDate the current batch's baseline ran under (its
   * baseline calls, or a reused snapshot's verdicts), or `undefined` when none is known. Read when the batch's
   * baseline ends; it travels on `baseline-batch-finished` as `workDate`.
   */
  batchWorkDate?(): string | undefined;

  /**
   * R1131, OPTIONAL (bcdev outside hub mode): why a stored snapshot whose baseline ran on `snapshotWorkDate`
   * (`undefined`: a snapshot from before control 1.0.0.28) is NOT reused, or `undefined` when it is. Reuse needs
   * an equal date: a snapshot measured on another day's start date is not this session's baseline.
   */
  refuseReusedBaselineDate?(snapshotWorkDate: string | undefined): string | undefined;

  /**
   * R948, OPTIONAL (al-runner v3): the session's stop state, given once with the budget floor. The
   * backend asks `spent()` before each request of a baseline it runs ahead of the orchestrator's
   * own loop (R955: no new call once the budget is out or a stop signal came), `signalled()` after
   * each (a call a signal ended is dropped), and calls `stopForMemory` when the container stays over
   * its memory bound: the session then stops through R955's path, and the report names memory.
   */
  useStopHandle?(handle: {
    spent(): boolean;
    signalled(): boolean;
    stopForMemory(info: {
      readonly usedBytes: number;
      readonly boundBytes: number;
      readonly source: string;
    }): void;
  }): void;

  /**
   * R948, OPTIONAL: asked right before the mutant loop activates a mutant (each lane's loop too,
   * so per activation, not per window). `false`: the memory guard stopped the session (it has
   * spent the budget through `useStopHandle`), so this group is NOT started and no later one is.
   */
  mayStartGroup?(): Promise<boolean>;

  /**
   * R948, OPTIONAL: true when this session's baseline comes from a serve daemon. Part of what
   * lends: its ` baseline-daemon` tag is in `runner_build`, so a snapshot or history from a daemon
   * baseline is not lent to a one-shot session, nor the other way.
   */
  readonly baselineDaemon?: boolean;

  /**
   * R1008, OPTIONAL: true when a `--resume` of this session must run its baseline again rather than
   * reuse a stored snapshot (al-runner-v3 on serve-entries: the warm-up needs this session's rows).
   * Read after `decideTransport`. Absent counts as false.
   */
  readonly resumeRunsBaseline?: boolean;

  /**
   * R635 §4, OPTIONAL: once at the top of each mutant-loop call, every covered mutant of that
   * shard with its covering refs. al-runner v3's serve-entries transport sends them as entries
   * and keeps each fully valid answer for that mutant's first activation.
   */
  prefetchMutants?(
    plans: readonly { readonly mutantId: string; readonly refs: readonly TestMethodRef[] }[],
    /**
     * R912: `remainingMs` is the time left of `--time-budget`. A prefetch request's outer deadline is
     * clamped to it; a live request never is (a live deadline is an `error` verdict).
     */
    opts?: {
      readonly remainingMs?: () => number;
      /**
       * PR-241: `plans` packs several split-prefetch units: how many plans each holds, in order (sums to
       * `plans.length`). Absent: one unit. A request never mixes units whose flags or guards differ.
       */
      readonly unitSizes?: readonly number[];
      /**
       * R912: every covered mutant of the call, passed with the first window only. The backend warms
       * up for all of them, as a whole-batch prefetch did, so a window cannot change what is warm.
       */
      readonly batchPlans?: readonly {
        readonly mutantId: string;
        readonly refs: readonly TestMethodRef[];
      }[];
    },
  ): Promise<void>;

  /**
   * PR-99 (§10.2), OPTIONAL: an N = 1 mutant loop hands over what it measured per procedure-scope unit (its
   * scoring wall, the window prefetch excluded) and per window (the prefetch wall), so the run records the
   * input of the scheduling bound. Timing only: no verdict reads it.
   */
  noteUnitTimings?(t: {
    readonly units: readonly {
      readonly window: number;
      readonly scope: string;
      readonly mutants: number;
      readonly entries: number;
      readonly scoringMs: number;
    }[];
    readonly windows: readonly {
      readonly window: number;
      readonly mutants: number;
      readonly entries: number;
      readonly prefetchMs: number;
    }[];
  }): void;

  /**
   * R912, OPTIONAL: true when a call for test codeunit `codeunitId` runs the codeunit's WHOLE suite
   * (v3 with entries and the codeunit not per-test), so a mutant's covering-test time is the whole
   * codeunit's baseline time. Absent counts as false: only the covering tests run.
   */
  wholeCodeunit?(codeunitId: number): boolean;

  /**
   * R653, OPTIONAL: called right before a cold fail kill's unmutated confirm, under the killing
   * mutant. al-runner v3's serve-entries transport sends the confirm (NONE) and the reproduction
   * (the mutant) as ONE request, confirm first, and keeps each answer for the next `activate(null)`
   * and `activate(mutantId)`. A no-op when it cannot; the confirm and the reproduction then run as
   * before.
   */
  sendKillPair?(mutantId: string, ref: TestMethodRef): Promise<void>;

  /**
   * PR-81 (R1066), OPTIONAL: drop the kill pair `sendKillPair` left pending for this mutant. The
   * covering loop calls it before it re-activates a mutant after a cold confirm that did not pass
   * (a held error), so the next `activate(mutantId)` is not read as the pair's reproduction. A
   * no-op when no pair is pending for that mutant. bcdev has no pair and does not implement it.
   */
  dropPendingPair?(mutantId: string): void;
}
