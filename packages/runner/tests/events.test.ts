import { describe, expect, test } from "bun:test";
import type { MutantManifestEntry } from "@lethal/schemata";
import { BASELINE_CLASSIFICATIONS, STREAM_SCHEMA_VERSION, createEmitter } from "../src/events";
import { CAVEAT_INTERPRETATIONS } from "../src/report";
import type { RunEvent, RunEventInput } from "../src/events";

function collect(): { events: RunEvent[]; sub: (e: RunEvent) => void } {
  const events: RunEvent[] = [];
  return { events, sub: (e) => events.push(e) };
}

/** One realistic `MutantManifestEntry`, styled after the Task 1 golden fixture — every
 *  mutant-carrying event below reuses this rather than inventing a fresh shape per test. */
function sampleMutant(): MutantManifestEntry {
  return {
    mutantId: "M0001",
    file: "Al/Codeunit/Codeunit 50100 Sales Helper.al",
    startIndex: 1200,
    endIndex: 1240,
    startLine: 45,
    operatorName: "lethal.void-method-call",
    operatorVersion: "1.0.0",
    astHash: "hashA1",
    objectType: "codeunit",
    codeunitId: 50100,
    codeunitName: "Sales Helper",
    procedureName: "ComputeTotal",
    procedureScope: "public",
    originalText: "TotalAmount := Quantity * UnitPrice;",
    mutatedText: "",
  };
}

