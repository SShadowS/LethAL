import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MutantManifestEntry } from "@lethal/schemata";
import type { CompiledArtifact } from "../src/artifact";
import type {
  BackendCapabilities,
  BackendStatus,
  ExecutionBackend,
  RunOpts,
  TestMethodRef,
  TestVerdict,
} from "../src/backend";
import type { RunEvent } from "../src/events";
import { runSession } from "../src/orchestrator";
import {
  CARRYABLE_VERDICTS,
  STRANDED_NOTE_PREFIX,
  STRANDED_SKIP_NOTE,
  batchCarriesEntirely,
  buildResumeIndex,
  carriedVerdictFor,
  isStrandedNote,
  sessionFingerprint,
  wasStranded,
} from "../src/resume";
import type { SessionFingerprintInput } from "../src/resume";
import { ResultsStore } from "../src/store";
import type { MutantVerdictRow } from "../src/store";

/**
 * R47 — resuming an aborted run.
 *
 * Measured failure this closes: attempting an all-tests sweep on Continia Document Output, one slow
 * (mutant, test) pair exceeded the per-mutant budget at mutant 13 of 138. The session correctly
 * refused to score anything it could not vouch for — and threw away the twelve verdicts it had
 * already measured, which SQLite had been holding the whole time.
 */

const APP_ID = "6d0f4a2e-1c3b-4a8d-9f10-2b7c5e4d3a91";
const APP_JSON = JSON.stringify({
  id: APP_ID,
  name: "Sandbox Resume Fixture",
  publisher: "LethAL",
  version: "1.0.0.0",
  idRanges: [{ from: 79000, to: 79199 }],
});

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

const CAPS: BackendCapabilities = {
  coverage: "procedure",
  deploy: "publish",
  isolation: "session",
  authoritative: true,
};

const selectorIds = { selectorId: 50000, controlId: 50001, tableId: 50002 };

/** A second carrier so `maxGuardsPerBatch` can split the project across two artifacts — batching is
 *  at FILE granularity, so one file can never be split. */
const SECOND_AL = `codeunit 79002 "Sandbox Extra"
{
    procedure UnderLimit(Amount: Decimal; Limit: Decimal): Boolean
    begin
        exit(Amount < Limit);
    end;
}
`;

async function makeProject(opts: { secondFile?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "lethal-resume-"));
  const projectDir = join(root, "app");
  const testDir = join(root, "tests");
  const instrumentedDir = join(root, "instr");
  await Bun.write(join(projectDir, "SandboxLogic.Codeunit.al"), TARGET_AL);
  if (opts.secondFile === true) {
    await Bun.write(join(projectDir, "SandboxExtra.Codeunit.al"), SECOND_AL);
  }
  await Bun.write(join(projectDir, "app.json"), APP_JSON);
  await Bun.write(join(testDir, "SandboxTests.Codeunit.al"), TEST_AL);
  return { projectDir, testDir, instrumentedDir };
}

/**
 * Counts every mutant-active run, so a resumed session can be proven to have executed nothing.
 *
 * `abortAfter` reproduces the R47 failure: after N mutant runs, the next one comes back
 * `in-flight-unknown`, which the orchestrator correctly refuses to score, latching the session
 * unsafe and quarantining. Such a run never reaches `store.finishRun` — that is precisely the state
 * `--resume` looks for, and the mutants scored BEFORE the abort are what it recovers.
 */
class CountingBackend implements ExecutionBackend {
  mutantRuns = 0;
  /** R192 (second half): runs with NO mutant active, i.e. the baseline. */
  baselineRuns = 0;
  deploys = 0;
  private activations: Array<string | null> = [];
  constructor(
    private readonly outcome: TestVerdict["outcome"] = "pass",
    private readonly abortAfter?: number,
    /** Abort once this many artifacts have been deployed — i.e. abort in batch N, leaving batches
     *  0..N-1 fully scored. Counting deploys rather than mutants keeps the test independent of how
     *  many sites the fixture happens to generate. */
    private readonly abortFromDeploy?: number,
  ) {}
  capabilities(): BackendCapabilities {
    return CAPS;
  }
  async status(): Promise<BackendStatus> {
    return { ok: true, details: "stub" };
  }
  async deploy(): Promise<CompiledArtifact | null> {
    this.deploys += 1;
    return null;
  }
  async compileCheck(): Promise<void> {}
  async activate(id: string | null): Promise<void> {
    this.activations.push(id);
  }
  async run(ref: TestMethodRef, opts: RunOpts): Promise<TestVerdict> {
    const active = this.activations.at(-1) ?? null;
    if (active !== null) this.mutantRuns += 1;
    else this.baselineRuns += 1;
    const aborts =
      active !== null &&
      ((this.abortAfter !== undefined && this.mutantRuns > this.abortAfter) ||
        (this.abortFromDeploy !== undefined && this.deploys >= this.abortFromDeploy));
    if (aborts) {
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
      outcome: active === null ? "pass" : this.outcome,
      durationMs: 5,
      ...(active === null
        ? {
            coverage: {
              granularity: "procedure" as const,
              // Both carriers, so a two-batch split leaves BOTH batches covered — an uncovered
              // batch contributes nothing and would sidestep the attestation gate entirely.
              entries: [
                { objectType: "Codeunit", objectId: 79000, procedure: "IsOverBudget" },
                { objectType: "Codeunit", objectId: 79002, procedure: "UnderLimit" },
              ],
            },
          }
        : {}),
      ...(opts.coverage === "none"
        ? { attestation: { observedAny: true, identityMismatch: false } }
        : {}),
    };
  }
}

/**
 * An authoritative backend whose runs never attest — the shape of a wrong or stale container, where
 * every test passes because the instrumented binary is not the one executing. Trips the fail-closed
 * attestation gate (design §G).
 */
class NeverAttestingBackend implements ExecutionBackend {
  private activations: Array<string | null> = [];
  capabilities(): BackendCapabilities {
    return CAPS;
  }
  async status(): Promise<BackendStatus> {
    return { ok: true, details: "stub" };
  }
  async deploy(): Promise<CompiledArtifact | null> {
    return null;
  }
  async compileCheck(): Promise<void> {}
  async activate(id: string | null): Promise<void> {
    this.activations.push(id);
  }
  async run(ref: TestMethodRef): Promise<TestVerdict> {
    const active = this.activations.at(-1) ?? null;
    return {
      ref,
      outcome: "pass",
      durationMs: 5,
      ...(active === null
        ? {
            coverage: {
              granularity: "procedure" as const,
              // Both carriers, so a two-batch split leaves BOTH batches covered — an uncovered
              // batch contributes nothing and would sidestep the attestation gate entirely.
              entries: [
                { objectType: "Codeunit", objectId: 79000, procedure: "IsOverBudget" },
                { objectType: "Codeunit", objectId: 79002, procedure: "UnderLimit" },
              ],
            },
          }
        : {}),
      // No `attestation` on any path — that is the whole point.
    };
  }
}

function tmpdirSync(): string {
  return mkdtempSync(join(tmpdir(), "lethal-store-"));
}

function row(over: Partial<MutantVerdictRow> = {}): MutantVerdictRow {
  return {
    astHash: "hash-a",
    codeunitName: "Sandbox Logic",
    procedureName: "Post",
    operatorName: "lethal.negate-conditional",
    operatorMajor: 1,
    identityOrdinal: 0,
    verdict: "survived",
    durationMs: 42,
    ...over,
  };
}

