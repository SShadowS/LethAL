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

export type CoverageIndex = ReadonlyMap<string, ReadonlySet<string>>;

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
  const index = new Map<string, Set<string>>();
  for (const b of baseline) {
    for (const e of b.coverage?.entries ?? []) {
      const key = `${e.objectId}::${e.procedure.toLowerCase()}`;
      let set = index.get(key);
      if (!set) {
        set = new Set();
        index.set(key, set);
      }
      set.add(testKeyOf(b.ref));
    }
  }
  return index;
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
    const testKeys = index.get(`${m.codeunitId}::${m.procedureName.toLowerCase()}`);
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
