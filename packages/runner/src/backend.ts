export interface TestMethodRef {
  readonly codeunitId: number;
  readonly codeunitName: string;
  readonly method: string;
}

export type TestOutcome = "pass" | "fail" | "skip" | "timeout" | "error";

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
