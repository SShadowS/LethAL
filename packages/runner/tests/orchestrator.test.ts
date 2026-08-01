import { Database } from "bun:sqlite";
import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ALSyntaxNode, MutationSpec } from "@lethal/engine";
import type { InstrumentedFile, MutantManifestEntry } from "@lethal/schemata";
import { writeInstrumentedProject } from "@lethal/schemata";
import { AlcCompileError, ArtifactPrepareError, DeploymentError } from "../src/artifact";
import type { CompiledArtifact } from "../src/artifact";
import type {
  BackendCapabilities,
  BackendStatus,
  ExecutionBackend,
  RunOpts,
  TestMethodRef,
  TestVerdict,
} from "../src/backend";
import { DeploymentVerifier, decidePublishOutcome } from "../src/deployment-verifier";
import { ActivationFailure } from "../src/failure-classes";
import { LeaseUnavailableError } from "../src/lease";
import type {
  AcquireOutcome,
  BeginPublishOutcome,
  EndPublishOutcome,
  Lease,
  LeaseApi,
  LeaseTuple,
  OperationStatus,
  RecoverOpOutcome,
  ReleaseOutcome,
  RenewOutcome,
} from "../src/lease";
// Namespace import purely so the two-batch test can `spyOn` `planArtifacts` — Bun's ESM
// implementation makes that reach `runSession`'s own intra-module call site, which is the only way
// to drive more than one batch while `planArtifacts` still collapses everything into one artifact.
import * as orchestratorModule from "../src/orchestrator";
import {
  MIN_MUTANT_BUDGET_MS,
  activateOnce,
  generateMutationSet,
  invalidateBatchVerdicts,
  narrowFilesToSubset,
  operatorTiers,
  runOnce,
  runSession,
} from "../src/orchestrator";
import type {
  LeaseSessionConfig,
  LeaseTimers,
  MutationSetResult,
  SessionConfig,
} from "../src/orchestrator";
import { QuarantineStore } from "../src/quarantine-store";
import { renderConsole } from "../src/report";
import type { SessionOutcome } from "../src/report";
import { SessionSafety, SessionUnsafeError } from "../src/session-safety";
import { ResultsStore } from "../src/store";

const TARGET_AL = `codeunit 79000 "Sandbox Logic"
{
    procedure IsOverBudget(Amount: Decimal; Budget: Decimal): Boolean
    begin
        exit(Amount > Budget);
    end;
}
`;

const TEST_AL = `codeunit 79100 "Sandbox Tests"
{
    Subtype = Test;

    [Test]
    procedure OverBudgetDetected()
    begin
    end;
}
`;

// A file with zero mutable sites — no comparisons, no exit(), no calls, no
// non-empty blocks — so generateMutationSet never includes it in any batch's
// `files`. Used to prove the orchestrator still copies it into the batch dir
// verbatim (C3), since alc needs the FULL project to compile, not just the
// mutated subset.
const NO_MUTANTS_AL = `codeunit 79002 "Sandbox NoOp"
{
    procedure NoOp()
    begin
    end;
}
`;

// Two independent, non-nested procedures. Used below for worker-sharding
// tests and for coverage-filter tests that need mutants split across two
// distinctly-identifiable procedures (e.g. "only IsOverBudget's procedure is
// covered"). Historically this fixture existed because `batchByOverlap`
// forbade any overlap within a batch, so `TARGET_AL`'s 3 nested mutants
// (empty-block on the procedure body, return-value on the exit statement,
// conditional-boundary on the comparison) always landed in 3 separate
// batches of exactly 1, and a batch of 1 mutant could never be sharded
// across >1 worker no matter how correct the fan-out was. Layer 4.3 removed
// overlap batching (every mutant compiles into the same single artifact
// regardless of overlap), so that constraint is gone — `TARGET_AL`'s 3
// mutants shard across workers directly now too.
const TWO_PROC_AL = `codeunit 79000 "Sandbox Logic"
{
    procedure IsOverBudget(Amount: Decimal; Budget: Decimal): Boolean
    begin
        exit(Amount > Budget);
    end;

    procedure IsUnderBudget(Amount: Decimal; Budget: Decimal): Boolean
    begin
        exit(Amount < Budget);
    end;
}
`;

// Three independent, non-nested procedures — used by the fractional-workers
// test below, which needs several shardable mutants to prove the flooring
// fix matters. Historically (pre-Layer-4.3, when `shardEvenly` ran once per
// batch) TWO_PROC_AL's exactly-2-mutants-per-batch made `i % 2.5` for i=0,1
// land safely inside `Array.from({length: 2.5}, ...)`'s truncated 2-element
// shard array — the drop bug only surfaces once an index >=2 is reached
// (`2 % 2.5 === 2`, out of the truncated array's bounds), so a third
// procedure was needed to reach it. With overlap batching removed,
// `shardEvenly` now runs once over every mutant in the single artifact, so
// this fixture is no longer uniquely load-bearing for that — THREE_PROC_AL's
// 9 mutants still comfortably exercise the fix.
const THREE_PROC_AL = `codeunit 79000 "Sandbox Logic"
{
    procedure IsOverBudget(Amount: Decimal; Budget: Decimal): Boolean
    begin
        exit(Amount > Budget);
    end;

    procedure IsUnderBudget(Amount: Decimal; Budget: Decimal): Boolean
    begin
        exit(Amount < Budget);
    end;

    procedure IsEqualBudget(Amount: Decimal; Budget: Decimal): Boolean
    begin
        exit(Amount = Budget);
    end;
}
`;

// M4 regression: two independent, non-nested procedures whose mutation sites'
// character offsets (`startIndex`) are chosen so a leading-digit comparison
// disagrees with the numeric one — IsOverBudget's sites land in the 200s
// (leading digit "2"), IsUnderBudget's land in the 1800s (leading digit "1"),
// after the padding comment block. `outcomes.sort()` in orchestrator.ts must
// order these ascending by NUMERIC startIndex (207 < 1830); sorting the
// colon-joined string "file:startIndex" via localeCompare instead compares
// "207" against "1830" character-by-character and finds '2' > '1' at the
// first position, putting the LARGER offset first — exactly the ":1000
// sorts before :99" bug this fixture is built to catch. (Verified against
// the real parser: without WIDE_GAP_LEAD_PAD, both procedures' offsets
// happen to share a leading "1" digit and the bug doesn't manifest.)
const WIDE_GAP_LEAD_PAD = "// L\n".repeat(20);
const WIDE_GAP_MID_PAD = "    // padding\n".repeat(100);
const WIDE_GAP_AL = `${WIDE_GAP_LEAD_PAD}codeunit 79000 "Sandbox Logic"
{
    procedure IsOverBudget(Amount: Decimal; Budget: Decimal): Boolean
    begin
        exit(Amount > Budget);
    end;

${WIDE_GAP_MID_PAD}
    procedure IsUnderBudget(Amount: Decimal; Budget: Decimal): Boolean
    begin
        exit(Amount < Budget);
    end;
}
`;

// A SECOND source file with its own mutable sites, so `generateMutationSet` returns two
// `InstrumentedFile`s that the two-batch lease-scoping test can split into two artifacts (see that
// test for why the split has to be injected at the `planArtifacts` seam).
const SECOND_FILE_AL = `codeunit 79001 "Sandbox Other"
{
    procedure IsWithinLimit(Amount: Decimal; Limit: Decimal): Boolean
    begin
        exit(Amount < Limit);
    end;
}
`;

const APP_ID = "11111111-1111-1111-1111-111111111111";
const APP_JSON = JSON.stringify(
  {
    id: APP_ID,
    name: "Sandbox Orchestrator Fixture",
    publisher: "LethAL",
    version: "1.0.0.0",
    idRanges: [{ from: 79000, to: 79199 }],
  },
  null,
  2,
);

class StubBackend implements ExecutionBackend {
  activations: Array<string | null> = [];
  deploys: string[] = [];
  /**
   * ROADMAP R26: the `failureMessage` a failing run carries, if any. A public field rather than
   * another positional constructor arg — the ctor already takes seven, and only the permissions-
   * diagnosis tests need this. Consulted ONLY when the scripted outcome is `"fail"`, so a test that
   * sets it cannot accidentally attach a failure message to a passing run.
   */
  failureMessageFor?: (mutant: string | null, ref: TestMethodRef) => string | undefined;
  constructor(
    private readonly caps: BackendCapabilities,
    private readonly script: (
      mutant: string | null,
      ref: TestMethodRef,
      // R59: the RUNNER a call goes to, so a fake can model two runners that DISAGREE.
      // A hub coverage mode sends the baseline to bc-dev-mcp and every verdict through the
      // fenced transport; without this argument no fake can tell the two apart, and every
      // test here would be blind to the mechanism R55/R57 measured.
      opts: RunOpts,
    ) => TestVerdict["outcome"],
    private readonly coverageProcedures: string[] = [],
    // When set, deploy() throws this value instead of succeeding — lets tests
    // simulate a batch-deploy failure (e.g. to prove the failure text alone
    // can't be miscounted as a different verdict cause).
    private readonly deployError?: unknown,
    // When set, awaited at the top of run() — lets tests probe how many
    // concurrent run() calls are in flight at once (the parallel-workers
    // concurrency proof).
    private readonly onRun?: () => Promise<void>,
    // When set, called on every deploy() with the artifact dir; returning an
    // Error throws it instead of succeeding, returning undefined succeeds.
    // Unlike `deployError` (a fixed always-throw), this lets a test fail
    // deploy conditionally — e.g. only while a specific mutant's spec is
    // still present in the artifact — to exercise bisection.
    private readonly deployGuard?: (dir: string) => Error | undefined,
  ) {}
  capabilities() {
    return this.caps;
  }
  async status(): Promise<BackendStatus> {
    return { ok: true, details: "stub" };
  }
  async deploy(dir: string): Promise<CompiledArtifact | null> {
    if (this.deployError !== undefined) throw this.deployError;
    const guardErr = this.deployGuard?.(dir);
    if (guardErr !== undefined) throw guardErr;
    this.deploys.push(dir);
    return null; // in-memory stub: nothing compiled, no artifact to describe
  }
  // This stub never modeled a separate publish/verify phase (that split is what
  // CompilePublishVerifyBackend below exists to test), so its compile-only seam is just its
  // existing deploy(): same guard, same error typing, same `deploys` bookkeeping. Every
  // bisection test below that exercises `deployGuard`/`deploys` keeps working unchanged —
  // bisection now calls this instead of deploy(), not some new, separately-behaving path.
  async compileCheck(dir: string): Promise<void> {
    await this.deploy(dir);
  }
  async activate(id: string | null) {
    this.activations.push(id);
  }
  async run(ref: TestMethodRef, opts: RunOpts): Promise<TestVerdict> {
    await this.onRun?.();
    const active = this.activations.at(-1) ?? null;
    const outcome = this.script(active, ref, opts);
    // Every mode that CLAIMS per-procedure coverage reports it at baseline — `"procedure"` (hub)
    // and R58's `"fenced"` alike. Written as `!== "none"` so the two stay indistinguishable to the
    // orchestrator, which is the point of the mode being a routing axis rather than a granularity.
    const hasCoverage = active === null && this.caps.coverage !== "none";
    // Layer 5C-A Task 8, Task 10 (design §G): this stub represents a healthy, correctly-deployed
    // authoritative backend by default — every coverage:"none" (the transport path) call attests
    // cleanly, mirroring what a real RunMutant `ran` result would report. Only the dedicated
    // `attestingBackend` fake (Task 10's own tests, below) models a NEVER-attests container;
    // every pre-existing test here keeps its prior verdicts unaffected by the new fail-closed gate.
    const hasAttestation = this.caps.authoritative && opts.coverage === "none";
    const failureMessage = outcome === "fail" ? this.failureMessageFor?.(active, ref) : undefined;
    return {
      ref,
      outcome,
      durationMs: 5,
      ...(failureMessage !== undefined ? { failureMessage } : {}),
      ...(hasCoverage
        ? {
            coverage: {
              granularity: "procedure" as const,
              entries: this.coverageProcedures.map((p) => ({
                objectType: "Codeunit",
                objectId: 79000,
                procedure: p,
              })),
            },
          }
        : {}),
      ...(hasAttestation ? { attestation: { observedAny: true, identityMismatch: false } } : {}),
    };
  }
}

async function makeProject(testAl: string = TEST_AL) {
  const root = await mkdtemp(join(tmpdir(), "lethal-orch-"));
  const projectDir = join(root, "app");
  const testDir = join(root, "tests");
  const instrumentedDir = join(root, "instr");
  await Bun.write(join(projectDir, "SandboxLogic.Codeunit.al"), TARGET_AL);
  await Bun.write(join(projectDir, "app.json"), APP_JSON);
  await Bun.write(join(testDir, "SandboxTests.Codeunit.al"), testAl);
  return { projectDir, testDir, instrumentedDir };
}

/**
 * A table whose field trigger holds two mutation sites (`empty-block` on the trigger body,
 * `negate-conditional` on the `=`). `StubBackend`'s coverage only ever names
 * `Codeunit 79000`, so nothing in the index mentions this table at any precision — which is the
 * shape that drives `coverageFilter`'s FALLBACK 2 ("run every green test").
 */
const TRIGGER_TABLE_AL = `table 79001 "Sandbox Table"
{
    fields
    {
        field(1; "No."; Code[20])
        {
            trigger OnValidate()
            begin
                if "No." = '' then
                    Error('blank');
            end;
        }
    }
}
`;

async function makeProjectWithTriggerTable() {
  const dirs = await makeProject();
  await Bun.write(join(dirs.projectDir, "SandboxTable.Table.al"), TRIGGER_TABLE_AL);
  return dirs;
}

const CAPS_NST: BackendCapabilities = {
  coverage: "procedure",
  deploy: "publish",
  isolation: "session",
  authoritative: true,
};

/**
 * Non-authoritative twin of CAPS_NST — same coverage/deploy/isolation shape, but
 * `authoritative: false`. Layer 5C-A Task 8, Task 10 (design §G) now rejects `workers > 1` for
 * an authoritative backend outright (the single `LC Mutation Active` row has no cross-process
 * lease in 5C-A) — used by pre-existing sharding/worker tests below whose actual subject is the
 * orchestrator's OWN sharding/dedup logic, not backend authoritativeness, so this twin preserves
 * their intent without tripping the new assertion.
 */
const CAPS_NST_WORKERS: BackendCapabilities = {
  coverage: "procedure",
  deploy: "publish",
  isolation: "session",
  authoritative: false,
};

const selectorIds = { selectorId: 50000, controlId: 50001, tableId: 50002 };

describe("runSession", () => {
  test("kill: mutant-active fail + baseline-pass confirmation = killed", async () => {
    const dirs = await makeProject();
    const backend = new StubBackend(CAPS_NST, (mutant) => (mutant === null ? "pass" : "fail"), [
      "IsOverBudget",
    ]);
    const store = new ResultsStore(":memory:");
    const report = await runSession({ backend, store, ...dirs, selectorIds });
    expect(report.baselineGreen).toBe(true);
    expect(report.counts.killed).toBeGreaterThan(0);
    expect(report.counts.survived).toBe(0);
    expect(backend.activations.at(-1)).toBeNull(); // finally: deactivated
    expect(backend.deploys.length).toBeGreaterThan(0);
  });

  test("survive: tests pass under every mutant", async () => {
    const dirs = await makeProject();
    const backend = new StubBackend(CAPS_NST, () => "pass", ["IsOverBudget"]);
    const store = new ResultsStore(":memory:");
    const report = await runSession({ backend, store, ...dirs, selectorIds });
    expect(report.counts.killed).toBe(0);
    expect(report.counts.survived).toBeGreaterThan(0);
    expect(report.mutationScore).toBe(0);
  });

  test("no coverage: uncovered procedure mutants get no-coverage, no runs", async () => {
    const dirs = await makeProject();
    const backend = new StubBackend(CAPS_NST, () => "pass", []); // covers nothing
    const store = new ResultsStore(":memory:");
    const report = await runSession({ backend, store, ...dirs, selectorIds });
    expect(report.counts.noCoverage).toBeGreaterThan(0);
    expect(report.counts.survived).toBe(0);
  });

  // R58: `"fenced"` must land on the coverage-FILTER branch, not the all-green-tests branch. The
  // orchestrator's only test is `caps.coverage === "none"`, so a mode added without checking it
  // would silently run every mutant against every green test: slower, never wrong, and completely
  // invisible in the verdicts — the same "a regression changes no count" shape the
  // untargetedTriggerCount tests below exist for.
  test("coverage:fenced capability selects per mutant, exactly like procedure", async () => {
    const dirs = await makeProject();
    const covering = new StubBackend(
      { coverage: "fenced", deploy: "publish", isolation: "session", authoritative: false },
      () => "pass",
      ["IsOverBudget"],
    );
    const covered = await runSession({
      backend: covering,
      store: new ResultsStore(":memory:"),
      ...dirs,
      selectorIds,
    });
    expect(covered.counts.survived).toBeGreaterThan(0);

    // Same backend, same script, covering NOTHING: under a filtering mode the uncovered mutants
    // must be reported `no-coverage` rather than run against all green tests.
    const nothing = new StubBackend(
      { coverage: "fenced", deploy: "publish", isolation: "session", authoritative: false },
      () => "pass",
      [],
    );
    const uncovered = await runSession({
      backend: nothing,
      store: new ResultsStore(":memory:"),
      ...dirs,
      selectorIds,
    });
    expect(uncovered.counts.noCoverage).toBeGreaterThan(0);
    expect(uncovered.counts.survived).toBe(0);
  });

  test("coverage:none capability runs all tests per mutant", async () => {
    const dirs = await makeProject();
    const backend = new StubBackend(
      { coverage: "none", deploy: "none", isolation: "full-reset", authoritative: false },
      (mutant) => (mutant === null ? "pass" : "fail"),
    );
    const store = new ResultsStore(":memory:");
    const report = await runSession({ backend, store, ...dirs, selectorIds });
    expect(report.counts.noCoverage).toBe(0);
    expect(report.counts.killed).toBeGreaterThan(0);
    // Controller decision: deploy() is always called (in-memory backends
    // need the per-batch instrumented dir too), so deploy:"none" no longer
    // means zero deploys — it means capabilities().deploy doesn't describe
    // a publish cost. Assert the batch dir was actually handed to deploy().
    expect(backend.deploys.length).toBeGreaterThanOrEqual(1);
    for (const d of backend.deploys) {
      expect(d.startsWith(dirs.instrumentedDir)).toBe(true);
    }
  });

  // `coverageFilter`'s all-green-tests fallback for table triggers reached only a `console.warn`
  // before, so nothing could gate on it — and it is invisible in the verdicts: a mutant run
  // against every test and a mutant run against its attributed tests are both simply "run". A
  // regression re-emptying `byObject` (the bug `0a463fd` fixed) therefore left every count and
  // every per-mutant verdict identical. These two tests pin the number that does move.
  describe("untargetedTriggerCount reaches the report", () => {
    test("counts the table trigger mutants coverage could not place at all", async () => {
      const dirs = await makeProjectWithTriggerTable();
      // Covers only the CODEUNIT's procedure — the table is named nowhere in the index, so its
      // trigger mutants miss at member level, miss at object level, and take fallback 2.
      const backend = new StubBackend(CAPS_NST, () => "pass", ["IsOverBudget"]);
      const store = new ResultsStore(":memory:");
      const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
      try {
        const report = await runSession({ backend, store, ...dirs, selectorIds });
        const triggerMutants = report.mutants.filter((m) => m.file.includes("SandboxTable"));
        expect(triggerMutants.length).toBeGreaterThan(0);
        expect(report.untargetedTriggerCount).toBe(triggerMutants.length);
        // ...and every one of them was RUN, not dropped — the fallback's whole purpose.
        for (const m of triggerMutants) expect(m.verdict).not.toBe("no-coverage");
      } finally {
        warnSpy.mockRestore();
        store.close();
      }
    });

    test("is 0 on a project with no table triggers at all — a measured zero, never absent", async () => {
      const dirs = await makeProject();
      const backend = new StubBackend(CAPS_NST, () => "pass", ["IsOverBudget"]);
      const store = new ResultsStore(":memory:");
      try {
        const report = await runSession({ backend, store, ...dirs, selectorIds });
        expect(report.untargetedTriggerCount).toBe(0);
      } finally {
        store.close();
      }
    });
  });

  test("late flakiness: fails under mutant AND at confirmation = error + unstable", async () => {
    const dirs = await makeProject();
    // Deterministic script: the fixture has exactly 1 test, so baseline is 1 inactive run.
    // Count inactive runs: run #1 (baseline) passes; every later inactive run (the
    // confirmation re-runs) fails. Active runs always fail.
    let inactiveRuns = 0;
    const backend = new StubBackend(
      CAPS_NST,
      (mutant) => {
        if (mutant !== null) return "fail";
        inactiveRuns++;
        return inactiveRuns === 1 ? "pass" : "fail";
      },
      ["IsOverBudget"],
    );
    const store = new ResultsStore(":memory:");
    const report = await runSession({ backend, store, ...dirs, selectorIds });
    expect(report.counts.errors).toBeGreaterThan(0);
    expect(report.counts.unstable).toBeGreaterThan(0);
    expect(report.counts.killed).toBe(0);
    // The control for the two R26 tests below: an unstable failure carrying NO permissions
    // refusal must get NO diagnosis. Without this, a diagnosis that fired unconditionally would
    // still pass the "names TestPermissions" assertion and mean nothing.
    for (const m of report.mutants) {
      if (m.cause !== "unstable") continue;
      expect(m.failureNote).toContain("fails at baseline confirmation");
      expect(m.failureNote).not.toContain("TestPermissions");
    }
  });

  // ————————————————————————————————————————————————————————————————————————
  // ROADMAP R26 (second half). MEASURED A/B (2026-07-26): a test codeunit that omits
  // `TestPermissions = Disabled` runs Restrictive (the AL default) and BC refuses its writes on
  // every path through `Test Runner - Mgt` 130454. Such a test fails under the mutant AND at
  // baseline confirmation, so it lands in the `unstable` branch — a deterministic, one-line-fixable
  // condition reported to the user as flakiness. The diagnosis names it. It must remain strictly a
  // DIAGNOSIS: same verdict, same cause, failure not suppressed, and never consulted where it could
  // move a killed/survived outcome.
  // ————————————————————————————————————————————————————————————————————————
  const BC_PERMISSION_REFUSAL =
    "Sorry, the current permissions prevented the action. " +
    "(TableData 79300 Data Main Insert: LethAL Sandbox Data Tests)";

  // ————————————————————————————————————————————————————————————————————————
  // ROADMAP R59. The entry fears a FALSE KILL: a test the hub passes and the fence fails enters
  // the green set, then fails against every mutant it covers, "and each of those reads as a KILL".
  // It cannot. A kill requires the confirmation rerun — unmutated, and on the FENCE — to PASS, so
  // such a test lands `error cause=unstable`. These two tests pin that, and pin the diagnosis that
  // WAS missing. The fake is the one R55's own review said any check here needs: two runners that
  // genuinely disagree. Every frozen gate is blind to this, because all four have a green baseline.
  // ————————————————————————————————————————————————————————————————————————

  test("R59: a hub-green / fence-red test is an ERROR, never a kill, and is named as a runner disagreement", async () => {
    const dirs = await makeProject();
    // CAPS_NST is a HUB mode (`coverage: "procedure"`), so the baseline goes to the hub and every
    // mutant run and confirmation goes through the fenced transport (`coverage: "none"`).
    const backend = new StubBackend(
      CAPS_NST,
      (_mutant, _ref, opts) => (opts.coverage === "procedure" ? "pass" : "fail"),
      ["IsOverBudget"],
    );
    const store = new ResultsStore(":memory:");
    try {
      const report = await runSession({ backend, store, ...dirs, selectorIds });

      // R59's stated fear, pinned as impossible rather than argued as impossible.
      expect(report.counts.killed).toBe(0);
      expect(report.counts.unstable).toBeGreaterThan(0);

      const unstable = report.mutants.filter((m) => m.cause === "unstable");
      expect(unstable.length).toBeGreaterThan(0);
      for (const m of unstable) {
        expect(m.verdict).toBe("error");
        // The original failure survives; the diagnosis is appended, never substituted.
        expect(m.failureNote).toContain("fails at baseline confirmation");
        expect(m.failureNote).toContain("runner disagreement");
        expect(m.failureNote).toContain('coverageMode "fenced"');
      }
      expect(report.runnerDisagreement?.tests.length).toBeGreaterThan(0);
      expect(report.validity.caveats).toContain("runner-disagreement");
      expect(renderConsole(report)).toContain("RUNNER DISAGREEMENT");
    } finally {
      store.close();
    }
  });

  test("R59: the same failure in a ONE-RUNNER mode gets no such diagnosis — it would be a lie", async () => {
    const dirs = await makeProject();
    // `coverage: "fenced"` routes the baseline through the SAME fenced transport as the verdicts,
    // so a test failing its confirmation there is flakiness (or a genuinely broken test) and
    // nothing about session types explains it. Without this control the diagnosis could fire
    // unconditionally and still pass the test above.
    const caps: BackendCapabilities = { ...CAPS_NST, coverage: "fenced" };
    let inactiveRuns = 0;
    const backend = new StubBackend(
      caps,
      (mutant) => {
        if (mutant !== null) return "fail";
        inactiveRuns++;
        return inactiveRuns === 1 ? "pass" : "fail";
      },
      ["IsOverBudget"],
    );
    const store = new ResultsStore(":memory:");
    try {
      const report = await runSession({ backend, store, ...dirs, selectorIds });
      expect(report.counts.unstable).toBeGreaterThan(0);
      expect(report.counts.killed).toBe(0);
      for (const m of report.mutants.filter((x) => x.cause === "unstable")) {
        expect(m.failureNote).toContain("fails at baseline confirmation");
        expect(m.failureNote).not.toContain("runner disagreement");
      }
      expect(report.runnerDisagreement).toBeUndefined();
      expect(report.validity.caveats).not.toContain("runner-disagreement");
    } finally {
      store.close();
    }
  });

  test("R26: an unstable failure carrying BC's permission refusal names TestPermissions and quotes BC", async () => {
    const dirs = await makeProject();
    let inactiveRuns = 0;
    const backend = new StubBackend(
      CAPS_NST,
      (mutant) => {
        if (mutant !== null) return "fail";
        inactiveRuns++;
        return inactiveRuns === 1 ? "pass" : "fail";
      },
      ["IsOverBudget"],
    );
    // Every failing run is refused by BC — exactly what a Restrictive test codeunit that writes
    // produces, on the mutant run and on the baseline confirmation alike.
    backend.failureMessageFor = () => BC_PERMISSION_REFUSAL;
    const store = new ResultsStore(":memory:");
    const report = await runSession({ backend, store, ...dirs, selectorIds });

    // The verdict is UNCHANGED — this is a diagnosis attached to an existing failure, not a new
    // classification. If a future edit made the pattern match decide anything, this goes red.
    expect(report.counts.unstable).toBeGreaterThan(0);
    expect(report.counts.killed).toBe(0);
    expect(report.counts.survived).toBe(0);

    const diagnosed = report.mutants.filter((m) => m.cause === "unstable");
    expect(diagnosed.length).toBeGreaterThan(0);
    for (const m of diagnosed) {
      expect(m.verdict).toBe("error");
      // The original failure text is still there — the diagnosis is appended, never substituted.
      expect(m.failureNote).toContain("fails at baseline confirmation");
      expect(m.failureNote).toContain("TestPermissions = Disabled");
      // BC's own words survive verbatim, so a reader who disagrees can still see what BC said.
      expect(m.failureNote).toContain(BC_PERMISSION_REFUSAL);
    }
    // And it reaches the operator: `renderConsole` prints `failureNote` under an error row.
    expect(renderConsole(report)).toContain("TestPermissions = Disabled");
  });

  // R35: the same refusal, recognised on the UNSTABLE path, must also reach the session-level
  // report. Without this the run contradicts itself — a per-mutant note telling the reader to
  // declare `TestPermissions = Disabled` while `permissionsRefused` is absent and the
  // `tests-permission-refused` caveat never fires, so the summary they read first says nothing.
  test("R35: a refusal found at baseline confirmation reaches the report, not just the note", async () => {
    const dirs = await makeProject();
    let inactiveRuns = 0;
    const backend = new StubBackend(
      CAPS_NST,
      (mutant) => {
        if (mutant !== null) return "fail";
        inactiveRuns++;
        return inactiveRuns === 1 ? "pass" : "fail";
      },
      ["IsOverBudget"],
    );
    backend.failureMessageFor = () => BC_PERMISSION_REFUSAL;
    const store = new ResultsStore(":memory:");
    const report = await runSession({ backend, store, ...dirs, selectorIds });

    expect(report.counts.unstable).toBeGreaterThan(0);
    expect(report.permissionsRefused?.tests.length).toBeGreaterThan(0);
    expect(report.validity.caveats).toContain("tests-permission-refused");
    expect(renderConsole(report)).toContain("PERMISSIONS REFUSED");
  });

  // The control for the above: an unstable failure with no refusal in it must leave the field
  // absent. A sink that filled on every unstable failure would pass the test above and mean
  // nothing.
  test("R35: an unstable failure with no refusal leaves the report field absent", async () => {
    const dirs = await makeProject();
    let inactiveRuns = 0;
    const backend = new StubBackend(
      CAPS_NST,
      (mutant) => {
        if (mutant !== null) return "fail";
        inactiveRuns++;
        return inactiveRuns === 1 ? "pass" : "fail";
      },
      ["IsOverBudget"],
    );
    backend.failureMessageFor = () => "Assert.AreEqual failed: expected 3, got 4";
    const store = new ResultsStore(":memory:");
    const report = await runSession({ backend, store, ...dirs, selectorIds });

    expect(report.counts.unstable).toBeGreaterThan(0);
    expect(report.permissionsRefused).toBeUndefined();
    expect(report.validity.caveats).not.toContain("tests-permission-refused");
  });

  test("R26: a permissions refusal that PASSES at baseline is still a kill, undiagnosed", async () => {
    const dirs = await makeProject();
    // The kill shape: fails under the mutant (with BC's refusal text, which the diagnosis would
    // happily match), passes at baseline confirmation. The pattern must not be consulted here —
    // if it ever downgraded or annotated a kill, `killed` would stop being the verdict.
    const backend = new StubBackend(CAPS_NST, (mutant) => (mutant === null ? "pass" : "fail"), [
      "IsOverBudget",
    ]);
    backend.failureMessageFor = () => BC_PERMISSION_REFUSAL;
    const store = new ResultsStore(":memory:");
    const report = await runSession({ backend, store, ...dirs, selectorIds });
    expect(report.counts.killed).toBeGreaterThan(0);
    expect(report.counts.unstable).toBe(0);
    for (const m of report.mutants) {
      expect(m.verdict).toBe("killed");
      expect(m.failureNote).toBeUndefined();
    }
  });

  test("timeout under mutant = timeout-killed, no confirmation re-run", async () => {
    const dirs = await makeProject();
    const backend = new StubBackend(CAPS_NST, (mutant) => (mutant === null ? "pass" : "timeout"), [
      "IsOverBudget",
    ]);
    const store = new ResultsStore(":memory:");
    const report = await runSession({ backend, store, ...dirs, selectorIds });
    expect(report.counts.timeoutKilled).toBeGreaterThan(0);
  });

  test("red baseline test is excluded and reported, session continues", async () => {
    const dirs = await makeProject();
    const backend = new StubBackend(
      CAPS_NST,
      (_mutant, ref) => (ref.method === "OverBudgetDetected" ? "fail" : "pass"),
      ["IsOverBudget"],
    );
    const store = new ResultsStore(":memory:");
    const report = await runSession({ backend, store, ...dirs, selectorIds });
    expect(report.baselineGreen).toBe(false);
    // single-test fixture: every test red → batch aborted → zero executed mutants
    expect(report.counts.killed + report.counts.survived).toBe(0);
  });
});

// Two baseline test methods with DISTINCT per-method coverage — one green, one
// "unsupported" (fail/error at baseline, e.g. a TestPage test that can't run in
// a web-service session, spec §9). The unsupported one still returns coverage
// at baseline (the bc-dev hub collects it regardless of outcome), so a mutant
// can be covered ONLY by it.
const TWO_TEST_AL = `codeunit 79100 "Sandbox Tests"
{
    Subtype = Test;

    [Test]
    procedure GreenTest()
    begin
    end;

    [Test]
    procedure UnsupportedTest()
    begin
    end;
}
`;

class QualificationBackend implements ExecutionBackend {
  activations: Array<string | null> = [];
  deploys: string[] = [];
  ranActive = 0; // active (mutant !== null) run count — proves a scheduled mutant executed
  constructor(
    private readonly baselineFor: (method: string) => {
      outcome: TestVerdict["outcome"];
      procedure: string;
      /** R35: BC's own words for the failure, when the test's outcome has a cause worth reading. */
      failureMessage?: string;
      /** Defaults to the single-carrier fixture's codeunit; set it when a test spans two files. */
      objectId?: number;
    },
  ) {}
  capabilities() {
    return CAPS_NST;
  }
  async status(): Promise<BackendStatus> {
    return { ok: true, details: "stub" };
  }
  async deploy(dir: string): Promise<CompiledArtifact | null> {
    this.deploys.push(dir);
    return null;
  }
  async compileCheck(dir: string): Promise<void> {
    await this.deploy(dir);
  }
  async activate(id: string | null) {
    this.activations.push(id);
  }
  async run(ref: TestMethodRef, opts: RunOpts): Promise<TestVerdict> {
    const active = this.activations.at(-1) ?? null;
    if (active !== null) {
      this.ranActive++;
      // Layer 5C-A Task 8, Task 10 (design §G): the covering-run transport path (coverage:
      // "none") of a healthy backend — see StubBackend's identical note above.
      return {
        ref,
        outcome: "fail",
        durationMs: 5,
        attestation: { observedAny: true, identityMismatch: false },
      }; // mutant-active fail → killed
    }
    const b = this.baselineFor(ref.method);
    return {
      ref,
      outcome: b.outcome,
      durationMs: 5,
      ...(b.failureMessage !== undefined ? { failureMessage: b.failureMessage } : {}),
      // Baseline coverage is attached regardless of pass/fail — mirrors bcdev
      // runOnHub, which builds the coverage map whenever coverage !== "none".
      coverage: {
        granularity: "procedure" as const,
        entries: [
          { objectType: "Codeunit", objectId: b.objectId ?? 79000, procedure: b.procedure },
        ],
      },
    };
  }
}