/** A manifest entry whose identity key matches `row({ astHash })` — the same codeunit, procedure
 *  and operator, so a `buildResumeIndex` built from rows can be asked about it. */
function manifestEntry(astHash: string): MutantManifestEntry {
  return {
    mutantId: `M-${astHash}`,
    file: "src/SandboxLogic.Codeunit.al",
    startIndex: 0,
    endIndex: 1,
    startLine: 1,
    operatorName: "lethal.negate-conditional",
    operatorVersion: "1.0.0",
    astHash,
    objectType: "codeunit",
    codeunitId: 79000,
    codeunitName: "Sandbox Logic",
    procedureName: "Post",
  } as MutantManifestEntry;
}

/**
 * R53. A `timeout-killed` exists only because a run was ALLOWED to end a hung BC session. Carrying
 * one into a session without that permission imports a verdict this run could not have produced
 * and could not reproduce if challenged — a kill claimed on the strength of a permission it does
 * not hold.
 *
 * Directional on purpose. The fingerprint deliberately excludes the flag, because turning it ON
 * and resuming is the natural recovery from a stranded run and must keep working; only the OFF
 * direction drops.
 */
describe("buildResumeIndex — timeout-killed across the stop flag (R53)", () => {
  const timeoutRow = row({ verdict: "timeout-killed", astHash: "hash-timeout" });

  test("carries a timeout-killed into a session that MAY stop sessions", () => {
    const index = buildResumeIndex([timeoutRow], true);
    expect(index.carryable.size).toBe(1);
    expect([...index.carryable.values()][0]?.verdict).toBe("timeout-killed");
    expect(index.nonCarryableRows).toBe(0);
  });

  test("REFUSES to carry it into a session that may not — and counts the drop", () => {
    const index = buildResumeIndex([timeoutRow], false);
    expect(index.carryable.size).toBe(0);
    // Counted, never silent: the same treatment every other drop in this function gets.
    expect(index.nonCarryableRows).toBe(1);
  });

  test("defaults to refusing — a caller that forgets the flag must not inherit the permission", () => {
    expect(buildResumeIndex([timeoutRow]).carryable.size).toBe(0);
  });

  // The control. Without this, "carryable.size === 0" above would also pass if the flag dropped
  // EVERYTHING, which would be a different and much worse bug.
  test("drops only timeout-killed — other carryable verdicts are unaffected", () => {
    const rows = [timeoutRow, row({ verdict: "killed", astHash: "hash-killed" })];
    const index = buildResumeIndex(rows, false);
    expect(index.carryable.size).toBe(1);
    expect([...index.carryable.values()][0]?.verdict).toBe("killed");
  });
});

describe("buildResumeIndex (R47)", () => {
  test("carries a scored verdict with its killing test and duration", () => {
    const index = buildResumeIndex([
      row({ verdict: "killed", killingTest: "OverBudgetDetected", durationMs: 91 }),
    ]);
    expect(index.carryable.size).toBe(1);
    const [carried] = [...index.carryable.values()];
    expect(carried?.verdict).toBe("killed");
    expect(carried?.killingTest).toBe("OverBudgetDetected");
    expect(carried?.durationMs).toBe(91);
  });

  test("refuses to carry an `error` verdict — it is a non-measurement, not a result", () => {
    // Freezing a transient transport failure into every future resume is strictly worse than
    // paying to re-run it: re-running either reproduces the error or scores the mutant.
    const index = buildResumeIndex([row({ verdict: "error", failureNote: "transport blew up" })]);
    expect(index.carryable.size).toBe(0);
    expect(index.nonCarryableRows).toBe(1);
  });

  test("carries `no-coverage` and `known-survivor`", () => {
    const index = buildResumeIndex([
      row({ astHash: "h1", verdict: "no-coverage" }),
      row({ astHash: "h2", verdict: "known-survivor" }),
    ]);
    expect(index.carryable.size).toBe(2);
  });

  test("R193: twins with ordinals are two keys, carried separately, and a strand excludes only its own", () => {
    // Before R193 these two rows were ONE colliding key: neither verdict carried, and a strand on
    // either excluded both. Measured on one real run: 15 colliding keys re-executed on every
    // resume, 12 mutants excluded from 3 strands.
    const index = buildResumeIndex([
      row({ verdict: "killed", killingTest: "T1", identityOrdinal: 0 }),
      row({
        verdict: "error",
        failureNote: `${STRANDED_NOTE_PREFIX} the second twin hung`,
        identityOrdinal: 1,
      }),
    ]);
    expect(index.ambiguousKeys).toBe(0);
    expect(index.carryable.size).toBe(1);
    const first = manifestEntry("hash-a");
    const second = { ...manifestEntry("hash-a"), mutantId: "M-second", identityOrdinal: 1 };
    expect(carriedVerdictFor(index, first)?.verdict).toBe("killed");
    expect(carriedVerdictFor(index, second)).toBeUndefined();
    expect(wasStranded(index, first)).toBe(false);
    expect(wasStranded(index, second)).toBe(true);
  });

  test("drops a colliding identity key rather than guessing which verdict was whose", () => {
    // Two textually identical statements in one codeunit, same operator, produce the same
    // (astHash, codeunitName, operatorName, operatorMajor) tuple — legal AL, e.g. `Rec.Modify(true)`
    // twice. Carrying either row onto both mutants would fabricate a measurement.
    const index = buildResumeIndex([
      row({ verdict: "killed", killingTest: "A" }),
      row({ verdict: "survived" }),
    ]);
    expect(index.carryable.size).toBe(0);
    expect(index.ambiguousKeys).toBe(1);
  });

  test("a collision is dropped even when both rows agree — count, not verdict, decides", () => {
    // The prior run may have scored only ONE of the two colliding mutants before aborting, so
    // "they agree" does not establish that both were measured.
    const index = buildResumeIndex([row({ verdict: "survived" }), row({ verdict: "survived" })]);
    expect(index.carryable.size).toBe(0);
    expect(index.ambiguousKeys).toBe(1);
  });

  test("a differing astHash does not match — an edited site never inherits a stale verdict", () => {
    const index = buildResumeIndex([row({ astHash: "before-the-edit", verdict: "survived" })]);
    expect(index.carryable.has("after-the-edit|Sandbox Logic|lethal.negate-conditional|1")).toBe(
      false,
    );
  });
});

describe("sessionFingerprint (R47)", () => {
  const base: SessionFingerprintInput = {
    projectDir: "/p",
    testDir: "/t",
    backend: "bcdev",
    skipKnownSurvivors: false,
    selectorIds: { selectorId: 1, controlId: 2, tableId: 3 },
  };

  test("glob ORDER does not change the fingerprint", () => {
    // Pattern order selects nothing different, so it must not defeat a resume.
    const a = sessionFingerprint({ ...base, only: ["b/**", "a/**"] });
    const b = sessionFingerprint({ ...base, only: ["a/**", "b/**"] });
    expect(a).toBe(b);
  });

  test("a different --only scope changes it", () => {
    expect(sessionFingerprint({ ...base, only: ["a/**"] })).not.toBe(
      sessionFingerprint({ ...base, only: ["b/**"] }),
    );
  });

  test("--tests-only changes it — that narrowing CAN change a verdict", () => {
    expect(sessionFingerprint({ ...base, testsOnly: ["x/**"] })).not.toBe(sessionFingerprint(base));
  });

  test("no narrowing is distinct from an empty-array narrowing's patterns", () => {
    expect(sessionFingerprint({ ...base, only: [] })).not.toBe(sessionFingerprint(base));
  });

  test("--skip-known-survivors changes it", () => {
    expect(sessionFingerprint({ ...base, skipKnownSurvivors: true })).not.toBe(
      sessionFingerprint(base),
    );
  });

  test("maxGuardsPerBatch is deliberately NOT part of it", () => {
    // Verdicts are carried by identity, not by mutant code, so re-batching is exactly what resume
    // is built to survive — and re-running with a smaller batch budget is a real recovery path
    // after a publish ceiling. There is no field for it on the input at all; this pins that.
    const keys = Object.keys(base);
    expect(keys).not.toContain("maxGuardsPerBatch");
  });
});

