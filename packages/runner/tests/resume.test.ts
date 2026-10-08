import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { IDENTITY_SCHEME } from "@lethal/schemata";
import type { MutantManifest, MutantManifestEntry } from "@lethal/schemata";
import { reserveAppVersion } from "../src/app-version";
import type { CompiledArtifact } from "../src/artifact";
import type {
  BackendCapabilities,
  BackendStatus,
  CoverageMode,
  ExecutionBackend,
  RunOpts,
  TestMethodRef,
  TestVerdict,
} from "../src/backend";
import type { MicrosoftMode } from "../src/digest-inputs";
import type { RunEvent } from "../src/events";
import { feedAttestation, runSession } from "../src/orchestrator";
import type { AttestationLedger } from "../src/orchestrator";
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
import { serializeKey } from "../src/selection";
import { ResultsStore } from "../src/store";
import type { MutantVerdictRow } from "../src/store";
import { characterize, recording, traceEvents } from "./helpers/characterize";
import type { Trace } from "./helpers/characterize";
import {
  servedIsInstalled,
  servesTestApp,
  testAppJson,
  testAppPackage,
} from "./helpers/proven-test-app";
import { scratchDirs } from "./helpers/scratch";

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
   *  is, so a run's test-app identity is proven. `null` is a failed read. */
  served: Uint8Array | null = testAppPackage();
  async fetchPublishedAppPackage(): Promise<Uint8Array | null> {
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
      recorded: { hash: "same", twins: null },
      current: { hash: "same", twins: new Set(), refused: new Set() },
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
  // under scheme 30.
  const PINNED = "b6299a652118ea68cfdc0cdb518cb0f595b476f50a0bec20c909b1afd786ed32";
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
    // Pinned by value so a bump is deliberate: 30 since R487 (every site the four hang-capable
    // operators mutate in an open `Integer` data item's code is hang-refused); 29 was R-300b
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
    // sites move twins). 32 is R509 (a temporary record's fields are typed); 31 is R-501's.
    expect(IDENTITY_SCHEME).toBe(32);
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
    // Controls: the same row onto an entry without the field still carries, and a kill on a
    // renamed member still carries (a kill is a measurement whatever attributed it).
    expect(carriedVerdictFor(index, base)?.verdict).toBe("no-coverage");
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
  afterEach(async () => {
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
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
   *  `null` is a failed read (identity unknown). */
  class PackageBackend extends CountingBackend {
    constructor(pkg: Uint8Array | null, abortFromDeploy?: number) {
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
          again(r, new PackageBackend(null), { resume: target(r.runId) }),
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
    const path = join(tmpdirSync(), "old.sqlite");
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
