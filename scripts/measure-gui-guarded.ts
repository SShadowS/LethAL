/**
 * R60: how much of a real AL project's mutable code sits behind a GUI guard?
 *
 * Measured under R57: LethAL executes every mutant in a `GuiAllowed=No`, `ClientType=ODataV4`
 * session, while a developer running the same suite from VS Code runs GUI-allowed. So AL guarded by
 * `GuiAllowed`, or branching on a `Confirm`, takes the NON-INTERACTIVE path during mutation
 * testing — always. A mutant inside the interactive branch can never be killed, because that branch
 * never executes, and it is reported `survived` or `no-coverage`. Both readings are statements
 * about the test suite; the truth is that LethAL never ran the code.
 *
 * That caveat was unquantified, and an unquantified caveat is either alarmism or complacency
 * depending on who reads it. This counts it.
 *
 * WHAT IT MEASURES, precisely — read this before quoting the number:
 *
 *   `guardedSites` counts mutation sites lexically inside the body of an `if` whose CONDITION
 *   mentions `GuiAllowed` or calls `Confirm(...)`, at any nesting depth.
 *
 * That is a LOWER BOUND, deliberately. It does not follow calls: a procedure invoked only from
 * inside a guarded branch has all of its sites counted as unguarded here, and a `GuiAllowed` early
 * return (`if not GuiAllowed then exit;`) guards its whole procedure without any site being
 * lexically inside the `if`. Both shapes are real. A dataflow-accurate answer needs the semantic
 * layer and reachability, which is R60's own follow-up — this exists to establish the order of
 * magnitude, not the exact figure.
 *
 * Usage:  bun scripts/measure-gui-guarded.ts <projectDir>
 */
// Relative, not "@lethal/engine": scripts/ is outside the workspaces, so the alias does not
// resolve here — the same reason probe-grammar-corpus.ts imports by path.
import { initParser, parseAL, wrapRoot } from "../packages/engine/src/index";
import type { ALSyntaxNode } from "../packages/engine/src/index";
import { generateMutationSet } from "../packages/runner/src/orchestrator";

const projectDir = process.argv[2];
if (projectDir === undefined || projectDir === "") {
  throw new Error("usage: bun scripts/measure-gui-guarded.ts <projectDir>");
}

/** A condition that makes its branch reachable only in a session that can prompt. */
const GUI_CONDITION = /\bGuiAllowed\b|\bConfirm\s*\(/i;
/** Any interactive construct, for the coarser per-procedure tally below. */
const GUI_CALL = /\bGuiAllowed\b|\bConfirm\s*\(|\bMessage\s*\(|\bStrMenu\s*\(|\.RunModal\s*\(/i;

/**
 * Byte ranges of every branch body whose enclosing `if` condition is GUI-dependent.
 *
 * The condition itself is excluded from the range: a mutant ON the condition is perfectly
 * reachable and killable — it is the BODY that never runs.
 */
function guardedRanges(root: ALSyntaxNode): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const walk = (n: ALSyntaxNode): void => {
    if (n.kind === "if_statement") {
      // The grammar emits `if_keyword, <condition>, then_keyword, <body>...`. Slicing on those
      // keyword nodes is what makes this correct — an earlier cut took `children[0]` as the
      // condition, which is the `if_keyword` itself (text "if"), so NOTHING ever matched and the
      // measurement read a confident 0.0%. A zero that comes from a broken predicate looks exactly
      // like a zero that means "no such code".
      // `rawKind`, not `kind`: `if_keyword`/`then_keyword` are real grammar nodes but are outside
      // the CURATED `ALNodeKind` union, and `ALSyntaxNode.kind` merely casts the raw type into
      // that union — so an `indexOf` on `kind` is a type error that says nothing about runtime.
      // Measured on the 554-file do-rel2/Cloud corpus: 4,389 of each. R120.
      const kinds = n.children.map((c) => c.rawKind);
      const ifAt = kinds.indexOf("if_keyword");
      const thenAt = kinds.indexOf("then_keyword");
      if (ifAt !== -1 && thenAt > ifAt) {
        const condition = n.children.slice(ifAt + 1, thenAt);
        const conditionText = condition.map((c) => c.text).join(" ");
        if (GUI_CONDITION.test(conditionText)) {
          for (const c of n.children.slice(thenAt + 1)) ranges.push([c.startIndex, c.endIndex]);
        }
      }
    }
    for (const c of n.children) walk(c);
  };
  walk(root);
  return ranges;
}

await initParser();
const { files, totalFiles } = await generateMutationSet(projectDir);

let totalSites = 0;
let guardedSites = 0;
let sitesInGuiProcedures = 0;
let filesWithGui = 0;
const worstFiles: Array<{ file: string; guarded: number; total: number }> = [];

for (const f of files) {
  totalSites += f.specs.length;
  const hasGui = GUI_CALL.test(f.source);
  if (hasGui) filesWithGui += 1;
  if (!hasGui) continue;

  const root = wrapRoot(parseAL(f.source));
  const ranges = guardedRanges(root);

  // Coarser tally: sites in any procedure that mentions an interactive construct anywhere. An
  // upper-ish bound on "could plausibly be affected", to bracket the lexical figure.
  const guiProcRanges: Array<[number, number]> = [];
  const collectProcs = (n: ALSyntaxNode): void => {
    if (n.kind === "procedure") {
      if (GUI_CALL.test(n.text)) guiProcRanges.push([n.startIndex, n.endIndex]);
    }
    for (const c of n.children) collectProcs(c);
  };
  collectProcs(root);

  let fileGuarded = 0;
  for (const spec of f.specs) {
    // `MutationSpec` carries NO startIndex — position lives on the node it replaces (`before`,
    // whose `astNodeId` is literally `"<start>-<end>"`). Reading `spec.startIndex` yields
    // `undefined`, every containment test is then false, and the script reports a confident 0.0%
    // that looks exactly like "this project has no GUI-guarded code". It did that twice here.
    const at = spec.before.startIndex;
    if (ranges.some(([a, b]) => at >= a && at < b)) {
      guardedSites += 1;
      fileGuarded += 1;
    }
    if (guiProcRanges.some(([a, b]) => at >= a && at < b)) sitesInGuiProcedures += 1;
  }
  if (fileGuarded > 0)
    worstFiles.push({ file: f.path, guarded: fileGuarded, total: f.specs.length });
}

const pct = (n: number) => (totalSites === 0 ? "0.0%" : `${((n / totalSites) * 100).toFixed(1)}%`);
console.log(`project:                  ${projectDir}`);
console.log(`.al files:                ${totalFiles} (${files.length} carrying mutation sites)`);
console.log(`files using GUI calls:    ${filesWithGui}`);
console.log(`mutation sites:           ${totalSites}`);
console.log("");
console.log(`LOWER BOUND — sites lexically inside a GuiAllowed/Confirm-guarded branch:`);
console.log(`  ${guardedSites}  (${pct(guardedSites)})`);
console.log(`UPPER-ISH BOUND — sites in any procedure that mentions an interactive construct:`);
console.log(`  ${sitesInGuiProcedures}  (${pct(sitesInGuiProcedures)})`);
console.log("");
worstFiles.sort((a, b) => b.guarded - a.guarded);
console.log("most-affected files (guarded / total sites):");
for (const w of worstFiles.slice(0, 10)) {
  console.log(`  ${String(w.guarded).padStart(4)}/${String(w.total).padEnd(5)} ${w.file}`);
}