describe("ResultsStore resume queries (R47)", () => {
  const CARRY = [...CARRYABLE_VERDICTS];
  test("findResumableRun matches an unfinished run with the same fingerprint", () => {
    const store = new ResultsStore(":memory:");
    const id = store.createRun({
      projectPath: "/p",
      backend: "bcdev",
      appVersion: "1.0.0.0",
      configFingerprint: "fp",
    });
    // R52: a run must also HAVE something to carry, so this fixture records a verdict — otherwise
    // it would be refused for emptiness and stop testing fingerprint matching at all.
    store.recordMutant(id, {
      mutantCode: "M0001",
      astHash: "h",
      codeunitName: "C",
      procedureName: "Post",
      operatorName: "op",
      operatorMajor: 1,
      file: "f.al",
      line: 1,
      verdict: "survived",
      durationMs: 1,
      batchIndex: 0,
    });
    expect(
      store.findResumableRun({
        projectPath: "/p",
        backend: "bcdev",
        configFingerprint: "fp",
        carryableVerdicts: CARRY,
      }),
    ).toBe(id);
  });

  test("a FINISHED run is not resumable — there is nothing left to score", () => {
    const store = new ResultsStore(":memory:");
    const id = store.createRun({
      projectPath: "/p",
      backend: "bcdev",
      appVersion: "1.0.0.0",
      configFingerprint: "fp",
    });
    store.finishRun(id, { batchCount: 1, baselineGreen: true });
    expect(
      store.findResumableRun({
        projectPath: "/p",
        backend: "bcdev",
        configFingerprint: "fp",
        carryableVerdicts: CARRY,
      }),
    ).toBeNull();
  });

  test("a different fingerprint does not match — scopes are not interchangeable", () => {
    const store = new ResultsStore(":memory:");
    store.createRun({
      projectPath: "/p",
      backend: "bcdev",
      appVersion: "1.0.0.0",
      configFingerprint: "scope-a",
    });
    expect(
      store.findResumableRun({
        projectPath: "/p",
        backend: "bcdev",
        configFingerprint: "scope-b",
        carryableVerdicts: CARRY,
      }),
    ).toBeNull();
  });

  test("a run recorded with NO fingerprint never matches", () => {
    // A pre-R47 lethal.sqlite row cannot prove how it was scoped, so it must not be resumable.
    const store = new ResultsStore(":memory:");
    store.createRun({ projectPath: "/p", backend: "bcdev", appVersion: "1.0.0.0" });
    expect(
      store.findResumableRun({
        projectPath: "/p",
        backend: "bcdev",
        configFingerprint: "fp",
        carryableVerdicts: CARRY,
      }),
    ).toBeNull();
  });

  test("an unfinished run that recorded NOTHING never shadows an older one that did (R52)", () => {
    // Measured live: an attempted resume aborted at lease acquisition before scoring a single
    // mutant, and the next --resume dutifully selected that empty run over the one holding 12 real
    // verdicts, reporting "0 verdict(s) carried". Recovery is exactly when a run is most likely to
    // have recorded nothing, so "most recent unfinished" alone is the wrong rule.
    const store = new ResultsStore(":memory:");
    const withVerdicts = store.createRun({
      projectPath: "/p",
      backend: "bcdev",
      appVersion: "1",
      configFingerprint: "fp",
    });
    store.recordMutant(withVerdicts, {
      mutantCode: "M0001",
      astHash: "h",
      codeunitName: "C",
      procedureName: "Post",
      operatorName: "op",
      operatorMajor: 1,
      file: "f.al",
      line: 1,
      verdict: "survived",
      durationMs: 1,
      batchIndex: 0,
    });
    // Newer, but died before recording anything.
    store.createRun({
      projectPath: "/p",
      backend: "bcdev",
      appVersion: "1",
      configFingerprint: "fp",
    });
    expect(
      store.findResumableRun({
        projectPath: "/p",
        backend: "bcdev",
        configFingerprint: "fp",
        carryableVerdicts: CARRY,
      }),
    ).toBe(withVerdicts);
  });

  test("a run holding only NON-carryable verdicts is skipped too (R52)", () => {
    // An all-error run carries nothing, so selecting it is the same dead end as selecting an empty
    // one — the SQL filter and CARRYABLE_VERDICTS must agree on that.
    const store = new ResultsStore(":memory:");
    const good = store.createRun({
      projectPath: "/p",
      backend: "bcdev",
      appVersion: "1",
      configFingerprint: "fp",
    });
    store.recordMutant(good, {
      mutantCode: "M0001",
      astHash: "h",
      codeunitName: "C",
      procedureName: "Post",
      operatorName: "op",
      operatorMajor: 1,
      file: "f.al",
      line: 1,
      verdict: "killed",
      durationMs: 1,
      batchIndex: 0,
    });
    const allErrors = store.createRun({
      projectPath: "/p",
      backend: "bcdev",
      appVersion: "1",
      configFingerprint: "fp",
    });
    store.recordMutant(allErrors, {
      mutantCode: "M0001",
      astHash: "h2",
      codeunitName: "C",
      procedureName: "Post",
      operatorName: "op",
      operatorMajor: 1,
      file: "f.al",
      line: 2,
      verdict: "error",
      durationMs: 1,
      batchIndex: 0,
    });
    expect(
      store.findResumableRun({
        projectPath: "/p",
        backend: "bcdev",
        configFingerprint: "fp",
        carryableVerdicts: CARRY,
      }),
    ).toBe(good);
  });

  test("mutantVerdicts reads back identity, verdict, killing test and duration", () => {
    const store = new ResultsStore(":memory:");
    const id = store.createRun({
      projectPath: "/p",
      backend: "bcdev",
      appVersion: "1.0.0.0",
      configFingerprint: "fp",
    });
    store.recordMutant(id, {
      mutantCode: "M0001",
      astHash: "h",
      codeunitName: "C",
      procedureName: "Post",
      operatorName: "op",
      operatorMajor: 2,
      file: "f.al",
      line: 3,
      verdict: "killed",
      killingTest: "T",
      durationMs: 77,
      batchIndex: 0,
    });
    expect(store.mutantVerdicts(id)).toEqual([
      {
        astHash: "h",
        codeunitName: "C",
        procedureName: "Post",
        operatorName: "op",
        operatorMajor: 2,
        identityOrdinal: 0,
        verdict: "killed",
        killingTest: "T",
        durationMs: 77,
      },
    ]);
  });

  test("R192: mutantVerdicts reads back the coverage facts, and their absence stays an absence", () => {
    const store = new ResultsStore(":memory:");
    const id = store.createRun({ projectPath: "/p", backend: "bcdev", appVersion: "1.0.0.0" });
    const base = {
      codeunitName: "C",
      procedureName: "Post",
      operatorName: "op",
      operatorMajor: 1,
      file: "f.al",
      line: 3,
      durationMs: 1,
      batchIndex: 0,
    } as const;
    store.recordMutant(id, {
      ...base,
      mutantCode: "M0001",
      astHash: "with",
      verdict: "survived",
      coveringTests: ["Tests.A", "Tests.B"],
      coverageAttribution: "exact",
    });
    store.recordMutant(id, {
      ...base,
      mutantCode: "M0002",
      astHash: "unplaceable",
      verdict: "no-coverage",
      coveringTests: [],
      unplaceable: true,
    });
    // A row written by a pre-R192 caller: nothing about coverage, and it must read back as
    // nothing — not as an empty list, which would let `--resume` skip a batch on invented facts.
    store.recordMutant(id, { ...base, mutantCode: "M0003", astHash: "without", verdict: "killed" });
    const rows = new Map(store.mutantVerdicts(id).map((r) => [r.astHash, r]));
    expect(rows.get("with")?.coveringTests).toEqual(["Tests.A", "Tests.B"]);
    expect(rows.get("with")?.coverageAttribution).toBe("exact");
    expect(rows.get("with")?.unplaceable).toBeUndefined();
    expect(rows.get("unplaceable")?.coveringTests).toEqual([]);
    expect(rows.get("unplaceable")?.unplaceable).toBe(true);
    expect(rows.get("without")?.coveringTests).toBeUndefined();
    expect(rows.get("without")?.coverageAttribution).toBeUndefined();
    expect(rows.get("without")?.unplaceable).toBeUndefined();
  });

  test("R192: a database created before the coverage columns is migrated, and its rows read back without them", () => {
    // The pre-R192 table, verbatim minus the three columns; `migrate()` must widen it.
    const raw = new Database(":memory:");
    raw.exec(`CREATE TABLE runs (id INTEGER PRIMARY KEY AUTOINCREMENT, started_at TEXT NOT NULL,
      finished_at TEXT, project_path TEXT NOT NULL, backend TEXT NOT NULL, app_version TEXT NOT NULL,
      batch_count INTEGER, baseline_green INTEGER, app_id TEXT, artifact_id TEXT, artifact_sha256 TEXT,
      config_fingerprint TEXT)`);
    raw.exec(`CREATE TABLE mutants (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER NOT NULL,
      mutant_code TEXT NOT NULL, ast_hash TEXT NOT NULL, codeunit_name TEXT NOT NULL,
      procedure_name TEXT, operator_name TEXT NOT NULL, operator_major INTEGER NOT NULL,
      file TEXT NOT NULL, line INTEGER NOT NULL, verdict TEXT NOT NULL, killing_test TEXT,
      failure_note TEXT, killing_test_failure TEXT, duration_ms INTEGER NOT NULL, batch_index INTEGER,
      runner TEXT)`);
    raw.exec(
      `INSERT INTO runs (started_at, project_path, backend, app_version) VALUES ('t', '/p', 'bcdev', '1')`,
    );
    raw.exec(`INSERT INTO mutants (run_id, mutant_code, ast_hash, codeunit_name, procedure_name, operator_name,
      operator_major, file, line, verdict, duration_ms, batch_index)
      VALUES (1, 'M0001', 'old', 'C', 'Post', 'op', 1, 'f.al', 1, 'survived', 5, 0)`);
    const path = join(tmpdirSync(), "pre-r192.sqlite");
    raw.exec(`VACUUM INTO '${path.replaceAll("\\", "/")}'`);
    raw.close();
    const store = new ResultsStore(path);
    const [row] = store.mutantVerdicts(1);
    expect(row?.verdict).toBe("survived");
    expect(row?.coveringTests).toBeUndefined();
    expect(row?.coverageAttribution).toBeUndefined();
    // And the widened table accepts a new row WITH the facts.
    store.recordMutant(1, {
      mutantCode: "M0002",
      astHash: "new",
      codeunitName: "C",
      procedureName: "Post",
      operatorName: "op",
      operatorMajor: 1,
      file: "f.al",
      line: 2,
      verdict: "killed",
      durationMs: 1,
      batchIndex: 0,
      coveringTests: ["Tests.A"],
      coverageAttribution: "object",
    });
    expect(store.mutantVerdicts(1).find((r) => r.astHash === "new")?.coveringTests).toEqual([
      "Tests.A",
    ]);
    store.close();
  });

  /**
   * R86. `--resume` re-records a carried verdict rather than re-executing it, so anything the store
   * does not read back is silently dropped on the second run: the resumed report would say "killed"
   * with no account of why, which is exactly the state R86 exists to end. The drift this models is
   * a `SELECT` that never learns the new column — the same hole `carried.runner` (R69 Phase 2 Task
   * 5) was added to close for the runner tag.
   */
  test("R86: mutantVerdicts reads back the killing run's failure text, so --resume can carry it", () => {
    const store = new ResultsStore(":memory:");
    const id = store.createRun({
      projectPath: "/p",
      backend: "bcdev",
      appVersion: "1.0.0.0",
      configFingerprint: "fp",
    });
    store.recordMutant(id, {
      mutantCode: "M0001",
      astHash: "h",
      codeunitName: "C",
      procedureName: "Post",
      operatorName: "op",
      operatorMajor: 2,
      file: "f.al",
      line: 3,
      verdict: "killed",
      killingTest: "T",
      killingTestFailure:
        "The length of the string is 18, but it must be less than or equal to 10 characters",
      durationMs: 77,
      batchIndex: 0,
    });
    const [row] = store.mutantVerdicts(id);
    expect(row?.killingTestFailure).toBe(
      "The length of the string is 18, but it must be less than or equal to 10 characters",
    );
  });
});

