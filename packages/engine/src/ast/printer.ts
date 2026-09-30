import { FileRefusedError } from "../file-refused";
import type { ALSyntaxNode } from "./syntax-node";

export function print(source: string, _root: ALSyntaxNode): string {
  // unmodified round-trip is just the original source
  return source;
}

export function printWithRewrites(
  source: string,
  root: ALSyntaxNode,
  rewrites: ReadonlyMap<ALSyntaxNode, string>,
  where?: string,
): string {
  if (rewrites.size === 0) return source;

  const edits: Array<{ start: number; end: number; replacement: string; kind: string }> = [];
  for (const [node, replacement] of rewrites) {
    assertNodeInTree(node, root);
    edits.push({
      start: node.startIndex,
      end: node.endIndex,
      replacement,
      kind: node.rawKind,
    });
  }

  edits.sort((a, b) => a.start - b.start);
  assertNoOverlap(edits, where, source);

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
  edits: ReadonlyArray<{ start: number; end: number; kind: string }>,
  where: string | undefined,
  source: string,
): void {
  for (let i = 1; i < edits.length; i++) {
    const prev = edits[i - 1];
    const curr = edits[i];
    if (prev === undefined || curr === undefined) continue;
    if (curr.start < prev.end) {
      const location = where !== undefined ? ` in ${where}` : "";
      // R307: the edits come from this one file's source, so the file is refused, not the run.
      const lineAt = (at: number): number => source.slice(0, at).split("\n").length;
      throw new FileRefusedError(
        `overlapping rewrites${location} at ${prev.start}..${prev.end} (${prev.kind}) and ${curr.start}..${curr.end} (${curr.kind})`,
        {
          file: where ?? "<file>",
          shape: "overlap",
          lines: [lineAt(prev.start), lineAt(Math.max(prev.end, curr.end))],
        },
      );
    }
  }
}
