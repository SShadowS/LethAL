import type { MutantManifestEntry } from "@lethal/schemata";

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

export interface OverlapSite {
  readonly file: string;
  readonly startIndex: number;
  readonly endIndex: number;
}

function overlaps<T extends OverlapSite>(a: T, b: T): boolean {
  return a.file === b.file && a.startIndex < b.endIndex && b.startIndex < a.endIndex;
}

export function batchByOverlap<T extends OverlapSite>(mutants: readonly T[]): T[][] {
  const sorted = [...mutants].sort(
    (a, b) => a.file.localeCompare(b.file) || a.startIndex - b.startIndex,
  );
  const batches: T[][] = [];
  for (const m of sorted) {
    let placed = false;
    for (const batch of batches) {
      if (!batch.some((x) => overlaps(x, m))) {
        batch.push(m);
        placed = true;
        break;
      }
    }
    if (!placed) batches.push([m]);
  }
  return batches;
}
