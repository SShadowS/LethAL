import type { ALSyntaxNode } from "./syntax-node";

/**
 * R214: which bytes of one file a build compiles out, given that build's preprocessor symbols.
 *
 * alc's rules, measured with alc 18.0.41 (docs/superpowers/plans/2026-09-29-R-214-symbol-aware-
 * site-enumeration.md, "alc's precedence, measured"): `not` binds to the next operand, then `and`,
 * then `or`; parentheses group; `true` and `false` are literals; keywords are case-insensitive and
 * symbols are not; an undefined symbol is false; `#define` / `#undef` count where they sit in an
 * active region. A condition is read from the marker's TEXT: tree-sitter-al 4.4.1 scopes `not` over a
 * following `and` / `or`, and trusting its expression nodes would pick the wrong arm with no error.
 *
 * The walk is over every directive marker in document order, never per container:
 * `preproc_split_if_then_begin_else_shared` holds an `#if` whose `#endif` is outside it, and
 * `preproc_fragmented_else_tail` the reverse.
 *
 * Anything it cannot evaluate exactly as alc does is `undecided` with a reason code (never source
 * text), and the caller then generates no mutant in the file.
 */
export type ArmEvaluation =
  | { readonly kind: "decided"; readonly inactive: readonly (readonly [number, number])[] }
  | { readonly kind: "undecided"; readonly reason: string };

const DIRECTIVE_KINDS: ReadonlySet<string> = new Set([
  "preproc_if",
  "preproc_elif",
  "preproc_else",
  "preproc_endif",
  "preproc_define",
  "preproc_undef",
]);
/** A directive line as alc reads one: first on its line, a BOM allowed before the first. */
const DIRECTIVE_LINE = /^\uFEFF?[ \t]*#[ \t]*(?:if|elif|else|endif|define|undef)\b/gim;
const CONDITION_HEAD = /^#[ \t]*(?:if|elif)\b/i;
const SYMBOL_DIRECTIVE = /^#[ \t]*(define|undef)[ \t]+([A-Za-z_][A-Za-z0-9_]*)[ \t]*(\/\/.*)?$/i;
const TOKEN = /[A-Za-z_][A-Za-z0-9_]*|\(|\)|\S/g;
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const OPERATOR_WORDS: ReadonlySet<string> = new Set(["and", "or", "not"]);

/** Internal: never leaves `evaluateArms`. */
class UndecidedArm extends Error {}

function lineOf(n: ALSyntaxNode): number {
  return n.startPosition.row + 1;
}

/** alc's grammar over one condition's text. Throws `UndecidedArm` on anything else. */
function holds(text: string, defined: ReadonlySet<string>, line: number): boolean {
  const toks = text.match(TOKEN) ?? [];
  let i = 0;
  const fail = (): never => {
    throw new UndecidedArm(`unparsed-condition at line ${line}`);
  };
  const isWord = (t: string | undefined, w: string): boolean => t?.toLowerCase() === w;
  const primary = (): boolean => {
    const t = toks[i++];
    if (t === "(") {
      const v = or();
      if (toks[i++] !== ")") fail();
      return v;
    }
    if (t === undefined || !IDENT.test(t) || OPERATOR_WORDS.has(t.toLowerCase())) return fail();
    if (isWord(t, "true")) return true;
    if (isWord(t, "false")) return false;
    return defined.has(t);
  };
  const unary = (): boolean => {
    if (isWord(toks[i], "not")) {
      i++;
      return !unary();
    }
    return primary();
  };
  const and = (): boolean => {
    let v = unary();
    while (isWord(toks[i], "and")) {
      i++;
      const r = unary();
      v = v && r;
    }
    return v;
  };
  const or = (): boolean => {
    let v = and();
    while (isWord(toks[i], "or")) {
      i++;
      const r = and();
      v = v || r;
    }
    return v;
  };
  const v = or();
  if (i !== toks.length) fail();
  return v;
}

function conditionText(marker: ALSyntaxNode): string {
  const text = marker.text.trim();
  const head = CONDITION_HEAD.exec(text);
  if (head === null) throw new UndecidedArm(`unparsed-condition at line ${lineOf(marker)}`);
  return text
    .slice(head[0].length)
    .replace(/\/\/.*$/s, "")
    .trim();
}