describe("ResultsStore.invalidateBatch (R47)", () => {
  function seed(
    store: ResultsStore,
    runId: number,
    batchIndex: number,
    over: Partial<Parameters<ResultsStore["recordMutant"]>[1]>,
  ) {
    store.recordMutant(runId, {
      mutantCode: "M0001",
      astHash: "h",
      codeunitName: "C",
      procedureName: "Post",
      operatorName: "op",
      operatorMajor: 1,
      file: "f.al",
      line: 1,
      verdict: "survived",
      durationMs: 1,
      batchIndex,
      ...over,
    });
  }

  test("rewrites the named batch's verdicts to error and drops the killing test", () => {
    const store = new ResultsStore(":memory:");
    const id = store.createRun({ projectPath: "/p", backend: "bcdev", appVersion: "1.0.0.0" });
    seed(store, id, 0, { astHash: "a", verdict: "survived" });
    seed(store, id, 0, { astHash: "b", verdict: "killed", killingTest: "T" });
    expect(store.invalidateBatch(id, 0, "unattested")).toBe(2);
    const rows = store.mutantVerdicts(id);
    expect(rows.every((r) => r.verdict === "error")).toBe(true);
    expect(rows.every((r) => r.killingTest === undefined)).toBe(true);
    expect(rows.every((r) => r.failureNote === "unattested")).toBe(true);
  });

  /**
   * R86: the killing run's failure text goes with the killing test. An invalidated row is no longer
   * a kill, so a surviving "why the test went red" would describe a verdict that has just been
   * withdrawn — and it would sit beside `failureNote: "unattested"`, giving the reader two accounts
   * of the same row that disagree about whether anything was measured.
   */
  test("R86: invalidateBatch drops the killing run's failure text along with the killing test", () => {
    const store = new ResultsStore(":memory:");
    const id = store.createRun({ projectPath: "/p", backend: "bcdev", appVersion: "1.0.0.0" });
    seed(store, id, 0, {
      astHash: "b",
      verdict: "killed",
      killingTest: "T",
      killingTestFailure: "Category must have a value in Data Main",
    });
    expect(store.invalidateBatch(id, 0, "unattested")).toBe(1);
    const rows = store.mutantVerdicts(id);
    expect(rows.every((r) => r.killingTestFailure === undefined)).toBe(true);
  });

  test("leaves ANOTHER batch alone", () => {
    // One artifact's attestation says nothing about a different artifact's verdicts.
    const store = new ResultsStore(":memory:");
    const id = store.createRun({ projectPath: "/p", backend: "bcdev", appVersion: "1.0.0.0" });
    seed(store, id, 0, { astHash: "a" });
    seed(store, id, 1, { astHash: "b" });
    expect(store.invalidateBatch(id, 0, "unattested")).toBe(1);
    expect(store.mutantVerdicts(id).filter((r) => r.verdict === "survived")).toHaveLength(1);
  });

  test("preserves a known-survivor and an already-classified error", () => {
    // Mirrors the in-memory rule (the fold's own `batch-invalidated` handling, report-fold.ts): a
    // known survivor was never run against this binary, and an existing error carries a more
    // specific diagnosis than this generic note.
    const store = new ResultsStore(":memory:");
    const id = store.createRun({ projectPath: "/p", backend: "bcdev", appVersion: "1.0.0.0" });
    seed(store, id, 0, { astHash: "a", verdict: "known-survivor" });
    seed(store, id, 0, { astHash: "b", verdict: "error", failureNote: "deadline exceeded" });
    expect(store.invalidateBatch(id, 0, "unattested")).toBe(0);
    const notes = store.mutantVerdicts(id).map((r) => r.failureNote);
    expect(notes).toContain("deadline exceeded");
    expect(notes).not.toContain("unattested");
  });
});

