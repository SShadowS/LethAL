// For each callee-mover/inserter LOOP row (summary files), count by parse the exits in the loop BODY:
// exit, break, Skip/Break/Quit calls, Error calls. Counts only.
// usage: bun exitscan702.ts <tree> <summary.txt>...
import { join } from "node:path";

const [root, ...sums] = process.argv.slice(2);
if (root === undefined || sums.length === 0) throw new Error("usage");
const eng = await import(join(root, "packages/engine/src/index.ts"));
await eng.initParser();
// biome-ignore lint/suspicious/noExplicitAny: scratch script
type N = any;
const visit = (n: N, f: (n: N) => void): void => {
  f(n);
  for (const c of n.namedChildren) visit(c, f);
};
const cache = new Map<string, N>();
for (const s of sums) {
  for (const l of (await Bun.file(s).text()).split("\n")) {
    if (!l.startsWith("LOOP\t")) continue;
    const c = l.split("\t");
    const [, cls, set, proj, file, obj, proc, line] = c;
    const p = join("/work/src", proj as string, file as string);
    let tree = cache.get(p);
    if (tree === undefined) {
      tree = eng.wrapRoot(eng.parseAL(await Bun.file(p).text()));
      cache.set(p, tree);
    }
    let loop: N = null;
    visit(tree, (n) => {
      if (loop === null && (n.rawKind === "while_statement" || n.rawKind === "repeat_statement") && (n.startPosition?.row ?? -2) + 1 === Number(line)) loop = n;
    });
    const k = { exit: 0, brk: 0, skip: 0, err: 0, cont: 0 };
    if (loop !== null) {
      const body = loop.childForFieldName("body") ?? loop;
      visit(body, (n) => {
        if (n.rawKind === "exit_statement") k.exit++;
        else if (n.rawKind === "break_statement") k.brk++;
        else if (n.rawKind === "continue_statement") k.cont++;
        else if (n.rawKind === "call_expression" || n.rawKind === "call_statement") {
          const t = n.text.toLowerCase();
          if (/^(currreport\.)?(skip|break|quit)\s*\(/.test(t)) k.skip++;
          else if (/^error\s*\(/.test(t)) k.err++;
        }
      });
    }
    console.log([cls, set, proj, obj, proc, line, loop === null ? "LOOP-NOT-FOUND" : JSON.stringify(k)].join("\t"));
  }
}
