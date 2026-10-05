import type { MutationSpec } from "@lethal/engine";

export interface IdedSpec {
  readonly mutantId: string;
  readonly spec: MutationSpec;
}

/**
 * R475: order two strings by UTF-16 code unit, the order `.sort()` and the generation hash use.
 * Never `localeCompare`: with no fixed locale it collates by the HOST's default, so two hosts
 * could number the same source's identity twins (and mutant codes) differently.
 */
export function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function assignMutantIds(
  specsByFile: ReadonlyMap<string, readonly MutationSpec[]>,
): Map<string, IdedSpec[]> {
  const sortedPaths = [...specsByFile.keys()].sort();
  const out = new Map<string, IdedSpec[]>();
  let counter = 1;
  for (const path of sortedPaths) {
    const specs = [...(specsByFile.get(path) ?? [])].sort((a, b) => {
      const si = a.before.startIndex - b.before.startIndex;
      if (si !== 0) return si;
      return compareCodeUnits(a.operatorName, b.operatorName);
    });
    const ided = specs.map((spec) => ({
      mutantId: `M${String(counter++).padStart(4, "0")}`,
      spec,
    }));
    out.set(path, ided);
  }
  return out;
}