describe("createEmitter", () => {
  test("stamps a monotonic seq starting at 1", () => {
    const { events, sub } = collect();
    const emit = createEmitter([sub]);
    emit({ type: "phase-entered", phase: "deploy" });
    emit({ type: "phase-entered", phase: "baseline" });
    expect(events.map((e) => e.seq)).toEqual([1, 2]);
  });

  test("fans out to every subscriber in registration order", () => {
    const a = collect();
    const b = collect();
    const emit = createEmitter([a.sub, b.sub]);
    emit({ type: "phase-entered", phase: "deploy" });
    expect(a.events).toHaveLength(1);
    expect(b.events).toHaveLength(1);
  });

  test("a throwing subscriber does not stop the others, and does not lose the event", () => {
    const good = collect();
    const emit = createEmitter([
      () => {
        throw new Error("subscriber exploded");
      },
      good.sub,
    ]);
    expect(() => emit({ type: "phase-entered", phase: "deploy" })).not.toThrow();
    expect(good.events).toHaveLength(1);
  });

  test("mutant-carried has no durationMs field — R54 made unrepresentable", () => {
    const { events, sub } = collect();
    const emit = createEmitter([sub]);
    emit({
      type: "mutant-carried",
      mutant: sampleMutant(),
      verdict: "survived",
      fromRunId: 7,
      batchIndex: 0,
      priorDurationMs: 4200,
      coveringTests: ["Suite.TestOne"],
    });
    const e = events[0];
    if (e === undefined) throw new Error("no event recorded");
    expect("durationMs" in e).toBe(false);
    expect(e).toMatchObject({ priorDurationMs: 4200 });
  });

  test("the header event carries the stream schema version", () => {
    const { events, sub } = collect();
    const emit = createEmitter([sub]);
    emit({ type: "stream-started", streamSchemaVersion: STREAM_SCHEMA_VERSION, runId: 3 });
    expect(events[0]).toMatchObject({ streamSchemaVersion: STREAM_SCHEMA_VERSION });
  });

  // Not from the brief's Step 1 — added per the team lead's explicit request to confirm that
  // `RunEvent = RunEventInput & Base` still narrows on the `type` discriminant under this repo's
  // tsconfig. This is a compile-time check as much as a runtime one: `bun test` alone would not
  // catch a narrowing regression, only `bun run typecheck` would.
  test("RunEvent narrows to mutant-carried on the type discriminant", () => {
    const { events, sub } = collect();
    const emit = createEmitter([sub]);
    emit({
      type: "mutant-carried",
      mutant: sampleMutant(),
      verdict: "killed",
      fromRunId: 9,
      batchIndex: 2,
      priorDurationMs: 1000,
      coveringTests: [],
    });
    const e = events[0];
    if (e === undefined) throw new Error("no event recorded");
    if (e.type !== "mutant-carried") throw new Error("expected mutant-carried");
    // Narrowed: `e` is now exactly the mutant-carried member intersected with `Base`, so
    // `priorDurationMs` is a plain, non-optional read with no cast.
    const prior: number = e.priorDurationMs;
    expect(prior).toBe(1000);
    // @ts-expect-error — mutant-carried has no durationMs; this line must fail to type-check.
    const bad = e.durationMs;
    expect(bad).toBeUndefined();
  });

  // Fix round 1 (post-Task-2 review): baseline-finished (aggregate counts) was DELETED and
  // replaced by baseline-batch-finished, which must carry per-test rows — the design rule is
  // "events carry facts, consumers compute aggregates". This pins that the replacement actually
  // is per-test, not a renamed aggregate.
  test("baseline-batch-finished carries per-test rows, not aggregate counts", () => {
    const { events, sub } = collect();
    const emit = createEmitter([sub]);
    emit({
      type: "baseline-batch-finished",
      batchIndex: 1,
      verdicts: [
        {
          name: "Sales Helper Tests.ComputeTotalMultipliesQtyByPrice",
          outcome: "pass",
          classification: [],
        },
        {
          name: "Sales Helper Tests.RefusedByPermissions",
          outcome: "fail",
          classification: ["tests-permission-refused"],
          failureMessage: "You do not have permission to insert...",
        },
      ],
    });
    const e = events[0];
    if (e === undefined) throw new Error("no event recorded");
    if (e.type !== "baseline-batch-finished") throw new Error("expected baseline-batch-finished");
    // Real per-test rows, not a `{ testCount, failingCount }` shape — no "count" field exists
    // to fall back to, and each row names its own test and outcome.
    expect(e.verdicts).toHaveLength(2);
    expect(e.verdicts[0]).toMatchObject({ outcome: "pass" });
    expect(e.verdicts[1]).toMatchObject({
      outcome: "fail",
      classification: ["tests-permission-refused"],
    });
    expect("testCount" in e).toBe(false);
    expect("failingCount" in e).toBe(false);
  });

  // Fix round 2, residual 2: `classification` was narrowed from a bare `string` to the literal
  // union `report.ts`'s own `caveats` array already uses (its `Caveat` type, and the three sites
  // that produce these tags: `caveats.push("tests-permission-refused")`,
  // `caveats.push("tests-testpage-unsupported")`, `caveats.push("stale-test-app")`). This pins
  // that all three real tags — permission-refused, testpage-unsupported, and stale — type-check
  // as `classification` values, so a typo on either the emit or the fold side is now a compile
  // error instead of a silent mismatch.
  test("baseline-batch-finished's classification accepts exactly the three real orchestrator tags", () => {
    const { events, sub } = collect();
    const emit = createEmitter([sub]);
    emit({
      type: "baseline-batch-finished",
      batchIndex: 2,
      verdicts: [
        {
          name: "Suite.PermissionRefused",
          outcome: "fail",
          classification: ["tests-permission-refused"],
        },
        {
          name: "Suite.OpensTestPage",
          outcome: "fail",
          classification: ["tests-testpage-unsupported"],
        },
        { name: "Suite.NoResultForMethod", outcome: "error", classification: ["stale-test-app"] },
      ],
    });
    const e = events[0];
    if (e === undefined) throw new Error("no event recorded");
    if (e.type !== "baseline-batch-finished") throw new Error("expected baseline-batch-finished");
    expect(e.verdicts.map((v) => v.classification)).toEqual([
      ["tests-permission-refused"],
      ["tests-testpage-unsupported"],
      ["stale-test-app"],
    ]);
  });

  // Fix round 3: the case a single scalar `classification` could not express. Two of the three
  // conditions (`describeTestPermissionsRefusal`/`describeTestPageUnsupported`, in
  // orchestrator.ts's `const classification: BaselineClassification[]` mapping) are independent
  // `if`s over the same `failureMessage`, so a test matching both must round-trip with BOTH tags
  // intact — a scalar field would have to silently drop one.
  test("a verdict row carrying both tags round-trips with both intact", () => {
    const { events, sub } = collect();
    const emit = createEmitter([sub]);
    emit({
      type: "baseline-batch-finished",
      batchIndex: 3,
      verdicts: [
        {
          name: "Suite.RefusedAndOpensTestPage",
          outcome: "fail",
          classification: ["tests-permission-refused", "tests-testpage-unsupported"],
          failureMessage: "concatenated BC exception carrying both diagnoses",
        },
      ],
    });
    const e = events[0];
    if (e === undefined) throw new Error("no event recorded");
    if (e.type !== "baseline-batch-finished") throw new Error("expected baseline-batch-finished");
    const [row] = e.verdicts;
    if (row === undefined) throw new Error("expected one verdict row");
    expect(row.classification).toHaveLength(2);
    expect(row.classification).toContain("tests-permission-refused");
    expect(row.classification).toContain("tests-testpage-unsupported");
  });

  // Fix round 1: the "given vs learned" rule says a static (caps/only/testsOnly/stopHungSessions)
  // is declared EXACTLY ONCE, in run-configured, and no later event may repeat it. This builds one
  // instance of every event kind in the union and asserts that a static field name present on
  // run-configured's payload appears as an own-property on no other emitted event — the concrete,
  // regression-catching form of "declared once".
  test("a static named in run-configured appears in no other event type", () => {
    const { events, sub } = collect();
    const emit = createEmitter([sub]);
    const mutant = sampleMutant();
    const inputs: RunEventInput[] = [
      { type: "stream-started", streamSchemaVersion: STREAM_SCHEMA_VERSION, runId: 1 },
      {
        type: "run-configured",
        caps: { coverage: "fenced", deploy: "publish", isolation: "session", authoritative: true },
        only: { patterns: ["Al/Codeunit/**"] },
        testsOnly: ["*Tests"],
        stopHungSessions: true,
      },
      {
        type: "resume-resolved",
        fromRunId: 1,
        mode: "last",
        carryableCount: 1,
        strandedKeyCount: 0,
        retryStranded: false,
      },
      { type: "phase-entered", phase: "baseline", testCount: 2, batchIndex: 0 },
      { type: "phase-left", phase: "baseline", elapsedMs: 10 },
      {
        type: "mutation-set-generated",
        siteCount: 4,
        deployedCount: 4,
        totalFiles: 2,
        instrumentableFiles: 2,
        notInstrumentedFiles: [],
        excludedByOnly: 0,
      },
      {
        type: "tests-discovered",
        tests: [{ codeunitId: 50101, codeunitName: "Sales Helper Tests", method: "T1" }],
      },
      { type: "batch-published", batchIndex: 0, guardCount: 4, elapsedMs: 100 },
      { type: "batch-invalidated", batchIndex: 0, reason: "attestation failed" },
      {
        type: "baseline-batch-finished",
        batchIndex: 0,
        verdicts: [{ name: "Sales Helper Tests.T1", outcome: "pass", classification: [] }],
      },
      {
        type: "coverage-split",
        batchIndex: 0,
        untargetedTriggerCount: 0,
        coveredCount: 1,
        noCoverageCount: 0,
      },
      { type: "permission-canary", result: { verdict: "not-mocked" } },
      {
        type: "mutant-scored",
        mutant,
        verdict: "killed",
        batchIndex: 0,
        durationMs: 500,
        coveringTests: ["Sales Helper Tests.T1"],
      },
      {
        type: "mutant-carried",
        mutant,
        verdict: "survived",
        fromRunId: 1,
        batchIndex: 0,
        priorDurationMs: 700,
        coveringTests: [],
      },
      { type: "mutant-skipped-stranded", mutant, batchIndex: 0, note: "stranded" },
      { type: "warning", code: "R60", message: "narrowed run" },
      { type: "quarantined", reason: "deadline exceeded" },
      { type: "session-finished", elapsedMs: 12345 },
    ];
    for (const input of inputs) emit(input);
    expect(events).toHaveLength(inputs.length);

    const staticFieldNames = ["caps", "only", "testsOnly", "stopHungSessions"] as const;
    for (const e of events) {
      for (const field of staticFieldNames) {
        if (e.type === "run-configured") continue;
        expect(field in e).toBe(false);
      }
    }
    // And run-configured itself does carry all four.
    const configured = events.find((e) => e.type === "run-configured");
    if (configured === undefined) throw new Error("run-configured not emitted");
    for (const field of staticFieldNames) expect(field in configured).toBe(true);
  });

  // Fix round 1, closing a gap the reviewer found in the brief's own tests: the original test only
  // proved a throwing subscriber doesn't lose ONE event. A chronically-throwing subscriber (the
  // realistic case — a renderer that dies on its first event will die identically on every
  // following one) must warn ONCE, not once per event, or a long run spams stderr into
  // unreadability; and the healthy subscriber must still receive every event, not just the first.
  test("a chronically-throwing subscriber warns only once across multiple events", () => {
    const good = collect();
    const warnings: string[] = [];
    const originalWrite = process.stderr.write;
    process.stderr.write = ((chunk: unknown) => {
      warnings.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      const emit = createEmitter([
        () => {
          throw new Error("subscriber exploded");
        },
        good.sub,
      ]);
      emit({ type: "phase-entered", phase: "deploy" });
      emit({ type: "phase-entered", phase: "baseline" });
      emit({ type: "phase-left", phase: "baseline", elapsedMs: 5 });
    } finally {
      process.stderr.write = originalWrite;
    }
    expect(warnings).toHaveLength(1);
    expect(good.events).toHaveLength(3);
  });

  // Fix round 2, residual 1: `runnerDisagreement` alone (a constant note keyed on coverage mode)
  // cannot identify WHICH covering test disagreed, and `coveringTests` carries the mutant's whole
  // list. This pins that `runnerDisagreementTest` names exactly one test — the one that actually
  // disagreed — even when the mutant has several covering tests.
  test("mutant-scored with 3 covering tests and a disagreement identifies exactly one of them", () => {
    const { events, sub } = collect();
    const emit = createEmitter([sub]);
    emit({
      type: "mutant-scored",
      mutant: sampleMutant(),
      verdict: "error",
      batchIndex: 0,
      durationMs: 300,
      cause: "unstable",
      coveringTests: ["Suite.TestA", "Suite.TestB", "Suite.TestC"],
      runnerDisagreement: "hub-green test failed unmutated on the fence",
      runnerDisagreementTest: "Suite.TestB",
    });
    const e = events[0];
    if (e === undefined) throw new Error("no event recorded");
    if (e.type !== "mutant-scored") throw new Error("expected mutant-scored");
    expect(e.coveringTests).toHaveLength(3);
    const disagreeing = e.runnerDisagreementTest;
    if (disagreeing === undefined) throw new Error("expected runnerDisagreementTest to be set");
    expect(disagreeing).toBe("Suite.TestB");
    // The disagreeing test is a member of the covering list, not some other name entirely.
    expect(e.coveringTests).toContain(disagreeing);
  });
});

/**
 * R113 — `BaselineClassification` used to be an INDEPENDENT copy of three `Caveat` names, under a
 * doc comment asserting they were the same identifiers `report.ts` pushes. Nothing enforced that.
 *
 * `satisfies readonly Caveat[]` in `events.ts` now makes it a compile error, but `bun test` is a
 * separate step from `bun run typecheck` in this repo, so a type-level guarantee alone is
 * INVISIBLE to the test runner (R115 found one entirely inert because its type was unimported).
 * These two tests are the runtime half: they walk the exported array against
 * `CAVEAT_INTERPRETATIONS`'s own keys, which is the only enumeration of `Caveat` that exists at
 * run time.
 */
describe("BASELINE_CLASSIFICATIONS (R113)", () => {
  test("every classification is a real `Caveat`, checked against the registry's own keys", () => {
    const known = Object.keys(CAVEAT_INTERPRETATIONS);
    const foreign = BASELINE_CLASSIFICATIONS.filter((c) => !known.includes(c));
    expect(foreign).toEqual([]);
  });

  test("guards the guard: the array is non-empty and the registry is reachable", () => {
    // Without this, the check above passes trivially the day either side becomes empty — an
    // empty-vs-empty match is this project's signature bug.
    expect(BASELINE_CLASSIFICATIONS.length).toBe(3);
    expect(Object.keys(CAVEAT_INTERPRETATIONS).length).toBeGreaterThan(3);
  });
});
