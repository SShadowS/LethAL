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
  deploy(instrumentedDir: string): Promise<void>;
  activate(mutantId: string | null): Promise<void>;
  run(ref: TestMethodRef, opts: RunOpts): Promise<TestVerdict>;
}
