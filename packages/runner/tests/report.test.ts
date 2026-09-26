import { describe, expect, test } from "bun:test";
import type { MutantManifestEntry } from "@lethal/schemata";
import type { AlRunnerCanaryResult } from "../src/al-runner-canary";
import type { RunEvent, RunEventInput } from "../src/events";
import { HANG_CAPABLE_EXPLANATIONS } from "../src/hang-capable";
import type { PermissionCanaryResult } from "../src/permission-canary";
import { buildReport, renderConsole } from "../src/report";
import type { Caveat, SessionReport } from "../src/report";
import type { FoldStatics } from "../src/report-fold";
import { identityKeyOf, serializeKey } from "../src/selection";

// ————————————————————————————————————————————————————————————————————————
// R7/R8: `renderConsole` repeats the al-runner canary's measured verdict at the END of the
// printed report (after the score line), not just once at session start via console.warn
// (`announceAlRunnerCanary`, cli.ts) — the end of a long run is where a reader actually is.
// Reverting this addition (i.e. `renderConsole` ignoring `r.alRunnerCanary` entirely) would fail
// every test below asserting the R7/R8 lines appear in its output.
// ————————————————————————————————————————————————————————————————————————
describe("renderConsole — al-runner canary reiteration (R7/R8)", () => {
  const baseReport: SessionReport = {
    schemaVersion: 2,
    validity: {
      reliability: "full" as const,
      caveats: [],
      scoreDescribes: "test fixture",
      baselineTests: { total: 0, failing: 0 },
      scoredMutants: { scored: 0, recorded: 0 },
      // R60/R69 Phase 2: one entry per execution path actually used; always non-empty.
      executionContexts: [
        {
          runner: "fenced",
          guiAllowed: false,
          clientType: "ODataV4",
          basis: "test fixture",
          verdictCount: 0,
        },
      ],
    },
    survivorsByProcedure: [],
    testFiles: {},
    backend: "al-runner",
    authoritative: false,
    baselineGreen: true,
    batches: 1,
    counts: {
      killed: 1,
      survived: 1,
      noCoverage: 0,
      timeoutKilled: 0,
      knownSurvivors: 0,
      unstable: 0,
      errors: 0,
      deadlineExceeded: 0,
    },
    mutationScore: 0.5,
    mutants: [],
    unsupportedTests: [],
    notInstrumented: { totalFiles: 0, fileCount: 0, siteCount: 0, files: [] },
    declarativeSites: { siteCount: 0, fileCount: 0, files: [] },
    timings: {
      totalMs: 0,
      generateMutationSetMs: 0,
      deployMs: 0,
      baselineMs: 0,
      mutantsMs: 0,
      perMutant: { count: 0, meanMs: 0, medianMs: 0, p95Ms: 0, maxMs: 0 },
    },
    preprocessorSymbols: [],
    unplaceableCount: 0,
    unplaceableMutants: [],
    untargetedTriggerCount: 0,
  };

  test("appends both canary lines after the score when the backend is non-authoritative and a canary result is present", () => {
    const canary: AlRunnerCanaryResult = {
      asserterror: "defect-confirmed",
      tableGlobalVar: "defect-not-reproduced",
      transactionRollback: "defect-not-reproduced",
    };
    const out = renderConsole({ ...baseReport, alRunnerCanary: canary });
    const scoreLineIdx = out.split("\n").findIndex((l) => l.startsWith("score:"));
    const r7LineIdx = out.split("\n").findIndex((l) => l.includes("R7"));
    const r8LineIdx = out.split("\n").findIndex((l) => l.includes("R8"));
    expect(scoreLineIdx).toBeGreaterThanOrEqual(0);
    expect(r7LineIdx).toBeGreaterThan(scoreLineIdx);
    expect(r8LineIdx).toBeGreaterThan(scoreLineIdx);
    expect(out).toContain("CONFIRMED");
    expect(out).toContain("did NOT reproduce");
  });

  test("omits the reiteration entirely when no canary result is present (bcdev session, or the al-runner no-alRunnerPath fallback)", () => {
    const out = renderConsole(baseReport);
    expect(out).not.toContain("R7");
    expect(out).not.toContain("R8");
    expect(out).not.toContain("canary");
  });

  test("omits the reiteration on an authoritative (bcdev) report even if alRunnerCanary were somehow set", () => {
    const canary: AlRunnerCanaryResult = {
      asserterror: "defect-confirmed",
      tableGlobalVar: "defect-confirmed",
      transactionRollback: "defect-not-reproduced",
    };
    const out = renderConsole({ ...baseReport, authoritative: true, alRunnerCanary: canary });
    expect(out).not.toContain("R7");
    expect(out).not.toContain("R8");
  });

  test("inconclusive verdicts still print something (never silently dropped)", () => {
    const canary: AlRunnerCanaryResult = {
      asserterror: "inconclusive",
      tableGlobalVar: "inconclusive",
      transactionRollback: "defect-not-reproduced",
      asserterrorDetail: "spawn ENOENT",
      tableGlobalVarDetail: "spawn ENOENT",
    };
    const out = renderConsole({ ...baseReport, alRunnerCanary: canary });
    expect(out).toContain("could not determine");
    expect(out).toContain("spawn ENOENT");
  });
});

