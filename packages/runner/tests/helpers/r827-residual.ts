import { type ALSyntaxNode, initParser, parseAL, wrapRoot } from "@lethal/engine";

/**
 * R827 residualising check. For one instrumented file and one mutant M, FOLD the emitted text as if
 * only M were active, then compare it BY STRUCTURE with the original source with M's own edit
 * applied by hand.
 *
 * Everything works on the parse tree, never on text:
 *
 * FOLD (what is evaluated). An `if` whose condition is exactly `<Selector>.Active('Mnnnn')` is a
 * guard. With M active it reduces to its then-branch when the id is M, else to its else-branch,
 * and so on down the chain. With no mutant active every guard takes its else-branch.
 *
 * STRIPPED (the only things removed, all of them instrumentation with no meaning for the mutant):
 *  1. a reach marker, a statement matching `if not <latch> then begin <Sel>.Reached('Mnnnn');
 *     <latch> := true; end` (its id must be M, or the marker is reported as leaked);
 *  2. a variable declaration `LethALReachLatch[n]: Boolean;` whose name the original source never
 *     mentions;
 *  3. a variable declaration `MutationSelector[n]: Codeunit "Mutation Selector";` whose name the
 *     original never mentions;
 *  4. a `var` section left with no declaration after 2 and 3.
 * Anything of those names left over is reported, so a leak cannot hide.
 *
 * CANONICAL FORM (what the comparison ignores). Whitespace and comments (never tokens); the `;`
 * between statements and after case branches; empty statements (the emptied-slot filler); an
 * absent `else` equals an empty `else`; and `begin ... end`. A block is flattened into the
 * statement list around it, and a branch is always rendered as `{ its statements }`, so
 * `if C then S` equals `if C then begin S end`. That is safe only because binding is decided by
 * the PARSER, not by the canonical form: `if C then begin if D then X end else Y` parses to
 * `if C then {if D then {X}} else {Y}`, while the same text without the block parses to
 * `if C then {if D then {X} else {Y}}`. Each `if` holds its own branches, so those two differ.
 */

export interface MutantCase {
  readonly mutantId: string;
  readonly operator: string;
  /** `spec.before`'s span in the original source. */
  readonly start: number;
  readonly end: number;
  /** `spec.after`'s text. */
  readonly afterText: string;
  /** PLAN gives this mutant a reach marker (its grain is `statement`). */
  readonly marked: boolean;
}

export interface FileCase {
  readonly path: string;
  readonly source: string;
  readonly compiled: string;
  readonly mutants: readonly MutantCase[];
}

export type FindingKind =
  | "diff"
  | "guard-in-loop"
  | "plain-branch-guard"
  | "guard-count"
  | "marker"
  | "leftover"
  | "emitted-parse-error"
  | "expected-parse-error"
  | "original-parse-error"
  | "no-mutant-diff";

export interface Finding {
  readonly path: string;
  readonly mutantId: string;
  readonly operator: string;
  readonly kind: FindingKind;
  readonly detail: string;
}

export interface Stats {
  guards: number;
  markers: number;
  latchDecls: number;
  selectorDecls: number;
}

const newStats = (): Stats => ({ guards: 0, markers: 0, latchDecls: 0, selectorDecls: 0 });

const GUARD = /^MutationSelector\d*\.Active\('(M\d+)'\)$/i;
const EXECUTION_LOOPS = new Set([
  "for_statement",
  "foreach_statement",
  "while_statement",
  "repeat_statement",
]);
const MARKER =
  /^if not (LethALReachLatch\d*) then begin (MutationSelector\d*)\.Reached\('(M\d+)'\); \1 := true; end$/i;
