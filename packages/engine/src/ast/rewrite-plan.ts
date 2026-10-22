import { FileRefusedError } from "../file-refused";
import type { ALSyntaxNode } from "./syntax-node";

/**
 * R-307 O4: one planned rewrite, by span. `payload` is what replaces `[start, end)`; `kind` is the
 * replaced node's raw kind, for the overlap refusal's message.
 */
export interface SpanEdit<T> {
  readonly start: number;
  readonly end: number;
  readonly kind: string;
  readonly payload: T;
}

/**
 * The PLAN half of `printWithRewrites`: every edit checked to sit inside `root` (E4, a plain
 * `Error`: a caller bug), sorted by start (stable, so map insertion order decides a tie, which is
 * what lets a zero-width latch at `begin` sit before a chain rooted there), then refused by file
 * when two overlap (`rewrite.overlap`). No text is read or joined. An empty map returns before
 * E4, so it never reads `root`.
 */
export function planEdits<T>(
  source: string,
  root: ALSyntaxNode,
  rewrites: ReadonlyMap<ALSyntaxNode, T>,
  where?: string,
): SpanEdit<T>[] {
  if (rewrites.size === 0) return [];

  const edits: SpanEdit<T>[] = [];
  for (const [node, payload] of rewrites) {
    assertNodeInTree(node, root);
    edits.push({ start: node.startIndex, end: node.endIndex, kind: node.rawKind, payload });
  }

  edits.sort((a, b) => a.start - b.start);
  assertNoOverlap(edits, where, source);
  return edits;
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
          site: "rewrite.overlap",
          // `end` is exclusive: the last line is the one holding the last covered character.
          lines: [lineAt(prev.start), lineAt(Math.max(prev.end, curr.end, prev.start + 1) - 1)],
        },
      );
    }
  }
}
