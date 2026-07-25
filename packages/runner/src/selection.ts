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
 * ANYTHING in that object — the only lookup that can ever match a trigger, since
 * `SymbolReference.json` never records a trigger at all (`AppMethodIndex.lookup` — see
 * `bcdev-backend.ts:606` — can therefore never name one; `app-package.ts:137-149` builds the
 * index exclusively from that file). See `coverageFilter`'s trigger-fallback branch.
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
    if (!testKeys || testKeys.size === 0) {
      uncovered.push(m);
      continue;
    }
    covered.set(
      m.mutantId,
      [...testKeys].flatMap((k) => byKey.get(k) ?? []),
    );
  }
  return { covered, uncovered };
}