// ————————————————————————————————————————————————————————————————————————
// R26: `renderConsole` repeats the PERMISSION canary's measured verdict after the score, for the
// same reason the al-runner canary is repeated — it is announced once, right after the lease is
// acquired and before the first mutant, which on a real session is many minutes and a whole mutant
// table before the number it qualifies. Reverting the addition (i.e. `renderConsole` ignoring
// `r.permissionCanary`) reddens every test below.
// ————————————————————————————————————————————————————————————————————————
describe("renderConsole — permission canary reiteration (R26)", () => {
  // A bcdev/authoritative base report: unlike the al-runner canary, this one belongs on an
  // AUTHORITATIVE report — the permission mock is a property of the fenced (bcdev) path.
  const bcdevReport: SessionReport = {
    schemaVersion: 2,
    validity: {
      reliability: "full" as const,
      caveats: [],
      scoreDescribes: "test fixture",
      baselineTests: { total: 0, failing: 0 },
      scoredMutants: { scored: 0, recorded: 0 },
      // R60/R69 Phase 2: one entry per execution path actually used; always non-empty.
      executionContexts: [
        {
          runner: "fenced",
          guiAllowed: false,
          clientType: "ODataV4",
          basis: "test fixture",
          verdictCount: 0,
        },
      ],
    },
    survivorsByProcedure: [],
    testFiles: {},
    backend: "bcdev",
    authoritative: true,
    baselineGreen: true,
    batches: 1,
    counts: {
      killed: 3,
      survived: 10,
      noCoverage: 3,
      timeoutKilled: 0,
      knownSurvivors: 0,
      unstable: 0,
      errors: 0,
      deadlineExceeded: 0,
    },
    mutationScore: 3 / 13,
    mutants: [],
    unsupportedTests: [],
    notInstrumented: { totalFiles: 0, fileCount: 0, siteCount: 0, files: [] },
    declarativeSites: { siteCount: 0, fileCount: 0, files: [] },
    timings: {
      totalMs: 0,
      generateMutationSetMs: 0,
      deployMs: 0,
      baselineMs: 0,
      mutantsMs: 0,
      perMutant: { count: 0, meanMs: 0, medianMs: 0, p95Ms: 0, maxMs: 0 },
    },
    preprocessorSymbols: [],
    unplaceableCount: 0,
    unplaceableMutants: [],
    untargetedTriggerCount: 0,
  };

  test("appends the mocked warning AFTER the score on an authoritative report", () => {
    const canary: PermissionCanaryResult = {
      verdict: "mocked",
      readPermission: false,
      writePermission: false,
      insertSucceeded: false,
      detail: "Sorry, the current permissions prevented the action.",
    };
    const out = renderConsole({ ...bcdevReport, permissionCanary: canary });
    const lines = out.split("\n");
    const scoreLineIdx = lines.findIndex((l) => l.startsWith("score:"));
    const canaryLineIdx = lines.findIndex((l) => l.includes("R26"));
    expect(scoreLineIdx).toBeGreaterThanOrEqual(0);
    expect(canaryLineIdx).toBeGreaterThan(scoreLineIdx);
    // R26 after the R1 correction: a `mocked` verdict now reports a VIOLATED PRECONDITION (the
    // platform stripping even a codeunit that declares `TestPermissions = Disabled`), not the
    // disproved fenced-path-vs-mock story. The consequence line is unchanged — such mutants are
    // still silently unscored.
    expect(out).toContain("PRECONDITION VIOLATED");
    expect(out).toContain("TestPermissions = Disabled");
    expect(out).toContain("UNSCORED");
  });

  test("not-mocked is reported too — silence would be indistinguishable from 'nobody looked'", () => {
    const canary: PermissionCanaryResult = {
      verdict: "not-mocked",
      readPermission: true,
      writePermission: true,
      insertSucceeded: true,
    };
    const out = renderConsole({ ...bcdevReport, permissionCanary: canary });
    expect(out).toContain("R26");
    expect(out).toContain("CAN write its own app's tables");
    // The weaker, honest claim: a clean canary confirms the SERVER's precondition and says nothing
    // about any particular target suite, whose own `TestPermissions` decides that.
    expect(out).toContain("says nothing about any particular target suite");
  });

  test("inconclusive prints its reason AND explicitly disclaims being 'not mocked'", () => {
    const canary: PermissionCanaryResult = {
      verdict: "inconclusive",
      detail: "HTTP 404 — the published LethAL Control app has no PermissionCanary action",
    };
    const out = renderConsole({ ...bcdevReport, permissionCanary: canary });
    expect(out).toContain("could not determine");
    expect(out).toContain("HTTP 404");
    expect(out).toContain('NOT the same as "not mocked"');
  });

  test("omits the reiteration entirely when no permission canary ran", () => {
    const out = renderConsole(bcdevReport);
    expect(out).not.toContain("R26");
    expect(out).not.toContain("permission canary");
  });
});