describe("runSession --resume (R47)", () => {
  test("recovers the verdicts an aborted run had already scored, and re-runs only the rest", async () => {
    // The R47 scenario end to end: a run quarantines partway, and the mutants it had already
    // scored are recovered instead of discarded.
    const dirs = await makeProject();
    const store = new ResultsStore(":memory:");

    const first = new CountingBackend("pass", 1); // scores one mutant, then goes in-flight-unknown
    const firstReport = await runSession({ backend: first, store, ...dirs, selectorIds });
    expect(firstReport.quarantined).toBeDefined();
    const firstScored = firstReport.counts.survived + firstReport.counts.killed;
    expect(firstScored).toBe(1);

    const second = new CountingBackend("pass");
    const secondReport = await runSession({
      backend: second,
      store,
      ...dirs,
      selectorIds,
      resume: "last",
    });

    expect(secondReport.resumedFrom?.runId).toBeGreaterThan(0);
    expect(secondReport.resumedFrom?.carriedMutants).toBe(1);
    expect(secondReport.validity.caveats).toContain("resumed");

    // The saving is real, and measured against a full run of the same project rather than against
    // arithmetic on mutant counts (one mutant can cost several runs — one per covering test, plus
    // a baseline re-confirmation on a kill).
    const control = new CountingBackend("pass");
    await runSession({
      backend: control,
      store: new ResultsStore(":memory:"),
      ...dirs,
      selectorIds,
    });
    expect(second.mutantRuns).toBeLessThan(control.mutantRuns);
  });

  test("R192: a batch where EVERY mutant carries is neither deployed nor baselined, and keeps its coverage facts", async () => {
    // Measured on a hosted sandbox: twelve resumes each republished a fully-scored batch (40 s)
    // and re-ran its 407-test baseline (215 s) to carry verdicts that could not change. The
    // carried verdicts now keep the covering tests and attribution they were measured under, so
    // the batch is recorded from the store and the deploy never happens.
    const dirs = await makeProject({ secondFile: true });
    const store = new ResultsStore(":memory:");
    const first = new CountingBackend("pass", undefined, 2); // batch 0 fully scored, batch 1 aborts
    const firstReport = await runSession({
      backend: first,
      store,
      ...dirs,
      selectorIds,
      maxGuardsPerBatch: 1,
    });
    expect(firstReport.batches).toBe(2);
    expect(first.deploys).toBe(2);
    const batch0Before = firstReport.mutants.filter((m) => m.batchIndex === 0);
    expect(batch0Before.length).toBeGreaterThan(0);
    // Every batch-0 verdict was measured with a non-empty covering list, which is what makes
    // the assertion below on the carried list a real one rather than [] equalling [].
    expect(batch0Before.every((m) => (m.coveringTests?.length ?? 0) > 0)).toBe(true);

    const second = new CountingBackend("pass");
    const events: RunEvent[] = [];
    const report = await runSession({
      backend: second,
      store,
      ...dirs,
      selectorIds,
      maxGuardsPerBatch: 1,
      resume: "last",
      emit: [(e) => events.push(e)],
    });
    // ONE deploy: batch 1's. Batch 0 was recorded from the prior run without a publish.
    expect(second.deploys).toBe(1);
    const skipped = events.filter((e) => e.type === "warning" && e.code === "resume-batch-carried");
    expect(skipped).toHaveLength(1);
    expect(events.some((e) => e.type === "batch-published" && e.batchIndex === 0)).toBe(false);
    expect(events.some((e) => e.type === "batch-published" && e.batchIndex === 1)).toBe(true);
    // The carried rows keep what they were measured under, verdict for verdict.
    const batch0After = report.mutants.filter((m) => m.batchIndex === 0);
    expect(batch0After.map((m) => m.mutantCode).sort()).toEqual(
      batch0Before.map((m) => m.mutantCode).sort(),
    );
    for (const after of batch0After) {
      const before = batch0Before.find((m) => m.mutantCode === after.mutantCode);
      if (before === undefined) throw new Error(`no prior verdict for ${after.mutantCode}`);
      expect(after.verdict).toBe(before.verdict);
      expect(after.coveringTests).toEqual(before.coveringTests);
      expect(after.coverageAttribution).toBe(before.coverageAttribution);
    }
    expect(report.resumedFrom?.carriedMutants).toBe(batch0Before.length);
    expect(report.quarantined).toBeUndefined();
    // And the batch that DID have work still ran its baseline and mutants normally.
    expect(report.counts.survived + report.counts.killed).toBeGreaterThan(batch0Before.length);
  });

  test("R192 (second half): a batch with work left is deployed but its baseline is NOT re-run when nothing it measured changed", async () => {
    // The other half of the measured cost: batch 1 still had mutants to run, so the first half
    // could not skip it, and every resume re-ran its 407-test baseline (215 s). Its instrumented
    // source and the test app are byte-identical to the prior run's, so the prior baseline stands.
    const dirs = await makeProject({ secondFile: true });
    const store = new ResultsStore(":memory:");
    const first = new CountingBackend("pass", undefined, 2); // batch 1 aborts on its first mutant
    const firstReport = await runSession({
      backend: first,
      store,
      ...dirs,
      selectorIds,
      maxGuardsPerBatch: 1,
    });
    expect(firstReport.quarantined).toBeDefined();
    expect(first.baselineRuns).toBeGreaterThan(0);

    const second = new CountingBackend("pass");
    const events: RunEvent[] = [];
    const report = await runSession({
      backend: second,
      store,
      ...dirs,
      selectorIds,
      maxGuardsPerBatch: 1,
      resume: "last",
      emit: [(e) => events.push(e)],
    });
    // Batch 0 was recorded from the store (first half); batch 1 was deployed for its mutants...
    expect(second.deploys).toBe(1);
    // ...and its baseline came from the snapshot: NOT ONE baseline test ran in this session.
    expect(second.baselineRuns).toBe(0);
    expect(second.mutantRuns).toBeGreaterThan(0);
    const reused = events.filter(
      (e) => e.type === "warning" && e.code === "resume-baseline-reused",
    );
    expect(reused).toHaveLength(1);
    expect(reused[0]?.type === "warning" ? reused[0].message : "").toContain(
      `run ${firstReport.resumedFrom?.runId ?? 1}`,
    );
    // The reused baseline still produced a coverage split and the same verdicts a fresh run gives.
    expect(events.some((e) => e.type === "coverage-split" && e.batchIndex === 1)).toBe(true);
    const control = await runSession({
      backend: new CountingBackend("pass"),
      store: new ResultsStore(":memory:"),
      ...dirs,
      selectorIds,
      maxGuardsPerBatch: 1,
    });
    // The one mutant the first run stranded on is skipped as `error` on resume (R53), which is a
    // resume property, not a baseline one; every other verdict must match the fresh run's.
    const strandedSkips = report.mutants.filter(
      (m) => m.failureNote?.includes("not re-run on resume") === true,
    );
    expect(strandedSkips).toHaveLength(1);
    const key = (m: (typeof report.mutants)[number]) => `${m.file}|${m.line}|${m.operatorName}`;
    const skipped = new Set(strandedSkips.map(key));
    const verdictsOf = (r: typeof report) =>
      r.mutants
        .filter((m) => !skipped.has(key(m)))
        .map((m) => `${key(m)}|${m.verdict}`)
        .sort();
    expect(verdictsOf(report)).toEqual(verdictsOf(control));
    expect(report.validity.baselineTests).toEqual(control.validity.baselineTests);
  });

  test("R192 (second half): a changed test app means the baseline IS re-run", async () => {
    const dirs = await makeProject({ secondFile: true });
    const store = new ResultsStore(":memory:");
    await runSession({
      backend: new CountingBackend("pass", undefined, 2),
      store,
      ...dirs,
      selectorIds,
      maxGuardsPerBatch: 1,
    });
    // Edit the test project: the source-tree hash (no package concept on this backend) moves.
    const { writeFile: write } = await import("node:fs/promises");
    await write(join(dirs.testDir, "Extra.Codeunit.al"), 'codeunit 79999 "Extra" { }', "utf8");
    const second = new CountingBackend("pass");
    const events: RunEvent[] = [];
    await runSession({
      backend: second,
      store,
      ...dirs,
      selectorIds,
      maxGuardsPerBatch: 1,
      resume: "last",
      emit: [(e) => events.push(e)],
    });
    expect(second.baselineRuns).toBeGreaterThan(0);
    expect(events.some((e) => e.type === "warning" && e.code === "resume-baseline-reused")).toBe(
      false,
    );
  });

  test("R192: a batch whose carried rows predate the coverage columns is deployed as before", () => {
    // A pre-R192 database holds verdicts without covering tests. Skipping on those would record
    // a carried survivor with an invented empty list, so the batch takes the ordinary path.
    const withFacts = buildResumeIndex(
      [row({ astHash: "a", coveringTests: ["T.one"], coverageAttribution: "exact" })],
      false,
    );
    const withoutFacts = buildResumeIndex([row({ astHash: "a" })], false);
    const mutant = manifestEntry("a");
    expect(batchCarriesEntirely(withFacts, [mutant], false)).toBe(true);
    expect(batchCarriesEntirely(withoutFacts, [mutant], false)).toBe(false);
    // An empty batch carries nothing and is never "entirely carried".
    expect(batchCarriesEntirely(withFacts, [], false)).toBe(false);
    // One mutant that must execute is enough to take the ordinary path.
    expect(batchCarriesEntirely(withFacts, [mutant, manifestEntry("b")], false)).toBe(false);
  });

  test("a batch where EVERY mutant carries does not trip the attestation gate", async () => {
    // The dangerous interaction. The fail-closed gate quarantines a batch that "contributed
    // verdicts" but never earned a clean attestation. A fully-carried batch schedules no run at
    // all, so it CANNOT attest — gating it on the pre-resume mutant set would quarantine the
    // container for the crime of having nothing left to do, and discard the carried verdicts with
    // it. Two artifacts, the first fully scored before the second aborts, is exactly that shape.
    const dirs = await makeProject({ secondFile: true });
    const store = new ResultsStore(":memory:");

    // Batch 0 scores completely; batch 1 aborts on its first mutant.
    const first = new CountingBackend("pass", undefined, 2);
    const firstReport = await runSession({
      backend: first,
      store,
      ...dirs,
      selectorIds,
      maxGuardsPerBatch: 1, // one file per artifact
    });
    expect(firstReport.batches).toBe(2);
    expect(firstReport.quarantined).toBeDefined();
    const batch0Scored = firstReport.mutants.filter(
      (m) => m.batchIndex === 0 && (m.verdict === "survived" || m.verdict === "killed"),
    ).length;
    expect(batch0Scored).toBeGreaterThan(0);

    const second = new CountingBackend("pass");
    const report = await runSession({
      backend: second,
      store,
      ...dirs,
      selectorIds,
      maxGuardsPerBatch: 1,
      resume: "last",
    });
    // Batch 0 now schedules NOTHING — every one of its mutants carried.
    expect(report.resumedFrom?.carriedMutants).toBe(batch0Scored);
    expect(report.quarantined).toBeUndefined();
    expect(report.mutants.some((m) => m.failureNote?.includes("unattested") === true)).toBe(false);
    expect(report.counts.survived).toBeGreaterThanOrEqual(batch0Scored);
  });

  test("a carried verdict is NOT re-measured — the value comes from the database", async () => {
    const dirs = await makeProject();
    const store = new ResultsStore(":memory:");
    const first = new CountingBackend("pass", 1);
    await runSession({ backend: first, store, ...dirs, selectorIds });

    // Scripted to KILL everything. Any mutant whose verdict is `survived` in the resumed report
    // therefore cannot have been executed here — it can only have come from the prior run.
    const second = new CountingBackend("fail");
    const report = await runSession({
      backend: second,
      store,
      ...dirs,
      selectorIds,
      resume: "last",
    });
    expect(report.counts.survived).toBe(1);
    // R53: the mutant the prior run stranded on is skipped rather than retried, so it is an error
    // here rather than a kill — everything else this "fail" backend touched is killed.
    expect(report.resumedFrom?.skippedStranded).toBe(1);
    expect(report.counts.killed).toBe(report.mutants.length - 2);
    expect(report.counts.errors).toBe(1);
  });

  test("a mutant that STRANDED the tier is not retried, and does not block the rest (R53)", async () => {
    // Measured on Document Output: M0013 negates `until DOCustSetup.Next() = 0;` into `<> 0`, which
    // never terminates. Retrying it re-hangs and re-quarantines, so the 125 mutants queued behind
    // it can never run — no --mutant-timeout-ms value helps, because the mutant has no runtime.
    const dirs = await makeProject();
    const store = new ResultsStore(":memory:");
    const first = new CountingBackend("pass", 1);
    const firstReport = await runSession({ backend: first, store, ...dirs, selectorIds });
    expect(firstReport.quarantined).toBeDefined();

    const second = new CountingBackend("pass");
    const report = await runSession({
      backend: second,
      store,
      ...dirs,
      selectorIds,
      resume: "last",
    });
    // The run COMPLETES rather than quarantining again — that is the whole point.
    expect(report.quarantined).toBeUndefined();
    expect(report.resumedFrom?.skippedStranded).toBe(1);
    // Skipped means NOT MEASURED: recorded as an error and excluded from the score, never counted
    // as a survivor, which would claim the suite failed to catch something it was never shown.
    const skipped = report.mutants.filter(
      (m) => m.failureNote?.includes("not re-run on resume") === true,
    );
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.verdict).toBe("error");
  });

  test("--retry-stranded attempts it anyway", async () => {
    const dirs = await makeProject();
    const store = new ResultsStore(":memory:");
    await runSession({ backend: new CountingBackend("pass", 1), store, ...dirs, selectorIds });
    const second = new CountingBackend("pass");
    const report = await runSession({
      backend: second,
      store,
      ...dirs,
      selectorIds,
      resume: "last",
      retryStranded: true,
    });
    expect(report.resumedFrom?.skippedStranded).toBe(0);
    expect(
      report.mutants.some((m) => m.failureNote?.includes("not re-run on resume") === true),
    ).toBe(false);
  });

  test("a carried verdict's duration is excluded from this run's cost (R54)", async () => {
    // Measured on a resumed Document Output sweep: timings reported 2200.4 s of "mutants" inside a
    // 2109.7 s run, with `overhead` clamped to 0 hiding the contradiction — because a carried
    // mutant's duration was spent in a DIFFERENT run. These numbers exist to extrapolate what a
    // bigger run will COST, so time this run never spent must not be in them.
    const dirs = await makeProject();
    const store = new ResultsStore(":memory:");
    await runSession({ backend: new CountingBackend("pass", 1), store, ...dirs, selectorIds });
    const report = await runSession({
      backend: new CountingBackend("pass"),
      store,
      ...dirs,
      selectorIds,
      resume: "last",
    });
    expect(report.resumedFrom?.carriedMutants).toBeGreaterThan(0);
    const carried = report.mutants.filter((m) => m.carried === true);
    expect(carried.length).toBe(report.resumedFrom?.carriedMutants ?? -1);
    // NOTE: the wall-clock invariant is NOT asserted here. This fixture's carried durations are
    // ~5 ms, far too small to breach it, so the assertion passed with the fix reverted — a test
    // that could not fail. The discriminating version lives in timings.test.ts (R54), where
    // `buildReport` is driven directly with a carried duration that dwarfs the run.
    expect(carried.every((m) => m.carried === true)).toBe(true);
  });

  // R69 Phase 2 Task 5 — THE RESUME HOLE, end to end through `runSession` rather than just the
  // isolated `buildResumeIndex`/`buildReport` units. Task 6 (not this one) wires the router that
  // would produce a client-services verdict live; this test stands in for that by tagging run 1's
  // verdict directly in the store — proving the RESUME/RECORD plumbing itself carries the tag,
  // independent of how it got there. Without this fix, `record()`'s carried-verdict call site
  // dropped the tag on the floor and the resumed report's `executionContexts` would report
  // fenced-only, silently misdescribing an interactive kill as fenced.
  test("a verdict tagged client-services keeps that tag through --resume, all the way into the report (R69 Phase 2)", async () => {
    const dirs = await makeProject();
    const store = new ResultsStore(":memory:");
    await runSession({ backend: new CountingBackend("pass", 1), store, ...dirs, selectorIds });
    // Stands in for Task 6's live router: tag run 1's recorded verdict(s) as having come from the
    // client-services path, directly against the store `record()` already wrote to.
    store.db.exec(
      "UPDATE mutants SET runner = 'client-services' WHERE run_id = (SELECT MAX(id) FROM runs) AND verdict != 'error'",
    );

    const report = await runSession({
      backend: new CountingBackend("pass"),
      store,
      ...dirs,
      selectorIds,
      resume: "last",
    });

    const carriedMutant = report.mutants.find((m) => m.carried === true);
    expect(carriedMutant).toBeDefined();
    expect(carriedMutant?.runner).toBe("client-services");

    const carriedCtx = report.validity.executionContexts.find(
      (c) => c.runner === "client-services",
    );
    expect(carriedCtx).toBeDefined();
    expect(carriedCtx?.basis).toContain("carried");
    // The stranded row was deliberately excluded from the UPDATE (still `error`, never carryable),
    // so it must NOT show up tagged client-services anywhere in this report.
    expect(
      report.mutants.some((m) => m.verdict === "error" && m.runner === "client-services"),
    ).toBe(false);
  });

  test("a resumed survivor keeps THIS run's covering tests, not an empty list", async () => {
    // Carried verdicts are recorded after coverage attribution precisely so a resumed survivor
    // stays actionable — an agent reading the report needs to know which tests ran it.
    const dirs = await makeProject();
    const store = new ResultsStore(":memory:");
    await runSession({ backend: new CountingBackend("pass", 1), store, ...dirs, selectorIds });
    const report = await runSession({
      backend: new CountingBackend("pass"),
      store,
      ...dirs,
      selectorIds,
      resume: "last",
    });
    const survivor = report.mutants.find((m) => m.verdict === "survived");
    expect(survivor).toBeDefined();
    expect(survivor?.coveringTests.length).toBeGreaterThan(0);
  });

  test("without --resume, the same aborted run is ignored and everything re-executes", async () => {
    const dirs = await makeProject();
    const store = new ResultsStore(":memory:");
    const first = new CountingBackend("pass", 1);
    await runSession({ backend: first, store, ...dirs, selectorIds });
    const second = new CountingBackend("pass");
    const report = await runSession({ backend: second, store, ...dirs, selectorIds });
    expect(report.resumedFrom).toBeUndefined();
    expect(report.validity.caveats).not.toContain("resumed");

    // Every mutant re-executed: identical to a run against a database that never saw the first.
    const control = new CountingBackend("pass");
    await runSession({
      backend: control,
      store: new ResultsStore(":memory:"),
      ...dirs,
      selectorIds,
    });
    expect(second.mutantRuns).toBe(control.mutantRuns);
  });

  test("a COMPLETED run is not resumable — nothing is left to score", async () => {
    const dirs = await makeProject();
    const store = new ResultsStore(":memory:");
    await runSession({ backend: new CountingBackend("pass"), store, ...dirs, selectorIds });
    await expect(
      runSession({ backend: new CountingBackend(), store, ...dirs, selectorIds, resume: "last" }),
    ).rejects.toThrow(/found no unfinished run to resume/);
  });

  test("--resume with no matching prior run refuses, naming what it looked for", async () => {
    const dirs = await makeProject();
    const store = new ResultsStore(":memory:");
    await expect(
      runSession({ backend: new CountingBackend(), store, ...dirs, selectorIds, resume: "last" }),
    ).rejects.toThrow(/found no unfinished run to resume/);
  });

  test("--resume refuses to reuse a run scoped by different --only patterns", async () => {
    const dirs = await makeProject();
    const store = new ResultsStore(":memory:");
    // ABORTED (so `finished_at IS NULL` matches) but narrowed — the only thing that must stop this
    // resume is the scope. A completed run would be refused for the wrong reason and the test
    // would pass whether or not the fingerprint check exists.
    const first = await runSession({
      backend: new CountingBackend("pass", 1),
      store,
      ...dirs,
      selectorIds,
      only: ["SandboxLogic.Codeunit.al"],
    });
    expect(first.quarantined).toBeDefined();
    // Same project, same backend, unnarrowed — carrying the narrowed run's verdicts would report
    // one slice's measurements as the whole project's.
    await expect(
      runSession({ backend: new CountingBackend(), store, ...dirs, selectorIds, resume: "last" }),
    ).rejects.toThrow(/found no unfinished run to resume/);
    // ...and the same narrowing resumes it fine, proving the refusal was about scope.
    const resumed = await runSession({
      backend: new CountingBackend("pass"),
      store,
      ...dirs,
      selectorIds,
      only: ["SandboxLogic.Codeunit.al"],
      resume: "last",
    });
    expect(resumed.resumedFrom?.carriedMutants).toBe(1);
  });

  test("verdicts an UNATTESTED artifact produced are never carried", async () => {
    // The dangerous case. A batch whose binary was never proven live has its verdicts invalidated
    // by the attestation gate — but that correction used to be in-memory only, protected by a
    // quarantined run never being marked finished. `--resume` selects on exactly that condition,
    // so without the durable half it would preferentially read the false survivors the gate exists
    // to destroy (the R29 failure, resurrected).
    const dirs = await makeProject();
    const store = new ResultsStore(":memory:");
    const first = await runSession({
      backend: new NeverAttestingBackend(),
      store,
      ...dirs,
      selectorIds,
    });
    expect(first.quarantined?.reason).toMatch(/unattested artifact/);
    expect(first.counts.survived).toBe(0); // invalidated in memory

    // Two independent guarantees, in order of strength.
    //
    // R52 made this REFUSE rather than carry nothing: `invalidateBatch` rewrote every row of the
    // unattested batch to `error`, so the run holds no carryable verdict and can no longer be
    // selected at all. Stronger than the old behaviour (resume, carry 0) because the false
    // survivors cannot even be reached.
    await expect(
      runSession({
        backend: new CountingBackend("pass"),
        store,
        ...dirs,
        selectorIds,
        resume: "last",
      }),
    ).rejects.toThrow(/found no unfinished run to resume/);

    // And without --resume, everything is re-measured — identical to a run whose database never
    // saw the unattested one.
    const second = new CountingBackend("pass");
    await runSession({ backend: second, store, ...dirs, selectorIds });
    const control = new CountingBackend("pass");
    await runSession({
      backend: control,
      store: new ResultsStore(":memory:"),
      ...dirs,
      selectorIds,
    });
    expect(second.mutantRuns).toBe(control.mutantRuns);
  });

  test("--resume-run naming a run from another project refuses, naming both", async () => {
    const dirs = await makeProject();
    const store = new ResultsStore(":memory:");
    const foreign = store.createRun({
      projectPath: "/somewhere/else",
      backend: "bcdev",
      appVersion: "1.0.0.0",
      configFingerprint: "fp",
    });
    await expect(
      runSession({ backend: new CountingBackend(), store, ...dirs, selectorIds, resume: foreign }),
    ).rejects.toThrow(/recorded project \/somewhere\/else/);
  });

  test("--resume-run naming a nonexistent run refuses", async () => {
    const dirs = await makeProject();
    const store = new ResultsStore(":memory:");
    await expect(
      runSession({ backend: new CountingBackend(), store, ...dirs, selectorIds, resume: 4242 }),
    ).rejects.toThrow(/no such run/);
  });
});

