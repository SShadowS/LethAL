import assert from "node:assert/strict";
import type { TestVerdict } from "../src/backend";
import type { SessionReport } from "../src/report";

/**
 * GH-24 Task 5. Pre-committed reach assertions for the live gates (bcdev, tables, chunked,
 * envtool, al-runner), extracted into their own module — the `notinstrumented-evidence.ts`
 * pattern — so every check can be red-checked offline against a hand-built report, without a
 * second billed live run.
 *
 * `guardReached`/`reachedBy`/`reachGrain` are all OPTIONAL report fields (GH-24 plan Decision 9):
 * nothing here is a frozen figure, and nothing here freezes one. See `report.ts`'s doc comments on
 * `MutantOutcome.guardReached`/`reachedBy`/`reachGrain` for what each proves.
 */

/** Grain counts across every mutant in a report — printed by every gate. */
export interface ReachGrainCounts {
  readonly statement: number;
  readonly enclosing: number;
  readonly unplaced: number;
  /** A manifest written before GH-24 carries no grain at all — "not recorded", never a grain. */
  readonly none: number;
}

export function reachGrainCounts(report: SessionReport): ReachGrainCounts {
  const counts = { statement: 0, enclosing: 0, unplaced: 0, none: 0 };
  for (const m of report.mutants) {
    if (m.reachGrain === undefined) counts.none += 1;
    else counts[m.reachGrain] += 1;
  }
  return counts;
}

/**
 * The reach split over `"statement"`-grain mutants only — the only grain that can ever carry a
 * `MutationSelector.Reached` marker (GH-24 plan Decision 4), so the only grain `guardReached` is
 * ever decided for.
 */
export interface ReachSplit {
  readonly reached: number;
  readonly notReached: number;
  readonly unmeasured: number;
}

export function reachSplit(report: SessionReport): ReachSplit {
  let reached = 0;
  let notReached = 0;
  let unmeasured = 0;
  for (const m of report.mutants) {
    if (m.reachGrain !== "statement") continue;
    if (m.guardReached === true) reached += 1;
    else if (m.guardReached === false) notReached += 1;
    else unmeasured += 1;
  }
  return { reached, notReached, unmeasured };
}

/** One line every gate prints — "each gate PRINTS the reach split and grain counts" (task brief). */
export function reachSummaryLine(report: SessionReport): string {
  const g = reachGrainCounts(report);
  const s = reachSplit(report);
  return (
    `  reach: grain statement=${g.statement} enclosing=${g.enclosing} unplaced=${g.unplaced} ` +
    `none=${g.none}; statement-grain guardReached true=${s.reached} false=${s.notReached} ` +
    `unmeasured=${s.unmeasured}`
  );
}

export function printReachSummary(report: SessionReport): void {
  console.log(reachSummaryLine(report));
}

/**
 * Ruling 2 (GH-24 plan orchestrator rulings): a KILLED statement-grain mutant whose own statement
 * never fired is a possible FALSE KILL, this project's most expensive error — a BLOCK, never a
 * soft warning. Live gates only: a killed mutant here rests on real server answers, so a
 * refutation is a live finding, not a fixture artifact.
 */
export function assertKilledStatementGrainReached(report: SessionReport): void {
  for (const m of report.mutants) {
    if (m.verdict !== "killed" || m.reachGrain !== "statement") continue;
    assert.equal(
      m.guardReached,
      true,
      `GH-24 ruling 2 (BLOCK): killed statement-grain mutant ${m.mutantCode} has guardReached ${JSON.stringify(m.guardReached)}, not true — its own statement may never have run, which makes this a possible false kill`,
    );
  }
}

/**
 * A SURVIVED statement-grain mutant runs every covering test to completion (nothing stops it
 * early the way a kill does), so its reach must always be DECIDED one way or the other —
 * `guardReached` absent here means the fold lost an answer it should have had.
 */
export function assertSurvivedStatementGrainReachDefined(report: SessionReport): void {
  for (const m of report.mutants) {
    if (m.verdict !== "survived" || m.reachGrain !== "statement") continue;
    assert.notEqual(
      m.guardReached,
      undefined,
      `survived statement-grain mutant ${m.mutantCode} has no guardReached — a survivor runs every covering test to completion, so reach must be decided one way or the other`,
    );
  }
}

/**
 * Only a `"statement"`-grain mutant ever carries a `MutationSelector.Reached` marker (GH-24 plan
 * Decision 4) — an `"enclosing"`/`"unplaced"`/absent-grain mutant must never carry `guardReached`,
 * however the server answered.
 */
export function assertNonStatementGrainHasNoGuardReached(report: SessionReport): void {
  for (const m of report.mutants) {
    if (m.reachGrain === "statement") continue;
    assert.equal(
      m.guardReached,
      undefined,
      `mutant ${m.mutantCode} has reachGrain ${JSON.stringify(m.reachGrain)} but carries guardReached ${JSON.stringify(m.guardReached)} — only a "statement"-grain mutant can ever have one`,
    );
  }
}

/**
 * al-runner never attests (GH-24 plan Decision 11): no mutant, of ANY grain, may carry
 * `guardReached` there — a stricter check than `assertNonStatementGrainHasNoGuardReached`, which
 * would let a statement-grain mutant through.
 */
