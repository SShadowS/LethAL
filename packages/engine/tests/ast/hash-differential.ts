// TEST-SIDE, never imported by product code (RUST-03 S4.2d, AMENDMENT 8 Guard 2). The corpus
// differential: the verbatim reference implementation against the product's `astSubtreeHash` on
// every node of every file, through the flat path (the native `FlatNode` itself), the generic path
// (`mirror`, a forwarding wrapper that is never a `FlatNode`) and a `withText` node carrying the
// node's own text (the generic path at the top, flat below). Anonymous nodes are hashed too, so
// the set covers every named node and more.
import { readFileSync } from "node:fs";
import { astSubtreeHash } from "../../src/ast/hash";
import { parseAL } from "../../src/ast/parser";
import { visit, withText, wrapRoot } from "../../src/ast/syntax-node";
import { mirror, referenceAstSubtreeHash } from "./hash-reference";

export interface DifferentialResult {
  files: number;
  /** Nodes compared (each through all three paths). */
  nodes: number;
  /** Of those, named nodes: the ones some parent lists in `namedChildren`, plus each root. */
  named: number;
  /** One line per difference: `<file> <start>-<end> <kind> <path>`. Empty means none. */
  differences: string[];
}

export function hashDifferential(files: readonly string[]): DifferentialResult {
  const out: DifferentialResult = { files: 0, nodes: 0, named: 0, differences: [] };
  for (const file of files) {
    const root = wrapRoot(parseAL(readFileSync(file, "utf8")));
    out.files++;
    const named = new Set<string>([key(root)]);
    visit(root, (n) => {
      for (const c of n.namedChildren) named.add(key(c));
      const want = referenceAstSubtreeHash(n);
      const paths: [string, string][] = [
        ["flat", astSubtreeHash(n)],
        ["generic", astSubtreeHash(mirror(n))],
        ["withText", astSubtreeHash(withText(n, n.text))],
      ];
      for (const [path, got] of paths)
        if (got !== want)
          out.differences.push(`${file} ${n.startIndex}-${n.endIndex} ${n.rawKind} ${path}`);
      out.nodes++;
      if (named.has(key(n))) out.named++;
    });
  }
  return out;
}

const key = (n: { startIndex: number; endIndex: number; rawKind: string }): string =>
  `${n.startIndex}:${n.endIndex}:${n.rawKind}`;
