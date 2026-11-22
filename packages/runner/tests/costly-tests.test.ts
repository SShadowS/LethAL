import { describe, expect, test } from "bun:test";
import type { MutantManifestEntry } from "@lethal/schemata";
import type { RunEvent, RunEventInput } from "../src/events";
import { buildReport, renderConsole } from "../src/report";
import { type FoldStatics, foldEvents } from "../src/report-fold";

/** PR-247: the `costlyTests` section, folded from `test-costs` + `mutant-scored` + `mutant-carried`. */

const STATICS: FoldStatics = {
  caps: {
    kind: "bcdev",
    authoritative: true,
    coverage: "procedure",
    deploy: "publish",
    isolation: "session",
  },
  buildSymbols: [],
};

const seq = (events: readonly RunEventInput[]): RunEvent[] =>
  events.map((e, i) => ({ ...e, seq: i + 1 }) as RunEvent);

function mutant(id: string): MutantManifestEntry {
  return {
    mutantId: id,
    file: "Al/Codeunit/Codeunit 50100 Sales Helper.al",
    startIndex: 100,
    endIndex: 140,
    startLine: 10,
    operatorName: "lethal.void-method-call",
    operatorVersion: "1.0.0",
    astHash: `hash-${id}`,
    objectType: "codeunit",
    codeunitId: 50100,
    codeunitName: "Sales Helper",
    procedureName: "ComputeTotal",
    procedureScope: "public",
    originalText: "X := 1;",
    mutatedText: "",
  };
}

const CU = "Sales Helper Tests";

/** A complete stream up to the mutant phase; `tests` are method names of `CU`, each with a baseline duration. */
function head(tests: readonly string[], runId?: number): RunEventInput[] {
  return [
    ...(runId !== undefined
      ? [{ type: "stream-started", streamSchemaVersion: 1, runId } as RunEventInput]
      : []),
    {
      type: "mutation-set-generated",
      siteCount: 2,
      deployedCount: 2,
      hangCapableCount: 0,
      totalFiles: 1,
      instrumentableFiles: 1,
      notInstrumentedFiles: [],
      declarativeSiteFiles: [],
      preprocExcludedFiles: [],
      excludedByOnly: 0,
      excludedByExclude: 0,
      excludedByOperator: 0,
    },
    {
      type: "tests-discovered",
      tests: tests.map((m, i) => ({ codeunitId: 50200, codeunitName: CU, method: m, line: i })),
    },
    {
      type: "baseline-batch-finished",
      batchIndex: 0,
      verdicts: tests.map((m, i) => ({
        name: `${CU}.${m}`,
        outcome: "pass" as const,
        classification: [],
        durationMs: 10 * (i + 1),
      })),
    },
    {
      type: "coverage-split",
      batchIndex: 0,
      untargetedTriggerCount: 0,
      coveredCount: 2,
      noCoverageCount: 0,
      unplaceableCount: 0,
      unplaceableMutants: [],
    },
  ];
}

const costs = (
  tests: {
    test: string;
    runs: number;
    ownMs: number;
    msUnderSurvivors: number;
    batchIndex?: number;
  }[],
): RunEventInput => ({
  type: "test-costs",
  tests: tests.map((t) => ({ ...t, batchIndex: t.batchIndex ?? 0 })),
});

/** Two mutants: M1 killed by T1 (covers T1,T2), M2 survived (covers T2,T3). */
function twoMutants(): RunEventInput[] {
  return [
    {
      type: "mutant-scored",
      mutant: mutant("M0001"),
      verdict: "killed",
      batchIndex: 0,
      durationMs: 50,
      coveringTests: [`${CU}.T1`, `${CU}.T2`],
      killingTest: "T1",
    },
    {
      type: "mutant-scored",
      mutant: mutant("M0002"),
      verdict: "survived",
      batchIndex: 0,
      durationMs: 50,
      coveringTests: [`${CU}.T2`, `${CU}.T3`],
    },
  ];
}

