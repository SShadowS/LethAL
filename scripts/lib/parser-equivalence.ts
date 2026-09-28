/**
 * RUST-01 Q1 (ruling C1): walk the WASM and native trees together through ALSyntaxNode, the view
 * every operator and astSubtreeHash read. At every node: kind, offsets, points, field name,
 * isMissing, hasError; the count, order and boundaries of children; each child's parent is the
 * node walked from; namedChildren with their field names; childForFieldName for every engine
 * query and every field present. Field lookups are always on.
 */
import type { Language } from "web-tree-sitter";
import type { ALSyntaxNode, FlatTree } from "../../packages/engine/src/ast/syntax-node";

/** Every field name product code passes to childForFieldName (grep 2026-09-27, refreshed
 *  2026-09-28: adds else_value and then_value). */
export const ENGINE_FIELD_QUERIES: readonly string[] = [
  "arguments",
  "base_object",
  "condition",
  "else_branch",
  "else_value",
  "enum_type",
  "function",
  "left",
  "member",
  "name",
  "object",
  "object_id",
  "object_name",
  "operand",
  "operator",
  "reference",
  "return_type",
  "return_value",
  "right",
  "then_branch",
  "then_value",
  "type",
  "value",
  "value_name",
];

export interface NodeDiff {
  readonly path: string;
  readonly what: string;
  readonly wasm: string;
  readonly native: string;
}

function row(n: ALSyntaxNode): Record<string, string> {
  return {
    kind: n.rawKind,
    start: String(n.startIndex),
    end: String(n.endIndex),
    startPoint: `${n.startPosition.row}:${n.startPosition.column}`,
    endPoint: `${n.endPosition.row}:${n.endPosition.column}`,
    field: n.fieldName ?? "",
    missing: String(n.isMissing),
    hasError: String(n.hasError),
    text: n.text,
  };
}

const span = (n: ALSyntaxNode | null | undefined): string =>
  n === null || n === undefined
    ? "null"
    : `${n.rawKind}@${n.startIndex}-${n.endIndex}:${n.fieldName ?? ""}`;

export function compareStructure(
  wasmRoot: ALSyntaxNode,
  nativeRoot: ALSyntaxNode,
  limit: number,
): { nodes: number; diffs: NodeDiff[] } {
  const diffs: NodeDiff[] = [];
  const add = (path: string, what: string, wasm: string, native: string): void => {
    if (diffs.length < limit) diffs.push({ path, what, wasm, native });
  };
  let nodes = 0;
  const walk = (w: ALSyntaxNode, n: ALSyntaxNode, path: string): void => {
    nodes++;
    const rw = row(w);
    const rn = row(n);
    for (const k of Object.keys(rw)) if (rw[k] !== rn[k]) add(path, k, rw[k] ?? "", rn[k] ?? "");

    const wn = w.namedChildren;
    const nn = n.namedChildren;
    const wNamed = wn.map(span).join(",");
    const nNamed = nn.map(span).join(",");
    if (wNamed !== nNamed) add(path, "namedChildren", wNamed, nNamed);

    const wk = w.children;
    const nk = n.children;
    if (wk.length !== nk.length) add(path, "childCount", String(wk.length), String(nk.length));

    const names = new Set(ENGINE_FIELD_QUERIES);
    for (const c of wk) if (c.fieldName !== null) names.add(c.fieldName);
    for (const c of nk) if (c.fieldName !== null) names.add(c.fieldName);
    for (const name of names) {
      const a = span(w.childForFieldName(name));
      const b = span(n.childForFieldName(name));
      if (a !== b) add(path, `childForFieldName(${name})`, a, b);
    }

    const count = Math.min(wk.length, nk.length);
    for (let c = 0; c < count; c++) {
      const wc = wk[c];
      const nc = nk[c];
      if (wc === undefined || nc === undefined) continue;
      if (wc.parent !== w) add(`${path}/${c}`, "wasm parent", "self", span(wc.parent));
      if (nc.parent !== n) add(`${path}/${c}`, "native parent", "self", span(nc.parent));
      walk(wc, nc, `${path}/${c}`);
    }
  };
  walk(wasmRoot, nativeRoot, "");
  return { nodes, diffs };
}

/**
 * Raw link check (r2 ruling I3): traverse the flat links from the root, marking every index. An
 * out-of-range link, a duplicate visit (two parents, or a cycle) or a child count that disagrees
 * with the links fails; every index must be reached exactly once.
 */
export function flatLinksConsistent(f: FlatTree): boolean {
  const n = f.kind.length;
  if (n === 0) return false;
  const seen = new Uint8Array(n);
  seen[0] = 1;
  let reached = 1;
  const stack: number[] = [0];
  for (let i = stack.pop(); i !== undefined; i = stack.pop()) {
    const count = f.childCount[i] ?? 0;
    let k = 0;
    let c = count > 0 ? i + 1 : -1;
    while (c !== -1) {
      if (c < 0 || c >= n || seen[c] === 1) return false;
      seen[c] = 1;
      reached++;
      k++;
      stack.push(c);
      c = f.nextSibling[c] ?? -2;
    }
    if (k !== count) return false;
  }
  return reached === n;
}

/** Same bytes as lib.rs kind_table_sha256: symbol names in id order, a marker, field names 1..n. */
export function wasmKindTableSha256(lang: Language): string {
  const h = new Bun.CryptoHasher("sha256");
  for (let id = 0; id < lang.nodeTypeCount; id++) h.update(`${lang.nodeTypeForId(id) ?? ""}\n`);
  h.update("--fields--\n");
  for (let id = 1; id <= lang.fieldCount; id++) h.update(`${lang.fieldNameForId(id) ?? ""}\n`);
  return h.digest("hex");
}