/** The grammar's `extras` that can sit between two statements (tree-sitter-al 4.4.1). */
export const TRIVIA_KINDS: ReadonlySet<string> = new Set([
  "comment",
  "multiline_comment",
  "pragma",
  "preproc_region",
  "preproc_endregion",
  "preproc_define",
  "preproc_undef",
]);
export const ARM_MARKERS: ReadonlySet<string> = new Set([
  "preproc_if",
  "preproc_elif",
  "preproc_else",
  "preproc_endif",
]);

/** A statement the parser placed in a statement list: a `*_statement`, or an expression statement.
 *  A preproc container (`preproc_conditional_statement`) is NOT one: plan r3 admits a `#if` that
 *  follows another, since its content cannot be judged without the earlier container's arms. */
function isStatementNode(n: ALSyntaxNode): boolean {
  if (n.rawKind.startsWith("preproc_")) return false;
  return n.rawKind.endsWith("_statement") || n.rawKind.endsWith("_expression");
}

/** The last (or first) leaf of `n`, skipping trivia subtrees. */
function edgeLeaf(n: ALSyntaxNode, last: boolean): ALSyntaxNode | null {
  if (TRIVIA_KINDS.has(n.rawKind)) return null;
  if (n.children.length === 0) return n;
  const kids = last ? [...n.children].reverse() : n.children;
  for (const c of kids) {
    const leaf = edgeLeaf(c, last);
    if (leaf !== null) return leaf;
  }
  return null;
}

/**
 * R402: a statement-level `#if` whose arm CONTINUES the statement before it. The grammar cannot
 * attach such a tail (`repeat ... until (A > 10)` `#if X or (B > 5) #endif ;`) to the statement, so
 * it parses the tail as a separate statement (`or(...)` becomes a call), and instrumenting it emits
 * an artifact alc refuses (measured: AL0111 / AL0104). Refused like any arm alc's reading of which
 * the tree cannot show. The rule (plan r3 §2(a)): skip trivia back to the previous sibling; admit
 * when it is not a statement, when its last leaf is `;`, or when every arm is empty or trivia-only
 * or starts with `;` (c2, c2b and c3 compile); otherwise refuse.
 *
 * Exported for test: no parse yields a statement that OWNS its `;` before a statement-level `#if`
 * (measured, plan r3 table C), so that admission is pinned on a hand-built tree.
 */
export function continuationRefusal(root: ALSyntaxNode): string | null {
  let found: string | null = null;
  const walk = (n: ALSyntaxNode): void => {
    if (found !== null) return;
    if (n.rawKind === "preproc_conditional_statement" && continuesPrevious(n)) {
      found = `directive-continues-statement at line ${lineOf(n)}`;
      return;
    }
    for (const c of n.children) walk(c);
  };
  walk(root);
  return found;
}

function continuesPrevious(container: ALSyntaxNode): boolean {
  const parent = container.parent;
  if (parent === null) return false;
  // Positions, not identity: wrapper nodes are rebuilt on access (R209).
  const at = parent.children.findIndex((c) => c.startIndex === container.startIndex);
  let prev: ALSyntaxNode | undefined;
  for (let i = at - 1; i >= 0; i--) {
    const c = parent.children[i];
    if (c !== undefined && !TRIVIA_KINDS.has(c.rawKind)) {
      prev = c;
      break;
    }
  }
  if (prev === undefined || !isStatementNode(prev)) return false;
  if (edgeLeaf(prev, true)?.rawKind === ";") return false;
  // Each arm's first content leaf: an arm with none (empty or trivia-only) continues nothing, and
  // an arm that opens with `;` supplies the separator itself.
  let armOpen = false;
  let armSeen = false;
  for (const c of container.children) {
    if (ARM_MARKERS.has(c.rawKind)) {
      armOpen = c.rawKind !== "preproc_endif";
      armSeen = false;
      continue;
    }
    if (!armOpen || armSeen) continue;
    const first = edgeLeaf(c, false);
    if (first === null) continue;
    armSeen = true;
    if (first.rawKind !== ";") return true;
  }
  return false;
}

function markersOf(root: ALSyntaxNode): ALSyntaxNode[] {
  const out: ALSyntaxNode[] = [];
  const walk = (n: ALSyntaxNode): void => {
    if (DIRECTIVE_KINDS.has(n.rawKind)) {
      out.push(n);
      return;
    }
    for (const c of n.children) walk(c);
  };
  walk(root);
  return out;
}

/** R403: whether `source` holds a directive line `evaluateArms` would read. A file without one is
 *  decided with no inactive range, so a caller can skip parsing it (R-371 pins one parse per test
 *  file in `lethal verify`). The same scan `evaluateArms` starts with. */