const fin: RunEventInput = { type: "session-finished", elapsedMs: 100 };

describe("costlyTests: the fold", () => {
  test("two mutants, three tests: exact rows", () => {
    const f = foldEvents(
      STATICS,
      seq([
        ...head(["T1", "T2", "T3"]),
        ...twoMutants(),
        costs([
          { test: `${CU}.T1`, runs: 1, ownMs: 10, msUnderSurvivors: 0 },
          { test: `${CU}.T2`, runs: 2, ownMs: 60, msUnderSurvivors: 40 },
          { test: `${CU}.T3`, runs: 1, ownMs: 30, msUnderSurvivors: 30 },
        ]),
        fin,
      ]),
    );
    expect(f.costlyTests).toEqual({
      scope: "whole-run",
      carriedMutants: 0,
      totalOwnMs: 100,
      ambiguousKills: 0,
      top: [
        {
          test: `${CU}.T2`,
          coveredMutants: 2,
          kills: 0,
          killRate: 0,
          runs: 2,
          ownMs: 60,
          share: 0.6,
          meanMs: 30,
          baselineMs: 20,
          msUnderSurvivors: 40,
        },
        {
          test: `${CU}.T3`,
          coveredMutants: 1,
          kills: 0,
          killRate: 0,
          runs: 1,
          ownMs: 30,
          share: 0.3,
          meanMs: 30,
          baselineMs: 30,
          msUnderSurvivors: 30,
        },
        {
          test: `${CU}.T1`,
          coveredMutants: 1,
          kills: 1,
          killRate: 1,
          runs: 1,
          ownMs: 10,
          share: 0.1,
          meanMs: 10,
          baselineMs: 10,
          msUnderSurvivors: 0,
        },
      ],
    });
  });

  test("25 tests give exactly 20 rows; equal ownMs sort by name, not by arrival", () => {
    const names = Array.from({ length: 25 }, (_, i) => `T${String(i).padStart(2, "0")}`);
    // Arrival order is REVERSED name order, every test costs the same: only the name tie-break orders them.
    const tests = [...names].reverse().map((n) => ({
      test: `${CU}.${n}`,
      runs: 1,
      ownMs: 5,
      msUnderSurvivors: 0,
    }));
    const f = foldEvents(STATICS, seq([...head(names), costs(tests), fin]));
    const top = f.costlyTests?.top ?? [];
    expect(top.length).toBe(20);
    expect(top.map((r) => r.test)).toEqual(names.slice(0, 20).map((n) => `${CU}.${n}`));
    expect(f.costlyTests?.totalOwnMs).toBe(125);
  });

  test("no test-costs event: no section", () => {
    const f = foldEvents(STATICS, seq([...head(["T1"]), ...twoMutants(), fin]));
    expect(f.costlyTests).toBeUndefined();
    expect("costlyTests" in buildReport(STATICS, seq([...head(["T1"]), fin]))).toBe(false);
  });
});

