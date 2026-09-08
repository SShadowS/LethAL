/** One-off: how many `DeleteAll(true)` / `ModifyAll(..., true)` sites do the reference corpora hold? */
import { ALNodeKind } from "../packages/engine/src/ast/node-kinds";
import { initParser } from "../packages/engine/src/ast/parser";
import type { ALSyntaxNode } from "../packages/engine/src/ast/syntax-node";
import { buildSemanticContext } from "../packages/engine/src/semantic/context";
import { claimsRecordMethod } from "../packages/engine/src/semantic/receiver";
import { collectAlFiles } from "./lib/collect-al-files";

await initParser();

/** The call's trailing argument, as text, or null. */
function lastArgument(call: ALSyntaxNode): string | null {
  const args = call.children.find((c) => c.rawKind === "argument_list");
  if (args === undefined) return null;
  const named = args.namedChildren;
  const last = named[named.length - 1];
  return last === undefined ? null : last.text.trim();
}

for (const dir of ["U:/Git/do-rel2/Cloud", "U:/Git/do-lethal-53470/Cloud"]) {
  const files = await collectAlFiles(dir);
  const ctx = buildSemanticContext(files);
  const stats: Record<string, { calls: number; onRecord: number; trueFlag: number }> = {
    DeleteAll: { calls: 0, onRecord: 0, trueFlag: 0 },
    ModifyAll: { calls: 0, onRecord: 0, trueFlag: 0 },
  };
  const walk = (n: ALSyntaxNode): void => {
    if (n.kind === ALNodeKind.procedure_call) {
      for (const method of ["DeleteAll", "ModifyAll"]) {
        const onRecord = claimsRecordMethod(n, ctx, method);
        if (!onRecord) continue;
        const s = stats[method];
        if (s === undefined) continue;
        s.calls += 1;
        s.onRecord += 1;
        if ((lastArgument(n) ?? "").toLowerCase() === "true") s.trueFlag += 1;
      }
    }
    for (const c of n.children) walk(c);
  };
  for (const f of files) walk(f.root);
  console.log(`${dir.split("/").slice(-2).join("/")}  (${files.length} files)`);
  for (const [m, s] of Object.entries(stats)) {
    console.log(`   ${m.padEnd(10)} on a resolved Record: ${String(s.onRecord).padStart(4)}   of those, trailing \`true\`: ${s.trueFlag}`);
  }
}
