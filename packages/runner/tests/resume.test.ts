import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { IDENTITY_SCHEME } from "@lethal/schemata";
import type { MutantManifest, MutantManifestEntry } from "@lethal/schemata";
import {
  AL_RUNNER_UNDECIDED_ARM_MISSING,
  AlRunnerTestNameError,
  oneShotLimits,
  verdictFromRunnerTest,
} from "../src/al-runner-backend";
import { reserveAppVersion } from "../src/app-version";
import type { CompiledArtifact } from "../src/artifact";
import type {
  BackendCapabilities,
  BackendStatus,
  CoverageMode,
  ExecutionBackend,
  PackageUnread,
  RunManyOpts,
  RunManyResult,
  RunOpts,
  TestMethodRef,
  TestVerdict,
} from "../src/backend";
import { BcDevMcpBackend } from "../src/bcdev-backend";
import type { BcDevConfig } from "../src/bcdev-backend";
import type { MicrosoftMode } from "../src/digest-inputs";
import type { RunEvent } from "../src/events";
import { EXPLAIN_SCHEMA_VERSION, explain } from "../src/explain";
import { feedAttestation, runSession } from "../src/orchestrator";
import type { AttestationLedger } from "../src/orchestrator";
import { ERROR_CAUSE_INTERPRETATIONS, renderConsole } from "../src/report";
import type { SessionReport } from "../src/report";
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
import type { ResumeIndex, SessionFingerprintInput } from "../src/resume";
import { RUNNER_DISAGREEMENT_NOTE } from "../src/runner-disagreement";
import { serializeKey } from "../src/selection";
import { ResultsStore } from "../src/store";
import type { MutantVerdictRow } from "../src/store";
import { measuredV2_12 } from "./helpers/al-runner-predefined";
import { characterize, recording, traceEvents } from "./helpers/characterize";
import type { Trace } from "./helpers/characterize";
import { buildFakeAppWithEntries } from "./helpers/fake-app";
import { fakeMicrosoftMode } from "./helpers/microsoft-mode";
import {
  TEST_APP,
  servedIsInstalled,
  servesTestApp,
  testAppJson,
  testAppPackage,
} from "./helpers/proven-test-app";
import { removeScratchDir, scratchDirs } from "./helpers/scratch";
import { testDbPath } from "./helpers/test-db";
import { UNREAD } from "./helpers/unread";

const scratch = scratchDirs();

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
  kind: "bcdev",
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
  const root = scratch("lethal-resume-");
  const projectDir = join(root, "app");
  const testDir = join(root, "tests");
  const instrumentedDir = join(root, "instr");
  await Bun.write(join(projectDir, "SandboxLogic.Codeunit.al"), TARGET_AL);
  if (opts.secondFile === true) {
    await Bun.write(join(projectDir, "SandboxExtra.Codeunit.al"), SECOND_AL);
  }
  await Bun.write(join(projectDir, "app.json"), APP_JSON);
  await Bun.write(join(testDir, "SandboxTests.Codeunit.al"), TEST_AL);
  await Bun.write(join(testDir, "app.json"), testAppJson());
  return { projectDir, testDir, instrumentedDir };
}

/** C02-02: `n` random bytes as lowercase hex, the same shape a real artifactId/sha256 takes. */
function randomHex(n: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
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
    /** C02-02: opt-in only (default false keeps every other caller's deploy()-returns-null
     *  assumption). When true, deploy() returns a fresh CompiledArtifact each call, the way a
     *  real backend does, so a test can assert on `SessionReport.artifacts`. */
    private readonly withArtifact = false,
    /** R354: the coverage mode this backend reports (default CAPS's, `procedure`). */
    private readonly coverage: CoverageMode = CAPS.coverage,
  ) {}
  /** R495: the served test-app package, installed at its own version, as a real bcdev backend's
   *  is, so a run's test-app identity is proven. `{ unread }` is a failed read. */
  served: Uint8Array | PackageUnread = testAppPackage();
  async fetchPublishedAppPackage(): Promise<Uint8Array | PackageUnread> {
    return this.served;
  }
  microsoftMode(): MicrosoftMode {
    return servedIsInstalled(() => this.served);
  }
  capabilities(): BackendCapabilities {
    return { ...CAPS, coverage: this.coverage };
  }
  async status(): Promise<BackendStatus> {
    return { ok: true, details: "stub" };
  }
  async deploy(dir: string): Promise<CompiledArtifact | null> {
    this.deploys += 1;
    if (!this.withArtifact) return null;
    const artifactId = randomHex(16);
    const manifest: MutantManifest = { selectorIds, artifactId, mutants: [] };
    // R360: step 3d stores the published `.app`, so it must exist and hash to `sha256`.
    const appPath = join(dir, `${artifactId}.app`);
    await Bun.write(appPath, artifactId);
    return {
      artifactId,
      appId: APP_ID,
      appVersion: "1.0.0.0",
      appPath,
      sha256: Bun.SHA256.hash(artifactId, "hex"),
      mutantManifest: manifest,
      appManifest: {},
    };
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
  return scratch("lethal-store-");
}

function row(over: Partial<MutantVerdictRow> = {}): MutantVerdictRow {
  return {
    astHash: "hash-a",
    codeunitName: "Sandbox Logic",
    procedureName: "Post",
    operatorName: "lethal.negate-conditional",
    operatorMajor: 1,
    file: "src/SandboxLogic.Codeunit.al",
    identityOrdinal: 0,
    verdict: "survived",
    durationMs: 42,
    memberHash: null,
    ...over,
  };
}

/** R391: `index` under rule 1 (the recorded run had this session's source), so the tests below
 *  exercise the key lookup they were written for. */