describe("stranded-note detection (R53)", () => {
  test("producer and detector share one constant", () => {
    // R31's lesson: a reworded literal makes the diagnosis silently stop firing, which is
    // indistinguishable from "this never happens". This pins the shape the orchestrator writes.
    expect(isStrandedNote(`${STRANDED_NOTE_PREFIX}SomeTest returned no readable result`)).toBe(
      true,
    );
  });

  test("an ordinary error is NOT treated as stranded — those must still be retried", () => {
    expect(isStrandedNote("deadline exceeded running SomeTest (infrastructure, not a kill)")).toBe(
      false,
    );
    expect(isStrandedNote("no green baseline tests")).toBe(false);
    expect(isStrandedNote(undefined)).toBe(false);
  });

  test("R201: a skip written by an earlier resume is stranded too, so the skip is sticky", () => {
    // `resolveResume` reads only the latest run. After one resume the latest row for a stranded
    // mutant is the SKIP, not the original `quarantined: ` row; if the skip did not count, the
    // next resume would re-run the hang. Measured on Document Output 2026-09-02 (M0023, a removed
    // loop counter): the first field run patched its database between iterations to stay skipped.
    expect(isStrandedNote(STRANDED_SKIP_NOTE)).toBe(true);
    const index = buildResumeIndex([row({ verdict: "error", failureNote: STRANDED_SKIP_NOTE })]);
    expect(index.strandedKeys.size).toBe(1);
    expect(index.carryable.size).toBe(0);
  });

  test("a stranding row is detected even when its identity key collides", () => {
    // Deliberately checked before the ambiguity rule: missing it does not cost a verdict, it
    // costs the whole run, because the resume hangs on that mutant forever.
    const index = buildResumeIndex([
      row({ verdict: "survived" }),
      row({ verdict: "error", failureNote: `${STRANDED_NOTE_PREFIX}T stranded the tier` }),
    ]);
    expect(index.ambiguousKeys).toBe(1);
    expect(index.carryable.size).toBe(0);
    expect(index.strandedKeys.size).toBe(1);
  });
});

