import type { ALSyntaxNode } from "./syntax-node";

export function print(source: string, _root: ALSyntaxNode): string {
  // unmodified round-trip is just the original source
  return source;
}

export function printWithRewrites(
  source: string,
  root: ALSyntaxNode,
  rewrites: ReadonlyMap<ALSyntaxNode, string>,
): string {
  if (rewrites.size === 0) return source;

  const edits: Array<{ start: number; end: number; replacement: string }> = [];
  for (const [node, replacement] of rewrites) {
    assertNodeInTree(node, root);
    edits.push({
      start: node.startIndex,
      end: node.endIndex,
      replacement,
    });
  }

  edits.sort((a, b) => a.start - b.start);
  assertNoOverlap(edits);

  const parts: string[] = [];
  let cursor = 0;
  for (const edit of edits) {
    parts.push(source.slice(cursor, edit.start));
    parts.push(edit.replacement);
    cursor = edit.end;
  }
  parts.push(source.slice(cursor));
  return parts.join("");
}

function assertNodeInTree(node: ALSyntaxNode, root: ALSyntaxNode): void {
  if (node.startIndex < root.startIndex || node.endIndex > root.endIndex) {
    throw new Error(
      `rewrite target at ${node.startIndex}..${node.endIndex} is outside root ${root.startIndex}..${root.endIndex}`,
    );
  }
}

function assertNoOverlap(
  edits: ReadonlyArray<{ start: number; end: number }>,
): void {
  for (let i = 1; i < edits.length; i++) {
    const prev = edits[i - 1];
    const curr = edits[i];
    if (prev === undefined || curr === undefined) continue;
    if (curr.start < prev.end) {
      throw new Error(
        `overlapping rewrites at ${prev.start}..${prev.end} and ${curr.start}..${curr.end}`,
      );
    }
  }
}
