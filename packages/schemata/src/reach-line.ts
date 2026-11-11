import { originalPositions } from "./compile-emit";
import type { FilePlan } from "./project-plan";

/**
 * R926. Each statement-grain mutant's `reachLine`: the line, in al-runner's coverage frame, where
 * the ORIGINAL copy of its reach statement starts in `compiled` (the text `emitOneFile` built).
 *
 * Until a mutant's own statement runs, a mutant run is the baseline run, and a baseline run
 * executes the original copy (the chain's `else begin` branch), not the mutant's branch. The
 * instrumented text does NOT keep the source's line numbers (a chain adds lines and copies the
 * root once per member), and al-runner reports lines of the instrumented text, counted from one
 * past the previous top-level object's last line (`line-map.ts`: `objectLine = fileLine -
 * baseLine + 1`). So the source offsets are mapped into `compiled` and the lines subtracted. Two
 * mutants on one statement share one original copy, so they get one line. A side table only: it
 * reads `compiled` and changes nothing in it. (Not an EMIT module: it decides nothing about the
 * text, and the EMIT lookup rule does not apply to it.)
 */
export function reachLinesOf(plan: FilePlan, compiled: string): ReadonlyMap<string, number> {
  const where = originalPositions(plan.compile);
  const lineStarts: number[] = [0];
  for (let i = compiled.indexOf("\n"); i !== -1; i = compiled.indexOf("\n", i + 1)) {
    lineStarts.push(i + 1);
  }
  const lineAt = (offset: number): number => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((lineStarts[mid] ?? 0) <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  const out = new Map<string, number>();
  for (const m of plan.compile.members) {
    const site = m.reachSite;
    if (site === undefined) continue;
    const stmt = where(site.stmt);
    const prevAt = site.prevEnd < 0 ? undefined : where(site.prevEnd);
    if (stmt === undefined || (site.prevEnd >= 0 && prevAt === undefined)) continue;
    const prev = prevAt === undefined ? 0 : lineAt(prevAt);
    out.set(m.mutantId, lineAt(stmt) - prev);
  }
  return out;
}
