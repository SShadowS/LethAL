import type { CompiledArtifact } from "./artifact";
import type { OperationOutcome } from "./operation-outcome";

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
export interface CoverageEntry {
  readonly objectType: string;
  readonly objectId: number;
  readonly procedure?: string;
  readonly line?: number;
}

export interface CoverageMap {
  readonly granularity: "procedure" | "line";
  readonly entries: readonly CoverageEntry[];
}

export interface TestVerdict {
  readonly ref: TestMethodRef;
  readonly outcome: TestOutcome;
  readonly durationMs: number;
  readonly failureMessage?: string;
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
 * | `"none"` | fenced `RunMutant` | no |
 *
 * `"fenced"` exists because the mutants ALWAYS run fenced, so `"procedure"` measures the green set
 * on a different session type than the one that produces verdicts (R55: 12 of 56 Continia Document
 * Output tests fail on the hub and pass on the fence, taking their coverage with them).
 */
export type CoverageMode = "none" | "procedure" | "line" | "fenced";

export interface BackendCapabilities {
  readonly coverage: CoverageMode;
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
}

export interface ExecutionBackend {
  capabilities(): BackendCapabilities;
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
  activate(mutantId: string | null): Promise<void>;
  run(ref: TestMethodRef, opts: RunOpts): Promise<TestVerdict>;
}