/**
 * R89. A `--resume last` on a hosted Document Output run printed no `RESUMED:` banner and
 * re-measured 86 mutants from scratch, with a valid unfinished target sitting in the store holding
 * 113 verdicts. Three explanations were ruled out against the code and the argv was never
 * recovered, so the row's own conclusion is that reproduction needs the invocation.
 *
 * These two pin the SELF-CONSISTENCY guard that makes a recurrence loud instead of silent. It does
 * not explain the field report and does not claim to.
 */
describe("R89 — a run asked to resume must SAY it resumed", () => {
  test("the happy path still reports resumedFrom, so the guard is not simply always-off", async () => {
    const dirs = await makeProject();
    const store = new ResultsStore(":memory:");
    const first = new CountingBackend("pass", 1);
    await runSession({ backend: first, store, ...dirs, selectorIds });

    const second = new CountingBackend("pass");
    const report = await runSession({
      backend: second,
      store,
      ...dirs,
      selectorIds,
      resume: "last",
    });
    expect(report.resumedFrom).toBeDefined();
  });

  test("a run with NO --resume is untouched by the guard", async () => {
    // The counterweight. Without it the guard could be `cfg.resume === undefined ||
    // resumedFrom !== undefined` written the wrong way round and every plain run would throw.
    const dirs = await makeProject();
    const store = new ResultsStore(":memory:");
    const report = await runSession({
      backend: new CountingBackend("pass"),
      store,
      ...dirs,
      selectorIds,
    });
    expect(report.resumedFrom).toBeUndefined();
  });
});