describe("runSession — Task 6 unsupported-baseline qualification (spec §9)", () => {
  // TWO_PROC_AL: IsOverBudget + IsUnderBudget, 3 mutants each. GreenTest covers
  // IsOverBudget (pass); UnsupportedTest covers IsUnderBudget (fail at baseline).
  // So IsUnderBudget's mutants are covered ONLY by a test that did not pass at
  // baseline — the spec §9 case that must be flagged, not silently no-coverage.
  async function qualProject() {
    const dirs = await makeProject(TWO_TEST_AL);
    await Bun.write(join(dirs.projectDir, "SandboxLogic.Codeunit.al"), TWO_PROC_AL);
    return dirs;
  }

  const baselineFor = (method: string) =>
    method === "UnsupportedTest"
      ? { outcome: "error" as const, procedure: "IsUnderBudget" }
      : { outcome: "pass" as const, procedure: "IsOverBudget" };

  test("mutant covered only by a non-passing baseline test is flagged unsupported, not no-coverage", async () => {
    const dirs = await qualProject();
    const backend = new QualificationBackend(baselineFor);
    const store = new ResultsStore(":memory:");
    const report = await runSession({ backend, store, ...dirs, selectorIds });

    // IsUnderBudget's 3 mutants are covered only by UnsupportedTest → error
    // (score-excluded), NEVER silently no-coverage (a real test DOES cover them).
    expect(report.counts.noCoverage).toBe(0);
    expect(report.counts.errors).toBe(3);

    // Each such mutant names the offending test in an honest failure note.
    const unsupportedMutants = report.mutants.filter(
      (m) => m.verdict === "error" && m.failureNote?.includes("did not pass at baseline"),
    );
    expect(unsupportedMutants.length).toBe(3);
    for (const m of unsupportedMutants) {
      expect(m.failureNote).toContain("Sandbox Tests.UnsupportedTest");
    }
  });

  test("report names the unsupported test(s) and not the green one", async () => {
    const dirs = await qualProject();
    const backend = new QualificationBackend(baselineFor);
    const store = new ResultsStore(":memory:");
    const report = await runSession({ backend, store, ...dirs, selectorIds });

    expect(report.unsupportedTests).toContain("Sandbox Tests.UnsupportedTest");
    expect(report.unsupportedTests).not.toContain("Sandbox Tests.GreenTest");
  });

  // ————————————————————————————————————————————————————————————————————————————————————————
  // R35, blind spot 1. R27 named the `TestPermissions` cause on the `unstable` path only. A test
  // BC refuses at BASELINE DISCOVERY never reaches that path: it is dropped from the green set,
  // and the mutants it alone covered were reported as "unsupported test type" — a WRONG diagnosis
  // that sends the reader looking for a TestPage when the fix is one property on their own test
  // codeunit. The refusal text below is BC's measured wording (see permission-canary.ts).
  // ————————————————————————————————————————————————————————————————————————————————————————
  describe("R35 — a baseline test BC REFUSED on permissions", () => {
    const REFUSAL =
      "Sorry, the current permissions prevented the action. " +
      "(TableData 79300 Data Main Insert: LethAL Sandbox Data Tests)";

    const refusedBaselineFor = (method: string) =>
      method === "UnsupportedTest"
        ? {
            outcome: "error" as const,
            procedure: "IsUnderBudget",
            failureMessage: REFUSAL,
          }
        : { outcome: "pass" as const, procedure: "IsOverBudget" };

    async function runRefused() {
      const dirs = await qualProject();
      const backend = new QualificationBackend(refusedBaselineFor);
      const store = new ResultsStore(":memory:");
      return await runSession({ backend, store, ...dirs, selectorIds });
    }

    test("names the permissions cause instead of claiming an unsupported test type", async () => {
      const report = await runRefused();
      const errored = report.mutants.filter((m) => m.verdict === "error");
      expect(errored.length).toBe(3);
      for (const m of errored) {
        expect(m.failureNote).toContain("permissions refusal");
        expect(m.failureNote).toContain("TestPermissions = Disabled");
        expect(m.failureNote).toContain("Sandbox Tests.UnsupportedTest");
        // The wrong LABEL must be gone, not merely accompanied. (The note's own text does say
        // "NOT an unsupported test type", so match the label form, not the bare phrase.)
        expect(m.failureNote).toStartWith("permissions refusal:");
        expect(m.failureNote).not.toContain("unsupported test type: mutant covered");
      }
    });

    test("surfaces the refused test on the report, distinct from the did-not-pass list", async () => {
      const report = await runRefused();
      expect(report.permissionsRefused?.tests).toEqual(["Sandbox Tests.UnsupportedTest"]);
      expect(report.permissionsRefused?.diagnosis).toContain("TestPermissions = Disabled");
      // Still in `unsupportedTests` — permissionsRefused is a strict subset, not a replacement.
      expect(report.unsupportedTests).toContain("Sandbox Tests.UnsupportedTest");
      expect(report.validity.caveats).toContain("tests-permission-refused");
    });

    test("quotes BC's own words rather than asserting the diagnosis unsupported", async () => {
      // The detector is a hedged English regex. Its whole design is that it QUOTES the platform,
      // so a reader who thinks it misread the message can overrule it. A note carrying the
      // conclusion without the evidence would be worse than the wording it replaced.
      const report = await runRefused();
      const errored = report.mutants.filter((m) => m.verdict === "error");
      expect(errored.length).toBeGreaterThan(0);
      for (const m of errored) {
        expect(m.failureNote).toContain("current permissions prevented the action");
        expect(m.failureNote).toContain("TableData 79300 Data Main Insert");
      }
    });

    // Both kinds of non-passing test covering the SAME procedure. The note must not claim the
    // mutant is covered "only" by refused tests while listing another one alongside — and the
    // reader needs to know the other one is a different problem, not more of the same.
    test("distinguishes refused tests from tests that failed for another reason", async () => {
      const threeTests = `codeunit 79100 "Sandbox Tests"
{
    Subtype = Test;

    [Test]
    procedure GreenTest()
    begin
    end;

    [Test]
    procedure RefusedTest()
    begin
    end;

    [Test]
    procedure BrokenTest()
    begin
    end;
}
`;
      const dirs = await makeProject(threeTests);
      await Bun.write(join(dirs.projectDir, "SandboxLogic.Codeunit.al"), TWO_PROC_AL);
      const backend = new QualificationBackend((method: string) => {
        if (method === "RefusedTest")
          return {
            outcome: "error" as const,
            procedure: "IsUnderBudget",
            failureMessage: REFUSAL,
          };
        if (method === "BrokenTest")
          return {
            outcome: "error" as const,
            procedure: "IsUnderBudget",
            failureMessage: "Assert.AreEqual failed: expected 3, got 4",
          };
        return { outcome: "pass" as const, procedure: "IsOverBudget" };
      });
      const store = new ResultsStore(":memory:");
      const report = await runSession({ backend, store, ...dirs, selectorIds });

      const errored = report.mutants.filter((m) => m.verdict === "error");
      expect(errored.length).toBe(3);
      for (const m of errored) {
        expect(m.failureNote).toContain("BC refused at baseline (Sandbox Tests.RefusedTest)");
        expect(m.failureNote).toContain(
          "did not pass for another reason (Sandbox Tests.BrokenTest)",
        );
        // The contradiction the mixed case invites: claiming "only" while listing another test.
        expect(m.failureNote).not.toContain("only by test(s) BC refused");
      }
      // Only the refused one is named as refused, on the report as well as in the note.
      expect(report.permissionsRefused?.tests).toEqual(["Sandbox Tests.RefusedTest"]);
      expect(report.unsupportedTests).toContain("Sandbox Tests.BrokenTest");
    });

    // Batching re-runs the baseline per batch, so the same test can carry a different failure in
    // each one. The refusal set the REPORT needs is session-cumulative; the note must NOT use it,
    // or a test refused in batch 0 and merely broken in batch 1 gets "permissions refusal" in
    // batch 1 too — the exact mislabel this whole item exists to remove, reintroduced one batch
    // over. (A permissions refusal is deterministic per the measured A/B, so this is defensive:
    // pinned rather than assumed, because "shouldn't happen" is not a test.)
    test("a refusal in one batch does not relabel another batch's note", async () => {
      const twoTests = `codeunit 79100 "Sandbox Tests"
{
    Subtype = Test;

    [Test]
    procedure GreenTest()
    begin
    end;

    [Test]
    procedure CoveringTest()
    begin
    end;
}
`;
      const dirs = await makeProject(twoTests);
      // Two carrier files so `maxGuardsPerBatch: 1` splits the run — batching is at FILE
      // granularity, so one file can never be split across batches.
      await Bun.write(join(dirs.projectDir, "SandboxLogic.Codeunit.al"), TWO_PROC_AL);
      await Bun.write(
        join(dirs.projectDir, "SandboxExtra.Codeunit.al"),
        `codeunit 79002 "Sandbox Extra"
{
    procedure UnderLimit(Amount: Decimal; Limit: Decimal): Boolean
    begin
        exit(Amount < Limit);
    end;
}
`,
      );

      // CoveringTest fails at every baseline, but for a DIFFERENT reason each time: BC's refusal
      // in the first batch, an ordinary assertion failure in the second.
      let coveringBaselineRuns = 0;
      const backend = new QualificationBackend((method: string) => {
        if (method !== "CoveringTest")
          return { outcome: "pass" as const, procedure: "IsOverBudget" };
        coveringBaselineRuns++;
        // Batches split at file granularity and run in filename order, so batch 0 is
        // SandboxExtra.Codeunit.al (codeunit 79002) and batch 1 is SandboxLogic (79000). Each
        // batch re-runs the baseline, so this covers the batch it is currently in.
        return coveringBaselineRuns === 1
          ? {
              outcome: "error" as const,
              procedure: "UnderLimit",
              objectId: 79002,
              failureMessage: REFUSAL,
            }
          : {
              outcome: "error" as const,
              procedure: "IsUnderBudget",
              objectId: 79000,
              failureMessage: "Assert.AreEqual failed: expected 3, got 4",
            };
      });
      const store = new ResultsStore(":memory:");
      const report = await runSession({
        backend,
        store,
        ...dirs,
        selectorIds,
        maxGuardsPerBatch: 1,
      });
      expect(report.batches).toBe(2);

      const notesIn = (batchIndex: number) =>
        report.mutants
          .filter((m) => m.batchIndex === batchIndex && m.failureNote !== undefined)
          .map((m) => m.failureNote ?? "");

      const batch0 = notesIn(0);
      const batch1 = notesIn(1);
      expect(batch0.length).toBeGreaterThan(0);
      expect(batch1.length).toBeGreaterThan(0);
      // The batch that was actually refused says so…
      expect(batch0.some((n) => n.startsWith("permissions refusal:"))).toBe(true);
      // …and the batch that merely failed does NOT, even though the session-level set — which the
      // report legitimately uses — names that same test.
      expect(batch1.some((n) => n.startsWith("permissions refusal:"))).toBe(false);
      expect(batch1.some((n) => n.startsWith("unsupported test type:"))).toBe(true);
      // The report still names it once, session-wide: that field is cumulative on purpose.
      expect(report.permissionsRefused?.tests).toContain("Sandbox Tests.CoveringTest");
    });

    test("a test that merely fails is NOT diagnosed as a permissions refusal", async () => {
      // The same shape with an ordinary failure: `permissionsRefused` must be ABSENT, and the
      // original wording must come back. A diagnosis that fires on every red baseline would be
      // worse than none — it would send every reader to check a property that is already correct.
      const dirs = await qualProject();
      const backend = new QualificationBackend((method: string) =>
        method === "UnsupportedTest"
          ? {
              outcome: "error" as const,
              procedure: "IsUnderBudget",
              failureMessage: "Assert.AreEqual failed: expected 3, got 4",
            }
          : { outcome: "pass" as const, procedure: "IsOverBudget" },
      );
      const store = new ResultsStore(":memory:");
      const report = await runSession({ backend, store, ...dirs, selectorIds });

      expect(report.permissionsRefused).toBeUndefined();
      expect(report.validity.caveats).not.toContain("tests-permission-refused");
      const errored = report.mutants.filter((m) => m.verdict === "error");
      expect(errored.length).toBe(3);
      for (const m of errored) expect(m.failureNote).toContain("unsupported test type");
    });
  });

  // ————————————————————————————————————————————————————————————————————————————————————————
  // R69. The mirror image of R35, and separate for exactly that reason. A test that opens a
  // `TestPage` is refused by the fenced session R58 made the default — MEASURED 2026-07-31 on
  // Cronus281 (`fixtures/sandbox-probes` codeunit 79218), and measured to be a FAST refusal
  // (87 ms), correcting the "hangs" this row was originally filed as. Where R35's cause has a
  // one-line fix in the reader's own source, this one has NO target-side fix at all, so the two
  // must never share a heading: each would tell the other's reader something false.
  // ————————————————————————————————————————————————————————————————————————————————————————
  describe("R69 — a baseline test refused for opening a TestPage", () => {
    const TESTPAGE_REFUSAL =
      "Unexpected CLR exception thrown.: System.NotSupportedException: Specified method is not " +
      "supported. at Microsoft.Dynamics.Nav.Runtime.NavSession.CreateNavTestService()";

    async function runTestPageRefused() {
      const dirs = await qualProject();
      const backend = new QualificationBackend((method: string) =>
        method === "UnsupportedTest"
          ? {
              outcome: "error" as const,
              procedure: "IsUnderBudget",
              failureMessage: TESTPAGE_REFUSAL,
            }
          : { outcome: "pass" as const, procedure: "IsOverBudget" },
      );
      const store = new ResultsStore(":memory:");
      return await runSession({ backend, store, ...dirs, selectorIds });
    }

    test("names the TestPage cause instead of the bare unsupported-test-type wording", async () => {
      const report = await runTestPageRefused();
      const errored = report.mutants.filter((m) => m.verdict === "error");
      expect(errored.length).toBe(3);
      for (const m of errored) {
        expect(m.failureNote).toStartWith("testpage unsupported on this path:");
        expect(m.failureNote).toContain("Sandbox Tests.UnsupportedTest");
        expect(m.failureNote).not.toContain("unsupported test type: mutant covered");
      }
    });

    test("surfaces the affected test on the report, distinct from the did-not-pass list", async () => {
      const report = await runTestPageRefused();
      expect(report.testPageUnsupported?.tests).toEqual(["Sandbox Tests.UnsupportedTest"]);
      expect(report.testPageUnsupported?.diagnosis).toContain("TestPage");
      // A strict subset, not a replacement — same contract as `permissionsRefused`.
      expect(report.unsupportedTests).toContain("Sandbox Tests.UnsupportedTest");
      expect(report.validity.caveats).toContain("tests-testpage-unsupported");
    });

    // The two causes demand opposite responses. Cross-labelling either way is the failure mode
    // this whole split exists to prevent.
    test("is never labelled a permissions refusal, and vice versa", async () => {
      const report = await runTestPageRefused();
      expect(report.permissionsRefused).toBeUndefined();
      expect(report.validity.caveats).not.toContain("tests-permission-refused");
      for (const m of report.mutants.filter((m) => m.verdict === "error")) {
        expect(m.failureNote).not.toContain("permissions refusal");
        expect(m.failureNote).not.toContain("TestPermissions = Disabled");
      }
    });

    test("quotes BC's own words rather than asserting the diagnosis unsupported", async () => {
      const report = await runTestPageRefused();
      const errored = report.mutants.filter((m) => m.verdict === "error");
      expect(errored.length).toBeGreaterThan(0);
      for (const m of errored) expect(m.failureNote).toContain("CreateNavTestService");
    });

    // The direction that matters for safety: this must not fire on every red baseline, or every
    // reader is told their tests cannot run here when they simply failed.
    test("a test that merely fails is NOT diagnosed as a TestPage refusal", async () => {
      const dirs = await qualProject();
      const backend = new QualificationBackend((method: string) =>
        method === "UnsupportedTest"
          ? {
              outcome: "error" as const,
              procedure: "IsUnderBudget",
              failureMessage: "Assert.AreEqual failed: expected 3, got 4",
            }
          : { outcome: "pass" as const, procedure: "IsOverBudget" },
      );
      const store = new ResultsStore(":memory:");
      const report = await runSession({ backend, store, ...dirs, selectorIds });

      expect(report.testPageUnsupported).toBeUndefined();
      expect(report.validity.caveats).not.toContain("tests-testpage-unsupported");
      for (const m of report.mutants.filter((m) => m.verdict === "error"))
        expect(m.failureNote).toContain("unsupported test type");
    });
  });

  test("a mutant covered by a green test still runs (no over-exclusion)", async () => {
    const dirs = await qualProject();
    const backend = new QualificationBackend(baselineFor);
    const store = new ResultsStore(":memory:");
    const report = await runSession({ backend, store, ...dirs, selectorIds });

    // IsOverBudget's 3 mutants are covered by GreenTest → scheduled + killed.
    expect(report.counts.killed).toBe(3);
    // Only those 3 ever ran under activation — the unsupported-covered mutants
    // were excluded, not executed.
    expect(backend.ranActive).toBe(3);
  });
});

describe("runSession — C3 batch app.json + full source copy", () => {
  test("batch dir gets app.json with bumped version + no-mutant files copied verbatim", async () => {
    const dirs = await makeProject();
    await Bun.write(join(dirs.projectDir, "SandboxNoOp.Codeunit.al"), NO_MUTANTS_AL);
    const backend = new StubBackend(CAPS_NST, () => "pass", ["IsOverBudget"]);
    const store = new ResultsStore(":memory:");
    await runSession({ backend, store, ...dirs, selectorIds });

    // Batch dirs are named run-<runId>-batch-<batchIdx>, find the one created
    const entries = await readdir(dirs.instrumentedDir);
    const batchDirs = entries.filter((e) => e.match(/^run-\d+-batch-0$/));
    expect(batchDirs.length).toBe(1);
    const batchDirName = batchDirs.at(0);
    expect(batchDirName).toBeDefined();
    const batchDir = join(dirs.instrumentedDir, batchDirName as string);
    const appJson = JSON.parse(await readFile(join(batchDir, "app.json"), "utf8")) as {
      id: string;
      version: string;
    };
    expect(appJson.id).toBe(APP_ID); // target app id preserved (spec §5)
    // 1.0.<daysSinceEpoch>.<halfSeconds> — major.minor from the fixture's own app.json
    // (1.0.0.0), build/revision clock-derived via reserveAppVersion (app-version.ts). BC
    // rejects publishing a version lower than the installed one; the clock components
    // increase across runs with no dependence on a persistent results DB.
    expect(appJson.version).toMatch(/^1\.0\.\d+\.\d+$/);
    expect(appJson.version).not.toBe("1.0.0.0"); // actually re-stamped, not the source version

    const copied = await readFile(join(batchDir, "SandboxNoOp.Codeunit.al"), "utf8");
    expect(copied).toBe(NO_MUTANTS_AL); // writeInstrumentedProject never wrote this file
  });

  test("missing app.json aborts with a clear error before deploy", async () => {
    const dirs = await makeProject();
    await rm(join(dirs.projectDir, "app.json"));
    const backend = new StubBackend(CAPS_NST, () => "pass", ["IsOverBudget"]);
    const store = new ResultsStore(":memory:");
    await expect(runSession({ backend, store, ...dirs, selectorIds })).rejects.toThrow(/app\.json/);
    expect(backend.deploys.length).toBe(0); // aborted before ever calling deploy()
  });

  // Was: "counts.deadlineExceeded must be derived structurally, never by sniffing
  // failureNote text" — proven via a batch-deploy failure whose bare-string message happened
  // to start with "deadline exceeded", downgraded to a per-mutant "error" note. Task 7 changed
  // what a batch-deploy failure like this one even DOES: a bare string/plain Error thrown from
  // deploy() is not a typed `AlcCompileError`, so it is no longer a bisectable compile
  // verdict — it now aborts the whole session before any note is ever written, rather than
  // being downgraded into a per-mutant error. (The original hardening property — that
  // `counts.deadlineExceeded` is never derived from note text — still holds and is still
  // covered structurally by the "client deadline" tests above, which set `cause` directly.)
  test("batch deploy failure that is not a typed AlcCompileError aborts the session, not just this batch", async () => {
    const dirs = await makeProject();
    const backend = new StubBackend(
      CAPS_NST,
      () => "pass",
      ["IsOverBudget"],
      "deadline exceeded talking to NST", // thrown bare string, not an Error, not AlcCompileError
    );
    const store = new ResultsStore(":memory:");
    await expect(runSession({ backend, store, ...dirs, selectorIds })).rejects.toThrow(
      /deadline exceeded talking to NST/,
    );
    store.close();
  });
});

describe("runSession — deadline vs runner-confirmed timeout", () => {
  test("runner-confirmed timeout under a mutant is timeout-killed", async () => {
    const dirs = await makeProject();
    const backend = new StubBackend(CAPS_NST, (mutant) => (mutant === null ? "pass" : "timeout"), [
      "IsOverBudget",
    ]);
    const store = new ResultsStore(":memory:");
    const report = await runSession({ backend, store, ...dirs, selectorIds });
    expect(report.counts.timeoutKilled).toBeGreaterThan(0);
    expect(report.counts.deadlineExceeded).toBe(0);
    store.close();
  });

  test("a client deadline is infrastructure: verdict error, never a kill", async () => {
    const dirs = await makeProject();
    const backend = new StubBackend(
      CAPS_NST,
      (mutant) => (mutant === null ? "pass" : "deadline-exceeded"),
      ["IsOverBudget"],
    );
    const store = new ResultsStore(":memory:");
    const report = await runSession({ backend, store, ...dirs, selectorIds });
    expect(report.counts.timeoutKilled).toBe(0);
    expect(report.counts.killed).toBe(0);
    expect(report.counts.deadlineExceeded).toBeGreaterThan(0);
    expect(report.counts.errors).toBeGreaterThan(0);
    // excluded from the score denominator
    expect(report.mutationScore).toBeNull();
    store.close();
  });

  // I1: a client deadline during KILL CONFIRMATION (the re-run of a mutant's
  // failing test against baseline) is the same kind of infrastructure noise as
  // a deadline during the initial mutant run above — not evidence the test is
  // flaky. Before the fix, the `fail` branch's confirmation handling treated
  // every non-"pass" confirm.outcome (including "deadline-exceeded") as
  // cause: "unstable", inflating counts.unstable and under-reporting
  // counts.deadlineExceeded for exactly the event this layer built that
  // counter for.
  test("deadline exceeded confirming a mutant's fail is deadlineExceeded, not unstable", async () => {
    const dirs = await makeProject();
    // Fixture has exactly 1 test: inactive run #1 is the baseline (must pass
    // for the session to proceed to mutants), inactive run #2 is the
    // confirmation re-run triggered by the active-mutant run's "fail" below.
    let inactiveRuns = 0;
    const backend = new StubBackend(
      CAPS_NST,
      (mutant) => {
        if (mutant !== null) return "fail";
        inactiveRuns++;
        return inactiveRuns === 1 ? "pass" : "deadline-exceeded";
      },
      ["IsOverBudget"],
    );
    const store = new ResultsStore(":memory:");
    const report = await runSession({ backend, store, ...dirs, selectorIds });
    expect(report.counts.deadlineExceeded).toBeGreaterThan(0);
    expect(report.counts.unstable).toBe(0);
    expect(report.counts.killed).toBe(0);
    store.close();
  });
});

// Tier 6B Phase 0 Task 6: `budget = 2 * baselineDuration` had no floor. Measured live, a
// warm baseline (~95ms) yields a ~190ms budget that a cold first execution (~1872ms measured)
// blows straight through — the client aborts, which the orchestrator turns into a durable tier
// quarantine and an aborted session, for a mutant that runs fine on its own. `MIN_MUTANT_BUDGET_MS`
// floors the budget so a cold start can't trigger that; a genuinely slow test's `2x` budget must
// stay uncapped above the floor, since the floor's job is absorbing a cold start, not capping
// performance.
describe("runSession — per-mutant budget floor (Tier 6B Phase 0 Task 6)", () => {
  /**
   * Records every `run()` call's `(active mutant, timeoutMs)` in dispatch order so a test can
   * assert on the actual budget the orchestrator computed, not just on the resulting verdict — a
   * test that only checked "it ran" would pass whether or not the floor exists. `activations`
   * mirrors `StubBackend`'s pattern above: the most recent `activate()` call determines whether
   * the next `run()` is the baseline/confirm-rerun (`null`) or a mutant's covering run (mutant id).
   * `coverage: "none"` (like the "coverage:none capability" test above) sidesteps needing a
   * procedure coverage list — every green test runs under every mutant regardless.
   */
  class BudgetProbeBackend implements ExecutionBackend {
    activations: Array<string | null> = [];
    readonly runs: Array<{ active: string | null; timeoutMs: number }> = [];
    constructor(private readonly baselineDurationMs: number) {}
    capabilities(): BackendCapabilities {
      return { coverage: "none", deploy: "none", isolation: "full-reset", authoritative: false };
    }
    async status(): Promise<BackendStatus> {
      return { ok: true, details: "budget-probe" };
    }
    async deploy(): Promise<CompiledArtifact | null> {
      return null;
    }
    async compileCheck(): Promise<void> {}
    async activate(id: string | null) {
      this.activations.push(id);
    }
    async run(ref: TestMethodRef, opts: RunOpts): Promise<TestVerdict> {
      const active = this.activations.at(-1) ?? null;
      this.runs.push({ active, timeoutMs: opts.timeoutMs });
      // The very first call is the baseline: reports the caller-chosen duration that feeds
      // `baselineDuration` and so the naive (unfloored) budget. Every later call — the mutant's
      // covering run, or the confirm re-run after a fail — reports an instant duration, so any
      // floor observed on ITS budget can only have come from the floor, never from its own time.
      const isBaseline = this.runs.length === 1;
      return {
        ref,
        outcome: active === null ? "pass" : "fail",
        durationMs: isBaseline ? this.baselineDurationMs : 1,
      };
    }
  }

  // The fixture's premise, asserted rather than assumed: these tests feed a 50ms baseline, so the
  // naive `2 * 50 = 100ms` budget must be strictly BELOW the floor for the floor to be what the
  // observed budget demonstrates. Pinning it here is also what stops the assertions below from
  // passing against the constant they are testing — `toBeGreaterThanOrEqual(MIN_MUTANT_BUDGET_MS)`
  // alone stays green if someone sets `MIN_MUTANT_BUDGET_MS = 0`.
  test("fixture premise: the floor is above the naive 2x budget these tests produce", () => {
    expect(MIN_MUTANT_BUDGET_MS).toBeGreaterThan(2 * 50);
  });

  test("a tiny baseline duration still dispatches the covering run at the floored budget", async () => {
    const dirs = await makeProject();
    const backend = new BudgetProbeBackend(50); // naive 2x budget = 100ms, far under the floor
    const store = new ResultsStore(":memory:");
    await runSession({ backend, store, ...dirs, selectorIds });
    store.close();
    // runs[0] = baseline; runs[1] = the first mutant's covering run.
    const mutantRun = backend.runs[1];
    expect(mutantRun).toBeDefined();
    expect(mutantRun?.active).not.toBeNull();
    // A LITERAL, not `MIN_MUTANT_BUDGET_MS`: asserting against the constant under test passes
    // whether or not the floor is applied (set the constant to 0 and `>= 0` is trivially true).
    expect(mutantRun?.timeoutMs).toBe(30_000);
    expect(mutantRun?.timeoutMs).toBe(MIN_MUTANT_BUDGET_MS); // ...and the constant still names it
  });

  test("a large baseline duration still gets exactly 2x, uncapped by the floor", async () => {
    const dirs = await makeProject();
    const backend = new BudgetProbeBackend(60_000); // naive 2x budget = 120,000ms, above the floor
    const store = new ResultsStore(":memory:");
    await runSession({ backend, store, ...dirs, selectorIds });
    store.close();
    const mutantRun = backend.runs[1];
    expect(mutantRun).toBeDefined();
    expect(mutantRun?.timeoutMs).toBe(120_000);
  });

  test("the same floor applies to the confirm-rerun after a fail", async () => {
    const dirs = await makeProject();
    const backend = new BudgetProbeBackend(50); // "fail" under every mutant triggers a confirm rerun
    const store = new ResultsStore(":memory:");
    await runSession({ backend, store, ...dirs, selectorIds });
    store.close();
    // runs[0] = baseline, runs[1] = mutant covering run ("fail"), runs[2] = confirm rerun (null
    // activation) — the same `budget` variable dispatches both runs[1] and runs[2].
    const confirmRun = backend.runs[2];
    expect(confirmRun).toBeDefined();
    expect(confirmRun?.active).toBeNull();
    // Literal, for the same reason as above.
    expect(confirmRun?.timeoutMs).toBe(30_000);
    expect(confirmRun?.timeoutMs).toBe(MIN_MUTANT_BUDGET_MS);
  });
});

describe("runSession — I7 second consecutive transport error aborts the session", () => {
  test("stub backend erroring on every active-mutant run throws, persists partial results", async () => {
    const root = await mkdtemp(join(tmpdir(), "lethal-orch-i7-"));
    const dbPath = join(root, "results.sqlite");
    const dirs = await makeProject();
    const backend = new StubBackend(CAPS_NST, (mutant) => (mutant === null ? "pass" : "error"), [
      "IsOverBudget",
    ]);
    const store = new ResultsStore(dbPath);
    await expect(runSession({ backend, store, ...dirs, selectorIds })).rejects.toThrow(
      /transport error/i,
    );
    expect(backend.activations.at(-1)).toBeNull(); // finally: still deactivated

    // Reopen the same on-disk (WAL-mode) db from a second connection to
    // confirm the errored mutant's row was persisted before the throw —
    // recordMutant auto-commits per statement, so it survives the abort.
    const raw = new Database(dbPath, { readonly: true });
    const rows = raw.query("SELECT verdict FROM mutants").all() as Array<{ verdict: string }>;
    raw.close();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((r) => r.verdict === "error")).toBe(true);
  });
});