function sameSource(index: ResumeIndex): ResumeIndex {
  return {
    ...index,
    carryRule: {
      recorded: { hash: "same", twins: null, dependencyHash: "dep" },
      current: { hash: "same", twins: new Set(), dependencyHash: "dep", refused: new Set() },
    },
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

/**
 * R577 (B1). A kill recorded before the reproduction rule (or with it off) may be a flaky test's
 * chance failure. A session whose backend has the rule on must re-run it, not carry it, under both
 * carry rules; one that does not keeps carrying it. Directional, like R53's flag above.
 */
describe("buildResumeIndex — a kill without killReproduced under the reproduction rule (R577)", () => {
  const preRule = [
    row({ verdict: "killed", astHash: "k", memberHash: "mh-k", killingTest: "T" }),
    row({ verdict: "timeout-killed", astHash: "t", memberHash: "mh-t", killingTest: "T" }),
  ];
  const marked = [
    row({
      verdict: "killed",
      astHash: "k",
      memberHash: "mh-k",
      killingTest: "T",
      killReproduced: true,
      reproducedFailure: "again",
    }),
    row({
      verdict: "timeout-killed",
      astHash: "t",
      memberHash: "mh-t",
      killingTest: "T",
      killReproduced: true,
    }),
  ];
  const survivor = row({ verdict: "survived", astHash: "s", memberHash: "mh-s" });

  test("with the rule on, neither pre-rule kill carries, under rule 1 or rule 2, and both are counted", () => {
    const index = buildResumeIndex([...preRule, survivor], true, true);
    expect([...index.carryable.values()].map((c) => c.verdict)).toEqual(["survived"]);
    expect([...index.carryableBySite.values()].map((c) => c.verdict)).toEqual(["survived"]);
    // M2: counted as unreproduced kills, never as prior 'error' verdicts.
    expect(index.unreproducedKills).toBe(2);
    expect(index.nonCarryableRows).toBe(0);
  });

  test("with the rule on, a marked kill carries under both rules, with its marker and text", () => {
    const index = buildResumeIndex(marked, true, true);
    expect(index.carryable.size).toBe(2);
    expect(index.carryableBySite.size).toBe(2);
    const killed = [...index.carryable.values()].find((c) => c.verdict === "killed");
    expect(killed).toMatchObject({ killReproduced: true, reproducedFailure: "again" });
  });

  test("with the rule off (the default), a pre-rule kill still carries", () => {
    expect(buildResumeIndex(preRule, true).carryable.size).toBe(2);
    expect(buildResumeIndex(preRule, true, false).carryableBySite.size).toBe(2);
  });
});

/**
 * R582 (U4): a run recorded on bcdev BEFORE R582 has `kill_reproduced` NULL on every kill. With the
 * flag read from `BcDevMcpBackend` itself, those kills are re-executed rather than carried; a
 * marked kill and a survivor still carry.
 */
describe("buildResumeIndex — a pre-R582 bcdev run under BcDevMcpBackend's flag (R582)", () => {
  test("its unmarked kills are re-executed, a marked kill and a survivor carry", () => {
    const store = new ResultsStore(":memory:");
    const runId = store.createRun({
      testScope: [],
      coverageMode: "fenced",
      identityScheme: IDENTITY_SCHEME,
      buildSymbols: [],
      projectPath: "/p",
      backend: "bcdev",
      appVersion: "1",
    });
    const base = {
      codeunitName: "Sandbox Logic",
      procedureName: "Post",
      operatorName: "lethal.negate-conditional",
      operatorMajor: 1,
      file: "src/SandboxLogic.Codeunit.al",
      line: 1,
      durationMs: 1,
      batchIndex: 0,
    };
    store.recordMutant(runId, {
      ...base,
      mutantCode: "M0001",
      astHash: "k1",
      verdict: "killed",
      killingTest: "T",
    });
    store.recordMutant(runId, {
      ...base,
      mutantCode: "M0002",
      astHash: "k2",
      verdict: "killed",
      killingTest: "T",
    });
    store.recordMutant(runId, { ...base, mutantCode: "M0003", astHash: "s", verdict: "survived" });
    store.recordMutant(runId, {
      ...base,
      mutantCode: "M0004",
      astHash: "k4",
      verdict: "killed",
      killingTest: "T",
      killReproduced: true,
    });
    const flag = new BcDevMcpBackend({} as unknown as BcDevConfig).killsMustReproduce === true;
    const index = buildResumeIndex(store.mutantVerdicts(runId), false, flag);
    expect(index.unreproducedKills).toBe(2);
    expect([...index.carryable.values()].map((c) => c.verdict).sort()).toEqual([
      "killed",
      "survived",
    ]);
    expect([...index.carryable.values()].find((c) => c.verdict === "killed")?.killReproduced).toBe(
      true,
    );
    store.close();
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
    expect(carriedVerdictFor(sameSource(index), first)?.verdict).toBe("killed");
    expect(carriedVerdictFor(sameSource(index), second)).toBeUndefined();
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
    identityScheme: IDENTITY_SCHEME,
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

  // R228: `runSession` passed `exclude` here for months while the fingerprint never read it, so
  // two runs differing only in their exclusions resumed into one another.
  test("a different --exclude scope changes it, and exclude order does not", () => {
    expect(sessionFingerprint({ ...base, exclude: ["a/**"] })).not.toBe(sessionFingerprint(base));
    expect(sessionFingerprint({ ...base, exclude: ["a/**"] })).not.toBe(
      sessionFingerprint({ ...base, exclude: ["b/**"] }),
    );
    expect(sessionFingerprint({ ...base, exclude: ["b/**", "a/**"] })).toBe(
      sessionFingerprint({ ...base, exclude: ["a/**", "b/**"] }),
    );
  });

  // R228: the key is CONDITIONAL, so no exclusions adds nothing to the digest. Pinned by value.
  // The value itself moved once, on purpose: R325 put the identity scheme into EVERY digest (it was
  // 16c632ac...9307 before), so no store keyed under an older scheme can be resumed. It moved again
  // for R323 (scheme 3; it was 9604b7d7...b2d5 under scheme 2). It moved again for R318, scheme 4;
  // it was 4a8c47ac...288a under scheme 3. It moved again for R214 (the next scheme after R318's);
  // it was 25fdc64a...3be4f under scheme 4. It moved again for R418 (scheme 6); it was
  // ef3bb9d1...daf5 under scheme 5. It moved again for R421 (scheme 7); it was b3f6072b...0c0e
  // under scheme 6. It moved again for R405 (scheme 8); it was 5c8357ec...0c4b under scheme 7.
  // It moved again for R307 (scheme 9, R374's run-wide ordinals); it was cf9df227...28d7 under
  // scheme 8. It moved again for R196 (scheme 10, refused loop-exit sites); it was
  // eab8b0ef...5539 under scheme 9. It moved again for R295/R294 (scheme 11); it was
  // 64769073...984e under scheme 10. It moved again for R455 (scheme 13); it was 667cd9c9...02aa
  // under scheme 11. It moved again for R454 (scheme 14, more refused loop-exit sites); it was
  // b5155ac2...1864 under scheme 13. It moved again for R-364 (scheme 16, hang refusal by name in
  // an unindexed object); it was a721384a...f23c under scheme 14. It moved again for R254 (scheme
  // 17, reportextensions instrumented); it was 961d7a41...3b65 under scheme 16. It moved again for
  // R-458 (scheme 18, hang refusal by name through `with` subjects and implicit records); it was
  // f6e4a1c6...c971 under scheme 17. It moved again for R468 (scheme 19, every object-level var
  // section is globals); it was 44f5ea54...3e7a under scheme 18. It moved again for R459 (scheme
  // 21, a two-argument Insert's Booleans flipped); it was 869bd1ae...68cd9 under scheme 19. It
  // moved again for R-464 (scheme 22, one implicit-record resolver); it was 6aab8fc7...be41 under
  // scheme 21. It moved again for R475 (scheme 24, code-unit twin order); it was
  // 06081a49...f571 under scheme 22. It moved again for R446 (scheme 25, body-exit guards of a
  // `while true` loop); it was e2706d8f...97bd under scheme 24. It moved again for R477 (scheme 26,
  // validate-to-assign's guarded bare fallback); it was 98154689...145c under scheme 25. It moved
  // again for R480 (scheme 27, body-exit guards under any non-cursor condition, feeds, `for`
  // control variables); it was cbbd9d28...3a65 under scheme 26. It moved again for R484 (scheme
  // 28, open `Integer` report data items are loops); it was 4ea3654a...49ab under scheme 27. It
  // moved again for R-300b (scheme 29, al-runner scores a `#if`-wrapped object alone in its file);
  // it was 1ce22835...7dd7 under scheme 28. It moved again for R487 (scheme 30, every site in an
  // open `Integer` data item's code is hang-refused); it was 51406729...1b37 under scheme 29. It
  // moved again for R509 (scheme 32, a temporary record's fields are typed); it was 5b1d3f6c...8f56
  // under scheme 30. It moved again for R501 (scheme 33, that scope refused for every operator,
  // and a bounded item's only bound); it was b6299a65...ed32 under scheme 32. It moved again for
  // R343 (scheme 34, a wrapped object the build compiles is indexed); it was 9db5cc98...d7a1 under
  // scheme 33. It moved again for R500 (scheme 35, Date items, one-hop callees and the stated
  // limits); it was 16607059...1e76 under scheme 34. It moved again for R497 (scheme 36, #if-wrapped
  // objects of the measured shapes are scored on the BC paths); it was 400af96f...8760 under scheme 35.
  // It moved again for R340 (scheme 37, trigger header names typed); it was 7f7b02f9...181f under scheme 36.
  // It moved again for R555 (scheme 38, a preset-exit-name writer call is hang-refused); it was
  // 9d5d97b3...91ce under scheme 37. It moved again for R-531 (scheme 39, a loop that ends only by
  // consuming its record set is hang-refused); it was 5ee5c7b6...3ec0 under scheme 38. It moved
  // again for R565 (scheme 40, an outside report's preset writers are read from the dependency
  // packages); it was f1086a61...e634 under scheme 39. It moved again for R572 (scheme 41, a guard
  // refused as a single site renumbers its procedure's same-tuple twins); it was 7abca7bc...6109
  // under scheme 40.
  const PINNED = "c49d72bc1d8b52b8c9d4964c21cd080b1e5ed95cfa79933cdb0530705f30773a";
  test("a run with no exclusions adds nothing to the digest", () => {
    expect(sessionFingerprint(base)).toBe(PINNED);
  });

  // C02-06 review r1 item 2: `#if` branches compile differently under other symbols, and R192's
  // baseline key hashes AL bytes only, so a resume across a symbol change would reuse measurements
  // made under the old symbols. Order selects nothing different, so it must not defeat a resume.
  test("different preprocessor symbols change it, and symbol order does not", () => {
    const ab = sessionFingerprint({ ...base, preprocessorSymbols: ["CLEAN24", "CLEAN25"] });
    expect(ab).not.toBe(sessionFingerprint({ ...base, preprocessorSymbols: ["CLEAN24"] }));
    expect(ab).not.toBe(sessionFingerprint(base));
    expect(ab).toBe(sessionFingerprint({ ...base, preprocessorSymbols: ["CLEAN25", "CLEAN24"] }));
  });

  // The key is conditional like `exclude`'s, so a run with no symbols keeps the digest pinned
  // above.
  test("no preprocessor symbols, or an empty list, keeps the pre-symbol digest", () => {
    expect(sessionFingerprint({ ...base, preprocessorSymbols: [] })).toBe(PINNED);
  });

  // R403: the test app's derived set and the arm-policy marker are conditional keys, so a session
  // with no test symbols and nothing the policy changed keeps PINNED byte for byte.
  test("R403: no test symbols and no arm-policy marker keep PINNED", () => {
    expect(sessionFingerprint({ ...base, testBuildSymbols: [] })).toBe(PINNED);
  });

  test("R403: the test build set changes it, order does not, and it is apart from the target's", () => {
    const x = sessionFingerprint({ ...base, testBuildSymbols: ["X", "A"] });
    expect(x).not.toBe(PINNED);
    expect(x).toBe(sessionFingerprint({ ...base, testBuildSymbols: ["A", "X"] }));
    expect(x).not.toBe(sessionFingerprint({ ...base, testBuildSymbols: ["A"] }));
    expect(x).not.toBe(sessionFingerprint({ ...base, preprocessorSymbols: ["A", "X"] }));
  });

  // Plan §3(e)'s counterexample at the function: the target set is {X} both times, the test set
  // moves {} -> {X}.
  test("R403: the counterexample, a target set held at {X} while the test set moves {} -> {X}", () => {
    const before = sessionFingerprint({ ...base, preprocessorSymbols: ["X"] });
    const after = sessionFingerprint({
      ...base,
      preprocessorSymbols: ["X"],
      testBuildSymbols: ["X"],
    });
    expect(after).not.toBe(before);
  });

  test("R403: the arm-policy marker changes it", () => {
    expect(sessionFingerprint({ ...base, testDiscovery: "arms-v1" })).not.toBe(PINNED);
  });

  // R354: the coverage mode is a conditional key, so an input without it keeps PINNED (the
  // function is unchanged for it), while every mode, and each mode against none, digests apart.
  test("the coverage mode changes it, and its absence keeps PINNED", () => {
    const modes = ["none", "procedure", "line", "fenced", "al-runner"] as const;
    const digests = modes.map((coverageMode) => sessionFingerprint({ ...base, coverageMode }));
    expect(new Set(digests).size).toBe(modes.length);
    expect(digests).not.toContain(PINNED);
    expect(sessionFingerprint(base)).toBe(PINNED);
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
      testScope: [],
      coverageMode: "procedure",
      identityScheme: IDENTITY_SCHEME,
      buildSymbols: [],
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
      testScope: [],
      coverageMode: "procedure",
      identityScheme: IDENTITY_SCHEME,
      buildSymbols: [],
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
      testScope: [],
      coverageMode: "procedure",
      identityScheme: IDENTITY_SCHEME,
      buildSymbols: [],
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
    store.createRun({
      testScope: [],
      coverageMode: "procedure",
      identityScheme: IDENTITY_SCHEME,
      buildSymbols: [],
      projectPath: "/p",
      backend: "bcdev",
      appVersion: "1.0.0.0",
    });
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
      testScope: [],
      coverageMode: "procedure",
      identityScheme: IDENTITY_SCHEME,
      buildSymbols: [],
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
      testScope: [],
      coverageMode: "procedure",
      identityScheme: IDENTITY_SCHEME,
      buildSymbols: [],
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
      testScope: [],
      coverageMode: "procedure",
      identityScheme: IDENTITY_SCHEME,
      buildSymbols: [],
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
      testScope: [],
      coverageMode: "procedure",
      identityScheme: IDENTITY_SCHEME,
      buildSymbols: [],
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
      testScope: [],
      coverageMode: "procedure",
      identityScheme: IDENTITY_SCHEME,
      buildSymbols: [],
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
        file: "f.al",
        identityOrdinal: 0,
        verdict: "killed",
        killingTest: "T",
        durationMs: 77,
        // R474: a row recorded without a member hash reads back NULL, never an invented one.
        memberHash: null,
      },
    ]);
  });

  test("R192: mutantVerdicts reads back the coverage facts, and their absence stays an absence", () => {
    const store = new ResultsStore(":memory:");
    const id = store.createRun({
      testScope: [],
      coverageMode: "procedure",
      identityScheme: IDENTITY_SCHEME,
      buildSymbols: [],
      projectPath: "/p",
      backend: "bcdev",
      appVersion: "1.0.0.0",
    });
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
    const path = testDbPath("pre-r192.sqlite");
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
      testScope: [],
      coverageMode: "procedure",
      identityScheme: IDENTITY_SCHEME,
      buildSymbols: [],
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
    const id = store.createRun({
      testScope: [],
      coverageMode: "procedure",
      identityScheme: IDENTITY_SCHEME,
      buildSymbols: [],
      projectPath: "/p",
      backend: "bcdev",
      appVersion: "1.0.0.0",
    });
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
    const id = store.createRun({
      testScope: [],
      coverageMode: "procedure",
      identityScheme: IDENTITY_SCHEME,
      buildSymbols: [],
      projectPath: "/p",
      backend: "bcdev",
      appVersion: "1.0.0.0",
    });
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
    const id = store.createRun({
      testScope: [],
      coverageMode: "procedure",
      identityScheme: IDENTITY_SCHEME,
      buildSymbols: [],
      projectPath: "/p",
      backend: "bcdev",
      appVersion: "1.0.0.0",
    });
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
    const id = store.createRun({
      testScope: [],
      coverageMode: "procedure",
      identityScheme: IDENTITY_SCHEME,
      buildSymbols: [],
      projectPath: "/p",
      backend: "bcdev",
      appVersion: "1.0.0.0",
    });
    seed(store, id, 0, { astHash: "a", verdict: "known-survivor" });
    seed(store, id, 0, { astHash: "b", verdict: "error", failureNote: "deadline exceeded" });
    expect(store.invalidateBatch(id, 0, "unattested")).toBe(0);
    const notes = store.mutantVerdicts(id).map((r) => r.failureNote);
    expect(notes).toContain("deadline exceeded");
    expect(notes).not.toContain("unattested");
  });
});

describe("ResultsStore.dropBaselineSnapshot (R508)", () => {
  function twoSnapshots(): { store: ResultsStore; id: number } {
    const store = new ResultsStore(":memory:");
    const id = store.createRun({
      testScope: [],
      coverageMode: "procedure",
      identityScheme: IDENTITY_SCHEME,
      buildSymbols: [],
      projectPath: "/p",
      backend: "bcdev",
      appVersion: "1",
      testAppHash: "package:t",
      testAppProven: true,
      testAppDeps: "D",
    });
    const ref = { codeunitId: 79100, codeunitName: "Tests", method: "A" };
    for (const batchIndex of [0, 1]) {
      store.recordBaselineSnapshot({
        runId: id,
        batchIndex,
        batchHash: `b${batchIndex}`,
        testAppHash: "package:t",
        baseline: [{ ref, verdict: { ref, outcome: "pass", durationMs: 1 } }],
      });
    }
    return { store, id };
  }

  test("drops only the named batch's snapshot", () => {
    const { store, id } = twoSnapshots();
    expect(store.dropBaselineSnapshot(id, 0)).toBe(1);
    expect(store.findBaselineSnapshot("b0", "package:t", "D", "procedure")).toBeNull();
    expect(store.findBaselineSnapshot("b1", "package:t", "D", "procedure")?.batchIndex).toBe(1);
  });

  test("invalidateBatch leaves snapshots alone (the attestation path is unchanged)", () => {
    const { store, id } = twoSnapshots();
    store.invalidateBatch(id, 0, "unattested");
    expect(store.findBaselineSnapshot("b0", "package:t", "D", "procedure")?.batchIndex).toBe(0);
    expect(store.findBaselineSnapshot("b1", "package:t", "D", "procedure")?.batchIndex).toBe(1);
  });
});

describe("runSession --resume (R47)", () => {
  test("review M-3: a quarantined run whose bundle is gone still returns its quarantined report", async () => {
    class DroppingStore extends ResultsStore {
      override recordArtifact(...args: Parameters<ResultsStore["recordArtifact"]>): void {
        super.recordArtifact(...args);
        this.db.query("DELETE FROM installed_bundles WHERE run_id = ?").run(args[0]);
      }
    }
    const dirs = await makeProject();
    const store = new DroppingStore(":memory:");
    const report = await runSession({
      backend: new CountingBackend("pass", 1, undefined, true),
      store,
      ...dirs,
      selectorIds,
    });
    expect(report.quarantined).toBeDefined();
    store.close();
  });

  // Review r1 #3: no resume path reads the prior run's installed .app or bundle (resolveResume,
  // replayCarriedBatch and snapshot reuse read store rows, the current batch dir and the test app),
  // so a pruned bundle must not cost the user the aborted run's carryable work.
  test("R360: a run whose highest bundle a later run pruned still resumes, under both flags", async () => {
    const dirs = await makeProject();
    const store = new ResultsStore(":memory:");
    // An aborted run: it published batch 0 and scored one mutant, then quarantined (unfinished).
    const aborted = new CountingBackend("pass", 1, undefined, true);
    expect(
      (await runSession({ backend: aborted, store, ...dirs, selectorIds })).quarantined,
    ).toBeDefined();
    const abortedId = (store.db.query("SELECT MAX(id) AS id FROM runs").get() as { id: number }).id;
    // A later run of the same app on the same (no) server publishes and finishes, which prunes
    // the older unfinished run's bundle (ruling Q1).
    await runSession({
      backend: new CountingBackend("pass", undefined, undefined, true),
      store,
      ...dirs,
      selectorIds,
    });
    expect(store.trustedArtifactRecord(abortedId, 0)?.bundlePrunedBy).not.toBeNull();

    for (const resume of [abortedId, "last"] as const) {
      const again = new CountingBackend("pass", undefined, undefined, true);
      const report = await runSession({ backend: again, store, ...dirs, selectorIds, resume });
      expect(report.resumedFrom?.runId).toBe(abortedId);
      expect(report.resumedFrom?.carriedMutants).toBe(1);
      expect(report.quarantined).toBeUndefined();
    }
  });

  test("R360 I4: a resumed run that publishes nothing (every batch carried) passes the end-of-run check", async () => {
    const dirs = await makeProject();
    // How many mutants the project has, from a control run.
    const control = await runSession({
      backend: new CountingBackend("pass"),
      store: new ResultsStore(":memory:"),
      ...dirs,
      selectorIds,
    });
    const n = control.mutants.length;
    expect(n).toBeGreaterThan(1);
    const store = new ResultsStore(":memory:");
    // Scores all but the last mutant, then strands it: every mutant then carries on resume.
    const first = await runSession({
      backend: new CountingBackend("pass", n - 1, undefined, true),
      store,
      ...dirs,
      selectorIds,
    });
    expect(first.quarantined).toBeDefined();
    const again = new CountingBackend("pass", undefined, undefined, true);
    const report = await runSession({
      backend: again,
      store,
      ...dirs,
      selectorIds,
      resume: "last",
    });
    expect(again.deploys).toBe(0);
    expect(report.artifacts ?? []).toEqual([]);
    expect(report.quarantined).toBeUndefined();
  });

  test("R577 (M2): a resume with the reproduction rule re-runs a pre-rule kill and says so in its own words, not as a prior 'error' verdict", async () => {
    const dirs = await makeProject();
    const store = new ResultsStore(":memory:");
    // Rule off: one kill is scored (no killReproduced), then the next mutant strands the run.
    const first = await runSession({
      backend: new CountingBackend("fail", 1),
      store,
      ...dirs,
      selectorIds,
    });
    expect(first.quarantined).toBeDefined();
    expect(first.counts.killed).toBe(1);
    class ReproCounting extends CountingBackend {
      readonly killsMustReproduce = true;
    }
    const events: RunEvent[] = [];
    const report = await runSession({
      backend: new ReproCounting("fail"),
      store,
      ...dirs,
      selectorIds,
      resume: "last",
      emit: [(e) => events.push(e)],
    });
    expect(report.resumedFrom?.carriedMutants).toBe(0);
    const reusing = events.find((e) => e.type === "warning" && e.code === "resume-reusing-run");
    const message = reusing?.type === "warning" ? reusing.message : "";
    expect(message).toContain(
      "1 prior kill(s) recorded before the kill-reproduction rule (no killReproduced) will be re-executed",
    );
    // The stranded row is the only prior 'error' verdict.
    expect(message).toContain(" 1 prior 'error' verdict(s) will be re-executed.");
    // Re-run under the rule, so the kill now carries the marker.
    const rescored = report.mutants.filter((m) => m.verdict === "killed");
    expect(rescored.length).toBeGreaterThan(0);
    expect(rescored.every((m) => m.killReproduced === true)).toBe(true);
  });

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
    const first = new CountingBackend("pass", undefined, 2, true); // batch 0 fully scored, batch 1 aborts
    const firstReport = await runSession({
      backend: first,
      store,
      ...dirs,
      selectorIds,
      maxGuardsPerBatch: 1,
    });
    expect(firstReport.batches).toBe(2);
    expect(first.deploys).toBe(2);
    // C02-02: this run published both batches, so both have an artifacts[] entry.
    expect(firstReport.artifacts).toBeDefined();
    expect((firstReport.artifacts ?? []).map((a) => a.batchIndex)).toEqual([0, 1]);
    const batch0Before = firstReport.mutants.filter((m) => m.batchIndex === 0);
    expect(batch0Before.length).toBeGreaterThan(0);
    // Every batch-0 verdict was measured with a non-empty covering list, which is what makes
    // the assertion below on the carried list a real one rather than [] equalling [].
    expect(batch0Before.every((m) => (m.coveringTests?.length ?? 0) > 0)).toBe(true);

    const second = new CountingBackend("pass", undefined, undefined, true);
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
    // C02-02: the carried batch has no entry of its own (nothing was published for it this run);
    // only batch 1, the one that actually deployed, does.
    expect((report.artifacts ?? []).map((a) => a.batchIndex)).toEqual([1]);
    const firstBatch1Artifact = firstReport.artifacts?.find((a) => a.batchIndex === 1);
    const secondBatch1Artifact = report.artifacts?.find((a) => a.batchIndex === 1);
    if (firstBatch1Artifact === undefined || secondBatch1Artifact === undefined) {
      throw new Error("expected both runs to have published a batch-1 artifact");
    }
    expect(secondBatch1Artifact.artifactId).not.toBe(firstBatch1Artifact.artifactId);
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

  // C02-06: lethal verify refuses a carried row, because a carried verdict was measured against
  // an earlier build. Same run as the test above: batch 0 carries whole, batch 1 runs.
  test("a carried verdict is stored carried, a measured one not", async () => {
    const dirs = await makeProject({ secondFile: true });
    const store = new ResultsStore(":memory:");
    await runSession({
      backend: new CountingBackend("pass", undefined, 2),
      store,
      ...dirs,
      selectorIds,
      maxGuardsPerBatch: 1,
    });
    const report = await runSession({
      backend: new CountingBackend("pass"),
      store,
      ...dirs,
      selectorIds,
      maxGuardsPerBatch: 1,
      resume: "last",
    });
    const run = store.db.query("SELECT MAX(id) AS id FROM runs").get() as { id: number };
    const batch0 = store.batchMutantRows(run.id, 0);
    const batch1 = store.batchMutantRows(run.id, 1);
    // Batch 0 carried whole (three mutants); batch 1 measured its own, including the stranded one
    // it skips as error, which is recorded, not carried.
    expect(batch0.map((r) => r.carried)).toEqual([true, true, true]);
    expect(batch1.map((r) => r.carried)).toEqual([false, false, false]);
    // The report, built from events rather than the store, agrees on how many carried.
    expect(report.mutants.filter((m) => m.carried === true)).toHaveLength(3);
  });

  // R247 superseded this: a changed test app no longer re-runs the baseline under a resume, it
  // refuses the resume, since every carried verdict was measured against the old test app too.
  test("R192 (second half), R247: a changed test app refuses the resume, so no baseline is reused", async () => {
    const dirs = await makeProject({ secondFile: true });
    const store = new ResultsStore(":memory:");
    await runSession({
      backend: new CountingBackend("pass", undefined, 2),
      store,
      ...dirs,
      selectorIds,
      maxGuardsPerBatch: 1,
    });
    // Republish the test app: the served package's hash moves. (R495: on a bcdev-shaped backend
    // the package, not the disk, is the identity; a backend with no package read proves none.)
    const second = new CountingBackend("pass");
    second.served = testAppPackage("1.0.0.0", "<!-- republished -->");
    await expect(
      runSession({
        backend: second,
        store,
        ...dirs,
        selectorIds,
        maxGuardsPerBatch: 1,
        resume: "last",
      }),
    ).rejects.toThrow(/R247/);
    expect(second.baselineRuns).toBe(0);
    expect(second.deploys).toBe(0);
  });

  test("R192: a batch whose carried rows predate the coverage columns is deployed as before", () => {
    // A pre-R192 database holds verdicts without covering tests. Skipping on those would record
    // a carried survivor with an invented empty list, so the batch takes the ordinary path.
    const withFacts = sameSource(
      buildResumeIndex(
        [row({ astHash: "a", coveringTests: ["T.one"], coverageAttribution: "exact" })],
        false,
      ),
    );
    const withoutFacts = sameSource(buildResumeIndex([row({ astHash: "a" })], false));
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

  // R228: the same shape for `--exclude`, which the fingerprint silently dropped. Two files, so
  // excluding one leaves something to mutate.
  test("--resume refuses to reuse a run scoped by different --exclude patterns", async () => {
    const dirs = await makeProject({ secondFile: true });
    const store = new ResultsStore(":memory:");
    const first = await runSession({
      backend: new CountingBackend("pass", 1),
      store,
      ...dirs,
      selectorIds,
      exclude: ["SandboxExtra.Codeunit.al"],
    });
    expect(first.quarantined).toBeDefined();
    await expect(
      runSession({ backend: new CountingBackend(), store, ...dirs, selectorIds, resume: "last" }),
    ).rejects.toThrow(/found no unfinished run to resume/);
    const resumed = await runSession({
      backend: new CountingBackend("pass"),
      store,
      ...dirs,
      selectorIds,
      exclude: ["SandboxExtra.Codeunit.al"],
      resume: "last",
    });
    expect(resumed.resumedFrom?.carriedMutants).toBe(1);
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
      testScope: [],
      coverageMode: "procedure",
      identityScheme: IDENTITY_SCHEME,
      buildSymbols: [],
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

  // R618 (orchestrator ruling 2): a finished run has nothing left to score, so `--resume-run` of
  // one is refused by name before any run row or lease; the same run, unfinished, resumes.
  test("--resume-run of a FINISHED run is refused by name; the same run unfinished resumes", async () => {
    const dirs = await makeProject();
    const store = new ResultsStore(":memory:");
    await runSession({ backend: new CountingBackend(), store, ...dirs, selectorIds });
    const runId = (store.db.query("SELECT MAX(id) AS id FROM runs").get() as { id: number }).id;
    expect(store.getRun(runId)?.finished).toBe(true);
    const resume = () =>
      runSession({ backend: new CountingBackend(), store, ...dirs, selectorIds, resume: runId });
    await expect(resume()).rejects.toThrow(
      `--resume-run ${runId}: run ${runId} already finished; nothing to resume.`,
    );
    const after = (store.db.query("SELECT MAX(id) AS id FROM runs").get() as { id: number }).id;
    expect(after).toBe(runId);
    store.db.run("UPDATE runs SET finished_at = NULL WHERE id = ?", [runId]);
    expect((await resume()).resumedFrom?.runId).toBe(runId);
  });

  test("C02-02: report.artifacts carries the COMPILED appVersion, not the reserved one", async () => {
    // CountingBackend's opt-in artifact always reports "1.0.0.0" (a fixed stand-in for what a
    // real backend compiled), while this project's own app.json is ALSO "1.0.0.0", so the
    // orchestrator's reserved version (major.minor from app.json, build.revision clock-derived,
    // see reserveAppVersion) can never equal it: the third component is a day count since the
    // Unix epoch, which is never 0 for a real clock. That gap is what makes this fixture able to
    // catch the bug: a session that (wrongly) emitted the reserved version instead of the
    // compiled one would disagree with the store here.
    const dirs = await makeProject();
    const store = new ResultsStore(":memory:");
    const backend = new CountingBackend("pass", undefined, undefined, true);
    const report = await runSession({ backend, store, ...dirs, selectorIds });

    const run = store.db.query("SELECT id FROM runs LIMIT 1").get() as { id: number };
    const storeArtifacts = store.artifactsForRun(run.id);
    expect(report.artifacts).toEqual(storeArtifacts);

    const artifact = report.artifacts?.[0];
    if (artifact === undefined) throw new Error("expected one published batch's artifact");
    expect(artifact.appVersion).toBe("1.0.0.0");

    const reserved = reserveAppVersion({ sourceVersion: "1.0.0.0", nowMs: Date.now() });
    expect(reserved).not.toBe(artifact.appVersion);
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

/**
 * C02-04 Part A, Task 1: the resume half of the characterization snapshot (the rest is in
 * orchestrator.test.ts). This is the only path through the baseline-snapshot reuse, so it is
 * characterized here with this file's own fakes. `--update-snapshots` is forbidden after the commit
 * that adds it, until the end of Part A.
 */
describe("C02-04 characterization", () => {
  test("R192: the resumed run reuses batch 1's baseline snapshot", async () => {
    // From "R192 (second half): a batch with work left is deployed but its baseline is NOT re-run
    // when nothing it measured changed". Two additions, so the snapshot-hash read shows in the
    // trace: a test-app app.json (the hash reads it to name the package) and a package reader.
    // R495: the reader serves the package, installed at its version (CountingBackend's default):
    // it used to answer `undefined` ("cannot form the request"), whose source-tree fallback a bcdev
    // run no longer counts as proven, so it would lend no snapshot.
    const dirs = await makeProject({ secondFile: true });
    const store = new ResultsStore(":memory:");
    const first = new CountingBackend("pass", undefined, 2);
    const firstReport = await runSession({
      backend: first,
      store,
      ...dirs,
      selectorIds,
      maxGuardsPerBatch: 1,
    });
    expect(firstReport.quarantined).toBeDefined();

    const trace: Trace = [];
    const second = new CountingBackend("pass");
    const report = await runSession({
      backend: recording(second, trace, "primary"),
      store,
      ...dirs,
      selectorIds,
      maxGuardsPerBatch: 1,
      resume: "last",
      emit: [traceEvents(trace)],
    }).catch((e: unknown) => e);
    expect(second.baselineRuns).toBe(0);
    expect(
      trace.some(
        (t) =>
          (t as { event?: { type?: string; code?: string } }).event?.code ===
          "resume-baseline-reused",
      ),
    ).toBe(true);
    expect(characterize(trace, store, report)).toMatchSnapshot();
  });

  test("R272: a reused baseline's durations never reach the report's testMethods", async () => {
    // Batch 1's baseline is reused on resume (R192), and its stored verdicts carry the first run's
    // 111 ms. The resumed run measures 222 ms wherever it runs a baseline itself. The report keeps
    // the SMALLEST measurement per test, so a reused 111 would win wherever it leaked through.
    // R495: CountingBackend serves its package, installed, so the run's identity is proven and
    // lends its snapshot (a reader answering `undefined` proves nothing on a bcdev backend).
    const dirs = await makeProject({ secondFile: true });
    const measuring = <B extends CountingBackend>(b: B, ms: number): B => {
      const run = b.run.bind(b);
      b.run = async (ref, opts) => {
        const v = await run(ref, opts);
        return v.outcome === "pass" ? { ...v, measuredDurationMs: ms } : v;
      };
      return b;
    };
    const store = new ResultsStore(":memory:");
    const firstReport = await runSession({
      backend: measuring(new CountingBackend("pass", undefined, 2), 111),
      store,
      ...dirs,
      selectorIds,
      maxGuardsPerBatch: 1,
    });
    const firstDurations = (firstReport.testMethods ?? []).map((t) => t.baselineDurationMs);
    expect(firstDurations.length).toBeGreaterThan(0);
    expect(firstDurations.every((d) => d === 111)).toBe(true);

    const second = measuring(new CountingBackend("pass"), 222);
    const report = await runSession({
      backend: second,
      store,
      ...dirs,
      selectorIds,
      maxGuardsPerBatch: 1,
      resume: "last",
    });
    // Every batch with work left reuses its snapshot here, so this session measured no baseline:
    // no test has a duration, rather than the reused 111.
    expect(second.baselineRuns).toBe(0);
    const methods = report.testMethods ?? [];
    expect(methods.length).toBeGreaterThan(0);
    expect(methods.filter((t) => t.baselineDurationMs !== undefined)).toEqual([]);
  });

  test("R272: an aborted baseline batch contributes no duration (completed batches only)", async () => {
    // Batch 1's baseline completes at 50 ms per test. Batch 2's baseline measures its first test
    // at 17 ms and then strands the session (in-flight-unknown), so it never reaches
    // `baseline-batch-finished`. The documented field is the smallest from COMPLETED baseline
    // batches: that test reads 50, never 17.
    const dirs = await makeProject({ secondFile: true });
    // A second test, so batch 2's baseline has a call after the measured one to strand on.
    await Bun.write(
      join(dirs.testDir, "MoreTests.Codeunit.al"),
      'codeunit 79910 "More Tests"\n{\n    Subtype = Test;\n\n    [Test]\n    procedure Second()\n    begin\n    end;\n}\n',
    );
    const b = new CountingBackend("pass");
    const run = b.run.bind(b);
    let batch2Baseline = 0;
    let aborted: string | undefined;
    b.run = async (ref, opts) => {
      const before = b.baselineRuns;
      const v = await run(ref, opts);
      if (b.baselineRuns === before) return v; // a mutant run
      if (b.deploys === 1) return { ...v, measuredDurationMs: 50 };
      batch2Baseline += 1;
      if (batch2Baseline === 1) {
        aborted = `${ref.codeunitName}.${ref.method}`;
        return { ...v, measuredDurationMs: 17 };
      }
      return {
        ref,
        outcome: "error",
        durationMs: 5,
        operation: "in-flight-unknown",
        failureMessage: "RunMutant timed out: AbortError",
      };
    };
    const report = await runSession({
      backend: b,
      store: new ResultsStore(":memory:"),
      ...dirs,
      selectorIds,
      maxGuardsPerBatch: 1,
    });
    expect(report.quarantined).toBeDefined();
    expect(b.deploys).toBe(2);
    expect(aborted).toBeDefined();
    const durations = (report.testMethods ?? []).map((t) => [t.name, t.baselineDurationMs]);
    expect(durations.length).toBeGreaterThan(1);
    expect(durations.filter(([, d]) => d !== 50)).toEqual([]);
  });
});

// R325: an identity key carries no version of its own, so a renumbering (R193 ordinals) can hand an
// old key to a different mutant with the AL source unchanged. Every consumer that carries a verdict
// across sessions must refuse a key made under another identity scheme. The "old" run below is made
// by this build and then rewritten to look like one recorded before the scheme existed: its
// `identity_scheme` is NULL (read as 1) and its fingerprint is the one a scheme-1 build computes.
describe("R325: no verdict crosses an identity-scheme change", () => {
  async function oldSchemeRun(opts: { finished: boolean }) {
    const dirs = await makeProject();
    const store = new ResultsStore(":memory:");
    const first = await runSession({
      backend: new CountingBackend("pass", opts.finished ? undefined : 1),
      store,
      ...dirs,
      selectorIds,
    });
    const run = store.db.query("SELECT id, backend FROM runs").get() as {
      id: number;
      backend: string;
    };
    const oldFingerprint = sessionFingerprint({
      projectDir: dirs.projectDir,
      testDir: dirs.testDir,
      backend: run.backend,
      skipKnownSurvivors: false,
      selectorIds,
      identityScheme: 1,
    });
    store.db.run("UPDATE runs SET identity_scheme = NULL, config_fingerprint = ? WHERE id = ?", [
      oldFingerprint,
      run.id,
    ]);
    return { dirs, store, first, runId: run.id };
  }

  test("the report carries the identity scheme it was keyed under", async () => {
    const dirs = await makeProject();
    const report = await runSession({
      backend: new CountingBackend("pass"),
      store: new ResultsStore(":memory:"),
      ...dirs,
      selectorIds,
    });
    // Pinned by value so a bump is deliberate: 33 since R501 (that scope is hang-refused for every
    // operator at dispatch, and so is a bounded item's only SetRange bound); 32 was R509 (a
    // temporary record's fields are typed); 31 was held for R-501 and is unused; 30 was R487 (every
    // site the four hang-capable operators mutate in an open `Integer` data item's code is
    // hang-refused); 29 was R-300b
    // (al-runner scores a `#if`-wrapped
    // object alone in its file, so a refused key's verdict can now be scored; no key moves); 28 was
    // R484 (an open `Integer` report data item is
    // a loop; writes its exit guards or range bounds read are hang-refused); 27 was R480 (body-exit
    // guards under any non-cursor condition, indirect feeds of a `while true` guard, `for`
    // control-variable writes); 26 was R477 (validate-to-assign's guarded bare fallback adds same-tuple twins); 25 was R446
    // (body-exit guards of a `while true`
    // loop); 24 was R475 (twins numbered in code-unit file order, not the host's collation; 23 is
    // unused); 22 was R-464 (one implicit-record resolver: page and TableNo `Rec`, dataitems and
    // `with` subjects resolve); 21 was R459 (a two-argument
    // Insert's Booleans are flipped; 20 is unused); 19 was R468 (every object-level var section is
    // globals); 18 was R-458 (hang refusal by name through `with` subjects and implicit records);
    // 17 was R254 (reportextensions instrumented); 16
    // was R-364 (hang refusal by name inside an unindexed object; 15 was reserved for R-254 and is
    // unused); 14 was R454 (more refused loop-exit sites); 13 was R455 (field-designator swaps,
    // calls in a record scope, case-only pairs removed; 12 was reserved for R254 and is unused); 11
    // was R295/R294 (every name of `A, B: T`, member receivers); 10 was R196 (refused loop-exit
    // sites move twins). 34 is R343 (a wrapped object the build compiles is indexed). 35 is R500
    // (Date items, one-hop callees, subscribers and the two stated limits are hang-refused). 36 is
    // R497 (#if-wrapped objects of the measured shapes are scored on the BC paths). 37 is R340 (trigger header names typed).
    // 38 is R555 (a call to a preset-exit-name writer is hang-refused). 39 is R-531 (a loop that
    // ends only by consuming its record set: its consumers are hang-refused). 40 is R565 (an
    // outside report's preset writers are read from the dependency packages). 41 is R572 (a guard
    // refused as a single site renumbers its procedure's same-tuple twins).
    expect(IDENTITY_SCHEME).toBe(41);
    expect(report.identityScheme).toBe(IDENTITY_SCHEME);
  });

  test("history: an old-scheme survivor is executed, not skipped as a known survivor", async () => {
    const { dirs, store, first, runId } = await oldSchemeRun({ finished: true });
    expect(first.counts.survived).toBeGreaterThan(0);
    const events: RunEvent[] = [];
    const report = await runSession({
      backend: new CountingBackend("pass"),
      store,
      ...dirs,
      selectorIds,
      skipKnownSurvivors: true,
      emit: [(e) => events.push(e)],
    });
    expect(report.mutants.filter((m) => m.verdict === "known-survivor")).toEqual([]);
    expect(report.counts.survived).toBe(first.counts.survived);
    const warned = events.filter(
      (e) => e.type === "warning" && e.code === "history-identity-scheme-changed",
    );
    expect(warned).toHaveLength(1);
    const [w] = warned;
    const message = w?.type === "warning" ? w.message : "";
    expect(message).toContain(`run ${runId}`);
    expect(message).toContain("identity scheme 1");
  });

  test("history control: the same run under the current scheme IS skipped", async () => {
    const { dirs, store, first, runId } = await oldSchemeRun({ finished: true });
    store.db.run("UPDATE runs SET identity_scheme = ? WHERE id = ?", [IDENTITY_SCHEME, runId]);
    const report = await runSession({
      backend: new CountingBackend("pass"),
      store,
      ...dirs,
      selectorIds,
      skipKnownSurvivors: true,
    });
    expect(report.mutants.filter((m) => m.verdict === "known-survivor")).toHaveLength(
      first.counts.survived,
    );
  });

  test("--resume-run of an old-scheme run is refused by name", async () => {
    const { dirs, store, runId } = await oldSchemeRun({ finished: false });
    await expect(
      runSession({
        backend: new CountingBackend("pass"),
        store,
        ...dirs,
        selectorIds,
        resume: runId,
      }),
    ).rejects.toThrow(
      new RegExp(
        `--resume-run ${runId} was keyed under identity scheme 1.*scheme ${IDENTITY_SCHEME}.*R325`,
      ),
    );
  });

  test("no verdict is carried from an old-scheme run, by any resume path", async () => {
    const { dirs, store, runId } = await oldSchemeRun({ finished: false });
    for (const resume of [runId, "last" as const]) {
      await expect(
        runSession({ backend: new CountingBackend("pass"), store, ...dirs, selectorIds, resume }),
      ).rejects.toThrow();
    }
  });

  test("--resume last names the old-scheme run instead of reporting none found", async () => {
    const { dirs, store, runId } = await oldSchemeRun({ finished: false });
    await expect(
      runSession({
        backend: new CountingBackend("pass"),
        store,
        ...dirs,
        selectorIds,
        resume: "last",
      }),
    ).rejects.toThrow(new RegExp(`run ${runId}, .*identity scheme 1.*R325`));
  });

  test("the fingerprint always carries the scheme", () => {
    const base: SessionFingerprintInput = {
      projectDir: "/p",
      testDir: "/t",
      backend: "bcdev",
      skipKnownSurvivors: false,
      selectorIds: { selectorId: 1, controlId: 2, tableId: 3 },
      identityScheme: 2,
    };
    expect(sessionFingerprint(base)).not.toBe(sessionFingerprint({ ...base, identityScheme: 1 }));
    // The digest every store recorded before R325 for this input. A scheme-2 build must never
    // produce it, even with every optional input absent.
    expect(sessionFingerprint(base)).not.toBe(
      "16c632acfe397d6df9ac6b53795b6361a861c285c6c079bd73f6e79819929307",
    );
  });

  test("marks: a mark made under another scheme is stale, never matched", async () => {
    const dirs = await makeProject();
    const first = await runSession({
      backend: new CountingBackend("pass"),
      store: new ResultsStore(":memory:"),
      ...dirs,
      selectorIds,
    });
    const survivor = first.mutants.find((m) => m.verdict === "survived");
    if (survivor === undefined) throw new Error("the fixture must produce a survivor");
    const key = serializeKey({
      astHash: survivor.astHash,
      codeunitName: survivor.codeunitName,
      procedureName: survivor.procedureName ?? "",
      operatorName: survivor.operatorName,
      operatorMajor: survivor.operatorMajor,
      ordinal: survivor.identityOrdinal ?? 0,
    });
    // R443: the mark carries the numbering digest of the run it was made from (rule 1).
    const numberingDigest = first.numberingDigest;
    if (numberingDigest === undefined) throw new Error("the report records no numbering digest");
    const run = async (identityScheme: number) => {
      const events: RunEvent[] = [];
      const report = await runSession({
        backend: new CountingBackend("pass"),
        store: new ResultsStore(":memory:"),
        ...dirs,
        selectorIds,
        equivalenceMarks: [{ key, reason: "same either way", identityScheme, numberingDigest }],
        emit: [(e) => events.push(e)],
      });
      return { report, events };
    };
    const old = await run(1);
    expect(old.report.readerMarkedEquivalent?.matched).toEqual([]);
    expect(old.report.readerMarkedEquivalent?.contradicted).toEqual([]);
    expect(old.report.readerMarkedEquivalent?.stale).toEqual([key]);
    expect(old.report.mutants.some((m) => m.readerMark !== undefined)).toBe(false);
    expect(
      old.events.filter(
        (e) => e.type === "warning" && e.code === "equivalence-marks-identity-scheme",
      ),
    ).toHaveLength(1);
    // Control: the same mark under the current scheme matches.
    const current = await run(IDENTITY_SCHEME);
    expect(current.report.readerMarkedEquivalent?.matched.map((m) => m.key)).toEqual([key]);
    expect(
      current.events.some(
        (e) => e.type === "warning" && e.code === "equivalence-marks-identity-scheme",
      ),
    ).toBe(false);
  });
});

describe("R354: no verdict crosses a coverage-mode change", () => {
  /** A run recorded under `mode`: finished, or aborted after one mutant (so it stays resumable). */
  async function recordedRun(mode: CoverageMode, opts: { finished: boolean }) {
    const dirs = await makeProject();
    const store = new ResultsStore(":memory:");
    const first = await runSession({
      backend: new CountingBackend("pass", opts.finished ? undefined : 1, undefined, false, mode),
      store,
      ...dirs,
      selectorIds,
    });
    const run = store.db.query("SELECT id, backend, coverage_mode FROM runs").get() as {
      id: number;
      backend: string;
      coverage_mode: string | null;
    };
    // The run records the mode it measured under.
    expect(run.coverage_mode).toBe(mode);
    return { dirs, store, first, runId: run.id, backend: run.backend };
  }

  /** Relabels a run as one measured under `mode` (NULL: from before R354), fingerprint included,
   *  exactly as a run of that mode (or of a pre-R354 build, whose digest had no mode) wrote it. */
  function relabel(
    store: ResultsStore,
    run: { dirs: { projectDir: string; testDir: string }; runId: number; backend: string },
    mode: CoverageMode | null,
  ) {
    const fingerprint = sessionFingerprint({
      projectDir: run.dirs.projectDir,
      testDir: run.dirs.testDir,
      backend: run.backend,
      skipKnownSurvivors: false,
      selectorIds,
      identityScheme: IDENTITY_SCHEME,
      ...(mode !== null ? { coverageMode: mode } : {}),
    });
    store.db.run("UPDATE runs SET coverage_mode = ?, config_fingerprint = ? WHERE id = ?", [
      mode,
      fingerprint,
      run.runId,
    ]);
  }

  const session = (
    r: { dirs: Awaited<ReturnType<typeof makeProject>>; store: ResultsStore },
    mode: CoverageMode,
    extra: { resume?: number | "last"; skipKnownSurvivors?: boolean; emit?: RunEvent[] } = {},
  ) => {
    const backend = new CountingBackend("pass", undefined, undefined, false, mode);
    const events = extra.emit;
    return {
      backend,
      run: runSession({
        backend,
        store: r.store,
        ...r.dirs,
        selectorIds,
        ...(extra.resume !== undefined ? { resume: extra.resume } : {}),
        ...(extra.skipKnownSurvivors !== undefined
          ? { skipKnownSurvivors: extra.skipKnownSurvivors }
          : {}),
        ...(events !== undefined ? { emit: [(e: RunEvent) => events.push(e)] } : {}),
      }),
    };
  };

  const warningsOf = (events: readonly RunEvent[]) =>
    events.flatMap((e) =>
      e.type === "warning" && e.code === "history-coverage-mode-changed" ? [e.message] : [],
    );

  for (const [from, to] of [
    ["none", "procedure"],
    ["procedure", "none"],
  ] as const) {
    describe(`coverage ${from} to ${to}`, () => {
      test("--resume-run is refused by name", async () => {
        const r = await recordedRun(from, { finished: false });
        await expect(session(r, to, { resume: r.runId }).run).rejects.toThrow(
          new RegExp(
            `^--resume-run ${r.runId} was measured under coverage mode ${from}, but this session measures under coverage mode ${to}\\. .*\\(R354\\)\\. Drop --resume-run to run from scratch\\.$`,
          ),
        );
      });

      test("--resume last is refused, naming the run", async () => {
        const r = await recordedRun(from, { finished: false });
        await expect(session(r, to, { resume: "last" }).run).rejects.toThrow(
          new RegExp(
            `^--resume found an unfinished run for this project and backend, run ${r.runId}, but it was measured under coverage mode ${from}, and this session measures under coverage mode ${to}\\. .*\\(R354\\)`,
          ),
        );
      });

      test("history skips nothing and warns once", async () => {
        const r = await recordedRun(from, { finished: true });
        expect(r.first.counts.survived).toBeGreaterThan(0);
        const events: RunEvent[] = [];
        const s = session(r, to, { skipKnownSurvivors: true, emit: events });
        const report = await s.run;
        expect(report.mutants.filter((m) => m.verdict === "known-survivor")).toEqual([]);
        expect(s.backend.mutantRuns).toBeGreaterThanOrEqual(report.mutants.length);
        const warned = warningsOf(events);
        expect(warned).toHaveLength(1);
        expect(warned[0]).toContain(`run ${r.runId}`);
        expect(warned[0]).toContain(`coverage mode ${from}`);
        expect(warned[0]).toContain(`coverage mode ${to}`);
        expect(warned[0]).toContain("R354");
      });
    });
  }

  for (const mode of ["none", "procedure"] as const) {
    describe(`control, same mode (${mode})`, () => {
      test("--resume-run carries", async () => {
        const r = await recordedRun(mode, { finished: false });
        const s = session(r, mode, { resume: r.runId });
        const report = await s.run;
        expect(report.mutants.filter((m) => m.carried === true).length).toBeGreaterThan(0);
      });

      test("--resume last carries", async () => {
        const r = await recordedRun(mode, { finished: false });
        const s = session(r, mode, { resume: "last" });
        const report = await s.run;
        expect(report.resumedFrom?.runId).toBe(r.runId);
        expect(report.mutants.filter((m) => m.carried === true).length).toBeGreaterThan(0);
      });

      test("history skips the survivors, and does not warn", async () => {
        const r = await recordedRun(mode, { finished: true });
        const events: RunEvent[] = [];
        const report = await session(r, mode, { skipKnownSurvivors: true, emit: events }).run;
        expect(report.mutants.filter((m) => m.verdict === "known-survivor")).toHaveLength(
          r.first.counts.survived,
        );
        expect(warningsOf(events)).toEqual([]);
      });
    });
  }

  test("fenced against procedure is a change: every path refuses", async () => {
    const open = await recordedRun("procedure", { finished: false });
    relabel(open.store, open, "fenced");
    await expect(session(open, "procedure", { resume: open.runId }).run).rejects.toThrow(
      new RegExp(
        `--resume-run ${open.runId} was measured under coverage mode fenced, but this session measures under coverage mode procedure\\..*R354`,
      ),
    );
    await expect(session(open, "procedure", { resume: "last" }).run).rejects.toThrow(
      new RegExp(`run ${open.runId}, but it was measured under coverage mode fenced.*R354`),
    );
    const done = await recordedRun("procedure", { finished: true });
    relabel(done.store, done, "fenced");
    const events: RunEvent[] = [];
    const report = await session(done, "procedure", { skipKnownSurvivors: true, emit: events }).run;
    expect(report.mutants.filter((m) => m.verdict === "known-survivor")).toEqual([]);
    expect(warningsOf(events)).toHaveLength(1);
  });

  test("a run from before R354 (no recorded mode) never carries, on any path", async () => {
    const open = await recordedRun("procedure", { finished: false });
    relabel(open.store, open, null);
    await expect(session(open, "procedure", { resume: open.runId }).run).rejects.toThrow(
      new RegExp(
        `--resume-run ${open.runId} was measured under an unrecorded coverage mode \\(the run predates R354\\), but this session measures under coverage mode procedure\\.`,
      ),
    );
    await expect(session(open, "procedure", { resume: "last" }).run).rejects.toThrow(
      new RegExp(
        `run ${open.runId}, but it was measured under an unrecorded coverage mode \\(the run predates R354\\)`,
      ),
    );
    const done = await recordedRun("procedure", { finished: true });
    relabel(done.store, done, null);
    const events: RunEvent[] = [];
    const report = await session(done, "procedure", { skipKnownSurvivors: true, emit: events }).run;
    expect(report.mutants.filter((m) => m.verdict === "known-survivor")).toEqual([]);
    const warned = warningsOf(events);
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain("an unrecorded coverage mode (the run predates R354)");
  });

  // The history filter runs once per batch, so the warning's once-per-session guard is only
  // exercised with two batches: each would otherwise warn.
  test("history across a mode change warns exactly once over two batches", async () => {
    const dirs = await makeProject({ secondFile: true });
    const store = new ResultsStore(":memory:");
    const first = await runSession({
      backend: new CountingBackend("pass", undefined, undefined, false, "none"),
      store,
      ...dirs,
      selectorIds,
      maxGuardsPerBatch: 1,
    });
    expect(first.batches).toBe(2);
    expect(first.counts.survived).toBeGreaterThan(0);
    const events: RunEvent[] = [];
    const report = await runSession({
      backend: new CountingBackend("pass", undefined, undefined, false, "procedure"),
      store,
      ...dirs,
      selectorIds,
      maxGuardsPerBatch: 1,
      skipKnownSurvivors: true,
      emit: [(e) => events.push(e)],
    });
    expect(report.batches).toBe(2);
    expect(report.mutants.filter((m) => m.verdict === "known-survivor")).toEqual([]);
    expect(warningsOf(events)).toHaveLength(1);
  });

  // Run 002: a resumed batch with work left may reuse a baseline snapshot, found by its source and
  // test-app hashes from ANY run. A newer run under another mode on the same source records one
  // too; it must not be used, or the resumed run selects its mutants' tests with that mode's
  // baseline and coverage. Run A (mode `a`) aborts in batch 1 after its baseline, run B (mode `b`)
  // finishes on the same source, then A resumes: batch 1 reuses A's own snapshot, never B's.
  for (const [a, b] of [
    ["procedure", "none"],
    ["none", "procedure"],
  ] as const) {
    test(`a resumed ${a} run never reuses a newer ${b} run's baseline snapshot`, async () => {
      const dirs = await makeProject({ secondFile: true });
      const store = new ResultsStore(":memory:");
      const runA = await runSession({
        backend: new CountingBackend("pass", undefined, 2, false, a),
        store,
        ...dirs,
        selectorIds,
        maxGuardsPerBatch: 1,
      });
      expect(runA.quarantined).toBeDefined();
      const runB = await runSession({
        backend: new CountingBackend("pass", undefined, undefined, false, b),
        store,
        ...dirs,
        selectorIds,
        maxGuardsPerBatch: 1,
      });
      expect(runB.quarantined).toBeUndefined();
      const ids = store.db.query("SELECT id, coverage_mode FROM runs ORDER BY id").all() as Array<{
        id: number;
        coverage_mode: string;
      }>;
      expect(ids.map((r) => r.coverage_mode)).toEqual([a, b]);
      const [idA, idB] = ids.map((r) => r.id);
      if (idA === undefined || idB === undefined) throw new Error("two runs expected");
      // B's snapshot for batch 1 exists and is the newer one: the unguarded query returns it.
      const snaps = store.db
        .query("SELECT run_id FROM baseline_snapshots WHERE batch_index = 1 ORDER BY id")
        .all() as Array<{ run_id: number }>;
      expect(snaps.map((s) => s.run_id)).toEqual([idA, idB]);

      const events: RunEvent[] = [];
      const resumed = await runSession({
        backend: new CountingBackend("pass", undefined, undefined, false, a),
        store,
        ...dirs,
        selectorIds,
        maxGuardsPerBatch: 1,
        resume: "last",
        emit: [(e) => events.push(e)],
      });
      expect(resumed.resumedFrom?.runId).toBe(idA);
      const reused = events.flatMap((e) =>
        e.type === "warning" && e.code === "resume-baseline-reused" ? [e.message] : [],
      );
      expect(reused).toHaveLength(1);
      expect(reused[0]).toContain(`same as run ${idA}'s batch 1`);
      expect(reused[0]).not.toContain(`run ${idB}'s`);
    });
  }

  // R252's shape `explain` refuses: a survivor with no attribution in a coverage-on report. A
  // resume from a coverage-off run is where one would come from: R192 records a batch whose every
  // mutant carries with the PRIOR run's attribution, which coverage off never set. So batch 0 is
  // scored in full under coverage off and batch 1 aborts, leaving a fully carryable batch.
  test("a resumed coverage-on report never carries an unattributed survivor", async () => {
    const dirs = await makeProject({ secondFile: true });
    const store = new ResultsStore(":memory:");
    const first = await runSession({
      backend: new CountingBackend("pass", undefined, 2, true, "none"),
      store,
      ...dirs,
      selectorIds,
      maxGuardsPerBatch: 1,
    });
    const offSurvivors = first.mutants.filter(
      (m) => m.batchIndex === 0 && m.verdict === "survived",
    );
    expect(offSurvivors.length).toBeGreaterThan(0);
    expect(offSurvivors.every((m) => m.coverageAttribution === undefined)).toBe(true);
    const r = { dirs, store };
    const onBackend = new CountingBackend("pass", undefined, undefined, true, "procedure");
    const attempt: SessionReport | Error = await runSession({
      backend: onBackend,
      store,
      ...dirs,
      selectorIds,
      maxGuardsPerBatch: 1,
      resume: "last",
    }).then(
      (report) => report,
      (err: unknown) => (err instanceof Error ? err : new Error(String(err))),
    );
    // Refused before anything ran: no deploy, no baseline, no mutant, so nothing was carried.
    expect(attempt).toBeInstanceOf(Error);
    expect([onBackend.deploys, onBackend.baselineRuns, onBackend.mutantRuns]).toEqual([0, 0, 0]);
    expect(attempt instanceof Error ? attempt.message : "").toMatch(
      /^--resume found an unfinished run for this project and backend, run \d+, but it was measured under coverage mode none, and this session measures under coverage mode procedure\. .*\(R354\)\. Drop --resume to run from scratch\.$/,
    );
    // Run fresh instead, as the refusal says: every survivor is attributed.
    const fresh = await session(r, "procedure").run;
    expect(fresh.coverageMode).toBe("procedure");
    const survivors = fresh.mutants.filter((m) => m.verdict === "survived");
    expect(survivors.length).toBeGreaterThan(0);
    expect(survivors.filter((m) => m.coverageAttribution === undefined)).toEqual([]);
    expect(fresh.mutants.some((m) => m.carried === true)).toBe(false);
  });
});

/** R318: a target whose public split member is renamed by its `#if` arms, and one test. */
const R318_TARGET = `codeunit 79000 "Repro R"
{
#if R318A
    procedure Pick(X: Integer): Integer
#else
    procedure Choose(X: Integer): Integer
#endif
    var
        K: Integer;
    begin
        K := 1;
        if X > 1 then
            Glob := X + 1;
        Glob := Glob + 2;
        exit(Glob + K);
    end;

    procedure Plain(X: Integer): Integer
    begin
        exit(X + 3);
    end;

    var
        Glob: Integer;
}
`;
const R318_TESTS = `codeunit 79100 "Repro Tests"
{
    Subtype = Test;

    [Test]
    procedure PickFive()
    begin
    end;
}
`;

/**
 * R318: a backend whose BASELINE coverage names the renamed member the way a pre-R318 line map
 * did (`pre`: an object-level row, no procedure, which is what an unmapped line becomes) or the way
 * R318's does (`post`: `Pick`), or as al-runner's server leg did before R318 (`choose`: the
 * renamed member's statements under `Choose`, the compiled arm's name). Every mutant run returns
 * `mutantOutcome` (default `fail`, a kill) and attests on the
 * `coverage: "none"` runs, as CountingBackend does (without it the attestation gate discards every
 * verdict). `abortAfter` strands the run the way CountingBackend's does, so it stays resumable.
 */
class R318Backend implements ExecutionBackend {
  baselineRuns = 0;
  mutantRuns = 0;
  private activations: Array<string | null> = [];
  constructor(
    private readonly naming: "pre" | "post" | "choose",
    private readonly abortAfter?: number,
    private readonly mutantOutcome: "fail" | "pass" = "fail",
  ) {}
  // R495: a served test app, installed, so the run's identity is proven (as a real bcdev's is).
  private readonly testApp = servesTestApp();
  fetchPublishedAppPackage = this.testApp.fetchPublishedAppPackage;
  microsoftMode = this.testApp.microsoftMode;
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
  async run(ref: TestMethodRef, opts: RunOpts): Promise<TestVerdict> {
    const active = this.activations.at(-1) ?? null;
    const attest =
      opts.coverage === "none"
        ? { attestation: { observedAny: true, identityMismatch: false } }
        : {};
    if (active === null) {
      this.baselineRuns += 1;
      const member =
        this.naming === "pre"
          ? { objectType: "Codeunit", objectId: 79000 }
          : {
              objectType: "Codeunit",
              objectId: 79000,
              procedure: this.naming === "choose" ? "Choose" : "Pick",
            };
      return {
        ref,
        outcome: "pass",
        durationMs: 5,
        coverage: {
          granularity: "procedure" as const,
          entries: [member, { objectType: "Codeunit", objectId: 79000, procedure: "Plain" }],
        },
      };
    }
    this.mutantRuns += 1;
    if (this.abortAfter !== undefined && this.mutantRuns > this.abortAfter) {
      return {
        ref,
        ...attest,
        outcome: "error",
        durationMs: 5,
        operation: "in-flight-unknown",
        failureMessage: "RunMutant timed out: AbortError",
      };
    }
    return this.mutantOutcome === "pass"
      ? { ref, ...attest, outcome: "pass", durationMs: 5 }
      : { ref, ...attest, outcome: "fail", durationMs: 5, failureMessage: "killed" };
  }
}

describe("R318: a resume across R318 re-scores a renamed member instead of keeping no-coverage", () => {
  test("carriedVerdictFor: a no-coverage row does not carry onto a mutant with coverageArmNames", () => {
    const index = sameSource(
      buildResumeIndex([row({ astHash: "h-r", procedureName: "", verdict: "no-coverage" })], false),
    );
    const base = { ...manifestEntry("h-r"), procedureName: "" };
    expect(
      carriedVerdictFor(index, { ...base, coverageArmNames: ["Pick", "Choose"] }),
    ).toBeUndefined();
    // R621: since then a stored no-coverage never carries onto ANY mutant (it is re-derived), so
    // the entry without the field gets none either. Control: a kill on a renamed member still
    // carries (a kill is a measurement whatever attributed it).
    expect(carriedVerdictFor(index, base)).toBeUndefined();
    const killed = sameSource(
      buildResumeIndex([row({ astHash: "h-k", procedureName: "", verdict: "killed" })], false),
    );
    expect(
      carriedVerdictFor(killed, {
        ...manifestEntry("h-k"),
        procedureName: "",
        coverageArmNames: ["Pick"],
      })?.verdict,
    ).toBe("killed");
  });

  test("runSession: the member is scored exact against a FRESH baseline, not carried or snapshot-reused", async () => {
    const root = scratch("lethal-r318-resume-");
    const dirs = {
      projectDir: join(root, "app"),
      testDir: join(root, "tests"),
      instrumentedDir: join(root, "instr"),
    };
    await Bun.write(join(dirs.projectDir, "Repro.Codeunit.al"), R318_TARGET);
    await Bun.write(join(dirs.projectDir, "app.json"), APP_JSON);
    await Bun.write(join(dirs.testDir, "ReproTests.Codeunit.al"), R318_TESTS);
    await Bun.write(join(dirs.testDir, "app.json"), testAppJson());
    const store = new ResultsStore(":memory:");

    // Run 1 sees the member as a pre-R318 line map did: its 10 mutants read no-coverage, Plain's
    // first two are killed and its third strands, so the run stays resumable. Its completed
    // baseline is recorded as a snapshot. MEASURED at HEAD b6562aba (R-318 plan scratch): with
    // abortAfter 2, run 2 replays the WHOLE batch from the store (batchCarriesEntirely), the 10
    // member mutants carried as no-coverage, 0 baseline runs, 0 mutant runs. So this one shape
    // exercises both guards: guard 1 stops the replay, and guard 2 then stops the snapshot reuse.
    // (Since R621 guard 1 is the general rule: no stored no-coverage carries at all.)
    const first = new R318Backend("pre", 2);
    const firstReport = await runSession({ backend: first, store, ...dirs, selectorIds });
    expect(firstReport.quarantined).toBeDefined();
    const inMember = (r: typeof firstReport) =>
      r.mutants.filter((m) => m.line >= 3 && m.line <= 16);
    expect(inMember(firstReport).map((m) => m.verdict)).toEqual(Array(10).fill("no-coverage"));

    const second = new R318Backend("post");
    const report = await runSession({
      backend: second,
      store,
      ...dirs,
      selectorIds,
      resume: "last",
    });
    expect(report.resumedFrom?.runId).toBeGreaterThan(0);
    // Guard 2: the snapshot recorded by run 1 was NOT reused; this session ran its own baseline.
    expect(second.baselineRuns).toBeGreaterThan(0);
    // Guard 1 and 2 together: every member mutant was scored now, exact, never carried.
    const member = inMember(report);
    expect(member).toHaveLength(10);
    for (const m of member) {
      expect([m.line, m.verdict]).toEqual([m.line, "killed"]);
      expect(m.coverageAttribution).toBe("exact");
      expect(m.carried).not.toBe(true);
    }
  });
});

/** R318: `r3`'s target with the renamed member and the `#if`-wrapped `Choose(T)`, one test. */
const R318_R3_TARGET = `codeunit 79000 "Repro R"
{
#if R318A
    procedure Pick(X: Integer): Integer
#else
    procedure Choose(X: Integer): Integer
#endif
    var
        K: Integer;
    begin
        K := 1;
        if X > 1 then
            Glob := X + 1;
        Glob := Glob + 2;
        exit(Glob + K);
    end;

#if R318A
    procedure Choose(T: Text): Integer
    begin
        exit(StrLen(T) + 1);
    end;
#endif

    procedure Plain(X: Integer): Integer
    begin
        exit(X + 3);
    end;

    var
        Glob: Integer;
}
`;

/**
 * R318: `r3` build `[]` as al-runner's server leg named it BEFORE R318 (`choose`: the renamed
 * member's statements under `Choose`) or AFTER (`post`: re-keyed by position to `Pick`). Every
 * mutant run passes, so a covered mutant survives.
 */
const r3Backend = (naming: "choose" | "post", abortAfter?: number) =>
  new R318Backend(naming, abortAfter, "pass");

// R318 (review r2, C2 and I3): R318 moves no key tuple, but it changes the verdict an unchanged key
// can carry, so it bumps IDENTITY_SCHEME and R325's refusals retire every verdict attributed the
// old way. The key used throughout is the #if-wrapped Choose(T)'s (lines 19-23): `survived` under
// the old naming, `no-coverage` under the new one. Each path has a control at the CURRENT scheme,
// which shows the false verdict the bump prevents. Pinned to IDENTITY_SCHEME and
// IDENTITY_SCHEME - 1, never to literals, so a later bump does not silently re-aim them.
describe("R318: the scheme bump retires verdicts attributed the old way", () => {
  const wrappedOf = (r: {
    mutants: readonly { line: number; verdict: string; carried?: boolean }[];
  }) =>
    r.mutants
      .filter((m) => m.line >= 19 && m.line <= 23)
      .map((m) => `${m.line}:${m.verdict}${m.carried === true ? ":carried" : ""}`);

  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) removeScratchDir(root);
  });

  // R214: the code under test sits in #if R318A; the build defines R318A, so its arm is live (orchestrator ruling q-20260930T055856).
  /** A run under the OLD naming, relabelled to `scheme` with the fingerprint that scheme computes. */
  async function oldNamingRun(scheme: number, finished: boolean) {
    const root = scratch("lethal-r318-scheme-");
    roots.push(root);
    const dirs = {
      projectDir: join(root, "app"),
      testDir: join(root, "tests"),
      instrumentedDir: join(root, "instr"),
    };
    await Bun.write(join(dirs.projectDir, "Repro.Codeunit.al"), R318_R3_TARGET);
    await Bun.write(join(dirs.projectDir, "app.json"), APP_JSON);
    await Bun.write(join(dirs.testDir, "ReproTests.Codeunit.al"), R318_TESTS);
    await Bun.write(join(dirs.testDir, "app.json"), testAppJson());
    const store = new ResultsStore(":memory:");
    const first = await runSession({
      backend: r3Backend("choose", finished ? undefined : 2),
      store,
      ...dirs,
      selectorIds,
      preprocessorSymbols: ["R318A"],
    });
    expect(wrappedOf(first)).toEqual(["20:survived", "21:survived"]);
    const run = store.db.query("SELECT id, backend FROM runs").get() as {
      id: number;
      backend: string;
    };
    const fingerprint = sessionFingerprint({
      projectDir: dirs.projectDir,
      testDir: dirs.testDir,
      backend: run.backend,
      skipKnownSurvivors: false,
      selectorIds,
      identityScheme: scheme,
      // R354: what runSession computes: it always passes the mode, here the backend's.
      coverageMode: "procedure",
      preprocessorSymbols: ["R318A"],
      // R403: no `testBuildSymbols`: no test file here holds a directive line, so runSession omits it.
    });
    store.db.run("UPDATE runs SET identity_scheme = ?, config_fingerprint = ? WHERE id = ?", [
      scheme,
      fingerprint,
      run.id,
    ]);
    return { dirs, store, first, runId: run.id };
  }

  // R214: the code under test sits in #if R318A; the build defines R318A, so its arm is live (orchestrator ruling q-20260930T055856).
  test("history: a previous-scheme survivor is executed, and reads no-coverage", async () => {
    const { dirs, store, runId } = await oldNamingRun(IDENTITY_SCHEME - 1, true);
    const events: RunEvent[] = [];
    const report = await runSession({
      backend: r3Backend("post"),
      store,
      ...dirs,
      selectorIds,
      preprocessorSymbols: ["R318A"],
      skipKnownSurvivors: true,
      emit: [(e) => events.push(e)],
    });
    expect(wrappedOf(report)).toEqual(["20:no-coverage", "21:no-coverage"]);
    const warned = events.filter(
      (e) => e.type === "warning" && e.code === "history-identity-scheme-changed",
    );
    expect(warned).toHaveLength(1);
    expect(warned[0]?.type === "warning" ? warned[0].message : "").toContain(`run ${runId}`);
  });

  // R214: the code under test sits in #if R318A; the build defines R318A, so its arm is live (orchestrator ruling q-20260930T055856).
  test("history control: at the current scheme the old survivor IS skipped (the false verdict)", async () => {
    const { dirs, store } = await oldNamingRun(IDENTITY_SCHEME, true);
    const events: RunEvent[] = [];
    const report = await runSession({
      backend: r3Backend("post"),
      store,
      ...dirs,
      selectorIds,
      preprocessorSymbols: ["R318A"],
      skipKnownSurvivors: true,
      emit: [(e) => events.push(e)],
    });
    expect(wrappedOf(report)).toEqual(["20:known-survivor", "21:known-survivor"]);
    expect(
      events.filter((e) => e.type === "warning" && e.code === "history-identity-scheme-changed"),
    ).toHaveLength(0);
  });

  // R214: the code under test sits in #if R318A; the build defines R318A, so its arm is live (orchestrator ruling q-20260930T055856).
  test("--resume-run: a previous-scheme run is refused by name", async () => {
    const { dirs, store, runId } = await oldNamingRun(IDENTITY_SCHEME - 1, false);
    await expect(
      runSession({
        backend: r3Backend("post"),
        store,
        ...dirs,
        selectorIds,
        preprocessorSymbols: ["R318A"],
        resume: runId,
      }),
    ).rejects.toThrow(
      new RegExp(
        `--resume-run ${runId} was keyed under identity scheme ${IDENTITY_SCHEME - 1}.*scheme ${IDENTITY_SCHEME}.*R325`,
      ),
    );
  });

  // R214: the code under test sits in #if R318A; the build defines R318A, so its arm is live (orchestrator ruling q-20260930T055856).
  test("--resume-run control: at the current scheme the same run resumes", async () => {
    const { dirs, store, runId } = await oldNamingRun(IDENTITY_SCHEME, false);
    const report = await runSession({
      backend: r3Backend("post"),
      store,
      ...dirs,
      selectorIds,
      preprocessorSymbols: ["R318A"],
      resume: runId,
    });
    expect(report.resumedFrom?.runId).toBe(runId);
  });

  // R214: the code under test sits in #if R318A; the build defines R318A, so its arm is live (orchestrator ruling q-20260930T055856).
  test("--resume last: a previous-scheme run is named and refused", async () => {
    const { dirs, store, runId } = await oldNamingRun(IDENTITY_SCHEME - 1, false);
    await expect(
      runSession({
        backend: r3Backend("post"),
        store,
        ...dirs,
        selectorIds,
        preprocessorSymbols: ["R318A"],
        resume: "last",
      }),
    ).rejects.toThrow(new RegExp(`run ${runId}, .*identity scheme ${IDENTITY_SCHEME - 1}.*R325`));
  });

  // R214: the code under test sits in #if R318A; the build defines R318A, so its arm is live (orchestrator ruling q-20260930T055856).
  test("--resume last control: at the current scheme the same run resumes", async () => {
    const { dirs, store, runId } = await oldNamingRun(IDENTITY_SCHEME, false);
    const report = await runSession({
      backend: r3Backend("post"),
      store,
      ...dirs,
      selectorIds,
      preprocessorSymbols: ["R318A"],
      resume: "last",
    });
    expect(report.resumedFrom?.runId).toBe(runId);
  });

  // R214: the code under test sits in #if R318A; the build defines R318A, so its arm is live (orchestrator ruling q-20260930T055856).
  test("marks: a previous-scheme mark on the old survivor is stale, not contradicted", async () => {
    const run = async (identityScheme: number) => {
      const { dirs, first } = await oldNamingRun(identityScheme, true);
      const survivor = first.mutants.find((m) => m.line === 20 && m.verdict === "survived");
      if (survivor === undefined) throw new Error("the old naming must leave Choose(T) surviving");
      const key = serializeKey({
        astHash: survivor.astHash,
        codeunitName: survivor.codeunitName,
        procedureName: survivor.procedureName ?? "",
        operatorName: survivor.operatorName,
        operatorMajor: survivor.operatorMajor,
        ordinal: survivor.identityOrdinal ?? 0,
      });
      const report = await runSession({
        backend: r3Backend("post"),
        store: new ResultsStore(":memory:"),
        ...dirs,
        selectorIds,
        preprocessorSymbols: ["R318A"],
        // R214: the mark names the build's symbols, so only its scheme can make it stale. R443:
        // and the numbering digest of the run it was made from, so it matches by key.
        equivalenceMarks: [
          {
            key,
            reason: "same either way",
            identityScheme,
            preprocessorSymbols: ["R318A"],
            ...(first.numberingDigest !== undefined
              ? { numberingDigest: first.numberingDigest }
              : {}),
          },
        ],
      });
      return { key, marked: report.readerMarkedEquivalent };
    };
    const old = await run(IDENTITY_SCHEME - 1);
    expect(old.marked?.stale).toEqual([old.key]);
    expect(old.marked?.contradicted).toEqual([]);
    // Control: at the current scheme the same mark is reported CONTRADICTED by a no-coverage,
    // although no test killed the mutant. That is the false claim the bump prevents.
    const current = await run(IDENTITY_SCHEME);
    expect(current.marked?.stale).toEqual([]);
    expect(current.marked?.contradicted.map((c) => [c.key, c.verdict])).toEqual([
      [current.key, "no-coverage"],
    ]);
  });
});
describe("R247: no verdict crosses a test-app change", () => {
  /** A bcdev-shaped backend: the server holds a test-app package, read by `fetchPublishedAppPackage`.
   *  `{ unread }` is a failed read (identity unknown). */
  class PackageBackend extends CountingBackend {
    constructor(pkg: Uint8Array | PackageUnread, abortFromDeploy?: number) {
      super("pass", undefined, abortFromDeploy);
      // R495: served, and installed at its own version (CountingBackend's microsoftMode).
      this.served = pkg;
    }
  }
  /** Two packages that differ ONLY in the version stamp, as a re-stamp-only republish produces. */
  const pkg = (version: string) => testAppPackage(version);
  const APP_A = pkg("1.0.0.0");
  const APP_B = pkg("1.0.0.1");
  const hashOf = (b: Uint8Array) => `package:${Bun.SHA256.hash(b, "hex")}`;

  /** Batch 0 fully scored, batch 1 aborted: an unfinished run holding a whole carried batch
   *  (R192's shape). With `finished`, a completed run. */
  async function recorded(app: Uint8Array, opts: { finished: boolean }) {
    const dirs = await makeProject({ secondFile: true });
    // The test app's own app.json names the package the backend is asked for.
    await Bun.write(
      join(dirs.testDir, "app.json"),
      JSON.stringify({ name: "Sandbox Tests", publisher: "LethAL", version: "1.0.0.0" }),
    );
    const store = new ResultsStore(":memory:");
    const first = await runSession({
      backend: new PackageBackend(app, opts.finished ? undefined : 2),
      store,
      ...dirs,
      selectorIds,
      maxGuardsPerBatch: 1,
    });
    const run = store.db.query("SELECT id, test_app_hash FROM runs").get() as {
      id: number;
      test_app_hash: string | null;
    };
    // The run records the test app it measured against.
    expect(run.test_app_hash).toBe(hashOf(app));
    return { dirs, store, first, runId: run.id };
  }

  const again = (
    r: Awaited<ReturnType<typeof recorded>>,
    backend: CountingBackend,
    extra: { resume?: number | "last"; skipKnownSurvivors?: boolean; events?: RunEvent[] } = {},
  ) => {
    const events = extra.events;
    return runSession({
      backend,
      store: r.store,
      ...r.dirs,
      selectorIds,
      maxGuardsPerBatch: 1,
      ...(extra.resume !== undefined ? { resume: extra.resume } : {}),
      ...(extra.skipKnownSurvivors !== undefined
        ? { skipKnownSurvivors: extra.skipKnownSurvivors }
        : {}),
      ...(events !== undefined ? { emit: [(e: RunEvent) => events.push(e)] } : {}),
    });
  };

  for (const mode of ["run", "last"] as const) {
    describe(`--resume ${mode}`, () => {
      const target = (runId: number) => (mode === "last" ? ("last" as const) : runId);
      const flag = (runId: number) => (mode === "last" ? "--resume" : `--resume-run ${runId}`);

      test("the same test app carries: the fully scored batch is neither deployed nor baselined", async () => {
        const r = await recorded(APP_A, { finished: false });
        const backend = new PackageBackend(APP_A);
        const report = await again(r, backend, { resume: target(r.runId) });
        expect(report.resumedFrom?.runId).toBe(r.runId);
        expect(report.mutants.filter((m) => m.carried === true).length).toBeGreaterThan(0);
        // ONE deploy, batch 1's: batch 0 carried whole (R192) without a deploy or a baseline.
        expect(backend.deploys).toBe(1);
        expect(
          report.mutants.filter((m) => m.carried === true).every((m) => m.batchIndex === 0),
        ).toBe(true);
        const row = r.store.db.query("SELECT test_app_hash FROM runs ORDER BY id DESC").get() as {
          test_app_hash: string | null;
        };
        expect(row.test_app_hash).toBe(hashOf(APP_A));
      });

      test("a republish that only moved the version stamp is refused by name; nothing is deployed or run", async () => {
        const r = await recorded(APP_A, { finished: false });
        const backend = new PackageBackend(APP_B);
        await expect(again(r, backend, { resume: target(r.runId) })).rejects.toThrow(
          new RegExp(
            `^${flag(r.runId)}: run ${r.runId} was measured against test app ${hashOf(APP_A)}, and this session's test app is ${hashOf(APP_B)}\\. .*version stamp.*byte for byte.*\\(R247, R495\\)\\. Drop the resume flag to run from scratch\\.$`,
          ),
        );
        expect(backend.deploys).toBe(0);
        expect(backend.baselineRuns + backend.mutantRuns).toBe(0);
      });

      test("a run from before R247 (NULL) is refused, even against a readable test app", async () => {
        const r = await recorded(APP_A, { finished: false });
        r.store.db.run("UPDATE runs SET test_app_hash = NULL");
        await expect(
          again(r, new PackageBackend(APP_A), { resume: target(r.runId) }),
        ).rejects.toThrow(
          new RegExp(
            `run ${r.runId} was measured against test app unknown \\(it recorded none: its test app was not proven installed, or it ran before R247\\), and this session's test app is ${hashOf(APP_A)}\\..*R247`,
          ),
        );
      });

      test("an unreadable test app this session (unknown) is refused", async () => {
        const r = await recorded(APP_A, { finished: false });
        await expect(
          again(r, new PackageBackend(UNREAD), { resume: target(r.runId) }),
        ).rejects.toThrow(
          new RegExp(
            `run ${r.runId} was measured against test app ${hashOf(APP_A)}, and this session's test app is unknown \\(not proven installed: .*\\)\\..*R247`,
          ),
        );
      });

      test("single carried rows too: a run aborted mid-batch is refused after a test app republish", async () => {
        const dirs = await makeProject();
        const store = new ResultsStore(":memory:");
        await runSession({
          backend: new CountingBackend("pass", 1),
          store,
          ...dirs,
          selectorIds,
        });
        const runId = (store.db.query("SELECT id FROM runs").get() as { id: number }).id;
        // R495: the identity is the served package (a source edit alone changes nothing BC runs).
        const backend = new CountingBackend("pass");
        backend.served = testAppPackage("1.0.0.0", "<!-- republished -->");
        await expect(
          runSession({ backend, store, ...dirs, selectorIds, resume: target(runId) }),
        ).rejects.toThrow(new RegExp(`run ${runId} was measured against test app package:.*R247`));
        expect(backend.mutantRuns + backend.baselineRuns).toBe(0);
      });
    });
  }

  const historyWarnings = (events: readonly RunEvent[]) =>
    events.flatMap((e) =>
      e.type === "warning" && e.code === "history-test-app-changed" ? [e.message] : [],
    );

  test("history across a changed test app skips nothing and warns once over two batches", async () => {
    const r = await recorded(APP_A, { finished: true });
    expect(r.first.counts.survived).toBeGreaterThan(0);
    const events: RunEvent[] = [];
    const report = await again(r, new PackageBackend(APP_B), { skipKnownSurvivors: true, events });
    expect(report.batches).toBe(2);
    expect(report.mutants.filter((m) => m.verdict === "known-survivor")).toEqual([]);
    expect(report.counts.survived).toBe(r.first.counts.survived);
    const warned = historyWarnings(events);
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain(`run ${r.runId}`);
    expect(warned[0]).toContain(hashOf(APP_A));
    expect(warned[0]).toContain(hashOf(APP_B));
    expect(warned[0]).toContain("R247");
  });

  test("history from a run with no recorded test app skips nothing and warns once", async () => {
    const r = await recorded(APP_A, { finished: true });
    r.store.db.run("UPDATE runs SET test_app_hash = NULL");
    const events: RunEvent[] = [];
    const report = await again(r, new PackageBackend(APP_A), { skipKnownSurvivors: true, events });
    expect(report.mutants.filter((m) => m.verdict === "known-survivor")).toEqual([]);
    const warned = historyWarnings(events);
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain("was measured against test app unknown");
  });

  test("history control: the same test app skips the survivors and does not warn", async () => {
    const r = await recorded(APP_A, { finished: true });
    const events: RunEvent[] = [];
    const report = await again(r, new PackageBackend(APP_A), { skipKnownSurvivors: true, events });
    expect(report.mutants.filter((m) => m.verdict === "known-survivor")).toHaveLength(
      r.first.counts.survived,
    );
    expect(historyWarnings(events)).toEqual([]);
  });
});

/**
 * R389 (sol's re-review): the closed-world guard's answer is part of what resume, survivor skips
 * and baseline reuse compare. A real published package (manifest id + the test source) and a
 * counting DependentCount, so the guard actually engages; "0" is closed-world, "1" open.
 */
describe("R389: no verdict or baseline crosses a closed-world guard flip", () => {
  // R495: the id `servedIsInstalled` reports installed, so the run's identity is proven.
  const TEST_ID = TEST_APP.id;
  const PKG = buildFakeAppWithEntries({
    "NavxManifest.xml": `<?xml version="1.0" encoding="utf-8"?><Package xmlns="http://schemas.microsoft.com/navx/2015/manifest"><App Id="${TEST_ID}" Name="Sandbox Tests" Publisher="LethAL" Version="1.0.0.0" /><InternalsVisibleTo /></Package>`,
    "src/SandboxTests.Codeunit.al": TEST_AL,
  });
  /** R601 D2: the same app id and version, other bytes. */
  const PKG_OTHER = buildFakeAppWithEntries({
    "NavxManifest.xml": `<?xml version="1.0" encoding="utf-8"?><Package xmlns="http://schemas.microsoft.com/navx/2015/manifest"><App Id="${TEST_ID}" Name="Sandbox Tests" Publisher="LethAL" Version="1.0.0.0" /><InternalsVisibleTo /></Package>`,
    "src/SandboxTests.Codeunit.al": `${TEST_AL}\n// another build\n`,
  });
  class GuardBackend extends CountingBackend {
    asked = 0;
    constructor(
      private readonly answer: (call: number) => number,
      abortFromDeploy?: number,
    ) {
      super("pass", undefined, abortFromDeploy);
      this.served = PKG;
    }
    async dependentCount(): Promise<number> {
      this.asked += 1;
      return this.answer(this.asked);
    }
  }
  const project = async (secondFile: boolean) => {
    const dirs = await makeProject({ secondFile });
    await Bun.write(
      join(dirs.testDir, "app.json"),
      JSON.stringify({
        id: TEST_ID,
        name: "Sandbox Tests",
        publisher: "LethAL",
        version: "1.0.0.0",
      }),
    );
    return dirs;
  };
  const session = (
    dirs: Awaited<ReturnType<typeof project>>,
    store: ResultsStore,
    backend: CountingBackend,
    extra: Partial<Parameters<typeof runSession>[0]> = {},
  ) => runSession({ backend, store, ...dirs, selectorIds, maxGuardsPerBatch: 1, ...extra });
  const hashes = (store: ResultsStore) =>
    (
      store.db.query("SELECT test_app_hash AS h FROM runs ORDER BY id").all() as { h: string }[]
    ).map((r) => r.h);
  /** R496: the first run's recorded dependency fingerprint, required (a proven identity has one). */
  const runDeps = (store: ResultsStore): string => {
    const d = (
      store.db.query("SELECT test_app_deps AS d FROM runs ORDER BY id LIMIT 1").get() as {
        d: string | null;
      }
    ).d;
    if (d === null) throw new Error("the run recorded no test-app dependencies");
    return d;
  };
  const FLIPS = [
    [0, 1],
    [1, 0],
  ] as const;
  const SAME = [
    [0, 0],
    [1, 1],
  ] as const;

  for (const [a, b] of [...FLIPS, ...SAME]) {
    const flip = a !== b;
    test(`--resume: recorded with count ${a}, resumed with ${b}: ${flip ? "refused, nothing runs" : "carries"}`, async () => {
      const dirs = await project(true);
      const store = new ResultsStore(":memory:");
      const first = new GuardBackend(() => a, 2); // batch 1 aborts on its first mutant
      expect((await session(dirs, store, first)).quarantined).toBeDefined();
      expect(first.asked).toBe(a === 0 ? 2 : 1); // closed: before and after; open: once
      const second = new GuardBackend(() => b);
      const resumed = session(dirs, store, second, { resume: "last" });
      if (flip) {
        await expect(resumed).rejects.toThrow(/R247/);
        expect(second.deploys + second.baselineRuns + second.mutantRuns).toBe(0);
      } else {
        const report = await resumed;
        expect(report.mutants.filter((m) => m.carried === true).length).toBeGreaterThan(0);
      }
      store.close();
    });

    test(`--skip-known-survivors: recorded with count ${a}, then ${b}: ${flip ? "skips nothing" : "skips the survivors"}`, async () => {
      const dirs = await project(false);
      const store = new ResultsStore(":memory:");
      const first = await session(dirs, store, new GuardBackend(() => a));
      expect(first.counts.survived).toBeGreaterThan(0);
      const report = await session(dirs, store, new GuardBackend(() => b), {
        skipKnownSurvivors: true,
      });
      const known = report.mutants.filter((m) => m.verdict === "known-survivor").length;
      expect(known).toBe(flip ? 0 : first.counts.survived);
      store.close();
    });

    // Real reuse: run 1 (answer a) measured both batch baselines. Run 2 (answer b) aborts in
    // batch 1, and its own snapshots are removed, so resuming it can reuse batch 1's baseline only
    // from run 1. Across a flip it must measure that baseline again.
    test(`baseline reuse: snapshot from count ${a}, resume under ${b}: ${flip ? "re-measured" : "reused"}`, async () => {
      const dirs = await project(true);
      const store = new ResultsStore(":memory:");
      await session(dirs, store, new GuardBackend(() => a, 2));
      const run1 = (store.db.query("SELECT MAX(id) AS id FROM runs").get() as { id: number }).id;
      // Run 1 is the unfinished run "last" would pick; finish it so run 2 is the resumable one.
      store.db.run("UPDATE runs SET finished_at = datetime('now') WHERE id = ?", [run1]);
      await session(dirs, store, new GuardBackend(() => b, 2));
      const run2 = (store.db.query("SELECT MAX(id) AS id FROM runs").get() as { id: number }).id;
      store.db.run("DELETE FROM baseline_snapshots WHERE run_id = ?", [run2]);
      expect(
        (
          store.db
            .query("SELECT COUNT(*) AS n FROM baseline_snapshots WHERE run_id = ?")
            .get(run1) as {
            n: number;
          }
        ).n,
      ).toBeGreaterThan(0);
      const third = new GuardBackend(() => b);
      const events: RunEvent[] = [];
      await session(dirs, store, third, { resume: run2, emit: [(e) => events.push(e)] });
      const reused = events.filter(
        (e) => e.type === "warning" && e.code === "resume-baseline-reused",
      );
      if (flip) {
        expect(reused).toEqual([]);
        expect(third.baselineRuns).toBeGreaterThan(0);
      } else {
        expect(reused).toHaveLength(1);
        expect(third.baselineRuns).toBe(0);
      }
      store.close();
    });
  }

  /** R601 I1: the server a session runs on. A pending prior resumes only on the same one. */
  const SERVER = { resourceServer: "http://bc-r601", resourceServerInstance: "BC" };
  /** The server, with a fresh quarantine dir: an aborted session quarantines its tier (R47). */
  const onServer = (
    server: { resourceServer: string; resourceServerInstance: string } = SERVER,
  ) => ({ ...server, quarantineDir: scratch("lethal-r601-q-") });
  /** R601 M1: `confirmClosedWorld` throws for its first `kills` calls (a run killed after scoring,
   *  before its post-execution confirmation), then confirms. */
  class KilledAtConfirm extends ResultsStore {
    constructor(
      path: string,
      private kills: number,
    ) {
      super(path);
    }
    override confirmClosedWorld(...args: Parameters<ResultsStore["confirmClosedWorld"]>): void {
      if (this.kills > 0) {
        this.kills -= 1;
        throw new Error("killed before confirmation");
      }
      super.confirmClosedWorld(...args);
    }
  }
  const snapHashes = (store: ResultsStore, runId: number) =>
    (
      store.db
        .query("SELECT test_app_hash AS h FROM baseline_snapshots WHERE run_id = ?")
        .all(runId) as { h: string }[]
    ).map((r) => r.h);
  const newestRun = (store: ResultsStore) =>
    (store.db.query("SELECT MAX(id) AS id FROM runs").get() as { id: number }).id;
  /** The crash: run 1 on SERVER, count 0, batch 1 aborted, killed at its confirmation. */
  const crashed = async (kills = 1) => {
    const dirs = await project(true);
    const store = new KilledAtConfirm(":memory:", kills);
    await expect(session(dirs, store, new GuardBackend(() => 0, 2), onServer())).rejects.toThrow(
      "killed before confirmation",
    );
    const [h] = hashes(store);
    if (h === undefined) throw new Error("the crashed session recorded no run");
    expect(h).toMatch(/\|closed-world:public\+internal\|pending$/);
    return { dirs, store, prior: newestRun(store), h, base: h.slice(0, -"|pending".length) };
  };
  const warningOf = (events: readonly RunEvent[], code: string) =>
    events.flatMap((e) => (e.type === "warning" && e.code === code ? [e.message] : []));
  const nothingRan = (b: CountingBackend) => b.deploys + b.baselineRuns + b.mutantRuns;

  // A run killed after scoring, before its post-execution confirmation: its identity and its
  // snapshots stay pending, and no lookup reuses its baseline, even under its own pending key.
  test("interrupted before confirmation: the run and its snapshots stay pending; no baseline is reused", async () => {
    const { store } = await crashed();
    const snaps = store.db.query("SELECT test_app_hash AS h FROM baseline_snapshots").all() as {
      h: string;
    }[];
    expect(snaps.length).toBeGreaterThan(0);
    for (const s of snaps) expect(s.h).toMatch(/\|pending$/);
    // The pending owner is excluded by the lookup too, even under its own (pending) key.
    const pendingSnap = store.db
      .query("SELECT batch_hash, test_app_hash FROM baseline_snapshots")
      .get() as {
      batch_hash: string;
      test_app_hash: string;
    };
    const pendingDeps = runDeps(store);
    expect(
      store.findBaselineSnapshot(
        pendingSnap.batch_hash,
        pendingSnap.test_app_hash,
        pendingDeps,
        CAPS.coverage,
      ),
    ).toBeNull();
    store.close();
  });

  // R601: a crashed closed-world run resumes on the same server when this session's guard gives
  // the same closed answer; its own re-ask confirms or revokes everything it carries.
  const DIFFERS =
    "Such a run is resumed only by a session on the same server whose test app and closed-world answer, asked now, are the same, and this session's differ.";
  for (const mode of ["last", "run"] as const) {
    describe(`R601: --resume ${mode} of a run killed before its confirmation`, () => {
      const resumeOf = (prior: number) => (mode === "last" ? ("last" as const) : prior);
      const flag = (prior: number) => (mode === "last" ? "--resume" : `--resume-run ${prior}`);
      const resume = (
        c: Awaited<ReturnType<typeof crashed>>,
        backend: CountingBackend,
        events: RunEvent[] = [],
        server: Partial<Parameters<typeof runSession>[0]> = onServer(),
        prior = c.prior,
      ) =>
        session(c.dirs, c.store, backend, {
          resume: resumeOf(prior),
          emit: [(e) => events.push(e)],
          ...server,
        });

      test("T1: the same closed answer now: carries, and its own re-ask confirms only the resumed run", async () => {
        const c = await crashed();
        const third = new GuardBackend(() => 0);
        const events: RunEvent[] = [];
        const report = await resume(c, third, events);
        expect(report.mutants.filter((m) => m.carried === true).length).toBeGreaterThan(0);
        expect(warningOf(events, "resume-reusing-run")[0]).toContain(
          `Run ${c.prior} ended before its post-execution closed-world check (R389); this session's guard gave the same closed answer now, and this run's own check after execution will confirm or revoke everything it carries; if this run also ends early, it stays pending like the run it resumed (R601).`,
        );
        expect(third.asked).toBe(2);
        // The batch the crash left open is baselined here, never from the pending prior's snapshot.
        expect(third.baselineRuns).toBeGreaterThan(0);
        const resumed = newestRun(c.store);
        expect(hashes(c.store)).toEqual([c.h, c.base]);
        expect(snapHashes(c.store, resumed).length).toBeGreaterThan(0);
        for (const h of snapHashes(c.store, resumed)) expect(h).toBe(c.base);
        for (const h of snapHashes(c.store, c.prior)) expect(h).toBe(c.h);
        c.store.close();
      });

      test("D1: the guard answers open now: refused in R601's words, with the guard's reason; nothing runs", async () => {
        const c = await crashed();
        const b = new GuardBackend(() => 1);
        await expect(resume(c, b)).rejects.toThrow(
          `${flag(c.prior)}: run ${c.prior} was measured against test app ${c.h}, and this session's test app is ${c.base.slice(0, c.base.indexOf("|"))}. Run ${c.prior} ended before its post-execution closed-world check, so its closed-world answer was never confirmed, and this session's closed-world guard does not answer closed now, because: 1 published app(s) declare the test app as a dependency. So that answer cannot be confirmed.`,
        );
        expect(nothingRan(b)).toBe(0);
        c.store.close();
      });

      test("D2a: closed now, other flags: refused as differing; nothing runs", async () => {
        const c = await crashed();
        const flags = c.h.replace(
          "|closed-world:public+internal|pending",
          "|closed-world:public|pending",
        );
        c.store.db.run("UPDATE runs SET test_app_hash = ? WHERE id = ?", [flags, c.prior]);
        const b = new GuardBackend(() => 0);
        await expect(resume(c, b)).rejects.toThrow(DIFFERS);
        expect(nothingRan(b)).toBe(0);
        c.store.close();
      });

      test("D2b: closed now, another package: refused as differing; nothing runs", async () => {
        const c = await crashed();
        const b = new GuardBackend(() => 0);
        b.served = PKG_OTHER;
        await expect(resume(c, b)).rejects.toThrow(DIFFERS);
        expect(nothingRan(b)).toBe(0);
        c.store.close();
      });

      test("D3(i), defensive: no guard asked, a bare pending prior (a shape production never writes): refused", async () => {
        const c = await crashed();
        const bare = `${c.base.slice(0, c.base.indexOf("|"))}|pending`;
        c.store.db.run("UPDATE runs SET test_app_hash = ? WHERE id = ?", [bare, c.prior]);
        const b = new CountingBackend();
        b.served = PKG;
        await expect(resume(c, b)).rejects.toThrow(
          "this session's closed-world guard does not answer closed now, because: this backend cannot ask the server which apps depend on the test app.",
        );
        expect(nothingRan(b)).toBe(0);
        c.store.close();
      });

      test("D3(ii), control: no guard asked, the real pending prior: refused", async () => {
        const c = await crashed();
        const b = new CountingBackend();
        b.served = PKG;
        await expect(resume(c, b)).rejects.toThrow("does not answer closed now");
        expect(nothingRan(b)).toBe(0);
        c.store.close();
      });

      test("D4 + D4b: accepted, then its own re-ask flips: the resumed run AND the pending chain are revoked", async () => {
        const c = await crashed();
        const b = new GuardBackend((call) => (call === 1 ? 0 : 1));
        const events: RunEvent[] = [];
        await resume(c, b, events);
        expect(b.asked).toBe(2);
        expect(warningOf(events, "closed-world-changed")).toHaveLength(1);
        const resumed = newestRun(c.store);
        const revoked = `${c.h}|closed-world:revoked`;
        expect(hashes(c.store)).toEqual([revoked, revoked]);
        for (const h of [...snapHashes(c.store, resumed), ...snapHashes(c.store, c.prior)])
          expect(h).toBe(revoked);
        // D4b: the prior lends nothing again, even when the guard answers 0, 0 now.
        const again = new GuardBackend(() => 0);
        await expect(resume(c, again)).rejects.toThrow(
          `${flag(c.prior)}: run ${c.prior} was measured against test app ${revoked}`,
        );
        expect(nothingRan(again)).toBe(0);
        c.store.close();
      });

      test("D5: the same answer on ANOTHER server: refused, naming both servers; nothing runs", async () => {
        const c = await crashed();
        const b = new GuardBackend(() => 0);
        const other = onServer({ resourceServer: "http://bc-other", resourceServerInstance: "BC" });
        await expect(resume(c, b, [], other)).rejects.toThrow(
          `Run ${c.prior} ended before its post-execution closed-world check, so its closed-world answer was never confirmed. It ran on server http://bc-r601|BC, and this session runs on server http://bc-other|BC. ${DIFFERS}`,
        );
        expect(nothingRan(b)).toBe(0);
        c.store.close();
      });

      test("D5c: the same answer, this session's server unknown: refused, an unknown server never matches", async () => {
        const c = await crashed();
        const b = new GuardBackend(() => 0);
        await expect(
          resume(c, b, [], { quarantineDir: scratch("lethal-r601-q-") }),
        ).rejects.toThrow(
          "It ran on server http://bc-r601|BC, and this session runs on server unknown. Such a run is resumed only by a session on the same server whose test app and closed-world answer, asked now, are the same, and an unknown server never matches.",
        );
        expect(nothingRan(b)).toBe(0);
        c.store.close();
      });

      test("D6: a FRESH session on the same server flips: the older pending run is revoked and a resume of it carries nothing", async () => {
        const c = await crashed();
        const fresh = new GuardBackend((call) => (call === 1 ? 0 : 1));
        const events: RunEvent[] = [];
        await session(c.dirs, c.store, fresh, { emit: [(e) => events.push(e)], ...onServer() });
        expect(fresh.asked).toBe(2);
        const changed = warningOf(events, "closed-world-changed");
        expect(changed).toHaveLength(1);
        // I-1: the flip names the other run it revoked.
        expect(changed[0]).toEndWith(
          `; it also revoked 1 run(s) of this project still pending on this server (${c.prior}), so they cannot be resumed (R601)`,
        );
        const revoked = `${c.h}|closed-world:revoked`;
        expect(hashes(c.store)).toEqual([revoked, revoked]);
        for (const h of snapHashes(c.store, c.prior)) expect(h).toBe(revoked);
        const again = new GuardBackend(() => 0);
        const refusal = resume(c, again);
        await expect(refusal).rejects.toThrow(
          `${flag(c.prior)}: run ${c.prior} was measured against test app ${revoked}`,
        );
        // I-1: the refusal names the cause, a changed answer, not a republish.
        await expect(refusal).rejects.toThrow(
          `. Its identity was revoked: a closed-world check after execution, its own or a later run's on its server, answered differently (R389, R601). A verdict`,
        );
        expect(nothingRan(again)).toBe(0);
        c.store.close();
      });

      test("T2: the resumed run crashes too: the next resume carries from it and confirms", async () => {
        const c = await crashed(2);
        await expect(resume(c, new GuardBackend(() => 0))).rejects.toThrow(
          "killed before confirmation",
        );
        const first = newestRun(c.store);
        const b = new GuardBackend(() => 0);
        const events: RunEvent[] = [];
        const report = await resume(c, b, events, onServer(), first);
        expect(warningOf(events, "resume-reusing-run")[0]).toContain(`reusing run ${first} —`);
        expect(report.mutants.filter((m) => m.carried === true).length).toBeGreaterThan(0);
        expect(hashes(c.store)).toEqual([c.h, c.h, c.base]);
        c.store.close();
      });
    });
  }

  /** A copy of run `from` and its snapshots, with `set` applied to the row; snapshots take the
   *  copy's `test_app_hash`. */
  const cloneRun = (store: ResultsStore, from: number, set: Record<string, string>) => {
    const cols = (store.db.query("PRAGMA table_info(runs)").all() as { name: string }[])
      .map((c) => c.name)
      .filter((n) => n !== "id")
      .join(", ");
    store.db.run(`INSERT INTO runs (${cols}) SELECT ${cols} FROM runs WHERE id = ?`, [from]);
    const id = newestRun(store);
    for (const [k, v] of Object.entries(set))
      store.db.run(`UPDATE runs SET ${k} = ? WHERE id = ?`, [v, id]);
    store.db.run(
      "INSERT INTO baseline_snapshots (run_id, batch_index, batch_hash, test_app_hash, payload) SELECT ?1, batch_index, batch_hash, (SELECT test_app_hash FROM runs WHERE id = ?1), payload FROM baseline_snapshots WHERE run_id = ?2",
      [id, from],
    );
    return id;
  };

  test("D4c: a flip leaves a confirmed run, another project's pending run and another server's pending run unchanged", async () => {
    const c = await crashed();
    const confirmed = cloneRun(c.store, c.prior, { test_app_hash: c.base });
    const otherProject = cloneRun(c.store, c.prior, { project_path: `${c.dirs.projectDir}-other` });
    const otherServer = cloneRun(c.store, c.prior, { resource_key: "http://bc-other|BC" });
    const kept = [confirmed, otherProject, otherServer];
    const before = kept.map((id) => [hashes(c.store)[id - 1], snapHashes(c.store, id)]);
    for (const [, snaps] of before) expect(snaps).not.toEqual([]);
    await session(c.dirs, c.store, new GuardBackend((call) => (call === 1 ? 0 : 1)), onServer());
    // Control: the flip did revoke this project's pending run on this server.
    expect(hashes(c.store)[c.prior - 1]).toBe(`${c.h}|closed-world:revoked`);
    expect(kept.map((id) => [hashes(c.store)[id - 1], snapHashes(c.store, id)])).toEqual(before);
    c.store.close();
  });

  test("D4c-tag (M-3): a flip also revokes the same package's pending run under the OTHER closed tag", async () => {
    const c = await crashed();
    const tag = `${c.base.replace(/\+internal$/, "")}|pending`;
    expect(tag).not.toBe(c.h);
    const other = cloneRun(c.store, c.prior, { test_app_hash: tag });
    await session(c.dirs, c.store, new GuardBackend((call) => (call === 1 ? 0 : 1)), onServer());
    expect(hashes(c.store)[other - 1]).toBe(`${tag}|closed-world:revoked`);
    for (const h of snapHashes(c.store, other)) expect(h).toBe(`${tag}|closed-world:revoked`);
    c.store.close();
  });

  test("D4c-nokey (M-7): a flipping session with no server key revokes the project's pending run on a known server", async () => {
    const c = await crashed();
    await session(c.dirs, c.store, new GuardBackend((call) => (call === 1 ? 0 : 1)), {
      quarantineDir: scratch("lethal-r601-q-"),
    });
    expect(hashes(c.store)[c.prior - 1]).toBe(`${c.h}|closed-world:revoked`);
    c.store.close();
  });

  test("M-8: --resume last picks the newest run, pending on ANOTHER server, over an older resumable one here: refused by name, no fallback", async () => {
    const c = await crashed(2);
    const other = { resourceServer: "http://bc-other", resourceServerInstance: "BC" };
    await expect(
      session(c.dirs, c.store, new GuardBackend(() => 0, 2), onServer(other)),
    ).rejects.toThrow("killed before confirmation");
    const newer = newestRun(c.store);
    expect(newer).toBeGreaterThan(c.prior);
    const b = new GuardBackend(() => 0);
    await expect(session(c.dirs, c.store, b, { resume: "last", ...onServer() })).rejects.toThrow(
      `--resume: run ${newer} was measured against test app ${c.h}, and this session's test app is ${c.base}. Run ${newer} ended before its post-execution closed-world check, so its closed-world answer was never confirmed. It ran on server http://bc-other|BC, and this session runs on server http://bc-r601|BC.`,
    );
    expect(nothingRan(b)).toBe(0);
    c.store.close();
  });

  test("M2: --resume-run of a resumed-then-revoked run (D4's shape): refused; nothing runs", async () => {
    const c = await crashed();
    const revoked = `${c.h}|closed-world:revoked`;
    c.store.db.run("UPDATE runs SET test_app_hash = ? WHERE id = ?", [revoked, c.prior]);
    const b = new GuardBackend(() => 0);
    await expect(session(c.dirs, c.store, b, { resume: c.prior, ...onServer() })).rejects.toThrow(
      `--resume-run ${c.prior}: run ${c.prior} was measured against test app ${revoked}`,
    );
    expect(nothingRan(b)).toBe(0);
    c.store.close();
  });

  test("findBaselineSnapshot excludes a revoked owner; revocation updates run and snapshots together", async () => {
    const dirs = await project(true);
    const store = new ResultsStore(":memory:");
    await session(dirs, store, new GuardBackend(() => 0, 2));
    const run1 = (store.db.query("SELECT MAX(id) AS id FROM runs").get() as { id: number }).id;
    const snap = store.db
      .query("SELECT batch_hash, test_app_hash FROM baseline_snapshots")
      .get() as {
      batch_hash: string;
      test_app_hash: string;
    };
    const deps = runDeps(store);
    // Control: confirmed, the snapshot is found by its key.
    expect(
      store.findBaselineSnapshot(snap.batch_hash, snap.test_app_hash, deps, CAPS.coverage),
    ).not.toBeNull();
    // A revoked owner whose snapshot kept the key (the state a non-atomic revoke could leave).
    store.db.run(
      "UPDATE runs SET test_app_hash = test_app_hash || '|closed-world:revoked' WHERE id = ?",
      [run1],
    );
    expect(
      store.findBaselineSnapshot(snap.batch_hash, snap.test_app_hash, deps, CAPS.coverage),
    ).toBeNull();
    // The real revoke is one transaction: a failure after the run update rolls it back.
    store.db.run("UPDATE runs SET test_app_hash = ? WHERE id = ?", [snap.test_app_hash, run1]);
    store.db.run(
      "CREATE TRIGGER fail_snap BEFORE UPDATE ON baseline_snapshots BEGIN SELECT RAISE(ABORT, 'killed'); END",
    );
    expect(() => store.revokeTestAppHash(run1, "|closed-world:revoked")).toThrow("killed");
    expect(hashes(store)[0]).toBe(snap.test_app_hash);
    store.db.run("DROP TRIGGER fail_snap");
    store.revokeTestAppHash(run1, "|closed-world:revoked");
    expect(hashes(store)[0]).toMatch(/\|closed-world:revoked$/);
    expect(
      (
        store.db.query("SELECT test_app_hash AS h FROM baseline_snapshots").all() as { h: string }[]
      ).every((r) => r.h.endsWith("|closed-world:revoked")),
    ).toBe(true);
    store.close();
  });
});

/** R512: which kind of run a `shaped` backend is answering. A `confirm` is an unmutated run after
 *  a covered run of the same deploy (the kill-confirmation rerun); a `baseline` one before it. */
type RunPhase = "baseline" | "covered" | "confirm";
/**
 * R512: a `CountingBackend` whose answers `shape` rewrites. `n` counts this phase's runs in the
 * session from 1; `deploys` is the backend's deploy count at the run.
 */
function shaped(
  shape: (at: { phase: RunPhase; n: number; deploys: number }, v: TestVerdict) => TestVerdict,
  abortFromDeploy?: number,
): CountingBackend {
  const b = new CountingBackend("pass", undefined, abortFromDeploy);
  const run = b.run.bind(b);
  const counts: Record<RunPhase, number> = { baseline: 0, covered: 0, confirm: 0 };
  let coveredInDeploy = -1;
  b.run = async (ref, opts) => {
    const before = b.mutantRuns;
    const v = await run(ref, opts);
    const phase: RunPhase =
      b.mutantRuns > before ? "covered" : coveredInDeploy === b.deploys ? "confirm" : "baseline";
    if (phase === "covered") coveredInDeploy = b.deploys;
    counts[phase] += 1;
    return shape({ phase, n: counts[phase], deploys: b.deploys }, v);
  };
  return b;
}
/** The wrong-binary answer: it ran, but observed no guard. */
const unattested = (v: TestVerdict): TestVerdict => ({
  ...v,
  attestation: { observedAny: false, identityMismatch: false },
});
/** No answer about the binary at all (a real timeout never carries one). */
const noAttestation = (v: TestVerdict): TestVerdict => {
  const { attestation: _, ...rest } = v;
  return rest;
};
/** A real-shape timeout: no attestation, no measured duration. */
const realTimeout = (v: TestVerdict): TestVerdict => {
  const { attestation: _, measuredDurationMs: __, ...rest } = v;
  return { ...rest, outcome: "timeout" };
};
/** The rows of `suspect_snapshots`. */
const suspectRows = (store: ResultsStore) =>
  store.db
    .query(
      "SELECT run_id AS run, batch_index AS b, marked_by_run AS by FROM suspect_snapshots ORDER BY run, b",
    )
    .all() as Array<{ run: number; b: number; by: number }>;
const lastRun = (store: ResultsStore) =>
  (store.db.query("SELECT MAX(id) AS id FROM runs").get() as { id: number }).id;
const reusedOf = (events: readonly RunEvent[]) =>
  events.flatMap((e) =>
    e.type === "warning" && e.code === "resume-baseline-reused" ? [e.message] : [],
  );

/**
 * R512. Run 1's batch 1 runs on a binary that is not the instrumented one: every covered run
 * answers but observes nothing, so design §G's attestation gate invalidates the batch. Its baseline
 * (test green) was recorded before the mutant phase. The real binary (run 2) has the test red
 * unmutated. `red` picks how: a stopped `timeout` (scored at position 1 with no unmutated confirm)
 * or a `fail` (confirmed by an unmutated rerun). The fix: the snapshot in use is marked suspect at
 * the first unattested answer, and `findBaselineSnapshot` never lends a marked one.
 */
describe("R512: an attestation-invalidated batch's baseline snapshot, then --resume", () => {
  /**
   * Run 2's real shape (review I2): every baseline run and batch 1's FIRST covered run time out
   * with no attestation; every later covered run passes, attested clean.
   */
  function realShape(): CountingBackend {
    return shaped(({ phase, n }, v) =>
      phase === "baseline" || (phase === "covered" && n === 1) ? realTimeout(v) : v,
    );
  }
  /** Run 1: batch 0 is the right binary; batch 1 answers every covered run unattested. */
  function wrongBinaryInBatch1(): CountingBackend {
    const b = new CountingBackend("pass");
    const run = b.run.bind(b);
    b.run = async (ref, opts) => {
      const v = await run(ref, opts);
      return b.deploys >= 2 && v.attestation !== undefined
        ? { ...v, attestation: { observedAny: false, identityMismatch: false } }
        : v;
    };
    return b;
  }
  /** Run 2: the real binary, on which the test is red with no mutant active too. */
  function redEverywhere(red: "timeout" | "fail"): CountingBackend {
    const b = new CountingBackend("pass");
    const run = b.run.bind(b);
    b.run = async (ref, opts) => {
      const { measuredDurationMs: _, ...v } = await run(ref, opts);
      return { ...v, outcome: red };
    };
    return b;
  }
  async function scenario(red: "timeout" | "fail" | CountingBackend, dropSnapshot: boolean) {
    const dirs = await makeProject({ secondFile: true });
    const store = new ResultsStore(":memory:");
    const events1: RunEvent[] = [];
    const first = await runSession({
      backend: wrongBinaryInBatch1(),
      store,
      ...dirs,
      selectorIds,
      maxGuardsPerBatch: 1,
      emit: [(e) => events1.push(e)],
    });
    const run1 = (store.db.query("SELECT MAX(id) AS id FROM runs").get() as { id: number }).id;
    // The control removes the snapshot by hand: what the resume does without it.
    if (dropSnapshot) store.dropBaselineSnapshot(run1, 1);
    const events: RunEvent[] = [];
    const second = typeof red === "string" ? redEverywhere(red) : red;
    const report = await runSession({
      backend: second,
      store,
      ...dirs,
      selectorIds,
      maxGuardsPerBatch: 1,
      resume: "last",
      stopHungSessions: true,
      emit: [(e) => events.push(e)],
    });
    const reused = events.flatMap((e) =>
      e.type === "warning" && e.code === "resume-baseline-reused" ? [e.message] : [],
    );
    return { first, events1, run1, report, second, reused, store };
  }

  test("R512 repro: the invalidated batch's snapshot is not reused, so a test red on the real binary scores no kill", async () => {
    const { first, events1, run1, report, second, reused, store } = await scenario(
      realShape(),
      false,
    );
    // Precondition: the gate fired on batch 1, and its snapshot is still stored.
    expect(
      events1.some(
        (e) =>
          e.type === "batch-invalidated" &&
          e.batchIndex === 1 &&
          e.reason.startsWith("unattested artifact"),
      ),
    ).toBe(true);
    expect(first.quarantined).toBeDefined();
    const snaps = store.db
      .query("SELECT batch_index AS b FROM baseline_snapshots WHERE run_id = ? ORDER BY b")
      .all(run1);
    expect(snaps).toEqual([{ b: 0 }, { b: 1 }]);
    // The snapshot in use was marked at run 1's first unattested answer, by run 1.
    expect(suspectRows(store)).toEqual([{ run: run1, b: 1, by: run1 }]);
    // Fixed: the unattested batch's snapshot is not reused, its baseline re-runs, the red test is
    // not sent as covering, and nothing is killed (before: M0001 timeout-killed by
    // OverBudgetDetected, with 0 baseline runs).
    const b1 = report.mutants.filter((m) => m.batchIndex === 1);
    expect(reused.filter((m) => m.includes(`run ${run1}'s batch 1`))).toEqual([]);
    expect(second.baselineRuns).toBeGreaterThan(0);
    expect(b1.filter((m) => m.verdict === "timeout-killed" || m.verdict === "killed")).toEqual([]);
    expect(b1.find((m) => m.mutantCode === "M0001")?.verdict).not.toBe("timeout-killed");
  });

  test("R512 control: without the snapshot, the same resume re-runs the baseline and kills nothing", async () => {
    const { report, second, reused } = await scenario("timeout", true);
    const b1 = report.mutants.filter((m) => m.batchIndex === 1);
    console.log(
      "R512 control batch1",
      JSON.stringify(b1.map((m) => [m.mutantCode, m.verdict, m.failureNote ?? null])),
    );
    expect(reused).toEqual([]);
    expect(second.baselineRuns).toBeGreaterThan(0);
    expect(b1.filter((m) => m.verdict === "timeout-killed" || m.verdict === "killed")).toEqual([]);
  });

  test("R512 measure: a test that FAILS on the real binary is confirmed by an unmutated rerun, so it never scores a kill", async () => {
    // Green before and after the fix: before, the reuse sends the red test and the confirm rerun
    // turns each kill into `error` (unstable); after, the baseline re-runs and the test is not sent.
    const { report } = await scenario("fail", false);
    const b1 = report.mutants.filter((m) => m.batchIndex === 1);
    console.log(
      "R512 fail batch1",
      JSON.stringify(b1.map((m) => [m.mutantCode, m.verdict, m.failureNote ?? null])),
    );
    expect(b1.filter((m) => m.verdict === "killed")).toEqual([]);
  });

  test("R512 C1: a lent snapshot is marked by the run that reused it, so a third run does not reuse it", async () => {
    const dirs = await makeProject({ secondFile: true });
    const store = new ResultsStore(":memory:");
    const base = { store, ...dirs, selectorIds, maxGuardsPerBatch: 1 };
    // Run A records S_A for batch 1 and hangs on its first mutant: no answer, no mark.
    await runSession({ ...base, backend: new CountingBackend("pass", undefined, 2) });
    const runA = lastRun(store);
    expect(suspectRows(store)).toEqual([]);
    // Run B reuses S_A and every covered run answers unattested: B marks S_A, not a key of its own.
    const eventsB: RunEvent[] = [];
    await runSession({
      ...base,
      backend: shaped(({ phase }, v) => (phase === "covered" ? unattested(v) : v)),
      resume: "last",
      emit: [(e) => eventsB.push(e)],
    });
    const runB = lastRun(store);
    expect(reusedOf(eventsB).filter((m) => m.includes(`run ${runA}'s batch 1`))).toHaveLength(1);
    expect(
      eventsB.some(
        (e) =>
          e.type === "batch-invalidated" &&
          e.batchIndex === 1 &&
          e.reason.startsWith("unattested artifact"),
      ),
    ).toBe(true);
    expect(suspectRows(store)).toEqual([{ run: runA, b: 1, by: runB }]);
    // Run C, the real binary: S_A is not lent, the baseline re-runs, and nothing is killed.
    const eventsC: RunEvent[] = [];
    const c = realShape();
    const reportC = await runSession({
      ...base,
      backend: c,
      resume: "last",
      stopHungSessions: true,
      emit: [(e) => eventsC.push(e)],
    });
    expect(reusedOf(eventsC).filter((m) => m.includes(`run ${runA}'s batch 1`))).toEqual([]);
    expect(c.baselineRuns).toBeGreaterThan(0);
    const b1 = reportC.mutants.filter((m) => m.batchIndex === 1);
    expect(b1.filter((m) => m.verdict === "timeout-killed" || m.verdict === "killed")).toEqual([]);
  });

  test("R512 (I3): the kill-confirmation rerun's unattested answer marks the snapshot", async () => {
    const dirs = await makeProject();
    const store = new ResultsStore(":memory:");
    let confirms = 0;
    await runSession({
      store,
      ...dirs,
      selectorIds,
      // The covering run fails with no attestation; the unmutated confirm passes, unattested.
      backend: shaped(({ phase }, v) => {
        if (phase === "covered") return noAttestation({ ...v, outcome: "fail" });
        if (phase === "confirm") {
          confirms += 1;
          return unattested(v);
        }
        return v;
      }),
    });
    const run = lastRun(store);
    expect(confirms).toBeGreaterThan(0);
    expect(suspectRows(store)).toEqual([{ run, b: 0, by: run }]);
  });

  /** One batch: covered runs answer by `answer(n, v)`; the third covered run hangs, so run 1 is
   *  left unfinished with work in its batch 0, and a resume (with --retry-stranded) deploys it. */
  async function thenResume(
    answer: (n: number, v: TestVerdict) => TestVerdict,
    store: ResultsStore,
  ) {
    const dirs = await makeProject();
    await runSession({
      store,
      ...dirs,
      selectorIds,
      backend: shaped(({ phase, n }, v) => {
        if (phase !== "covered") return v;
        if (n === 3) {
          return {
            ref: v.ref,
            outcome: "error",
            durationMs: 5,
            operation: "in-flight-unknown",
            failureMessage: "RunMutant timed out: AbortError",
          };
        }
        return answer(n, v);
      }),
    });
    const run1 = lastRun(store);
    const marksAfterRun1 = suspectRows(store);
    const events: RunEvent[] = [];
    await runSession({
      store,
      ...dirs,
      selectorIds,
      backend: new CountingBackend("pass"),
      resume: "last",
      retryStranded: true,
      emit: [(e) => events.push(e)],
    });
    return { run1, marksAfterRun1, reused: reusedOf(events) };
  }

  test("R512 clear: an unattested answer then a clean one leaves no mark, and the snapshot is still reused", async () => {
    const store = new ResultsStore(":memory:");
    const seen: Array<ReturnType<typeof suspectRows>> = [];
    const { run1, marksAfterRun1, reused } = await thenResume((n, v) => {
      if (n === 1) return unattested(v);
      // Precondition: the first answer DID mark run 1's snapshot.
      if (n === 2) seen.push(suspectRows(store));
      return v;
    }, store);
    expect(seen).toEqual([[{ run: run1, b: 0, by: run1 }]]);
    expect(marksAfterRun1).toEqual([]);
    expect(reused.filter((m) => m.includes(`run ${run1}'s batch 0`))).toHaveLength(1);
  });

  test("R512: no mark after a clean attestation", async () => {
    const store = new ResultsStore(":memory:");
    const { marksAfterRun1 } = await thenResume((n, v) => (n === 2 ? unattested(v) : v), store);
    expect(marksAfterRun1).toEqual([]);
  });

  test("R512: a clean batch is never marked, and its snapshot is reused", async () => {
    const store = new ResultsStore(":memory:");
    const { run1, marksAfterRun1, reused } = await thenResume((_n, v) => v, store);
    expect(marksAfterRun1).toEqual([]);
    expect(reused.filter((m) => m.includes(`run ${run1}'s batch 0`))).toHaveLength(1);
  });

  test("R512 control: a hang at batch start fires the gate but marks nothing, and keeps both snapshots", async () => {
    const dirs = await makeProject({ secondFile: true });
    const store = new ResultsStore(":memory:");
    const events: RunEvent[] = [];
    await runSession({
      store,
      ...dirs,
      selectorIds,
      maxGuardsPerBatch: 1,
      backend: new CountingBackend("pass", undefined, 2),
      emit: [(e) => events.push(e)],
    });
    const run1 = lastRun(store);
    expect(
      events.some(
        (e) =>
          e.type === "batch-invalidated" &&
          e.batchIndex === 1 &&
          e.reason.startsWith("unattested artifact"),
      ),
    ).toBe(true);
    expect(
      store.db
        .query("SELECT batch_index AS b FROM baseline_snapshots WHERE run_id = ? ORDER BY b")
        .all(run1),
    ).toEqual([{ b: 0 }, { b: 1 }]);
    expect(suspectRows(store)).toEqual([]);
  });
});

describe("R512/R513: the store's negative records", () => {
  const CARRY = [...CARRYABLE_VERDICTS];
  function newRun(
    store: ResultsStore,
    over: Partial<Parameters<ResultsStore["createRun"]>[0]> = {},
  ): number {
    return store.createRun({
      testScope: [],
      coverageMode: "procedure",
      identityScheme: IDENTITY_SCHEME,
      buildSymbols: [],
      projectPath: "/p",
      backend: "bcdev",
      appVersion: "1",
      configFingerprint: "fp",
      ...over,
    });
  }
  function seed(
    store: ResultsStore,
    runId: number,
    batchIndex: number,
    over: Partial<Parameters<ResultsStore["recordMutant"]>[1]>,
  ) {
    store.recordMutant(runId, {
      mutantCode: "M0001",
      astHash: "h",
      codeunitName: "Sandbox Logic",
      procedureName: "Post",
      operatorName: "lethal.negate-conditional",
      operatorMajor: 1,
      file: "src/SandboxLogic.Codeunit.al",
      line: 1,
      verdict: "survived",
      durationMs: 1,
      batchIndex,
      ...over,
    });
  }
  const LOST = "lease-lost: R513 test note";

  test("R513: mutantVerdicts reads a lost batch's kills and survivors as error with the loss note; batch 0, a known-survivor and a stranded error are unchanged", () => {
    const store = new ResultsStore(":memory:");
    const id = newRun(store);
    seed(store, id, 0, { astHash: "a", verdict: "killed", killingTest: "T", killPosition: 1 });
    seed(store, id, 1, {
      astHash: "b",
      verdict: "killed",
      killingTest: "T",
      killingTestFailure: "boom",
      killPosition: 1,
    });
    seed(store, id, 1, { astHash: "c", verdict: "survived" });
    seed(store, id, 1, { astHash: "d", verdict: "timeout-killed", killingTest: "T" });
    seed(store, id, 1, { astHash: "e", verdict: "known-survivor" });
    const stranded = `${STRANDED_NOTE_PREFIX}in-flight-unknown R513`;
    seed(store, id, 1, { astHash: "f", verdict: "error", failureNote: stranded });
    store.markBatchLost(id, 1, LOST);
    const byHash = new Map(store.mutantVerdicts(id).map((r) => [r.astHash, r]));
    expect(byHash.get("a")).toMatchObject({ verdict: "killed", killingTest: "T", killPosition: 1 });
    for (const h of ["b", "c", "d"]) {
      const r = byHash.get(h);
      expect(r?.verdict).toBe("error");
      expect(r?.failureNote).toBe(LOST);
      expect(r?.killingTest).toBeUndefined();
      expect(r?.killingTestFailure).toBeUndefined();
      expect(r?.killPosition).toBeUndefined();
    }
    expect(byHash.get("e")?.verdict).toBe("known-survivor");
    expect(byHash.get("f")).toMatchObject({ verdict: "error", failureNote: stranded });
    // The stranded row still reaches R53's skip.
    const index = buildResumeIndex(store.mutantVerdicts(id));
    expect(index.strandedKeys.size).toBe(1);
    expect(wasStranded(index, manifestEntry("f"))).toBe(true);
    // The stored rows are untouched: this is a read-time rewrite.
    expect(
      store.db
        .query("SELECT verdict FROM mutants WHERE run_id = ? AND batch_index = 1 ORDER BY id")
        .all(id),
    ).toEqual([
      { verdict: "killed" },
      { verdict: "survived" },
      { verdict: "timeout-killed" },
      { verdict: "known-survivor" },
      { verdict: "error" },
    ]);
  });

  test("R513: findResumableRun skips a run whose only carryable rows are in a lost batch, and finds the older one", () => {
    const store = new ResultsStore(":memory:");
    const older = newRun(store);
    seed(store, older, 0, { verdict: "survived" });
    const newer = newRun(store);
    seed(store, newer, 1, { verdict: "killed", killingTest: "T" });
    const q = {
      projectPath: "/p",
      backend: "bcdev",
      configFingerprint: "fp",
      carryableVerdicts: CARRY,
    };
    expect(store.findResumableRun(q)).toBe(newer);
    store.markBatchLost(newer, 1, LOST);
    expect(store.findResumableRun(q)).toBe(older);
  });

  test("R513: unfinishedRunUnderOtherScheme ignores a run whose only carryable rows are lost", () => {
    const store = new ResultsStore(":memory:");
    const id = newRun(store, { identityScheme: IDENTITY_SCHEME - 1 });
    seed(store, id, 1, { verdict: "survived" });
    const q = { projectPath: "/p", backend: "bcdev", carryableVerdicts: CARRY };
    expect(store.unfinishedRunUnderOtherScheme(q)?.runId).toBe(id);
    store.markBatchLost(id, 1, LOST);
    expect(store.unfinishedRunUnderOtherScheme(q)).toBeNull();
  });

  test("R513: unfinishedRunUnderOtherSymbols ignores a run whose only carryable rows are lost", () => {
    const store = new ResultsStore(":memory:");
    const id = newRun(store, { buildSymbols: ["OTHER"] });
    seed(store, id, 1, { verdict: "survived" });
    const q = { projectPath: "/p", backend: "bcdev", buildSymbols: [], carryableVerdicts: CARRY };
    expect(store.unfinishedRunUnderOtherSymbols(q)?.runId).toBe(id);
    store.markBatchLost(id, 1, LOST);
    expect(store.unfinishedRunUnderOtherSymbols(q)).toBeNull();
  });

  test("R513: unfinishedRunUnderOtherCoverageMode ignores a run whose only carryable rows are lost", () => {
    const store = new ResultsStore(":memory:");
    const id = newRun(store, { coverageMode: "none" });
    seed(store, id, 1, { verdict: "survived" });
    const q = {
      projectPath: "/p",
      backend: "bcdev",
      coverageMode: "procedure" as const,
      carryableVerdicts: CARRY,
    };
    expect(store.unfinishedRunUnderOtherCoverageMode(q)?.runId).toBe(id);
    store.markBatchLost(id, 1, LOST);
    expect(store.unfinishedRunUnderOtherCoverageMode(q)).toBeNull();
  });

  function twoSnapshots(): { store: ResultsStore; id: number } {
    const store = new ResultsStore(":memory:");
    const id = newRun(store, { testAppHash: "package:t", testAppProven: true, testAppDeps: "D" });
    const ref = { codeunitId: 79100, codeunitName: "Tests", method: "A" };
    for (const batchIndex of [0, 1]) {
      store.recordBaselineSnapshot({
        runId: id,
        batchIndex,
        batchHash: `b${batchIndex}`,
        testAppHash: "package:t",
        baseline: [{ ref, verdict: { ref, outcome: "pass", durationMs: 1 } }],
      });
    }
    return { store, id };
  }
  const find = (store: ResultsStore, batchHash: string) =>
    store.findBaselineSnapshot(batchHash, "package:t", "D", "procedure")?.batchIndex ?? null;

  test("R513: findBaselineSnapshot skips a lost batch's snapshot and still finds batch 0's", () => {
    const { store, id } = twoSnapshots();
    expect(find(store, "b1")).toBe(1);
    store.markBatchLost(id, 1, LOST);
    expect(find(store, "b1")).toBeNull();
    expect(find(store, "b0")).toBe(0);
  });

  test("R512: findBaselineSnapshot skips a suspect snapshot and still finds batch 0's", () => {
    const { store, id } = twoSnapshots();
    expect(find(store, "b1")).toBe(1);
    store.markSnapshotSuspect({ runId: id, batchIndex: 1 }, id);
    expect(find(store, "b1")).toBeNull();
    expect(find(store, "b0")).toBe(0);
  });

  test("markBatchLost keeps the first note; markSnapshotSuspect twice is a no-op; clearSnapshotSuspect removes one key", () => {
    const store = new ResultsStore(":memory:");
    const id = newRun(store);
    store.markBatchLost(id, 1, "first");
    store.markBatchLost(id, 1, "second");
    expect(store.db.query("SELECT note FROM lost_batches").all()).toEqual([{ note: "first" }]);
    expect(store.markSnapshotSuspect({ runId: id, batchIndex: 0 }, id)).toBe(true);
    expect(store.markSnapshotSuspect({ runId: id, batchIndex: 0 }, id)).toBe(false);
    expect(store.markSnapshotSuspect({ runId: id, batchIndex: 1 }, id)).toBe(true);
    expect(suspectRows(store)).toEqual([
      { run: id, b: 0, by: id },
      { run: id, b: 1, by: id },
    ]);
    store.clearSnapshotSuspect({ runId: id, batchIndex: 1 }, id);
    expect(suspectRows(store)).toEqual([{ run: id, b: 0, by: id }]);
  });

  test("R512 (r3): the mark is owner-scoped: only the run whose insert created it clears it", () => {
    const { store, id: a } = twoSnapshots();
    const x = newRun(store);
    const y = newRun(store);
    const sA = { runId: a, batchIndex: 1 };
    expect(store.markSnapshotSuspect(sA, x)).toBe(true);
    expect(store.markSnapshotSuspect(sA, y)).toBe(false);
    expect(suspectRows(store)).toEqual([{ run: a, b: 1, by: x }]);
    store.clearSnapshotSuspect(sA, y);
    expect(suspectRows(store)).toEqual([{ run: a, b: 1, by: x }]);
    expect(find(store, "b1")).toBeNull();
    store.clearSnapshotSuspect(sA, x);
    expect(suspectRows(store)).toEqual([]);
    expect(find(store, "b1")).toBe(1);
  });

  test("R512 (r3): feedAttestation clears only a mark this run's insert created", () => {
    let clears = 0;
    const ledger = (inserted: boolean): AttestationLedger => ({
      clean: false,
      markTried: false,
      suspect: false,
      markSuspect: () => inserted,
      clearSuspect: () => {
        clears += 1;
      },
    });
    const wrong = { observedAny: false, identityMismatch: false };
    const right = { observedAny: true, identityMismatch: false };
    // Another run's mark was already there: the insert did not create it, so no clear.
    const theirs = ledger(false);
    feedAttestation(theirs, wrong);
    feedAttestation(theirs, right);
    expect(theirs.clean).toBe(true);
    expect(clears).toBe(0);
    // Control: this run's own mark is cleared, once.
    const mine = ledger(true);
    feedAttestation(mine, wrong);
    feedAttestation(mine, right);
    feedAttestation(mine, right);
    expect(clears).toBe(1);
  });

  test("an old store gains both tables on open and reads its rows unchanged", async () => {
    const path = testDbPath("old.sqlite");
    const first = new ResultsStore(path);
    const id = newRun(first);
    seed(first, id, 0, { astHash: "a", verdict: "survived" });
    seed(first, id, 1, { astHash: "b", verdict: "killed", killingTest: "T" });
    const before = first.mutantVerdicts(id);
    first.db.run("DROP TABLE lost_batches");
    first.db.run("DROP TABLE suspect_snapshots");
    first.close();
    const reopened = new ResultsStore(path);
    const tables = reopened.db
      .query(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('lost_batches', 'suspect_snapshots') ORDER BY name",
      )
      .all();
    expect(tables).toEqual([{ name: "lost_batches" }, { name: "suspect_snapshots" }]);
    expect(reopened.mutantVerdicts(id)).toEqual(before);
    reopened.close();
  });
});

/**
 * R514. A reused baseline's DURATIONS set today's budgets. A test that was fast when the snapshot
 * was recorded and is slower today (with or without a mutant) runs past `max(2 x old duration,
 * floor)` and, at group position 1, is scored `timeout-killed` with no unmutated confirm.
 *
 * Two tests, so another test's clean answer passes design §G's gate: `AFast` (always 100 ms) and
 * `BSlow` (`slowMs` today). Both cover both carriers. Durations are simulated: a run whose
 * simulated time exceeds the budget it was sent answers `timeout` (no attestation), never a clock.
 */
const TWO_TESTS_AL = `codeunit 79100 "Sandbox Tests"
{
    Subtype = Test;

    [Test]
    procedure AFast()
    begin
    end;

    [Test]
    procedure BSlow()
    begin
    end;
}
`;

/** The budgets the orchestrator sent, per run. `active` is the mutant active at the run. */
interface SentBudget {
  readonly method: string;
  readonly active: boolean;
  readonly timeoutMs: number;
}

interface ClockOptions {
  readonly abort?: { after?: number; fromDeploy?: number };
  /** Serve `runMany` (the grouped path). */
  readonly grouped?: boolean;
  /** BSlow's simulated duration while a mutant is active; `Infinity` is a hang. Absent: `slowMs`. */
  readonly mutatedMs?: number;
  /** false: a non-authoritative backend, so `workers > 1` is allowed. */
  readonly authoritative?: boolean;
  /**
   * R516 (c): model al-runner one-shot. The in-run test limit is `oneShotLimits(timeoutMs)`'s
   * (imported, so this fake follows the formula `AlRunnerBackend.sendOneShot` sends), the simulated
   * time is the test BODY, and the wall clock (`durationMs`) adds this compile overhead; a pass
   * also carries the body as `measuredDurationMs` (R272). Absent: the limit is `timeoutMs` and the
   * wall clock is the body.
   */
  readonly alRunnerCompileMs?: number;
  /** R516 I1: the backend's `inRunStopIsBudget` (false: the al-runner `--server` shape). Default true. */
  readonly inRunStopIsBudget?: boolean;
  /**
   * R517: model the al-runner `--server` daemon. One stop for its life, timed on the test BODY:
   * `ceil(max(f, b) / 1000) * 1000` once `useMutantBudgetFloor(f, b)` was called, else 60 000 ms
   * (al-runner's own default, which is what today's daemon gets). A run times out when BSlow's body
   * exceeds the stop, whatever `timeoutMs` says, and its verdict carries `reportedStopMs`. A
   * verdict's `durationMs` is the suite's wall clock (body plus `restMs`); a pass carries the body
   * as `measuredDurationMs`. `inRunStopIsBudget` is false.
   */
  readonly server?: {
    readonly restMs: number;
    /** The stop the daemon really enforces, whatever it was configured with (a build that ignores
     *  the flag, or a test that needs a known stop with no floor call). */
    readonly enforcedStopMs?: number;
    /** What the timeout row reports; `null`: a row whose message does not parse. Default: the stop. */
    readonly reportedStopMs?: number | null;
  };
}

/** R517: a timeout verdict's `reportedStopMs`, absent for `null` (a row that does not parse). */
function reportedStop(ms: number | null): { reportedStopMs?: number } {
  return ms === null ? {} : { reportedStopMs: ms };
}

class ClockBackend extends CountingBackend {
  readonly sent: SentBudget[] = [];
  /** The mutant active at the next run (`null`: unmutated). */
  active: string | null = null;
  readonly inRunStopIsBudget: boolean;
  private readonly mutatedMs: number | undefined;
  private readonly authoritative: boolean;
  private readonly compileMs: number | undefined;
  private readonly server: ClockOptions["server"];
  /** R517: every `useMutantBudgetFloor` call, with how many runs this backend had made before it. */
  readonly floorCalls: Array<{ floorMs: number; baselineTimeoutMs: number; runsBefore: number }> =
    [];
  private configuredStopMs: number | undefined;
  useMutantBudgetFloor(floorMs: number, baselineTimeoutMs: number): void {
    this.floorCalls.push({ floorMs, baselineTimeoutMs, runsBefore: this.sent.length });
    this.configuredStopMs = Math.ceil(Math.max(floorMs, baselineTimeoutMs) / 1000) * 1000;
  }
  /** R517: the stop LethAL configured, under the `server` shape only. */
  get inRunStopMs(): number | undefined {
    return this.server !== undefined ? this.configuredStopMs : undefined;
  }
  constructor(
    /** BSlow's simulated unmutated duration on this backend (AFast is always 100 ms). */
    private readonly slowMs: number,
    o: ClockOptions = {},
  ) {
    super("pass", o.abort?.after, o.abort?.fromDeploy);
    if (o.grouped === true) this.runMany = (opts) => this.many(opts);
    this.inRunStopIsBudget = o.server !== undefined ? false : (o.inRunStopIsBudget ?? true);
    this.mutatedMs = o.mutatedMs;
    this.authoritative = o.authoritative ?? true;
    this.compileMs = o.alRunnerCompileMs;
    this.server = o.server;
    // The al-runner shape: no served package to fetch, so its test app is proven from source.
    if (!this.authoritative) {
      (this as { fetchPublishedAppPackage?: unknown }).fetchPublishedAppPackage = undefined;
    }
  }
  runMany?: (opts: RunManyOpts) => Promise<RunManyResult>;
  /** R392: read only when non-authoritative (the al-runner shape `workers > 1` needs). */
  readonly measurePredefinedSymbols = measuredV2_12;
  override capabilities(): BackendCapabilities {
    return {
      ...super.capabilities(),
      kind: this.authoritative ? "bcdev" : "al-runner",
      authoritative: this.authoritative,
    };
  }
  override async activate(id: string | null): Promise<void> {
    this.active = id;
    await super.activate(id);
  }
  override async run(ref: TestMethodRef, opts: RunOpts): Promise<TestVerdict> {
    const v = await super.run(ref, opts);
    if (v.operation === "in-flight-unknown") return v; // run 1's hang
    this.sent.push({
      method: ref.method,
      active: this.active !== null,
      timeoutMs: opts.timeoutMs,
    });
    const ms =
      ref.method !== "BSlow"
        ? 100
        : this.active !== null
          ? (this.mutatedMs ?? this.slowMs)
          : this.slowMs;
    const server = this.server;
    if (server !== undefined) {
      const stop = server.enforcedStopMs ?? this.configuredStopMs ?? 60_000;
      if (ms > stop) {
        const { attestation: _, measuredDurationMs: __, ...rest } = v;
        const reported = server.reportedStopMs === undefined ? stop : server.reportedStopMs;
        // R534: al-runner's body-timeout row (`Test exceeded {N}s timeout.`) is decoded `body`.
        return {
          ...rest,
          outcome: "timeout",
          durationMs: stop + server.restMs,
          ...reportedStop(reported),
          timeoutIn: "body",
        };
      }
      return { ...v, durationMs: ms + server.restMs, measuredDurationMs: ms };
    }
    const compile = this.compileMs;
    if (compile !== undefined) {
      const limit = oneShotLimits(opts.timeoutMs).testTimeoutSeconds * 1000;
      if (ms > limit) {
        const { attestation: _, measuredDurationMs: __, ...rest } = v;
        // R517: al-runner's row says which stop fired (`Test exceeded {N}s timeout.`); R534: in
        // the test body.
        return {
          ...rest,
          outcome: "timeout",
          durationMs: limit + compile,
          ...reportedStop(limit),
          timeoutIn: "body",
        };
      }
      return { ...v, durationMs: ms + compile, measuredDurationMs: ms };
    }
    if (ms > opts.timeoutMs) {
      const { attestation: _, measuredDurationMs: __, ...rest } = v;
      return { ...rest, outcome: "timeout", durationMs: opts.timeoutMs };
    }
    return { ...v, durationMs: ms };
  }
  private async many(opts: RunManyOpts): Promise<RunManyResult> {
    const verdicts: TestVerdict[] = [];
    let endedBy: "complete" | "failure" = "complete";
    for (const m of opts.methods) {
      const v = await this.run(m.ref, { coverage: "none", timeoutMs: m.budgetMs });
      verdicts.push(v);
      if (v.outcome !== "pass") {
        endedBy = "failure";
        break;
      }
    }
    return {
      kind: "verdicts",
      endedBy,
      ranCount: verdicts.length,
      verdicts,
      durationMs: verdicts.reduce((s, v) => s + v.durationMs, 0),
      fencedOp: { attemptId: `c${this.sent.length}`, opSeq: 100 + this.sent.length },
    };
  }
}

describe("R514: a reused baseline's durations set today's budgets", () => {
  const YESTERDAY_MS = 1_000; // BSlow when the snapshot was recorded
  const TODAY_MS = 5_000; // BSlow today, mutant or not
  const FLOOR_MS = 2_000; // --mutant-timeout-ms

  async function twoTestProject(secondFile: boolean) {
    const dirs = await makeProject({ secondFile });
    await Bun.write(join(dirs.testDir, "SandboxTests.Codeunit.al"), TWO_TESTS_AL);
    return dirs;
  }
  const opts = (store: ResultsStore, dirs: Awaited<ReturnType<typeof twoTestProject>>) => ({
    store,
    ...dirs,
    selectorIds,
    stopHungSessions: true,
    mutantTimeoutMs: FLOOR_MS,
  });
  const falseKills = (report: SessionReport, batch: number) =>
    report.mutants.filter(
      (m) =>
        m.batchIndex === batch &&
        m.carried !== true &&
        (m.verdict === "timeout-killed" || m.verdict === "killed"),
    );
  /** BSlow's budgets under a mutant, as sent. */
  const slowBudgets = (b: ClockBackend) => [
    ...new Set(b.sent.filter((s) => s.active && s.method === "BSlow").map((s) => s.timeoutMs)),
  ];
  /** Every unmutated BSlow run sent AFTER the first mutated run (so never a baseline run): the
   *  confirms. */
  const slowConfirms = (b: ClockBackend) => {
    const first = b.sent.findIndex((s) => s.active);
    return first < 0 ? [] : b.sent.slice(first).filter((s) => !s.active && s.method === "BSlow");
  };
  /** The scored (not carried) mutants of a batch. */
  const scoredOf = (report: SessionReport, batch: number) =>
    report.mutants.filter((m) => m.batchIndex === batch && m.carried !== true);
  /** Every scored mutant is `error` / `reused-budget-stale`, its note naming the reused run. */
  const expectStale = (report: SessionReport, batch: number, reusedRun: number) => {
    const scored = scoredOf(report, batch);
    expect(scored.length).toBeGreaterThan(0);
    for (const m of scored) {
      expect([m.mutantCode, m.verdict, m.cause]).toEqual([
        m.mutantCode,
        "error",
        "reused-budget-stale",
      ]);
      expect(m.failureNote).toContain(`run ${reusedRun}'s reused baseline`);
    }
    return scored;
  };
  /**
   * R515: the first scored mutant is `reused-budget-stale` (its confirm measures BSlow today);
   * every later one in the batch runs BSlow at twice that measurement and, no mutant touching
   * BSlow's time, survives. So exactly ONE confirm, and no kill.
   */
  const expectStaleThenRebudgeted = (
    b: ClockBackend,
    report: SessionReport,
    batch: number,
    reusedRun: number,
  ) => {
    const scored = scoredOf(report, batch);
    expect(scored.length).toBeGreaterThan(1);
    const [first, ...rest] = scored;
    expect([first?.verdict, first?.cause]).toEqual(["error", "reused-budget-stale"]);
    expect(first?.failureNote).toContain(`run ${reusedRun}'s reused baseline`);
    expect(rest.map((m) => m.verdict)).toEqual(rest.map(() => "survived"));
    expectConfirmsAtBaselineDeadline(b, 1);
    return scored;
  };
  /** One unmutated BSlow confirm per position-1 timeout, each at the baseline's deadline. */
  const expectConfirmsAtBaselineDeadline = (b: ClockBackend, timeouts: number) => {
    expect(slowConfirms(b).map((s) => s.timeoutMs)).toEqual(
      Array.from({ length: timeouts }, () => 120_000),
    );
  };

  /** (a) Run 1, yesterday: one batch, finishes the first mutant (both tests answer, attested
   *  clean), then hangs. Run 2, today, resumes with --retry-stranded and reuses run 1's snapshot. */
  async function sameBatchReuse(
    today: ClockBackend,
    extra: { maxMethodsPerCall?: number; workers?: ClockBackend[] } = {},
  ) {
    const dirs = await twoTestProject(false);
    const store = new ResultsStore(":memory:");
    const authoritative = extra.workers === undefined;
    await runSession({
      ...opts(store, dirs),
      backend: new ClockBackend(YESTERDAY_MS, { abort: { after: 2 }, authoritative }),
    });
    const run1 = lastRun(store);
    const events: RunEvent[] = [];
    const workers = extra.workers;
    const report = await runSession({
      ...opts(store, dirs),
      backend: today,
      resume: "last",
      retryStranded: true,
      emit: [(e) => events.push(e)],
      ...(extra.maxMethodsPerCall !== undefined
        ? { groupRuns: { maxMethodsPerCall: extra.maxMethodsPerCall } }
        : {}),
      ...(workers !== undefined
        ? {
            workers: workers.length,
            backendFactory: (i: number) => {
              const w = workers[i];
              if (w === undefined) throw new Error(`no worker backend ${i}`);
              return w;
            },
          }
        : {}),
    });
    return { run1, today, report, reused: reusedOf(events), events };
  }

  test("R514 fixed (a), single path: a reused fast duration gives BSlow a 2000 ms budget; the timeout is confirmed unmutated and is reused-budget-stale, not a kill", async () => {
    const today = new ClockBackend(TODAY_MS);
    const { run1, report, reused } = await sameBatchReuse(today);
    expect(reused.filter((m) => m.includes(`run ${run1}'s batch 0`))).toHaveLength(1);
    // R515: the first mutated BSlow run is sent the reused 2000; once its confirm measures 5000,
    // the rest are sent 10000.
    expect(slowBudgets(today)).toEqual([Math.max(2 * YESTERDAY_MS, FLOOR_MS), 2 * TODAY_MS]);
    expect(falseKills(report, 0)).toEqual([]);
    expectStaleThenRebudgeted(today, report, 0, run1);
  });

  test("R514 fixed (a), single path, workers = 2: executeCovering forwards the reuse to every worker", async () => {
    const today = new ClockBackend(TODAY_MS, { authoritative: false });
    const workers = [
      new ClockBackend(TODAY_MS, { authoritative: false }),
      new ClockBackend(TODAY_MS, { authoritative: false }),
    ];
    const { run1, report, reused } = await sameBatchReuse(today, { workers });
    expect(reused.filter((m) => m.includes(`run ${run1}'s batch 0`))).toHaveLength(1);
    expect(falseKills(report, 0)).toEqual([]);
    const scored = expectStale(report, 0, run1);
    expect(workers.flatMap((w) => slowConfirms(w)).map((s) => s.timeoutMs)).toEqual(
      scored.map(() => 120_000),
    );
  });

  test("R514 fixed (a), the (budget/2, budget] band: an unmutated confirm inside the budget but over half of it is reused-budget-stale (R53's 2x margin)", async () => {
    // Budget 2000 (from yesterday's 1000). Today: 1500 unmutated, 2500 under the mutant. The 1x
    // rule would score the confirm at 1500 <= 2000 a kill.
    // R515: after the first confirm (1500 ms) the rest are sent 3000, and pass at 2500.
    const today = new ClockBackend(1_500, { mutatedMs: 2_500 });
    const { run1, report } = await sameBatchReuse(today);
    expect(slowBudgets(today)).toEqual([2_000, 3_000]);
    expect(falseKills(report, 0)).toEqual([]);
    const [first] = expectStaleThenRebudgeted(today, report, 0, run1);
    expect(first?.failureNote).toContain("completed unmutated in 1500 ms");
  });

  test("R514 control (a), grouped, one call: BSlow at position 2 is replayed unmutated (confirmWarm), so no kill", async () => {
    const today = new ClockBackend(TODAY_MS, { grouped: true });
    const { run1, report, reused } = await sameBatchReuse(today);
    expect(reused.filter((m) => m.includes(`run ${run1}'s batch 0`))).toHaveLength(1);
    expect(today.runMany).toBeDefined();
    expect(falseKills(report, 0)).toEqual([]);
  });

  test("R514 fixed (a), grouped, one method per call: every BSlow run is at position 1, and each is confirmed unmutated", async () => {
    const today = new ClockBackend(TODAY_MS, { grouped: true });
    const { run1, report } = await sameBatchReuse(today, { maxMethodsPerCall: 1 });
    expect(falseKills(report, 0)).toEqual([]);
    expectStaleThenRebudgeted(today, report, 0, run1);
  });

  test("R514 confirmWarm on a reused batch: a replay at position 2 over half the budget is reused-budget-stale", async () => {
    // One call, AFast at 1 and BSlow at 2. BSlow 1500 unmutated, 2500 mutated, budget 2000: the
    // replay passes at 1500, inside the budget (the 1x rule's kill) but over half of it.
    const today = new ClockBackend(1_500, { grouped: true, mutatedMs: 2_500 });
    const { run1, report } = await sameBatchReuse(today);
    expect(falseKills(report, 0)).toEqual([]);
    const scored = expectStale(report, 0, run1);
    for (const m of scored) expect(m.failureNote).toContain("at position 2 of the replay");
  });

  test("R514 confirmWarm on a reused batch: a genuine hang at position 2 whose replay passes in under half the budget is timeout-killed", async () => {
    const today = new ClockBackend(800, { grouped: true, mutatedMs: Number.POSITIVE_INFINITY });
    const { report } = await sameBatchReuse(today);
    const scored = scoredOf(report, 0);
    // The first is killed at position 2 (warm, confirmed by the replay); R197 then puts BSlow
    // first, so the next is killed at position 1 (cold, confirmed unmutated).
    expect(scored.map((m) => [m.mutantCode, m.verdict, m.killingTest, m.killPosition])).toEqual([
      ["M0002", "timeout-killed", "BSlow", 2],
      ["M0003", "timeout-killed", "BSlow", 1],
    ]);
  });

  test("R514 fixed (b1): a snapshot kept from a hang at batch start (nothing answered) lends the same short budget, and is caught by the confirm", async () => {
    const dirs = await twoTestProject(true);
    const store = new ResultsStore(":memory:");
    const base = { ...opts(store, dirs), maxGuardsPerBatch: 1 };
    // Batch 0 completes; batch 1's baseline is recorded, then its first covered run hangs.
    await runSession({
      ...base,
      backend: new ClockBackend(YESTERDAY_MS, { abort: { fromDeploy: 2 } }),
    });
    const run1 = lastRun(store);
    expect(suspectRows(store)).toEqual([]);
    const today = new ClockBackend(TODAY_MS);
    const events: RunEvent[] = [];
    const report = await runSession({
      ...base,
      backend: today,
      resume: "last",
      retryStranded: true,
      emit: [(e) => events.push(e)],
    });
    expect(reusedOf(events).filter((m) => m.includes(`run ${run1}'s batch 1`))).toHaveLength(1);
    expect(falseKills(report, 1)).toEqual([]);
    expectStaleThenRebudgeted(today, report, 1, run1);
  });

  test("R514 fixed (b2): once R512 marks the newest snapshot, an older one from the same stale period is lent instead, and is caught by the confirm", async () => {
    const dirs = await twoTestProject(false);
    const store = new ResultsStore(":memory:");
    // Run A: fast, records S_A, scores one mutant, hangs.
    await runSession({
      ...opts(store, dirs),
      backend: new ClockBackend(YESTERDAY_MS, { abort: { after: 2 } }),
    });
    const runA = lastRun(store);
    // Run B: a fresh run (no resume), also fast; records S_B, its covered runs answer unattested,
    // so R512 marks S_B, then it hangs.
    const b = new ClockBackend(YESTERDAY_MS, { abort: { after: 2 } });
    const runB0 = b.run.bind(b);
    b.run = async (ref, o) => {
      const v = await runB0(ref, o);
      return v.attestation !== undefined ? unattested(v) : v;
    };
    await runSession({ ...opts(store, dirs), backend: b });
    const runB = lastRun(store);
    expect(suspectRows(store)).toEqual([{ run: runB, b: 0, by: runB }]);
    // Run C, today: resumes B (the newest unfinished run with carryable rows) or A; either way the
    // snapshot lent is S_A, from the same fast period, with no evidence against it.
    const today = new ClockBackend(TODAY_MS);
    const events: RunEvent[] = [];
    const report = await runSession({
      ...opts(store, dirs),
      backend: today,
      resume: "last",
      retryStranded: true,
      emit: [(e) => events.push(e)],
    });
    expect(reusedOf(events).filter((m) => m.includes(`run ${runA}'s batch 0`))).toHaveLength(1);
    expect(falseKills(report, 0)).toEqual([]);
    expectStaleThenRebudgeted(today, report, 0, runA);
  });

  test("R514 direction 2: a GENUINE hang under the mutant on a reused baseline is still timeout-killed, after one unmutated confirm at under half the budget", async () => {
    // Today BSlow is 800 ms unmutated (2 x 800 = 1600 <= the 2000 budget, off the boundary), and
    // never ends under any mutant.
    const today = new ClockBackend(800, { mutatedMs: Number.POSITIVE_INFINITY });
    const { report, reused } = await sameBatchReuse(today);
    expect(reused).toHaveLength(1);
    const scored = scoredOf(report, 0);
    expect(scored.length).toBeGreaterThan(0);
    for (const m of scored) {
      expect([m.verdict, m.killingTest, m.killPosition]).toEqual(["timeout-killed", "BSlow", 1]);
    }
    expectConfirmsAtBaselineDeadline(today, scored.length);
  });

  test("R516 T5 a fresh genuine hang: every position-1 timeout is confirmed by ONE unmutated run at the baseline deadline, and is timeout-killed", async () => {
    // BSlow 800 ms unmutated (budget the 2000 floor; 2 x 800 = 1600 <= 2000, off the boundary),
    // and never ends under any mutant. No resume.
    const dirs = await twoTestProject(false);
    const store = new ResultsStore(":memory:");
    const today = new ClockBackend(800, { mutatedMs: Number.POSITIVE_INFINITY });
    const report = await runSession({ ...opts(store, dirs), backend: today });
    const scored = scoredOf(report, 0);
    expect(scored.length).toBeGreaterThan(0);
    for (const m of scored) {
      expect([m.verdict, m.killingTest, m.killPosition]).toEqual(["timeout-killed", "BSlow", 1]);
    }
    expectConfirmsAtBaselineDeadline(today, scored.length);
    // The row shape `itest:hang`'s R516 check queries: per timeout row's `mutant_row_id`, exactly
    // one `mutant_code IS NULL AND op_kind IS NULL` row, for the killing test, outcome pass.
    const confirmRows = store.db
      .query(
        `SELECT t.mutant_row_id AS id, COUNT(c.id) AS n, MIN(c.method) AS method, MIN(c.outcome) AS outcome
           FROM test_results t
           LEFT JOIN test_results c
             ON c.mutant_row_id = t.mutant_row_id AND c.mutant_code IS NULL AND c.op_kind IS NULL
          WHERE t.outcome = 'timeout' AND t.mutant_code IS NOT NULL
          GROUP BY t.mutant_row_id`,
      )
      .all() as { id: number; n: number; method: string; outcome: string }[];
    expect(confirmRows.length).toBe(scored.length);
    for (const r of confirmRows) expect([r.n, r.method, r.outcome]).toEqual([1, "BSlow", "pass"]);
  });

  /** A fresh grouped run (AFast at 1, BSlow at 2 of one call) whose baseline measures BSlow at
   *  1000 ms (budget 2000); later, unmutated, BSlow takes `unmutatedMs`; it hangs under a mutant. */
  async function freshWarmHang(unmutatedMs: number) {
    const dirs = await twoTestProject(false);
    const store = new ResultsStore(":memory:");
    const today = new ClockBackend(unmutatedMs, {
      grouped: true,
      mutatedMs: Number.POSITIVE_INFINITY,
    });
    const inner = today.run.bind(today);
    let baselineDone = false;
    today.run = async (ref, o) => {
      if (today.mutantRuns === 0 && !baselineDone && ref.method === "BSlow") {
        baselineDone = true;
        const v = await inner(ref, { ...o, timeoutMs: Number.POSITIVE_INFINITY });
        return { ...v, durationMs: YESTERDAY_MS };
      }
      return inner(ref, o);
    };
    return runSession({ ...opts(store, dirs), backend: today });
  }

  test("R516 T6 a fresh batch's confirmWarm uses the 2x rule: a replay at 0.75 x the budget is warm-timeout-unconfirmed, not a kill", async () => {
    const report = await freshWarmHang(1_500);
    expect(falseKills(report, 0)).toEqual([]);
    const first = scoredOf(report, 0)[0];
    expect([first?.verdict, first?.cause]).toEqual(["error", "warm-timeout-unconfirmed"]);
    expect(first?.failureNote).toContain(
      "completed unmutated in 1500 ms at position 2 of the replay, within its 2000 ms budget but more than half of it",
    );
  });

  test("R516 T6 control: a fresh warm hang whose replay passes at 0.4 x the budget is timeout-killed at position 2", async () => {
    const report = await freshWarmHang(800);
    const first = scoredOf(report, 0)[0];
    expect([first?.verdict, first?.killingTest, first?.killPosition]).toEqual([
      "timeout-killed",
      "BSlow",
      2,
    ]);
  });

  test("R514 the fail path is unchanged on a reused batch: a covered fail whose confirm passes is killed, the confirm sent at the budget", async () => {
    const today = new ClockBackend(YESTERDAY_MS);
    const inner = today.run.bind(today);
    today.run = async (ref, o) => {
      const v = await inner(ref, o);
      return today.active !== null && ref.method === "BSlow"
        ? { ...v, outcome: "fail", failureMessage: "R514 assertion" }
        : v;
    };
    const { report } = await sameBatchReuse(today);
    const scored = scoredOf(report, 0);
    expect(scored.length).toBeGreaterThan(0);
    for (const m of scored) expect([m.verdict, m.killingTest]).toEqual(["killed", "BSlow"]);
    expect(slowConfirms(today).map((s) => s.timeoutMs)).toEqual(scored.map(() => 2_000));
  });

  test("R514 the default-floor slow day: a confirm that overruns unmutated is a strand that latches the session, never a kill", async () => {
    // With the default --mutant-timeout-ms the confirm's deadline is the budget, and bcdev has no
    // stop hook for an unmutated run, so a test slower than the budget today is aborted:
    // in-flight-unknown. The same outcome a re-run baseline gives it (I2).
    const today = new ClockBackend(TODAY_MS);
    const inner = today.run.bind(today);
    today.run = async (ref, o) => {
      const v = await inner(ref, o);
      if (today.active !== null || ref.method !== "BSlow") return v;
      return {
        ref,
        outcome: "error",
        durationMs: 5,
        operation: "in-flight-unknown",
        failureMessage: "RunMutant timed out: AbortError",
      };
    };
    const { report } = await sameBatchReuse(today);
    expect(falseKills(report, 0)).toEqual([]);
    const stranded = scoredOf(report, 0).filter((m) => m.cause === "stranded");
    expect(stranded.map((m) => m.verdict)).toEqual(["error"]);
    expect(report.quarantined).toBeDefined();
  });

  test("R514 the cause's ripple: interpretation, banner and explain", async () => {
    expect(ERROR_CAUSE_INTERPRETATIONS["reused-budget-stale"].basis).toBe("R514");
    const today = new ClockBackend(1_500, { mutatedMs: 2_500 });
    const { report } = await sameBatchReuse(today);
    // R515: one stale mutant; the later one is re-budgeted from its confirm and survives.
    const stale = report.mutants.filter((m) => m.cause === "reused-budget-stale");
    expect(stale).toHaveLength(1);
    expect(renderConsole(report)).toContain(", reused-budget-stale 1])");
    const out = explain(report);
    expect(out.explainSchemaVersion).toBe(18);
    const rows = out.notMeasured.filter((n) => n.cause === "reused-budget-stale");
    expect(rows).toHaveLength(1);
    for (const r of rows) {
      expect(r.interpretation).toBe(ERROR_CAUSE_INTERPRETATIONS["reused-budget-stale"]);
    }
  });

  test("R516 the cause's ripple: timeout-unconfirmed's interpretation, banner and explain", async () => {
    const interp = ERROR_CAUSE_INTERPRETATIONS["timeout-unconfirmed"];
    expect(interp.basis).toBe("R516");
    // Scoped (I1) and both lost-kill bands named (I4).
    expect(interp.meaning).toContain("On bcdev and al-runner one-shot");
    expect(interp.meaning).toContain("compile plus body takes more than half the budget");
    expect(ERROR_CAUSE_INTERPRETATIONS["warm-timeout-unconfirmed"].meaning).toContain(
      "in more than half the budget",
    );
    const { report } = await freshDrift(TODAY_MS);
    expect(report.mutants.filter((m) => m.cause === "timeout-unconfirmed")).toHaveLength(1);
    expect(renderConsole(report)).toContain(", timeout-unconfirmed 1])");
    const out = explain(report);
    expect(out.explainSchemaVersion).toBe(EXPLAIN_SCHEMA_VERSION);
    const rows = out.notMeasured.filter((n) => n.cause === "timeout-unconfirmed");
    expect(rows).toHaveLength(1);
    for (const r of rows) expect(r.interpretation).toBe(interp);
  });

  test("R514 RUNNER_DISAGREEMENT_NOTE names the reuse route", () => {
    expect([
      RUNNER_DISAGREEMENT_NOTE.includes("--resume"),
      RUNNER_DISAGREEMENT_NOTE.includes("R192"),
    ]).toEqual([true, true]);
  });

  test("R514 control (c): the same day with a FRESH baseline measures BSlow at 5000 ms, budgets 10000 ms, and kills nothing", async () => {
    const dirs = await twoTestProject(false);
    const store = new ResultsStore(":memory:");
    const today = new ClockBackend(TODAY_MS);
    const report = await runSession({ ...opts(store, dirs), backend: today });
    expect(today.baselineRuns).toBeGreaterThan(0);
    expect(slowBudgets(today)).toEqual([2 * TODAY_MS]);
    expect(falseKills(report, 0)).toEqual([]);
  });

  // ---------------------------------------------------------------------------------------------
  // R516 / R515 (the repros, flipped, and the direction tests of plan r2).
  // ---------------------------------------------------------------------------------------------

  const verdictsOf = (report: SessionReport, batch: number) =>
    scoredOf(report, batch).map((m) => [m.mutantCode, m.verdict, m.cause ?? m.killingTest ?? null]);

  /** BSlow's mutated budgets in the order they were sent. */
  const slowBudgetsInOrder = (b: ClockBackend) =>
    b.sent.filter((s) => s.active && s.method === "BSlow").map((s) => s.timeoutMs);

  /**
   * Give `b`'s BSlow scripted unmutated durations: every run before the first mutated run (the
   * baseline) answers `baselineMs`; the n-th unmutated run after it (a confirm) answers
   * `confirmMs[n]`, or the backend's own figure once the list runs out. The run itself still goes
   * through `b` (so `sent` records it); only the reported duration is replaced.
   */
  function scriptBSlow(b: ClockBackend, s: { baselineMs?: number; confirmMs?: number[] }) {
    const inner = b.run.bind(b);
    let confirms = 0;
    b.run = async (ref, o) => {
      if (ref.method !== "BSlow" || b.active !== null) return inner(ref, o);
      if (b.mutantRuns === 0) {
        if (s.baselineMs === undefined) return inner(ref, o);
        const v = await inner(ref, { ...o, timeoutMs: Number.POSITIVE_INFINITY });
        return { ...v, durationMs: s.baselineMs };
      }
      const scripted = s.confirmMs?.[confirms];
      confirms += 1;
      const v = await inner(ref, o);
      return scripted === undefined || v.outcome !== "pass" ? v : { ...v, durationMs: scripted };
    };
    return b;
  }

  /** A fresh run whose baseline measures BSlow at 1000 ms (budget 2000); afterwards it takes
   *  `todayMs` unmutated and `mutatedMs` (default `todayMs`) under every mutant. */
  async function freshDrift(todayMs: number, mutatedMs?: number) {
    const dirs = await twoTestProject(false);
    const store = new ResultsStore(":memory:");
    const today = scriptBSlow(
      new ClockBackend(todayMs, mutatedMs !== undefined ? { mutatedMs } : {}),
      { baselineMs: YESTERDAY_MS },
    );
    const report = await runSession({ ...opts(store, dirs), backend: today });
    return { report, today };
  }

  test("R516 T1 (repro a): a FRESH baseline, BSlow slows past 2x inside the run: no kill; the timeout is confirmed unmutated and is timeout-unconfirmed, with both durations and their ratio", async () => {
    // The baseline measures BSlow at 1000 ms (budget 2000); later in the same run it takes 5000 ms
    // with or without a mutant.
    const { report, today } = await freshDrift(TODAY_MS);
    expect(falseKills(report, 0)).toEqual([]);
    // D4 (R515) re-budgets BSlow from the first confirm (2 x 5000), so the later mutants get
    // their real verdict (BSlow passes at 5000 under them) instead of a confirm each.
    expect(verdictsOf(report, 0)).toEqual([
      ["M0001", "error", "timeout-unconfirmed"],
      ["M0002", "survived", null],
      ["M0003", "survived", null],
    ]);
    expect(slowBudgetsInOrder(today)).toEqual([2_000, 10_000, 10_000]);
    expectConfirmsAtBaselineDeadline(today, 1);
    const note = scoredOf(report, 0)[0]?.failureNote ?? "";
    expect(note).toContain(
      "unmutated it completed in 5000 ms on this backend, more than half its 2000 ms budget, which was set from this run's baseline, 1000 ms; ratio 5000/1000 = 5.00",
    );
    expect(note).toContain("slower now than when its budget was set");
  });

  test("R516 T1b: fresh, BSlow 1000 at the baseline, 1500 unmutated later, 2500 mutated: timeout-unconfirmed (inside the budget, over half of it), never a kill", async () => {
    // A fresh-only 1x rule (`confirm > budget`) would score the confirm at 1500 <= 2000 a kill.
    const { report, today } = await freshDrift(1_500, 2_500);
    expect(falseKills(report, 0)).toEqual([]);
    expect(verdictsOf(report, 0)).toEqual([
      ["M0001", "error", "timeout-unconfirmed"],
      ["M0002", "survived", null],
      ["M0003", "survived", null],
    ]);
    // R515: after the 1500 ms confirm the budget is 3000, and BSlow passes at 2500 under a mutant.
    expect(slowBudgetsInOrder(today)).toEqual([2_000, 3_000, 3_000]);
    expectConfirmsAtBaselineDeadline(today, 1);
  });

  test("R516 T2 (repro b): workers = 2, the baseline measured on a fast tier sets budgets on a slower worker tier: no kill; the confirm runs on the slow worker", async () => {
    // The session backend (where the baseline runs) and worker 0 run BSlow in 1000 ms; worker 1's
    // tier runs it in 5000 ms, mutant or not. No mutant touches BSlow's time.
    const dirs = await twoTestProject(false);
    const store = new ResultsStore(":memory:");
    const session = new ClockBackend(YESTERDAY_MS, { authoritative: false });
    const workers = [
      new ClockBackend(YESTERDAY_MS, { authoritative: false }),
      new ClockBackend(TODAY_MS, { authoritative: false }),
    ];
    const report = await runSession({
      ...opts(store, dirs),
      backend: session,
      workers: 2,
      backendFactory: (i: number) => {
        const w = workers[i];
        if (w === undefined) throw new Error(`no worker backend ${i}`);
        return w;
      },
    });
    const [fast, slow] = workers;
    if (fast === undefined || slow === undefined) throw new Error("two workers expected");
    expect(session.baselineRuns).toBeGreaterThan(0);
    expect(slow.mutantRuns).toBeGreaterThan(0);
    expect(slowBudgets(slow)).toEqual([2_000]);
    expect(falseKills(report, 0)).toEqual([]);
    // The slow tier's mutant is the error; the fast tier's survive.
    expect(verdictsOf(report, 0)).toEqual([
      ["M0001", "survived", null],
      ["M0002", "error", "timeout-unconfirmed"],
      ["M0003", "survived", null],
    ]);
    // The confirm ran on worker 1 (the slow tier), at the baseline deadline; none on worker 0.
    expectConfirmsAtBaselineDeadline(slow, 1);
    expect(slowConfirms(fast)).toEqual([]);
  });

  test("R516 T3a (repro c reused): al-runner one-shot gives the test its whole budget in-run, so a 5.8% slower body under an unrelated mutant passes: survived, no confirm", async () => {
    // Yesterday: BSlow's body 8700 ms + 300 ms compile = 9000 ms wall, reused budget 18000. Before
    // R516 the in-run limit was floor(18000 / 2000) s = 9000 ms, so a 9100 ms body under an
    // unrelated mutant timed out, its confirm's wall clock (8900) passed R514's 2x rule, and it was
    // a false kill. Now the in-run limit is the budget (oneShotLimits, imported by this fake).
    const today = new ClockBackend(8_600, { mutatedMs: 9_100, alRunnerCompileMs: 300 });
    const dirs = await twoTestProject(false);
    const store = new ResultsStore(":memory:");
    await runSession({
      ...opts(store, dirs),
      backend: new ClockBackend(8_700, { abort: { after: 2 }, alRunnerCompileMs: 300 }),
    });
    const events: RunEvent[] = [];
    const report = await runSession({
      ...opts(store, dirs),
      backend: today,
      resume: "last",
      retryStranded: true,
      emit: [(e) => events.push(e)],
    });
    expect(reusedOf(events)).toHaveLength(1);
    expect(slowBudgets(today)).toEqual([18_000]);
    expect(falseKills(report, 0)).toEqual([]);
    expect(verdictsOf(report, 0)).toEqual([
      ["M0002", "survived", null],
      ["M0003", "survived", null],
    ]);
    expect(slowConfirms(today)).toEqual([]);
  });

  test("R516 T3b (repro c fresh): al-runner one-shot, a test whose body is within the sub-second remainder of its wall clock no longer times out under every mutant: survived, no confirm", async () => {
    // Fresh baseline: body 8600 + 300 compile = 8900 wall, budget 17800. Before R516 the in-run
    // limit was floor(17800 / 2000) s = 8000 ms < 8600, so every mutated run timed out though no
    // mutant touches BSlow. Now it is ceil(17800 / 1000) s = 18000 ms. (M5: this "no drift" shape
    // needs the floor not to bind, wall > floor / 2; this test's floor is 2000.)
    const dirs = await twoTestProject(false);
    const store = new ResultsStore(":memory:");
    const today = new ClockBackend(8_600, { alRunnerCompileMs: 300 });
    const report = await runSession({ ...opts(store, dirs), backend: today });
    expect(slowBudgets(today)).toEqual([17_800]);
    expect(falseKills(report, 0)).toEqual([]);
    expect(verdictsOf(report, 0)).toEqual([
      ["M0001", "survived", null],
      ["M0002", "survived", null],
      ["M0003", "survived", null],
    ]);
    expect(slowConfirms(today)).toEqual([]);
  });

  test("R516 T8: an al-runner-shaped genuine hang (compile 300 ms, body 800 ms) is timeout-killed after one confirm", async () => {
    // Baseline wall 1100, budget 2200 (the floor 2000 does not bind), in-run limit 3 s. Under every
    // mutant BSlow never ends; its confirm's wall clock is 1100, and 2 x 1100 <= 2200.
    const dirs = await twoTestProject(false);
    const store = new ResultsStore(":memory:");
    const today = new ClockBackend(800, {
      alRunnerCompileMs: 300,
      mutatedMs: Number.POSITIVE_INFINITY,
    });
    const report = await runSession({ ...opts(store, dirs), backend: today });
    const scored = scoredOf(report, 0);
    expect(scored.length).toBeGreaterThan(0);
    for (const m of scored) {
      expect([m.verdict, m.killingTest, m.killPosition]).toEqual(["timeout-killed", "BSlow", 1]);
    }
    expectConfirmsAtBaselineDeadline(today, scored.length);
  });

  test("R515 T4 (repro d): after one reused-budget-stale, a later mutant covered by BSlow gets a budget from the confirm (2 x 5000) and a real verdict", async () => {
    const today = new ClockBackend(TODAY_MS);
    const { report } = await sameBatchReuse(today);
    // The first scored mutant is reused-budget-stale (one confirm, 5000 ms); the next runs BSlow
    // at 10000 and survives (BSlow passes at 5000 under it).
    expect(verdictsOf(report, 0)).toEqual([
      ["M0002", "error", "reused-budget-stale"],
      ["M0003", "survived", null],
    ]);
    expect(slowBudgetsInOrder(today)).toEqual([2_000, 2 * TODAY_MS]);
    expect(slowConfirms(today)).toHaveLength(1);
  });

  /** Reused (R514's shape), BSlow 5000 ms unmutated today and hung under every mutant; the n-th
   *  confirm reports `confirmMs[n]`. */
  async function reusedHang(confirmMs: number[]) {
    const today = scriptBSlow(new ClockBackend(TODAY_MS, { mutatedMs: Number.POSITIVE_INFINITY }), {
      confirmMs,
    });
    const { report } = await sameBatchReuse(today);
    return { report, today };
  }

  test("R515 T9: a hang after a re-budget is still timeout-killed (never survived), judged against the 10000 ms it was sent", async () => {
    // M0002: budget 2000 (reused), confirm 5000 -> reused-budget-stale, BSlow re-budgeted to
    // 10000. M0003: hangs at 10000; its confirm reports 4900, and 2 x 4900 <= 10000.
    const { report, today } = await reusedHang([TODAY_MS, 4_900]);
    expect(verdictsOf(report, 0)).toEqual([
      ["M0002", "error", "reused-budget-stale"],
      ["M0003", "timeout-killed", "BSlow"],
    ]);
    expect(slowBudgetsInOrder(today)).toEqual([2_000, 10_000]);
    expectConfirmsAtBaselineDeadline(today, 2);
  });

  test("R515 T9 boundary: a second confirm of exactly half the budget (5000 of 10000) is timeout-killed (<=, not <)", async () => {
    const { report } = await reusedHang([TODAY_MS, 5_000]);
    expect(verdictsOf(report, 0)).toEqual([
      ["M0002", "error", "reused-budget-stale"],
      ["M0003", "timeout-killed", "BSlow"],
    ]);
  });

  test("R515 T9b: after a re-budget the stale cause follows the budget's source: timeout-unconfirmed (not reused-budget-stale), naming the confirm the budget came from", async () => {
    const { report } = await reusedHang([TODAY_MS, 5_200]);
    expect(verdictsOf(report, 0)).toEqual([
      ["M0002", "error", "reused-budget-stale"],
      ["M0003", "error", "timeout-unconfirmed"],
    ]);
    const note = scoredOf(report, 0)[1]?.failureNote ?? "";
    expect(note).toContain(
      "unmutated it completed in 5200 ms on this backend, more than half its 10000 ms budget, which was set from the confirm of mutant M0002, 5000 ms (R515); ratio 5200/5000 = 1.04",
    );
    // Ratio <= 1.25: the boundary-band wording.
    expect(note).toContain("R516's boundary band");
  });

  /** A fresh run, BSlow 4000 ms at the baseline (budget 8000) and hung under every mutant; the
   *  n-th confirm reports `confirmMs[n]`. */
  async function freshHang(confirmMs: number[]) {
    const dirs = await twoTestProject(false);
    const store = new ResultsStore(":memory:");
    const today = scriptBSlow(new ClockBackend(4_000, { mutatedMs: Number.POSITIVE_INFINITY }), {
      confirmMs,
    });
    const report = await runSession({ ...opts(store, dirs), backend: today });
    return { report, today };
  }

  test("R515 H: the re-budget keeps the LARGEST confirm measured (a faster later confirm never lowers a budget)", async () => {
    // M0001: confirm 4100 > half of 8000 -> timeout-unconfirmed; BSlow re-budgeted to 8200.
    // M0002: confirm 3000 -> kill; the stored 4100 stays, so M0003 is still sent 8200 (a
    // replace-with-the-latest map would send max(2 x max(4000, 3000), floor) = 8000).
    const { report, today } = await freshHang([4_100, 3_000, 3_000]);
    expect(verdictsOf(report, 0)).toEqual([
      ["M0001", "error", "timeout-unconfirmed"],
      ["M0002", "timeout-killed", "BSlow"],
      ["M0003", "timeout-killed", "BSlow"],
    ]);
    expect(slowBudgetsInOrder(today)).toEqual([8_000, 8_200, 8_200]);
  });

  test("R515 H: a confirm faster than the baseline never lowers a budget below twice the baseline", async () => {
    // M0001: confirm 3000 (below the 4000 baseline) -> kill. Every later budget stays 8000; a
    // budget taken from the confirm alone would be 6000.
    const { report, today } = await freshHang([3_000, 3_000, 3_000]);
    expect(verdictsOf(report, 0).map((v) => v[1])).toEqual([
      "timeout-killed",
      "timeout-killed",
      "timeout-killed",
    ]);
    expect(slowBudgetsInOrder(today)).toEqual([8_000, 8_000, 8_000]);
  });

  test("R515 T10: the re-budget is per shard: the slow tier re-budgets, the fast tier's budgets stay 2000", async () => {
    // Two carriers, so each worker gets more than one mutant. The baseline (session backend) and
    // worker 0 run BSlow in 1000 ms; worker 1 in 5000 ms, mutant or not.
    const dirs = await twoTestProject(true);
    const store = new ResultsStore(":memory:");
    const session = new ClockBackend(YESTERDAY_MS, { authoritative: false });
    const fast = new ClockBackend(YESTERDAY_MS, { authoritative: false });
    const slow = new ClockBackend(TODAY_MS, { authoritative: false });
    const workers = [fast, slow];
    const report = await runSession({
      ...opts(store, dirs),
      backend: session,
      workers: 2,
      backendFactory: (i: number) => {
        const w = workers[i];
        if (w === undefined) throw new Error(`no worker backend ${i}`);
        return w;
      },
    });
    expect(falseKills(report, 0)).toEqual([]);
    // The slow tier: its first mutated BSlow run is sent 2000, the rest 10000 (its own confirm).
    const slowSent = slowBudgetsInOrder(slow);
    expect(slowSent.length).toBeGreaterThan(1);
    expect(slowSent).toEqual([2_000, ...slowSent.slice(1).map(() => 2 * TODAY_MS)]);
    expectConfirmsAtBaselineDeadline(slow, 1);
    // The fast tier never saw a timeout: every budget it was sent is the baseline's 2000.
    const fastSent = slowBudgetsInOrder(fast);
    expect(fastSent.length).toBeGreaterThan(1);
    expect(fastSent).toEqual(fastSent.map(() => 2_000));
  });

  test("R516 T11 (M2): on the grouped path the confirm is judged against each method's budgetMs as sent, before and after a re-budget", async () => {
    // Reused, one method per call (every BSlow run at position 1). M0002 sends BSlow 2000, its
    // confirm reports 5000 (stale); M0003 sends BSlow 10000, hangs, its confirm reports 5200.
    const today = scriptBSlow(
      new ClockBackend(TODAY_MS, { grouped: true, mutatedMs: Number.POSITIVE_INFINITY }),
      { confirmMs: [TODAY_MS, 5_200] },
    );
    const sentMany: number[] = [];
    const many = today.runMany;
    if (many === undefined) throw new Error("grouped backend expected");
    today.runMany = async (o) => {
      for (const m of o.methods) {
        if (m.ref.method === "BSlow" && today.active !== null) sentMany.push(m.budgetMs);
      }
      return many(o);
    };
    const { report } = await sameBatchReuse(today, { maxMethodsPerCall: 1 });
    expect(sentMany).toEqual([2_000, 10_000]);
    const [m2, m3] = scoredOf(report, 0);
    expect([m2?.cause, m3?.cause]).toEqual(["reused-budget-stale", "timeout-unconfirmed"]);
    expect(m2?.failureNote).toContain(`more than half the ${sentMany[0]} ms budget`);
    expect(m3?.failureNote).toContain(`more than half its ${sentMany[1]} ms budget`);
  });

  /** I1's sequence, fresh: the baseline measures BSlow at 100 s (budget 200 s); BSlow times out
   *  under every mutant; its confirms report 105 s, then 103 s. */
  async function stopNotBudget(inRunStopIsBudget: boolean) {
    const dirs = await twoTestProject(false);
    const store = new ResultsStore(":memory:");
    const today = scriptBSlow(
      new ClockBackend(100_000, { mutatedMs: Number.POSITIVE_INFINITY, inRunStopIsBudget }),
      { baselineMs: 100_000, confirmMs: [105_000, 103_000, 103_000] },
    );
    const report = await runSession({ ...opts(store, dirs), backend: today });
    return { report, today };
  }

  test("R516 M3: a floor-sourced budget's boundary-band note names the floor, not twice the measured duration", async () => {
    // BSlow 900 at the baseline: 2 x 900 < the 2000 floor, so the budget is the floor. Hung under
    // the mutant; its confirm takes 1100 (over half of 2000; ratio 1100/900 = 1.22 <= 1.25).
    const dirs = await twoTestProject(false);
    const store = new ResultsStore(":memory:");
    const today = scriptBSlow(new ClockBackend(900, { mutatedMs: Number.POSITIVE_INFINITY }), {
      baselineMs: 900,
      confirmMs: [1_100],
    });
    const report = await runSession({ ...opts(store, dirs), backend: today });
    const first = scoredOf(report, 0)[0];
    expect([first?.verdict, first?.cause]).toEqual(["error", "timeout-unconfirmed"]);
    const note = first?.failureNote ?? "";
    expect(note).toContain("ratio 1100/900 = 1.22");
    expect(note).toContain(
      "R516's boundary band (the budget is the --mutant-timeout-ms floor and the test takes more than half of it)",
    );
    expect(note).not.toContain("twice its measured duration");
  });

  test("R516 I1: where the in-run stop is not the budget (al-runner --server), a confirm never re-budgets, so a later 103 s confirm is not judged against 2 x 105 s: no false kill", async () => {
    const { report, today } = await stopNotBudget(false);
    expect(falseKills(report, 0)).toEqual([]);
    expect(verdictsOf(report, 0)).toEqual([
      ["M0001", "error", "timeout-unconfirmed"],
      ["M0002", "error", "timeout-unconfirmed"],
      ["M0003", "error", "timeout-unconfirmed"],
    ]);
    expect(slowBudgetsInOrder(today)).toEqual([200_000, 200_000, 200_000]);
  });

  test("R516 I1 control: where the in-run stop IS the budget, R515 re-budgets from the 105 s confirm and the 103 s confirms are kills", async () => {
    const { report, today } = await stopNotBudget(true);
    expect(verdictsOf(report, 0)).toEqual([
      ["M0001", "error", "timeout-unconfirmed"],
      ["M0002", "timeout-killed", "BSlow"],
      ["M0003", "timeout-killed", "BSlow"],
    ]);
    expect(slowBudgetsInOrder(today)).toEqual([200_000, 210_000, 210_000]);
  });

  test("R516 M1: on a reused batch, a warm replay over half a budget R515 set from a confirm is warm-timeout-unconfirmed, not reused-budget-stale naming the reused run", async () => {
    // BSlow covers both carriers, AFast only `IsOverBudget`: `UnderLimit`'s mutants (scored first)
    // run BSlow at position 1, `IsOverBudget`'s run AFast then BSlow (R197: fewest members first).
    const coverOnlyLogic = (b: ClockBackend) => {
      const inner = b.run.bind(b);
      b.run = async (ref, o) => {
        const v = await inner(ref, o);
        if (ref.method !== "AFast" || v.coverage === undefined) return v;
        return {
          ...v,
          coverage: {
            granularity: "procedure" as const,
            entries: [{ objectType: "Codeunit", objectId: 79000, procedure: "IsOverBudget" }],
          },
        };
      };
      return b;
    };
    const dirs = await twoTestProject(true);
    const store = new ResultsStore(":memory:");
    await runSession({
      ...opts(store, dirs),
      backend: coverOnlyLogic(new ClockBackend(YESTERDAY_MS, { abort: { after: 2 } })),
    });
    const run1 = lastRun(store);
    const today = coverOnlyLogic(
      scriptBSlow(
        new ClockBackend(TODAY_MS, { grouped: true, mutatedMs: Number.POSITIVE_INFINITY }),
        { confirmMs: [TODAY_MS, 5_200] },
      ),
    );
    const report = await runSession({
      ...opts(store, dirs),
      backend: today,
      resume: "last",
      retryStranded: true,
    });
    // M0003: BSlow at position 1, confirm 5000 -> reused-budget-stale, BSlow re-budgeted to 10000
    // from that confirm. M0004: BSlow at position 2, the replay passes at 5200, over half of 10000.
    const [m3, m4] = scoredOf(report, 0);
    expect([m3?.mutantCode, m3?.cause]).toEqual(["M0003", "reused-budget-stale"]);
    expect([m4?.mutantCode, m4?.verdict, m4?.cause]).toEqual([
      "M0004",
      "error",
      "warm-timeout-unconfirmed",
    ]);
    expect(m4?.failureNote).toContain(
      "completed unmutated in 5200 ms at position 2 of the replay, within its 10000 ms budget but more than half of it",
    );
    expect(m4?.failureNote).not.toContain(`run ${run1}'s reused baseline`);
  });

  test("R516 T12 (M8): a fresh batch at the default floor, whose confirm overruns unmutated, is a strand that latches the session, never a kill", async () => {
    // No resume, the default --mutant-timeout-ms (180 000), BSlow 1000 at the baseline and hung
    // under a mutant. Its unmutated confirm answers in-flight-unknown (bcdev abandons an
    // unmutated run at its deadline: there is no stop for it).
    const dirs = await twoTestProject(false);
    const store = new ResultsStore(":memory:");
    const today = new ClockBackend(YESTERDAY_MS, { mutatedMs: Number.POSITIVE_INFINITY });
    const inner = today.run.bind(today);
    today.run = async (ref, o) => {
      const v = await inner(ref, o);
      if (today.active !== null || ref.method !== "BSlow" || today.mutantRuns === 0) return v;
      return {
        ref,
        outcome: "error",
        durationMs: 5,
        operation: "in-flight-unknown",
        failureMessage: "RunMutant timed out: AbortError",
      };
    };
    const { mutantTimeoutMs: _, ...defaultFloor } = opts(store, dirs);
    const report = await runSession({ ...defaultFloor, backend: today });
    expect(slowBudgetsInOrder(today)).toEqual([180_000]);
    expect(falseKills(report, 0)).toEqual([]);
    expect(report.mutants.filter((m) => m.verdict === "timeout-killed")).toEqual([]);
    const stranded = scoredOf(report, 0).filter((m) => m.cause === "stranded");
    expect(stranded.map((m) => m.verdict)).toEqual(["error"]);
    expect(report.quarantined).toBeDefined();
  });

  // ---------------------------------------------------------------------------------------------
  // R517: al-runner `--server`, the daemon's own stop.
  // ---------------------------------------------------------------------------------------------

  /** A fresh run on the `--server` shape at the default 180 000 ms floor: BSlow's body is `bodyMs`
   *  unmutated and `mutatedMs` under every mutant. */
  async function serverRun(
    bodyMs: number,
    server: NonNullable<ClockOptions["server"]>,
    mutatedMs: number,
  ) {
    const dirs = await twoTestProject(false);
    const store = new ResultsStore(":memory:");
    const today = new ClockBackend(bodyMs, { server, mutatedMs });
    const events: RunEvent[] = [];
    const report = await runSession({
      ...opts(store, dirs),
      mutantTimeoutMs: 180_000,
      backend: today,
      emit: [(e) => events.push(e)],
    });
    return { report, today, events };
  }
  /** R517 (M-a): the stop-mismatch warnings a run emitted. */
  const stopWarnings = (events: readonly RunEvent[]) =>
    events.flatMap((e) =>
      e.type === "warning" && e.code === "alrunner-stop-mismatch" ? [e.message] : [],
    );

  test("R517 M-a: a reported stop other than the configured one warns ONCE per session; a matching one never", async () => {
    const off = await serverRun(58_000, { restMs: 30_000, enforcedStopMs: 60_000 }, 61_000);
    expect(scoredOf(off.report, 0).length).toBeGreaterThan(1);
    expect(stopWarnings(off.events)).toEqual([
      expect.stringContaining(
        "al-runner reported a 60s stop although it was started with --test-timeout 180",
      ),
    ]);
    const same = await serverRun(1_000, { restMs: 94_000 }, Number.POSITIVE_INFINITY);
    expect(scoredOf(same.report, 0).every((m) => m.verdict === "timeout-killed")).toBe(true);
    expect(stopWarnings(same.events)).toEqual([]);
  });

  test("R517 I-2: reused --server, budget 260 s, stop 180 s, confirm body 100 s: timeout-unconfirmed naming the stop, never reused-budget-stale", async () => {
    // Yesterday BSlow took 130 s (budget 260 s). Today its body is 100 s (130 s wall) and 181 s
    // under every mutant, stopped at 180 s. 2 x 100 fits the budget but not the stop: re-measuring
    // the baseline would change nothing, so the stale-budget cause would send the reader astray.
    const dirs = await twoTestProject(false);
    const store = new ResultsStore(":memory:");
    const o = { ...opts(store, dirs), mutantTimeoutMs: 180_000 };
    await runSession({
      ...o,
      backend: new ClockBackend(130_000, { abort: { after: 2 }, server: { restMs: 0 } }),
    });
    const events: RunEvent[] = [];
    const today = new ClockBackend(100_000, { server: { restMs: 30_000 }, mutatedMs: 181_000 });
    const report = await runSession({
      ...o,
      backend: today,
      resume: "last",
      retryStranded: true,
      emit: [(e) => events.push(e)],
    });
    expect(reusedOf(events)).toHaveLength(1);
    expect(slowBudgets(today)).toEqual([260_000]);
    const scored = scoredOf(report, 0);
    expect(scored.length).toBeGreaterThan(0);
    expect(scored.map((m) => [m.verdict, m.cause])).toEqual(
      scored.map(() => ["error", "timeout-unconfirmed"]),
    );
    const note = scored[0]?.failureNote ?? "";
    expect(note).toContain("more than half the 180000 ms in-run stop al-runner reported");
    expect(note).toContain(
      "The test's own run (100000 ms) is more than half the 180000 ms in-run stop, which is below its budget; the stop is the larger of --mutant-timeout-ms and the baseline timeout, so raising --mutant-timeout-ms above twice this test's own run raises the stop and re-scores it",
    );
  });

  test("R517 S1: --server, BSlow body 58 s plus 30 s rest (budget 180 s), 61 s under an unrelated mutant: survived, never stopped at al-runner's own 60 s default", async () => {
    // Before R517 the daemon had no --test-timeout, so it stopped the body at 60 s; the confirm's
    // suite wall clock (88 s) passed 2 x 88 <= 180 and the mutant was a false timeout-killed.
    const { report, today } = await serverRun(58_000, { restMs: 30_000 }, 61_000);
    expect(slowBudgets(today)).toEqual([180_000]);
    expect(falseKills(report, 0)).toEqual([]);
    expect(verdictsOf(report, 0)).toEqual([
      ["M0001", "survived", null],
      ["M0002", "survived", null],
      ["M0003", "survived", null],
    ]);
    expect(slowConfirms(today)).toEqual([]);
  });

  test("R517 S2: --server, the stop (180 s) below the budget (260 s): an unrelated mutant stopped at 180 s whose confirm body is 100 s is timeout-unconfirmed, the note naming the stop", async () => {
    // Baseline: body 100 s + 30 s rest = 130 s, budget 260 s. Under the mutant the body is 181 s.
    // The old rule judged the confirm's 130 s suite wall clock against the budget: 260 <= 260, a
    // false kill. Now: 2 x 100 > min(260, 180).
    const { report } = await serverRun(
      100_000,
      { restMs: 30_000, enforcedStopMs: 180_000 },
      181_000,
    );
    expect(falseKills(report, 0)).toEqual([]);
    const scored = scoredOf(report, 0);
    expect(scored.map((m) => [m.verdict, m.cause])).toEqual(
      scored.map(() => ["error", "timeout-unconfirmed"]),
    );
    expect(scored[0]?.failureNote).toContain(
      "unmutated it completed in 100000 ms by its own figure (130000 ms wall clock) on this backend, more than half the 180000 ms in-run stop al-runner reported (below its 260000 ms budget, which was set from this run's baseline, 130000 ms)",
    );
  });

  test("R517 S3: --server, a genuine hang is still timeout-killed after exactly one unmutated confirm, judged on the body (1 s), not the suite (95 s)", async () => {
    // Baseline: body 1 s + 94 s rest = 95 s, budget 190 s, stop 180 s. Judged on the suite's wall
    // clock the confirm would be 2 x 95 > 180: a lost kill.
    const { report, today } = await serverRun(1_000, { restMs: 94_000 }, Number.POSITIVE_INFINITY);
    const scored = scoredOf(report, 0);
    expect(scored.length).toBeGreaterThan(0);
    for (const m of scored) {
      expect([m.verdict, m.killingTest, m.killPosition]).toEqual(["timeout-killed", "BSlow", 1]);
    }
    expect(slowConfirms(today)).toHaveLength(scored.length);
  });

  test("R517 S5 (a): the ENFORCED stop: a daemon configured at 180 s that reports 'Test exceeded 60s timeout.' is judged against 60 s: timeout-unconfirmed", async () => {
    // A build that takes --test-timeout but does not apply it. BSlow body 58 s + 30 s rest, budget
    // 180 s, 61 s under an unrelated mutant, stopped at 60 s. 2 x 58 > min(180, 60, 180).
    const { report, today } = await serverRun(
      58_000,
      { restMs: 30_000, enforcedStopMs: 60_000 },
      61_000,
    );
    expect(today.inRunStopMs).toBe(180_000);
    expect(falseKills(report, 0)).toEqual([]);
    const scored = scoredOf(report, 0);
    expect(scored.map((m) => [m.verdict, m.cause])).toEqual(
      scored.map(() => ["error", "timeout-unconfirmed"]),
    );
    expect(scored[0]?.failureNote).toContain("more than half the 60000 ms in-run stop");
  });

  test("R517 S5 (b): a timeout row whose stop does not parse, on a backend that declares inRunStopMs: a genuine hang stays timeout-unconfirmed", async () => {
    const { report } = await serverRun(
      1_000,
      { restMs: 1_000, reportedStopMs: null },
      Number.POSITIVE_INFINITY,
    );
    const scored = scoredOf(report, 0);
    expect(scored.length).toBeGreaterThan(0);
    expect(scored.map((m) => [m.verdict, m.cause])).toEqual(
      scored.map(() => ["error", "timeout-unconfirmed"]),
    );
    expect(scored[0]?.failureNote).toContain("al-runner did not say which stop it enforced");
  });

  test("R517 one-shot: a genuine hang whose confirm's COMPILE takes 65 s is timeout-killed, judged on its 1 s body (R516's lost-kill band)", async () => {
    // Baseline: body 1 s + 55 s compile = 56 s, budget the 120 s floor. Under the mutant BSlow
    // hangs and is stopped at 120 s. The confirm compiles in 65 s: wall 66 s, body 1 s. Judged on
    // the wall clock, 2 x 66 > 120 lost the kill.
    const dirs = await twoTestProject(false);
    const store = new ResultsStore(":memory:");
    const today = scriptBSlow(
      new ClockBackend(1_000, {
        alRunnerCompileMs: 55_000,
        mutatedMs: Number.POSITIVE_INFINITY,
      }),
      { confirmMs: [66_000, 66_000, 66_000] },
    );
    const report = await runSession({
      ...opts(store, dirs),
      mutantTimeoutMs: 120_000,
      backend: today,
    });
    // R515 then re-budgets from the confirm's wall clock (2 x 66 s), the safe direction.
    expect(slowBudgetsInOrder(today)).toEqual([120_000, 132_000, 132_000]);
    const scored = scoredOf(report, 0);
    expect(scored.length).toBeGreaterThan(0);
    for (const m of scored) {
      expect([m.verdict, m.killingTest, m.killPosition]).toEqual(["timeout-killed", "BSlow", 1]);
    }
  });

  test("R517 one-shot drift: a body that slowed from 1000 to 1500 ms unmutated (3500 mutated) is still timeout-unconfirmed when judged on the body, never a kill", async () => {
    // R516 T1b's shape on one-shot: baseline wall 1300 (body 1000 + compile 300), budget 2600,
    // in-run limit 3 s. The mutated body 3500 times out; the confirm's body is 1500: 2 x 1500 > 2600.
    const dirs = await twoTestProject(false);
    const store = new ResultsStore(":memory:");
    const today = scriptBSlow(
      new ClockBackend(1_500, { alRunnerCompileMs: 300, mutatedMs: 3_500 }),
      { baselineMs: 1_300 },
    );
    const report = await runSession({ ...opts(store, dirs), backend: today });
    expect(falseKills(report, 0)).toEqual([]);
    const [first] = scoredOf(report, 0);
    expect([first?.verdict, first?.cause]).toEqual(["error", "timeout-unconfirmed"]);
    expect(first?.failureNote).toContain(
      "unmutated it completed in 1500 ms by its own figure (1800 ms wall clock) on this backend, more than half its 2600 ms budget",
    );
  });

  // ---------------------------------------------------------------------------------------------
  // R534 S2: a timeout in the test codeunit's OnRun trigger is confirmed on the confirm's WALL
  // clock. al-runner's pass row reports the body only (measured: 66 ms beside a 4 s OnRun), so the
  // body figure would compare a mutated OnRun with an unmutated ~50 ms body: a false kill.
  // ---------------------------------------------------------------------------------------------

  /**
   * BSlow, decoded by al-runner's own `verdictFromRunnerTest`: under a mutant the OnRun-trigger
   * timeout row at 20 s (or, `rowMessage: null`, a hand-built timeout with no `timeoutIn`);
   * unmutated after the first mutant, a pass whose wall clock is `confirmWallMs` and whose body is
   * 50 ms. The baseline's BSlow takes 100 ms, so the budget is the 20 000 ms floor.
   */
  class OnRunClock extends ClockBackend {
    constructor(
      private readonly confirmWallMs: number,
      private readonly rowMessage: string | null,
    ) {
      super(100);
    }
    override async run(ref: TestMethodRef, o: RunOpts): Promise<TestVerdict> {
      const v = await super.run(ref, o);
      if (ref.method !== "BSlow") return v;
      if (this.active !== null) {
        if (this.rowMessage === null) {
          const { attestation: _, measuredDurationMs: __, ...rest } = v;
          return { ...rest, outcome: "timeout", durationMs: 20_000, reportedStopMs: 20_000 };
        }
        const row = { status: "error", message: this.rowMessage };
        return verdictFromRunnerTest(ref, "Codeunit79100.BSlow", row, 20_500, undefined);
      }
      if (this.mutantRuns === 0) return v;
      const confirm = { status: "pass", durationMs: 50 };
      return {
        ...verdictFromRunnerTest(
          ref,
          "Codeunit79100.BSlow",
          confirm,
          this.confirmWallMs,
          undefined,
        ),
        ...(v.attestation !== undefined ? { attestation: v.attestation } : {}),
      };
    }
  }
  const ONRUN_20 =
    "The test codeunit's OnRun trigger exceeded the 20s timeout, so none of its test methods ran.";
  async function onRunSession(confirmWallMs: number, rowMessage: string | null) {
    const dirs = await twoTestProject(false);
    const backend = new OnRunClock(confirmWallMs, rowMessage);
    const report = await runSession({
      ...opts(new ResultsStore(":memory:"), dirs),
      mutantTimeoutMs: 20_000,
      backend,
    });
    return { report, backend };
  }

  test("R534 S2: an OnRun timeout whose confirm takes 15 s of wall clock (body 50 ms) is timeout-unconfirmed, never a kill", async () => {
    const { report, backend } = await onRunSession(15_000, ONRUN_20);
    // The first budget is the floor; R515 then re-budgets from the confirm's wall (2 x 15 s).
    expect(slowBudgets(backend)[0]).toBe(20_000);
    expect(falseKills(report, 0)).toEqual([]);
    const scored = scoredOf(report, 0);
    expect(scored.length).toBeGreaterThan(0);
    expect(scored.map((m) => [m.verdict, m.cause])).toEqual(
      scored.map(() => ["error", "timeout-unconfirmed"]),
    );
    expect(scored[0]?.failureNote).toContain("al-runner does not report the OnRun's own time");
  });

  test("R534 S2 other direction: the same OnRun timeout whose confirm takes 5 s of wall clock is timeout-killed", async () => {
    const { report } = await onRunSession(5_000, ONRUN_20);
    const scored = scoredOf(report, 0);
    expect(scored.length).toBeGreaterThan(0);
    for (const m of scored) {
      expect([m.verdict, m.killingTest, m.killPosition]).toEqual(["timeout-killed", "BSlow", 1]);
    }
  });

  test("R534 S2 fail-closed: a timeout that does not say where it fired (no timeoutIn) is judged on the wall clock too", async () => {
    const { report } = await onRunSession(15_000, null);
    expect(falseKills(report, 0)).toEqual([]);
    const scored = scoredOf(report, 0);
    expect(scored.length).toBeGreaterThan(0);
    expect(scored.map((m) => [m.verdict, m.cause])).toEqual(
      scored.map(() => ["error", "timeout-unconfirmed"]),
    );
  });

  test("R517 wiring: useMutantBudgetFloor gets the floor and the baseline timeout before the first run, once per backend", async () => {
    const dirs = await twoTestProject(false);
    const byDefault = new ClockBackend(100, { server: { restMs: 0 } });
    await runSession({
      ...opts(new ResultsStore(":memory:"), dirs),
      mutantTimeoutMs: 180_000,
      backend: byDefault,
    });
    expect(byDefault.floorCalls).toEqual([
      { floorMs: 180_000, baselineTimeoutMs: 120_000, runsBefore: 0 },
    ]);
    const overridden = new ClockBackend(100, { server: { restMs: 0 } });
    await runSession({
      ...opts(new ResultsStore(":memory:"), dirs),
      baselineTimeoutMs: 5_000,
      backend: overridden,
    });
    expect(overridden.floorCalls).toEqual([
      { floorMs: FLOOR_MS, baselineTimeoutMs: 5_000, runsBefore: 0 },
    ]);
  });

  test("R517 wiring: under workers = 2 every worker backend gets the same pair, before its first run", async () => {
    const dirs = await twoTestProject(true);
    const session = new ClockBackend(100, { authoritative: false, server: { restMs: 0 } });
    const workers = [
      new ClockBackend(100, { authoritative: false, server: { restMs: 0 } }),
      new ClockBackend(100, { authoritative: false, server: { restMs: 0 } }),
    ];
    await runSession({
      ...opts(new ResultsStore(":memory:"), dirs),
      backend: session,
      workers: 2,
      backendFactory: (i: number) => {
        const w = workers[i];
        if (w === undefined) throw new Error(`no worker backend ${i}`);
        return w;
      },
    });
    const pair = { floorMs: FLOOR_MS, baselineTimeoutMs: 120_000, runsBefore: 0 };
    expect(session.floorCalls).toEqual([pair]);
    for (const w of workers) {
      expect(w.sent.length).toBeGreaterThan(0);
      expect(w.floorCalls).toEqual([pair]);
    }
  });
});

/**
 * R557 x R577: two remove-only filters on --resume, each of which ALONE refuses a kill. R557's
 * run-level trust (`runs.al_runner_names`) empties the carry of an untrusted al-runner run; R577's
 * row-level rule refuses an unmarked kill from a trusted one. The control carries.
 */
describe("R557 x R577: --resume on al-runner, each remove-only rule alone", () => {
  /** The al-runner shape (non-authoritative, test app proven from source) that kills. */
  class AlRunnerKills extends CountingBackend {
    readonly killsMustReproduce: boolean;
    /** R392: read only when non-authoritative. */
    readonly measurePredefinedSymbols = measuredV2_12;
    constructor(rule: boolean, abortAfter?: number) {
      super("fail", abortAfter);
      this.killsMustReproduce = rule;
      (this as { fetchPublishedAppPackage?: unknown }).fetchPublishedAppPackage = undefined;
    }
    override capabilities(): BackendCapabilities {
      return { ...super.capabilities(), kind: "al-runner", authoritative: false };
    }
  }
  /** Run 1 kills its first mutant (marked when `marked`), then strands; run 2 resumes it. */
  async function resume(o: { trusted: boolean; marked: boolean }) {
    const dirs = await makeProject();
    const store = new ResultsStore(":memory:");
    // The rule makes the first kill cost two mutated runs (the kill and its reproduction).
    const first = await runSession({
      backend: new AlRunnerKills(o.marked, o.marked ? 2 : 1),
      store,
      ...dirs,
      selectorIds,
    });
    expect(first.quarantined).toBeDefined();
    const prior = first.mutants.filter((m) => m.verdict === "killed");
    expect(prior).toHaveLength(1);
    expect(prior[0]?.killReproduced === true).toBe(o.marked);
    const runId = lastRun(store);
    if (!o.trusted) store.db.run("UPDATE runs SET al_runner_names = NULL WHERE id = ?", [runId]);
    const report = await runSession({
      backend: new AlRunnerKills(true),
      store,
      ...dirs,
      selectorIds,
      resume: "last",
      retryStranded: true,
    });
    expect(report.resumedFrom?.runId).toBe(runId);
    return report.mutants.filter((m) => m.carried === true && m.verdict === "killed").length;
  }

  test("(a) an UNTRUSTED run's MARKED kill is not carried (R557 alone)", async () => {
    expect(await resume({ trusted: false, marked: true })).toBe(0);
  });

  test("(b) a TRUSTED run's UNMARKED kill is not carried (R577 alone)", async () => {
    expect(await resume({ trusted: true, marked: false })).toBe(0);
  });

  test("(c) control: a TRUSTED run's MARKED kill is carried", async () => {
    expect(await resume({ trusted: true, marked: true })).toBe(1);
  });
});

/**
 * R557 C1. Before R557 al-runner was sent the AL name of a test like `"Space Step"`, selected
 * nothing, and the run recorded that test as a baseline `error` and its only-kills as survivors. A
 * prior run like that must not come back through `--skip-known-survivors`, `--resume` or a reused
 * baseline snapshot, or the fixed name is never sent and the false survivor stands.
 */
describe("R557: a pre-fix al-runner run's false misses never come back (C1)", () => {
  const NAMES_TESTS_AL = `codeunit 79100 "Sandbox Tests"
{
    Subtype = Test;

    [Test]
    procedure OverBudgetDetected()
    begin
    end;

    [Test]
    procedure "Space Step"()
    begin
    end;

    [Test]
    procedure Pond()
    begin
    end;
}
`;
  async function project() {
    const dirs = await makeProject();
    await Bun.write(join(dirs.testDir, "SandboxTests.Codeunit.al"), NAMES_TESTS_AL);
    return dirs;
  }
  const base = (store: ResultsStore, dirs: Awaited<ReturnType<typeof project>>) => ({
    store,
    ...dirs,
    selectorIds,
    stopHungSessions: true,
    mutantTimeoutMs: 2_000,
  });
  /** The al-runner shape: non-authoritative, so the session's backend kind is `al-runner`. */
  const alRunner = (abortAfter?: number) =>
    new ClockBackend(100, {
      authoritative: false,
      ...(abortAfter !== undefined ? { abort: { after: abortAfter } } : {}),
    });
  /** Rewrites one BASELINE row of `runId`, as a pre-fix al-runner run recorded it. */
  const markBaseline = (store: ResultsStore, runId: number, method: string, outcome: string) =>
    store.db.run(
      "UPDATE test_results SET outcome = ?, failure_message = 'selected no test in this run' WHERE run_id = ? AND mutant_row_id IS NULL AND method = ?",
      [outcome, runId, method],
    );
  const warned = (events: readonly RunEvent[], code: string) =>
    events.flatMap((e) => (e.type === "warning" && e.code === code ? [e.message] : []));
  const known = (r: SessionReport) => r.mutants.filter((m) => m.verdict === "known-survivor");

  async function history(
    recordedBackend: "al-runner" | "bcdev",
    method: string,
    outcome: string,
  ): Promise<{ survived: number; report: SessionReport; events: RunEvent[]; runId: number }> {
    const dirs = await project();
    const store = new ResultsStore(":memory:");
    const r1 = await runSession({ ...base(store, dirs), backend: alRunner() });
    const runId = lastRun(store);
    markBaseline(store, runId, method, outcome);
    // A bcdev run, as the store records one; everything else (test app, symbols) stays equal, so
    // only the backend can decide.
    if (recordedBackend === "bcdev") {
      store.db.run("UPDATE runs SET backend = 'bcdev' WHERE id = ?", [runId]);
    }
    const events: RunEvent[] = [];
    const report = await runSession({
      ...base(store, dirs),
      backend: alRunner(),
      skipKnownSurvivors: true,
      emit: [(e) => events.push(e)],
    });
    return { survived: r1.counts.survived, report, events, runId };
  }

  test("T8a: history: a latest al-runner run with `Space Step` as a baseline error skips nothing, and warns once by name", async () => {
    const h = await history("al-runner", "Space Step", "error");
    expect(h.survived).toBeGreaterThan(0);
    expect(known(h.report)).toEqual([]);
    const w = warned(h.events, "history-al-runner-test-names");
    expect(w).toHaveLength(1);
    expect(w[0]).toContain(`run ${h.runId}`);
    expect(w[0]).toContain("Space Step");
    expect(w[0]).toContain("R557");
  });

  test("T8b: history: a plain-name error, a renamed test that FAILED, or a bcdev run does not taint", async () => {
    for (const [recorded, method, outcome] of [
      ["al-runner", "Pond", "error"],
      ["al-runner", "Space Step", "fail"],
      ["bcdev", "Space Step", "error"],
    ] as const) {
      const h = await history(recorded, method, outcome);
      expect(known(h.report).length, `${method} ${outcome}`).toBe(h.survived);
      expect(warned(h.events, "history-al-runner-test-names")).toEqual([]);
    }
  });

  async function resumed(method: string) {
    const dirs = await project();
    const store = new ResultsStore(":memory:");
    // Three covering tests: the first mutant finishes (carryable), the next one hangs.
    await runSession({ ...base(store, dirs), backend: alRunner(3) });
    const runId = lastRun(store);
    markBaseline(store, runId, method, "error");
    const events: RunEvent[] = [];
    const report = await runSession({
      ...base(store, dirs),
      backend: alRunner(),
      resume: "last",
      retryStranded: true,
      emit: [(e) => events.push(e)],
    });
    return { report, events, runId };
  }

  test("T9a: --resume of an unfinished al-runner run with `Space Step` as a baseline error carries nothing, and warns", async () => {
    const r = await resumed("Space Step");
    expect(r.report.mutants.filter((m) => m.carried === true)).toEqual([]);
    const w = warned(r.events, "resume-al-runner-test-names");
    expect(w).toHaveLength(1);
    expect(w[0]).toContain(`run ${r.runId}`);
    expect(w[0]).toContain("Space Step");
  });

  test("T9b: --resume of a run whose only error is a plain name carries as before", async () => {
    const r = await resumed("Pond");
    expect(r.report.mutants.filter((m) => m.carried === true).length).toBeGreaterThan(0);
    expect(warned(r.events, "resume-al-runner-test-names")).toEqual([]);
  });

  /**
   * R557 (I1): a run row WITHOUT the R557 test-name mark (`runs.al_runner_names`), as every run
   * recorded before R557 is. The rows below hold no renamed `error` of their own, so only the mark
   * can refuse them: each is one of the three ways the review found past the renamed-error rule.
   */
  const unmark = (store: ResultsStore, runId: number) =>
    store.db.run("UPDATE runs SET al_runner_names = NULL WHERE id = ?", [runId]);
  const carriedOf = (r: SessionReport) => r.mutants.filter((m) => m.carried === true);
  /** The `resume-al-runner-test-names` warning that refuses the CARRY (not a snapshot). */
  const notCarried = (events: readonly RunEvent[]) =>
    warned(events, "resume-al-runner-test-names").filter((m) =>
      m.includes("its verdicts are not carried"),
    );

  /** A aborts, B resumes A and aborts too; C resumes B. `unmarked` simulates pre-R557 A and B. */
  async function resumeOfResume(unmarked: boolean) {
    const dirs = await project();
    const store = new ResultsStore(":memory:");
    await runSession({ ...base(store, dirs), backend: alRunner(3) });
    const a = lastRun(store);
    await runSession({
      ...base(store, dirs),
      backend: alRunner(3),
      resume: "last",
      retryStranded: true,
    });
    const b = lastRun(store);
    if (unmarked) {
      unmark(store, a);
      unmark(store, b);
    }
    const events: RunEvent[] = [];
    const report = await runSession({
      ...base(store, dirs),
      backend: alRunner(),
      resume: "last",
      retryStranded: true,
      emit: [(e) => events.push(e)],
    });
    return { report, events, b, store };
  }

  test("I1 (a): --resume of an UNMARKED resume of a resume carries nothing and warns, naming R53's stranded keys too", async () => {
    const r = await resumeOfResume(true);
    expect(r.store.baselineErrorMethods(r.b)).toEqual([]);
    expect(carriedOf(r.report)).toEqual([]);
    // The carry refusal (the snapshot refusal is pinned by its own test, "I1 (snapshot)").
    const w = notCarried(r.events);
    expect(w).toHaveLength(1);
    expect(w[0]).toContain(`run ${r.b}`);
    expect(w[0]).toContain("R557");
    // Minor 4: the empty carry drops stranded keys too, so a hang-capable mutant runs again.
    expect(w[0]).toContain("R53");
    // Minor 1: the banner says WHY nothing was carried, not "the prior run had no reusable verdict".
    expect(r.report.resumedFrom?.carryRefused).toContain("R557");
    const banner = renderConsole(r.report);
    expect(banner).toContain("Nothing was carried");
    expect(banner).toContain("R557");
    expect(banner).not.toContain("the prior run had no reusable verdict");
  });

  test("I1 (a) control: the same chain, MARKED (an R557 session), carries as before", async () => {
    const r = await resumeOfResume(false);
    expect(carriedOf(r.report).length).toBeGreaterThan(0);
    expect(warned(r.events, "resume-al-runner-test-names")).toEqual([]);
    expect(r.report.resumedFrom?.carryRefused).toBeUndefined();
  });

  /** A finished run with NO baseline rows (as a resume that carried every batch is), then a
   *  `--skip-known-survivors` session over it. */
  async function noBaselineHistory(unmarked: boolean, backend: "al-runner" | "bcdev") {
    const dirs = await project();
    const store = new ResultsStore(":memory:");
    const make = () => (backend === "al-runner" ? alRunner() : new ClockBackend(100));
    const r1 = await runSession({ ...base(store, dirs), backend: make() });
    const runId = lastRun(store);
    store.db.run("DELETE FROM test_results WHERE run_id = ? AND mutant_row_id IS NULL", [runId]);
    if (unmarked) unmark(store, runId);
    const events: RunEvent[] = [];
    const report = await runSession({
      ...base(store, dirs),
      backend: make(),
      skipKnownSurvivors: true,
      emit: [(e) => events.push(e)],
    });
    return { survived: r1.counts.survived, report, events, runId };
  }

  test("I1 (b): an UNMARKED finished al-runner run with no baseline rows serves no --skip-known-survivors, and warns", async () => {
    const h = await noBaselineHistory(true, "al-runner");
    expect(h.survived).toBeGreaterThan(0);
    expect(known(h.report)).toEqual([]);
    const w = warned(h.events, "history-al-runner-test-names");
    expect(w).toHaveLength(1);
    expect(w[0]).toContain(`run ${h.runId}`);
    expect(w[0]).toContain("R557");
  });

  test("I1 (b) controls: a MARKED al-runner run, and an UNMARKED bcdev run, lend their survivors", async () => {
    for (const [unmarked, backend] of [
      [false, "al-runner"],
      [true, "bcdev"],
    ] as const) {
      const h = await noBaselineHistory(unmarked, backend);
      expect(known(h.report).length, `${backend} unmarked=${unmarked}`).toBe(h.survived);
      expect(warned(h.events, "history-al-runner-test-names")).toEqual([]);
    }
  });

  /** Run 1 finishes; run 2 skips its survivors as known-survivor rows and is interrupted; run 3
   *  resumes run 2. `unmarked`: both are pre-R557 runs. */
  async function knownThenInterrupted(unmarked: boolean) {
    const dirs = await project();
    const store = new ResultsStore(":memory:");
    await runSession({ ...base(store, dirs), backend: alRunner() });
    const first = lastRun(store);
    await runSession({ ...base(store, dirs), backend: alRunner(), skipKnownSurvivors: true });
    const second = lastRun(store);
    const recordedKnown = (
      store.db
        .query("SELECT COUNT(*) AS n FROM mutants WHERE run_id = ? AND verdict = 'known-survivor'")
        .get(second) as { n: number }
    ).n;
    // Every mutant of this project survives, so run 2 has nothing left to execute and finishes;
    // the interruption is simulated by reopening it.
    store.db.run("UPDATE runs SET finished_at = NULL WHERE id = ?", [second]);
    if (unmarked) {
      unmark(store, first);
      unmark(store, second);
    }
    const events: RunEvent[] = [];
    const report = await runSession({
      ...base(store, dirs),
      backend: alRunner(),
      skipKnownSurvivors: true,
      resume: "last",
      retryStranded: true,
      emit: [(e) => events.push(e)],
    });
    return { report, events, second, recordedKnown };
  }

  test("I1 (c): known-survivor rows of an UNMARKED interrupted run are not carried by --resume", async () => {
    const r = await knownThenInterrupted(true);
    expect(r.recordedKnown).toBeGreaterThan(0);
    expect(carriedOf(r.report)).toEqual([]);
    expect(known(r.report)).toEqual([]);
    const w = notCarried(r.events);
    expect(w).toHaveLength(1);
    expect(w[0]).toContain(`run ${r.second}`);
  });

  test("I1 (c) control: the same rows of a MARKED run are carried", async () => {
    const r = await knownThenInterrupted(false);
    expect(r.recordedKnown).toBeGreaterThan(0);
    expect(carriedOf(r.report).length).toBeGreaterThan(0);
    expect(warned(r.events, "resume-al-runner-test-names")).toEqual([]);
  });

  /** Run 1 records batch 0's baseline snapshot and aborts; the snapshot then holds `method` as an
   *  `error`; run 2 resumes, where it would reuse that snapshot. */
  async function snapshotted(method: string) {
    const dirs = await project();
    const store = new ResultsStore(":memory:");
    await runSession({ ...base(store, dirs), backend: alRunner(3) });
    const runId = lastRun(store);
    const row = store.db
      .query("SELECT id, payload FROM baseline_snapshots WHERE run_id = ?")
      .get(runId) as { id: number; payload: string };
    const payload = (JSON.parse(row.payload) as BaselineObservationLike[]).map((o) =>
      o.ref.method === method ? { ...o, verdict: { ...o.verdict, outcome: "error" } } : o,
    );
    store.db.run("UPDATE baseline_snapshots SET payload = ? WHERE id = ?", [
      JSON.stringify(payload),
      row.id,
    ]);
    const today = alRunner();
    const events: RunEvent[] = [];
    await runSession({
      ...base(store, dirs),
      backend: today,
      resume: "last",
      retryStranded: true,
      emit: [(e) => events.push(e)],
    });
    return { events, runId, today };
  }
  interface BaselineObservationLike {
    readonly ref: TestMethodRef;
    readonly verdict: TestVerdict;
  }

  test("T10a: a snapshot with `Space Step` as an error is not reused: the baseline re-runs, and a warning names the snapshot", async () => {
    const s = await snapshotted("Space Step");
    expect(reusedOf(s.events)).toEqual([]);
    expect(s.today.baselineRuns).toBeGreaterThan(0);
    const w = warned(s.events, "resume-al-runner-test-names");
    expect(w).toHaveLength(1);
    expect(w[0]).toContain(`run ${s.runId}`);
    expect(w[0]).toContain("batch 0");
    expect(w[0]).toContain("Space Step");
  });

  test("T10b: a snapshot whose only error is a plain name is reused", async () => {
    const s = await snapshotted("Pond");
    expect(reusedOf(s.events)).toHaveLength(1);
    expect(warned(s.events, "resume-al-runner-test-names")).toEqual([]);
  });

  /** R557 (I1): run 1 records batch 0's snapshot and aborts; the snapshot is then moved to ANOTHER
   *  al-runner run (`findBaselineSnapshot` lends from any run) that is `marked` or not, with no
   *  error in it at all; run 2 resumes run 1, which is marked, so only the snapshot's own run can
   *  decide. */
  async function snapshotFromOtherRun(marked: boolean) {
    const dirs = await project();
    const store = new ResultsStore(":memory:");
    await runSession({ ...base(store, dirs), backend: alRunner(3) });
    const runId = lastRun(store);
    const row = store.getRun(runId);
    if (row === null || row.testAppHash === null || row.testAppDeps === null) {
      throw new Error("run 1 recorded no proven test app");
    }
    const other = store.createRun({
      testScope: [],
      coverageMode: row.coverageMode ?? "none",
      identityScheme: row.identityScheme,
      buildSymbols: [],
      projectPath: "/elsewhere",
      backend: "al-runner",
      appVersion: "0.0.0.0",
      testAppHash: row.testAppHash,
      testAppProven: true,
      testAppDeps: row.testAppDeps,
      ...(marked ? { alRunnerNames: true } : {}),
    });
    store.db.run("UPDATE baseline_snapshots SET run_id = ? WHERE run_id = ?", [other, runId]);
    const today = alRunner();
    const events: RunEvent[] = [];
    await runSession({
      ...base(store, dirs),
      backend: today,
      resume: "last",
      retryStranded: true,
      emit: [(e) => events.push(e)],
    });
    return { events, other };
  }

  test("I1 (snapshot): a snapshot whose run is an UNMARKED al-runner run is not reused, and a warning names it", async () => {
    const s = await snapshotFromOtherRun(false);
    expect(reusedOf(s.events)).toEqual([]);
    const w = warned(s.events, "resume-al-runner-test-names");
    expect(w).toHaveLength(1);
    expect(w[0]).toContain(`run ${s.other}`);
    expect(w[0]).toContain("R557");
  });

  test("I1 (snapshot) control: the same snapshot from a MARKED al-runner run is reused", async () => {
    const s = await snapshotFromOtherRun(true);
    expect(reusedOf(s.events)).toHaveLength(1);
    expect(warned(s.events, "resume-al-runner-test-names")).toEqual([]);
  });

  /** T11's backend: the al-runner shape whose baseline answers `Space Step` with `text`. */
  class UndecidedBackend extends ClockBackend {
    constructor(private readonly text: string) {
      super(100, { authoritative: false });
    }
    override async run(ref: TestMethodRef, opts: RunOpts): Promise<TestVerdict> {
      if (this.active === null && ref.method === "Space Step") {
        return {
          ref,
          outcome: "error",
          durationMs: 1,
          failureMessage: this.text,
          operation: "pre-dispatch-rejected",
        };
      }
      return super.run(ref, opts);
    }
  }

  test("the stop: AlRunnerTestNameError out of a baseline run stops the session before any mutant is scored", async () => {
    class Stops extends ClockBackend {
      constructor() {
        super(100, { authoritative: false });
      }
      override async run(ref: TestMethodRef, opts: RunOpts): Promise<TestVerdict> {
        if (ref.method === "Space Step") {
          throw new AlRunnerTestNameError([
            { alName: "Sandbox Tests.Space Step", sent: "Codeunit79100.Space_Step" },
          ]);
        }
        return super.run(ref, opts);
      }
    }
    const dirs = await project();
    const store = new ResultsStore(":memory:");
    const backend = new Stops();
    const p = runSession({ ...base(store, dirs), backend });
    await expect(p).rejects.toBeInstanceOf(AlRunnerTestNameError);
    expect(backend.mutantRuns).toBe(0);
    expect(
      store.db.query("SELECT COUNT(*) AS n FROM mutants WHERE verdict != 'known-survivor'").get(),
    ).toEqual({ n: 0 });
  });

  test("I3 wiring: runSession hands the session suite to the backend and to every worker (useSessionTests)", async () => {
    class Records extends ClockBackend {
      readonly calls: Array<[string[], string[]]> = [];
      constructor() {
        super(100, { authoritative: false });
      }
      useSessionTests(suite: readonly TestMethodRef[], undecided: readonly TestMethodRef[]): void {
        this.calls.push([suite.map((t) => t.method), undecided.map((t) => t.method)]);
      }
    }
    const dirs = await project();
    const session = new Records();
    const workers = [new Records(), new Records()];
    await runSession({
      ...base(new ResultsStore(":memory:"), dirs),
      backend: session,
      workers: workers.length,
      backendFactory: (i: number) => {
        const w = workers[i];
        if (w === undefined) throw new Error(`no worker backend ${i}`);
        return w;
      },
    });
    const suite: [string[], string[]] = [["OverBudgetDetected", "Space Step", "Pond"], []];
    expect(session.calls).toEqual([suite]);
    for (const w of workers) expect(w.calls).toEqual([suite]);
  });

  test("T11: a baseline holding an AL_RUNNER_UNDECIDED_ARM_MISSING error warns once, naming it; a plain error does not", async () => {
    for (const [text, expected] of [
      [`${AL_RUNNER_UNDECIDED_ARM_MISSING}: al-runner selected no test`, 1],
      ["al-runner exited 2", 0],
    ] as const) {
      const dirs = await project();
      const events: RunEvent[] = [];
      await runSession({
        ...base(new ResultsStore(":memory:"), dirs),
        backend: new UndecidedBackend(text),
        emit: [(e) => events.push(e)],
      });
      const w = warned(events, "al-runner-undecided-test-missing");
      expect(w, text).toHaveLength(expected);
      if (expected === 1) {
        expect(w[0]).toContain("Sandbox Tests.Space Step");
        expect(w[0]).not.toContain("Pond");
        expect(w[0]).toContain("R403");
      }
    }
  });
});
