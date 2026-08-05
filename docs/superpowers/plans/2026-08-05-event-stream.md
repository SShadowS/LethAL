# Event Stream Implementation Plan (subsystem A)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a typed in-process event stream the single source of truth for a LethAL run, so the report is folded from the same facts the run emits, progress appears while the run executes, and a crashed run leaves a diagnosable record.

**Architecture:** The orchestrator emits typed events at the moments it already knows things. Three subscribers consume them: a human renderer writing to stderr during the run, the `SessionReport` fold, and an NDJSON sink. Events are ephemeral and in-process — sqlite remains the durable incremental record and the only resume source.

**Tech Stack:** Bun + TypeScript, `bun:test`, `bun:sqlite`.

**Spec:** `docs/superpowers/specs/2026-08-05-observability-and-campaign-method-design.md` (`2b9b696`), section A. Read it before starting; this plan implements it and does not restate its reasoning.

**Scope:** This plan covers **subsystem A only**. `lethal explain` (B), the tool features (C1–C4) and `lethal campaign` + the skill (D) each get their own plan. They do not depend on this one.

## Global Constraints

- **No `!` non-null assertions** — biome `noNonNullAssertion: error`. Destructure, then check `undefined`.
- **`exactOptionalPropertyTypes`** — build optional props with `...(v !== undefined ? { k: v } : {})`.
- **Typed error classes extend `Error` directly, never each other.** `AlcCompileError` vs `ArtifactPrepareError` vs `DeploymentError`. Preserve the separation.
- **Fail loudly on caller-contract violations.** Throw; never return a plausible empty default. Empty-vs-empty "matches" is this project's signature bug.
- **Build order:** `bun run typecheck` → `rm -rf packages/*/dist` → `bun test`. Skipping the dist clean causes ~21 phantom failures.
- **Lint only what you touched:** `bunx biome check <paths>`.
- **Git bash on Windows, Windows paths.** Never `2>nul` — use `2>/dev/null`.
- **Events are ephemeral.** No durable event log, no replay-as-rebuild, no events as a resume source. If a task tempts you toward any of these, stop — it is out of scope by design (spec §A).
- **Progress goes to stderr. The report goes to stdout.** They must never mix.

## File Structure

| path | responsibility |
|---|---|
| `packages/runner/src/events.ts` | **New.** The event union, the `RunEmitter` interface, and `createEmitter`. Pure — no I/O, no clock. |
| `packages/runner/src/report-fold.ts` | **New.** The presence-asserting fold: events in, `BuildReportInput` out. Pure. |
| `packages/runner/src/progress-renderer.ts` | **New.** Subscriber that formats events as human lines for stderr. Pure formatting + an injected sink. |
| `packages/runner/src/progress-ndjson.ts` | **New.** Subscriber that serialises events as NDJSON to a writable. |
| `packages/runner/src/orchestrator.ts` | **Modify.** Emit from `record()` (line 3819) and at phase boundaries; thread the emitter through `runSession`. |
| `packages/runner/src/report.ts` | **Modify.** `buildReport` takes folded input; `REPORT_SCHEMA_VERSION` unchanged. |
| `packages/runner/tests/report-equality.test.ts` | **New.** The safety net: a golden `SessionReport` compared field-by-field. |
| `packages/runner/tests/events.test.ts` | **New.** Event union and emitter tests. |
| `packages/runner/tests/report-fold.test.ts` | **New.** Fold tests, including every throw-on-missing case. |
| `packages/runner/tests/progress-renderer.test.ts` | **New.** Renderer output tests. |

**Ordering note, and it differs from the spec's migration list.** The spec says run the field-identical equality check "before and after step 3". That is only possible if the harness exists first, so **Task 1 builds the harness** and the fold rewrite is Task 4. Everything else follows the spec's order.

---

### Task 1: The report-equality safety net

This is the entire safety net for the refactor. It must exist and be green before anything else changes.

**Files:**
- Create: `packages/runner/tests/report-equality.test.ts`
- Create: `packages/runner/tests/fixtures/golden-report-input.json`

**Interfaces:**
- Consumes: `buildReport(input: BuildReportInput): SessionReport` from `packages/runner/src/report.ts`; `BuildReportInput` from the same file (definition begins at line 612).
- Produces: `packages/runner/tests/fixtures/golden-report-input.json`, a committed `BuildReportInput` fixture, and the test that pins `buildReport`'s output over it.

