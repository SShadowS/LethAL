import type { CompiledArtifact } from "./artifact";
import type { OperationOutcome } from "./operation-outcome";

export interface TestMethodRef {
  readonly codeunitId: number;
  readonly codeunitName: string;
  readonly method: string;
}

/**
 * `timeout` means the TEST RUNNER confirmed the test did not terminate — real
 * evidence about the mutant (design.md §6.7).
 * `deadline-exceeded` means OUR client timer fired and we know nothing about
 * what the server did — infrastructure noise, never evidence about the mutant.
 */
export type TestOutcome = "pass" | "fail" | "skip" | "timeout" | "deadline-exceeded" | "error";

export interface CoverageEntry {
  readonly objectType: string;
  readonly objectId: number;
  readonly procedure: string;
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
}

export interface BackendCapabilities {
  readonly coverage: "none" | "procedure" | "line";
  readonly deploy: "publish" | "none";
  readonly isolation: "session" | "full-reset";
  readonly authoritative: boolean;
}

export interface BackendStatus {
  readonly ok: boolean;
  readonly details: string;
}

export interface RunOpts {
  readonly coverage: "none" | "procedure" | "line";
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