export function assertNoReachAttestation(report: SessionReport): void {
  for (const m of report.mutants) {
    assert.equal(
      m.guardReached,
      undefined,
      `mutant ${m.mutantCode} carries guardReached ${JSON.stringify(m.guardReached)} on a backend that never attests (al-runner, GH-24 plan Decision 11)`,
    );
  }
}

/**
 * `reachGrain` is a compile-time fact (GH-24 plan Decision 4) written for every mutant a manifest
 * built by this codebase carries. Absence is only ever "a manifest written before GH-24", never
 * this build's own output.
 */
export function assertEveryMutantHasReachGrain(report: SessionReport): void {
  for (const m of report.mutants) {
    assert.notEqual(
      m.reachGrain,
      undefined,
      `mutant ${m.mutantCode} carries no reachGrain — every mutant this build generates records one as a compile-time fact (GH-24 plan Decision 4)`,
    );
  }
}

/**
 * `reachedBy` is folded from the SAME covering runs `coveringTests` already names (GH-24 plan
 * Decision 7), so the two populations can never disagree — a name in `reachedBy` that is not in
 * `coveringTests` means the fold read a different test set than the one it recorded.
 */
export function assertReachedByWithinCoveringTests(report: SessionReport): void {
  for (const m of report.mutants) {
    if (m.reachedBy === undefined) continue;
    const covering = new Set(m.coveringTests ?? []);
    for (const name of m.reachedBy) {
      assert.ok(
        covering.has(name),
        `mutant ${m.mutantCode}'s reachedBy names ${JSON.stringify(name)}, which is not in its ` +
          `own coveringTests (${JSON.stringify(m.coveringTests)})`,
      );
    }
  }
}

/**
 * The five bullets shared by bcdev/tables/chunked/envtool (task brief). Prints the summary line
 * BEFORE asserting, so a failing gate's console already carries the split rather than only a
 * bare mutant code.
 */
export function assertReachEvidence(report: SessionReport): void {
  printReachSummary(report);
  assertEveryMutantHasReachGrain(report);
  assertNonStatementGrainHasNoGuardReached(report);
  assertKilledStatementGrainReached(report);
  assertSurvivedStatementGrainReachDefined(report);
  assertReachedByWithinCoveringTests(report);
}

/**
 * chunked.itest.ts: chunking is a cost knob (R208) and must not move what reach was measured, so
 * `guardReached` and `reachedBy` (as a SET — chunking can reorder which covering call reaches a
 * mutant first) must be identical across the unbounded and chunked legs, per mutant.
 */
export function assertReachIdenticalAcrossLegs(
  control: SessionReport,
  chunked: SessionReport,
): void {
  const byCode = new Map(chunked.mutants.map((m) => [m.mutantCode, m]));
  for (const a of control.mutants) {
    const b = byCode.get(a.mutantCode);
    assert.ok(
      b !== undefined,
      `mutant ${a.mutantCode} is in the control leg but missing from the chunked leg`,
    );
    assert.equal(
      a.guardReached,
      b.guardReached,
      `mutant ${a.mutantCode}: guardReached differs across legs (control ${JSON.stringify(a.guardReached)}, chunked ${JSON.stringify(b.guardReached)}) — chunking is a cost knob, never a semantic one`,
    );
    assert.deepEqual(
      new Set(a.reachedBy ?? []),
      new Set(b.reachedBy ?? []),
      `mutant ${a.mutantCode}: reachedBy differs across legs as a SET (control ` +
        `${JSON.stringify(a.reachedBy)}, chunked ${JSON.stringify(b.reachedBy)})`,
    );
  }
}

/** One direct-transport probe result the bcdev gate feeds this check — enough of a `TestVerdict`
 *  to test offline without building a full transport response. */
export interface DirectTransportProbe {
  readonly label: string;
  readonly verdict: Pick<TestVerdict, "outcome" | "reachedActive">;
  /** True for a probe run with no mutant active (`mutantId: ""`) — no marker can ever fire. */
  readonly baseline: boolean;
}

/**
 * bcdev's direct-transport attestation check (bcdev.itest.ts, the attestation-fence block): every
 * `ran` verdict — outcome `pass`/`fail`, the only two outcomes `mapRanResult` ever returns for a
 * `ran` answer — must carry a boolean `reachedActive`, and every BASELINE run (no mutant active,
 * `mutantId: ""`) must report it `false`, since no marker can fire with nothing active.
 */
export function assertDirectTransportReach(probes: readonly DirectTransportProbe[]): void {
  for (const p of probes) {
    const ran = p.verdict.outcome === "pass" || p.verdict.outcome === "fail";
    if (ran) {
      assert.equal(
        typeof p.verdict.reachedActive,
        "boolean",
        `probe ${JSON.stringify(p.label)}: a ran verdict must carry a boolean reachedActive, got ${JSON.stringify(p.verdict.reachedActive)}`,
      );
    }
    if (p.baseline) {
      assert.equal(
        p.verdict.reachedActive,
        false,
        `probe ${JSON.stringify(p.label)}: a BASELINE run (no mutant active) must report ` +
          `reachedActive false, got ${JSON.stringify(p.verdict.reachedActive)}`,
      );
    }
  }
}