- [ ] **Step 1: Capture a realistic input fixture**

`BuildReportInput` is large and its fields matter. Rather than hand-writing one, derive it from the existing table-fixture test data. Read `packages/runner/tests/report.test.ts` and find the largest `BuildReportInput` literal it constructs. Copy that object into `packages/runner/tests/fixtures/golden-report-input.json`, then extend it so **every** optional field is populated — `only`, `testsOnly`, `staleTestApp`, `permissionsRefusedTests`, `testPageUnsupportedTests` — and so `outcomes` contains at least one of each: `killed`, `survived`, `no-coverage`, `timeout-killed`, `error` with `cause: "unstable"`, and one with `carried: true` and a non-zero `durationMs`.

The `carried: true` outcome is not optional. R54 was a carried-verdict accounting bug, and this fixture is what proves the fold does not reintroduce it.

- [ ] **Step 2: Write the equality test**

Create `packages/runner/tests/report-equality.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import goldenInput from "./fixtures/golden-report-input.json";
import { buildReport } from "../src/report";
import type { BuildReportInput } from "../src/report";

/**
 * The safety net for the event-stream refactor (spec 2026-08-05 §A).
 *
 * `buildReport` is being rewritten from a bag-of-fields builder into a fold over emitted events.
 * That rewrite touches how EVERY verdict reaches the report. This test pins the output over a
 * fixture exercising every optional field and every verdict kind, so the rewrite is provably
 * behaviour-preserving rather than plausibly so.
 *
 * It must be green BEFORE the rewrite starts and after it lands. A snapshot recorded after the
 * rewrite would prove nothing.
 */
describe("buildReport output is stable across the event-stream refactor", () => {
  test("the golden input produces a report identical to the committed snapshot", () => {
    const report = buildReport(goldenInput as unknown as BuildReportInput);
    expect(report).toMatchSnapshot();
  });

  test("the golden input exercises every verdict kind and the carried path", () => {
    const input = goldenInput as unknown as BuildReportInput;
    const verdicts = new Set(input.outcomes.map((o) => o.verdict));
    for (const v of ["killed", "survived", "no-coverage", "timeout-killed", "error"]) {
      expect(verdicts.has(v as never)).toBe(true);
    }
    expect(input.outcomes.some((o) => o.carried === true && (o.durationMs ?? 0) > 0)).toBe(true);
  });

  test("mutantsMs excludes carried durations — the R54 regression", () => {
    const input = goldenInput as unknown as BuildReportInput;
    const report = buildReport(input);
    const carriedMs = input.outcomes
      .filter((o) => o.carried === true)
      .reduce((n, o) => n + (o.durationMs ?? 0), 0);
    const allMs = input.outcomes.reduce((n, o) => n + (o.durationMs ?? 0), 0);
    expect(carriedMs).toBeGreaterThan(0);
    expect(report.timings.mutantsMs).toBe(allMs - carriedMs);
  });
});
```

- [ ] **Step 3: Run it and record the snapshot**

```bash
cd U:/Git/LethAL && bun run typecheck && rm -rf packages/*/dist && bun test packages/runner/tests/report-equality.test.ts
```

Expected: PASS, and a snapshot file written under `packages/runner/tests/__snapshots__/`. Inspect the snapshot — it is the contract the refactor must preserve. If any field reads as `undefined` where the fixture set a value, the fixture is wrong; fix it before continuing.

- [ ] **Step 4: Red-check the R54 assertion**

Temporarily change `report.ts:865` from `.filter((o) => o.carried !== true)` to `.filter(() => true)`, re-run the test file, confirm **only** the "mutantsMs excludes carried durations" test fails, then restore and confirm green. Record both outputs in the commit message. If that test passes with the filter defeated, the fixture's carried outcome has a zero duration and the assertion is vacuous.

- [ ] **Step 5: Commit**

```bash
cd U:/Git/LethAL && bunx biome check packages/runner/tests/report-equality.test.ts
git add packages/runner/tests/report-equality.test.ts packages/runner/tests/fixtures/golden-report-input.json packages/runner/tests/__snapshots__/
git commit -m "test(report): pin buildReport output before the event-stream refactor"
```

---

### Task 2: The event union and emitter

**Files:**
- Create: `packages/runner/src/events.ts`
- Test: `packages/runner/tests/events.test.ts`