describe("costlyTests: scope", () => {
  const carried = (n: number, fromRunId: number): RunEventInput => ({
    type: "mutant-carried",
    mutant: mutant(`M01${n}`),
    verdict: "survived",
    fromRunId,
    batchIndex: 0,
    priorDurationMs: 1,
    coveringTests: [`${CU}.T1`],
  });
  const one = costs([{ test: `${CU}.T1`, runs: 1, ownMs: 10, msUnderSurvivors: 0 }]);

  test("no carried mutants: whole-run", () => {
    const f = foldEvents(STATICS, seq([...head(["T1"], 2), one, fin]));
    expect(f.costlyTests?.scope).toBe("whole-run");
    expect(f.costlyTests?.carriedMutants).toBe(0);
  });

  test("carried mutants whose session has no test-costs here: this-session, and the banner says so", () => {
    const events = seq([...head(["T1"], 2), carried(1, 1), carried(2, 1), one, fin]);
    const f = foldEvents(STATICS, events);
    expect(f.costlyTests?.scope).toBe("this-session");
    expect(f.costlyTests?.carriedMutants).toBe(2);
    expect(renderConsole(buildReport(STATICS, events))).toContain(
      "(this session only: 2 carried mutants' tests not counted)",
    );
  });

  test("an appended stream holding the earlier session's test-costs: whole-run", () => {
    const f = foldEvents(
      STATICS,
      seq([
        ...head(["T1"], 1),
        one,
        fin,
        ...head(["T1"], 2),
        carried(1, 1),
        carried(2, 1),
        one,
        fin,
      ]),
    );
    expect(f.costlyTests?.scope).toBe("whole-run");
    expect(f.costlyTests?.carriedMutants).toBe(0);
    expect(f.costlyTests?.totalOwnMs).toBe(20);
    expect(f.costlyTests?.top[0]?.runs).toBe(2);
  });
});

describe("costlyTests: the banner", () => {
  test("the exact line, and it never says remove", () => {
    const events = seq([
      ...head(["T1", "T2", "T3"]),
      ...twoMutants(),
      costs([
        { test: `${CU}.T1`, runs: 1, ownMs: 10, msUnderSurvivors: 0 },
        { test: `${CU}.T2`, runs: 2, ownMs: 60, msUnderSurvivors: 40 },
        { test: `${CU}.T3`, runs: 1, ownMs: 30, msUnderSurvivors: 30 },
      ]),
      fin,
    ]);
    const text = renderConsole(buildReport(STATICS, events));
    const line = text.split("\n").find((l) => l.startsWith("costly tests:"));
    expect(line).toBe(
      `costly tests: the top 3 take 100% of the mutation test time; the top one, ${CU}.T2, 60%, killed 0% of the 2 mutants it covers`,
    );
    expect(line).not.toContain("remove");
  });
});