const LATCH_DECL = /^(LethALReachLatch\d*): Boolean;$/i;
const SELECTOR_DECL = /^(MutationSelector\d*): Codeunit "Mutation Selector";$/i;
const LEFTOVER = /LethALReachLatch|MutationSelector|Mutation Selector|\.Active\(|\.Reached\(/i;
const LOOPS = new Set([
  "while_statement",
  "for_statement",
  "foreach_statement",
  "with_statement",
  "case_branch",
  "asserterror_statement",
]);
const FLATTEN = new Set(["code_block", "statement_block", "empty_statement"]);

const squash = (s: string): string => s.replace(/\s+/g, " ").trim();

class Canon {
  readonly stats = newStats();
  readonly leftovers: string[] = [];

  constructor(
    private readonly original: string,
    /** false: plain source, nothing is folded or stripped. */
    private readonly instrumented: boolean,
    private readonly active: string | null,
  ) {}

  private mentioned(name: string): boolean {
    return new RegExp(`\\b${name}\\b`, "i").test(this.original);
  }

  /** The statements a node contributes to the list around it. */
  private stmts(n: ALSyntaxNode): string[] {
    const k = n.rawKind;
    if (k.includes("comment") || k === ";" || k === "empty_statement") return [];
    if (k === "code_block" || k === "statement_block") {
      return n.children
        .filter((c) => !c.rawKind.endsWith("_keyword"))
        .flatMap((c) => this.stmts(c));
    }
    const c = this.canon(n);
    return c === null ? [] : [c];
  }

  /** A guard folds to its chosen branch's statements; a reach marker is stripped. */
  private instrumentation(n: ALSyntaxNode): string | null | undefined {
    const cond = n.childForFieldName("condition");
    const guard = cond === null ? null : GUARD.exec(squash(cond.text));
    if (guard !== null) {
      const id = guard[1];
      const then = n.childForFieldName("then_branch");
      const els = n.childForFieldName("else_branch");
      // A guard without both branches is reported; it still folds, so the other findings stay true.
      if (then === null || els === null)
        this.leftovers.push(`guard ${id} has no ${then === null ? "then" : "else"} branch`);
      this.stats.guards++;
      const pick = id === this.active ? then : els;
      const folded = (pick === null ? [] : this.stmts(pick)).join(" ");
      return folded === "" ? null : folded;
    }
    const marker = MARKER.exec(squash(n.text));
    if (marker === null) return undefined;
    const [, latch, , id] = marker;
    if (latch === undefined || this.mentioned(latch)) {
      this.leftovers.push(`marker with latch ${latch} that the original mentions`);
    } else if (id !== this.active) {
      this.leftovers.push(`marker ${id} outside its own branch (active ${this.active})`);
    } else this.stats.markers++;
    return null;
  }

  /** null: the node is stripped. */
  canon(n: ALSyntaxNode): string | null {
    const k = n.rawKind;
    if (k.includes("comment")) return null;
    if (k === "if_statement" && this.instrumented) {
      const r = this.instrumentation(n);
      if (r !== undefined) return r;
    }
    if (n.children.length === 0) return n.text;
    if (FLATTEN.has(k)) return `{${this.stmts(n).join(" ")}}`;
    // A bare `var` with no declaration declares nothing. The instrumented side drops the section
    // once the latch is stripped from it, so the plain side must drop it too.
    if (
      !this.instrumented &&
      k === "var_section" &&
      !n.children.some((c) => c.rawKind === "var_body")
    )
      return null;
    if (k === "variable_declaration" && this.instrumented) {
      const t = squash(n.text);
      const latch = LATCH_DECL.exec(t);
      if (latch?.[1] !== undefined && !this.mentioned(latch[1])) {
        this.stats.latchDecls++;
        return null;
      }
      const sel = SELECTOR_DECL.exec(t);
      if (sel?.[1] !== undefined && !this.mentioned(sel[1])) {
        this.stats.selectorDecls++;
        return null;
      }
    }
    const parts: string[] = [];
    let elseEmpty = false;
    if (k === "if_statement") {
      const els = n.childForFieldName("else_branch");
      // A throwaway walk, so this test counts nothing: `child` walks a non-empty `else` once more.
      const probe = new Canon(this.original, this.instrumented, this.active);
      elseEmpty = els === null || probe.stmts(els).length === 0;
      if (elseEmpty && els !== null) this.stmts(els);
    }
    const strippedBefore = this.stats.latchDecls + this.stats.selectorDecls;
    for (const c of n.children) {
      const cs = this.child(c, n, elseEmpty);
      if (cs === null) {
        // A `var` section whose body lost every declaration goes with them.
        if (k === "var_section" && c.rawKind === "var_body") return null;
      } else parts.push(cs);
    }
    if (
      k === "var_body" &&
      this.stats.latchDecls + this.stats.selectorDecls > strippedBefore &&
      parts.length === 0
    )
      return null;
    return `(${k} ${parts.join(" ")})`;
  }

  private child(c: ALSyntaxNode, parent: ALSyntaxNode, elseEmpty: boolean): string | null {
    const k = c.rawKind;
    if (k.includes("comment")) return null;
    if (k === ";" && FLATTEN_PARENT.has(parent.rawKind)) return null;
    // A block alone in a `#if` arm that holds nothing is the arm empty: `begin end` and a deleted
    // statement mean the same there.
    if (parent.rawKind === "preproc_conditional_statement" && FLATTEN.has(k)) {
      const inner = this.stmts(c);
      return inner.length === 0 ? null : `{${inner.join(" ")}}`;
    }
    if (parent.rawKind === "if_statement") {
      if (c.fieldName === "else_branch" || c.rawKind === "else_keyword") {
        if (elseEmpty) return null;
      }
      if (c.fieldName === "then_branch" || c.fieldName === "else_branch")
        return `{${this.stmts(c).join(" ")}}`;
    } else if (LOOPS.has(parent.rawKind) && c.fieldName === "body") {
      return `{${this.stmts(c).join(" ")}}`;
    }
    return this.canon(c);
  }
}

const FLATTEN_PARENT = new Set([
  "statement_block",
  "code_block",
  "case_branch",
  "preproc_conditional_statement",
]);

/** Parse once per distinct text. */
const parses = new Map<string, { root: ALSyntaxNode }>();
function parse(text: string): ALSyntaxNode {
  let p = parses.get(text);
  if (p === undefined) {
    p = { root: wrapRoot(parseAL(text)) };
    if (parses.size > 2000) parses.clear();
    parses.set(text, p);
  }
  return p.root;
}

/** The folded canonical form of `compiled` with only `active` on (null: no mutant). */
export function foldCanon(
  original: string,
  compiled: string,
  active: string | null,
): { canon: string; stats: Stats; leftovers: string[] } {
  const c = new Canon(original, true, active);
  const canon = c.canon(parse(compiled)) ?? "";
  const leftovers = [...c.leftovers];
  if (LEFTOVER.test(canon) && !LEFTOVER.test(original))
    leftovers.push("instrumentation name left in the folded tree");
  return { canon, stats: c.stats, leftovers };
}

export function hasParseError(text: string): boolean {
  return parse(text).hasError;
}

export function plainCanon(text: string): string {
  return new Canon(text, false, null).canon(parse(text)) ?? "";
}

/** The mutant written by hand: M's `before` span replaced by `after`'s text. */
export function expectedText(source: string, m: MutantCase): string {
  const at = (s: string): string => source.slice(0, m.start) + s + source.slice(m.end);
  const plain = at(m.afterText);
  if (m.afterText.trim() !== "") return plain;
  // A deleted statement is an empty block: bare deletion before an `else` is not legal AL, and the
  // parser recovers from it WITHOUT an error node (`if C then else X` reads `else` as a call).
  const filled = at("begin end");
  return parse(filled).hasError ? plain : filled;
}

function firstDiff(a: string, b: string): string {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const cut = (s: string): string => s.slice(Math.max(0, i - 60), i + 100);
  return `at ${i}: folded ...${cut(a)}... expected ...${cut(b)}...`;
}

export interface FileResult {
  readonly checked: number;
  readonly findings: readonly Finding[];
  readonly stats: Stats;
  /** Loops the `guard-in-loop` check saw under a guard's `else`, so a blind check shows as 0. */
  readonly walked: number;
}

/** Every mutant of one file, plus the no-mutant fold. Reports every finding. */
export async function checkFile(fc: FileCase, withDetail = true): Promise<FileResult> {
  await initParser();
  const findings: Finding[] = [];
  const stats = newStats();
  const add = (m: MutantCase, kind: FindingKind, detail: string): void => {
    findings.push({
      path: fc.path,
      mutantId: m.mutantId,
      operator: m.operator,
      kind,
      detail: withDetail ? detail : "",
    });
  };
  const none: MutantCase = {
    mutantId: "(none)",
    operator: "(none)",
    start: 0,
    end: 0,
    afterText: "",
    marked: false,
  };
  if (parse(fc.source).hasError) {
    add(none, "original-parse-error", "the original source has a parse error");
    return { checked: 0, findings, stats, walked: 0 };
  }
  if (parse(fc.compiled).hasError) {
    add(none, "emitted-parse-error", "the emitted text has a parse error");
    return { checked: 0, findings, stats, walked: 0 };
  }
  // R827: the fold compares meaning, so it cannot see WHEN a guard runs. This reads that from the
  // emitted tree: a guard holds the code in its `else`, and no guard may sit inside a loop there,
  // where it would run on every pass (R246).
  let walked = 0;
  const isGuard = (n: ALSyntaxNode): boolean => {
    const c = n.rawKind === "if_statement" ? n.childForFieldName("condition") : null;
    return c !== null && c !== undefined && GUARD.test(squash(c.text));
  };
  const guardIds = new Map<string, number>();
  const idOf = (n: ALSyntaxNode): string | undefined => {
    const c = n.rawKind === "if_statement" ? n.childForFieldName("condition") : null;
    return c === null || c === undefined ? undefined : GUARD.exec(squash(c.text))?.[1];
  };
  // R828: a plain branch (a guard's `then`: the free marker block, or a plain copy of the root with
  // one edit) holds no guard of any mutant.
  const walkPlain = (n: ALSyntaxNode): void => {
    if (isGuard(n)) {
      add(none, "plain-branch-guard", n.text.slice(0, 60));
      return;
    }
    for (const c of n.children) walkPlain(c);
  };
  // Every guard is walked. Inside a guard's `else` (a free body's, or an `if`'s original branch, or
  // the next link of a chain) no guard may sit inside a loop: it would run on every pass (R246).
  // A guard outside any `else` may sit in a loop: that is a root nothing hosts, as before. R-836:
  // `walked` counts the outermost loops seen under an `else`, so a check that walked no loop shows as 0.
  const walk = (n: ALSyntaxNode, underElse: boolean, inLoop: boolean): void => {
    const id = idOf(n);
    if (id !== undefined) {
      if (underElse && inLoop) {
        add(none, "guard-in-loop", n.text.slice(0, 60));
        return;
      }
      const then = n.childForFieldName("then_branch");
      const els = n.childForFieldName("else_branch");
      if (then !== null) walkPlain(then);
      if (els !== null) walk(els, true, false);
      return;
    }
    const loop = inLoop || EXECUTION_LOOPS.has(n.rawKind);
    if (underElse && loop && !inLoop) walked++;
    for (const c of n.children) walk(c, underElse, loop);
  };
  const count = (n: ALSyntaxNode): void => {
    const id = idOf(n);
    if (id !== undefined) guardIds.set(id, (guardIds.get(id) ?? 0) + 1);
    for (const c of n.children) count(c);
  };
  const emitted = parse(fc.compiled);
  walk(emitted, false, false);
  count(emitted);
  const originalCanon = plainCanon(fc.source);
  const base = foldCanon(fc.source, fc.compiled, null);
  for (const l of base.leftovers) add(none, "leftover", l);
  if (base.canon !== originalCanon)
    add(none, "no-mutant-diff", firstDiff(base.canon, originalCanon));
  for (const m of fc.mutants) {
    // Each mutant has exactly one guard in the emitted file.
    const guards = guardIds.get(m.mutantId) ?? 0;
    if (guards !== 1) add(m, "guard-count", `${guards} guards`);
    const exp = expectedText(fc.source, m);
    if (parse(exp).hasError) {
      add(m, "expected-parse-error", "the hand-written mutant does not parse");
      continue;
    }
    const folded = foldCanon(fc.source, fc.compiled, m.mutantId);
    stats.guards += folded.stats.guards;
    stats.markers += folded.stats.markers;
    for (const l of folded.leftovers) add(m, "leftover", l);
    // A marker lost or gained moves `reach`, and with it the mutant's reported state.
    if (folded.stats.markers !== (m.marked ? 1 : 0)) {
      add(m, "marker", `${folded.stats.markers} markers, marked ${m.marked}`);
    }
    const want = plainCanon(exp);
    if (folded.canon !== want) add(m, "diff", firstDiff(folded.canon, want));
  }
  return { checked: fc.mutants.length, findings, stats, walked };
}