**Interfaces:**
- Consumes: `MutantVerdict` from `packages/runner/src/store.ts` (line 5); `CoverageAttribution` from `packages/runner/src/selection.ts`; `MutantManifestEntry` from `packages/schemata`.
- Produces: `RunEvent` (the union), `RunEmitter`, `createEmitter(subscribers: readonly EventSubscriber[]): RunEmitter`, `EventSubscriber`, `STREAM_SCHEMA_VERSION`.

- [ ] **Step 1: Write the failing tests**

Create `packages/runner/tests/events.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { createEmitter, STREAM_SCHEMA_VERSION } from "../src/events";
import type { RunEvent } from "../src/events";

function collect(): { events: RunEvent[]; sub: (e: RunEvent) => void } {
  const events: RunEvent[] = [];
  return { events, sub: (e) => events.push(e) };
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
      mutantCode: "M0001",
      verdict: "survived",
      fromRunId: 7,
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
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd U:/Git/LethAL && bun test packages/runner/tests/events.test.ts
```

Expected: FAIL — `Cannot find module '../src/events'`.

- [ ] **Step 3: Write the implementation**

Create `packages/runner/src/events.ts`:

```ts
/**
 * The run's event union and emitter (spec 2026-08-05 §A).
 *
 * Events are EPHEMERAL and IN-PROCESS. There is no durable event log, no replay-as-rebuild, and
 * events are never a resume source — `bun:sqlite` remains the incremental record and the only
 * thing `--resume` reads. A second durable truth can disagree with the first, which is R54's shape
 * reborn.
 *
 * Emission serialises on the JS event loop, but arrival order is COMPLETION order once batches run
 * concurrently. `seq` is stamped monotonically so a crash-truncated stream is detectable; the
 * report fold does not depend on arrival order, and `orchestrator.ts`'s final sort keeps the
 * folded artifact deterministic.
 */
import type { CoverageAttribution } from "./selection";
import type { MutantVerdict, RunnerKind } from "./store";

/** Bumped independently of `REPORT_SCHEMA_VERSION`. Consumers ignore unknown event types. */
export const STREAM_SCHEMA_VERSION = 1;

export type RunPhase =
  | "generate"
  | "deploy"
  | "baseline"
  | "mutants"
  | "teardown";

interface Base {
  /** Monotonic, starting at 1. A gap means the stream was truncated. */
  readonly seq: number;
}

export type RunEventInput =
  | { readonly type: "stream-started"; readonly streamSchemaVersion: number; readonly runId: number }
  | { readonly type: "phase-entered"; readonly phase: RunPhase; readonly detail?: string }
  | { readonly type: "phase-left"; readonly phase: RunPhase; readonly elapsedMs: number }
  | {
      readonly type: "mutation-set-generated";
      readonly siteCount: number;
      readonly deployedCount: number;
      readonly totalFiles: number;
      readonly instrumentableFiles: number;
    }
  | { readonly type: "batch-published"; readonly batchIndex: number; readonly guardCount: number; readonly elapsedMs: number }
  | { readonly type: "batch-invalidated"; readonly batchIndex: number; readonly reason: string }
  | { readonly type: "baseline-finished"; readonly testCount: number; readonly failingCount: number }
  | {
      readonly type: "mutant-scored";
      readonly mutantCode: string;
      readonly verdict: MutantVerdict;
      readonly batchIndex: number;
      readonly durationMs: number;
      readonly killingTest?: string;
      readonly failureNote?: string;
      readonly coveringTests: readonly string[];
      readonly coverageAttribution?: CoverageAttribution;
      readonly guardObserved?: boolean;
      readonly runner?: RunnerKind;
    }
  | {
      /**
       * A verdict `--resume` carried from a prior run.
       *
       * DELIBERATELY has no `durationMs` field. The prior cost lives only in `priorDurationMs`, so
       * the fold cannot sum it into `mutantsMs` even by accident — R54 becomes unrepresentable
       * rather than guarded by a filter someone forgets (`report.ts:865`).
       */
      readonly type: "mutant-carried";
      readonly mutantCode: string;
      readonly verdict: MutantVerdict;
      readonly fromRunId: number;
      readonly priorDurationMs: number;
      readonly coveringTests: readonly string[];
    }
  | { readonly type: "mutant-skipped-stranded"; readonly mutantCode: string; readonly note: string }
  | { readonly type: "warning"; readonly code: string; readonly message: string }
  | { readonly type: "quarantined"; readonly reason: string }
  | { readonly type: "session-finished"; readonly elapsedMs: number };

export type RunEvent = RunEventInput & Base;

export type EventSubscriber = (event: RunEvent) => void;

export interface RunEmitter {
  (event: RunEventInput): void;
}

/**
 * A subscriber that throws must not abort the run or cost the other subscribers their event: a
 * broken renderer is a cosmetic failure, and losing a `mutant-scored` event would corrupt the
 * report. The throw is swallowed deliberately and reported once on stderr.
 */
export function createEmitter(subscribers: readonly EventSubscriber[]): RunEmitter {
  let seq = 0;
  const broken = new Set<number>();
  return (input: RunEventInput): void => {
    seq += 1;
    const event = { ...input, seq } as RunEvent;
    subscribers.forEach((sub, i) => {
      try {
        sub(event);
      } catch (err) {
        if (!broken.has(i)) {
          broken.add(i);
          process.stderr.write(
            `[lethal] event subscriber ${i} threw and will keep receiving events: ${String(err)}\n`,
          );
        }
      }
    });
  };
}
```

