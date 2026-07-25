import type { MutantManifestEntry } from "@lethal/schemata";
import type { CoverageMap, TestMethodRef } from "./backend";

export interface IdentityKey {
  readonly astHash: string;
  readonly codeunitName: string;
  readonly operatorName: string;
  readonly operatorMajor: number;
}

export function identityKeyOf(m: MutantManifestEntry): IdentityKey {
  return {
    astHash: m.astHash,
    codeunitName: m.codeunitName,
    operatorName: m.operatorName,
    operatorMajor: Number(m.operatorVersion.split(".")[0] ?? "0"),
  };
}

export function serializeKey(k: IdentityKey): string {
  return `${k.astHash}|${k.codeunitName}|${k.operatorName}|${k.operatorMajor}`;
}

export interface HistorySplit {
  readonly execute: MutantManifestEntry[];
  readonly knownSurvivors: MutantManifestEntry[];
}

export function filterHistory(
  mutants: readonly MutantManifestEntry[],
  priorSurvivorKeys: ReadonlySet<string>,
  opts: { skipKnownSurvivors: boolean },
): HistorySplit {
  if (!opts.skipKnownSurvivors) return { execute: [...mutants], knownSurvivors: [] };
  const execute: MutantManifestEntry[] = [];
  const knownSurvivors: MutantManifestEntry[] = [];
  for (const m of mutants) {
    if (priorSurvivorKeys.has(serializeKey(identityKeyOf(m)))) knownSurvivors.push(m);
    else execute.push(m);
  }
  return { execute, knownSurvivors };
}

/**
 * `byMember` is the precise `<objectId>::<member>` index (exact, correct for every ordinary
 * procedure). `byObject` is a coarser `<objectId>` index carrying every test that covered
 * ANYTHING in that object — the finer of the two lookups that can match a trigger, since
 * `SymbolReference.json` never records a trigger at all (`AppMethodIndex.lookup` — see
 * `bcdev-backend.ts:606` — can therefore never name one; `app-package.ts:137-149` builds the
 * index exclusively from that file). When neither index names a trigger mutant, `coverageFilter`
 * falls back further still, to every green test — see its trigger-fallback branches.
 */
export interface CoverageIndex {
  readonly byMember: ReadonlyMap<string, ReadonlySet<string>>;
  readonly byObject: ReadonlyMap<number, ReadonlySet<string>>;
}

export interface CoverageSplit {
  readonly covered: ReadonlyMap<string, readonly TestMethodRef[]>;
  readonly uncovered: MutantManifestEntry[];
}

export function testKeyOf(ref: TestMethodRef): string {
  return `${ref.codeunitId}::${ref.method}`;
}

export function buildCoverageIndex(
  baseline: ReadonlyArray<{ ref: TestMethodRef; coverage?: CoverageMap }>,
): CoverageIndex {
  const byMember = new Map<string, Set<string>>();
  const byObject = new Map<number, Set<string>>();
  for (const b of baseline) {
    for (const e of b.coverage?.entries ?? []) {
      const memberKey = `${e.objectId}::${e.procedure.toLowerCase()}`;
      let memberSet = byMember.get(memberKey);
      if (!memberSet) {
        memberSet = new Set();
        byMember.set(memberKey, memberSet);
      }
      memberSet.add(testKeyOf(b.ref));

      let objectSet = byObject.get(e.objectId);
      if (!objectSet) {
        objectSet = new Set();
        byObject.set(e.objectId, objectSet);
      }
      objectSet.add(testKeyOf(b.ref));
    }
  }
  return { byMember, byObject };
}

export function coverageFilter(
  mutants: readonly MutantManifestEntry[],
  index: CoverageIndex,
  allTests: readonly TestMethodRef[],
): CoverageSplit {
  const byKey = new Map(allTests.map((t) => [testKeyOf(t), t]));
  const covered = new Map<string, TestMethodRef[]>();
  const uncovered: MutantManifestEntry[] = [];
  // Task 5 amendment: how many trigger mutants fell through to the untargeted (all-green-tests)
  // fallback below, tallied so the warning fires once per run rather than once per mutant.
  let untargetedTriggerCount = 0;
  for (const m of mutants) {
    // Member-level first: precise, and correct for every ordinary procedure.
    let testKeys = index.byMember.get(`${m.codeunitId}::${m.procedureName.toLowerCase()}`);
    // A trigger has no member-level entry to match — SymbolReference.json does not record
    // triggers at all, so AppMethodIndex can never name one. Fall back to "any test that covered
    // ANYTHING in this object". Deliberately conservative: it may run more tests than strictly
    // needed, but it never wrongly reports a mutant as no-coverage, which would silently hide a
    // live mutation site.
    if ((testKeys === undefined || testKeys.size === 0) && m.triggerName !== undefined) {
      testKeys = index.byObject.get(m.codeunitId);
    }
    // A live-gate run found real trigger mutants BC's coverage index cannot name at ANY
    // precision — object-level came back empty too. We genuinely don't know which tests reach
    // that trigger, and the honest response to "I don't know" is to run every green test, not to
    // silently report no-coverage: skipping would hide a live mutation site, which is the exact
    // failure this layer exists to prevent. Over-running costs time; under-running hides bugs.
    // Gated on `triggerName` so an ordinary uncovered procedure — genuinely untested — still
    // reports `no-coverage` instead of inflating every run.
    if ((testKeys === undefined || testKeys.size === 0) && m.triggerName !== undefined) {
      covered.set(m.mutantId, [...allTests]);
      untargetedTriggerCount++;
      continue;
    }
    if (!testKeys || testKeys.size === 0) {
      uncovered.push(m);
      continue;
    }
    covered.set(
      m.mutantId,
      [...testKeys].flatMap((k) => byKey.get(k) ?? []),
    );
  }
  if (untargetedTriggerCount > 0) {
    console.warn(
      `[lethal] ${untargetedTriggerCount} trigger mutant(s) could not be coverage-matched (BC does not report coverage for trigger code) — running each against all ${allTests.length} green test(s).`,
    );
  }
  return { covered, uncovered };
}