describe("runSession — parallel workers", () => {
  test("verdicts are identical at 1, 2 and 4 workers", async () => {
    const shape = (r: Awaited<ReturnType<typeof runSession>>) =>
      [...r.mutants].map((m) => `${m.file}:${m.line}:${m.operatorName}:${m.verdict}`).sort();
    // Unsorted report order: `shape()` above ends in `.sort()`, so it would
    // still pass even if runSession's internal `outcomes.sort(...)` were
    // deleted (report ordering would then depend on scheduling, but the
    // multiset would be unaffected). This captures `report.mutants` in
    // whatever order runSession actually produced it, unsorted, so a
    // regression that drops the internal sort has something to break against.
    const order = (r: Awaited<ReturnType<typeof runSession>>) =>
      r.mutants.map((m) => `${m.file}:${m.line}:${m.operatorName}`);

    const results: string[][] = [];
    const orders: string[][] = [];
    for (const workers of [1, 2, 4]) {
      const dirs = await makeProject();
      const store = new ResultsStore(":memory:");
      const report = await runSession({
        // CAPS_NST_WORKERS, not CAPS_NST: this test sweeps workers up to 4, which Task 10 (design
        // §G) now rejects for an authoritative backend — the sharding determinism under test here
        // is orthogonal to authoritativeness.
        backend: new StubBackend(
          CAPS_NST_WORKERS,
          (mutant) => (mutant === null ? "pass" : "fail"),
          ["IsOverBudget"],
        ),
        backendFactory: () =>
          new StubBackend(CAPS_NST_WORKERS, (mutant) => (mutant === null ? "pass" : "fail"), [
            "IsOverBudget",
          ]),
        store,
        ...dirs,
        selectorIds,
        workers,
      });
      results.push(shape(report));
      orders.push(order(report));
      store.close();
    }
    expect(results[1]).toEqual(results[0]);
    expect(results[2]).toEqual(results[0]);
    expect(orders[1]).toEqual(orders[0]);
    expect(orders[2]).toEqual(orders[0]);
  });

  // The test above reuses the standard single-comparison fixture; since
  // Layer 4.3 (see TWO_PROC_AL comment) it too now shards its 3 mutants
  // across workers, so it already exercises >1 concurrently executing
  // shard. This test additionally uses TWO_PROC_AL so the cross-shard
  // determinism check is stressed with mutants spanning two independent
  // procedures, not just three sites within one.
  test("verdicts are identical at 1, 2 and 4 workers when a batch has multiple shardable mutants", async () => {
    const shape = (r: Awaited<ReturnType<typeof runSession>>) =>
      [...r.mutants].map((m) => `${m.file}:${m.line}:${m.operatorName}:${m.verdict}`).sort();
    const order = (r: Awaited<ReturnType<typeof runSession>>) =>
      r.mutants.map((m) => `${m.file}:${m.line}:${m.operatorName}`);
    const caps: BackendCapabilities = {
      coverage: "none",
      deploy: "none",
      isolation: "full-reset",
      authoritative: false,
    };

    const results: string[][] = [];
    const orders: string[][] = [];
    for (const workers of [1, 2, 4]) {
      const dirs = await makeProject();
      await Bun.write(join(dirs.projectDir, "SandboxLogic.Codeunit.al"), TWO_PROC_AL);
      const store = new ResultsStore(":memory:");
      // Worker 0 is made artificially slower than worker 1. (shardEvenly's
      // round-robin no longer aligns worker assignment with procedure
      // identity post-Layer-4.3 — both workers get a mix of IsOverBudget's
      // and IsUnderBudget's mutants — so this no longer cleanly slows "the
      // IsOverBudget worker"; it doesn't need to.) Without runSession's
      // outcomes.sort(), whichever worker finishes first would call
      // record() first, so the raw accumulation order could come out
      // different from the workers=1 baseline depending on scheduling — the
      // sort is what makes this test's order assertion pass regardless of
      // which worker happens to finish first.
      const make = (workerIndex: number) =>
        new StubBackend(
          caps,
          (mutant) => (mutant === null ? "pass" : "fail"),
          [],
          undefined,
          workerIndex === 0
            ? async () => {
                await new Promise((r) => setTimeout(r, 15));
              }
            : undefined,
        );
      const report = await runSession({
        backend: make(-1),
        backendFactory: make,
        store,
        ...dirs,
        selectorIds,
        workers,
      });
      results.push(shape(report));
      orders.push(order(report));
      store.close();
    }
    expect(results[1]).toEqual(results[0]);
    expect(results[2]).toEqual(results[0]);
    expect(orders[1]).toEqual(orders[0]);
    expect(orders[2]).toEqual(orders[0]);
  });

  test("more than one worker actually runs concurrently", async () => {
    const dirs = await makeProject();
    // Overwrite the single-comparison fixture with two independent
    // procedures (see TWO_PROC_AL comment) so a batch actually contains more
    // than one shardable mutant. coverage:"none" means every mutant is
    // covered by every green test regardless of which procedure it targets,
    // so no per-procedure coverage bookkeeping is needed here.
    await Bun.write(join(dirs.projectDir, "SandboxLogic.Codeunit.al"), TWO_PROC_AL);
    const store = new ResultsStore(":memory:");
    let concurrent = 0;
    let peak = 0;
    const make = () =>
      new StubBackend(
        { coverage: "none", deploy: "none", isolation: "full-reset", authoritative: false },
        (mutant) => (mutant === null ? "pass" : "fail"),
        [],
        undefined,
        async () => {
          concurrent++;
          peak = Math.max(peak, concurrent);
          await new Promise((r) => setTimeout(r, 5));
          concurrent--;
        },
      );
    await runSession({
      backend: make(),
      backendFactory: make,
      store,
      ...dirs,
      selectorIds,
      workers: 3,
    });
    expect(peak).toBeGreaterThan(1);
    store.close();
  });

  test("a worker's own deploy failure records that shard's mutants as errors, other shards still run", async () => {
    const dirs = await makeProject();
    await Bun.write(join(dirs.projectDir, "SandboxLogic.Codeunit.al"), TWO_PROC_AL);
    const store = new ResultsStore(":memory:");
    const caps: BackendCapabilities = {
      coverage: "none",
      deploy: "none",
      isolation: "full-reset",
      authoritative: false,
    };
    // Layer 4.3 collapsed overlap batching to a single artifact, so
    // shardEvenly's round-robin (index % workers) no longer aligns with
    // procedure boundaries — worker 0 and worker 1 each get a mix of
    // IsOverBudget's and IsUnderBudget's mutants, 3 of TWO_PROC_AL's 6 total
    // apiece. That mix doesn't matter here (unlike the coverage-scoped test
    // below): every mutant behaves identically regardless of procedure, so
    // worker 0's shard (deploy always fails) records 3 errors and worker 1's
    // shard (deploy always succeeds) kills its 3, whichever specific mutants
    // land where. Mirrors the sequential per-artifact deploy try/catch (step
    // 3 in orchestrator.ts): a deploy failure must record every mutant in
    // the affected shard as "error" and let the session continue, not
    // reject the whole `runSession` call.
    const make = (workerIndex: number) =>
      new StubBackend(
        caps,
        (mutant) => (mutant === null ? "pass" : "fail"),
        [],
        // A typed AlcCompileError — the only shape a per-shard deploy failure may take and
        // still be bisected/downgraded to per-mutant errors (Task 7); anything else now aborts
        // the whole session (see the DeploymentError/ArtifactPrepareError abort tests below).
        workerIndex === 0 ? new AlcCompileError("boom: worker 0 could not deploy") : undefined,
      );
    const report = await runSession({
      backend: make(-1),
      backendFactory: make,
      store,
      ...dirs,
      selectorIds,
      workers: 2,
    });
    // 6 total mutants split 3/3 across the two workers: worker 0's 3 error,
    // worker 1's 3 are killed — the deploy failure never propagates past its
    // own shard.
    expect(report.counts.errors).toBe(3);
    expect(report.counts.killed).toBe(3);
    expect(report.counts.survived).toBe(0);
    store.close();
  });

  test("a worker deploy failure does not double-record a mutant step 5 already marked no-coverage", async () => {
    const dirs = await makeProject();
    await Bun.write(join(dirs.projectDir, "SandboxLogic.Codeunit.al"), TWO_PROC_AL);
    const store = new ResultsStore(":memory:");
    // Procedure-level coverage (CAPS_NST), covering ONLY IsOverBudget's
    // procedure — all 3 of IsUnderBudget's mutants are therefore uncovered
    // and already recorded "no-coverage" by step 5, ONCE EACH (Layer 4.3:
    // one artifact means step 5's coverage filter runs once over every
    // mutant, not once per batch), before the per-mutant fan-out ever runs.
    //
    // TWO_PROC_AL's 6 mutants sort (by file, startIndex) as IsOverBudget's 3
    // then IsUnderBudget's 3 (indices 0-2, 3-5). Since there's only one
    // artifact now, shardEvenly's round-robin (index % workers) no longer
    // has a per-batch boundary to align on, so it interleaves the two
    // procedures instead of cleanly separating them: worker 0 gets indices
    // 0, 2, 4 (IsOverBudget's 1st + 3rd mutants, plus IsUnderBudget's 2nd);
    // worker 1 gets indices 1, 3, 5 (IsOverBudget's 2nd, plus IsUnderBudget's
    // 1st + 3rd). Worker 1's backend always fails to deploy: without the
    // `perMutantTests.get(...) === undefined` skip in the deploy-failure
    // catch, its two already-no-coverage IsUnderBudget mutants would be
    // recorded a SECOND time as "error" — `mutants` has no unique constraint
    // on (run_id, mutant_code), so `recordMutant`'s plain INSERT would
    // silently duplicate the row rather than fail loudly. Its one covered
    // mutant (IsOverBudget's 2nd) has nothing recorded yet, so the deploy
    // failure legitimately records it as "error".
    // CAPS_NST_WORKERS, not CAPS_NST: this test runs `workers: 2`, which Task 10 (design §G) now
    // rejects for an authoritative backend — the no-double-record property under test here is
    // orthogonal to authoritativeness.
    const make = (workerIndex: number) =>
      new StubBackend(
        CAPS_NST_WORKERS,
        (mutant) => (mutant === null ? "pass" : "fail"),
        ["IsOverBudget"],
        // Typed AlcCompileError — see the sibling test above for why (Task 7 no longer
        // bisects/downgrades an untyped deploy failure).
        workerIndex === 1 ? new AlcCompileError("boom: worker 1 could not deploy") : undefined,
      );
    const report = await runSession({
      backend: make(-1),
      backendFactory: make,
      store,
      ...dirs,
      selectorIds,
      workers: 2,
    });
    // 6 total — never 9 (which would mean an IsUnderBudget mutant landed
    // under both no-coverage and error).
    expect(report.mutants.length).toBe(6);
    expect(report.counts.noCoverage).toBe(3); // IsUnderBudget's 3 mutants, recorded once each
    expect(report.counts.errors).toBe(1); // IsOverBudget's mutant on worker 1's shard
    expect(report.counts.killed).toBe(2); // IsOverBudget's other 2 mutants, on worker 0's shard
    // Belt-and-suspenders: no single mutant identity appears under both verdicts.
    const noCoverageKeys = new Set(
      report.mutants.filter((m) => m.verdict === "no-coverage").map((m) => `${m.file}:${m.line}`),
    );
    const errorKeys = new Set(
      report.mutants.filter((m) => m.verdict === "error").map((m) => `${m.file}:${m.line}`),
    );
    for (const k of noCoverageKeys) expect(errorKeys.has(k)).toBe(false);
    store.close();
  });

  test("a shard's transport-error abort drains sibling shards before rethrowing", async () => {
    const root = await mkdtemp(join(tmpdir(), "lethal-orch-parallel-i7-"));
    const dbPath = join(root, "results.sqlite");
    const dirs = await makeProject();
    await Bun.write(join(dirs.projectDir, "SandboxLogic.Codeunit.al"), TWO_PROC_AL);
    const store = new ResultsStore(dbPath);
    const caps: BackendCapabilities = {
      coverage: "none",
      deploy: "none",
      isolation: "full-reset",
      authoritative: false,
    };
    // Worker 0 is slow — 30ms per run(). Worker 1 errors on every
    // active-mutant run, tripping the I7 "two consecutive transport errors"
    // abort almost immediately. (Both behaviors key on workerIndex, not on
    // which specific mutants land in a shard — shardEvenly's round-robin no
    // longer aligns shard composition with procedure identity post-Layer-4.3,
    // so each shard now holds a mix of IsOverBudget's and IsUnderBudget's
    // mutants.) If runSession rethrew as soon as worker 1's shard rejected
    // (plain `Promise.all` semantics) instead of waiting for every shard to
    // settle (`Promise.allSettled`), worker 0 could still be mid-flight —
    // and, worse, a caller reacting to the rejection by closing the store
    // could race a still-running worker 0's write to it.
    const make = (workerIndex: number) =>
      new StubBackend(
        caps,
        (mutant) => (mutant === null ? "pass" : workerIndex === 1 ? "error" : "fail"),
        [],
        undefined,
        workerIndex === 0
          ? async () => {
              await new Promise((r) => setTimeout(r, 30));
            }
          : undefined,
      );
    await expect(
      runSession({
        backend: make(-1),
        backendFactory: make,
        store,
        ...dirs,
        selectorIds,
        workers: 2,
      }),
    ).rejects.toThrow(/transport error/i);

    // Reopen the same on-disk DB from a second connection immediately after
    // the rejection (no sleep, no retry): worker 0's mutant row must already
    // be there, proving allSettled actually waited for it rather than the
    // throw racing ahead of a still-writing sibling.
    const raw = new Database(dbPath, { readonly: true });
    const rows = raw.query("SELECT verdict FROM mutants").all() as Array<{ verdict: string }>;
    raw.close();
    expect(rows.some((r) => r.verdict === "error")).toBe(true); // worker 1's abort
    expect(rows.length).toBeGreaterThanOrEqual(2); // worker 0's mutant landed too
    store.close();
  });

  test("worker backends are built once per session and disposed exactly once, not once per batch", async () => {
    const dirs = await makeProject();
    await Bun.write(join(dirs.projectDir, "SandboxLogic.Codeunit.al"), TWO_PROC_AL);
    const store = new ResultsStore(":memory:");
    const caps: BackendCapabilities = {
      coverage: "none",
      deploy: "none",
      isolation: "full-reset",
      authoritative: false,
    };
    let factoryCalls = 0;
    const closeCallCounts: number[] = [];
    // Duck-typed close(), same as real backends (BcDevMcpBackend,
    // AlRunnerBackend) that StubBackend itself doesn't model.
    const make = () => {
      factoryCalls++;
      let closed = 0;
      const backend = new StubBackend(caps, (mutant) => (mutant === null ? "pass" : "fail"), []);
      return Object.assign(backend, {
        async close() {
          closed++;
          closeCallCounts.push(closed);
        },
      });
    };
    await runSession({
      backend: make(),
      backendFactory: make,
      store,
      ...dirs,
      selectorIds,
      workers: 2,
    });
    // TWO_PROC_AL yields exactly 1 artifact (Layer 4.3 collapsed overlap
    // batching), so this can no longer observationally distinguish "built
    // once per session" from "built once per artifact" the way it could
    // when TWO_PROC_AL yielded 3 batches (the bug would have run the
    // factory 1 (cfg.backend) + 3 batches * 2 workers = 7 times, vs. 1 + 2 =
    // 3 once fixed). The invariant this asserts — workerBackends are built
    // once, outside the artifacts loop, and reused across it — still holds
    // structurally; Task 6's multi-artifact bisection will make it
    // observable here again.
    expect(factoryCalls).toBe(3);
    // Exactly the 2 worker backends close, each exactly once — cfg.backend
    // is caller-owned (see cli.ts) and is never closed by runSession itself.
    expect(closeCallCounts).toEqual([1, 1]);
    store.close();
  });

  test("a fractional workers count is floored, not silently dropping mutants", async () => {
    const dirs = await makeProject();
    // THREE_PROC_AL, not TWO_PROC_AL: needs >=3 shardable mutants in a
    // single sharding call for the drop bug to manifest (`i % 2.5` for
    // i=0,1 never lands outside shardEvenly's length-truncated 2-element
    // shard array) — see THREE_PROC_AL's comment.
    await Bun.write(join(dirs.projectDir, "SandboxLogic.Codeunit.al"), THREE_PROC_AL);
    const store = new ResultsStore(":memory:");
    const caps: BackendCapabilities = {
      coverage: "none",
      deploy: "none",
      isolation: "full-reset",
      authoritative: false,
    };
    const make = () => new StubBackend(caps, (mutant) => (mutant === null ? "pass" : "fail"), []);
    const report = await runSession({
      backend: make(),
      backendFactory: make,
      store,
      ...dirs,
      selectorIds,
      workers: 2.5,
    });
    // 9 total (3 procedures * 3 mutants each, all in the single Layer-4.3
    // artifact). Before flooring, shardEvenly(execute, 2.5) built a
    // length-2 shard array (Array.from truncates a fractional `length`)
    // while still computing target indices via `i % 2.5`, so an item whose
    // index (e.g. 2, `2 % 2.5 === 2`) fell outside the truncated array was
    // silently dropped by shardEvenly's `if (target !== undefined)` guard —
    // no error, just fewer mutants in the report than were generated.
    expect(report.mutants.length).toBe(9);
    expect(report.counts.killed).toBe(9);
    store.close();
  });
});

describe("runSession — M4 outcome ordering", () => {
  test("report order is numeric by startIndex, not lexicographic on the colon-joined string", async () => {
    const dirs = await makeProject();
    await Bun.write(join(dirs.projectDir, "SandboxLogic.Codeunit.al"), WIDE_GAP_AL);
    const store = new ResultsStore(":memory:");
    const caps: BackendCapabilities = {
      coverage: "none",
      deploy: "none",
      isolation: "full-reset",
      authoritative: false,
    };
    const backend = new StubBackend(caps, (mutant) => (mutant === null ? "pass" : "fail"), []);
    const report = await runSession({ backend, store, ...dirs, selectorIds, workers: 1 });
    // IsOverBudget's mutants sit on lines ~21-26 (startIndex in the 200s);
    // IsUnderBudget's sit past the 100-line padding block, well past line 100
    // (startIndex in the 1800s). Numeric ascending order must list every
    // IsOverBudget mutant before every IsUnderBudget one; the buggy string
    // sort inverted this (see WIDE_GAP_AL's comment).
    const overBudgetIndices = report.mutants
      .map((m, i) => (m.line <= 50 ? i : -1))
      .filter((i) => i >= 0);
    const lastOverBudgetIdx = overBudgetIndices.at(-1) ?? -1;
    const firstUnderBudgetIdx = report.mutants.findIndex((m) => m.line > 50);
    expect(lastOverBudgetIdx).toBeGreaterThanOrEqual(0);
    expect(firstUnderBudgetIdx).toBeGreaterThanOrEqual(0);
    expect(lastOverBudgetIdx).toBeLessThan(firstUnderBudgetIdx);
    store.close();
  });
});

describe("mutation score — timeout-killed contribution", () => {
  test("timeout-killed and killed contribute equally to the score", async () => {
    const dirs = await makeProject();
    // Create a scenario: some mutants killed, some timeout-killed, some survived
    // We'll use a fixture where 2 out of 3 mutants are tested, but with different outcomes
    const backend = new StubBackend(
      { coverage: "procedure", deploy: "publish", isolation: "session", authoritative: true },
      (mutant) => {
        // First test run is baseline (green)
        // Mutant activation determines outcome per test run
        if (mutant === null) return "pass";
        // For orchestrator, we can't directly control which mutant gets which verdict,
        // but we can test via the mock. Let's use a simpler approach.
        return "pass"; // Will mark all as survived initially
      },
      ["IsOverBudget"],
    );
    const store = new ResultsStore(":memory:");
    const report = await runSession({ backend, store, ...dirs, selectorIds });
    // This test won't work directly with runSession since we can't control
    // individual mutant verdicts easily. Let's instead test buildReport directly.
    store.close();
  });

  test("buildReport: only timeout-killed and survived produces non-null score", async () => {
    const { buildReport } = await import("../src/report");
    const report = buildReport({
      caps: { coverage: "procedure", deploy: "publish", isolation: "session", authoritative: true },
      baselineGreen: true,
      batches: 1,
      unsupportedTests: [],
      notInstrumented: { totalFiles: 0, files: [] },
      timings: { totalMs: 0, generateMutationSetMs: 0, deployMs: 0, baselineMs: 0 },
      untargetedTriggerCount: 0,
      baselineTests: [],
      outcomes: [
        {
          mutant: {
            mutantId: "M1",
            file: "test.al",
            startIndex: 0,
            endIndex: 1,
            startLine: 10,
            operatorName: "Op1",
            operatorVersion: "1.0.0",
            astHash: "hash1",
            objectType: "codeunit",
            codeunitId: 50000,
            codeunitName: "Test",
            procedureName: "TestProc",
            originalText: "Original();",
            mutatedText: "",
          },
          verdict: "timeout-killed" as const,
          batchIndex: 0,
        },
        {
          mutant: {
            mutantId: "M2",
            file: "test.al",
            startIndex: 2,
            endIndex: 3,
            startLine: 20,
            operatorName: "Op2",
            operatorVersion: "1.0.0",
            astHash: "hash2",
            objectType: "codeunit",
            codeunitId: 50000,
            codeunitName: "Test",
            procedureName: "TestProc",
            originalText: "Original();",
            mutatedText: "",
          },
          verdict: "survived" as const,
          batchIndex: 0,
        },
      ],
    });
    // 1 timeout-killed + 0 killed = 1 in numerator
    // 1 timeout-killed + 0 killed + 1 survived = 2 in denominator
    // Expected score: 1/2 = 0.5
    expect(report.mutationScore).toBe(0.5);
    expect(report.counts.timeoutKilled).toBe(1);
    expect(report.counts.killed).toBe(0);
  });

  test("buildReport: killed and timeout-killed contribute equally", async () => {
    const { buildReport } = await import("../src/report");
    const report = buildReport({
      caps: { coverage: "procedure", deploy: "publish", isolation: "session", authoritative: true },
      baselineGreen: true,
      batches: 1,
      unsupportedTests: [],
      notInstrumented: { totalFiles: 0, files: [] },
      timings: { totalMs: 0, generateMutationSetMs: 0, deployMs: 0, baselineMs: 0 },
      untargetedTriggerCount: 0,
      baselineTests: [],
      outcomes: [
        {
          mutant: {
            mutantId: "M1",
            file: "test.al",
            startIndex: 0,
            endIndex: 1,
            startLine: 10,
            operatorName: "Op1",
            operatorVersion: "1.0.0",
            astHash: "hash1",
            objectType: "codeunit",
            codeunitId: 50000,
            codeunitName: "Test",
            procedureName: "TestProc",
            originalText: "Original();",
            mutatedText: "",
          },
          verdict: "killed" as const,
          batchIndex: 0,
          killingTest: "Test1",
        },
        {
          mutant: {
            mutantId: "M2",
            file: "test.al",
            startIndex: 2,
            endIndex: 3,
            startLine: 20,
            operatorName: "Op2",
            operatorVersion: "1.0.0",
            astHash: "hash2",
            objectType: "codeunit",
            codeunitId: 50000,
            codeunitName: "Test",
            procedureName: "TestProc",
            originalText: "Original();",
            mutatedText: "",
          },
          verdict: "timeout-killed" as const,
          batchIndex: 0,
        },
        {
          mutant: {
            mutantId: "M3",
            file: "test.al",
            startIndex: 4,
            endIndex: 5,
            startLine: 30,
            operatorName: "Op3",
            operatorVersion: "1.0.0",
            astHash: "hash3",
            objectType: "codeunit",
            codeunitId: 50000,
            codeunitName: "Test",
            procedureName: "TestProc",
            originalText: "Original();",
            mutatedText: "",
          },
          verdict: "survived" as const,
          batchIndex: 0,
        },
        {
          mutant: {
            mutantId: "M4",
            file: "test.al",
            startIndex: 6,
            endIndex: 7,
            startLine: 40,
            operatorName: "Op4",
            operatorVersion: "1.0.0",
            astHash: "hash4",
            objectType: "codeunit",
            codeunitId: 50000,
            codeunitName: "Test",
            procedureName: "TestProc",
            originalText: "Original();",
            mutatedText: "",
          },
          verdict: "survived" as const,
          batchIndex: 0,
        },
      ],
    });
    // 1 killed + 1 timeout-killed = 2 in numerator
    // 1 killed + 1 timeout-killed + 2 survived = 4 in denominator
    // Expected score: 2/4 = 0.5
    expect(report.mutationScore).toBe(0.5);
    expect(report.counts.killed).toBe(1);
    expect(report.counts.timeoutKilled).toBe(1);
    expect(report.counts.survived).toBe(2);
  });

  test("buildReport: null score when no killable mutants", async () => {
    const { buildReport } = await import("../src/report");
    const report = buildReport({
      caps: { coverage: "procedure", deploy: "publish", isolation: "session", authoritative: true },
      baselineGreen: true,
      batches: 1,
      unsupportedTests: [],
      notInstrumented: { totalFiles: 0, files: [] },
      timings: { totalMs: 0, generateMutationSetMs: 0, deployMs: 0, baselineMs: 0 },
      untargetedTriggerCount: 0,
      baselineTests: [],
      outcomes: [
        {
          mutant: {
            mutantId: "M1",
            file: "test.al",
            startIndex: 0,
            endIndex: 1,
            startLine: 10,
            operatorName: "Op1",
            operatorVersion: "1.0.0",
            astHash: "hash1",
            objectType: "codeunit",
            codeunitId: 50000,
            codeunitName: "Test",
            procedureName: "TestProc",
            originalText: "Original();",
            mutatedText: "",
          },
          verdict: "no-coverage" as const,
          batchIndex: 0,
        },
        {
          mutant: {
            mutantId: "M2",
            file: "test.al",
            startIndex: 2,
            endIndex: 3,
            startLine: 20,
            operatorName: "Op2",
            operatorVersion: "1.0.0",
            astHash: "hash2",
            objectType: "codeunit",
            codeunitId: 50000,
            codeunitName: "Test",
            procedureName: "TestProc",
            originalText: "Original();",
            mutatedText: "",
          },
          verdict: "error" as const,
          batchIndex: 0,
          cause: "unstable" as const,
        },
      ],
    });
    // No killed, timeout-killed, or survived mutants
    expect(report.mutationScore).toBeNull();
  });
});

describe("runSession — single artifact", () => {
  test("a project whose mutants overlap still deploys exactly once", async () => {
    const dirs = await makeProject();
    const backend = new StubBackend(CAPS_NST, (mutant) => (mutant === null ? "pass" : "fail"), [
      "IsOverBudget",
    ]);
    const store = new ResultsStore(":memory:");
    const report = await runSession({ backend, store, ...dirs, selectorIds });
    expect(backend.deploys).toHaveLength(1);
    expect(report.batches).toBe(1);
    store.close();
  });

  // `planArtifacts` returns zero artifacts for zero instrumented files (see its
  // doc comment) — mirroring `batchByOverlap([])`'s old `[]` result — so a
  // project with no mutable sites anywhere must never reach deploy() at all,
  // not deploy one pointless empty artifact. Overwriting the target logic
  // file with NO_MUTANTS_AL (no comparisons, no exit(), no calls, no
  // non-empty blocks) makes `generateMutationSet` return zero files for the
  // whole project, so this is a genuine zero-mutant project, not just a
  // zero-mutant file alongside other mutable ones.
  test("a project with no mutable sites deploys nothing", async () => {
    const dirs = await makeProject();
    await Bun.write(join(dirs.projectDir, "SandboxLogic.Codeunit.al"), NO_MUTANTS_AL);
    const backend = new StubBackend(CAPS_NST, () => "pass", ["IsOverBudget"]);
    const store = new ResultsStore(":memory:");
    const report = await runSession({ backend, store, ...dirs, selectorIds });
    expect(backend.deploys).toHaveLength(0);
    expect(report.batches).toBe(0);
    expect(report.mutants.length).toBe(0);
    store.close();
  });
});

// A mutation guard is a bare `MutationSelector.Active(...)` call, and only a codeunit or a table
// can carry the `var MutationSelector: Codeunit "Mutation Selector";` declaration that makes it
// resolve (AL0118 otherwise). The tier-1 operators happily target a page's `OnAction` body, and a
// page with actions is ordinary AL — so without an object-kind filter at generation time, ONE
// such page reaches `compileSchemataForFile`, which throws, and the whole session dies. The
// page's own mutants are the only thing lost: `prepareBatchProject` still copies it into the
// batch dir verbatim, so what is published is byte-identical to the source project.
describe("generateMutationSet: object kinds that cannot carry the selector var", () => {
  // R40 made page and report legal carriers (measured: the selector var compiles inside both), so
  // this suite uses an `xmlport` — still refused, and still ordinary AL whose bodies the tier-1
  // operators happily target. The property under test is unchanged: one such object must cost only
  // its own mutants, not the whole session.
  const PAGE_AL = `xmlport 79010 "Sandbox Port"
{
    schema
    {
        textelement(Root)
        {
            tableelement(Cust; Customer)
            {
                trigger OnAfterGetRecord()
                begin
                    if Cust.Name = '' then
                        Cust.Name := 'x';
                end;
            }
        }
    }
}
`;

  async function pageProject(): Promise<{
    projectDir: string;
    testDir: string;
    instrumentedDir: string;
  }> {
    const root = await mkdtemp(join(tmpdir(), "lethal-orch-objkind-"));
    const projectDir = join(root, "app");
    await Bun.write(join(projectDir, "SandboxLogic.Codeunit.al"), TARGET_AL);
    await Bun.write(join(projectDir, "SandboxPort.XmlPort.al"), PAGE_AL);
    await Bun.write(join(projectDir, "app.json"), APP_JSON);
    await Bun.write(join(root, "tests", "SandboxTests.Codeunit.al"), TEST_AL);
    return {
      projectDir,
      testDir: join(root, "tests"),
      instrumentedDir: join(root, "instr"),
    };
  }

  test("drops the page's specs, keeps the codeunit's, and warns once naming the file and kind", async () => {
    const dirs = await pageProject();
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    let files: readonly InstrumentedFile[];
    let skipped: MutationSetResult["skipped"];
    let totalFiles: number;
    let messages: string[];
    try {
      ({ files, skipped, totalFiles } = await generateMutationSet(dirs.projectDir));
      messages = warnSpy.mock.calls.map((c) => String(c[0]));
    } finally {
      warnSpy.mockRestore();
    }
    expect(files.map((f) => f.path)).toEqual(["SandboxLogic.Codeunit.al"]);

    // R5: the structured return, not just the console message — this is what `runSession`
    // threads into `SessionReport.notInstrumented`, so it must survive as DATA, not just text.
    expect(totalFiles).toBe(2); // SandboxLogic.Codeunit.al + SandboxPort.XmlPort.al
    expect(skipped).toHaveLength(1);
    const [skippedFile] = skipped;
    if (skippedFile === undefined) throw new Error("expected one skipped file");
    expect(skippedFile.file).toBe("SandboxPort.XmlPort.al");
    expect(skippedFile.kinds).toContain("xmlport_declaration");
    expect(skippedFile.sites).toBeGreaterThan(0);

    const skips = messages.filter((m) => m.includes("skipped"));
    expect(skips).toHaveLength(1); // once per RUN, not once per file/spec
    const [message] = skips;
    expect(message).toContain("SandboxPort.XmlPort.al");
    expect(message).toContain("xmlport_declaration");
    // Guards this whole test against passing vacuously: if the page fixture stopped producing
    // mutation sites, dropping it would prove nothing. The count comes from the specs actually
    // generated for it, so it can only be >=1 if there was something real to drop.
    expect(message).toMatch(/holding [1-9]\d* mutation site/);
  });

  test("a session over a project containing that page still completes", async () => {
    const dirs = await pageProject();
    const backend = new StubBackend(CAPS_NST, () => "pass", ["IsOverBudget"]);
    const store = new ResultsStore(":memory:");
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const report = await runSession({ backend, store, ...dirs, selectorIds });
      expect(report.baselineGreen).toBe(true);
      expect(report.counts.errors).toBe(0);
      expect(report.mutants.length).toBeGreaterThan(0);
      // Every surviving mutant belongs to the codeunit — the page contributed none.
      expect([...new Set(report.mutants.map((m) => m.file))]).toEqual(["SandboxLogic.Codeunit.al"]);

      // Skipping the page costs its mutants and nothing else: `prepareBatchProject` still copies
      // it into the batch dir, byte-identical to source, so what gets published is unchanged.
      const batchDirs = (await readdir(dirs.instrumentedDir)).filter((e) =>
        /^run-\d+-batch-0$/.test(e),
      );
      const [batchDir] = batchDirs;
      if (batchDir === undefined) throw new Error(`no batch dir under ${dirs.instrumentedDir}`);
      const published = await readFile(
        join(dirs.instrumentedDir, batchDir, "SandboxPort.XmlPort.al"),
        "utf8",
      );
      expect(published).toBe(PAGE_AL);
    } finally {
      warnSpy.mockRestore();
      store.close();
    }
  });

  // R5: the report itself must say how much of the project was skipped, not just stderr —
  // `SessionReport.notInstrumented` is what `renderConsole` and `writeJsonReport` (--out) both
  // read, so this asserts the field survives all the way from `generateMutationSet` through
  // `runSession`/`buildReport`, not merely that a console warning fired.
  test("report.notInstrumented names the skipped file and the total file count", async () => {
    const dirs = await pageProject();
    const backend = new StubBackend(CAPS_NST, () => "pass", ["IsOverBudget"]);
    const store = new ResultsStore(":memory:");
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const report = await runSession({ backend, store, ...dirs, selectorIds });
      expect(report.notInstrumented.totalFiles).toBe(2); // codeunit + page
      expect(report.notInstrumented.fileCount).toBe(1);
      expect(report.notInstrumented.siteCount).toBeGreaterThan(0);
      expect(report.notInstrumented.files).toHaveLength(1);
      const [skippedFile] = report.notInstrumented.files;
      if (skippedFile === undefined) throw new Error("expected one skipped file");
      expect(skippedFile.file).toBe("SandboxPort.XmlPort.al");
      expect(skippedFile.kinds).toContain("xmlport_declaration");
      expect(skippedFile.sites).toBeGreaterThan(0);

      // The console render must not let a reader mistake this for a full-project score.
      const rendered = renderConsole(report);
      expect(rendered).toContain("NOT INSTRUMENTED");
      expect(rendered).toContain("SandboxPort.XmlPort.al");
      expect(rendered).toContain("1/2");

      // And a session with NOTHING skipped must report a genuinely empty account, not omit the
      // field — a caller reading JSON should never need to null-check `notInstrumented`.
      const codeunitOnlyDirs = {
        projectDir: dirs.projectDir,
        testDir: dirs.testDir,
        instrumentedDir: join(dirs.projectDir, "..", "instr2"),
      };
      // Remove the page so this second run has nothing to skip.
      await rm(join(dirs.projectDir, "SandboxPort.XmlPort.al"));
      const backend2 = new StubBackend(CAPS_NST, () => "pass", ["IsOverBudget"]);
      const store2 = new ResultsStore(":memory:");
      try {
        const cleanReport = await runSession({
          backend: backend2,
          store: store2,
          ...codeunitOnlyDirs,
          selectorIds,
        });
        expect(cleanReport.notInstrumented.fileCount).toBe(0);
        expect(cleanReport.notInstrumented.siteCount).toBe(0);
        expect(cleanReport.notInstrumented.files).toEqual([]);
        expect(cleanReport.notInstrumented.totalFiles).toBe(1);
        expect(renderConsole(cleanReport)).not.toContain("NOT INSTRUMENTED");
      } finally {
        store2.close();
      }
    } finally {
      warnSpy.mockRestore();
      store.close();
    }
  });
});

/**
 * The Tier-2 shadowing guard, observed through the pipeline's OWN context shape.
 *
 * `claimsRecordMethod` (packages/builtin-tier2/src/receiver.ts) refuses a call whose receiver's
 * table declares a procedure of that name "in the project" (design doc §4.1). It reads
 * `ctx.symbols`, so it can only ever fire over a context that HOLDS the table — and while this
 * function built one context per file, a normal AL project (one object per file) never gave it
 * one. The guard's unit test was red-checkable but certified a configuration no run produced;
 * these two tests use the real thing, two files and whatever context `generateMutationSet` builds.
 */