- [ ] **Step 4: Run to verify it passes**

```bash
cd U:/Git/LethAL && bun run typecheck && rm -rf packages/*/dist && bun test packages/runner/tests/events.test.ts
```

Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
cd U:/Git/LethAL && bunx biome check packages/runner/src/events.ts packages/runner/tests/events.test.ts
git add packages/runner/src/events.ts packages/runner/tests/events.test.ts
git commit -m "feat(events): the run event union and emitter, with mutant-carried carrying no durationMs"
```

---

### Task 3: Emit from `record()` and the phase boundaries

The report is still built the old way after this task. Events run alongside, and a test asserts they agree with the outcomes array — so a divergence is caught before the fold depends on it.

**Files:**
- Modify: `packages/runner/src/orchestrator.ts` (`record()` at line 3819; `runSession`; the phase boundaries)
- Test: `packages/runner/tests/events-orchestrator.test.ts` (new)

**Interfaces:**
- Consumes: `RunEmitter`, `RunEventInput` from `packages/runner/src/events.ts`.
- Produces: `record()` gains a required final parameter `emit: RunEmitter`. `SessionConfig` gains `readonly emit?: RunEmitter`.

- [ ] **Step 1: Thread the emitter into `record()`**

`record()` (`orchestrator.ts:3819`) is the single choke point that writes the store row. Add `emit: RunEmitter` as a **required** final parameter and emit immediately after `store.recordMutant` returns, so no call site can write a row without emitting:

```ts
  const mutantRowId = store.recordMutant(runId, { /* unchanged */ });

  if (carried === true) {
    emit({
      type: "mutant-carried",
      mutantCode: m.mutantId,
      verdict,
      fromRunId: runId,
      priorDurationMs: durationMs,
      coveringTests,
    });
  } else {
    emit({
      type: "mutant-scored",
      mutantCode: m.mutantId,
      verdict,
      batchIndex,
      durationMs,
      coveringTests,
      ...(killingTest !== undefined ? { killingTest } : {}),
      ...(failureNote !== undefined ? { failureNote } : {}),
      ...(coverageAttribution !== undefined ? { coverageAttribution } : {}),
      ...(guardObserved !== undefined ? { guardObserved } : {}),
      ...(runner !== undefined ? { runner } : {}),
    });
  }
```

Required, not optional: an optional emitter lets a future call site silently skip emission, which is the drift this design exists to prevent. Update every `record(...)` call site in the file to pass the emitter.

- [ ] **Step 2: Emit at the phase boundaries**

Wrap each phase in `runSession` with `phase-entered` / `phase-left`. The phases and where they begin are already visible in the timings the report computes (`generate`, `deploy`, `baseline`, `mutants`, `teardown`). Emit `mutation-set-generated` after `generateMutationSet` returns, carrying **both** the raw site count and the deployed count — that pair is R92's fix and it costs nothing here.

Convert the 20 `console.warn` calls to `emit({ type: "warning", code, message })`, keeping the existing text. Give each a stable `code` derived from its roadmap row where one exists (e.g. `"quarantine-consult-disabled"`).

- [ ] **Step 3: Write the agreement test**

Create `packages/runner/tests/events-orchestrator.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { createEmitter } from "../src/events";
import type { RunEvent } from "../src/events";