// ————————————————————————————————————————————————————————————————————————
// `Caveat` union (prerequisite refactor for `lethal explain`): `caveats` used to be a free
// `readonly string[]` — a typo at a `caveats.push(...)` call site would silently never match a
// consumer's check. This is a COMPILE-TIME check, not a runtime one: `all` below must list every
// member of `Caveat` or `tsc` refuses to build (excess/missing keys against `Record<Caveat, true>`).
// The `toBe(15)` assertion is a weak backstop by comparison — it would not catch two members
// silently swapped for each other — but it does pin the count against silent growth/shrinkage of
// the union without a matching update here.
// ————————————————————————————————————————————————————————————————————————
describe("Caveat union", () => {
  test("every caveat the report can push is a member of the union", () => {
    // Compile-time: this object must be exhaustive over `Caveat` or tsc fails.
    const all: Record<Caveat, true> = {
      "baseline-red": true,
      narrowed: true,
      "operator-narrowed": true,
      "line-narrowed": true,
      "tests-narrowed": true,
      "uninstrumentable-files": true,
      "stale-test-app": true,
      "tests-permission-refused": true,
      "tests-testpage-unsupported": true,
      "runner-disagreement": true,
      "stop-hung-sessions": true,
      resumed: true,
      "untargeted-triggers": true,
      "attribution-unplaceable": true,
      "platform-artifact-kills": true,
      "kills-without-assertion": true,
      "declarative-sites-dropped": true,
      "all-errors": true,
      "session-warm": true,
    };
    expect(Object.keys(all).length).toBe(19);
  });
});