describe("costlyTests: amendment 1 (final outcomes, ambiguous kills, invalidated batches)", () => {
  const row = (test: string, over: { batchIndex?: number; ownMs: number; surv?: number }) => ({
    test,
    runs: 1,
    ownMs: over.ownMs,
    msUnderSurvivors: over.surv ?? 0,
    ...(over.batchIndex !== undefined ? { batchIndex: over.batchIndex } : {}),
  });

  test("two codeunits sharing the killing method name: no double credit, ambiguousKills 1", () => {
    const events = seq([
      ...head(["T1"]),
      {
        type: "mutant-scored",
        mutant: mutant("M0001"),
        verdict: "killed",
        batchIndex: 0,
        durationMs: 5,
        coveringTests: ["A Tests.Shared", "B Tests.Shared"],
        killingTest: "Shared",
      },
      costs([row("A Tests.Shared", { ownMs: 5 }), row("B Tests.Shared", { ownMs: 5 })]),
      fin,
    ]);
    const c = foldEvents(STATICS, events).costlyTests;
    expect(c?.ambiguousKills).toBe(1);
    expect(c?.top.map((r) => [r.test, r.kills, r.coveredMutants])).toEqual([
      ["A Tests.Shared", 0, 1],
      ["B Tests.Shared", 0, 1],
    ]);
    expect(renderConsole(buildReport(STATICS, events))).toContain(
      "(1 kills could not be credited to one test)",
    );
  });

  test("a recheck-recovered kill counts as a kill", () => {
    const m = mutant("M0001");
    const events = seq([
      ...head(["T1"]),
      {
        type: "mutant-scored",
        mutant: m,
        verdict: "error",
        cause: "runner-refused",
        batchIndex: 0,
        durationMs: 5,
        coveringTests: [`${CU}.T1`],
        failureNote:
          "NotRun: out-of-scope: a test before this one in the codeunit did not pass (X.Y): this failure is not trusted: boom",
      },
      {
        type: "mutant-rechecked",
        mutant: m,
        batchIndex: 0,
        durationMs: 3,
        recovery: {
          killingTest: "T1",
          coveringTests: [`${CU}.T1`],
          isolatedRecheck: { withheldFailure: "boom", killerGreenInMainBaseline: true },
        },
      },
      costs([row(`${CU}.T1`, { ownMs: 5 })]),
      fin,
    ]);
    const top = foldEvents(STATICS, events).costlyTests?.top;
    expect(top?.[0]?.kills).toBe(1);
    expect(top?.[0]?.coveredMutants).toBe(1);
  });

  // PR-322 (R1167): the recovery carries the mutant's own covering set (plus its killer), not the recheck's whole run
  // set, so a test that only RAN in the recheck no longer counts as covering it. Named limit: a covering test of another
  // codeunit with the killer's method name still makes the credit ambiguous (the test above; 0 of 349 on DO c2).
  test("PR-322: a recovered row's covering list is the recovery's; a recheck-only test is not counted as covering", () => {
    const m = mutant("M0001");
    const events = seq([
      ...head(["T1", "T3"]),
      {
        type: "mutant-scored",
        mutant: m,
        verdict: "error",
        cause: "runner-refused",
        batchIndex: 0,
        durationMs: 5,
        coveringTests: [`${CU}.T1`],
        failureNote:
          "NotRun: out-of-scope: a test before this one in the codeunit did not pass (X.Y): this failure is not trusted: boom",
      },
      {
        type: "mutant-rechecked",
        mutant: m,
        batchIndex: 0,
        durationMs: 3,
        recovery: {
          killingTest: "T1",
          coveringTests: [`${CU}.T1`],
          isolatedRecheck: { withheldFailure: "boom", killerGreenInMainBaseline: true },
        },
      },
      costs([row(`${CU}.T1`, { ownMs: 5 }), row(`${CU}.T3`, { ownMs: 9 })]),
      fin,
    ]);
    const folded = foldEvents(STATICS, events);
    expect(folded.outcomes[0]?.coveringTests).toEqual([`${CU}.T1`]);
    const t3 = folded.costlyTests?.top.find((r) => r.test === `${CU}.T3`);
    expect(t3?.coveredMutants).toBe(0);
  });

  test("an invalidated batch: its kill does not count; its time leaves msUnderSurvivors but stays in ownMs", () => {
    const scored = (id: string, verdict: "killed" | "survived", batchIndex: number) =>
      ({
        type: "mutant-scored",
        mutant: mutant(id),
        verdict,
        batchIndex,
        durationMs: 5,
        coveringTests: [`${CU}.T1`],
        ...(verdict === "killed" ? { killingTest: "T1" } : {}),
      }) as RunEventInput;
    const stream = (invalidate: boolean) =>
      seq([
        ...head(["T1"]),
        scored("M0001", "killed", 0),
        scored("M0003", "survived", 0),
        scored("M0002", "survived", 1),
        costs([
          row(`${CU}.T1`, { batchIndex: 0, ownMs: 30, surv: 10 }),
          row(`${CU}.T1`, { batchIndex: 1, ownMs: 20, surv: 20 }),
        ]),
        ...(invalidate
          ? [{ type: "batch-invalidated", batchIndex: 0, reason: "tree changed" } as RunEventInput]
          : []),
        fin,
      ]);
    const kept = foldEvents(STATICS, stream(false)).costlyTests?.top[0];
    expect([kept?.kills, kept?.coveredMutants, kept?.ownMs, kept?.msUnderSurvivors]).toEqual([
      1, 3, 50, 30,
    ]);
    const inv = foldEvents(STATICS, stream(true)).costlyTests?.top[0];
    expect([inv?.kills, inv?.coveredMutants, inv?.ownMs, inv?.msUnderSurvivors]).toEqual([
      0, 1, 50, 20,
    ]);
  });
});
