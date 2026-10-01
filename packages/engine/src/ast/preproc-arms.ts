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