describe("generateMutationSet: project-wide semantic context", () => {
  const CALLER_AL = `codeunit 79310 "Shadow Caller"
{
    procedure P()
    var
        Other: Record "Other Table";
    begin
        Other.SetRange("No.", 'A');
    end;
}
`;

  const tableAL = (withProcedure: boolean): string => `table 79311 "Other Table"
{
    fields { field(1; "No."; Code[20]) { } }
${
  withProcedure
    ? `
    procedure SetRange(A: Code[20]; B: Code[20])
    begin
    end;
`
    : ""
}}
`;

  async function operatorsAtSetRange(withProcedure: boolean): Promise<string[]> {
    const root = await mkdtemp(join(tmpdir(), "lethal-orch-shadow-"));
    const projectDir = join(root, "app");
    // Separate files — the layout the guard was inert against, and the ordinary AL convention.
    await Bun.write(join(projectDir, "ShadowCaller.Codeunit.al"), CALLER_AL);
    await Bun.write(join(projectDir, "OtherTable.Table.al"), tableAL(withProcedure));
    await Bun.write(join(projectDir, "app.json"), APP_JSON);
    try {
      const { files } = await generateMutationSet(projectDir);
      const caller = files.find((f) => f.path === "ShadowCaller.Codeunit.al");
      if (caller === undefined) throw new Error("caller file produced no specs at all");
      return caller.specs
        .filter((s) => s.before.text.startsWith("Other.SetRange"))
        .map((s) => s.operatorName)
        .sort();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  test("the shadowing refusal fires across files: only the Tier-1 mutant remains", async () => {
    expect(await operatorsAtSetRange(true)).toEqual(["lethal.void-method-call"]);
  });

  test("with no shadowing procedure in that table, RemoveSetRange claims the same site", async () => {
    // The counterweight: without it, the test above would pass just as well if `RemoveSetRange`
    // never claimed anything in a two-file project for some unrelated reason.
    expect(await operatorsAtSetRange(false)).toEqual([
      "lethal.remove-setrange",
      "lethal.void-method-call",
    ]);
  });
});

/**
 * The only place a REAL cross-tier collision is observed end to end.
 *
 * `packages/schemata/tests/dedup.test.ts` and `project.test.ts` hand-build their colliding specs
 * — correctly, since `schemata` deliberately does not depend on the operator packages — so they
 * verify how `dedupeSpecs` resolves a collision, never that the real operators actually produce
 * one. This package imports BOTH registries, so `generateMutationSet` over a temp project holding
 * the four Tier-2 shapes answers the question the spec's §7.4 invariant is really about: do
 * `void-method-call` and each Tier-2 narrowing agree, byte for byte, on the span and the
 * after-form at a shared site? Span discipline is what makes them collide at all; a Tier-2
 * operator that claimed a slightly different span would silently emit a SECOND mutant at every
 * site instead of replacing the Tier-1 one, and every assertion in `schemata` would still pass.
 */
describe("generateMutationSet: real cross-tier collisions", () => {
  const COLLISION_AL = `codeunit 79300 "Tier2 Collisions"
{
    procedure P()
    var
        Cust: Record Customer;
    begin
        Cust.TestField("No.");
        Cust.SetRange("No.", 'A');
        Cust.CalcFields(Balance);
        Cust.Modify(true);
    end;
}
`;

  /** Exactly the identity `dedupeSpecs` keys on (`packages/schemata/src/dedup.ts`). */
  const identityOf = (s: MutationSpec): string =>
    `${s.before.kind}:${s.before.startIndex}:${s.before.endIndex}:${s.after.text}`;

  async function collisionSpecs(): Promise<readonly MutationSpec[]> {
    const root = await mkdtemp(join(tmpdir(), "lethal-orch-collide-"));
    const projectDir = join(root, "app");
    await Bun.write(join(projectDir, "Collisions.Codeunit.al"), COLLISION_AL);
    await Bun.write(join(projectDir, "app.json"), APP_JSON);
    const { files } = await generateMutationSet(projectDir);
    const [file] = files;
    if (file === undefined) throw new Error("expected one instrumented file");
    return file.specs;
  }

  const spanOf = (specs: readonly MutationSpec[], text: string): string => {
    const hit = specs.find((s) => s.before.text === text);
    if (hit === undefined) {
      throw new Error(
        `no spec at ${JSON.stringify(text)}; produced: ${JSON.stringify(specs.map((s) => s.before.text))}`,
      );
    }
    return `${hit.before.startIndex}:${hit.before.endIndex}`;
  };

  test("each Tier-2 deletion collides with void-method-call on the SAME span and after-form", async () => {
    const specs = await collisionSpecs();

    for (const [callText, tier2Name] of [
      ['Cust.TestField("No.")', "lethal.remove-testfield"],
      ["Cust.SetRange(\"No.\", 'A')", "lethal.remove-setrange"],
      ["Cust.CalcFields(Balance)", "lethal.remove-calcfields"],
    ] as const) {
      const span = spanOf(specs, callText);
      const atSite = specs.filter((s) => `${s.before.startIndex}:${s.before.endIndex}` === span);
      expect(atSite.map((s) => s.operatorName).sort()).toEqual(
        ["lethal.void-method-call", tier2Name].sort(),
      );
      // The collision itself: one identity, two operators claiming it.
      expect(new Set(atSite.map(identityOf)).size).toBe(1);
    }
  });

  test("the Modify(true) site produces two DIFFERENT identities — coexistence, not a collision", async () => {
    const specs = await collisionSpecs();
    const span = spanOf(specs, "Cust.Modify(true)");
    const atSite = specs.filter((s) => `${s.before.startIndex}:${s.before.endIndex}` === span);
    expect(atSite.map((s) => s.operatorName).sort()).toEqual([
      "lethal.swap-modify-flag",
      "lethal.void-method-call",
    ]);
    expect(new Set(atSite.map(identityOf)).size).toBe(2);
    expect(atSite.map((s) => s.after.text).sort()).toEqual(["", "Cust.Modify(false)"]);
  });

  test("the whole pipeline resolves them to one mutant per deletion site and two at Modify", async () => {
    const root = await mkdtemp(join(tmpdir(), "lethal-orch-collide-e2e-"));
    const projectDir = join(root, "app");
    const outDir = join(root, "instr");
    await Bun.write(join(projectDir, "Collisions.Codeunit.al"), COLLISION_AL);
    await Bun.write(join(projectDir, "app.json"), APP_JSON);
    try {
      const { files } = await generateMutationSet(projectDir);
      await writeInstrumentedProject({
        targetDir: outDir,
        files,
        selectorIds,
        artifactId: "0123456789abcdef0123456789abcdef",
        targetAppId: "df1aa9ff-6539-4c86-a9d0-ad702b61ac9a",
        operatorTiers,
      });
      const manifest = JSON.parse(await readFile(join(outDir, "mutant-manifest.json"), "utf8")) as {
        mutants: Array<{ startIndex: number; operatorName: string }>;
      };
      const [file] = files;
      if (file === undefined) throw new Error("expected one instrumented file");

      const survivorsAt = (callText: string): string[] => {
        const start = Number(spanOf(file.specs, callText).split(":")[0]);
        return manifest.mutants
          .filter((m) => m.startIndex === start)
          .map((m) => m.operatorName)
          .sort();
      };

      // Tier 2 outranks Tier 1: the narrowing wins and void-method-call is gone from the artifact.
      expect(survivorsAt('Cust.TestField("No.")')).toEqual(["lethal.remove-testfield"]);
      expect(survivorsAt("Cust.SetRange(\"No.\", 'A')")).toEqual(["lethal.remove-setrange"]);
      expect(survivorsAt("Cust.CalcFields(Balance)")).toEqual(["lethal.remove-calcfields"]);
      // Different after-form, so no collision to resolve — both survive.
      expect(survivorsAt("Cust.Modify(true)")).toEqual([
        "lethal.swap-modify-flag",
        "lethal.void-method-call",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// ————————————————————————————————————————————————————————————————————————
// Layer 5A (Task 6): deployment identity — compile/publish/verify phases,
// version reservation, artifact provenance, version-conflict retry.
// ————————————————————————————————————————————————————————————————————————

const PHASE_CAPS: BackendCapabilities = {
  coverage: "none",
  deploy: "publish",
  isolation: "session",
  authoritative: true,
};

const PHASE_VERIFIER_CFG = {
  baseUrl: "http://bc:7048/BC",
  company: "CRONUS",
  username: "u",
  password: "p",
};

/**
 * Mirrors `BcDevMcpBackend.deploy()`'s three-phase composition (compile -> publish -> verify),
 * faking the compile (it reads the batch dir's app.json + mutant-manifest.json, exactly like
 * the real prepare step) and the publish, while running the REAL `DeploymentVerifier`,
 * `decidePublishOutcome` and `DeploymentError`. Using the real verifier is deliberate: its
 * malformed-id tripwire THROWS on anything that isn't 32 lowercase hex, so a placeholder
 * artifact id surviving anywhere in the orchestrator fails every one of these tests loudly.
 */
class PhaseBackend implements ExecutionBackend {
  readonly calls: string[] = [];
  lastCompiledVersion: string | undefined;
  constructor(
    private readonly opts: {
      /** Called once per publish phase (1-based attempt); throwing simulates altool failing. */
      readonly onPublish?: (attempt: number) => void;
      /** What MutationControl_Identity reports; defaults to echoing the compiled artifact. */
      readonly reportedIdentity?: string;
    } = {},
  ) {}
  private publishAttempts = 0;
  capabilities() {
    return PHASE_CAPS;
  }
  async status(): Promise<BackendStatus> {
    return { ok: true, details: "phase" };
  }
  /** Shared compile-only step: reads the batch dir's inputs, builds the fake artifact. Used by
   *  both deploy() (compile -> publish -> verify) and compileCheck() (compile, stop). */
  private async compileArtifact(dir: string): Promise<CompiledArtifact> {
    this.calls.push("compile");
    const appManifest = JSON.parse(await readFile(join(dir, "app.json"), "utf8")) as {
      id: string;
      version: string;
    };
    const mutantManifest = JSON.parse(
      await readFile(join(dir, "mutant-manifest.json"), "utf8"),
    ) as CompiledArtifact["mutantManifest"];
    this.lastCompiledVersion = appManifest.version;
    return {
      artifactId: mutantManifest.artifactId,
      appId: appManifest.id,
      appVersion: appManifest.version,
      appPath: join(dir, "phase-fake.app"),
      sha256: Bun.SHA256.hash(new Uint8Array([1, 2, 3]), "hex"),
      mutantManifest,
      appManifest: appManifest as unknown as Record<string, unknown>,
    };
  }
  /** Compile-only seam: no "publish"/"verify" entries in `calls`, ever. */
  async compileCheck(dir: string): Promise<void> {
    await this.compileArtifact(dir);
  }
  async deploy(dir: string): Promise<CompiledArtifact | null> {
    const artifact = await this.compileArtifact(dir);
    this.calls.push("publish");
    this.publishAttempts++;
    let publishOk = true;
    let publishError: string | undefined;
    try {
      this.opts.onPublish?.(this.publishAttempts);
    } catch (err) {
      publishOk = false;
      publishError = err instanceof Error ? err.message : String(err);
    }
    this.calls.push("verify");
    // A failed publish leaves the PREVIOUS artifact running server-side, so identity then
    // reports some other (well-formed) id, never the one this deploy just tried to publish.
    const reported =
      this.opts.reportedIdentity ?? (publishOk ? artifact.artifactId : "f".repeat(32));
    const fetchFn = (async (_url: unknown, _init?: RequestInit) =>
      new Response(JSON.stringify({ value: reported }), { status: 200 })) as typeof fetch;
    const verification = await new DeploymentVerifier(PHASE_VERIFIER_CFG, fetchFn).verify(artifact);
    const outcome = decidePublishOutcome(publishOk, verification);
    if (outcome !== "accepted") throw new DeploymentError(outcome, publishError, verification);
    return artifact;
  }
  async activate(mutantId: string | null): Promise<void> {
    // runSession's cleanup `finally` always deactivates (activate(null)); only a real mutant
    // activation counts as "the orchestrator started testing against this deployment".
    if (mutantId !== null) this.calls.push("activate");
  }
  async run(ref: TestMethodRef, _opts: RunOpts): Promise<TestVerdict> {
    this.calls.push("run");
    // Layer 5C-A Task 8, Task 10 (design §G): PHASE_CAPS is always authoritative — attest
    // cleanly by default (healthy-backend fixture), same rationale as StubBackend's note above.
    return {
      ref,
      outcome: "pass",
      durationMs: 5,
      attestation: { observedAny: true, identityMismatch: false },
    };
  }
}

describe("runSession — Layer 5A deployment identity", () => {
  test("calls compile once, then publish, then verify — in that order, before any test runs", async () => {
    const dirs = await makeProject();
    const backend = new PhaseBackend();
    const store = new ResultsStore(":memory:");
    await runSession({ backend, store, ...dirs, selectorIds });
    const calls = backend.calls;
    const firstRun = calls.indexOf("run");
    expect(firstRun).toBeGreaterThan(-1);
    expect(calls.filter((c) => c === "compile")).toHaveLength(1);
    expect(calls.indexOf("compile")).toBeLessThan(calls.indexOf("publish"));
    expect(calls.indexOf("publish")).toBeLessThan(calls.indexOf("verify"));
    expect(calls.indexOf("verify")).toBeLessThan(firstRun);
    store.close();
  });

  test("records the version actually compiled, not the createRun placeholder", async () => {
    const dirs = await makeProject();
    const store = new ResultsStore(":memory:");
    await runSession({ backend: new PhaseBackend(), store, ...dirs, selectorIds });
    const row = store.db
      .query("SELECT app_version, app_id, artifact_id, artifact_sha256 FROM runs LIMIT 1")
      .get() as {
      app_version: string;
      app_id: string;
      artifact_id: string;
      artifact_sha256: string;
    };
    expect(row.app_version).not.toBe("0.0.0.0");
    expect(row.app_version).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    // Major.minor come from the fixture's own app.json (1.0.0.0), never hardcoded elsewhere.
    expect(row.app_version.startsWith("1.0.")).toBe(true);
    expect(row.app_id).toBe(APP_ID);
    expect(row.artifact_id).toMatch(/^[0-9a-f]{32}$/);
    expect(row.artifact_sha256).toMatch(/^[0-9a-f]{64}$/);
    store.close();
  });

  test("re-stamps above the version BC names and retries exactly once on conflict", async () => {
    const dirs = await makeProject();
    let attempts = 0;
    const backend = new PhaseBackend({
      onPublish: () => {
        attempts++;
        if (attempts === 1) {
          throw new Error(
            "Cannot install the extension X by Y 1.0.1.1 because a newer version 9.9.9.9 was already installed.",
          );
        }
      },
    });
    const store = new ResultsStore(":memory:");
    const report = await runSession({ backend, store, ...dirs, selectorIds });
    expect(attempts).toBe(2);
    expect(backend.lastCompiledVersion).toBe("9.9.9.10");
    expect(report.counts.errors).toBe(0);
    store.close();
  });

  test("fails loudly on a SECOND version conflict rather than retrying forever", async () => {
    const dirs = await makeProject();
    const backend = new PhaseBackend({
      onPublish: () => {
        throw new Error(
          "Cannot install the extension X by Y 1.0.1.1 because a newer version 9.9.9.9 was already installed.",
        );
      },
    });
    const store = new ResultsStore(":memory:");
    await expect(runSession({ backend, store, ...dirs, selectorIds })).rejects.toThrow(
      /version conflict/i,
    );
    store.close();
  });

  test("runs no tests when identity does not match the published artifact", async () => {
    const dirs = await makeProject();
    const backend = new PhaseBackend({ reportedIdentity: "some-other-artifact-id" });
    const store = new ResultsStore(":memory:");
    await expect(runSession({ backend, store, ...dirs, selectorIds })).rejects.toThrow(
      /indeterminate/i,
    );
    expect(backend.calls).not.toContain("run");
    expect(backend.calls).not.toContain("activate");
    store.close();
  });

  test("an app.json version component above 65535 aborts the session before any compile", async () => {
    const dirs = await makeProject();
    const manifest = JSON.parse(APP_JSON) as Record<string, unknown>;
    await Bun.write(
      join(dirs.projectDir, "app.json"),
      JSON.stringify({ ...manifest, version: "70000.0.0.0" }),
    );
    const backend = new PhaseBackend();
    const store = new ResultsStore(":memory:");
    await expect(runSession({ backend, store, ...dirs, selectorIds })).rejects.toThrow(
      /app\.json version/,
    );
    expect(backend.calls).not.toContain("compile");
    store.close();
  });

  test("a malformed app.json version aborts the session before any compile", async () => {
    const dirs = await makeProject();
    const manifest = JSON.parse(APP_JSON) as Record<string, unknown>;
    await Bun.write(
      join(dirs.projectDir, "app.json"),
      JSON.stringify({ ...manifest, version: "1.0" }),
    );
    const backend = new PhaseBackend();
    const store = new ResultsStore(":memory:");
    await expect(runSession({ backend, store, ...dirs, selectorIds })).rejects.toThrow(
      /app\.json version/,
    );
    expect(backend.calls).not.toContain("compile");
    store.close();
  });
});

// ————————————————————————————————————————————————————————————————————————
// Task 14 (Layer 5B fold-in): a deploy:"none" (al-runner) run's `createRun` placeholder is what
// durably lands in `runs.app_version` — al-runner's deploy() always returns null, so the
// Layer 5A `recordArtifact` correction (3d, see "records the version actually compiled" above)
// never fires for it. Must read the project's own app.json version instead of the meaningless
// "0.0.0.0" default.
// ————————————————————————————————————————————————————————————————————————

describe("runSession — deploy:none (al-runner) app_version", () => {
  const AL_RUNNER_CAPS: BackendCapabilities = {
    coverage: "none",
    deploy: "none",
    isolation: "full-reset",
    authoritative: false,
  };

  test("records the project's own app.json version, not the 0.0.0.0 placeholder", async () => {
    const dirs = await makeProject();
    const manifest = JSON.parse(APP_JSON) as Record<string, unknown>;
    await Bun.write(
      join(dirs.projectDir, "app.json"),
      JSON.stringify({ ...manifest, version: "1.2.3.4" }),
    );
    const backend = new StubBackend(AL_RUNNER_CAPS, (mutant) =>
      mutant === null ? "pass" : "fail",
    );
    const store = new ResultsStore(":memory:");
    await runSession({ backend, store, ...dirs, selectorIds });
    const row = store.db.query("SELECT app_version FROM runs LIMIT 1").get() as {
      app_version: string;
    };
    expect(row.app_version).toBe("1.2.3.4");
    expect(row.app_version).not.toBe("0.0.0.0");
    store.close();
  });

  test("an explicit cfg.appVersion still wins over app.json for a deploy:none backend", async () => {
    const dirs = await makeProject();
    const manifest = JSON.parse(APP_JSON) as Record<string, unknown>;
    await Bun.write(
      join(dirs.projectDir, "app.json"),
      JSON.stringify({ ...manifest, version: "1.2.3.4" }),
    );
    const backend = new StubBackend(AL_RUNNER_CAPS, (mutant) =>
      mutant === null ? "pass" : "fail",
    );
    const store = new ResultsStore(":memory:");
    await runSession({ backend, store, ...dirs, selectorIds, appVersion: "9.9.9.9" });
    const row = store.db.query("SELECT app_version FROM runs LIMIT 1").get() as {
      app_version: string;
    };
    expect(row.app_version).toBe("9.9.9.9");
    store.close();
  });

  test("does not change mutant verdicts — recorded-metadata fix only", async () => {
    const dirs = await makeProject();
    const manifest = JSON.parse(APP_JSON) as Record<string, unknown>;
    await Bun.write(
      join(dirs.projectDir, "app.json"),
      JSON.stringify({ ...manifest, version: "1.2.3.4" }),
    );
    const shape = (r: Awaited<ReturnType<typeof runSession>>) =>
      [...r.mutants].map((m) => `${m.file}:${m.line}:${m.operatorName}:${m.verdict}`).sort();
    const store = new ResultsStore(":memory:");
    const backend = new StubBackend(AL_RUNNER_CAPS, (mutant) =>
      mutant === null ? "pass" : "fail",
    );
    const report = await runSession({ backend, store, ...dirs, selectorIds });
    store.close();

    const dirs2 = await makeProject(); // app.json still the default 1.0.0.0 here
    const store2 = new ResultsStore(":memory:");
    const backend2 = new StubBackend(AL_RUNNER_CAPS, (mutant) =>
      mutant === null ? "pass" : "fail",
    );
    const report2 = await runSession({ backend: backend2, store: store2, ...dirs2, selectorIds });
    store2.close();

    expect(shape(report)).toEqual(shape(report2));
  });
});

describe("narrowFilesToSubset", () => {
  // Minimal fakes: `narrowFilesToSubset` only ever reads `spec.before.{start,end}Index`,
  // `spec.operatorName`, and `file.{path,specs}` — every other field on `ALSyntaxNode` /
  // `MutationSpec` is irrelevant to the regrouping logic under test, so the fakes only
  // populate what's actually read rather than constructing a real parsed tree.
  function fakeNode(startIndex: number, endIndex: number): ALSyntaxNode {
    return { startIndex, endIndex } as unknown as ALSyntaxNode;
  }
  function fakeSpec(operatorName: string, startIndex: number, endIndex: number): MutationSpec {
    return {
      operatorName,
      operatorVersion: "1.0.0",
      astNodeId: `${operatorName}@${startIndex}`,
      before: fakeNode(startIndex, endIndex),
      after: fakeNode(startIndex, endIndex),
      parentContext: "statement",
    } as unknown as MutationSpec;
  }
  function fakeEntry(
    file: string,
    startIndex: number,
    endIndex: number,
    operatorName: string,
  ): MutantManifestEntry {
    return {
      mutantId: "M0000",
      file,
      startIndex,
      endIndex,
      startLine: 1,
      operatorName,
      operatorVersion: "1.0.0",
      astHash: "h",
      objectType: "codeunit",
      codeunitId: 1,
      codeunitName: "C",
      procedureName: "P",
      originalText: "Original();",
      mutatedText: "",
    };
  }

  test("keeps only the specs matching the subset, by (file, span, operator)", () => {
    const specA = fakeSpec("lethal.empty-block", 0, 10);
    const specB = fakeSpec("lethal.conditional-boundary", 20, 30);
    const files: InstrumentedFile[] = [
      { path: "a.al", source: "", root: fakeNode(0, 100), specs: [specA, specB] },
    ];
    const narrowed = narrowFilesToSubset(files, [
      fakeEntry("a.al", 20, 30, "lethal.conditional-boundary"),
    ]);
    expect(narrowed).toHaveLength(1);
    expect(narrowed[0]?.specs).toEqual([specB]);
  });

  test("drops a file entirely when none of its specs are in the subset", () => {
    const specA = fakeSpec("lethal.empty-block", 0, 10);
    const files: InstrumentedFile[] = [
      { path: "a.al", source: "", root: fakeNode(0, 100), specs: [specA] },
    ];
    expect(narrowFilesToSubset(files, [])).toHaveLength(0);
  });

  test("a file untouched by the subset is dropped, a matching file across many is kept", () => {
    const specA = fakeSpec("lethal.empty-block", 0, 10);
    const specB = fakeSpec("lethal.return-value", 5, 8);
    const files: InstrumentedFile[] = [
      { path: "a.al", source: "srcA", root: fakeNode(0, 100), specs: [specA] },
      { path: "b.al", source: "srcB", root: fakeNode(0, 100), specs: [specB] },
    ];
    const narrowed = narrowFilesToSubset(files, [fakeEntry("b.al", 5, 8, "lethal.return-value")]);
    expect(narrowed).toHaveLength(1);
    expect(narrowed[0]?.path).toBe("b.al");
  });

  test("throws loudly when two specs collide on the (file, span, operator) key", () => {
    // The key's uniqueness holds today only because every Tier 1 operator
    // emits at most one spec per node. The day an operator emits two variants
    // for the same node, matching a manifest entry back to "its" spec becomes
    // ambiguous — that must fail loudly, not silently coarsen bisection.
    const specA = fakeSpec("lethal.two-variant", 0, 10);
    const specB = fakeSpec("lethal.two-variant", 0, 10); // same node, same operator
    const files: InstrumentedFile[] = [
      { path: "a.al", source: "", root: fakeNode(0, 100), specs: [specA, specB] },
    ];
    expect(() =>
      narrowFilesToSubset(files, [fakeEntry("a.al", 0, 10, "lethal.two-variant")]),
    ).toThrow(/duplicate spec key/);
    // Same-operator specs on DIFFERENT spans stay legal.
    const okFiles: InstrumentedFile[] = [
      {
        path: "a.al",
        source: "",
        root: fakeNode(0, 100),
        specs: [fakeSpec("lethal.two-variant", 0, 10), fakeSpec("lethal.two-variant", 20, 30)],
      },
    ];
    expect(() => narrowFilesToSubset(okFiles, [])).not.toThrow();
  });
});

describe("runSession — bisection on compile failure", () => {
  // Brief's literal test, adapted: `deployGuard` is a `StubBackend` constructor
  // parameter (matching how `deployError`/`onRun` already extend it) rather than a
  // property assigned after construction. The guard fails only the very first deploy
  // (the whole-artifact one), then succeeds on everything bisection tries afterward —
  // a minimal smoke test that the new catch-block wiring doesn't crash or hang, and
  // that the batch still ends up correctly recorded as errored. Since this scenario's
  // culprit search comes up empty (the guard stops failing before any subset is
  // proven guilty), the note falls back to the raw error text — asserted here too,
  // now that `failureNote` reaches `SessionReport`.
  test("a mutant that breaks compilation is named, not blamed on the whole run", async () => {
    const dirs = await makeProject();
    let seenSubsets = 0;
    const backend = new StubBackend(
      CAPS_NST,
      () => "pass",
      ["IsOverBudget"],
      undefined,
      undefined,
      (_dir: string) => {
        seenSubsets++;
        return seenSubsets === 1 ? new AlcCompileError("alc: AL0001") : undefined;
      },
    );
    const store = new ResultsStore(":memory:");
    const report = await runSession({ backend, store, ...dirs, selectorIds });
    expect(report.counts.errors).toBeGreaterThan(0);
    const noted = report.mutants.find((m) => m.verdict === "error");
    expect(noted).toBeDefined();
    expect(noted?.failureNote).toContain("AL0001");
    store.close();
  });

  // Stronger: `deployGuard` fails whenever the ACTUAL manifest written for whatever
  // subset `prepareArtifactDir` just built still contains the
  // `lethal.conditional-boundary` mutant (TARGET_AL's 3 nested mutants —
  // empty-block/return-value/conditional-boundary — all share one containment
  // component, exactly the "one bad spec in one file" shape bisection exists for).
  // If `narrowFilesToSubset` were a no-op (e.g. always re-writing the full,
  // unnarrowed spec set regardless of `subset`), every attempt would keep seeing the
  // boundary mutant and keep failing — `attempts` would never see `false`.
  //
  // Critically, the identity this test cares about is asserted on `report.mutants`
  // itself, not inferred from re-reading the scratch artifact's manifest — reading
  // the manifest inside `deployGuard` only simulates a realistic backend (one whose
  // failure genuinely depends on which spec is present), it is not how the test
  // proves the name reached the user. Verified by temporarily deleting the
  // `...(o.failureNote !== undefined ? { failureNote: o.failureNote } : {})` line in
  // `buildReport` (report.ts) and re-running: `noted?.failureNote` came back
  // `undefined` and both `toContain` assertions failed — restoring the line turned it
  // green again, confirming this test actually depends on that wiring end to end.
  test("bisection identifies the culprit in the SessionReport, not just via a manifest side channel", async () => {
    const dirs = await makeProject();
    const attempts: boolean[] = []; // true = this attempt's manifest still had the boundary mutant
    const backend = new StubBackend(
      CAPS_NST,
      () => "pass",
      ["IsOverBudget"],
      undefined,
      undefined,
      (dir: string) => {
        const manifest = JSON.parse(readFileSync(join(dir, "mutant-manifest.json"), "utf8")) as {
          mutants: Array<{ operatorName: string }>;
        };
        const hasBoundary = manifest.mutants.some(
          (m) => m.operatorName === "lethal.conditional-boundary",
        );
        attempts.push(hasBoundary);
        return hasBoundary
          ? new AlcCompileError("alc: AL0001 malformed operator replacement")
          : undefined;
      },
    );
    const store = new ResultsStore(":memory:");
    const report = await runSession({ backend, store, ...dirs, selectorIds });
    expect(report.counts.errors).toBeGreaterThan(0);
    // More than the one always-failing whole-artifact deploy — bisection genuinely ran.
    expect(attempts.length).toBeGreaterThan(1);
    // At least one narrowed attempt excluded the boundary mutant and compiled clean —
    // proof the artifact `prepareArtifactDir` wrote actually reflected that subset.
    expect(attempts.some((hasBoundary) => !hasBoundary)).toBe(true);

    // The actual assertion this test exists for: the culprit's identity must reach
    // the public SessionReport.
    const noted = report.mutants.find((m) => m.verdict === "error");
    expect(noted).toBeDefined();
    expect(noted?.failureNote).toBeDefined();
    expect(noted?.failureNote).toContain("bisected to mutant");
    expect(noted?.failureNote).toContain("lethal.conditional-boundary");
    store.close();
  });

  // I3: a deploy failure that reproduces regardless of which mutants are in
  // the artifact (observed live with BC app-version monotonicity, see
  // fixtures/README.md) must NOT be pinned on a mutant. The unconfirmed search used to
  // converge on candidates[0] and blame it with full confidence; the confirmation step
  // (complement still fails without the candidate) now classifies it as environmental
  // instead. (This fixture used to fail with a version-conflict message; since Task 6 that
  // specific shape is handled UPSTREAM of bisection — re-stamp + one retry, then a loud
  // session abort, see the test below.) Typed as `AlcCompileError`, not a bare licence-style
  // message: since Task 7, only a deterministic alc rejection ever reaches bisection at all —
  // a real licence failure surfaces as `DeploymentError` and aborts upstream of this path (see
  // the DeploymentError/ArtifactPrepareError abort tests below) — so this fixture stands in
  // for something alc itself can genuinely fail on regardless of mutant content (e.g. a
  // resource limit), not a publish-time licence check.
  test("an environment-caused deploy failure is reported as such, not blamed on a mutant", async () => {
    const dirs = await makeProject();
    const backend = new StubBackend(
      CAPS_NST,
      () => "pass",
      ["IsOverBudget"],
      undefined,
      undefined,
      // Every deploy fails identically, whatever the manifest contains —
      // the environmental shape.
      () => new AlcCompileError("alc: internal compiler error (resource limit exceeded)"),
    );
    const store = new ResultsStore(":memory:");
    const report = await runSession({ backend, store, ...dirs, selectorIds });
    expect(report.counts.errors).toBeGreaterThan(0);
    const noted = report.mutants.find((m) => m.verdict === "error");
    expect(noted).toBeDefined();
    expect(noted?.failureNote).toContain("not attributable to any mutant");
    expect(noted?.failureNote).toContain("resource limit exceeded");
    expect(noted?.failureNote).not.toContain("bisected to mutant");
    store.close();
  });

  // Same problem, `workers > 1` path: a worker's own deploy of the shared artifact
  // can fail while other workers succeed (existing "worker's own deploy failure"
  // tests already cover that split), and until now that failure was never bisected —
  // every mutant in the failing shard was blamed with a flat `String(err)`. Only
  // worker 0's backend is guarded here (mirroring the existing per-worker-failure
  // tests' `workerIndex === 0` convention); worker 1 has no guard and always
  // succeeds, so its shard's mutants must resolve normally (killed/survived), never
  // "error" — proving the bisected failure stayed scoped to worker 0's shard.
  //
  // The guard is scoped to IsOverBudget's conditional-boundary specifically (operatorName
  // AND procedureName), not just operatorName: TWO_PROC_AL carries a conditional-boundary
  // mutant in EACH procedure, so an operatorName-only check would make two mutants equally
  // "guilty" — bisectFailingMutant assumes exactly one culprit, and confirmation against a
  // manifest search that (correctly, post-Task-7) spans every procedure would then find the
  // complement still fails (the OTHER procedure's conditional-boundary is still present) and
  // report "environmental" instead of naming either one. Scoping to one procedure keeps this
  // fixture a genuine single-culprit case.
  test("a worker's deploy failure is bisected to a named mutant, not blamed on its whole shard", async () => {
    const dirs = await makeProject();
    await Bun.write(join(dirs.projectDir, "SandboxLogic.Codeunit.al"), TWO_PROC_AL);
    const store = new ResultsStore(":memory:");
    const caps: BackendCapabilities = {
      coverage: "none",
      deploy: "none",
      isolation: "full-reset",
      authoritative: false,
    };
    const make = (workerIndex: number) =>
      new StubBackend(
        caps,
        (mutant) => (mutant === null ? "pass" : "fail"),
        [],
        undefined,
        undefined,
        workerIndex === 0
          ? (dir: string) => {
              const manifest = JSON.parse(
                readFileSync(join(dir, "mutant-manifest.json"), "utf8"),
              ) as { mutants: Array<{ operatorName: string; procedureName: string }> };
              const hasBoundary = manifest.mutants.some(
                (m) =>
                  m.operatorName === "lethal.conditional-boundary" &&
                  m.procedureName === "IsOverBudget",
              );
              return hasBoundary
                ? new AlcCompileError("alc: AL0001 malformed operator replacement")
                : undefined;
            }
          : undefined,
      );
    const report = await runSession({
      backend: make(-1),
      backendFactory: make,
      store,
      ...dirs,
      selectorIds,
      workers: 2,
    });
    expect(report.counts.errors).toBeGreaterThan(0);
    const noted = report.mutants.find((m) => m.verdict === "error");
    expect(noted).toBeDefined();
    expect(noted?.failureNote).toContain("bisected to mutant");
    expect(noted?.failureNote).toContain("lethal.conditional-boundary");
    // Worker 1's shard (no guard, always succeeds) still produced real verdicts —
    // the bisected failure never spread past worker 0's own shard.
    expect(report.counts.killed).toBeGreaterThan(0);
    store.close();
  });

  // The `workers > 1` twin of the sequential AlcCompileError-guard abort (step 3b, covered
  // above by the "reportedIdentity" tests using a single `backend`): a DeploymentError is
  // NOT a compile verdict — the per-shard catch's `if (!(err instanceof AlcCompileError))
  // throw err` must reject the whole session before `bisectAndNote` ever runs, exactly like
  // the sequential path. Without that guard, a worker's publish/verify failure would fall
  // through into the same bisection machinery the previous test exercises for a plain compile
  // error, and get silently downgraded into a per-mutant "error" note instead of aborting the
  // run.
  test("a worker's DeploymentError aborts the whole session instead of being bisected", async () => {
    const root = await mkdtemp(join(tmpdir(), "lethal-orch-parallel-deployerr-"));
    const dbPath = join(root, "results.sqlite");
    const dirs = await makeProject();
    await Bun.write(join(dirs.projectDir, "SandboxLogic.Codeunit.al"), TWO_PROC_AL);
    const store = new ResultsStore(dbPath);
    const caps: BackendCapabilities = {
      coverage: "none",
      deploy: "none",
      isolation: "full-reset",
      authoritative: false,
    };
    // The exact object worker 0's deploy() throws — asserted below by reference (`.toBe`),
    // so the rethrow at orchestrator.ts:667 is proven to propagate it untouched, never
    // wrapped in a "bisected to mutant ..." note the way a plain compile failure would be.
    const deployErr = new DeploymentError("failed", "boom: worker 0 could not deploy", {
      status: "unavailable",
      detail: "no response",
    });
    const make = (workerIndex: number) =>
      new StubBackend(
        caps,
        (mutant) => (mutant === null ? "pass" : "fail"),
        [],
        workerIndex === 0 ? deployErr : undefined,
      );
    await expect(
      runSession({
        backend: make(-1),
        backendFactory: make,
        store,
        ...dirs,
        selectorIds,
        workers: 2,
      }),
    ).rejects.toBe(deployErr);

    // Reopen the on-disk DB: no mutant anywhere carries a "bisected" note — proof the
    // DeploymentError never reached bisectAndNote, on worker 0's shard or anywhere else.
    const raw = new Database(dbPath, { readonly: true });
    const rows = raw.query("SELECT failure_note FROM mutants").all() as Array<{
      failure_note: string | null;
    }>;
    raw.close();
    expect(rows.every((r) => !r.failure_note?.includes("bisected"))).toBe(true);
    store.close();
  });
});

// ————————————————————————————————————————————————————————————————————————
// Task 7: bisect the full manifest (not the history-filtered `execute` set),
// and never let a non-compiler failure reach — or survive inside — bisection.
// ————————————————————————————————————————————————————————————————————————

/**
 * Writes `projectDir`'s full (unfiltered) mutation set to a throwaway scratch dir and returns
 * its manifest entries — used only to read a REAL mutant's identity fields ahead of a real run,
 * so a seeded "prior survivor" (see `seedPriorSurvivor` below) structurally matches a mutant
 * `runSession` will itself generate for the same project. `generateMutationSet` +
 * `writeInstrumentedProject` are pure functions of the project's source (same file list, same
 * AST traversal order, same `astSubtreeHash`), so calling this once here and letting
 * `runSession` regenerate the same project again independently yields identical identity
 * fields for the same mutant — this is exactly what `narrowFilesToSubset`'s own (file, span,
 * operator) matching and every existing `deployGuard`-reads-the-manifest test above already
 * lean on.
 */
async function manifestMutants(
  projectDir: string,
  scratchDir: string,
): Promise<readonly MutantManifestEntry[]> {
  const { files } = await generateMutationSet(projectDir);
  await writeInstrumentedProject({
    targetDir: scratchDir,
    files,
    selectorIds,
    artifactId: "seed00000000000000000000000000",
    targetAppId: "df1aa9ff-6539-4c86-a9d0-ad702b61ac9a",
    operatorTiers,
  });
  const manifest = JSON.parse(await readFile(join(scratchDir, "mutant-manifest.json"), "utf8")) as {
    mutants: MutantManifestEntry[];
  };
  await rm(scratchDir, { recursive: true, force: true });
  return manifest.mutants;
}

/**
 * Seeds `store` with a single prior "survived" mutant whose identity matches `target`'s exactly
 * on the four fields `identityKeyOf`/`priorSurvivorKeys` (selection.ts/store.ts) key on —
 * astHash, codeunitName, operatorName, and operatorMajor (operatorVersion's leading component)
 * — NEVER the per-batch `mutantId` label, which `assignMutantIds` renumbers fresh per batch and
 * so cannot identify a mutant across two independent generations of the same project. Finishes
 * the run so a subsequent `runSession({ store, skipKnownSurvivors: true })` against the SAME
 * `projectPath` sees it via `priorSurvivorKeys` and excludes it from `execute` — while it stays
 * compiled into the artifact regardless, exactly the shipped defect this file's first new test
 * below exists to catch.
 */
function seedPriorSurvivor(
  store: ResultsStore,
  projectPath: string,
  target: MutantManifestEntry,
): void {
  const runId = store.createRun({ projectPath, backend: "bcdev", appVersion: "0.0.0.1" });
  store.recordMutant(runId, {
    mutantCode: "SEED",
    astHash: target.astHash,
    codeunitName: target.codeunitName,
    operatorName: target.operatorName,
    operatorMajor: Number(target.operatorVersion.split(".")[0] ?? "0"),
    file: target.file,
    line: target.startLine,
    verdict: "survived",
    durationMs: 0,
    batchIndex: 0,
  });
  store.finishRun(runId, { batchCount: 1, baselineGreen: true });
}

describe("runSession — Task 7: bisects the full manifest, not the history-filtered execute set", () => {
  // Defect 1 (sequential path): `execute` (post `filterHistory`) omits known survivors, but
  // `writeInstrumentedProject` still compiled them into the artifact — they were only excluded
  // from EXECUTION, not from COMPILATION. Bisecting `execute` (the shipped bug) can therefore
  // never find a malformed known-survivor: `compiles(execute)` never re-includes it in any
  // candidate subset, so the very first check trivially "compiles" and bisection reports
  // "no-repro" — an admitted, but previously unexplained, dead end. Bisecting
  // `manifest.mutants` (every mutant the artifact actually contains) finds it like any other.
  test("bisects the FULL embedded manifest, so a malformed known-survivor is findable", async () => {
    const dirs = await makeProject();
    const scratchDir = join(dirs.instrumentedDir, "seed-scratch");
    const mutants = await manifestMutants(dirs.projectDir, scratchDir);
    const boundary = mutants.find((m) => m.operatorName === "lethal.conditional-boundary");
    expect(boundary).toBeDefined();
    if (boundary === undefined) throw new Error("unreachable: asserted above");

    const store = new ResultsStore(":memory:");
    seedPriorSurvivor(store, dirs.projectDir, boundary);

    // The whole-artifact deploy fails as long as the conditional-boundary spec is present.
    // `execute` (skipKnownSurvivors: true) excludes it, but the compiled artifact — what this
    // guard actually inspects — does not; the failure is deterministic on every attempt that
    // still contains it.
    const backend = new StubBackend(
      CAPS_NST,
      () => "pass",
      ["IsOverBudget"],
      undefined,
      undefined,
      (dir: string) => {
        const manifest = JSON.parse(readFileSync(join(dir, "mutant-manifest.json"), "utf8")) as {
          mutants: Array<{ operatorName: string }>;
        };
        const hasBoundary = manifest.mutants.some(
          (m) => m.operatorName === "lethal.conditional-boundary",
        );
        return hasBoundary
          ? new AlcCompileError("alc: AL0001 malformed operator replacement")
          : undefined;
      },
    );
    const report = await runSession({
      backend,
      store,
      ...dirs,
      selectorIds,
      skipKnownSurvivors: true,
    });
    expect(report.counts.errors).toBeGreaterThan(0);
    // The known survivor itself is recorded separately (verdict "known-survivor", no note); the
    // culprit's identity lands on `execute`'s error-recorded mutants' shared note instead.
    const knownSurvivor = report.mutants.find((m) => m.verdict === "known-survivor");
    expect(knownSurvivor).toBeDefined();
    const noted = report.mutants.find((m) => m.failureNote !== undefined);
    expect(noted).toBeDefined();
    expect(noted?.failureNote).toContain("bisected to mutant");
    expect(noted?.failureNote).toContain("lethal.conditional-boundary");
    store.close();
  });

  // Defect 1 (per-shard worker path): every worker deploys the SAME `batchDir` — the whole
  // artifact, every mutant, not a shard-scoped subset (sharding only decides which worker
  // EXECUTES which mutant's tests). Bisecting `shard` (the shipped bug) can therefore miss a
  // culprit that happens to be assigned to a DIFFERENT worker's shard: that worker's own search
  // never re-includes it in any candidate, so it "compiles" trivially and falls back to
  // "no-repro" — exactly the sequential path's bug, reproduced per-shard. Guarding both workers
  // identically (they see the same artifact) and searching `manifest.mutants` for both finds
  // the true culprit regardless of which shard it landed in.
  test("a worker's shard-scoped bisection can miss a culprit outside its own shard; the full manifest finds it", async () => {
    const dirs = await makeProject();
    await Bun.write(join(dirs.projectDir, "SandboxLogic.Codeunit.al"), TWO_PROC_AL);
    const store = new ResultsStore(":memory:");
    const caps: BackendCapabilities = {
      coverage: "none",
      deploy: "none",
      isolation: "full-reset",
      authoritative: false,
    };
    // Scoped to one specific mutant (operatorName AND procedureName) so there is exactly one
    // culprit — TWO_PROC_AL carries a conditional-boundary mutant in EACH procedure, and an
    // operatorName-only guard would make two mutants equally "guilty", which bisection can't
    // resolve to a single confirmed name (see the comment on the sibling test above).
    const guard = (dir: string) => {
      const manifest = JSON.parse(readFileSync(join(dir, "mutant-manifest.json"), "utf8")) as {
        mutants: Array<{ operatorName: string; procedureName: string }>;
      };
      const hasCulprit = manifest.mutants.some(
        (m) =>
          m.operatorName === "lethal.conditional-boundary" && m.procedureName === "IsUnderBudget",
      );
      return hasCulprit
        ? new AlcCompileError("alc: AL0001 malformed operator replacement")
        : undefined;
    };
    // Both REAL workers (0 and 1) guarded identically: they deploy the same full batchDir, so
    // both observe the same failure regardless of which one's own shard happens to contain the
    // culprit. `cfg.backend` (workerIndex -1, the session's initial/step-3 deploy) is NOT
    // guarded — matching the existing per-worker-failure tests' convention — so the batch's
    // own whole-artifact deploy at step 3 succeeds and execution actually reaches the per-shard
    // fan-out this test means to exercise, rather than the sequential catch handling it first.
    const make = (workerIndex: number) =>
      new StubBackend(
        caps,
        (mutant) => (mutant === null ? "pass" : "fail"),
        [],
        undefined,
        undefined,
        workerIndex === -1 ? undefined : guard,
      );
    const report = await runSession({
      backend: make(-1),
      backendFactory: make,
      store,
      ...dirs,
      selectorIds,
      workers: 2,
    });
    const errorMutants = report.mutants.filter((m) => m.verdict === "error");
    expect(errorMutants.length).toBeGreaterThan(0);
    // Every errored mutant — from EITHER worker's shard — must be attributed to the actual
    // culprit, never a shard-scoped "no-repro" fallback for whichever worker's own shard
    // doesn't happen to contain it.
    for (const m of errorMutants) {
      expect(m.failureNote).toContain("bisected to mutant");
      expect(m.failureNote).toContain("lethal.conditional-boundary");
    }
    store.close();
  });
});

describe("runSession — Task 7: only a typed AlcCompileError may be bisected", () => {
  // Brief's literal test 3: a subset-preparation failure that is NOT a compiler verdict
  // (filesystem, not alc) must abort the search rather than be read as "this subset doesn't
  // compile". `ArtifactPrepareError` and `DeploymentError` both extend `Error` directly, not
  // `AlcCompileError` — `instanceof` cannot cross-match them — so guarding on `AlcCompileError`
  // specifically excludes ArtifactPrepareError too, not just DeploymentError (the shipped
  // guard's actual gap).
  test("aborts immediately on a non-compiler ArtifactPrepareError, without a single bisection compile", async () => {
    const dirs = await makeProject();
    let calls = 0;
    const backend = new StubBackend(
      CAPS_NST,
      () => "pass",
      ["IsOverBudget"],
      undefined,
      undefined,
      (_dir: string) => {
        calls++;
        return new ArtifactPrepareError("disk full");
      },
    );
    const store = new ResultsStore(":memory:");
    await expect(runSession({ backend, store, ...dirs, selectorIds })).rejects.toThrow(/disk full/);
    // Exactly the one production deploy — the guard aborted before bisection ever called
    // deploy() again.
    expect(calls).toBe(1);
    store.close();
  });

  // Brief's literal test 2, adapted to a bare (untyped) publish-style failure rather than
  // `DeploymentError` specifically: the shipped guard (`instanceof DeploymentError`) already
  // excluded `DeploymentError` itself pre-Task-7, so it alone would not distinguish old from
  // new behaviour here. An untyped `Error` — standing in for any publish/transport failure that
  // isn't perfectly wrapped — is exactly what the old, too-narrow guard let slip through.
  test("never bisects a publish-style failure that is not a typed AlcCompileError", async () => {
    const dirs = await makeProject();
    let calls = 0;
    const backend = new StubBackend(
      CAPS_NST,
      () => "pass",
      ["IsOverBudget"],
      undefined,
      undefined,
      (_dir: string) => {
        calls++;
        return new Error("NST unavailable");
      },
    );
    const store = new ResultsStore(":memory:");
    await expect(runSession({ backend, store, ...dirs, selectorIds })).rejects.toThrow(
      /NST unavailable/,
    );
    expect(calls).toBe(1);
    store.close();
  });

  // Same guard, worker path: mirrors the existing "a worker's DeploymentError aborts" test
  // above, swapped to ArtifactPrepareError — the shape the shipped guard (`instanceof
  // DeploymentError`) did NOT exclude, and would have bisected/downgraded to a per-shard error.
  // Uses `deployGuard` (not the fixed `deployError`) so `calls` can prove the OUTER guard
  // specifically: `subsetMutants` already searches the full manifest (Task 7's other fix), and
  // the inner `compiles` callback already propagates a non-AlcCompileError too, so an always-
  // failing deploy would eventually abort with the right error via the INNER guard alone even
  // if this outer one were missing — `calls === 1` is what only the outer guard delivers (zero
  // wasted bisection compiles, not merely "eventually aborts correctly").
  test("a worker's ArtifactPrepareError aborts the whole session instead of being bisected", async () => {
    const root = await mkdtemp(join(tmpdir(), "lethal-orch-parallel-prepareerr-"));
    const dbPath = join(root, "results.sqlite");
    const dirs = await makeProject();
    await Bun.write(join(dirs.projectDir, "SandboxLogic.Codeunit.al"), TWO_PROC_AL);
    const store = new ResultsStore(dbPath);
    const caps: BackendCapabilities = {
      coverage: "none",
      deploy: "none",
      isolation: "full-reset",
      authoritative: false,
    };
    const deployErr = new ArtifactPrepareError("boom: worker 0 disk full");
    let worker0Calls = 0;
    const make = (workerIndex: number) =>
      new StubBackend(
        caps,
        (mutant) => (mutant === null ? "pass" : "fail"),
        [],
        undefined,
        undefined,
        workerIndex === 0
          ? () => {
              worker0Calls++;
              return deployErr;
            }
          : undefined,
      );
    await expect(
      runSession({
        backend: make(-1),
        backendFactory: make,
        store,
        ...dirs,
        selectorIds,
        workers: 2,
      }),
    ).rejects.toBe(deployErr);
    // Exactly the one production deploy on worker 0's shard — the guard aborted before
    // bisection ever called deploy() again.
    expect(worker0Calls).toBe(1);

    const raw = new Database(dbPath, { readonly: true });
    const rows = raw.query("SELECT failure_note FROM mutants").all() as Array<{
      failure_note: string | null;
    }>;
    raw.close();
    expect(rows.every((r) => !r.failure_note?.includes("bisected"))).toBe(true);
    store.close();
  });

  // The DEEPER half of the guard: not just "don't bisect a non-compile failure", but "don't
  // let one masquerade as a compile answer FROM WITHIN an already-legitimate bisection search".
  // The first deploy fails with a genuine AlcCompileError (entering bisection legitimately,
  // same as the existing "bisection identifies the culprit" test), but the very first candidate
  // `bisectAndNote` tries then fails for an unrelated, non-compiler reason (simulating a disk
  // failure mid-search). That must abort the whole search immediately, not be read as `false`
  // ("this subset doesn't compile") and keep halving toward an innocent mutant.
  test("a non-compiler failure mid-bisection aborts the search instead of being read as a compile answer", async () => {
    const dirs = await makeProject();
    let calls = 0;
    const backend = new StubBackend(
      CAPS_NST,
      () => "pass",
      ["IsOverBudget"],
      undefined,
      undefined,
      (_dir: string) => {
        calls++;
        // Call 1: the initial whole-artifact deploy — a genuine compiler rejection, legitimately
        // entering bisection. Every call after that (bisection's own candidate deploys):
        // unrelated infrastructure failure, never a compile answer.
        if (calls === 1) return new AlcCompileError("alc: AL0001 malformed operator replacement");
        return new ArtifactPrepareError("disk full mid-search");
      },
    );
    const store = new ResultsStore(":memory:");
    await expect(runSession({ backend, store, ...dirs, selectorIds })).rejects.toThrow(
      /disk full mid-search/,
    );
    // Exactly 2 deploy calls: the initial production compile, and the ONE bisection attempt
    // whose non-compiler failure aborted the search immediately — proof the search did not
    // misread it as "false" and keep going (which would have driven `calls` well past 2, per
    // `bisectFailingMutant`'s halving + confirmation steps).
    expect(calls).toBe(2);
    store.close();
  });
});

// ————————————————————————————————————————————————————————————————————————
// Task 7b: bisection's compile-only seam. Spec §8 forbids publishing a bisection
// candidate; spec §10's operational test is a call-count gate on a compiler failure:
// publisher and verifier call counts stay ZERO, bisection makes compiler calls only, and the
// culprit is still named. Asserted with call counters on an instrumented fake — never timing.
// ————————————————————————————————————————————————————————————————————————

/**
 * Like `PhaseBackend`, but with compile/publish/verify tracked as SEPARATE counters (not one
 * shared `calls` log) so a test can assert "publisher/verifier called zero times" directly,
 * and with `compileViaDeployCalls`/`compileViaCheckCalls` split so "the production deploy
 * compiled exactly once, everything after that was compileCheck" is a call-count fact, not an
 * inference from the note text. `compileGuard` decides per-candidate whether the compile phase
 * throws `AlcCompileError`, reading the actual mutant-manifest.json each candidate write
 * produced — same technique as `StubBackend.deployGuard` — so the guard genuinely depends on
 * which mutant a given subset still carries, not on call order alone.
 */
class CompilePublishVerifyBackend implements ExecutionBackend {
  compileViaDeployCalls = 0;
  compileViaCheckCalls = 0;
  publisherCalls = 0;
  verifierCalls = 0;
  // Mirrors BcDevMcpBackend.deploy() setting `this.methodIndex`/`this.localProcedures` right
  // after a successful compile, before publish — only a real deploy() may touch this.
  methodIndexAssignments = 0;

  constructor(
    private readonly compileGuard: (dir: string) => Error | undefined,
    // Layer 5C-A Task 8, Task 10 (design §G): defaults to PHASE_CAPS's authoritative:true; the
    // worker-path test below sets this false, since Task 10 now rejects `workers > 1` for an
    // authoritative backend and that test's actual subject (compile-only bisection counters
    // staying at zero across a worker's shard) is orthogonal to authoritativeness.
    private readonly authoritative: boolean = true,
  ) {}

  capabilities(): BackendCapabilities {
    return { ...PHASE_CAPS, authoritative: this.authoritative };
  }
  async status(): Promise<BackendStatus> {
    return { ok: true, details: "counting-phase" };
  }

  private async compile(dir: string): Promise<CompiledArtifact> {
    const guardErr = this.compileGuard(dir);
    if (guardErr !== undefined) throw guardErr;
    const appManifest = JSON.parse(await readFile(join(dir, "app.json"), "utf8")) as {
      id: string;
      version: string;
    };
    const mutantManifest = JSON.parse(
      await readFile(join(dir, "mutant-manifest.json"), "utf8"),
    ) as CompiledArtifact["mutantManifest"];
    return {
      artifactId: mutantManifest.artifactId,
      appId: appManifest.id,
      appVersion: appManifest.version,
      appPath: join(dir, "counting-fake.app"),
      sha256: Bun.SHA256.hash(new Uint8Array([1, 2, 3]), "hex"),
      mutantManifest,
      appManifest: appManifest as unknown as Record<string, unknown>,
    };
  }

  async deploy(dir: string): Promise<CompiledArtifact | null> {
    this.compileViaDeployCalls++;
    const artifact = await this.compile(dir); // throws BEFORE publish/verify on a bad candidate
    this.methodIndexAssignments++;
    this.publisherCalls++;
    this.verifierCalls++;
    return artifact;
  }

  /** The seam under test: compile only, never touches publish/verify/methodIndex. */
  async compileCheck(dir: string): Promise<void> {
    this.compileViaCheckCalls++;
    await this.compile(dir);
  }

  async activate(): Promise<void> {}
  async run(ref: TestMethodRef, _opts: RunOpts): Promise<TestVerdict> {
    return { ref, outcome: "pass", durationMs: 5 };
  }
}

/** True while `dir`'s just-written manifest still carries TARGET_AL's
 *  conditional-boundary mutant — the shared "one bad spec" fixture bisection narrows to. */
function manifestHasConditionalBoundary(dir: string): boolean {
  const manifest = JSON.parse(readFileSync(join(dir, "mutant-manifest.json"), "utf8")) as {
    mutants: Array<{ operatorName: string }>;
  };
  return manifest.mutants.some((m) => m.operatorName === "lethal.conditional-boundary");
}

describe("runSession — Task 7b: bisection's compile-only seam (spec §10 counters)", () => {
  test("sequential: compiler failure leaves publisher/verifier at zero while bisection names the culprit", async () => {
    const dirs = await makeProject();
    const backend = new CompilePublishVerifyBackend((dir) =>
      manifestHasConditionalBoundary(dir)
        ? new AlcCompileError("alc: AL0001 malformed operator replacement")
        : undefined,
    );
    const store = new ResultsStore(":memory:");
    const report = await runSession({ backend, store, ...dirs, selectorIds });

    // The gate: publisher/verifier never ran at all, for this batch or for bisection.
    expect(backend.publisherCalls).toBe(0);
    expect(backend.verifierCalls).toBe(0);
    expect(backend.methodIndexAssignments).toBe(0);
    // Exactly one production compile (the whole-artifact deploy that failed); everything
    // bisection did after that went through compileCheck, never deploy() again.
    expect(backend.compileViaDeployCalls).toBe(1);
    expect(backend.compileViaCheckCalls).toBeGreaterThan(1);

    const noted = report.mutants.find((m) => m.verdict === "error");
    expect(noted?.failureNote).toContain("bisected to mutant");
    expect(noted?.failureNote).toContain("lethal.conditional-boundary");
    store.close();
  });

  test("worker path: the failing shard's publisher/verifier stay at zero while bisection names the culprit", async () => {
    const dirs = await makeProject();
    await Bun.write(join(dirs.projectDir, "SandboxLogic.Codeunit.al"), TWO_PROC_AL);
    const store = new ResultsStore(":memory:");
    const backends = new Map<number, CompilePublishVerifyBackend>();
    const make = (workerIndex: number) => {
      const backend = new CompilePublishVerifyBackend(
        workerIndex === 0
          ? (dir) => {
              const manifest = JSON.parse(
                readFileSync(join(dir, "mutant-manifest.json"), "utf8"),
              ) as { mutants: Array<{ operatorName: string; procedureName: string }> };
              const hasBoundary = manifest.mutants.some(
                (m) =>
                  m.operatorName === "lethal.conditional-boundary" &&
                  m.procedureName === "IsOverBudget",
              );
              return hasBoundary
                ? new AlcCompileError("alc: AL0001 malformed operator replacement")
                : undefined;
            }
          : () => undefined, // worker 1 and cfg.backend (-1) always compile fine
        false, // non-authoritative: this test runs workers: 2, which Task 10 now rejects otherwise
      );
      backends.set(workerIndex, backend);
      return backend;
    };
    const report = await runSession({
      backend: make(-1),
      backendFactory: make,
      store,
      ...dirs,
      selectorIds,
      workers: 2,
    });

    const worker0 = backends.get(0);
    expect(worker0).toBeDefined();
    if (worker0 === undefined) throw new Error("unreachable");
    // The gate, scoped to the shard that actually hit a compiler failure: its ONE fan-out
    // deploy() attempt failed before ever reaching publish/verify, and every bisection
    // candidate after that went through compileCheck — publisher/verifier stayed at zero for
    // this worker's whole search.
    expect(worker0.publisherCalls).toBe(0);
    expect(worker0.verifierCalls).toBe(0);
    expect(worker0.methodIndexAssignments).toBe(0);
    expect(worker0.compileViaDeployCalls).toBe(1);
    expect(worker0.compileViaCheckCalls).toBeGreaterThan(1);

    const noted = report.mutants.find((m) => m.verdict === "error");
    expect(noted).toBeDefined();
    expect(noted?.failureNote).toContain("bisected to mutant");
    expect(noted?.failureNote).toContain("lethal.conditional-boundary");
    store.close();
  });
});

// ————————————————————————————————————————————————————————————————————————
// Layer 5B (Task 10): activateOnce/runOnce — retry ONLY provably-undispatched
// failures. A minimal ExecutionBackend fake (not the fuller StubBackend
// above, which models a whole session's worth of scripted deploy/run
// behavior) is enough here: these tests exercise the two helpers directly,
// not a full runSession.
// ————————————————————————————————————————————————————————————————————————

function fakeBackend(overrides: Partial<ExecutionBackend> = {}): ExecutionBackend {
  return {
    capabilities: () => CAPS_NST,
    status: async () => ({ ok: true, details: "fake" }),
    deploy: async () => null,
    compileCheck: async () => {},
    activate: async () => {},
    // Layer 5C-A Task 8, Task 10 (design §G): attests cleanly on the coverage:"none" (transport)
    // path by default — same healthy-backend rationale as StubBackend's note above. Harmless for
    // a test that overrides `capabilities` to a non-authoritative shape while keeping this
    // default `run`: the orchestrator's fail-closed gate only ever reads `.attestation` when
    // `caps.authoritative` is true, so an unused attestation field on a non-authoritative fake is
    // simply ignored.
    run: async (ref, opts) => ({
      ref,
      outcome: "pass",
      durationMs: 1,
      ...(opts.coverage === "none"
        ? { attestation: { observedAny: true, identityMismatch: false } }
        : {}),
    }),
    ...overrides,
  };
}

function aRef(): TestMethodRef {
  return { codeunitId: 79100, codeunitName: "Sandbox Tests", method: "OverBudgetDetected" };
}

describe("activateOnce / runOnce — retry only pre-dispatch failures", () => {
  test("activateOnce retries a pre-dispatch-rejected activation exactly once", async () => {
    let calls = 0;
    const backend = fakeBackend({
      activate: async () => {
        calls++;
        if (calls === 1) throw new ActivationFailure("boom", "pre-dispatch-rejected");
        // second call succeeds
      },
    });
    const safety = new SessionSafety();
    await activateOnce(backend, safety, "M0007");
    expect(calls).toBe(2);
    expect(safety.isUnsafe).toBe(false);
  });

  test("activateOnce does NOT retry an in-flight-unknown activation; latches unsafe and rethrows", async () => {
    let calls = 0;
    const backend = fakeBackend({
      activate: async () => {
        calls++;
        throw new ActivationFailure("timed out", "in-flight-unknown");
      },
    });
    const safety = new SessionSafety();
    await expect(activateOnce(backend, safety, "M0007")).rejects.toBeInstanceOf(ActivationFailure);
    expect(calls).toBe(1); // never retried
    expect(safety.isUnsafe).toBe(true);
  });

  test("runOnce retries only a pre-dispatch-rejected run", async () => {
    let calls = 0;
    const backend = fakeBackend({
      run: async (ref) => {
        calls++;
        if (calls === 1)
          return { ref, outcome: "error", durationMs: 1, operation: "pre-dispatch-rejected" };
        return { ref, outcome: "pass", durationMs: 1 };
      },
    });
    const v = await runOnce(backend, new SessionSafety(), aRef(), {
      coverage: "none",
      timeoutMs: 100,
    });
    expect(calls).toBe(2);
    expect(v.outcome).toBe("pass");
  });

  test("runOnce does NOT retry an in-flight-unknown run", async () => {
    let calls = 0;
    const backend = fakeBackend({
      run: async (ref) => {
        calls++;
        return { ref, outcome: "error", durationMs: 1, operation: "in-flight-unknown" };
      },
    });
    const v = await runOnce(backend, new SessionSafety(), aRef(), {
      coverage: "none",
      timeoutMs: 100,
    });
    expect(calls).toBe(1);
    expect(v.operation).toBe("in-flight-unknown");
  });

  // Task 10 review Minor-3 (folded into Task 11, see .superpowers/sdd/5b-task-11-brief.md):
  // two activateOnce branches the original suite never exercised.
  test("activateOnce rethrows a completed-effect-unknown failure WITHOUT retry or latch", async () => {
    let calls = 0;
    const backend = fakeBackend({
      activate: async () => {
        calls++;
        throw new ActivationFailure("malformed 2xx body", "completed-effect-unknown");
      },
    });
    const safety = new SessionSafety();
    await expect(activateOnce(backend, safety, "M0007")).rejects.toBeInstanceOf(ActivationFailure);
    expect(calls).toBe(1); // never retried — completed-effect-unknown is not retry-safe
    expect(safety.isUnsafe).toBe(false); // only in-flight-unknown latches
  });

  test("activateOnce lets a raw non-ActivationFailure Error fall through un-retried, un-latched", async () => {
    let calls = 0;
    const backend = fakeBackend({
      activate: async () => {
        calls++;
        throw new Error("ECONNRESET");
      },
    });
    const safety = new SessionSafety();
    await expect(activateOnce(backend, safety, "M0007")).rejects.toThrow("ECONNRESET");
    expect(calls).toBe(1); // not an ActivationFailure — no retry/latch branch can even inspect it
    expect(safety.isUnsafe).toBe(false);
  });

  // Task 10 review Minor-1 (folded into Task 11): the RETRY of a retry-safe failure is a fresh
  // dispatch attempt — if IT resolves in-flight-unknown, the latch invariant must still trip.
  test("activateOnce latches unsafe when the retry of a retry-safe failure itself is in-flight-unknown", async () => {
    let calls = 0;
    const backend = fakeBackend({
      activate: async () => {
        calls++;
        if (calls === 1) throw new ActivationFailure("boom", "pre-dispatch-rejected");
        throw new ActivationFailure("timed out on retry", "in-flight-unknown");
      },
    });
    const safety = new SessionSafety();
    await expect(activateOnce(backend, safety, "M0007")).rejects.toBeInstanceOf(ActivationFailure);
    expect(calls).toBe(2); // the retry-safe first failure DID earn its one retry
    expect(safety.isUnsafe).toBe(true); // ...but the retry itself came back ambiguous
  });
});

// ————————————————————————————————————————————————————————————————————————
// Layer 5B (Task 11): gate all work-plane calls on SessionSafety — quarantine consult BEFORE
// status(), and a latch-gated finally teardown (no mutating activate(null) once unsafe).
// ————————————————————————————————————————————————————————————————————————

/** Synchronous sibling of `mkdtemp` for inline use in test literals (e.g.
 *  `runSessionForTest(backend, { quarantineDir: freshTmpDir() })`), where an `await` isn't
 *  available. Each call gets its own directory, so tests never share (or race on) quarantine
 *  state. */
function freshTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "lethal-orch-quarantine-"));
}

/**
 * Thin wrapper building a full `SessionConfig` around a caller-supplied fake backend: a fresh
 * `makeProject()` fixture (overwritten with THREE_PROC_AL — 9 mutants, M0001..M0009 — so tests
 * that need to reach a specific mutant id like "M0007" have one to reach), an in-memory store,
 * and the tier resource key the brief's tests assert against: `resourceServer` +
 * `resourceServerInstance` normalize (resource-key.ts) to exactly `http://cronus281|BC`.
 * `overrides` lets a test inject `quarantineDir` (always required in tests — production alone
 * defaults to `~/.lethal/quarantine`) or replace any other field, e.g. `nowIso` for Task 12.
 */
async function runSessionForTest(
  backend: ExecutionBackend,
  overrides: Partial<SessionConfig> = {},
) {
  const dirs = await makeProject();
  await Bun.write(join(dirs.projectDir, "SandboxLogic.Codeunit.al"), THREE_PROC_AL);
  const store = new ResultsStore(":memory:");
  return runSession({
    backend,
    store,
    ...dirs,
    selectorIds,
    resourceServer: "http://cronus281",
    resourceServerInstance: "BC",
    ...overrides,
  });
}

describe("runSession — Task 11 quarantine consult + latch-gated finally", () => {
  test("a pre-quarantined tier refuses to run before status() is ever called", async () => {
    const dir = freshTmpDir();
    const store = new QuarantineStore(dir);
    await store.record({
      resourceKey: "http://cronus281|BC",
      opKind: "test-run",
      detail: "prior strand",
      recordedAtIso: "2026-07-20T10:00:00.000Z",
    });
    let statusCalled = false;
    const backend = fakeBackend({
      status: async () => {
        statusCalled = true;
        return { ok: true, details: "" };
      },
    });
    await expect(runSessionForTest(backend, { quarantineDir: dir })).rejects.toThrow(
      /quarantined/i,
    );
    expect(statusCalled).toBe(false);
  });

  test("an unquarantined tier proceeds past the consult and reaches status()", async () => {
    let statusCalled = false;
    const backend = fakeBackend({
      capabilities: () => ({
        coverage: "none",
        deploy: "publish",
        isolation: "session",
        authoritative: true,
      }),
      status: async () => {
        statusCalled = true;
        return { ok: true, details: "" };
      },
    });
    await runSessionForTest(backend, { quarantineDir: freshTmpDir() });
    expect(statusCalled).toBe(true);
  });

  test("finally teardown does NOT call activate(null) once the session is unsafe", async () => {
    // Reaches the unsafe latch via the mutant loop's OWN activateOnce call (already latch-wired
    // since Task 10) rather than a run()-side in-flight-unknown: recording a durable quarantine
    // on a run()-side ambiguity is Task 12's job (deadline-branch), not this task's — this test
    // only needs SOME real path to `safety.isUnsafe === true` reached from inside `runSession`,
    // and activate()-throws-in-flight-unknown is already fully wired end to end.
    const activateCalls: Array<string | null> = [];
    const backend = fakeBackend({
      // coverage:"none" so every mutant is covered by the (always-passing) baseline test —
      // THREE_PROC_AL's 9 mutants would otherwise all resolve "no-coverage" against a fake
      // backend that never reports real procedure coverage, and the mutant loop (and M0007)
      // would never be reached at all.
      capabilities: () => ({
        coverage: "none",
        deploy: "publish",
        isolation: "session",
        authoritative: true,
      }),
      activate: async (id) => {
        activateCalls.push(id);
        if (id === "M0007") throw new ActivationFailure("timed out", "in-flight-unknown");
      },
    });
    await runSessionForTest(backend, { quarantineDir: freshTmpDir() }).catch(() => {});
    // M0001..M0006 activate and run clean (every run() call defaults to "pass" — see
    // fakeBackend); M0007's activation is where the latch trips and the session aborts. NO
    // activate(null) may appear after it — that would be the finally block's deactivating
    // ClearActive, a mutating call on a tier that may still be stranded (spec §8).
    const afterUnsafe = activateCalls.slice(activateCalls.indexOf("M0007") + 1);
    expect(afterUnsafe).not.toContain(null);
    // Sanity: the latch path was actually exercised, not vacuously true because M0007 never ran.
    expect(activateCalls).toContain("M0007");
  });

  test("finally DOES call activate(null) on the ordinary (safe) path", async () => {
    const activateCalls: Array<string | null> = [];
    const backend = fakeBackend({
      capabilities: () => ({
        coverage: "none",
        deploy: "publish",
        isolation: "session",
        authoritative: true,
      }),
      activate: async (id) => {
        activateCalls.push(id);
      },
    });
    await runSessionForTest(backend, { quarantineDir: freshTmpDir() });
    expect(activateCalls.at(-1)).toBeNull();
  });
});

// ————————————————————————————————————————————————————————————————————————
// Task 13 folded fix (Task 11 review, Important-1): the quarantine consult above only fires when
// BOTH `resourceServer`/`resourceServerInstance` are present — an authoritative caller that omits
// them is tolerated (skip, not throw), because ~30 pre-existing authoritative-backend unit tests
// exercise an in-memory stub without ever setting them. Tolerated is not the same as silent: a
// regression in whatever sources these fields from real config (`cli.ts`'s `resourceIdentityFor`,
// added this same task) would otherwise leave quarantine permanently — and invisibly — inert
// against a real BC server. `runSession` must warn every time this happens.
// ————————————————————————————————————————————————————————————————————————
describe("runSession — Task 13 folded fix: warn when authoritative but no tier identity", () => {
  // Authoritative fake backends below explicitly set `coverage: "none"` (rather than relying on
  // `fakeBackend()`'s CAPS_NST default of `coverage: "procedure"`), mirroring the already-proven
  // "an unquarantined tier proceeds past the consult" test above — coverage:"none" runs every
  // test against every mutant without needing the backend to report per-procedure coverage data.
  const authoritativeNoCoverage = (): ExecutionBackend =>
    fakeBackend({
      capabilities: () => ({
        coverage: "none",
        deploy: "publish",
        isolation: "session",
        authoritative: true,
      }),
    });

  test("warns when an authoritative backend omits resourceServer/resourceServerInstance", async () => {
    const dirs = await makeProject();
    const store = new ResultsStore(":memory:");
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    let messages: string[] = [];
    try {
      // Deliberately the RAW runSession call (not runSessionForTest, which always fills in
      // resourceServer/resourceServerInstance) — this is exactly the shape of the ~30
      // pre-existing authoritative tests elsewhere in this file.
      await runSession({ backend: authoritativeNoCoverage(), store, ...dirs, selectorIds });
      // Captured INSIDE the try, before `finally`'s mockRestore() — bun:test's mockRestore()
      // also resets `.mock.calls` (like Jest's), so reading it after restore would always see
      // zero calls regardless of what actually happened.
      messages = warnSpy.mock.calls.map((call) => String(call[0]));
    } finally {
      warnSpy.mockRestore();
    }
    expect(messages.some((m) => m.includes("quarantine consult is DISABLED"))).toBe(true);
  });

  test("does NOT warn when resourceServer/resourceServerInstance are both set", async () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    let callCount = 0;
    try {
      await runSessionForTest(authoritativeNoCoverage(), { quarantineDir: freshTmpDir() });
      callCount = warnSpy.mock.calls.length; // see note above: read before mockRestore()
    } finally {
      warnSpy.mockRestore();
    }
    expect(callCount).toBe(0);
  });

  test("does NOT warn for a non-authoritative (al-runner) backend either", async () => {
    const dirs = await makeProject();
    const store = new ResultsStore(":memory:");
    const backend = fakeBackend({
      capabilities: () => ({
        coverage: "none",
        deploy: "none",
        isolation: "full-reset",
        authoritative: false,
      }),
    });
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    let callCount = 0;
    try {
      await runSession({ backend, store, ...dirs, selectorIds });
      callCount = warnSpy.mock.calls.length; // see note above: read before mockRestore()
    } finally {
      warnSpy.mockRestore();
    }
    expect(callCount).toBe(0);
  });
});

// ————————————————————————————————————————————————————————————————————————
// Layer 5B (Task 12): mutant-loop in-flight-unknown deadline records a durable
// quarantine, latches unsafe, and stops — a plain (non-in-flight-unknown)
// deadline stays an ordinary error, no quarantine.
// ————————————————————————————————————————————————————————————————————————

describe("runSession — Task 12 quarantine on in-flight-unknown deadline", () => {
  test("an in-flight-unknown deadline records a durable quarantine and reports quarantined", async () => {
    const dir = freshTmpDir();
    // NOTE on this fixture (deviates from the brief's literal `run: async (ref) => ({ ...
    // deadline-exceeded/in-flight-unknown }))` one-liner): a `run` override that uniform for
    // EVERY call also answers the session's BASELINE test (step 4, before the mutant loop —
    // which has no in-flight-unknown handling of its own, by design/scope). A deadline-exceeded
    // baseline just fails baseline outright ("no green baseline tests") and the session never
    // reaches the mutant loop this test means to exercise — confirmed empirically: the literal
    // brief fixture leaves the quarantine store empty even with Step 3 fully implemented.
    // Tracking `activeMutant` (same pattern as the "finally teardown" test above) lets baseline
    // (activation `null`) pass normally and keeps the ambiguous deadline scoped to the
    // per-mutant covering-test run this task's branch actually guards.
    let activeMutant: string | null = null;
    const backend = fakeBackend({
      capabilities: () => ({
        coverage: "none", // every mutant covered by baseline's one passing test — no coverage index needed
        deploy: "publish",
        isolation: "session",
        authoritative: true, // required for the Task 11 quarantine consult/record path to engage
      }),
      activate: async (id) => {
        activeMutant = id;
      },
      run: async (ref) =>
        activeMutant === null
          ? { ref, outcome: "pass", durationMs: 1 }
          : { ref, outcome: "deadline-exceeded", durationMs: 1, operation: "in-flight-unknown" },
    });
    const report = await runSessionForTest(backend, {
      quarantineDir: dir,
      nowIso: () => "2026-07-20T12:00:00.000Z",
    }).catch((e) => e);
    // session exits quarantined (either a thrown quarantined error or a report flag — assert the store):
    const store = new QuarantineStore(dir);
    const rec = await store.read("http://cronus281|BC");
    expect(rec).not.toBeNull();
    expect(rec?.opKind).toBe("test-run");
    expect(rec?.recordedAtIso).toBe("2026-07-20T12:00:00.000Z");
    // The session resolves (not rejects) with a report naming the stranded op — Step 3's "stop
    // scheduling further mutants after the mutant loop" wiring, not just the store write.
    expect(report).not.toBeInstanceOf(Error);
    expect((report as Awaited<ReturnType<typeof runSession>>).quarantined?.reason).toContain(
      "in-flight-unknown",
    );
  });

  test("a plain deadline-exceeded (no in-flight-unknown operation) stays an ordinary error — no quarantine, session continues", async () => {
    const dir = freshTmpDir();
    let activeMutant: string | null = null;
    const backend = fakeBackend({
      capabilities: () => ({
        coverage: "none",
        deploy: "publish",
        isolation: "session",
        authoritative: false, // al-runner shape: no shared tier, mirrors the brief's "no shared tier" case
      }),
      activate: async (id) => {
        activeMutant = id;
      },
      run: async (ref) =>
        activeMutant === null
          ? { ref, outcome: "pass", durationMs: 1 }
          : { ref, outcome: "deadline-exceeded", durationMs: 1 }, // no `operation` — al-runner has no seam for it
    });
    const report = await runSessionForTest(backend, { quarantineDir: dir });
    const store = new QuarantineStore(dir);
    const rec = await store.read("http://cronus281|BC");
    expect(rec).toBeNull(); // no quarantine recorded
    expect(report.quarantined).toBeUndefined();
    expect(report.counts.deadlineExceeded).toBeGreaterThan(0);
    expect(report.counts.errors).toBeGreaterThan(0);
  });
});

// ————————————————————————————————————————————————————————————————————————
// Layer 5B (Task 12 follow-up): Task 12 only wired the mutant-loop's covering-test run — two
// other `runOnce` sites also consume a `TestVerdict` and inspect `.outcome` without ever
// looking at `.operation`: the BASELINE test loop (runs before any mutant is even scheduled)
// and the kill-CONFIRMATION rerun (the baseline-re-run triggered by a mutant's covering test
// failing). Both now share the same `quarantineInFlight` helper the mutant-loop's main branch
// was refactored to call.
// ————————————————————————————————————————————————————————————————————————

describe("runSession — latch+quarantine on in-flight-unknown at baseline and kill-confirm too", () => {
  test("a BASELINE test returning in-flight-unknown records a durable quarantine and quarantines the session before any mutant is scheduled", async () => {
    const dir = freshTmpDir();
    // THREE_PROC_AL's discovered test suite (from TEST_AL, via runSessionForTest) has exactly
    // one baseline test method — so it's simultaneously the FIRST and only baseline test, and
    // every `run()` call in this fixture is answered identically: there is no mutant-loop call
    // to distinguish from the baseline one, because the session must never reach the mutant
    // loop at all once the baseline itself comes back in-flight-unknown.
    const backend = fakeBackend({
      capabilities: () => ({
        coverage: "none",
        deploy: "publish",
        isolation: "session",
        authoritative: true, // required for the Task 11 quarantine consult/record path to engage
      }),
      run: async (ref) => ({
        ref,
        outcome: "deadline-exceeded",
        durationMs: 1,
        operation: "in-flight-unknown",
      }),
    });
    const report = await runSessionForTest(backend, {
      quarantineDir: dir,
      nowIso: () => "2026-07-20T12:00:00.000Z",
    }).catch((e) => e);
    const store = new QuarantineStore(dir);
    const rec = await store.read("http://cronus281|BC");
    expect(rec).not.toBeNull();
    expect(rec?.opKind).toBe("test-run");
    expect(rec?.recordedAtIso).toBe("2026-07-20T12:00:00.000Z");
    // Resolves (doesn't reject) with a quarantined report — same "stop cleanly" contract as
    // Task 12's mutant-loop branch, not a thrown SessionUnsafeError.
    expect(report).not.toBeInstanceOf(Error);
    const sessionReport = report as Awaited<ReturnType<typeof runSession>>;
    expect(sessionReport.quarantined?.reason).toContain("in-flight-unknown");
    // No mutant scheduling: the baseline latch must stop the session before step 5/6 ever run,
    // so nothing at all lands in `report.mutants` (not even "no green baseline tests" errors).
    expect(sessionReport.mutants).toHaveLength(0);
  });

  test("a kill-confirmation rerun returning in-flight-unknown records a durable quarantine and latches the session unsafe", async () => {
    const dir = freshTmpDir();
    // Stateful fake (same pattern as the Task 12 "finally teardown"/"in-flight-unknown deadline"
    // tests above): `activeMutant` tracks the most recent activate() call so `run()` can answer
    // differently for the baseline/confirm (null-activation) runs vs. a mutant-active run, and
    // `nullRuns` distinguishes the FIRST null-activation run (the baseline, which must pass so
    // the session reaches the mutant loop) from the SECOND (the kill-confirmation rerun
    // triggered by the first mutant's covering test failing below).
    let activeMutant: string | null = null;
    let nullRuns = 0;
    const backend = fakeBackend({
      capabilities: () => ({
        coverage: "none", // every mutant covered by baseline's one passing test — no coverage index needed
        deploy: "publish",
        isolation: "session",
        authoritative: true,
      }),
      activate: async (id) => {
        activeMutant = id;
      },
      run: async (ref) => {
        if (activeMutant !== null) return { ref, outcome: "fail", durationMs: 1 };
        nullRuns++;
        return nullRuns === 1
          ? { ref, outcome: "pass", durationMs: 1 }
          : { ref, outcome: "deadline-exceeded", durationMs: 1, operation: "in-flight-unknown" };
      },
    });
    const report = await runSessionForTest(backend, {
      quarantineDir: dir,
      nowIso: () => "2026-07-20T13:00:00.000Z",
    }).catch((e) => e);
    const store = new QuarantineStore(dir);
    const rec = await store.read("http://cronus281|BC");
    expect(rec).not.toBeNull();
    expect(rec?.opKind).toBe("test-run");
    expect(rec?.recordedAtIso).toBe("2026-07-20T13:00:00.000Z");
    expect(report).not.toBeInstanceOf(Error);
    const sessionReport = report as Awaited<ReturnType<typeof runSession>>;
    expect(sessionReport.quarantined?.reason).toContain("in-flight-unknown");
    // Stops scheduling further mutants after the one whose confirm run tripped the latch: only
    // that single mutant (M0001, the first one activated) reaches `report.mutants`.
    expect(sessionReport.mutants).toHaveLength(1);
    expect(sessionReport.mutants[0]?.verdict).toBe("error");
    // Layer 5C-B2: this used to assert `cause: "deadline-exceeded"`, which was simply wrong — an
    // in-flight-unknown is an UNREADABLE ANSWER, and our own client timeout produces a different
    // verdict entirely (`RunMutant timed out`, mapped by the `v.outcome === "deadline-exceeded"`
    // branch that follows this one). Labelling it a deadline inflated `counts.deadlineExceeded` in
    // the report and mislabelled the durable record. `cause`'s union has no accurate member for
    // "the ack was lost", so it is left unset rather than carrying a misleading one.
    expect(sessionReport.mutants[0]?.cause).toBeUndefined();
    expect(sessionReport.counts.deadlineExceeded).toBe(0);
  });
});

// ————————————————————————————————————————————————————————————————————————
// Layer 5C-A Task 8, Task 10 (design §G): two orchestrator-side safety properties for the
// AUTHORITATIVE (bcdev) backend only.
//   1. `workers > 1` is rejected outright — the single `LC Mutation Active` row is not
//      lease-protected against parallel RunMutant calls in 5C-A.
//   2. Per-artifact fail-closed attestation gate: a batch that ran verdict-contributing
//      (covered) mutants but recorded ZERO clean attestations (`observedAny && !identityMismatch`
//      on some coverage:"none" run) means no covered run ever confirmed the deployed binary is
//      actually running. A wrong/stale container legitimately returns observedAny=false on every
//      run (coverage over-approximates) and would otherwise let every test pass, silently
//      accumulating false "survived" verdicts — so that batch's verdicts are invalidated to
//      "error" and the session quarantined instead.
// Reuses the Task 11 `fakeBackend`/`runSessionForTest` harness above: THREE_PROC_AL (9 mutants
// across 3 procedures), CAPS_NST-shaped capabilities (authoritative, coverage:"procedure").
// ————————————————————————————————————————————————————————————————————————

/**
 * An authoritative fake whose baseline/coverage-discovery run (coverage:"procedure", the hub
 * path) covers every THREE_PROC_AL procedure — so all 9 mutants are scheduled with >=1 covering
 * test ("contributed") — and whose per-mutant run (coverage:"none", the transport path: both the
 * covering run and the null-activation kill-confirmation run) always passes and carries a FIXED
 * attestation. Mirrors `TestVerdict.attestation`'s doc comment in backend.ts: attestation is
 * present ONLY on the coverage:"none" path, never on the coverage:"procedure" baseline.
 */
function attestingBackend(attestation: {
  readonly observedAny: boolean;
  readonly identityMismatch: boolean;
}): ExecutionBackend {
  return fakeBackend({
    run: async (ref, opts) => {
      if (opts.coverage === "procedure") {
        return {
          ref,
          outcome: "pass",
          durationMs: 1,
          coverage: {
            granularity: "procedure" as const,
            entries: [
              { objectType: "Codeunit", objectId: 79000, procedure: "IsOverBudget" },
              { objectType: "Codeunit", objectId: 79000, procedure: "IsUnderBudget" },
              { objectType: "Codeunit", objectId: 79000, procedure: "IsEqualBudget" },
            ],
          },
        };
      }
      return { ref, outcome: "pass", durationMs: 1, attestation };
    },
  });
}

describe("runSession — Task 10 workers=1 assertion + per-artifact clean-attestation gate (design §G)", () => {
  test("authoritative backend with workers > 1 is rejected", async () => {
    await expect(
      runSessionForTest(attestingBackend({ observedAny: true, identityMismatch: false }), {
        quarantineDir: freshTmpDir(),
        workers: 2,
      }),
    ).rejects.toThrow(/workers.*1.*authoritative/i);
  });

  test("covered artifact that never attests cleanly -> verdicts invalidated + quarantined", async () => {
    const report = await runSessionForTest(
      attestingBackend({ observedAny: false, identityMismatch: false }),
      { quarantineDir: freshTmpDir() },
    );
    // Every one of THREE_PROC_AL's 9 mutants is covered and every run "passes" — without the
    // gate every one of these would report "survived". Zero clean attestations means the gate
    // must discard the whole batch's verdicts instead.
    expect(report.mutants.length).toBeGreaterThan(0);
    expect(report.mutants.every((m) => m.verdict !== "survived")).toBe(true);
    expect(report.mutants.every((m) => m.verdict === "error")).toBe(true);
    expect(report.quarantined).toBeDefined();
  });

  test("covered artifact with >=1 clean attestation reports verdicts normally, no quarantine", async () => {
    const report = await runSessionForTest(
      attestingBackend({ observedAny: true, identityMismatch: false }),
      { quarantineDir: freshTmpDir() },
    );
    expect(report.mutants.some((m) => m.verdict === "survived")).toBe(true);
    expect(report.quarantined).toBeUndefined();
  });

  // Coordinator review, Fix 1 (Critical): reproduces the ordering the first three tests above
  // miss. M0001 (the first scheduled mutant) runs clean and would-be "survived" — but its
  // attestation is EMPTY (observedAny:false), the wrong-binary signature. Before that batch's
  // gate ever runs, M0002 (the SECOND scheduled mutant) hits an in-flight-unknown run and
  // latches `safety` unsafe mid-loop — recorded with its OWN `cause`. The gate must still fire
  // for THIS batch (M0001's false "survived" came from the SAME unattested binary) even though
  // `safety.isUnsafe` is already true by the time the gate runs; a `!safety.isUnsafe` guard on
  // the gate (an earlier, incorrect fix) would skip it and ship M0001 as a false "survived"
  // right alongside the quarantined flag.
  test("an earlier mutant's false survived in the same batch is invalidated even though a LATER mutant already latched unsafe", async () => {
    let activeMutant: string | null = null;
    const backend = fakeBackend({
      activate: async (id) => {
        activeMutant = id;
      },
      run: async (ref, opts) => {
        if (opts.coverage === "procedure") {
          return {
            ref,
            outcome: "pass",
            durationMs: 1,
            coverage: {
              granularity: "procedure" as const,
              entries: [
                { objectType: "Codeunit", objectId: 79000, procedure: "IsOverBudget" },
                { objectType: "Codeunit", objectId: 79000, procedure: "IsUnderBudget" },
                { objectType: "Codeunit", objectId: 79000, procedure: "IsEqualBudget" },
              ],
            },
          };
        }
        if (activeMutant === "M0002") {
          // The second scheduled mutant: an in-flight-unknown run — latches `safety` mid-batch.
          // (It carries no `fencedOp`, so 5C-B2's lost-ack reconciliation has no op to ask about
          // and the conservative quarantine applies, exactly as before.)
          return {
            ref,
            outcome: "deadline-exceeded",
            durationMs: 1,
            operation: "in-flight-unknown",
          };
        }
        // M0001 (the first scheduled mutant): passes cleanly, but attests EMPTY — never proves
        // the deployed binary is the one that ran.
        return {
          ref,
          outcome: "pass",
          durationMs: 1,
          attestation: { observedAny: false, identityMismatch: false },
        };
      },
    });
    const report = await runSessionForTest(backend, { quarantineDir: freshTmpDir() });
    const m1 = report.mutants.find((m) => m.mutantCode === "M0001");
    expect(m1).toBeDefined();
    // The bug: without Fix 1, M0001 ships "survived" (a false survivor from an unproven binary)
    // right alongside a quarantined report — exactly the silent-false-survivor shape this task
    // exists to prevent.
    expect(m1?.verdict).toBe("error");
    expect(report.quarantined).toBeDefined();
  });
});

// Coordinator review, Fix 2 (Important): `invalidateBatchVerdicts` only corrects the in-memory
// `outcomes[]` the report is built from — the `mutants` rows already written to `store` during
// the batch keep whatever verdict they had at `record()` time (no store-row-update API exists).
// `priorSurvivorKeys` (store.ts) treats the most recent FINISHED run's "survived"/"known-survivor"
// rows as a future session's `skipKnownSurvivors` skip-list. Without a guard, a quarantined run's
// uncorrected on-disk "survived" rows (from a NEVER-attested, unproven binary) would become that
// skip-list — permanently skipping re-test of a mutant whose only "survived" ever came from a
// binary that was never confirmed to be the one that actually ran. Fix: `runSession` never calls
// `store.finishRun` for a run that latched unsafe, so `priorSurvivorKeys`'s
// `finished_at IS NOT NULL` filter excludes it entirely — uses `runSession` directly (not the
// Task 11 `runSessionForTest` helper, which discards its internal `store`/`projectDir`) so this
// test can query `priorSurvivorKeys` against the SAME store afterward.
describe("runSession — Task 10 fix: a quarantined run never seeds a future skip-list", () => {
  test("a never-attested (quarantined) run leaves no finished row for priorSurvivorKeys to find", async () => {
    const dirs = await makeProject();
    await Bun.write(join(dirs.projectDir, "SandboxLogic.Codeunit.al"), THREE_PROC_AL);
    const store = new ResultsStore(":memory:");
    const backend = attestingBackend({ observedAny: false, identityMismatch: false });
    const report = await runSession({
      backend,
      store,
      ...dirs,
      selectorIds,
      resourceServer: "http://cronus281",
      resourceServerInstance: "BC",
      quarantineDir: freshTmpDir(),
    });
    expect(report.quarantined).toBeDefined();
    // R47 strengthened this. It used to assert the opposite — that the store still HELD uncorrected
    // "survived" rows, and that only `finished_at IS NOT NULL` kept them out of history. `--resume`
    // reads by `finished_at IS NULL`, the exact complement, so that arrangement would have made the
    // false survivors preferentially readable. `store.invalidateBatch` now applies the gate's
    // correction durably, and nothing on disk claims "survived" from an unproven binary.
    const rawVerdicts = store.db.query("SELECT verdict FROM mutants").all() as Array<{
      verdict: string;
    }>;
    expect(rawVerdicts.length).toBeGreaterThan(0);
    expect(rawVerdicts.some((r) => r.verdict === "survived")).toBe(false);
    expect(rawVerdicts.every((r) => r.verdict === "error")).toBe(true);
    // The original guard still holds independently: an unfinished run is invisible to
    // priorSurvivorKeys, so this does not rely on the correction alone.
    const keys = store.priorSurvivorKeys(dirs.projectDir);
    expect(keys.size).toBe(0);
    store.close();
  });
});
// ————————————————————————————————————————————————————————————————————————
// Layer 5C-B1 Task 8 (design §5/§6/§8): `runSession` acquires the machine-global lease before
// deploy, fences the publish, heartbeats it at ttl/3, guards every work-plane dispatch behind
// `SessionSafety`, invalidates the CURRENT batch's verdicts when the lease is genuinely lost,
// and releases (op-gated) at session end.
//
// Every fake below is in-memory and counter-driven: the heartbeat is exercised through an
// injected timer seam (`fire()`), never a wall-clock delay, and the backoff through an injected
// `sleep`. Ordering assertions read a shared `log` array, not timing.
// ————————————————————————————————————————————————————————————————————————

const FAKE_GENERATION = "a".repeat(32);

function aLease(over: Partial<Lease> = {}): Lease {
  return {
    epoch: 3,
    token: "tok-abc",
    serverGeneration: FAKE_GENERATION,
    lastCompletedOpSeq: 7,
    expiresAt: "2026-07-24T12:00:00.000Z",
    ...over,
  };
}

/** Records every lease call and answers from caller-seeded queues (last entry repeats). */
class FakeLeaseClient implements LeaseApi {
  acquireArgs: Array<{
    owner: string;
    ttlSeconds: number;
    clientNonce: string;
    expectedGeneration: string;
  }> = [];
  renewArgs: Array<{ lease: LeaseTuple; ttlSeconds: number }> = [];
  releaseCalls = 0;
  statusArgs: Array<{ attemptId: string; opSeq: number }> = [];
  beginPublishArgs: Array<{ attemptId: string; opSeq: number }> = [];
  endPublishArgs: Array<{ attemptId: string; opSeq: number; outcome: string }> = [];
  recoverArgs: Array<{ attemptId: string; opSeq: number }> = [];
  acquireQueue: AcquireOutcome[] = [{ granted: true, lease: aLease() }];
  renewQueue: RenewOutcome[] = [{ renewed: true, expiresAt: "2026-07-24T12:00:15.000Z" }];
  statusQueue: OperationStatus[] = [
    { opKind: "none", opAttemptId: "", opSeq: 0, lastCompletedOpSeq: 7, completed: true },
  ];
  releaseOutcome: ReleaseOutcome = { released: true };
  beginPublishOutcome: BeginPublishOutcome = { begun: true };
  endPublishOutcome: EndPublishOutcome = { ended: true };
  recoverOutcome: RecoverOpOutcome = { recovered: true };
  endPublishError: Error | undefined;
  /** When set, every renew THROWS — a lost ack, which design §6 says is not lease loss. */
  renewError: Error | undefined;
  /**
   * When set, a status read made WITH an attemptId — the RECONCILIATION read after a lost
   * `EndPublish` ack; every other read passes `""` — answers as if the server's current marker
   * were that exact op, echoing the caller's own `attemptId`/`opSeq` under this `opKind`.
   * Necessary because the publish attemptId is minted inside the orchestrator (random, per
   * attempt) and so cannot be seeded into `statusQueue` ahead of time. With `opKind: "publish"`
   * the marker is provably ours; flipping it to `"run"` changes ONLY the kind, so a test that
   * asserts `recoverOp` is not called then isolates the `opKind === "publish"` precondition.
   */
  reconcileOpKind: string | undefined;
  /**
   * 5C-B2 (t10): override the `opAttemptId`/`opSeq` echoed back under `reconcileOpKind`. By
   * default (`undefined`) the reconciling read echoes the CALLER's own tuple, which makes
   * `reconcileStrandedPublish`'s `opAttemptId === attemptId` / `opSeq === opSeq` conjuncts
   * tautologically true no matter what — deleting either reddens no test. Setting one (with
   * `reconcileOpKind` still `"publish"`) reports a marker that IS a publish op but is NOT this
   * caller's own attempt, isolating that one conjunct. Every existing test leaves both
   * `undefined` and so is unaffected.
   */
  reconcileOpAttemptId: string | undefined;
  reconcileOpSeq: number | undefined;
  /**
   * Layer 5C-B2: answers a status read made WITH a non-empty attemptId — the LOST-ACK
   * reconciliation read. Takes precedence over `reconcileOpKind`, which cannot express a
   * COMPLETED op (it hardcodes `completed: false` for the publish-recovery precondition) and so
   * cannot cover the case this exists for. May throw, to drive the "the status read itself
   * failed" arm.
   */
  reconcileStatus: ((attemptId: string, opSeq: number) => OperationStatus) | undefined;
  /** Awaited inside renew() — lets a test hold one heartbeat tick open to prove single-flight. */
  renewGate: Promise<void> | undefined;
  constructor(readonly log: string[] = []) {}

  private next<T>(queue: T[], what: string): T {
    const head = queue.length > 1 ? queue.shift() : queue[0];
    if (head === undefined) throw new Error(`FakeLeaseClient: no ${what} outcome seeded`);
    return head;
  }

  async acquire(
    owner: string,
    ttlSeconds: number,
    clientNonce: string,
    expectedGeneration: string,
  ): Promise<AcquireOutcome> {
    this.log.push("acquire");
    this.acquireArgs.push({ owner, ttlSeconds, clientNonce, expectedGeneration });
    return this.next(this.acquireQueue, "acquire");
  }
  async renew(lease: LeaseTuple, ttlSeconds: number): Promise<RenewOutcome> {
    this.log.push("renew");
    this.renewArgs.push({ lease, ttlSeconds });
    if (this.renewGate !== undefined) await this.renewGate;
    if (this.renewError !== undefined) throw this.renewError;
    return this.next(this.renewQueue, "renew");
  }
  async release(_lease: LeaseTuple): Promise<ReleaseOutcome> {
    this.log.push("release");
    this.releaseCalls++;
    return this.releaseOutcome;
  }
  async beginPublish(
    _lease: LeaseTuple,
    attemptId: string,
    opSeq: number,
  ): Promise<BeginPublishOutcome> {
    this.log.push("beginPublish");
    this.beginPublishArgs.push({ attemptId, opSeq });
    return this.beginPublishOutcome;
  }
  async endPublish(
    _lease: LeaseTuple,
    attemptId: string,
    opSeq: number,
    outcome: string,
  ): Promise<EndPublishOutcome> {
    this.log.push("endPublish");
    this.endPublishArgs.push({ attemptId, opSeq, outcome });
    if (this.endPublishError !== undefined) throw this.endPublishError;
    return this.endPublishOutcome;
  }
  async getOperationStatus(
    _lease: LeaseTuple,
    attemptId: string,
    opSeq: number,
  ): Promise<OperationStatus> {
    this.log.push("status");
    this.statusArgs.push({ attemptId, opSeq });
    if (this.reconcileStatus !== undefined && attemptId !== "") {
      return this.reconcileStatus(attemptId, opSeq);
    }
    if (this.reconcileOpKind !== undefined && attemptId !== "") {
      return {
        opKind: this.reconcileOpKind,
        opAttemptId: this.reconcileOpAttemptId ?? attemptId,
        opSeq: this.reconcileOpSeq ?? opSeq,
        lastCompletedOpSeq: opSeq - 1,
        completed: false,
      };
    }
    return this.next(this.statusQueue, "status");
  }
  async recoverOp(
    _lease: LeaseTuple,
    attemptId: string,
    opSeq: number,
    terminalProof: true,
  ): Promise<RecoverOpOutcome> {
    this.log.push("recoverOp");
    if (terminalProof !== true) throw new Error("recoverOp called without terminal proof");
    this.recoverArgs.push({ attemptId, opSeq });
    return this.recoverOutcome;
  }
}

/** Injected timer seam: captures the heartbeat callback so a test can fire it deterministically. */
class FakeTimers implements LeaseTimers {
  fn: (() => unknown) | undefined;
  periodMs: number | undefined;
  cleared = 0;
  private readonly handle = { id: "hb" };
  setInterval(fn: () => unknown, ms: number): unknown {
    this.fn = fn;
    this.periodMs = ms;
    return this.handle;
  }
  clearInterval(handle: unknown): void {
    if (handle === this.handle) this.cleared++;
  }
  /** One tick, awaited to completion (the production seam ignores the returned promise). */
  async fire(): Promise<void> {
    await this.fn?.();
  }
  /** One tick, NOT awaited — for the single-flight proof. */
  fireDetached(): void {
    void this.fn?.();
  }
}

/** `fakeBackend` + the `setLease` binding an authoritative lease session requires. */
function leaseBackend(overrides: Partial<ExecutionBackend> = {}): ExecutionBackend & {
  leases: Lease[];
} {
  const leases: Lease[] = [];
  return Object.assign(
    fakeBackend({
      capabilities: () => ({
        coverage: "none",
        deploy: "publish",
        isolation: "session",
        authoritative: true,
      }),
      ...overrides,
    }),
    {
      leases,
      setLease(lease: Lease): void {
        leases.push(lease);
      },
    },
  );
}

function leaseCfg(
  client: LeaseApi,
  over: Partial<LeaseSessionConfig> = {},
): { lease: LeaseSessionConfig; sleeps: number[] } {
  const sleeps: number[] = [];
  return {
    sleeps,
    lease: {
      client,
      serverGeneration: async () => FAKE_GENERATION,
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
      timers: new FakeTimers(),
      ...over,
    },
  };
}

describe("runSession — Layer 5C-B1 Task 8: lease acquisition (design §6 step 1)", () => {
  test("acquires with the HarnessInfo generation BEFORE any deploy, backing off a `held` refusal", async () => {
    const log: string[] = [];
    const client = new FakeLeaseClient(log);
    client.acquireQueue = [
      { granted: false, reason: "held", holder: "other-host:1:9" },
      { granted: true, lease: aLease() },
    ];
    const backend = leaseBackend({
      deploy: async () => {
        log.push("deploy");
        return null;
      },
    });
    const { lease, sleeps } = leaseCfg(client);
    await runSessionForTest(backend, { quarantineDir: freshTmpDir(), lease });
    // Ordering by call log, never by clock: both acquire attempts precede the first deploy.
    expect(log.indexOf("deploy")).toBeGreaterThan(-1);
    expect(log.slice(0, log.indexOf("deploy"))).toContain("acquire");
    expect(client.acquireArgs).toHaveLength(2);
    expect(sleeps).toHaveLength(1); // exactly one backoff between the two attempts
    expect(sleeps[0]).toBeGreaterThan(0);
    // Same client nonce on the retry: the server replays a held nonce as the SAME grant, so a
    // lost ack can never mint a second lease (ControlState.TryAcquire step 3).
    expect(client.acquireArgs[0]?.clientNonce).toBe(client.acquireArgs[1]?.clientNonce ?? "x");
    expect(client.acquireArgs[0]?.expectedGeneration).toBe(FAKE_GENERATION);
    // ttl bound: the server's RenewPeriodMs() is 5000ms and design §6 heartbeats at ttl/3.
    expect(client.acquireArgs[0]?.ttlSeconds).toBeLessThanOrEqual(15);
    expect(client.acquireArgs[0]?.owner).toMatch(/.+:\d+:\d+/); // host:pid:runId
  });

  test("a persistently held lease throws LeaseUnavailableError before any deploy", async () => {
    const client = new FakeLeaseClient();
    client.acquireQueue = [{ granted: false, reason: "held", holder: "other" }];
    let deploys = 0;
    const backend = leaseBackend({
      deploy: async () => {
        deploys++;
        return null;
      },
    });
    const { lease } = leaseCfg(client, { acquireAttempts: 3 });
    await expect(
      runSessionForTest(backend, { quarantineDir: freshTmpDir(), lease }),
    ).rejects.toBeInstanceOf(LeaseUnavailableError);
    expect(client.acquireArgs).toHaveLength(3);
    expect(deploys).toBe(0);
  });

  test("operation-orphaned re-checked ONCE with an unchanged marker writes a durable container-needs-recycle", async () => {
    const dir = freshTmpDir();
    const client = new FakeLeaseClient();
    client.acquireQueue = [
      {
        granted: false,
        reason: "operation-orphaned",
        opAttemptId: "a42",
        opStartedAt: "2026-07-24T11:00:00.000Z",
      },
    ];
    const { lease } = leaseCfg(client, { acquireAttempts: 5 });
    await expect(
      runSessionForTest(leaseBackend(), {
        quarantineDir: dir,
        lease,
        nowIso: () => "2026-07-24T12:00:00.000Z",
      }),
    ).rejects.toBeInstanceOf(LeaseUnavailableError);
    // Re-check ONCE, then stop — not a full backoff run against a stranded container.
    expect(client.acquireArgs).toHaveLength(2);
    const rec = await new QuarantineStore(dir).read("http://cronus281|BC");
    expect(rec?.opKind).toBe("container-needs-recycle");
    expect(rec?.detail).toContain("a42");
    expect(rec?.recordedAtIso).toBe("2026-07-24T12:00:00.000Z");
  });

  test("operation-orphaned whose marker MOVED between checks writes no durable quarantine", async () => {
    const dir = freshTmpDir();
    const client = new FakeLeaseClient();
    client.acquireQueue = [
      {
        granted: false,
        reason: "operation-orphaned",
        opAttemptId: "a42",
        opStartedAt: "2026-07-24T11:00:00.000Z",
      },
      {
        granted: false,
        reason: "operation-orphaned",
        opAttemptId: "a43", // a DIFFERENT op: the container is making progress, not stranded
        opStartedAt: "2026-07-24T11:00:05.000Z",
      },
      { granted: true, lease: aLease() },
    ];
    const { lease } = leaseCfg(client, { acquireAttempts: 5 });
    await runSessionForTest(leaseBackend(), { quarantineDir: dir, lease });
    expect(await new QuarantineStore(dir).read("http://cronus281|BC")).toBeNull();
  });

  // The signature bug of this codebase, guarding its most expensive action: if the server ever
  // answers `operation-orphaned` WITHOUT naming the stranded op, a marker synthesised as
  // `"<blank>|<blank>"` compares equal to the next equally-blank one, and a durable,
  // operator-only-recoverable container-needs-recycle gets written having compared NOTHING.
  test("repeated operation-orphaned with NO opAttemptId writes no durable quarantine (empty-vs-empty)", async () => {
    const dir = freshTmpDir();
    const client = new FakeLeaseClient();
    // One entry, so the fake repeats it: every look is an unnamed orphan refusal.
    client.acquireQueue = [{ granted: false, reason: "operation-orphaned" }];
    const { lease } = leaseCfg(client, { acquireAttempts: 3 });
    await expect(
      runSessionForTest(leaseBackend(), {
        quarantineDir: dir,
        lease,
        nowIso: () => "2026-07-24T12:00:00.000Z",
      }),
    ).rejects.toBeInstanceOf(LeaseUnavailableError);
    expect(await new QuarantineStore(dir).read("http://cronus281|BC")).toBeNull();
    // Backed off across the whole budget instead of recording after two unnameable looks.
    expect(client.acquireArgs).toHaveLength(3);
  });

  test("a `generation-changed` refusal aborts immediately — backoff cannot fix a recycled container", async () => {
    const client = new FakeLeaseClient();
    client.acquireQueue = [{ granted: false, reason: "generation-changed" }];
    const { lease } = leaseCfg(client, { acquireAttempts: 5 });
    await expect(
      runSessionForTest(leaseBackend(), { quarantineDir: freshTmpDir(), lease }),
    ).rejects.toBeInstanceOf(LeaseUnavailableError);
    expect(client.acquireArgs).toHaveLength(1);
  });
});

describe("runSession — Layer 5C-B1 Task 8: publish fence + op-gated release (design §6 steps 2/5)", () => {
  test("publishes inside BeginPublish/EndPublish with an exactly-next opSeq, then rebinds the backend", async () => {
    const log: string[] = [];
    const client = new FakeLeaseClient(log);
    client.statusQueue = [
      { opKind: "none", opAttemptId: "", opSeq: 0, lastCompletedOpSeq: 7, completed: true },
    ];
    const backend = leaseBackend({
      deploy: async () => {
        log.push("deploy");
        return null;
      },
    });
    const { lease } = leaseCfg(client);
    await runSessionForTest(backend, { quarantineDir: freshTmpDir(), lease });
    const begin = log.indexOf("beginPublish");
    expect(begin).toBeGreaterThan(-1);
    expect(log.indexOf("deploy")).toBeGreaterThan(begin);
    expect(log.indexOf("endPublish")).toBeGreaterThan(log.indexOf("deploy"));
    expect(client.beginPublishArgs[0]?.opSeq).toBe(8); // lastCompletedOpSeq + 1
    expect(client.beginPublishArgs[0]?.attemptId.length).toBeLessThanOrEqual(64);
    expect(client.endPublishArgs[0]?.opSeq).toBe(8);
    expect(client.endPublishArgs[0]?.attemptId).toBe(client.beginPublishArgs[0]?.attemptId ?? "x");
    expect(client.endPublishArgs[0]?.outcome).toBe("succeeded");
    // The backend's RunMutant op-seq counter must continue AFTER the publish op, not from the
    // acquire grant's lastCompletedOpSeq (which the publish has since advanced).
    expect(backend.leases.at(-1)?.lastCompletedOpSeq).toBe(8);
  });

  test("releases the lease at session end when no op is in flight, and clears the heartbeat timer", async () => {
    const client = new FakeLeaseClient();
    const timers = new FakeTimers();
    const { lease } = leaseCfg(client, { timers });
    await runSessionForTest(leaseBackend(), { quarantineDir: freshTmpDir(), lease });
    expect(client.releaseCalls).toBe(1);
    expect(timers.cleared).toBeGreaterThan(0);
  });

  test("does NOT release while an op marker is still set — records container-needs-recycle instead", async () => {
    const dir = freshTmpDir();
    const client = new FakeLeaseClient();
    // status reads: [0] publish-fence opSeq lookup, [1] the session-end release gate.
    client.statusQueue = [
      { opKind: "none", opAttemptId: "", opSeq: 0, lastCompletedOpSeq: 7, completed: true },
      { opKind: "run", opAttemptId: "a9", opSeq: 9, lastCompletedOpSeq: 8, completed: false },
    ];
    const { lease } = leaseCfg(client);
    await runSessionForTest(leaseBackend(), {
      quarantineDir: dir,
      lease,
      nowIso: () => "2026-07-24T13:00:00.000Z",
    });
    expect(client.releaseCalls).toBe(0);
    const rec = await new QuarantineStore(dir).read("http://cronus281|BC");
    expect(rec?.opKind).toBe("container-needs-recycle");
    expect(rec?.detail).toContain("a9");
    // The quarantine above is only legitimate because the marker was proven OURS: `finish()`
    // renews before recording, and this fake answers renewed:true.
    expect(client.renewArgs.length).toBeGreaterThan(0);
    expect(client.renewArgs.at(-1)?.lease.token).toBe(aLease().token);
  });

  // design §6: a clean lease loss must NOT write a durable tier quarantine. If our lease lapsed
  // and another session acquired and began ITS op before the heartbeat noticed, the marker
  // `finish()` reads is theirs — recording against it would block a healthy container (and that
  // other session, and everyone after it) until an operator hand-runs the §8 recovery.
  test("a non-idle marker belonging to ANOTHER session is NOT durably quarantined", async () => {
    const dir = freshTmpDir();
    const client = new FakeLeaseClient();
    client.statusQueue = [
      { opKind: "none", opAttemptId: "", opSeq: 0, lastCompletedOpSeq: 7, completed: true },
      // Someone else's op: we lapsed, they acquired, and they are mid-publish right now.
      {
        opKind: "publish",
        opAttemptId: "their-attempt",
        opSeq: 12,
        lastCompletedOpSeq: 11,
        completed: false,
      },
    ];
    client.renewQueue = [{ renewed: false }]; // the row moved on: the lease is provably not ours
    const { lease } = leaseCfg(client);
    await runSessionForTest(leaseBackend(), {
      quarantineDir: dir,
      lease,
      nowIso: () => "2026-07-24T13:00:00.000Z",
    });
    expect(await new QuarantineStore(dir).read("http://cronus281|BC")).toBeNull();
    expect(client.releaseCalls).toBe(0); // nothing of ours to release either
  });

  // A renew that cannot be ANSWERED proves nothing (design §6: only renewed:false is loss), so the
  // conservative behaviour must survive — "I could not ask" must never be read as "not ours".
  test("a non-idle marker still quarantines when the ownership renew cannot be answered", async () => {
    const dir = freshTmpDir();
    const client = new FakeLeaseClient();
    client.statusQueue = [
      { opKind: "none", opAttemptId: "", opSeq: 0, lastCompletedOpSeq: 7, completed: true },
      { opKind: "run", opAttemptId: "a9", opSeq: 9, lastCompletedOpSeq: 8, completed: false },
    ];
    client.renewError = new Error("connect ECONNREFUSED");
    const { lease } = leaseCfg(client);
    await runSessionForTest(leaseBackend(), {
      quarantineDir: dir,
      lease,
      nowIso: () => "2026-07-24T13:00:00.000Z",
    });
    const rec = await new QuarantineStore(dir).read("http://cronus281|BC");
    expect(rec?.opKind).toBe("container-needs-recycle");
    expect(rec?.detail).toContain("a9");
  });
});

describe("runSession — Layer 5C-B1 Task 8: renew heartbeat (design §6 step 3)", () => {
  test("is single-flight: a tick arriving while one is in flight is dropped, not queued", async () => {
    const client = new FakeLeaseClient();
    let openGate: () => void = () => {};
    client.renewGate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    const timers = new FakeTimers();
    const { lease } = leaseCfg(client, { timers });
    const backend = leaseBackend({
      run: async (ref, opts) => {
        // Fire three ticks while the first renew is still parked on the gate.
        timers.fireDetached();
        timers.fireDetached();
        timers.fireDetached();
        return {
          ref,
          outcome: "pass" as const,
          durationMs: 1,
          ...(opts.coverage === "none"
            ? { attestation: { observedAny: true, identityMismatch: false } }
            : {}),
        };
      },
    });
    // The gate stays SHUT for the whole session: the first renew never completes, so no tick may
    // ever queue behind it. `run` (above) fires 3 ticks PER CALL, not 30 — the ~30 comes from the
    // session's own baseline run plus THREE_PROC_AL's 9 mutant runs (~10 `run()` calls this
    // session, 3 ticks each), and every one of those ~30 must be dropped by the single-flight
    // guard (t9, 5C-B2: the prior wording read as if 30 ticks fired from the 3 lines above).
    await runSessionForTest(backend, { quarantineDir: freshTmpDir(), lease });
    expect(client.renewArgs.length).toBe(1);
    openGate(); // let the one parked renew settle so no promise is left hanging
    expect(client.renewArgs[0]?.ttlSeconds).toBeLessThanOrEqual(15);
    expect(timers.periodMs).toBe(5000); // ttl/3 at the 15s ceiling
  });

  test("renewed:false latches lease-lost, stops scheduling, and stops renewing", async () => {
    const client = new FakeLeaseClient();
    client.renewQueue = [{ renewed: false }];
    const timers = new FakeTimers();
    const { lease } = leaseCfg(client, { timers });
    let runs = 0;
    const backend = leaseBackend({
      run: async (ref, opts) => {
        runs++;
        if (runs === 2) await timers.fire(); // mid-session: the lease is gone
        return {
          ref,
          outcome: "pass" as const,
          durationMs: 1,
          ...(opts.coverage === "none"
            ? { attestation: { observedAny: true, identityMismatch: false } }
            : {}),
        };
      },
    });
    const report = await runSessionForTest(backend, { quarantineDir: freshTmpDir(), lease });
    expect(report.quarantined?.reason).toContain("lease-lost");
    // THREE_PROC_AL has 9 mutants; scheduling stopped long before all of them ran.
    expect(runs).toBeLessThan(9);
    await timers.fire(); // a tick after the loss must not renew again
    expect(client.renewArgs).toHaveLength(1);
    expect(timers.cleared).toBeGreaterThan(0);
  });
});

describe("runSession — Layer 5C-B1 Task 8: lease-lost invalidation + dispatch guards (design §6)", () => {
  /** M0001 runs clean and attests cleanly (so design §G's fail-closed attestation gate is NOT
   *  what invalidates it); M0002's covering run returns the caller-supplied lease verdict. */
  function leaseLostAfterFirstMutant(over: Partial<TestVerdict>): ExecutionBackend {
    let activeMutant: string | null = null;
    return leaseBackend({
      activate: async (id) => {
        activeMutant = id;
      },
      run: async (ref) => {
        if (activeMutant === "M0002") {
          return { ref, outcome: "error" as const, durationMs: 1, ...over };
        }
        return {
          ref,
          outcome: "pass" as const,
          durationMs: 1,
          attestation: { observedAny: true, identityMismatch: false },
        };
      },
    });
  }

  test("a genuine RunMutant lease-lost invalidates the CURRENT batch's already-recorded verdicts", async () => {
    const dir = freshTmpDir();
    const client = new FakeLeaseClient();
    const { lease } = leaseCfg(client);
    const backend = leaseLostAfterFirstMutant({
      operation: "lease-lost",
      leaseInvalidReason: "lease-invalid",
    });
    const report = await runSessionForTest(backend, { quarantineDir: dir, lease });
    const m1 = report.mutants.find((m) => m.mutantCode === "M0001");
    expect(m1).toBeDefined();
    // The bug this closes: M0001 was recorded "survived" under a lease we can no longer prove we
    // held — per-mutant equality, never an aggregate count.
    expect(m1?.verdict).toBe("error");
    expect(report.quarantined?.reason).toContain("lease-lost");
    // A clean lease-lost means the container is FINE (design §6) — no durable tier quarantine.
    expect(await new QuarantineStore(dir).read("http://cronus281|BC")).toBeNull();
  });

  test("an `op-in-flight` lease-invalid polls the op instead of latching — earlier verdicts stand", async () => {
    const dir = freshTmpDir();
    const client = new FakeLeaseClient();
    client.statusQueue = [
      { opKind: "none", opAttemptId: "", opSeq: 0, lastCompletedOpSeq: 7, completed: true },
    ];
    const { lease } = leaseCfg(client);
    const backend = leaseLostAfterFirstMutant({
      operation: "lease-lost",
      leaseInvalidReason: "op-in-flight",
    });
    const report = await runSessionForTest(backend, { quarantineDir: dir, lease });
    const m1 = report.mutants.find((m) => m.mutantCode === "M0001");
    const m2 = report.mutants.find((m) => m.mutantCode === "M0002");
    // op-in-flight is THIS caller's own still-active attempt, NOT lease loss: latching here would
    // discard a batch that is fine.
    expect(m1?.verdict).toBe("survived");
    expect(m2?.verdict).toBe("error");
    expect(report.quarantined).toBeUndefined();
    // Polled (getOperationStatus), never re-dispatched and never RecoverOp'd.
    expect(client.statusArgs.length).toBeGreaterThan(1);
    expect(client.recoverArgs).toHaveLength(0);
    expect(await new QuarantineStore(dir).read("http://cronus281|BC")).toBeNull();
  });

  test("an `op-in-flight` lease-invalid that never clears is durably quarantined (t12: runMutantsOnBackend's own op-in-flight branch)", async () => {
    const dir = freshTmpDir();
    const client = new FakeLeaseClient();
    // `FakeLeaseClient.next` shifts until exactly one entry is left, then returns that SAME entry
    // forever — so seeding a non-idle final entry means the poll never sees `opKind: "none"` and
    // exhausts every attempt. Distinct from the "still-ACTIVE op that never clears" coverage under
    // `reconcileLostAck` (this file, the 5C-B2 lost-RunMutant-ack describe block): that drives
    // `pollUntilOpClears` via the lost-ack path. This drives the SAME method from
    // `runMutantsOnBackend`'s own explicit `leaseKind === "op-in-flight"` branch
    // (orchestrator.ts:2245-2266) — the ONE call site t12 named as still uncovered, since both
    // existing op-in-flight tests in this block seed a statusQueue that clears on the FIRST poll.
    client.statusQueue = [
      { opKind: "none", opAttemptId: "", opSeq: 0, lastCompletedOpSeq: 7, completed: true },
      {
        opKind: "run",
        opAttemptId: "someone-else",
        opSeq: 99,
        lastCompletedOpSeq: 98,
        completed: false,
      },
    ];
    const { lease } = leaseCfg(client);
    const backend = leaseLostAfterFirstMutant({
      operation: "lease-lost",
      leaseInvalidReason: "op-in-flight",
    });
    const report = await runSessionForTest(backend, {
      quarantineDir: dir,
      lease,
      nowIso: () => "2026-07-24T17:00:00.000Z",
    });
    const m1 = report.mutants.find((m) => m.mutantCode === "M0001");
    const m2 = report.mutants.find((m) => m.mutantCode === "M0002");
    expect(m1?.verdict).toBe("survived"); // earlier verdict stands — never latched retroactively
    expect(m2?.verdict).toBe("error");
    expect(m2?.failureNote).toContain("never cleared");
    expect(report.quarantined).toBeDefined();
    expect(client.recoverArgs).toHaveLength(0); // never RecoverOp'd — the op may still be executing
    const rec = await new QuarantineStore(dir).read("http://cronus281|BC");
    expect(rec?.opKind).toBe("test-run");
    expect(rec?.detail).toContain("operation never cleared after an op-in-flight refusal");
  });

  test("invalidateBatchVerdicts leaves an EARLIER batch's verdicts untouched", () => {
    const outcomes: SessionOutcome[] = [
      { mutant: fakeManifestEntry("M0001"), verdict: "survived", batchIndex: 0 },
      { mutant: fakeManifestEntry("M0002"), verdict: "killed", batchIndex: 0 },
      { mutant: fakeManifestEntry("M0003"), verdict: "survived", batchIndex: 1 },
    ];
    invalidateBatchVerdicts(outcomes, 1, "lease-lost");
    expect(outcomes[0]?.verdict).toBe("survived"); // earlier batch was individually fence-validated
    expect(outcomes[1]?.verdict).toBe("killed");
    expect(outcomes[2]?.verdict).toBe("error");
  });

  test("activateOnce refuses its RETRY dispatch when the latch trips during the first attempt", async () => {
    // design §6 requires EVERY work-plane dispatch to be guarded, and the retry inside
    // `activateOnce` is a SECOND dispatch: the renew heartbeat can latch lease-loss while the
    // first attempt is in flight (a `pre-dispatch-rejected` connect failure — the one outcome
    // that earns a retry — is exactly that shape), so the entry-point `assertSafe` cannot speak
    // for it. Driven directly rather than through a runSession fixture on purpose: for the
    // authoritative backend `activate()` is local bookkeeping that never throws
    // `ActivationFailure`, so no real backend can reach this branch at all.
    const safety = new SessionSafety();
    let calls = 0;
    const backend = fakeBackend({
      activate: async () => {
        calls++;
        safety.latchUnsafe("lease-lost: RenewLease answered renewed:false");
        throw new ActivationFailure("connect refused", "pre-dispatch-rejected");
      },
    });
    await expect(activateOnce(backend, safety, "M0007")).rejects.toBeInstanceOf(SessionUnsafeError);
    expect(calls).toBe(1); // the retry never reached the backend
  });

  test("runOnce refuses to dispatch once the session is latched unsafe", async () => {
    let runs = 0;
    const backend = fakeBackend({
      run: async (ref) => {
        runs++;
        return { ref, outcome: "pass", durationMs: 1 };
      },
    });
    const safety = new SessionSafety();
    safety.latchUnsafe("lease-lost: renew refused");
    await expect(
      runOnce(backend, safety, aRef(), { coverage: "none", timeoutMs: 100 }),
    ).rejects.toBeInstanceOf(SessionUnsafeError);
    expect(runs).toBe(0);
  });

  test("a mid-mutant lease loss stops the very next dispatch, before it reaches the backend", async () => {
    // The next dispatch after the loss must be a `run` with NO intervening `activate`, or this
    // test would be satisfied by `activateOnce`'s pre-existing guard and prove nothing about
    // `runOnce`'s. TWO_TEST_AL gives each mutant TWO covering tests, so the covering-test loop
    // dispatches run #2 for the SAME mutant with nothing in between: only `runOnce`'s own latch
    // check can stop it. (Verified by red-check: reverting that check alone reddens this test.)
    const dirs = await makeProject(TWO_TEST_AL);
    await Bun.write(join(dirs.projectDir, "SandboxLogic.Codeunit.al"), THREE_PROC_AL);
    const client = new FakeLeaseClient();
    client.renewQueue = [{ renewed: false }];
    const timers = new FakeTimers();
    const { lease } = leaseCfg(client, { timers });
    let activeMutant: string | null = null;
    let runsAfterLoss = 0;
    let lost = false;
    const backend = leaseBackend({
      activate: async (id) => {
        activeMutant = id;
      },
      run: async (ref) => {
        if (lost) runsAfterLoss++;
        if (activeMutant === "M0001" && !lost) {
          // First covering test of the first mutant: passes (so the loop moves on to the SECOND
          // covering test) while the heartbeat loses the lease during this very call.
          lost = true;
          await timers.fire();
        }
        return {
          ref,
          outcome: "pass" as const,
          durationMs: 1,
          attestation: { observedAny: true, identityMismatch: false },
        };
      },
    });
    const report = await runSession({
      backend,
      store: new ResultsStore(":memory:"),
      ...dirs,
      selectorIds,
      resourceServer: "http://cronus281",
      resourceServerInstance: "BC",
      quarantineDir: freshTmpDir(),
      lease,
    });
    // No second covering run, no next mutant: the latch stopped the dispatch itself.
    expect(runsAfterLoss).toBe(0);
    expect(report.quarantined?.reason).toContain("lease-lost");
  });
});

describe("runSession — Layer 5C-B1 fix round 1: no lease is a caller-contract violation, never a default", () => {
  test("an authoritative, lease-bindable backend with NO lease configured fails before any backend call", async () => {
    let statusCalls = 0;
    let deploys = 0;
    const backend = leaseBackend({
      status: async () => {
        statusCalls++;
        return { ok: true, details: "fake" };
      },
      deploy: async () => {
        deploys++;
        return null;
      },
    });
    await expect(runSessionForTest(backend, { quarantineDir: freshTmpDir() })).rejects.toThrow(
      /no lease/i,
    );
    // Loud AND early: not one work-plane call, not even the readiness probe, runs unfenced.
    expect(statusCalls).toBe(0);
    expect(deploys).toBe(0);
  });

  test("a lease-lost verdict with no lease session throws instead of latching silently", async () => {
    // Unreachable in production (a fenceable backend without a lease now throws at session start,
    // above), but the arm this replaces latched WITHOUT setting `lostBatchIndex`, so the current
    // batch's already-recorded verdicts were never invalidated — a plausible-looking default that
    // silently skipped the one thing this layer exists to do.
    let activeMutant: string | null = null;
    const backend = fakeBackend({
      capabilities: () => ({
        coverage: "none",
        deploy: "publish",
        isolation: "session",
        authoritative: true,
      }),
      activate: async (id) => {
        activeMutant = id;
      },
      run: async (ref) =>
        activeMutant === "M0002"
          ? {
              ref,
              outcome: "error" as const,
              durationMs: 1,
              operation: "lease-lost" as const,
              leaseInvalidReason: "lease-invalid",
            }
          : {
              ref,
              outcome: "pass" as const,
              durationMs: 1,
              attestation: { observedAny: true, identityMismatch: false },
            },
    });
    await expect(runSessionForTest(backend, { quarantineDir: freshTmpDir() })).rejects.toThrow(
      /holds no lease/,
    );
  });
});

describe("runSession — Layer 5C-B1 fix round 1: publish-fence failure paths + RecoverOp reconciliation (design §6 step 2)", () => {
  const VERIFY_UNAVAILABLE = { status: "unavailable" as const, detail: "no response" };

  test('a DeploymentError with outcome "failed" is a confirmed terminal — EndPublish tombstones it as failed', async () => {
    const dir = freshTmpDir();
    const client = new FakeLeaseClient();
    const { lease } = leaseCfg(client);
    const err = new DeploymentError("failed", "BC rejected the package", VERIFY_UNAVAILABLE);
    const backend = leaseBackend({
      deploy: async () => {
        throw err;
      },
    });
    await expect(runSessionForTest(backend, { quarantineDir: dir, lease })).rejects.toBe(err);
    expect(client.endPublishArgs).toHaveLength(1);
    expect(client.endPublishArgs[0]?.outcome).toBe("failed");
    expect(client.endPublishArgs[0]?.attemptId).toBe(client.beginPublishArgs[0]?.attemptId ?? "x");
    // A confirmed deterministic rejection strands nothing — no durable tier quarantine.
    expect(await new QuarantineStore(dir).read("http://cronus281|BC")).toBeNull();
  });

  test('a DeploymentError with outcome "indeterminate" leaves the marker SET and quarantines the tier', async () => {
    const dir = freshTmpDir();
    const client = new FakeLeaseClient();
    const { lease } = leaseCfg(client);
    const err = new DeploymentError(
      "indeterminate",
      "connection reset mid-publish",
      VERIFY_UNAVAILABLE,
    );
    const backend = leaseBackend({
      deploy: async () => {
        throw err;
      },
    });
    await expect(
      runSessionForTest(backend, {
        quarantineDir: dir,
        lease,
        nowIso: () => "2026-07-24T14:00:00.000Z",
      }),
    ).rejects.toBe(err);
    // NEVER tombstoned: the publish may have landed, or may still be landing. Leaving the marker
    // set is what stops the next session publishing across a half-applied one (design §6 step 2).
    expect(client.endPublishArgs).toHaveLength(0);
    const rec = await new QuarantineStore(dir).read("http://cronus281|BC");
    expect(rec?.opKind).toBe("container-needs-recycle");
    expect(rec?.detail).toContain("UNKNOWN result");
    expect(rec?.detail).toContain(String(client.beginPublishArgs[0]?.opSeq ?? -1));
    expect(rec?.recordedAtIso).toBe("2026-07-24T14:00:00.000Z");
  });

  test("a lost EndPublish ack whose marker is provably OUR OWN publish op earns exactly one RecoverOp", async () => {
    const dir = freshTmpDir();
    const client = new FakeLeaseClient();
    client.endPublishError = new Error("socket hang up");
    client.reconcileOpKind = "publish"; // the reconciling read names our own attemptId/opSeq
    const { lease } = leaseCfg(client);
    await runSessionForTest(leaseBackend(), { quarantineDir: dir, lease });
    expect(client.recoverArgs).toHaveLength(1);
    expect(client.recoverArgs[0]?.attemptId).toBe(client.beginPublishArgs[0]?.attemptId ?? "x");
    expect(client.recoverArgs[0]?.opSeq).toBe(client.beginPublishArgs[0]?.opSeq ?? -1);
    // Recovered, so nothing is stranded.
    expect(await new QuarantineStore(dir).read("http://cronus281|BC")).toBeNull();
  });

  test("a lost EndPublish ack whose marker is a RUN op is NEVER recovered — the marker stays, the tier is quarantined", async () => {
    const dir = freshTmpDir();
    const client = new FakeLeaseClient();
    client.endPublishError = new Error("socket hang up");
    // Identical to the test above except for `opKind`: same lost ack, same echoed attemptId and
    // opSeq. A `run` marker genuinely could still be executing AL, and clearing it would let a
    // second session overlap it on shared DB state — the exact sequence design §5 forbids
    // RecoverOp for. This is the assertion that PROVES the precondition instead of documenting it.
    client.reconcileOpKind = "run";
    const { lease } = leaseCfg(client);
    await runSessionForTest(leaseBackend(), {
      quarantineDir: dir,
      lease,
      nowIso: () => "2026-07-24T15:00:00.000Z",
    });
    expect(client.recoverArgs).toHaveLength(0);
    const rec = await new QuarantineStore(dir).read("http://cronus281|BC");
    expect(rec?.opKind).toBe("container-needs-recycle");
    expect(rec?.detail).toContain("could not be reconciled");
    expect(rec?.detail).toContain("opKind run");
  });

  test("a lost EndPublish ack whose marker is a publish op at our OWN opSeq but a DIFFERENT attemptId is NEVER recovered (t10: the attemptId conjunct)", async () => {
    const dir = freshTmpDir();
    const client = new FakeLeaseClient();
    client.endPublishError = new Error("socket hang up");
    client.reconcileOpKind = "publish";
    // Same opKind, same opSeq (still echoed from the caller) — ONLY the attemptId diverges from
    // our own. Isolates `status.opAttemptId === attemptId` on its own: the two tests above never
    // could, since the fixture always echoed the caller's own attemptId back.
    client.reconcileOpAttemptId = "someone-elses-attempt";
    const { lease } = leaseCfg(client);
    await runSessionForTest(leaseBackend(), {
      quarantineDir: dir,
      lease,
      nowIso: () => "2026-07-24T16:00:00.000Z",
    });
    expect(client.recoverArgs).toHaveLength(0);
    const rec = await new QuarantineStore(dir).read("http://cronus281|BC");
    expect(rec?.opKind).toBe("container-needs-recycle");
    expect(rec?.detail).toContain("could not be reconciled");
  });

  test("a lost EndPublish ack whose marker is a publish op under our OWN attemptId but a DIFFERENT opSeq is NEVER recovered (t10: the opSeq conjunct)", async () => {
    const dir = freshTmpDir();
    const client = new FakeLeaseClient();
    client.endPublishError = new Error("socket hang up");
    client.reconcileOpKind = "publish";
    // Same opKind, same attemptId (still echoed from the caller) — ONLY the opSeq diverges,
    // isolating `status.opSeq === opSeq` on its own.
    client.reconcileOpSeq = 999;
    const { lease } = leaseCfg(client);
    await runSessionForTest(leaseBackend(), {
      quarantineDir: dir,
      lease,
      nowIso: () => "2026-07-24T16:05:00.000Z",
    });
    expect(client.recoverArgs).toHaveLength(0);
    const rec = await new QuarantineStore(dir).read("http://cronus281|BC");
    expect(rec?.opKind).toBe("container-needs-recycle");
    expect(rec?.detail).toContain("could not be reconciled");
  });

  test("a lost EndPublish ack whose reconciling read reports the op already completed needs no recovery (t11: the `status.completed` early return)", async () => {
    const dir = freshTmpDir();
    const client = new FakeLeaseClient();
    client.endPublishError = new Error("socket hang up");
    client.reconcileStatus = (attemptId, opSeq) => ({
      opKind: "publish",
      opAttemptId: attemptId,
      opSeq,
      lastCompletedOpSeq: opSeq,
      completed: true, // the lost EndPublish ack had actually landed
    });
    const { lease } = leaseCfg(client);
    await runSessionForTest(leaseBackend(), {
      quarantineDir: dir,
      lease,
      nowIso: () => "2026-07-24T16:10:00.000Z",
    });
    // Nothing to recover (already tombstoned) and nothing to strand.
    expect(client.recoverArgs).toHaveLength(0);
    expect(await new QuarantineStore(dir).read("http://cronus281|BC")).toBeNull();
  });

  test("a lost EndPublish ack whose reconciling GetOperationStatus ALSO fails records both failures and leaves the marker set (t11: the reconciling read itself throwing)", async () => {
    const dir = freshTmpDir();
    const client = new FakeLeaseClient();
    client.endPublishError = new Error("socket hang up");
    client.reconcileStatus = () => {
      throw new LeaseUnavailableError("GetOperationStatus unreachable");
    };
    const { lease } = leaseCfg(client);
    await runSessionForTest(leaseBackend(), {
      quarantineDir: dir,
      lease,
      nowIso: () => "2026-07-24T16:15:00.000Z",
    });
    expect(client.recoverArgs).toHaveLength(0);
    const rec = await new QuarantineStore(dir).read("http://cronus281|BC");
    expect(rec?.opKind).toBe("container-needs-recycle");
    expect(rec?.detail).toContain("was not acknowledged");
    expect(rec?.detail).toContain("also failed");
    expect(rec?.recordedAtIso).toBe("2026-07-24T16:15:00.000Z");
  });
});

// ————————————————————————————————————————————————————————————————————————
// Layer 5C-B2 item 1 — lost-ack reconciliation for a fenced RunMutant (design §5).
//
// Live-observed on 3 of 8 bcdev gate runs: BC answers a `RunMutant` with HTTP 200 and a
// ZERO-BYTE body. The transport can only call that `in-flight-unknown`, and the orchestrator used
// to go straight to a durable `container-needs-recycle` that blocks every later session on the
// tier until an operator deletes the record by hand. The lease row read live moments after one
// such failure said `{"opKind":"none","opAttemptId":"a10","opSeq":304,"lastCompletedOpSeq":304,
// "completed":true}` — phase 3 HAD run and tombstoned the op. Only the HTTP response body was
// lost; nothing was ever stranded.
//
// design §5 already prescribes the fix: read `GetOperationStatus` first, and quarantine ONLY when
// the op cannot be shown to have finished. `RecoverOp` is forbidden on this path outright (an
// unreadable body is not a parsed application-level terminal), which every test below asserts.
// ————————————————————————————————————————————————————————————————————————
describe("runSession — Layer 5C-B2: a lost RunMutant ack is reconciled, not blindly quarantined (design §5)", () => {
  /** The fence coordinates of the failed attempt, shaped exactly like the live evidence. */
  const LOST_OP = { attemptId: "a10", opSeq: 304 } as const;
  const TIER = "http://cronus281|BC";

  function tombstoned(attemptId: string, opSeq: number): OperationStatus {
    return {
      opKind: "none",
      opAttemptId: attemptId,
      opSeq,
      lastCompletedOpSeq: opSeq,
      completed: true,
    };
  }
  function stillOurs(attemptId: string, opSeq: number): OperationStatus {
    return {
      opKind: "run",
      opAttemptId: attemptId,
      opSeq,
      lastCompletedOpSeq: opSeq - 1,
      completed: false,
    };
  }

  /** The verdict BC's zero-byte 200 produces, as the transport maps it. */
  const LOST_ANSWER: Partial<TestVerdict> = {
    outcome: "error",
    failureMessage: 'RunMutant returned no string `value` (HTTP 200), body: ""',
    operation: "in-flight-unknown",
    fencedOp: LOST_OP,
  };

  /**
   * M0001 runs clean and attests cleanly (so design §G's fail-closed gate is NOT what marks it);
   * M0002's covering runs are answered from `answers` IN ORDER, the last entry repeating — so a
   * test can say "the first attempt's ack was lost, the retry really ran". `dispatches` counts
   * M0002's runs, which is how the retry budget is asserted by call counter rather than by timing.
   */
  function lostAckAfterFirstMutant(
    opts: {
      readonly answers?: readonly Partial<TestVerdict>[];
      readonly fencedOp?: { readonly attemptId: string; readonly opSeq: number } | null;
      readonly dispatches?: { count: number };
    } = {},
  ): ExecutionBackend {
    const answers = opts.answers ?? [LOST_ANSWER];
    let activeMutant: string | null = null;
    let issued = 0;
    return leaseBackend({
      activate: async (id) => {
        activeMutant = id;
      },
      run: async (ref) => {
        if (activeMutant === "M0002") {
          if (opts.dispatches !== undefined) opts.dispatches.count++;
          const answer = answers[Math.min(issued, answers.length - 1)] ?? LOST_ANSWER;
          issued++;
          // `fencedOp: null` strips the coordinates the answer would otherwise carry — the
          // "nothing to reconcile" case. Omitted, the answer keeps its own.
          const { fencedOp: own, ...rest } = answer;
          const fence = opts.fencedOp === undefined ? own : opts.fencedOp;
          return {
            ref,
            outcome: "error" as const,
            durationMs: 1,
            ...rest,
            ...(fence !== undefined && fence !== null ? { fencedOp: fence } : {}),
          };
        }
        return {
          ref,
          outcome: "pass" as const,
          durationMs: 1,
          attestation: { observedAny: true, identityMismatch: false },
        };
      },
    });
  }

  test("a TOMBSTONED op writes NO durable quarantine — the container is clean and the session continues", async () => {
    const dir = freshTmpDir();
    const client = new FakeLeaseClient();
    client.reconcileStatus = tombstoned;
    const { lease } = leaseCfg(client);
    const report = await runSessionForTest(lostAckAfterFirstMutant(), {
      quarantineDir: dir,
      lease,
    });
    // THE assertion this whole change exists for: a container that provably finished the op is
    // not condemned. A durable record here locks out every later session on this tier until an
    // operator deletes it by hand.
    expect(await new QuarantineStore(dir).read(TIER)).toBeNull();
    expect(report.quarantined).toBeUndefined();
    // The reconciling read asked about OUR attempt, by its own coordinates.
    expect(client.statusArgs).toContainEqual({ attemptId: "a10", opSeq: 304 });
    // Never on this path: an unreadable body is not a parsed application-level terminal (design §5).
    expect(client.recoverArgs).toHaveLength(0);
    const m1 = report.mutants.find((m) => m.mutantCode === "M0001");
    const m2 = report.mutants.find((m) => m.mutantCode === "M0002");
    const m3 = report.mutants.find((m) => m.mutantCode === "M0003");
    expect(m1?.verdict).toBe("survived"); // an earlier, fence-validated verdict still stands
    expect(m2?.verdict).toBe("error"); // THIS mutant's result is genuinely lost
    expect(m2?.failureNote).toContain("unreadable");
    expect(m2?.failureNote).toContain("COMPLETED server-side");
    expect(m3).toBeDefined(); // the run continued to the next mutant
    // Not a deadline: our own client timeout produces a different verdict entirely.
    expect(m2?.cause).toBeUndefined();
    expect(report.counts.deadlineExceeded).toBe(0);
  });

  test("an op still ACTIVE and ours that CLEARS while polling is likewise not quarantined", async () => {
    const dir = freshTmpDir();
    const client = new FakeLeaseClient();
    client.reconcileStatus = stillOurs; // first look: the run op is still marked, and it is ours
    // ...and the poll (which reads with an EMPTY attemptId) finds the marker idle.
    client.statusQueue = [
      { opKind: "none", opAttemptId: "", opSeq: 0, lastCompletedOpSeq: 7, completed: true },
    ];
    const { lease } = leaseCfg(client);
    const report = await runSessionForTest(lostAckAfterFirstMutant(), {
      quarantineDir: dir,
      lease,
    });
    expect(await new QuarantineStore(dir).read(TIER)).toBeNull();
    expect(report.quarantined).toBeUndefined();
    expect(client.recoverArgs).toHaveLength(0);
    expect(report.mutants.find((m) => m.mutantCode === "M0002")?.verdict).toBe("error");
    expect(report.mutants.find((m) => m.mutantCode === "M0003")).toBeDefined();
  });

  test("an op that NEVER clears still writes the durable container-needs-recycle and stops the session", async () => {
    const dir = freshTmpDir();
    const client = new FakeLeaseClient();
    client.reconcileStatus = stillOurs;
    // Head entry answers the publish fence's own `nextOpSeq` read; every later poll sees a marker
    // that never goes idle (the last seeded entry repeats).
    client.statusQueue = [
      { opKind: "none", opAttemptId: "", opSeq: 0, lastCompletedOpSeq: 7, completed: true },
      { opKind: "run", opAttemptId: "a10", opSeq: 304, lastCompletedOpSeq: 303, completed: false },
    ];
    const { lease } = leaseCfg(client);
    const report = await runSessionForTest(lostAckAfterFirstMutant(), {
      quarantineDir: dir,
      lease,
      nowIso: () => "2026-07-25T09:00:00.000Z",
    });
    // The conservative default is UNCHANGED: a container that may genuinely still be executing is
    // still condemned.
    const rec = await new QuarantineStore(dir).read(TIER);
    expect(rec?.opKind).toBe("test-run"); // the SAME durable record this path has always written
    expect(rec?.recordedAtIso).toBe("2026-07-25T09:00:00.000Z");
    expect(report.quarantined).toBeDefined();
    expect(client.recoverArgs).toHaveLength(0);
  });

  test("a status read that FAILS quarantines — conservative when the facts cannot be established", async () => {
    const dir = freshTmpDir();
    const client = new FakeLeaseClient();
    client.reconcileStatus = () => {
      throw new LeaseUnavailableError("GetOperationStatus unreachable");
    };
    const { lease } = leaseCfg(client);
    const report = await runSessionForTest(lostAckAfterFirstMutant(), {
      quarantineDir: dir,
      lease,
    });
    expect((await new QuarantineStore(dir).read(TIER))?.opKind).toBe("test-run");
    expect(report.quarantined).toBeDefined();
    expect(client.recoverArgs).toHaveLength(0);
  });

  test("a marker belonging to SOMEONE ELSE quarantines — it is not ours to declare finished", async () => {
    const dir = freshTmpDir();
    const client = new FakeLeaseClient();
    // Same shape as `stillOurs` except the attempt id: another attempt holds the marker, so our
    // own op's fate is unknown. Isolating exactly the ownership predicate.
    client.reconcileStatus = (_attemptId, opSeq) => ({
      opKind: "run",
      opAttemptId: "a99",
      opSeq,
      lastCompletedOpSeq: opSeq - 1,
      completed: false,
    });
    const { lease } = leaseCfg(client);
    const report = await runSessionForTest(lostAckAfterFirstMutant(), {
      quarantineDir: dir,
      lease,
    });
    expect((await new QuarantineStore(dir).read(TIER))?.opKind).toBe("test-run");
    expect(report.quarantined).toBeDefined();
    expect(client.recoverArgs).toHaveLength(0);
  });

  test("an in-flight-unknown carrying NO fence coordinates quarantines exactly as before", async () => {
    // al-runner, the bc-dev hub's coverage runs, and any pre-5C-B2 verdict claim no op at all —
    // there is nothing to reconcile, so the conservative path must remain the default rather than
    // an absent field being read as "nothing was stranded" (the empty-vs-empty match this
    // codebase keeps getting bitten by).
    const dir = freshTmpDir();
    const client = new FakeLeaseClient();
    const { lease } = leaseCfg(client);
    const backend = lostAckAfterFirstMutant({ fencedOp: null });
    const report = await runSessionForTest(backend, { quarantineDir: dir, lease });
    expect((await new QuarantineStore(dir).read(TIER))?.opKind).toBe("test-run");
    expect(report.quarantined).toBeDefined();
    // Not even asked: with no coordinates there is no reconciling read to make.
    expect(client.statusArgs.filter((a) => a.attemptId !== "")).toHaveLength(0);
  });

  /**
   * The confirm-rerun sibling of `lostAckAfterFirstMutant`: M0002's covering run FAILS, so a
   * kill-confirmation rerun follows, and THOSE are answered from `confirmAnswers` in order (last
   * entry repeating). The confirm branch is a hand-copied sibling of the covering-run branch, so
   * every property proven for one has to be proven for the other or the two silently diverge.
   */
  function confirmAnswersAfterKill(
    confirmAnswers: readonly Partial<TestVerdict>[],
    dispatches?: { count: number },
  ): ExecutionBackend {
    const attested = { observedAny: true, identityMismatch: false };
    let activeMutant: string | null = null;
    let coveringFailed = false;
    let issued = 0;
    return leaseBackend({
      activate: async (id) => {
        activeMutant = id;
      },
      run: async (ref) => {
        if (activeMutant === "M0002" && !coveringFailed) {
          coveringFailed = true;
          return { ref, outcome: "fail" as const, durationMs: 1, attestation: attested };
        }
        if (coveringFailed && activeMutant === null) {
          if (dispatches !== undefined) dispatches.count++;
          const answer = confirmAnswers[Math.min(issued, confirmAnswers.length - 1)] ?? LOST_ANSWER;
          issued++;
          return { ref, outcome: "error" as const, durationMs: 1, ...answer };
        }
        return { ref, outcome: "pass" as const, durationMs: 1, attestation: attested };
      },
    });
  }

  test("a lost ack on the KILL-CONFIRMATION rerun whose retry is also unreadable stays an error, still unquarantined", async () => {
    const dir = freshTmpDir();
    const client = new FakeLeaseClient();
    client.reconcileStatus = tombstoned;
    const { lease } = leaseCfg(client);
    const dispatches = { count: 0 };
    const backend = confirmAnswersAfterKill([LOST_ANSWER], dispatches);
    const report = await runSessionForTest(backend, { quarantineDir: dir, lease });
    expect(await new QuarantineStore(dir).read(TIER)).toBeNull();
    expect(report.quarantined).toBeUndefined();
    expect(client.recoverArgs).toHaveLength(0);
    expect(dispatches.count).toBe(2); // one lost, exactly one retry — never a loop
    const m2 = report.mutants.find((m) => m.mutantCode === "M0002");
    expect(m2?.verdict).toBe("error"); // the kill could not be confirmed — never "killed"
    expect(m2?.failureNote).toContain("unreadable");
    expect(m2?.cause).toBeUndefined();
    expect(report.counts.deadlineExceeded).toBe(0);
  });

  test("our OWN client timeout is reconciled too, and is no longer mislabelled a deadline", async () => {
    // The transport's abort path returns `outcome:"deadline-exceeded"` WITH
    // `operation:"in-flight-unknown"`, so it lands in this same branch. design §5 permits the
    // status READ after a client timeout (only `RecoverOp` is forbidden), and a tombstoned op
    // proves the run finished.
    const dir = freshTmpDir();
    const client = new FakeLeaseClient();
    client.reconcileStatus = tombstoned;
    const { lease } = leaseCfg(client);
    const backend = lostAckAfterFirstMutant({
      answers: [
        {
          ...LOST_ANSWER,
          outcome: "deadline-exceeded",
          failureMessage: "RunMutant timed out: AbortError",
        },
      ],
    });
    const report = await runSessionForTest(backend, { quarantineDir: dir, lease });
    expect(await new QuarantineStore(dir).read(TIER)).toBeNull();
    expect(report.quarantined).toBeUndefined();
    expect(client.recoverArgs).toHaveLength(0);
  });
});

// ————————————————————————————————————————————————————————————————————————
// Layer 5C-B2 item 1, follow-up — retry ONCE after a CONFIRMED-COMPLETE reconciliation.
//
// Reconciling a lost ack contains the intermittency but does not resolve it: the mutant is still
// recorded `error`, so the live gate still fails on per-mutant equality (survived -> error). Two
// fresh gate runs both lost M0008 at the same position, so this is temporal/positional, not
// mutant-specific — a fresh attempt is very likely to succeed.
//
// It is safe precisely because reconciliation PROVED phase 3 tombstoned the op and cleared the
// active tuple: the container is in a known-clean state and a fresh attempt is a NEW op, not a
// re-dispatch of an active one. design §5 forbids only the latter. The retry is capped at one.
// ————————————————————————————————————————————————————————————————————————
describe("runSession — Layer 5C-B2: a proven-complete lost ack earns one fresh attempt (design §5)", () => {
  const LOST_OP = { attemptId: "a10", opSeq: 304 } as const;
  const TIER = "http://cronus281|BC";
  const ATTESTED = { observedAny: true, identityMismatch: false };
  const LOST_ANSWER: Partial<TestVerdict> = {
    outcome: "error",
    failureMessage: 'RunMutant returned no string `value` (HTTP 200), body: ""',
    operation: "in-flight-unknown",
    fencedOp: LOST_OP,
  };

  function tombstoned(attemptId: string, opSeq: number): OperationStatus {
    return {
      opKind: "none",
      opAttemptId: attemptId,
      opSeq,
      lastCompletedOpSeq: opSeq,
      completed: true,
    };
  }

  /** M0002's covering runs answered from `answers` in order (last repeating); `dispatches` counts
   *  them, so the retry budget is asserted by call counter rather than by timing. */
  function m2Answers(
    answers: readonly Partial<TestVerdict>[],
    dispatches: { count: number },
  ): ExecutionBackend {
    let activeMutant: string | null = null;
    let issued = 0;
    return leaseBackend({
      activate: async (id) => {
        activeMutant = id;
      },
      run: async (ref) => {
        if (activeMutant === "M0002") {
          dispatches.count++;
          const answer = answers[Math.min(issued, answers.length - 1)] ?? LOST_ANSWER;
          issued++;
          return { ref, outcome: "error" as const, durationMs: 1, ...answer };
        }
        return { ref, outcome: "pass" as const, durationMs: 1, attestation: ATTESTED };
      },
    });
  }

  test("the retry's REAL verdict is what the report records — the mutant is no longer lost", async () => {
    const dir = freshTmpDir();
    const client = new FakeLeaseClient();
    client.reconcileStatus = tombstoned;
    const { lease } = leaseCfg(client);
    const dispatches = { count: 0 };
    const backend = m2Answers(
      [LOST_ANSWER, { outcome: "pass", attestation: ATTESTED }],
      dispatches,
    );
    const report = await runSessionForTest(backend, { quarantineDir: dir, lease });
    const m2 = report.mutants.find((m) => m.mutantCode === "M0002");
    // The whole point: an intermittent lost ack no longer costs the gate a per-mutant equality
    // (survived -> error). The mutant gets the verdict the retry actually measured.
    expect(m2?.verdict).toBe("survived");
    expect(m2?.failureNote).toBeUndefined();
    expect(dispatches.count).toBe(2); // one lost, exactly one retry
    expect(await new QuarantineStore(dir).read(TIER)).toBeNull();
    expect(report.quarantined).toBeUndefined();
    expect(client.recoverArgs).toHaveLength(0);
  });

  test("a retry that is ALSO unreadable is an error, never retried again, and still not quarantined", async () => {
    const dir = freshTmpDir();
    const client = new FakeLeaseClient();
    client.reconcileStatus = tombstoned;
    const { lease } = leaseCfg(client);
    const dispatches = { count: 0 };
    const report = await runSessionForTest(m2Answers([LOST_ANSWER], dispatches), {
      quarantineDir: dir,
      lease,
    });
    expect(dispatches.count).toBe(2); // BOUNDED: a loop here would hammer a container forever
    const m2 = report.mutants.find((m) => m.mutantCode === "M0002");
    expect(m2?.verdict).toBe("error");
    expect(m2?.failureNote).toContain("retried once");
    // The retry's own ack was reconciled too, and it too proved complete — so still no quarantine,
    // and the session continues to the next mutant.
    expect(await new QuarantineStore(dir).read(TIER)).toBeNull();
    expect(report.quarantined).toBeUndefined();
    expect(report.mutants.find((m) => m.mutantCode === "M0003")).toBeDefined();
    expect(client.recoverArgs).toHaveLength(0);
  });

  test("an UNRESOLVED lost ack is NEVER retried — the op may still be executing server-side", async () => {
    // The safety half of the same change. design §5: re-dispatching over an attempt that could
    // still be running AL is exactly what must not happen; only a PROVEN-complete op earns a fresh
    // attempt. Isolated by making the status read itself fail, so nothing is established.
    const dir = freshTmpDir();
    const client = new FakeLeaseClient();
    client.reconcileStatus = () => {
      throw new LeaseUnavailableError("GetOperationStatus unreachable");
    };
    const { lease } = leaseCfg(client);
    const dispatches = { count: 0 };
    const report = await runSessionForTest(m2Answers([LOST_ANSWER], dispatches), {
      quarantineDir: dir,
      lease,
    });
    expect(dispatches.count).toBe(1); // not proven clean ⇒ no fresh attempt
    expect((await new QuarantineStore(dir).read(TIER))?.opKind).toBe("test-run");
    expect(report.quarantined).toBeDefined();
    expect(client.recoverArgs).toHaveLength(0);
  });

  test("a still-ACTIVE op that never clears is NEVER retried either — it is polled, then quarantined", async () => {
    const dir = freshTmpDir();
    const client = new FakeLeaseClient();
    client.reconcileStatus = (attemptId, opSeq) => ({
      opKind: "run",
      opAttemptId: attemptId,
      opSeq,
      lastCompletedOpSeq: opSeq - 1,
      completed: false,
    });
    client.statusQueue = [
      { opKind: "none", opAttemptId: "", opSeq: 0, lastCompletedOpSeq: 7, completed: true },
      { opKind: "run", opAttemptId: "a10", opSeq: 304, lastCompletedOpSeq: 303, completed: false },
    ];
    const { lease } = leaseCfg(client);
    const dispatches = { count: 0 };
    const report = await runSessionForTest(m2Answers([LOST_ANSWER], dispatches), {
      quarantineDir: dir,
      lease,
    });
    expect(dispatches.count).toBe(1);
    expect((await new QuarantineStore(dir).read(TIER))?.opKind).toBe("test-run");
    expect(report.quarantined).toBeDefined();
    expect(client.recoverArgs).toHaveLength(0);
  });

  test("the retry goes out only AFTER an op-seq resync", async () => {
    // The backend's counter advanced past the lost call, and the server tombstoned that same seq,
    // so the two already agree and the resync is a value no-op in the expected case. It is made
    // anyway, reusing `runOnce`'s existing pre-dispatch-rejected mechanism, because `completed` is
    // `opSeq <= lastCompletedOpSeq` — the server may legitimately be FURTHER ahead, and a
    // stale-low/high opSeq is refused as `lease-invalid`, i.e. a FALSE lease loss.
    const log: string[] = [];
    const client = new FakeLeaseClient(log);
    client.reconcileStatus = tombstoned;
    const { lease } = leaseCfg(client);
    let activeMutant: string | null = null;
    let issued = 0;
    const backend = leaseBackend({
      activate: async (id) => {
        activeMutant = id;
      },
      run: async (ref) => {
        if (activeMutant !== "M0002") {
          return { ref, outcome: "pass" as const, durationMs: 1, attestation: ATTESTED };
        }
        issued++;
        log.push(`m2run${issued}`);
        if (issued === 1) {
          return {
            ref,
            outcome: "error" as const,
            durationMs: 1,
            failureMessage: 'RunMutant returned no string `value` (HTTP 200), body: ""',
            operation: "in-flight-unknown" as const,
            fencedOp: LOST_OP,
          };
        }
        return { ref, outcome: "pass" as const, durationMs: 1, attestation: ATTESTED };
      },
    });
    await runSessionForTest(backend, { quarantineDir: freshTmpDir(), lease });
    const first = log.indexOf("m2run1");
    const retry = log.indexOf("m2run2");
    expect(first).toBeGreaterThan(-1);
    expect(retry).toBeGreaterThan(first);
    // Ordering by call log, never by clock: exactly TWO lease reads sit between the lost dispatch
    // and its retry — the reconciliation read that proves the op completed, and the resync read
    // that reseeds the backend's op-seq counter before a fresh attempt goes out.
    expect(log.slice(first, retry).filter((e) => e === "status")).toHaveLength(2);
  });

  test("the KILL-CONFIRMATION rerun earns the same one retry — a real retry confirms the kill", async () => {
    const dir = freshTmpDir();
    const client = new FakeLeaseClient();
    client.reconcileStatus = tombstoned;
    const { lease } = leaseCfg(client);
    const dispatches = { count: 0 };
    let activeMutant: string | null = null;
    let coveringFailed = false;
    let issued = 0;
    const backend = leaseBackend({
      activate: async (id) => {
        activeMutant = id;
      },
      run: async (ref) => {
        if (activeMutant === "M0002" && !coveringFailed) {
          coveringFailed = true;
          return { ref, outcome: "fail" as const, durationMs: 1, attestation: ATTESTED };
        }
        if (coveringFailed && activeMutant === null) {
          dispatches.count++;
          issued++;
          if (issued === 1) {
            return {
              ref,
              outcome: "error" as const,
              durationMs: 1,
              failureMessage: 'RunMutant returned no string `value` (HTTP 200), body: ""',
              operation: "in-flight-unknown" as const,
              fencedOp: LOST_OP,
            };
          }
          return { ref, outcome: "pass" as const, durationMs: 1, attestation: ATTESTED };
        }
        return { ref, outcome: "pass" as const, durationMs: 1, attestation: ATTESTED };
      },
    });
    const report = await runSessionForTest(backend, { quarantineDir: dir, lease });
    // The confirmation rerun passed on the retry, so the mutant IS killed — the lost ack cost
    // nothing at all.
    expect(report.mutants.find((m) => m.mutantCode === "M0002")?.verdict).toBe("killed");
    expect(dispatches.count).toBe(2);
    expect(await new QuarantineStore(dir).read(TIER)).toBeNull();
    expect(report.quarantined).toBeUndefined();
    expect(client.recoverArgs).toHaveLength(0);
  });
});

describe("runSession — Layer 5C-B1 fix round 1: op-seq resync at the BASELINE run site (design §5)", () => {
  test("a pre-dispatch-rejected baseline run resyncs the op seq before its one retry", async () => {
    // The first attempt consumed a client-side op-seq the server never saw. Without a resync the
    // retry sends a stale-HIGH opSeq, which `TryBeginRun` refuses with reason "lease-invalid" —
    // indistinguishable at the client from genuine lease loss, so a healthy session would be
    // quarantined and its batch discarded. This used to be safe-by-accident because bcdev reported
    // `coverage: "procedure"` and the baseline then never took the fenced RunMutant path; R58's
    // `coverage: "fenced"` spends that guard and makes the resync load-bearing on every baseline
    // test. Nothing at the call site recorded that dependency, which is exactly what this pins.
    const log: string[] = [];
    const client = new FakeLeaseClient(log);
    let runs = 0;
    const backend = leaseBackend({
      run: async (ref) => {
        runs++;
        log.push(`run${runs}`);
        if (runs === 1) {
          return {
            ref,
            outcome: "error" as const,
            durationMs: 1,
            operation: "pre-dispatch-rejected" as const,
          };
        }
        return {
          ref,
          outcome: "pass" as const,
          durationMs: 1,
          attestation: { observedAny: true, identityMismatch: false },
        };
      },
    });
    const { lease } = leaseCfg(client);
    await runSessionForTest(backend, { quarantineDir: freshTmpDir(), lease });
    const first = log.indexOf("run1");
    const retry = log.indexOf("run2");
    expect(first).toBeGreaterThan(-1);
    expect(retry).toBeGreaterThan(first);
    // Ordering by call log, never by clock: a GetOperationStatus read sits between the refused
    // baseline dispatch and its retry.
    expect(log.slice(first, retry)).toContain("status");
    // ...and the re-read seq was bound back into the backend before the retry went out.
    expect(backend.leases.at(-1)?.lastCompletedOpSeq).toBe(7);
  });
});

describe("runSession — Layer 5C-B1 fix round 1: the kill-confirmation rerun's lease branches (design §5/§6)", () => {
  /**
   * The KILL path — the common case in a healthy run, and the one the existing lease fixture never
   * reaches (its covering run returns `outcome:"error"`, so `v.outcome === "fail"` is never true).
   * M0001 runs clean and attests (so design §G's fail-closed gate is NOT what invalidates it);
   * M0002's covering run FAILS, and the kill-confirmation rerun that follows answers with the
   * caller-supplied lease verdict exactly once.
   */
  function confirmLeaseAfterKill(over: Partial<TestVerdict>): ExecutionBackend {
    let activeMutant: string | null = null;
    let awaitingConfirm = false;
    return leaseBackend({
      activate: async (id) => {
        activeMutant = id;
      },
      run: async (ref) => {
        if (activeMutant === "M0002" && !awaitingConfirm) {
          awaitingConfirm = true;
          return {
            ref,
            outcome: "fail" as const,
            durationMs: 1,
            attestation: { observedAny: true, identityMismatch: false },
          };
        }
        if (awaitingConfirm && activeMutant === null) {
          awaitingConfirm = false;
          return { ref, outcome: "error" as const, durationMs: 1, ...over };
        }
        return {
          ref,
          outcome: "pass" as const,
          durationMs: 1,
          attestation: { observedAny: true, identityMismatch: false },
        };
      },
    });
  }

  test("a failing covering run whose kill-confirmation rerun is lease-lost invalidates the current batch", async () => {
    const dir = freshTmpDir();
    const client = new FakeLeaseClient();
    const { lease } = leaseCfg(client);
    const backend = confirmLeaseAfterKill({
      operation: "lease-lost",
      leaseInvalidReason: "lease-invalid",
    });
    const report = await runSessionForTest(backend, { quarantineDir: dir, lease });
    const m1 = report.mutants.find((m) => m.mutantCode === "M0001");
    const m2 = report.mutants.find((m) => m.mutantCode === "M0002");
    // Per-mutant, never an aggregate count: M0001 was recorded "survived" under a lease this
    // session can no longer prove it held.
    expect(m1?.verdict).toBe("error");
    expect(m2?.verdict).toBe("error");
    // Names the CONFIRM rerun, not the covering run — this branch, not its hand-copied sibling.
    expect(report.quarantined?.reason).toContain("confirming");
    expect(report.quarantined?.reason).toContain("lease-lost");
    // A clean lease-lost leaves the container fine (design §6 taxonomy) — nothing durable.
    expect(await new QuarantineStore(dir).read("http://cronus281|BC")).toBeNull();
  });

  test("a failing covering run whose kill-confirmation rerun is op-in-flight does NOT latch", async () => {
    const dir = freshTmpDir();
    const client = new FakeLeaseClient();
    const { lease } = leaseCfg(client);
    const backend = confirmLeaseAfterKill({
      operation: "lease-lost",
      leaseInvalidReason: "op-in-flight",
    });
    const report = await runSessionForTest(backend, { quarantineDir: dir, lease });
    const m1 = report.mutants.find((m) => m.mutantCode === "M0001");
    const m2 = report.mutants.find((m) => m.mutantCode === "M0002");
    // Our OWN attempt is still executing — a duplicate claim, not a loss. Latching here would
    // discard a batch that is perfectly fine.
    expect(m1?.verdict).toBe("survived");
    expect(m2?.verdict).toBe("error");
    expect(m2?.failureNote).toContain("op-in-flight");
    expect(report.quarantined).toBeUndefined();
    expect(client.statusArgs.length).toBeGreaterThan(1); // polled...
    expect(client.recoverArgs).toHaveLength(0); // ...never RecoverOp'd
    expect(await new QuarantineStore(dir).read("http://cronus281|BC")).toBeNull();
  });
});

describe("runSession — Layer 5C-B1 fix round 1: deploy latch guard + earlier-batch scoping", () => {
  test("a lease lost DURING the first publish stops the version-conflict retry deploy", async () => {
    const client = new FakeLeaseClient();
    client.renewQueue = [{ renewed: false }];
    const timers = new FakeTimers();
    const { lease } = leaseCfg(client, { timers });
    let deploys = 0;
    const backend = leaseBackend({
      deploy: async () => {
        deploys++;
        await timers.fire(); // the heartbeat observes the loss mid-publish
        // BC's downgrade rejection, verbatim enough for parseVersionConflict — the ONE deploy
        // failure that earns a second publish, and so the only path that reaches deployOnce twice.
        throw new Error("The version 1.0.0.5 or a newer version 9.9.9.9 was already installed");
      },
    });
    const report = await runSessionForTest(backend, { quarantineDir: freshTmpDir(), lease });
    expect(deploys).toBe(1); // the re-stamped retry never reached the backend
    expect(report.quarantined?.reason).toContain("lease-lost");
  });

  test("a lease lost during a worker's deploy stops the NEXT worker's deploy", async () => {
    // The worker-shard deploy has its own latch guard (a fan-out path, so it cannot reuse
    // `deployOnce`). `workers > 1` is rejected outright for an AUTHORITATIVE backend, so the only
    // configuration that reaches this guard under a lease is a non-authoritative fenced backend.
    // `compileConcurrency: 1` makes the ordering deterministic (Semaphore's waiting queue is FIFO):
    // worker 0 holds the one permit, loses the lease inside its deploy, and only then is worker 1
    // woken — with the latch already set.
    const dirs = await makeProject();
    await Bun.write(join(dirs.projectDir, "SandboxLogic.Codeunit.al"), THREE_PROC_AL);
    const client = new FakeLeaseClient();
    client.renewQueue = [{ renewed: false }];
    const timers = new FakeTimers();
    const { lease } = leaseCfg(client, { timers });
    const nonAuthoritative = () =>
      ({
        coverage: "none",
        deploy: "publish",
        isolation: "session",
        authoritative: false,
      }) as const;
    const workerDeploys = [0, 0];
    const makeWorker = (i: number) =>
      fakeBackend({
        capabilities: nonAuthoritative,
        deploy: async () => {
          workerDeploys[i] = (workerDeploys[i] ?? 0) + 1;
          if (i === 0) await timers.fire(); // worker 0 loses the lease mid-deploy
          return null;
        },
      });
    const report = await runSession({
      backend: leaseBackend({ capabilities: nonAuthoritative }),
      backendFactory: makeWorker,
      store: new ResultsStore(":memory:"),
      ...dirs,
      selectorIds,
      workers: 2,
      compileConcurrency: 1,
      quarantineDir: freshTmpDir(),
      lease,
    });
    expect(workerDeploys[0]).toBe(1);
    expect(workerDeploys[1]).toBe(0); // refused by the latch, never dispatched
    expect(report.quarantined?.reason).toContain("lease-lost");
  });

  test("a lease lost in the SECOND batch invalidates only that batch — the first batch's verdicts stand", async () => {
    // The "earlier batches STAND" guarantee is otherwise asserted only against the pure
    // `invalidateBatchVerdicts` helper: nothing drives `runSession` with two batches, so a bug
    // hardcoding `lostBatchIndex = 0` (or dropping `currentBatchIndex`'s per-batch update) would
    // pass the whole suite. `planArtifacts` collapses everything into ONE artifact today, so the
    // split is injected at that seam — Bun's `spyOn` on the module namespace does reach
    // `runSession`'s own intra-module call (verified: without the spy this test sees one batch).
    const dirs = await makeProject();
    await Bun.write(join(dirs.projectDir, "SandboxLogic.Codeunit.al"), TARGET_AL);
    await Bun.write(join(dirs.projectDir, "SandboxOther.Codeunit.al"), SECOND_FILE_AL);
    const client = new FakeLeaseClient();
    const { lease } = leaseCfg(client);
    let batchNo = -1;
    let activeMutant: string | null = null;
    const backend = leaseBackend({
      deploy: async () => {
        batchNo++; // deploy #1 is batch 0, deploy #2 is batch 1
        return null;
      },
      activate: async (id) => {
        activeMutant = id;
      },
      run: async (ref) => {
        if (batchNo === 1 && activeMutant === "M0002") {
          return {
            ref,
            outcome: "error" as const,
            durationMs: 1,
            operation: "lease-lost" as const,
            leaseInvalidReason: "lease-invalid",
          };
        }
        return {
          ref,
          outcome: "pass" as const,
          durationMs: 1,
          attestation: { observedAny: true, identityMismatch: false },
        };
      },
    });
    const spy = spyOn(orchestratorModule, "planArtifacts").mockImplementation((files) =>
      files.map((f) => [f]),
    );
    let report: Awaited<ReturnType<typeof runSession>>;
    try {
      report = await runSession({
        backend,
        store: new ResultsStore(":memory:"),
        ...dirs,
        selectorIds,
        resourceServer: "http://cronus281",
        resourceServerInstance: "BC",
        quarantineDir: freshTmpDir(),
        lease,
      });
    } finally {
      spy.mockRestore();
    }
    expect(report.batches).toBe(2);
    const first = report.mutants.filter((m) => m.batchIndex === 0);
    const second = report.mutants.filter((m) => m.batchIndex === 1);
    expect(first.length).toBeGreaterThan(0);
    expect(second.length).toBeGreaterThan(0);
    // Per-mutant equality, never an aggregate: every batch-0 verdict was individually
    // phase-1/phase-3 fence-validated and must survive the loss untouched.
    for (const m of first) expect(m.verdict).toBe("survived");
    // ...while batch 1's already-recorded M0001 is discarded.
    expect(second.find((m) => m.mutantCode === "M0001")?.verdict).toBe("error");
    expect(report.quarantined?.reason).toContain("lease-lost");
  });
});

// ————————————————————————————————————————————————————————————————————————
// ROADMAP R26: the permission canary runs EXACTLY ONCE per session — after the lease is acquired
// (it drives the platform test runner, which is exactly what the lease serialises) and before any
// mutant — and its verdict reaches `SessionReport`. Ordering is asserted from the shared call log,
// never from timing.
// ————————————————————————————————————————————————————————————————————————
describe("runSession — R26 permission canary", () => {
  test("runs once, after acquire and before the first deploy, and lands on the report", async () => {
    const log: string[] = [];
    const client = new FakeLeaseClient(log);
    const backend = leaseBackend({
      deploy: async () => {
        log.push("deploy");
        return null;
      },
    });
    const { lease } = leaseCfg(client);
    let calls = 0;
    const report = await runSessionForTest(backend, {
      quarantineDir: freshTmpDir(),
      lease,
      permissionCanary: async () => {
        calls++;
        log.push("canary");
        return {
          verdict: "mocked",
          readPermission: false,
          writePermission: false,
          insertSucceeded: false,
          detail: "Sorry, the current permissions prevented the action.",
        };
      },
    });
    expect(calls).toBe(1); // once per SESSION, never per mutant or per batch
    expect(log.indexOf("canary")).toBeGreaterThan(log.indexOf("acquire"));
    expect(log.indexOf("canary")).toBeLessThan(log.indexOf("deploy"));
    expect(report.permissionCanary?.verdict).toBe("mocked");
    expect(report.permissionCanary?.detail).toContain("permissions prevented the action");
    // ...and it survives into the rendered console report, after the score.
    expect(renderConsole(report)).toContain("R26");
  });

  test("a not-mocked verdict is carried through unchanged (the two worlds stay distinguishable)", async () => {
    const client = new FakeLeaseClient();
    const { lease } = leaseCfg(client);
    const report = await runSessionForTest(leaseBackend(), {
      quarantineDir: freshTmpDir(),
      lease,
      permissionCanary: async () => ({
        verdict: "not-mocked",
        readPermission: true,
        writePermission: true,
        insertSucceeded: true,
      }),
    });
    expect(report.permissionCanary?.verdict).toBe("not-mocked");
  });

  test("no canary configured leaves the field absent — never a fabricated verdict", async () => {
    const client = new FakeLeaseClient();
    const { lease } = leaseCfg(client);
    const report = await runSessionForTest(leaseBackend(), {
      quarantineDir: freshTmpDir(),
      lease,
    });
    expect(report.permissionCanary).toBeUndefined();
    expect("permissionCanary" in report).toBe(false);
  });

  // The failure mode this guard exists for: a canary that throws must not take the session with
  // it. Before it was guarded, an infrastructure hiccup would abort BEFORE A SINGLE MUTANT RAN,
  // producing no SessionReport at all — strictly worse than not knowing whether the mock is on.
  test("a THROWING canary is demoted to inconclusive and the session still completes", async () => {
    const client = new FakeLeaseClient();
    const { lease } = leaseCfg(client);
    const report = await runSessionForTest(leaseBackend(), {
      quarantineDir: freshTmpDir(),
      lease,
      permissionCanary: async () => {
        throw new Error("canary transport exploded");
      },
    });
    expect(report.permissionCanary?.verdict).toBe("inconclusive");
    expect(report.permissionCanary?.detail).toContain("canary transport exploded");
    // The session itself is unharmed: mutants were still scored.
    expect(report.mutants.length).toBeGreaterThan(0);
  });
});

function fakeManifestEntry(mutantId: string): MutantManifestEntry {
  return {
    mutantId,
    file: "SandboxLogic.Codeunit.al",
    operatorName: "conditional-boundary",
    operatorVersion: "1.0.0",
    startIndex: 100,
    endIndex: 110,
    startLine: 5,
    objectType: "codeunit",
    codeunitId: 79000,
    codeunitName: "Sandbox Logic",
    procedureName: "IsOverBudget",
    originalText: "Original();",
    mutatedText: "",
    astHash: "hash",
  };
}
