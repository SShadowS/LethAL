// Summarise census702 output for one set. usage: bun summ702.ts <outdir> <set> [list]
// Production = project path without "test" (as R-696). Counts only; "list" prints loop names for mover/inserter loops.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const [dir, set, list] = process.argv.slice(2);
if (dir === undefined || set === undefined) throw new Error("usage");
const projs = readFileSync(join(dir, set, "projects.tsv"), "utf8").trim().split("\n").map((l) => l.split("\t") as [string, string]);
type Call = { methods?: string[]; sameObject?: boolean; line: number; kind: string; cls: string; reason: string; callee: string[]; movers: number; inserters: number };
type Row = { keysAll?: boolean; obj: string; file: string; proc: string; line: number; table: string; ownMovers: number; calls: Call[] };
for (const prod of [true, false]) {
  let loops = 0;
  let own = 0;
  let withCalls = 0;
  const lc: Record<string, number> = {};
  const cc: Record<string, number> = {};
  const kind: Record<string, number> = {};
  const reasons: Record<string, number> = {};
  const extra: Record<string, number> = {};
  let calls = 0;
  let resolved = 0;
  let errs = 0;
  for (const [i, p] of projs) {
    if (/test/i.test(p) === prod) continue;
    const f = join(dir, set, `${i}.json`);
    if (!existsSync(f)) continue;
    const j = JSON.parse(readFileSync(f, "utf8"));
    if (j.error) {
      errs++;
      continue;
    }
    for (const r of j.rows as Row[]) {
      loops++;
      if (r.ownMovers > 0) own++;
      if (r.calls.length === 0) continue;
      withCalls++;
      for (const c of r.calls) {
        calls++;
        cc[c.cls] = (cc[c.cls] ?? 0) + 1;
        kind[c.kind] = (kind[c.kind] ?? 0) + 1;
        if (c.cls !== "unresolved") resolved++;
        else reasons[c.reason] = (reasons[c.reason] ?? 0) + 1;
      }
      const cl = r.calls.some((c) => c.cls === "mover")
        ? "callee-mover"
        : r.calls.some((c) => c.cls === "inserter")
          ? "callee-inserter"
          : r.calls.some((c) => c.cls === "unresolved")
            ? "unresolved"
            : "callee-clean";
      const key = r.ownMovers > 0 ? `${cl} (own mover already)` : cl;
      lc[key] = (lc[key] ?? 0) + 1;
      if ((cl === "callee-mover" || cl === "callee-inserter") && r.ownMovers === 0) {
        const kk = r.keysAll ? "keys-all(fail-closed)" : "keys-known";
        extra[kk] = (extra[kk] ?? 0) + 1;
        for (const c of r.calls)
          for (const m of c.methods ?? []) extra[`method:${m}`] = (extra[`method:${m}`] ?? 0) + 1;
        const so = r.calls.filter((c) => c.cls === "mover" || c.cls === "inserter").every((c) => c.sameObject) ? "same-object" : "other-object";
        extra[so] = (extra[so] ?? 0) + 1;
      }
      if (list !== undefined && prod && (cl === "callee-mover" || cl === "callee-inserter") && r.ownMovers === 0)
        console.log(`LOOP\t${cl}\t${set}\t${p.replace(/^\/work\/src\//, "")}\t${r.file}\t${r.obj}\t${r.proc}\t${r.line}\t${r.table}\t${r.calls.filter((c) => c.cls === "mover" || c.cls === "inserter").map((c) => `${c.kind}@${c.line}->${c.callee.join("+")}`).join(";")}`);
    }
  }
  console.log(JSON.stringify({ set, scope: prod ? "production" : "test", errs, shapeBLoops: loops, ownMoverLoops: own, loopsWithCalls: withCalls, calls, resolvedCalls: resolved, callClass: cc, callKind: kind, loopClass: lc, unresolvedReasons: reasons, moverLoopDetail: extra }));
}