/**
 * Events must agree with the outcomes array while both exist. Task 4 makes the fold authoritative;
 * until then this is what proves the events are a faithful second view rather than a plausible one.
 */
describe("emitted mutant events agree with recorded outcomes", () => {
  test("every scored outcome has exactly one mutant-scored or mutant-carried event", () => {
    const events: RunEvent[] = [];
    const emit = createEmitter([(e) => events.push(e)]);

    // Drive `record` through a fake store, once per verdict kind plus one carried.
    // (The implementer wires this against the existing fake-store helper in
    // packages/runner/tests/ — find it by grepping for `recordMutant` in the tests directory.)
    const recorded = driveRecordOverFakeStore(emit);

    const mutantEvents = events.filter(
      (e) => e.type === "mutant-scored" || e.type === "mutant-carried",
    );
    expect(mutantEvents).toHaveLength(recorded.length);
    for (const o of recorded) {
      const matches = mutantEvents.filter((e) => "mutantCode" in e && e.mutantCode === o.mutantCode);
      expect(matches).toHaveLength(1);
    }
  });

  test("a carried outcome emits mutant-carried, never mutant-scored", () => {
    const events: RunEvent[] = [];
    const emit = createEmitter([(e) => events.push(e)]);
    driveOneCarriedRecord(emit);
    expect(events.some((e) => e.type === "mutant-carried")).toBe(true);
    expect(events.some((e) => e.type === "mutant-scored")).toBe(false);
  });
});
```

Implement `driveRecordOverFakeStore` and `driveOneCarriedRecord` in the same file against the existing fake-store pattern in `packages/runner/tests/`. Do not invent a new fake — reuse the one the orchestrator tests already use.

- [ ] **Step 4: Run the full runner suite**

```bash
cd U:/Git/LethAL && bun run typecheck && rm -rf packages/*/dist && bun test packages/runner
```

Expected: PASS, including `report-equality.test.ts` from Task 1 — the report is unchanged by this task.

- [ ] **Step 5: Commit**

```bash
cd U:/Git/LethAL && bunx biome check packages/runner/src/orchestrator.ts packages/runner/tests/events-orchestrator.test.ts
git add packages/runner/src/orchestrator.ts packages/runner/tests/events-orchestrator.test.ts
git commit -m "feat(events): emit from record() and the phase boundaries, warnings included"
```

---

### Task 4: The presence-asserting fold

The dangerous task. Task 1's harness is the safety net; it must stay green.

**Files:**
- Create: `packages/runner/src/report-fold.ts`
- Test: `packages/runner/tests/report-fold.test.ts`
- Modify: `packages/runner/src/orchestrator.ts` (the single `buildReport` call site)

**Interfaces:**
- Consumes: `RunEvent` from `events.ts`; `BuildReportInput` from `report.ts`.
- Produces: `foldEvents(events: readonly RunEvent[], statics: FoldStatics): BuildReportInput` and `FoldStatics`.

- [ ] **Step 1: Write the failing tests**

Create `packages/runner/tests/report-fold.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { foldEvents } from "../src/report-fold";
import type { RunEvent } from "../src/events";
import type { FoldStatics } from "../src/report-fold";

const STATICS: FoldStatics = {
  caps: { authoritative: true, coverage: "procedure" } as never,
  notInstrumented: { totalFiles: 3, files: [] },
};

function seq(events: readonly Omit<RunEvent, "seq">[]): RunEvent[] {
  return events.map((e, i) => ({ ...e, seq: i + 1 }) as RunEvent);
}

describe("foldEvents", () => {
  test("THROWS when mutation-set-generated never arrived", () => {
    const events = seq([
      { type: "baseline-finished", testCount: 5, failingCount: 0 },
      { type: "session-finished", elapsedMs: 10 },
    ]);
    expect(() => foldEvents(events, STATICS)).toThrow(/mutation-set-generated/);
  });

  test("THROWS when neither baseline-finished nor quarantined arrived", () => {
    const events = seq([
      { type: "mutation-set-generated", siteCount: 9, deployedCount: 8, totalFiles: 3, instrumentableFiles: 2 },
      { type: "session-finished", elapsedMs: 10 },
    ]);
    expect(() => foldEvents(events, STATICS)).toThrow(/baseline-finished.*quarantined/s);
  });

  test("THROWS when session-finished never arrived — a truncated stream is not a report", () => {
    const events = seq([
      { type: "mutation-set-generated", siteCount: 9, deployedCount: 8, totalFiles: 3, instrumentableFiles: 2 },
      { type: "baseline-finished", testCount: 5, failingCount: 0 },
    ]);
    expect(() => foldEvents(events, STATICS)).toThrow(/session-finished/);
  });

  test("accepts the quarantined path instead of baseline-finished", () => {
    const events = seq([
      { type: "mutation-set-generated", siteCount: 9, deployedCount: 8, totalFiles: 3, instrumentableFiles: 2 },
      { type: "quarantined", reason: "test in-flight-unknown" },
      { type: "session-finished", elapsedMs: 10 },
    ]);
    expect(() => foldEvents(events, STATICS)).not.toThrow();
  });

  test("a carried event contributes NO duration to the mutant clock", () => {
    const events = seq([
      { type: "mutation-set-generated", siteCount: 2, deployedCount: 2, totalFiles: 1, instrumentableFiles: 1 },
      { type: "baseline-finished", testCount: 1, failingCount: 0 },
      { type: "mutant-scored", mutantCode: "M0001", verdict: "killed", batchIndex: 0, durationMs: 1000, coveringTests: [] },
      { type: "mutant-carried", mutantCode: "M0002", verdict: "survived", fromRunId: 1, priorDurationMs: 9999, coveringTests: [] },
      { type: "session-finished", elapsedMs: 5000 },
    ]);
    const input = foldEvents(events, STATICS);
    const total = input.outcomes.reduce((n, o) => n + (o.durationMs ?? 0), 0);
    expect(total).toBe(1000);
    expect(input.outcomes.find((o) => o.mutant.mutantId === "M0002")?.carried).toBe(true);
  });

  test("batch-invalidated rewrites the affected verdicts", () => {
    const events = seq([
      { type: "mutation-set-generated", siteCount: 1, deployedCount: 1, totalFiles: 1, instrumentableFiles: 1 },
      { type: "baseline-finished", testCount: 1, failingCount: 0 },
      { type: "mutant-scored", mutantCode: "M0001", verdict: "survived", batchIndex: 2, durationMs: 5, coveringTests: [] },
      { type: "batch-invalidated", batchIndex: 2, reason: "lease lost" },
      { type: "session-finished", elapsedMs: 10 },
    ]);
    const input = foldEvents(events, STATICS);
    const o = input.outcomes.find((x) => x.mutant.mutantId === "M0001");
    expect(o?.verdict).toBe("error");
    expect(o?.failureNote).toMatch(/lease lost/);
  });

  test("an unknown event type is ignored, not fatal", () => {
    const events = seq([
      { type: "mutation-set-generated", siteCount: 1, deployedCount: 1, totalFiles: 1, instrumentableFiles: 1 },
      { type: "baseline-finished", testCount: 1, failingCount: 0 },
      { type: "future-event-from-a-newer-writer" } as never,
      { type: "session-finished", elapsedMs: 10 },
    ]);
    expect(() => foldEvents(events, STATICS)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify they fail**

```bash
cd U:/Git/LethAL && bun test packages/runner/tests/report-fold.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the fold**

Create `packages/runner/src/report-fold.ts`. It is a state machine, not a defaulting reduce. `finalize()` throws unless the mandatory events arrived — `mutation-set-generated`; `baseline-finished` **or** `quarantined`; `session-finished`. Carry the doc comment explaining why:

```ts
/**
 * Folds the run's events into `BuildReportInput` (spec 2026-08-05 §A).
 *
 * THROWS on a missing mandatory event; it never defaults. `BuildReportInput` deliberately makes
 * fields required — `untargetedTriggerCount` is a required `number` because "an absent tally and a
 * measured zero must never look alike" (`report.ts:666`). A defaulting fold would turn every
 * missing event into zero/false/empty, industrialising this project's signature bug across the
 * whole report.
 *
 * `mutant-carried` has no `durationMs` field, so a carried verdict cannot reach the mutant clock
 * even by accident. That is R54 made unrepresentable rather than guarded.
 */