// ------------------------------------------------------------------------
// R196: `hangCapable` is a SITE property, exactly like `platformKillMechanism` (R72): it comes off
// `MutantManifestEntry` and never off the outcome, so it is present on the mutant whatever its
// verdict. These tests pin the same shape: a manifest entry carrying the tag has it on the built
// report row, and one without it omits the KEY entirely (not `undefined` under it, the schema
// distinguishes "absent" from "present but empty").
// ------------------------------------------------------------------------
describe("buildReport: hangCapable travels the site property path (R196)", () => {
  const STATICS: FoldStatics = {
    caps: { authoritative: true, coverage: "none", deploy: "publish", isolation: "session" },
  };

  function seq(events: readonly RunEventInput[]): RunEvent[] {
    return events.map((e, i) => ({ ...e, seq: i + 1 }) as RunEvent);
  }

  function mutant(id: string, over: Partial<MutantManifestEntry> = {}): MutantManifestEntry {
    return {
      mutantId: id,
      file: "Al/Codeunit/Codeunit 50100 Sales Helper.al",
      startIndex: 100,
      endIndex: 140,
      startLine: 10,
      operatorName: "lethal.remove-assignment",
      operatorVersion: "1.0.0",
      astHash: `hash-${id}`,
      objectType: "codeunit",
      codeunitId: 50100,
      codeunitName: "Sales Helper",
      procedureName: "ComputeTotal",
      procedureScope: "public",
      originalText: "Counter := Counter + 1;",
      mutatedText: "",
      ...over,
    };
  }

  test("an outcome built from a manifest entry carrying hangCapable has it on the report row", () => {
    const events = seq([
      {
        type: "mutation-set-generated",
        siteCount: 1,
        deployedCount: 1,
        hangCapableCount: 0,
        totalFiles: 1,
        instrumentableFiles: 1,
        notInstrumentedFiles: [],
        declarativeSiteFiles: [],
        excludedByOnly: 0,
        excludedByExclude: 0,
        excludedByOperator: 0,
      },
      { type: "baseline-batch-finished", batchIndex: 0, verdicts: [] },
      {
        type: "mutant-scored",
        mutant: mutant("M0001", { hangCapable: "loop-condition-target" }),
        verdict: "timeout-killed",
        batchIndex: 0,
        durationMs: 180_000,
        coveringTests: [],
      },
      { type: "session-finished", elapsedMs: 180_000 },
    ]);
    const report = buildReport(STATICS, events);
    expect(report.mutants).toHaveLength(1);
    const [row] = report.mutants;
    if (row === undefined) throw new Error("buildReport dropped the only mutant");
    expect(row.hangCapable).toBe("loop-condition-target");
  });

  test("an outcome built from a manifest entry without hangCapable omits the key entirely", () => {
    const events = seq([
      {
        type: "mutation-set-generated",
        siteCount: 1,
        deployedCount: 1,
        hangCapableCount: 0,
        totalFiles: 1,
        instrumentableFiles: 1,
        notInstrumentedFiles: [],
        declarativeSiteFiles: [],
        excludedByOnly: 0,
        excludedByExclude: 0,
        excludedByOperator: 0,
      },
      { type: "baseline-batch-finished", batchIndex: 0, verdicts: [] },
      {
        type: "mutant-scored",
        mutant: mutant("M0002"),
        verdict: "killed",
        batchIndex: 0,
        durationMs: 500,
        coveringTests: [],
        killingTest: "Sales Helper Tests.T1",
      },
      { type: "session-finished", elapsedMs: 500 },
    ]);
    const report = buildReport(STATICS, events);
    expect(report.mutants).toHaveLength(1);
    const [row] = report.mutants;
    if (row === undefined) throw new Error("buildReport dropped the only mutant");
    expect("hangCapable" in row).toBe(false);
  });

  test("the enclosing member's line span rides the same site path, and is absent when the entry lacks it (C02-01)", () => {
    const events = seq([
      {
        type: "mutation-set-generated",
        siteCount: 2,
        deployedCount: 2,
        hangCapableCount: 0,
        totalFiles: 1,
        instrumentableFiles: 1,
        notInstrumentedFiles: [],
        declarativeSiteFiles: [],
        excludedByOnly: 0,
        excludedByExclude: 0,
        excludedByOperator: 0,
      },
      { type: "baseline-batch-finished", batchIndex: 0, verdicts: [] },
      {
        type: "mutant-scored",
        mutant: mutant("M0001", { procedureStartLine: 3, procedureEndLine: 8 }),
        verdict: "survived",
        batchIndex: 0,
        durationMs: 500,
        coveringTests: [],
      },
      {
        type: "mutant-scored",
        mutant: mutant("M0002"),
        verdict: "survived",
        batchIndex: 0,
        durationMs: 500,
        coveringTests: [],
      },
      { type: "session-finished", elapsedMs: 1_000 },
    ]);
    const report = buildReport(STATICS, events);
    const byId = new Map(report.mutants.map((m) => [m.mutantCode, m]));
    const spanned = byId.get("M0001");
    const bare = byId.get("M0002");
    if (spanned === undefined || bare === undefined)
      throw new Error("buildReport dropped a mutant");
    expect({ start: spanned.procedureStartLine, end: spanned.procedureEndLine }).toEqual({
      start: 3,
      end: 8,
    });
    expect("procedureStartLine" in bare).toBe(false);
    expect("procedureEndLine" in bare).toBe(false);
  });

  // ----------------------------------------------------------------------
  // C02-01 Task 2: `equivalenceRisk` and `readerMark` are decided per ROW. Mutant ids restart per
  // batch, so two batches can both hold an `M0001`, and the run-level lists keyed by bare
  // `mutantCode` cannot say which batch they mean (R231). Operator facts are registry literals:
  // `lethal.remove-assignment` declares `value-rewrite`, `lethal.negate-conditional` declares none.
  // ----------------------------------------------------------------------
  describe("per-row equivalenceRisk and readerMark (C02-01)", () => {
    const B0 = mutant("M0001", { astHash: "hash-b0" });
    const B1 = mutant("M0001", { astHash: "hash-b1", operatorName: "lethal.negate-conditional" });
    // A trigger row: its `procedureName` is "" and its member is named by `triggerName`.
    const TRIGGER = mutant("M0002", {
      astHash: "hash-trg",
      procedureName: "",
      triggerName: "OnInsert",
    });
    const KILLED = mutant("M0003", { astHash: "hash-killed" });
    const KEY_B1 = serializeKey(identityKeyOf(B1));
    const KEY_KILLED = serializeKey(identityKeyOf(KILLED));
    // Today's `??` key for the trigger row, i.e. the way the RUN-LEVEL list keys it: the procedure
    // field is "" because `"" ?? triggerName` never reaches `triggerName`. This is R229's BUG, not
    // the correct identity. R229's fix changes this constant to `serializeKey(identityKeyOf(TRIGGER))`;
    // a test that reads it as the right key would obstruct that fix.
    const LEGACY_R229_TRIGGER_KEY = serializeKey({ ...identityKeyOf(TRIGGER), procedureName: "" });
    const STALE_KEY = serializeKey(identityKeyOf(mutant("M0009", { astHash: "hash-gone" })));
    const MARKS = [
      { key: KEY_B1, reason: "R-b1" },
      { key: LEGACY_R229_TRIGGER_KEY, reason: "R-trg" },
      { key: KEY_KILLED, reason: "R-killed" },
      { key: STALE_KEY, reason: "R-stale" },
    ];

    function scored(
      m: MutantManifestEntry,
      batchIndex: number,
      verdict: "survived" | "killed" | "known-survivor",
    ): RunEventInput {
      return {
        type: "mutant-scored",
        mutant: m,
        verdict,
        batchIndex,
        durationMs: 500,
        coveringTests: [],
        ...(verdict === "killed" ? { killingTest: "Sales Helper Tests.T1" } : {}),
      };
    }

    function setGenerated(n: number): RunEventInput {
      return {
        type: "mutation-set-generated",
        siteCount: n,
        deployedCount: n,
        hangCapableCount: 0,
        totalFiles: 1,
        instrumentableFiles: 1,
        notInstrumentedFiles: [],
        declarativeSiteFiles: [],
        excludedByOnly: 0,
        excludedByExclude: 0,
        excludedByOperator: 0,
      };
    }

    // Two batches, both holding an `M0001`, each batch with its own baseline.
    const TWO_BATCH_EVENTS = seq([
      setGenerated(4),
      { type: "baseline-batch-finished", batchIndex: 0, verdicts: [] },
      scored(B0, 0, "survived"),
      scored(KILLED, 0, "killed"),
      { type: "baseline-batch-finished", batchIndex: 1, verdicts: [] },
      scored(B1, 1, "survived"),
      scored(TRIGGER, 1, "survived"),
      { type: "session-finished", elapsedMs: 2_000 },
    ]);

    test("two batches reusing M0001 keep their own risk and mark (C02-01)", () => {
      const report = buildReport(
        { ...STATICS, equivalenceMarks: [{ key: KEY_B1, reason: "R-b1" }] },
        TWO_BATCH_EVENTS,
      );
      const row = (b: number) =>
        report.mutants.find((m) => m.batchIndex === b && m.mutantCode === "M0001");
      expect(row(0)).toBeDefined();
      expect(row(1)).toBeDefined();
      expect(row(0)?.equivalenceRisk).toBe("value-rewrite");
      expect("readerMark" in (row(0) ?? {})).toBe(false);
      expect("equivalenceRisk" in (row(1) ?? {})).toBe(false);
      expect(row(1)?.readerMark).toEqual({ key: KEY_B1, reason: "R-b1" });
    });

    test("a killed row whose identity is marked carries no readerMark, and a killed risk row no risk (C02-01)", () => {
      const survivor = mutant("M0002", { astHash: "hash-ks" });
      const KEY_KS = serializeKey(identityKeyOf(survivor));
      const report = buildReport(
        {
          ...STATICS,
          equivalenceMarks: [
            { key: KEY_KILLED, reason: "R-killed" },
            { key: KEY_KS, reason: "R-ks" },
          ],
        },
        seq([
          setGenerated(2),
          { type: "baseline-batch-finished", batchIndex: 0, verdicts: [] },
          scored(mutant("M0001", { astHash: "hash-killed" }), 0, "killed"),
          scored(survivor, 0, "known-survivor"),
          { type: "session-finished", elapsedMs: 1_000 },
        ]),
      );
      const byId = new Map(report.mutants.map((m) => [m.mutantCode, m]));
      const killed = byId.get("M0001");
      const known = byId.get("M0002");
      if (killed === undefined || known === undefined)
        throw new Error("buildReport dropped a mutant");
      // Risk is `survived`-only, like the run-level list: the known-survivor row is checked first
      // so dropping that filter fails on it, not only on the killed row.
      expect("equivalenceRisk" in known).toBe(false);
      expect("equivalenceRisk" in killed).toBe(false);
      expect("readerMark" in killed).toBe(false);
      expect(known.readerMark).toEqual({ key: KEY_KS, reason: "R-ks" });
      expect(report.readerMarkedEquivalent?.contradicted.map((c) => c.mutantCode)).toEqual([
        "M0001",
      ]);
      expect(report.readerMarkedEquivalent?.matched.map((c) => c.mutantCode)).toEqual(["M0002"]);
    });

    test("run-level lists are unchanged by C02-01", () => {
      // Both objects are LITERALS captured from `buildReport` at fd72825, before C02-01 Task 2
      // touched report.ts. Never derive them from the new rows: that would compare the change
      // with itself.
      const report = buildReport({ ...STATICS, equivalenceMarks: MARKS }, TWO_BATCH_EVENTS);
      expect(report.likelyEquivalentSurvivors).toEqual({
        count: 2,
        byRisk: [
          {
            risk: "value-rewrite",
            mutants: ["M0001", "M0002"],
            meaning:
              "This operator rewrites a written or compared VALUE. Where nothing downstream reads that value, the mutant is equivalent and no source-derived layer can see it without dataflow. Read these survivors as leads only after checking that something actually depends on the value.",
          },
        ],
      });
      expect(report.readerMarkedEquivalent).toEqual({
        matched: [
          {
            mutantCode: "M0001",
            key: "hash-b1|Sales Helper|ComputeTotal|lethal.negate-conditional|1",
            reason: "R-b1",
          },
          {
            mutantCode: "M0002",
            key: "hash-trg|Sales Helper||lethal.remove-assignment|1",
            reason: "R-trg",
          },
        ],
        stale: ["hash-gone|Sales Helper|ComputeTotal|lethal.remove-assignment|1"],
        contradicted: [
          {
            mutantCode: "M0003",
            key: "hash-killed|Sales Helper|ComputeTotal|lethal.remove-assignment|1",
            reason: "R-killed",
            verdict: "killed",
          },
        ],
      });
    });

    test("row marks and the run-level matched list agree (C02-01)", () => {
      const report = buildReport({ ...STATICS, equivalenceMarks: MARKS }, TWO_BATCH_EVENTS);
      const rowMarked = report.mutants
        .filter((m) => m.readerMark !== undefined)
        .map((m) => ({
          mutantCode: m.mutantCode,
          key: m.readerMark?.key,
          reason: m.readerMark?.reason,
        }))
        .sort((a, b) => a.mutantCode.localeCompare(b.mutantCode));
      const matched = report.readerMarkedEquivalent?.matched ?? [];
      // Non-empty on both sides, so an empty-vs-empty "agreement" cannot pass.
      expect(matched.length).toBe(2);
      expect(rowMarked).toEqual(matched.map((m) => ({ ...m })));
    });

    // Review finding 2 (C02-01 round 1): two rows share ONE R166 identity (the same site in two
    // batches), one survived and one killed. The run-level matcher keeps the LAST row per identity,
    // so the order decides `matched` or `contradicted`. A row's `readerMark` must follow that
    // classification, never a second per-row lookup, or the row and the list disagree.
    describe("two rows sharing one identity, one survived and one killed (C02-01)", () => {
      const SITE = { astHash: "hash-shared" };
      const KEY_SHARED = serializeKey(identityKeyOf(mutant("M0001", SITE)));
      const marks = [{ key: KEY_SHARED, reason: "R-shared" }];
      const run = (first: "survived" | "killed", second: "survived" | "killed") =>
        buildReport(
          { ...STATICS, equivalenceMarks: marks },
          seq([
            setGenerated(2),
            { type: "baseline-batch-finished", batchIndex: 0, verdicts: [] },
            scored(mutant("M0001", SITE), 0, first),
            { type: "baseline-batch-finished", batchIndex: 1, verdicts: [] },
            scored(mutant("M0001", SITE), 1, second),
            { type: "session-finished", elapsedMs: 2_000 },
          ]),
        );
      const survivorOf = (r: SessionReport) => {
        const s = r.mutants.find((m) => m.verdict === "survived");
        if (s === undefined) throw new Error("buildReport dropped the survivor");
        return s;
      };

      test("killed last: the list says contradicted, so no row carries the mark", () => {
        const report = run("survived", "killed");
        expect(report.readerMarkedEquivalent?.contradicted.map((c) => c.key)).toEqual([KEY_SHARED]);
        expect(report.readerMarkedEquivalent?.matched).toEqual([]);
        expect("readerMark" in survivorOf(report)).toBe(false);
        expect(report.mutants.filter((m) => m.readerMark !== undefined)).toEqual([]);
      });

      test("survived last: the list says matched, so the survivor carries the mark", () => {
        const report = run("killed", "survived");
        expect(report.readerMarkedEquivalent?.matched.map((c) => c.key)).toEqual([KEY_SHARED]);
        expect(report.readerMarkedEquivalent?.contradicted).toEqual([]);
        expect(survivorOf(report).readerMark).toEqual({ key: KEY_SHARED, reason: "R-shared" });
        expect(report.mutants.filter((m) => m.readerMark !== undefined)).toHaveLength(1);
      });
    });
  });

  test("explains every hang-capable reason it can carry", () => {
    // Iterate the TABLE itself, not a hand-copied list of its keys: `Record<HangCapableReason,
    // string>` already forces a new union member to gain an entry at compile time, but a separate
    // literal array of reasons does not grow with the union, so a second reason could arrive with
    // this test still green and asserting nothing about it (design §3.2 plans three more).
    const entries = Object.entries(HANG_CAPABLE_EXPLANATIONS);
    // Iterating an empty object passes trivially, so non-emptiness is asserted separately: without
    // this, deleting every entry from the table would leave this test green, the empty-vs-empty
    // shape CLAUDE.md names as this project's signature bug.
    expect(entries.length).toBeGreaterThan(0);
    for (const [, explanation] of entries) {
      expect(explanation).toBeTruthy();
    }
  });
});
