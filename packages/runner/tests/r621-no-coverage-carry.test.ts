// R621: before the fix, `--resume` carried a stored `no-coverage` without checking it against THIS
// session's coverage. Now a stored no-coverage is never carried: it is re-derived. Written
// test-first: the "covered now" cases were RED on master (they carried); the "uncovered now"
// controls are green either way.
// What makes coverage differ between the two sessions here is the backend's covered set. A real
// cause on one test app and target: `--resume` allows a TARGET edit (a batch with work left is
// rebuilt), so a covered procedure edited to call an uncovered one makes it covered, while the
// uncovered procedure's own mutants keep their keys and carry.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type {
  BackendCapabilities,
  BackendStatus,
  ExecutionBackend,
  PackageUnread,
  RunOpts,
  TestMethodRef,
  TestVerdict,
} from "../src/backend";
import type { MicrosoftMode } from "../src/digest-inputs";
import type { RunEvent } from "../src/events";
import { runSession } from "../src/orchestrator";
import type { SessionReport } from "../src/report";
import { ResultsStore } from "../src/store";
import { servedIsInstalled, testAppJson, testAppPackage } from "./helpers/proven-test-app";
import { scratchDirs } from "./helpers/scratch";

const scratch = scratchDirs();

const LOGIC_AL = `codeunit 79000 "Sandbox Logic"
{
    procedure IsOverBudget(Amount: Decimal; Budget: Decimal): Boolean
    begin
        exit(Amount > Budget);
    end;
}
`;
/** The realistic cause: the covered procedure, edited between the sessions, now calls UnderLimit. */
const LOGIC_CALLS_EXTRA_AL = `codeunit 79000 "Sandbox Logic"
{
    procedure IsOverBudget(Amount: Decimal; Budget: Decimal): Boolean
    var
        Extra: Codeunit "Sandbox Extra";
    begin
        if Extra.UnderLimit(Amount, Budget) then;
        exit(Amount > Budget);
    end;
}
`;
const EXTRA_AL = `codeunit 79002 "Sandbox Extra"
{
    procedure UnderLimit(Amount: Decimal; Limit: Decimal): Boolean
    begin
        exit(Amount < Limit);
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
const APP_JSON = JSON.stringify({
  id: "6d0f4a2e-1c3b-4a8d-9f10-2b7c5e4d3a91",
  name: "Sandbox R621 Fixture",
  publisher: "LethAL",
  version: "1.0.0.0",
  idRanges: [{ from: 79000, to: 79199 }],
});
const selectorIds = { selectorId: 50000, controlId: 50001, tableId: 50002 };
const LOGIC = { objectType: "Codeunit", objectId: 79000, procedure: "IsOverBudget" };
const EXTRA = { objectType: "Codeunit", objectId: 79002, procedure: "UnderLimit" };

/** bcdev shape (resume.test.ts's CountingBackend, cut down): the baseline reports `covered`;
 *  every mutant is killed; aborts after `abortAfter` mutant runs or from deploy `abortFromDeploy`. */
class CoverBackend implements ExecutionBackend {
  mutantRuns = 0;
  baselineRuns = 0;
  deploys = 0;
  private active: string | null = null;
  constructor(
    private readonly covered: ReadonlyArray<typeof LOGIC>,
    private readonly abort: { readonly after?: number; readonly fromDeploy?: number } = {},
  ) {}
  served: Uint8Array | PackageUnread = testAppPackage();
  async fetchPublishedAppPackage(): Promise<Uint8Array | PackageUnread> {
    return this.served;
  }
  microsoftMode(): MicrosoftMode {
    return servedIsInstalled(() => this.served);
  }
  capabilities(): BackendCapabilities {
    return {
      coverage: "procedure",
      deploy: "publish",
      isolation: "session",
      kind: "bcdev",
      authoritative: true,
    };
  }
  async status(): Promise<BackendStatus> {
    return { ok: true, details: "stub" };
  }
  async deploy(): Promise<null> {
    this.deploys += 1;
    return null;
  }
  async compileCheck(): Promise<void> {}
  async activate(id: string | null): Promise<void> {
    this.active = id;
  }
  async run(ref: TestMethodRef, opts: RunOpts): Promise<TestVerdict> {
    if (this.active === null) {
      this.baselineRuns += 1;
      return {
        ref,
        outcome: "pass",
        durationMs: 5,
        coverage: { granularity: "procedure" as const, entries: [...this.covered] },
      };
    }
    this.mutantRuns += 1;
    const { after, fromDeploy } = this.abort;
    if (
      (after !== undefined && this.mutantRuns > after) ||
      (fromDeploy !== undefined && this.deploys >= fromDeploy)
    ) {
      return {
        ref,
        outcome: "error",
        durationMs: 5,
        operation: "in-flight-unknown",
        failureMessage: "RunMutant timed out: AbortError",
      };
    }
    return {
      ref,
      outcome: "fail",
      durationMs: 5,
      failureMessage: "Assert.IsTrue failed",
      ...(opts.coverage === "none"
        ? { attestation: { observedAny: true, identityMismatch: false } }
        : {}),
    };
  }
}

async function project() {
  const root = scratch("lethal-r621-");
  const dirs = {
    projectDir: join(root, "app"),
    testDir: join(root, "tests"),
    instrumentedDir: join(root, "instr"),
  };
  await Bun.write(join(dirs.projectDir, "SandboxLogic.Codeunit.al"), LOGIC_AL);
  await Bun.write(join(dirs.projectDir, "SandboxExtra.Codeunit.al"), EXTRA_AL);
  await Bun.write(join(dirs.projectDir, "app.json"), APP_JSON);
  await Bun.write(join(dirs.testDir, "SandboxTests.Codeunit.al"), TEST_AL);
  await Bun.write(join(dirs.testDir, "app.json"), testAppJson());
  return dirs;
}
const inExtra = (r: SessionReport) => r.mutants.filter((m) => m.procedureName === "UnderLimit");

/** Run 1 leaves UnderLimit uncovered (no-coverage) and aborts; run 2 resumes with `nowCovered`. */
async function scenario(
  shape: "whole" | "partial",
  nowCovered: ReadonlyArray<typeof LOGIC>,
  editLogic = false,
  /** Drop run 1's baseline snapshots, so run 2 measures coverage fresh. With one on record for an
   *  unchanged instrumented tree and test app, run 2 reuses it (R192), coverage included. */
  noSnapshot = false,
) {
  const dirs = await project();
  const store = new ResultsStore(":memory:");
  // whole: one file per batch; abort in the second batch, so the first is fully scored.
  // partial: one batch; abort after one mutant run, so the batch is part-scored.
  const split = shape === "whole" ? { maxGuardsPerBatch: 1 } : {};
  const first = new CoverBackend([LOGIC], shape === "whole" ? { fromDeploy: 2 } : { after: 1 });
  const r1 = await runSession({ backend: first, store, ...dirs, selectorIds, ...split });
  if (editLogic)
    await Bun.write(join(dirs.projectDir, "SandboxLogic.Codeunit.al"), LOGIC_CALLS_EXTRA_AL);
  if (noSnapshot) store.db.run("DELETE FROM baseline_snapshots");
  const second = new CoverBackend(nowCovered);
  const events: RunEvent[] = [];
  const r2 = await runSession({
    backend: second,
    store,
    ...dirs,
    selectorIds,
    ...split,
    resume: "last",
    emit: [(e) => events.push(e)],
  });
  store.close();
  return { r1, r2, events, second };
}

describe("R621: a stored no-coverage carries only when this session leaves the mutant uncovered too", () => {
  test("setup: run 1 stored UnderLimit's mutants as no-coverage, and the run is unfinished", async () => {
    for (const shape of ["whole", "partial"] as const) {
      const { r1 } = await scenario(shape, [LOGIC]);
      expect(inExtra(r1).length).toBeGreaterThan(0);
      expect(inExtra(r1).every((m) => m.verdict === "no-coverage")).toBe(true);
    }
  });

  test("(1) a batch whose every mutant was scored, one stored no-coverage, covered now: not carried whole, re-run", async () => {
    const { r1, r2, events } = await scenario("whole", [LOGIC, EXTRA], false, true);
    // Precondition: Extra's batch was fully scored in run 1 (all no-coverage), so on master it is
    // the whole-batch path (`replayCarriedBatch`) that carries it.
    const extraBatch = inExtra(r1)[0]?.batchIndex;
    expect(
      r1.mutants
        .filter((m) => m.batchIndex === extraBatch)
        .every((m) => m.verdict === "no-coverage"),
    ).toBe(true);
    // This session's coverage reaches UnderLimit, so its mutants are measured: killed.
    expect(inExtra(r2).map((m) => m.verdict)).toEqual(inExtra(r1).map(() => "killed"));
    expect(inExtra(r2).some((m) => m.carried === true)).toBe(false);
    expect(events.some((e) => e.type === "warning" && e.code === "resume-batch-carried")).toBe(
      false,
    );
  });

  test("(2) partly carried batch (scoreBatch), covered now: re-run, fresh coverage wins", async () => {
    const { r1, r2 } = await scenario("partial", [LOGIC, EXTRA], false, true);
    expect(r1.batches).toBe(1);
    expect(inExtra(r2).map((m) => m.verdict)).toEqual(inExtra(r1).map(() => "killed"));
    expect(inExtra(r2).some((m) => m.carried === true)).toBe(false);
  });

  test("with run 1's snapshot on record (same tree, same test app), the re-derived verdict follows its coverage (R192's trust, R643), never a carry", async () => {
    for (const shape of ["whole", "partial"] as const) {
      const { r1, r2 } = await scenario(shape, [LOGIC, EXTRA]);
      expect(inExtra(r2).map((m) => m.verdict)).toEqual(inExtra(r1).map(() => "no-coverage"));
      expect(inExtra(r2).some((m) => m.carried === true)).toBe(false);
    }
  });

  test("(1) and (2) through a real cause: a target edit makes UnderLimit covered; the resume is not refused", async () => {
    const got: string[] = [];
    const want: string[] = [];
    for (const shape of ["whole", "partial"] as const) {
      const { r1, r2 } = await scenario(shape, [LOGIC, EXTRA], true);
      expect(r2.resumedFrom).toBeDefined();
      got.push(...inExtra(r2).map((m) => `${shape}:${m.verdict}`));
      want.push(...inExtra(r1).map(() => `${shape}:killed`));
    }
    expect(got).toEqual(want);
  });

  test("control (1): whole batch, uncovered now: stays no-coverage", async () => {
    const { r1, r2 } = await scenario("whole", [LOGIC]);
    expect(inExtra(r2).map((m) => m.verdict)).toEqual(inExtra(r1).map(() => "no-coverage"));
  });

  test("control (2): partial batch, uncovered now: re-derived fresh as no-coverage (not carried)", async () => {
    const { r1, r2 } = await scenario("partial", [LOGIC]);
    expect(inExtra(r2).map((m) => m.verdict)).toEqual(inExtra(r1).map(() => "no-coverage"));
    expect(inExtra(r2).some((m) => m.carried === true)).toBe(false);
  });
});