export function hasDirectiveLine(source: string): boolean {
  DIRECTIVE_LINE.lastIndex = 0;
  const found = DIRECTIVE_LINE.test(source);
  DIRECTIVE_LINE.lastIndex = 0;
  return found;
}

export function evaluateArms(
  root: ALSyntaxNode,
  source: string,
  symbols: readonly string[],
): ArmEvaluation {
  // R214 I7: a file with no directive line costs one scan and no walk (93% of corpus files, measured).
  const matches = [...source.matchAll(DIRECTIVE_LINE)];
  const lines = matches.length;
  if (lines === 0) return { kind: "decided", inactive: [] };
  const defined = new Set(symbols);
  /** One open `#if`: whether its outer region is built, whether an arm was taken, whether the
   *  current arm is built, whether its `#else` was seen (row 30), and its line for a refusal. */
  const frames: {
    outer: boolean;
    taken: boolean;
    active: boolean;
    closed: boolean;
    line: number;
  }[] = [];
  const inactive: [number, number][] = [];
  const active = (): boolean => frames.at(-1)?.active ?? true;
  let closedAt: number | null = null;
  try {
    const markers = markersOf(root);
    // Positions, not counts: a marker the line scan misses (mid-line `#if`) and a directive line the
    // tree does not mark (inside a comment) cancel out in a count. 1-based line of each match.
    const directiveRows = new Set<number>();
    let row = 1;
    let scanned = 0;
    for (const m of matches) {
      for (; scanned < m.index; scanned++) if (source.charCodeAt(scanned) === 10) row++;
      directiveRows.add(row);
    }
    const markerRows = new Set(markers.map(lineOf));
    if (
      markers.length !== lines ||
      markerRows.size !== directiveRows.size ||
      [...markerRows].some((r) => !directiveRows.has(r))
    ) {
      throw new UndecidedArm(
        `marker-mismatch (${lines} directive lines, ${markers.length} markers)`,
      );
    }
    const continuation = continuationRefusal(root);
    if (continuation !== null) throw new UndecidedArm(continuation);
    for (const d of markers) {
      const before = active();
      if (d.rawKind === "preproc_define" || d.rawKind === "preproc_undef") {
        if (!before) continue;
        const m = SYMBOL_DIRECTIVE.exec(d.text.trim());
        if (m === null) throw new UndecidedArm(`bad-define at line ${lineOf(d)}`);
        const [, verb = "", name = ""] = m;
        if (verb.toLowerCase() === "define") defined.add(name);
        else defined.delete(name);
        continue;
      }
      if (d.rawKind === "preproc_if") {
        const v = before && holds(conditionText(d), defined, lineOf(d));
        frames.push({ outer: before, taken: v, active: v, closed: false, line: lineOf(d) });
      } else {
        const f = frames.at(-1);
        if (f === undefined) throw new UndecidedArm(`unbalanced at line ${lineOf(d)}`);
        if (d.rawKind === "preproc_endif") {
          frames.pop();
        } else {
          // Defensive: no input reaches this (the marker check refuses an elif after else first).
          if (f.closed) throw new UndecidedArm(`unbalanced at line ${lineOf(d)}`);
          if (d.rawKind === "preproc_elif") {
            const v = f.outer && !f.taken && holds(conditionText(d), defined, lineOf(d));
            f.active = v;
            f.taken = f.taken || v;
          } else {
            f.active = f.outer && !f.taken;
            f.taken = true;
            f.closed = true;
          }
        }
      }
      const after = active();
      if (before && !after) closedAt = d.endIndex;
      else if (!before && after && closedAt !== null) {
        inactive.push([closedAt, d.startIndex]);
        closedAt = null;
      }
    }
    const open = frames.at(-1);
    if (open !== undefined) throw new UndecidedArm(`unbalanced at line ${open.line}`);
  } catch (err) {
    if (err instanceof UndecidedArm) return { kind: "undecided", reason: err.message };
    throw err;
  }
  return { kind: "decided", inactive };
}

/** Whether `offset` lies inside one of `evaluateArms`'s inactive ranges. ponytail: linear over a
 *  file's ranges (a few dozen at most in BaseApp); a binary search if a file ever holds thousands. */
export function startsInInactiveArm(
  inactive: readonly (readonly [number, number])[],
  offset: number,
): boolean {
  return inactive.some(([from, to]) => from <= offset && offset < to);
}
