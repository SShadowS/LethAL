/**
 * R197: the order a mutant's covering tests are tried in.
 *
 * Until R197 they ran in coverage-index order, which is baseline discovery order, and a kill
 * therefore landed wherever the killing test happened to sit. Measured on one real run (296
 * kills, hosted sandbox at about 0.5 s a call): the killer was the first test tried for 48% of
 * kills and sat at position 9.4 on average, 2,476 passing calls and 21 minutes before kills. Of
 * the 257 kills with an earlier kill in the SAME procedure, 207 (81%) were by a test that had
 * already killed there. That information exists inside the run at the moment it is needed, and
 * this module is where it is kept.
 *
 * The order is a heuristic about COST, never about verdicts: a survivor still runs every covering
 * test, and a kill is still confirmed against the baseline. What it changes is WHICH of several
 * killing tests is met first, so `killingTest` in the report can differ from a run before R197
 * where more than one test kills. Every committed per-mutant baseline was re-recorded on that
 * understanding, with the proof that only `killingTest` moved.
 *
 * Deterministic by construction: the ledger is filled in scoring order, and ties fall through to
 * the qualified test name, so a resumed or repeated run over the same prior kills orders the same.
 */
import type { MutantManifestEntry } from "@lethal/schemata";
import type { TestMethodRef } from "./backend";
import { testKeyOf } from "./selection";

/** The tie-break name: codeunit plus method, the same shape the report prints. */
function nameOf(ref: TestMethodRef): string {
  return `${ref.codeunitName}.${ref.method}`;
}

/** Kills seen so far this session, by procedure scope and then by test. Shared across shards. */
export interface KillLedger {
  readonly killsByProcedure: Map<string, Map<string, number>>;
}

export function newKillLedger(): KillLedger {
  return { killsByProcedure: new Map() };
}

/** The scope a kill is remembered under: the object plus the procedure or trigger. */
export function procedureScopeOf(m: MutantManifestEntry): string {
  return `${m.codeunitName}|${m.procedureName || m.triggerName || ""}`;
}

export function recordKill(ledger: KillLedger, m: MutantManifestEntry, ref: TestMethodRef): void {
  const scope = procedureScopeOf(m);
  const byTest = ledger.killsByProcedure.get(scope) ?? new Map<string, number>();
  const key = testKeyOf(ref);
  byTest.set(key, (byTest.get(key) ?? 0) + 1);
  ledger.killsByProcedure.set(scope, byTest);
}

/**
 * How many distinct members each test was observed to cover at baseline, from the coverage
 * index's `byMember` map. A test that covers few members is a narrow test, and a narrow test that
 * covers THIS mutant's member is likelier to assert on it than a broad end-to-end test that merely
 * passes through.
 */
export function memberCountsByTest(
  byMember: ReadonlyMap<string, ReadonlySet<string>>,
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const tests of byMember.values()) {
    for (const t of tests) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return counts;
}

/**
 * The order to try `covering` in for mutant `m`:
 *
 *   1. tests that have already killed a mutant in the same procedure this session, most kills
 *      first (the 81% measurement above);
 *   2. then the narrowest test, by members covered at baseline, fewest first;
 *   3. then the fastest at baseline, so a wrong guess costs least;
 *   4. then the qualified name, so the order is total and repeatable.
 *
 * Returns a new array; `covering` is not modified, since it is the coverage index's own list.
 */
export function orderCoveringTests(
  covering: readonly TestMethodRef[],
  m: MutantManifestEntry,
  ledger: KillLedger,
  memberCounts: ReadonlyMap<string, number>,
  baselineDuration: ReadonlyMap<string, number>,
): TestMethodRef[] {
  const kills = ledger.killsByProcedure.get(procedureScopeOf(m));
  const rank = (ref: TestMethodRef) => {
    const key = testKeyOf(ref);
    return {
      kills: kills?.get(key) ?? 0,
      members: memberCounts.get(key) ?? Number.POSITIVE_INFINITY,
      ms: baselineDuration.get(key) ?? Number.POSITIVE_INFINITY,
      name: nameOf(ref),
    };
  };
  return [...covering]
    .map((ref) => ({ ref, r: rank(ref) }))
    .sort(
      (a, b) =>
        b.r.kills - a.r.kills ||
        a.r.members - b.r.members ||
        a.r.ms - b.r.ms ||
        a.r.name.localeCompare(b.r.name),
    )
    .map((x) => x.ref);
}