```

Unknown event types are ignored (forward compatibility, per the stream contract). `batch-invalidated` rewrites the verdicts of the named batch to `error` with the reason in `failureNote`, mirroring what `invalidateBatchVerdicts` (`orchestrator.ts:2769`) does today.

- [ ] **Step 4: Switch the orchestrator's single call site**

`buildReport` is called once (`orchestrator.ts`, ~line 2905). Collect events into an array via a subscriber, and build the report from `foldEvents(collected, statics)` instead of the hand-assembled bag. Keep the final sort so the artifact stays deterministic.

- [ ] **Step 5: Run the equality gate — this is the whole point**

```bash
cd U:/Git/LethAL && bun run typecheck && rm -rf packages/*/dist && bun test packages/runner
```

Expected: PASS, and specifically `report-equality.test.ts`'s snapshot **unchanged**. If the snapshot differs, the fold is not behaviour-preserving — do not update the snapshot to make it pass. Diff it, find the field, fix the fold.

- [ ] **Step 6: Commit**

```bash
cd U:/Git/LethAL && bunx biome check packages/runner/src/report-fold.ts packages/runner/tests/report-fold.test.ts packages/runner/src/orchestrator.ts
git add packages/runner/src/report-fold.ts packages/runner/tests/report-fold.test.ts packages/runner/src/orchestrator.ts
git commit -m "refactor(report): fold the report from events, throwing rather than defaulting"
```

---

### Task 5: The stderr progress renderer

**Files:**
- Create: `packages/runner/src/progress-renderer.ts`
- Test: `packages/runner/tests/progress-renderer.test.ts`
- Modify: `packages/runner/src/cli.ts` (register the subscriber)

**Interfaces:**
- Consumes: `RunEvent`, `EventSubscriber` from `events.ts`.
- Produces: `createProgressRenderer(write: (line: string) => void, opts: { readonly heartbeatMs: number }): EventSubscriber`.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, test } from "bun:test";
import { createProgressRenderer } from "../src/progress-renderer";
import type { RunEvent } from "../src/events";

function lines(): { out: string[]; write: (l: string) => void } {
  const out: string[] = [];
  return { out, write: (l) => out.push(l) };
}
const ev = (e: Omit<RunEvent, "seq">, seq = 1): RunEvent => ({ ...e, seq }) as RunEvent;

describe("progress renderer", () => {
  test("names the phase on entry", () => {
    const { out, write } = lines();
    createProgressRenderer(write, { heartbeatMs: 30_000 })(ev({ type: "phase-entered", phase: "baseline", detail: "409 tests" }));
    expect(out[0]).toContain("baseline");
    expect(out[0]).toContain("409 tests");
  });

  test("reports both site and deployed counts — R92", () => {
    const { out, write } = lines();
    createProgressRenderer(write, { heartbeatMs: 30_000 })(
      ev({ type: "mutation-set-generated", siteCount: 176, deployedCount: 148, totalFiles: 554, instrumentableFiles: 441 }),
    );
    expect(out[0]).toContain("176");
    expect(out[0]).toContain("148");
  });

  test("surfaces a warning rather than swallowing it", () => {
    const { out, write } = lines();
    createProgressRenderer(write, { heartbeatMs: 30_000 })(ev({ type: "warning", code: "stale-lease", message: "lease is old" }));
    expect(out[0]).toContain("lease is old");
  });

  test("does not print one line per mutant — the final table already exists", () => {
    const { out, write } = lines();
    const r = createProgressRenderer(write, { heartbeatMs: 30_000 });
    for (let i = 0; i < 50; i++) {
      r(ev({ type: "mutant-scored", mutantCode: `M${i}`, verdict: "killed", batchIndex: 0, durationMs: 1, coveringTests: [] }, i + 1));
    }
    expect(out.length).toBeLessThan(5);
  });
});
```

- [ ] **Step 2: Run to verify failure, then implement**

Implement `createProgressRenderer`. Mutant events update an internal counter and emit at most one line per `heartbeatMs` (`mutants: 63/148, 2.4s median`), because a 473-mutant run must not produce 473 lines when the final table already exists.

- [ ] **Step 3: Register on stderr in `cli.ts`**

Wire it as a subscriber writing to `process.stderr`. **stderr, not stdout** — the report goes to stdout, and mixing them is what made piping run output through `grep` swallow real errors twice during the campaign.

- [ ] **Step 4: Run tests and commit**

```bash
cd U:/Git/LethAL && bun run typecheck && rm -rf packages/*/dist && bun test packages/runner
bunx biome check packages/runner/src/progress-renderer.ts packages/runner/tests/progress-renderer.test.ts packages/runner/src/cli.ts
git add packages/runner/src/progress-renderer.ts packages/runner/tests/progress-renderer.test.ts packages/runner/src/cli.ts
git commit -m "feat(progress): human progress lines on stderr during the run"
```

---

### Task 6: The NDJSON sink

**Files:**
- Create: `packages/runner/src/progress-ndjson.ts`
- Test: `packages/runner/tests/progress-ndjson.test.ts`
- Modify: `packages/runner/src/cli.ts` (`--progress-out <path>`)

**Interfaces:**
- Consumes: `RunEvent`, `EventSubscriber`, `STREAM_SCHEMA_VERSION` from `events.ts`.
- Produces: `createNdjsonSink(write: (chunk: string) => void): EventSubscriber`.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, test } from "bun:test";
import { createNdjsonSink } from "../src/progress-ndjson";
import { STREAM_SCHEMA_VERSION } from "../src/events";
import type { RunEvent } from "../src/events";

const ev = (e: Omit<RunEvent, "seq">, seq: number): RunEvent => ({ ...e, seq }) as RunEvent;

describe("ndjson sink", () => {
  test("writes one JSON object per line, seq preserved", () => {
    const chunks: string[] = [];
    const sink = createNdjsonSink((c) => chunks.push(c));
    sink(ev({ type: "stream-started", streamSchemaVersion: STREAM_SCHEMA_VERSION, runId: 1 }, 1));
    sink(ev({ type: "phase-entered", phase: "deploy" }, 2));
    const parsed = chunks.join("").trim().split("\n").map((l) => JSON.parse(l));
    expect(parsed).toHaveLength(2);
    expect(parsed[1]).toMatchObject({ type: "phase-entered", seq: 2 });
  });

  test("a mutant-carried line has no durationMs key", () => {
    const chunks: string[] = [];
    const sink = createNdjsonSink((c) => chunks.push(c));
    sink(ev({ type: "mutant-carried", mutantCode: "M1", verdict: "survived", fromRunId: 2, priorDurationMs: 10, coveringTests: [] }, 1));
    const parsed = JSON.parse(chunks.join("").trim());
    expect("durationMs" in parsed).toBe(false);
  });
});
```

