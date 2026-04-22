import type { MutationSpec } from "@lethal/engine";

export interface IdedSpec {
  readonly mutantId: string;
  readonly spec: MutationSpec;
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
      return a.operatorName.localeCompare(b.operatorName);
    });
    const ided = specs.map((spec) => ({
      mutantId: `M${String(counter++).padStart(4, "0")}`,
      spec,
    }));
    out.set(path, ided);
  }
  return out;
}