- [ ] **Step 2: Implement, wire `--progress-out`, and document the provisional-verdict rule**

The sink serialises each event followed by `\n`. Add `--progress-out <path>` to `cli.ts`'s `parseArgs` options and to the help text, with the line: *verdict lines are provisional until `session-finished` — a `batch-invalidated` event can supersede them.*

- [ ] **Step 3: Prove it survives a crash**

Run a session that throws mid-mutants (point `--project` at the sandbox fixture and kill it), then confirm the NDJSON file holds the events emitted before the crash and that `seq` is contiguous up to the truncation. This is the crash-diagnosis case R89's three stranded attempts needed and did not have.

- [ ] **Step 4: Run tests and commit**

```bash
cd U:/Git/LethAL && bun run typecheck && rm -rf packages/*/dist && bun test packages/runner
bunx biome check packages/runner/src/progress-ndjson.ts packages/runner/tests/progress-ndjson.test.ts packages/runner/src/cli.ts
git add packages/runner/src/progress-ndjson.ts packages/runner/tests/progress-ndjson.test.ts packages/runner/src/cli.ts
git commit -m "feat(progress): --progress-out NDJSON sink for agents, CI and crash diagnosis"
```

---

## The live gate — non-negotiable, and it is not optional after Task 4

This refactor changes how every verdict reaches the report. Unit tests are structurally blind to AL that cannot compile and to real BC behaviour.

Before merging, run both frozen gates and compare **per mutant**, not on aggregates:

```bash
LETHAL_ITEST_BCDEV=1 bun run itest:bcdev      # frozen: 3 killed / 10 survived / 3 no-coverage
LETHAL_ITEST_TABLES=1 bun run itest:tables    # frozen: 109 / 17 / 10 over 136 deployed,
                                              # untargetedTriggerCount 0, and EXACTLY ONE expected
                                              # baseline failure — Data Tests.PageActionComputesNonZero
```

A differing verdict is a BLOCK, never "close enough". `itest:tables` asserts that one named test fails and that the refusal is named in the report — do not "fix" that by making the baseline green.
