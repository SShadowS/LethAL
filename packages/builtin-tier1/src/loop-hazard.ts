import {
  ALNodeKind,
  type ALSyntaxNode,
  type HangCapableReason,
  type SemanticContext,
  armOfNode,
  declarationMembers,
  isObjectContainer,
  isProcedureLike,
  normalizeAlName,
  objectDeclarationsOf,
  procedureLikeArmNames,
  resolveVarRef,
} from "@lethal/engine";

/**
 * WHY THIS EXISTS (R196). Four operators can turn a terminating loop into a non-terminating one by
 * mutating a variable the loop's condition reads. Measured on the Document Output Templates slice:
 * eight of 741 mutants never terminate, costing about 40 of the run's 148 minutes in strands,
 * quarantines and resumes. Those four operators now REFUSE every site this names (owner ruling
 * 2026-10-05) rather than tagging it; the `hangCapable` channel stays for plug-in operators.
 *
 * WHAT A CLAIM MEANS, EXACTLY. That the assignment's target is a CONDITION-RELEVANT VARIABLE of an
 * enclosing loop. It does NOT establish that the mutation prevents progress, that the assignment
 * runs on the path that timed out, that nothing else advances the condition, or that an `exit`, an
 * error or an overflow cannot end the loop anyway. R179's `DrainQueue` is this repository's
 * counterexample: its frozen loop terminated by Int32 overflow in ~4.4 s rather than hanging.
 *
 * R446 and R480: the guards of a `while`/`repeat` loop's body exits (`exit`, `Error`,
 * `CurrReport.Quit`/`Break`, a `break` of that loop) count as its condition (`loopExitParts`), so a
 * write ANY such guard reads is refused. R446 did this for a condition that reads no name and calls
 * nothing (`while true`, `until false`); R480 extends it to every other condition that does not
 * name a cursor method (`namesCursorMethod`). For a name- and call-free condition only, a write that
 * FEEDS a guard's name is refused too, by name and to a fixpoint (`indirectFeeds`: `I += 1; Done :=
 * I >= 3; if Done then exit`). And a write to an enclosing `for`'s control variable is refused
 * (R480 shape 4n, in `classifyHangCapable`); a `for` gets no body guards. A scoped heuristic, not a
 * proof. Not extended; each a known exclusion, pinned as not refused in `loop-exit-refusal.test.ts`,
 * none shown safe: a condition naming a cursor method (`Next`, `Read`, `EOS`, `MoveNext`), which by
 * name also covers a user procedure or field named `Next` and a mixed condition (`(C.Next() <> 0)
 * or KeepGoing`); a write to a `for` loop's end bound; a `foreach` (its list); `asserterror` as the
 * only exit; `CurrReport.Skip`.
 *
 * R484: a report data item over the virtual `Integer` table is a loop too (BC calls its
 * `OnAfterGetRecord` once per record), unless a narrow certificate bounds it (`dataItemOpen`).
 * R487 (the blanket rule): inside an OPEN item, EVERY site the four operators mutate is refused,
 * whatever it writes or reads (`inOpenItemCode`): the item's triggers, its child items' triggers
 * and columns, a reportextension dataset block anchored on it, and every same-object procedure
 * that code reaches by name. Known exclusions, none shown safe: code that runs before the item
 * (`OnPreReport`, an earlier sibling), procedures in other objects, items over ordinary tables and
 * `Date`, XMLport `Integer` elements, reportextensions outside the project, a `while`/`repeat`
 * inside a bounded item's code (R196/R446/R480's loop rules only), and condition-side mutants.
 *
 * WHAT IT DELIBERATELY DOES NOT SEE, all UNCLASSIFIED rather than proven safe (spec 3.2): a target
 * read in the loop BODY rather than its condition (beyond R446's body-exit guards); preheader
 * assignments; progress that happens through a CALL (which is both hangs in `fixtures/sandbox-hang`); a field target outside any `with`
 * or implicit record (a resolved `R.Field` IS seen since R454; one written through an implicit
 * record or a `with` subject IS refused by name since R-458, see `byNameRefusal`); and
 * condition-side mutations, which are not assignments at all.
 *
 * POSITIONAL AND IDENTITY-BASED, never value-based. `empty-block.ts` records the principle this
 * follows: reading the tree is checkable, guessing what a loop does is not. Asking which
 * declaration a name refers to is identity, not value.
 *
 * The type itself now lives on `@lethal/engine` (`MutationSpec.hangCapable`), because the engine
 * cannot depend on this package. Re-exported here so existing importers of this file keep working.
 */
export type { HangCapableReason };

const LOOP_KINDS: ReadonlySet<string> = new Set([
  ALNodeKind.while_statement,
  ALNodeKind.repeat_statement,
]);

/**
 * `for_statement` is absent on purpose. Whether an AL `for` can be made non-terminating by mutating
 * its control variable depends on whether the platform re-evaluates the bound and re-reads the
 * variable each iteration, and this repository has NOT measured that. R480 refuses a write to the
 * control variable on relevance (Microsoft: the behaviour "isn't predictable") through a SEPARATE
 * check in `classifyHangCapable`, so `hasEnclosingLoop` and `loopConditionParts`, which other
 * operators' literal refusals read, do not change.
 */
const SCOPE_KINDS: ReadonlySet<string> = new Set([ALNodeKind.procedure, ALNodeKind.trigger]);
/** R302: a walk stops at a `SCOPE_KINDS` node or a split-header member (`isProcedureLike`). Nothing
 *  encloses a member, so no test can tell the split-member stop from its absence (red-checked:
 *  the hang tag inside a split member rests on `resolveVarRef`, i.e. `findEnclosingProcedure`). */
function isScope(n: ALSyntaxNode): boolean {
  return SCOPE_KINDS.has(n.kind) || isProcedureLike(n);
}

/**
 * Does `node` sit inside any enclosing `while`/`repeat`, stopping at the enclosing procedure or
 * trigger boundary. Same walk `classifyHangCapable` runs, minus the per-loop condition check.
 * Exported so a census script's denominator ("is this assignment even a loop-condition-target
 * CANDIDATE") is computed by calling this rather than by copying the walk a second time: two
 * copies of one walk is R80's shape, and this walk is a published rate's denominator.
 */
export function hasEnclosingLoop(node: ALSyntaxNode): boolean {
  let cur: ALSyntaxNode | null = node.parent;
  while (cur !== null && !isScope(cur)) {
    if (LOOP_KINDS.has(cur.kind)) return true;
    cur = cur.parent;
  }
  return false;
}

/**
 * The grammar's quoted-identifier kind, not in `ALNodeKind` (which enumerates only the kinds the
 * mutation pipeline targets, per `node-kinds.ts`'s own header). Same local-constant shape
 * `receiver.ts`'s private `isIdentifierLike` uses, not exported cross-package: this is a static
 * grammar fact, not a rule that could drift the way two hazard predicates could (R80's concern),
 * so a second one-line copy carries none of that risk.
 */
const QUOTED_IDENTIFIER = "quoted_identifier";

/**
 * Is `node` an identifier read, bare or quoted? AL parses `"Line Done"` as `quoted_identifier`, a
 * distinct grammar kind from `identifier`. A bare `.kind === ALNodeKind.identifier` check missed
 * every quoted target and every quoted condition read, which is invisible rather than declined:
 * such a site never even reaches `resolveVarRef`, let alone its DECLINE-on-unresolved rule.
 *
 * Exported so a census script's own "is this really a bare identifier target" invariant check can
 * call this rather than restating the same two-kind test a third time (`receiver.ts` already has an
 * unexported copy of the same shape, for the same static grammar fact).
 */
export function isIdentifierLike(node: ALSyntaxNode): boolean {
  return node.kind === ALNodeKind.identifier || node.rawKind === QUOTED_IDENTIFIER;
}

/** The target identifier of the assignment at, or enclosing, `node`. Bare or quoted (see
 *  `isIdentifierLike`). */
export function assignmentTargetOf(node: ALSyntaxNode): ALSyntaxNode | null {
  let cur: ALSyntaxNode | null = node;
  while (cur !== null && !isScope(cur)) {
    if (cur.kind === ALNodeKind.assignment_statement) {
      const target = cur.childForFieldName("left") ?? cur.namedChildren[0] ?? null;
      if (target === null) return null;
      return isIdentifierLike(target) ? target : null;
    }
    cur = cur.parent;
  }
  return null;
}

/** The condition expression of a `while`/`repeat`, or null when the grammar did not name one.
 *  Measured against the vendored grammar: both `while_statement` and `repeat_statement` (the
 *  `until` expression) expose a `condition` field. */
function conditionOf(loop: ALSyntaxNode): ALSyntaxNode | null {
  return loop.childForFieldName("condition") ?? null;
}

/** A directive marker: `#if`/`#elif`/`#else`/`#endif` and the symbol condition it carries. */
const DIRECTIVE_MARKERS: ReadonlySet<string> = new Set([
  "preproc_if",
  "preproc_elif",
  "preproc_else",
  "preproc_endif",
]);

/**
 * Every identifier the loop's condition reads in THIS build, bare or quoted (`isIdentifierLike`),
 * member names excluded by `resolveVarRef`.
 *
 * R402: the grammar puts a directive tail of the condition (`while (A < 10)` `#if X and (B < 5)`
 * `#endif` `do`) BESIDE the `condition` field, as a `preproc_conditional_expression_tail`, so those
 * are read too. Tails and list elements nested inside the condition are reached by the same walk.
 * A node in an arm the build compiles out is skipped; an UNDECIDED one is read, because for a hang
 * tag the unsafe direction is an untagged hang-capable mutant. Directive markers are never read:
 * their condition is a preprocessor symbol, not a variable.
 */
function conditionIdentifiers(parts: ALSyntaxNode[], ctx: SemanticContext): ALSyntaxNode[] {
  const out: ALSyntaxNode[] = [];
  const walk = (n: ALSyntaxNode): void => {
    if (DIRECTIVE_MARKERS.has(n.rawKind)) return;
    if (armOfNode(ctx, n) === "inactive") return;
    if (isIdentifierLike(n)) out.push(n);
    for (const c of n.namedChildren) walk(c);
  };
  for (const part of parts) walk(part);
  return out;
}

/**
 * The exit parts of every `while`/`repeat` enclosing `node`, innermost first, up to the procedure or
 * trigger boundary (`loopExitParts`). An open report data item is no longer read here: R487 refuses
 * every site in its code before this is asked (`hangCapableForMutatedNode`).
 */
function enclosingExitParts(node: ALSyntaxNode, ctx: SemanticContext): ALSyntaxNode[][] {
  const out: ALSyntaxNode[][] = [];
  let cur: ALSyntaxNode | null = node.parent;
  while (cur !== null && !isScope(cur)) {
    if (LOOP_KINDS.has(cur.kind)) out.push(loopExitParts(cur, ctx));
    cur = cur.parent;
  }
  return out;
}

/** Per-context, per-file memo. The file root is a stable object (the arm map is keyed by it). */
const memo = new WeakMap<object, WeakMap<ALSyntaxNode, Map<string, unknown>>>();
function cached<T>(ctx: SemanticContext, n: ALSyntaxNode, tag: string, f: () => T): T {
  let byRoot = memo.get(ctx);
  if (byRoot === undefined) {
    byRoot = new WeakMap();
    memo.set(ctx, byRoot);
  }
  const root = rootOf(n);
  let m = byRoot.get(root);
  if (m === undefined) {
    m = new Map();
    byRoot.set(root, m);
  }
  const k = `${tag}|${n.startIndex}|${n.endIndex}`;
  if (m.has(k)) return m.get(k) as T;
  const v = f();
  m.set(k, v);
  return v;
}

/** The object declaration holding `n`: the ancestor whose parent is an object container (the file
 *  root, or an R298 `preproc_conditional_object` wrapper). */
function objectOf(n: ALSyntaxNode): ALSyntaxNode | null {
  let cur: ALSyntaxNode = n;
  while (cur.parent !== null && !isObjectContainer(cur.parent)) cur = cur.parent;
  return cur.parent === null ? null : cur;
}

/** Every arm name of a procedure-like node (a split-header procedure has one per arm, possibly
 *  renamed): all count, the safe direction. */
const procNames = (p: ALSyntaxNode): string[] => procedureLikeArmNames(p).map(normalizeAlName);

/** The callee name of a same-object call shape (`P()`, `P;`, `this.P()`), or null. */
function bareCallee(n: ALSyntaxNode): string | null {
  if (n.rawKind !== "call_expression" && n.rawKind !== "call_statement") return null;
  const f = n.childForFieldName("function");
  if (f === null) return null;
  if (isIdentifierLike(f)) return normalizeAlName(f.text);
  if (f.rawKind !== "member_expression") return null;
  const o = f.childForFieldName("object");
  const m = f.childForFieldName("member");
  return o !== null && m !== null && normalizeAlName(o.text) === "this"
    ? normalizeAlName(m.text)
    : null;
}

/** Where code runs: its trigger or procedure, or the report column whose source holds it. */
function codeScope(n: ALSyntaxNode): ALSyntaxNode | null {
  for (let s = n.parent; s !== null; s = s.parent) {
    if (s.rawKind === "report_column" || isScope(s)) return s;
  }
  return null;
}

/** A reportextension dataset block anchored on a base item: `modify(D)`, `add(D)`, `addfirst(D)`,
 *  `addlast(D)` and any other `*_dataset_modification`. */
const isExtensionBlock = (n: ALSyntaxNode): boolean =>
  n.rawKind === "modify_modification" || n.rawKind.endsWith("_dataset_modification");

/**
 * Is trigger or column `t` inside an open data item (itself or any ancestor item), or in a
 * reportextension block whose base anchor is open (`modifiedItemOpen`)? An item added by an
 * extension is checked itself first, then its block's anchor.
 */
function insideOpenItem(t: ALSyntaxNode, ctx: SemanticContext): boolean {
  return cached(ctx, t, "open", () => {
    for (let p = t.parent; p !== null; p = p.parent) {
      if (isExtensionBlock(p)) {
        const ext = objectOf(p);
        return ext?.rawKind === "reportextension_declaration" && modifiedItemOpen(ext, p, ctx);
      }
      if (p.rawKind === "report_dataitem" && itemOpen(p, ctx)) return true;
    }
    return false;
  });
}

/**
 * Is report data item `item` open? R484's certificates decide (`dataItemOpen`), EXCEPT that a view
 * or SetRange certificate does not hold for an `Integer` item of a report that any reportextension
 * in the project extends: extension code can change the item's filters. `MaxIteration` (an engine
 * cap) still holds. This applies to the BASE report's own code too, not only the extension's.
 */
function itemOpen(item: ALSyntaxNode, ctx: SemanticContext): boolean {
  if (dataItemOpen(item, ctx)) return true;
  if (!isIntegerItem(item) || maxIterationBounded(item, ctx)) return false;
  return reportExtended(item, ctx);
}

/**
 * The base report an extension names, by its LAST name segment, so `N.P`, `"N"."P"` and `P` all
 * match report `P`. Measured on the vendored grammar: a namespace qualifier parses as an ERROR
 * sibling and the `base_object` field already holds only the last segment, so no splitting is
 * needed; `loop-exit-refusal.test.ts` pins that on the AST, and goes red if a grammar change puts
 * the full qualified name there. Matching the last segment alone can over-match a same-named report
 * in another namespace: an extra refusal, the safe direction. No base name at all (a MISSING node):
 * null, read as "extends every report".
 */
function extendedBaseName(ext: ALSyntaxNode): string | null {
  const name = normalizeAlName(ext.childForFieldName("base_object")?.text ?? "");
  return name === "" ? null : name;
}

const ANY_REPORT = "\u0000any";
const extendedReports = new WeakMap<object, Set<string>>();
/** Does any reportextension in the project extend the report holding `item`? Unknown (no file
 *  list on the context): yes, the safe direction. An item an extension adds is not extended. */
function reportExtended(item: ALSyntaxNode, ctx: SemanticContext): boolean {
  const report = objectOf(item);
  if (report === null || report.rawKind !== "report_declaration") return false;
  const files = ctx.files;
  if (files === undefined) return true;
  let names = extendedReports.get(ctx);
  if (names === undefined) {
    names = new Set();
    for (const f of files) {
      for (const o of objectDeclarationsOf(f.root)) {
        if (o.rawKind !== "reportextension_declaration") continue;
        names.add(extendedBaseName(o) ?? ANY_REPORT);
      }
    }
    extendedReports.set(ctx, names);
  }
  const own = normalizeAlName(report.childForFieldName("object_name")?.text ?? "");
  return names.has(ANY_REPORT) || names.has(own);
}

/**
 * A reportextension dataset block anchored on `D` runs inside base item `D` AND every base item
 * enclosing it. It counts as open unless the base report is in this project, `D` is found there,
 * and neither `D` nor any enclosing base item is open (`itemOpen`), and every enclosing `Integer`
 * item has a `MaxIteration` bound: an extension can change a base item's filters, so a base-only
 * view or `SetRange` certificate does not count. Not found, ambiguous or unnamed: open (the safe
 * direction).
 */
function modifiedItemOpen(ext: ALSyntaxNode, mod: ALSyntaxNode, ctx: SemanticContext): boolean {
  const base = extendedBaseName(ext);
  if (base === null) return true;
  const target = normalizeAlName(mod.childForFieldName("target")?.text ?? "");
  const reports = ctx.symbols.objects.filter(
    (o) => o.kind === "report" && normalizeAlName(o.name) === base,
  );
  const [report] = reports;
  if (reports.length !== 1 || report === undefined) return true;
  const items: ALSyntaxNode[] = [];
  visitAll(report.node, (n) => {
    if (
      n.rawKind === "report_dataitem" &&
      normalizeAlName(n.childForFieldName("name")?.text ?? "") === target
    ) {
      items.push(n);
    }
  });
  const [item] = items;
  if (items.length !== 1 || item === undefined) return true;
  for (let p: ALSyntaxNode | null = item; p !== null; p = p.parent) {
    if (p.rawKind !== "report_dataitem") continue;
    if (itemOpen(p, ctx)) return true;
    if (isIntegerItem(p) && !maxIterationBounded(p, ctx)) return true;
  }
  return false;
}

function isIntegerItem(item: ALSyntaxNode): boolean {
  return normalizeAlName(item.childForFieldName("table_name")?.text ?? "") === "integer";
}

/** The engine cap: a literal `MaxIteration` from 1 to `ITERATION_CAP` the build surely has. */
function maxIterationBounded(item: ALSyntaxNode, ctx: SemanticContext): boolean {
  const body = item.childForFieldName("body");
  if (body === null) return false;
  return itemMembers(body, ctx, true).some((m) => {
    if (m.kind !== ALNodeKind.property) return false;
    const v = m.childForFieldName("value");
    if (normalizeAlName(m.childForFieldName("name")?.text ?? "") !== "maxiteration") return false;
    if (v === null || v.rawKind !== "integer") return false;
    const max = Number(v.text);
    return max > 0 && max <= ITERATION_CAP;
  });
}

/** Same-object procedures reachable (by name, transitively) from open-item code. */
function openReachable(obj: ALSyntaxNode, ctx: SemanticContext): Set<string> {
  return cached(ctx, obj, "reach", () => {
    const calls: { readonly callee: string; readonly scope: ALSyntaxNode | null }[] = [];
    visitAll(obj, (n) => {
      const callee = bareCallee(n);
      if (callee !== null) calls.push({ callee, scope: codeScope(n) });
    });
    const out = new Set<string>();
    for (let changed = true; changed; ) {
      changed = false;
      for (const c of calls) {
        if (out.has(c.callee) || c.scope === null) continue;
        const from = isProcedureLike(c.scope)
          ? procNames(c.scope).some((k) => out.has(k))
          : insideOpenItem(c.scope, ctx);
        if (from) {
          out.add(c.callee);
          changed = true;
        }
      }
    }
    return out;
  });
}

/** R487: is `node` in open-item code, or in a same-object procedure open-item code reaches? */
function inOpenItemCode(node: ALSyntaxNode, ctx: SemanticContext): boolean {
  const s = codeScope(node);
  if (s === null) return false;
  if (!isProcedureLike(s)) return insideOpenItem(s, ctx);
  const obj = objectOf(s);
  if (obj === null) return false;
  const reach = openReachable(obj, ctx);
  return procNames(s).some((k) => reach.has(k));
}

/**
 * The members of a data item's body, through `#if` arms the build does not compile out. By default
 * an UNDECIDED arm is kept: exit guards are read from these, and for a refusal the safe direction
 * reads too much. `certain` keeps, inside a `#if`, only an ACTIVE arm, as the engine's
 * `liveMembers` does for object members (which does not descend into a data item's
 * `preproc_conditional_report`): a bound certificate must hold in the build.
 */
function itemMembers(body: ALSyntaxNode, ctx: SemanticContext, certain = false): ALSyntaxNode[] {
  const out: ALSyntaxNode[] = [];
  const collect = (n: ALSyntaxNode, insideIf: boolean): void => {
    for (const c of n.namedChildren) {
      const arm = armOfNode(ctx, c);
      if (arm === "inactive") continue;
      if (c.rawKind.startsWith("preproc_")) collect(c, true);
      else if (!(certain && insideIf && arm !== "active")) out.push(c);
    }
  };
  collect(body, false);
  return out;
}

const triggerName = (t: ALSyntaxNode): string =>
  normalizeAlName(t.childForFieldName("name")?.text ?? "");

/**
 * R484: a report data item is a loop BC drives, calling `OnAfterGetRecord` once per record. Over the
 * virtual `Integer` table it ends only when a bound or an exit stops it; any other table is out of
 * scope (it ends with its records; a trigger inserting into the set it walks is a known exclusion).
 * Returns null for a BOUNDED item, which is not a loop here. A bound holds ONLY as one of:
 * - `MaxIteration` a literal from 1 to `ITERATION_CAP` (0 means no limit). A report-engine limit no
 *   filter can replace, so it needs no mention scan;
 * - `DataItemTableView` filtering `Number` by `const(...)` or a closed `filter(...)` (`closedFilter`),
 *   AND zero mentions of the item's record (`mentionScan`), since any mention may replace it;
 * - the SINGLE-MENTION certificate (`certified`): one literal, small `SetRange(Number, ...)`.
 * Otherwise it is OPEN, and R487 refuses every site in its code (`inOpenItemCode`). R484's exit
 * guards and range arguments are no longer collected: the blanket rule covers every site they named.
 */
function dataItemOpen(item: ALSyntaxNode, ctx: SemanticContext): boolean {
  return cached(ctx, item, "item", () => dataItemOpenOnce(item, ctx));
}

function dataItemOpenOnce(item: ALSyntaxNode, ctx: SemanticContext): boolean {
  const table = item.childForFieldName("table_name");
  if (table === null || normalizeAlName(table.text) !== "integer") return false;
  const name = normalizeAlName(item.childForFieldName("name")?.text ?? "");
  const body = item.childForFieldName("body");
  if (body === null) return false;
  const members = itemMembers(body, ctx);
  let viewBounded = false;
  // A bound property counts only where the build surely has it: a direct member, or one inside a
  // `#if` whose arm is ACTIVE (an undecided arm is dropped), as the SetRange certificate requires.
  for (const m of itemMembers(body, ctx, true)) {
    if (m.kind !== ALNodeKind.property) continue;
    const p = normalizeAlName(m.childForFieldName("name")?.text ?? "");
    const v = m.childForFieldName("value");
    if (p === "maxiteration" && v !== null && v.rawKind === "integer") {
      const max = Number(v.text);
      if (max > 0 && max <= ITERATION_CAP) return false;
    }
    if (p === "dataitemtableview" && viewBoundsNumber(m)) viewBounded = true;
  }
  const triggers = members.filter((m) => m.kind === ALNodeKind.trigger);
  const scan = mentionScan(item, name, triggers);
  if (viewBounded && scan.mentions.length + scan.calls.length === 0) return false;
  return !certified(scan, name, triggers, ctx);
}

/** Is `call` a statement of `trigger`'s own block (through nested `begin`/`end` and `#if` only),
 *  with no `exit` statement before it in the trigger? */
function unconditional(call: ALSyntaxNode, trigger: ALSyntaxNode): boolean {
  for (let a = call.parent; a !== null && !samePos(a, trigger); a = a.parent) {
    if (
      a.rawKind !== "statement_block" &&
      a.rawKind !== "code_block" &&
      !a.rawKind.startsWith("preproc_")
    ) {
      return false;
    }
  }
  let exitBefore = false;
  visitAll(trigger, (n) => {
    if (n.rawKind === "exit_statement" && n.startIndex < call.startIndex) exitBefore = true;
  });
  return !exitBefore;
}

function visitAll(n: ALSyntaxNode, f: (n: ALSyntaxNode) => void): void {
  f(n);
  for (const c of n.namedChildren) visitAll(c, f);
}

/**
 * R484: the most records a bound may admit and still count as a bound. A fixed bound above it
 * (`1..2147483647`, `MaxIteration = 100000000`) is as open as no bound for a test run.
 * ponytail: one fixed cap, chosen without a timing measurement; raise or lower it if a measured
 * trigger cost says so.
 */
const ITERATION_CAP = 1_000_000;

/** A closed filter of at most `ITERATION_CAP` records: every `|` item an integer or `a..b` with
 *  integer ends and a <= b, counted inclusively and summed. Anything else (`<`, `>`, `*`, an open
 *  end, a name, a reversed range) is not closed. */
function closedFilter(text: string): boolean {
  const s = text.replace(/^'|'$/g, "").trim();
  if (s === "") return false;
  let count = 0;
  for (const item of s.split("|")) {
    const ends = item.split("..").map((e) => e.trim());
    if (ends.length > 2 || ends.some((e) => !/^-?\d+$/.test(e))) return false;
    const [lo, hi] = ends.map(Number);
    if (lo === undefined) return false;
    if (hi !== undefined && hi < lo) return false;
    count += hi === undefined ? 1 : hi - lo + 1;
  }
  return count <= ITERATION_CAP;
}

/** Does a `DataItemTableView` value filter `Number` by `const(...)` or a closed `filter(...)`? */
function viewBoundsNumber(prop: ALSyntaxNode): boolean {
  let found = false;
  visitAll(prop, (n) => {
    if (n.rawKind !== "where_condition") return;
    const f = n.childForFieldName("field");
    if (f === null || normalizeAlName(f.text) !== "number") return;
    const kw = n.namedChildren.find((c) => c.rawKind.endsWith("_keyword"));
    const v = n.childForFieldName("value");
    if (kw === undefined || v === null) return;
    const k = normalizeAlName(kw.text);
    if (k === "const" || (k === "filter" && closedFilter(v.text))) found = true;
  });
  return found;
}

interface MentionScan {
  /** The item's name used anywhere in the report object (not a declared name, a source table or a
   *  member half), inactive arms included. */
  readonly mentions: ALSyntaxNode[];
  /** Every unqualified call in the item's own triggers: its receiver may be the implicit record. */
  readonly calls: { readonly call: ALSyntaxNode; readonly trigger: ALSyntaxNode }[];
}

/**
 * R484: every operational mention of the item's record. No list of filter-touching methods: as a
 * receiver, an argument (`CopyFilter` into it, `Clear(D)`, passing it to a procedure), a `with`
 * subject or anything else, anywhere in the report, a child trigger included. A view bound needs
 * none; the SetRange certificate needs exactly one, its own call. Known cost: an unqualified
 * `Error(...)` in the item's own triggers is a mention too (the safe direction).
 */
function mentionScan(item: ALSyntaxNode, name: string, triggers: ALSyntaxNode[]): MentionScan {
  let scope: ALSyntaxNode = item;
  for (let p = item.parent; p !== null; p = p.parent) {
    scope = p;
    if (p.kind === ALNodeKind.report || p.rawKind === "reportextension_declaration") break;
  }
  const mentions: ALSyntaxNode[] = [];
  visitAll(scope, (n) => {
    if (!isIdentifierLike(n) || normalizeAlName(n.text) !== name) return;
    if (n.fieldName === "name" || n.fieldName === "table_name" || n.fieldName === "member") return;
    mentions.push(n);
  });
  const calls: { readonly call: ALSyntaxNode; readonly trigger: ALSyntaxNode }[] = [];
  for (const t of triggers) {
    visitAll(t, (n) => {
      // R487 item 7: an unqualified `Number := X` moves the item's cursor: a mention.
      if (n.kind === ALNodeKind.assignment_statement) {
        const l = n.childForFieldName("left");
        if (l !== null && isIdentifierLike(l) && normalizeAlName(l.text) === "number") {
          mentions.push(l);
        }
      }
      if (n.rawKind !== "call_expression" && n.rawKind !== "call_statement") return;
      const fn = n.childForFieldName("function");
      if (fn !== null && isIdentifierLike(fn)) calls.push({ call: n, trigger: t });
    });
  }
  return { mentions, calls };
}

/**
 * The SINGLE-MENTION certificate (R484): the scan found exactly one mention, and it is a literal
 * `SetRange(Number, v)` or `SetRange(Number, lo, hi)` (`rangeCallOf`) in the item's own
 * `OnPreDataItem`, unconditional, in an ACTIVE arm (not inactive, not undecided).
 */
function certified(
  scan: MentionScan,
  name: string,
  triggers: ALSyntaxNode[],
  ctx: SemanticContext,
): boolean {
  const { mentions, calls } = scan;
  if (mentions.length + calls.length !== 1) return false;
  // The one mention: an unqualified call, or the receiver of a qualified call.
  let call: ALSyntaxNode | null = null;
  let trigger: ALSyntaxNode | null = null;
  const [c] = calls;
  const [m] = mentions;
  if (c !== undefined) {
    call = c.call;
    trigger = c.trigger;
  } else if (m !== undefined) {
    const member = m.parent;
    const outer = member?.parent ?? null;
    if (member === null || outer === null || member.rawKind !== "member_expression") return false;
    const obj = member.childForFieldName("object");
    const fn = outer.childForFieldName("function");
    if (obj === null || !samePos(obj, m) || fn === null || !samePos(fn, member)) return false;
    call = outer;
    trigger =
      triggers.find((t) => t.startIndex <= outer.startIndex && outer.endIndex <= t.endIndex) ??
      null;
  }
  if (call === null || trigger === null || call.rawKind !== "call_expression") return false;
  return (
    rangeCallOf(call, name)?.literal === true &&
    triggerName(trigger) === "onpredataitem" &&
    armOfNode(ctx, call) === "active" &&
    unconditional(call, trigger)
  );
}

/** An integer literal, or a minus applied to one. */
function intValue(a: ALSyntaxNode): number | null {
  if (a.rawKind === "integer") return Number(a.text);
  if (a.rawKind === "unary_expression") {
    const op = a.childForFieldName("operand");
    if (op !== null && op.rawKind === "integer" && a.text.trim().startsWith("-")) {
      return -Number(op.text);
    }
  }
  return null;
}

/**
 * A `SetRange`/`SetFilter` call on the item's own record (unqualified, or qualified by its name).
 * `literal`: `SetRange(<f>, v)` or `SetRange(<f>, lo, hi)` with integer literals, lo <= hi and at
 * most `ITERATION_CAP` records (a reversed range is no bound).
 */
function rangeCallOf(n: ALSyntaxNode, item: string): { readonly literal: boolean } | null {
  if (n.rawKind !== "call_expression") return null;
  const f = n.childForFieldName("function");
  if (f === null) return null;
  let method: string;
  if (isIdentifierLike(f)) method = normalizeAlName(f.text);
  else if (f.rawKind === "member_expression") {
    const obj = f.childForFieldName("object");
    const mem = f.childForFieldName("member");
    if (obj === null || mem === null || normalizeAlName(obj.text) !== item) return null;
    method = normalizeAlName(mem.text);
  } else return null;
  if (method !== "setrange" && method !== "setfilter") return null;
  const al = n.childForFieldName("arguments");
  const rest = (al === null ? [] : al.namedChildren).slice(1);
  const [lo, hi, ...more] = rest.map(intValue);
  const literal =
    method === "setrange" &&
    more.length === 0 &&
    lo !== null &&
    lo !== undefined &&
    hi !== null &&
    (hi === undefined || (lo <= hi && hi - lo + 1 <= ITERATION_CAP));
  return { literal };
}

/**
 * R446/R480: the parts that decide whether `loop` ends. Its own condition parts, plus the guard of
 * every exit in its body (`bodyExitGuards`) UNLESS the condition names a cursor method
 * (`namesCursorMethod`). When the condition reads no name and calls nothing in this build
 * (`while true`, `until false`), also every value that feeds those parts (`indirectFeeds`). A scoped
 * heuristic, not a proof that no mutant hangs: see the known exclusions in the header.
 */
function loopExitParts(loop: ALSyntaxNode, ctx: SemanticContext): ALSyntaxNode[] {
  const own = loopConditionParts(loop);
  if (conditionIsNameAndCallFree(own, ctx)) {
    const parts = [...own, ...bodyExitGuards(loop)];
    return [...parts, ...indirectFeeds(loop, parts, ctx)];
  }
  return namesCursorMethod(own, ctx) ? own : [...own, ...bodyExitGuards(loop)];
}

/** R480: a method whose name says it steps a cursor or a stream. By NAME, any receiver. */
const CURSOR_METHODS: ReadonlySet<string> = new Set(["next", "read", "eos", "movenext"]);

/**
 * R480: does the condition (active arms, tails included; undecided read) name a cursor method? A
 * `call_expression` whose callee is a bare name or a member, or a bare `member_expression` (`X.Next`
 * with no parentheses), whose name is in `CURSOR_METHODS`. A heuristic, NOT a proof that the loop
 * advances: a user procedure or field named `Next` matches, and so does a mixed condition
 * (`(C.Next() <> 0) or KeepGoing`). Both are known exclusions.
 */
function namesCursorMethod(parts: ALSyntaxNode[], ctx: SemanticContext): boolean {
  const named = (n: ALSyntaxNode | null): boolean =>
    n !== null && CURSOR_METHODS.has(normalizeAlName(n.text));
  const walk = (n: ALSyntaxNode): boolean => {
    if (DIRECTIVE_MARKERS.has(n.rawKind)) return false;
    if (armOfNode(ctx, n) === "inactive") return false;
    if (n.rawKind === "call_expression") {
      const f = n.childForFieldName("function");
      if (f !== null && isIdentifierLike(f) && named(f)) return true;
    }
    if (n.rawKind === "member_expression" && named(n.childForFieldName("member"))) return true;
    return n.namedChildren.some(walk);
  };
  return parts.some(walk);
}

/**
 * R480 shape 2: the right-hand side (and its `#if` tails) of every body assignment, nested bodies
 * included, whose target is a name `parts` read, to a fixpoint (`I += 1; Done := I >= 3; if Done
 * then exit` makes `I >= 3` a part, then `1`). By NAME, the safe direction for a refusal: every
 * identifier counts, member halves included, and a bare target `X` or a member target `R.X` matches
 * a read of `X`. An assignment in an inactive arm adds nothing, because no name or reader reads an
 * inactive node; an undecided one is followed.
 */
function indirectFeeds(
  loop: ALSyntaxNode,
  parts: ALSyntaxNode[],
  ctx: SemanticContext,
): ALSyntaxNode[] {
  const body = loop.childForFieldName("body");
  if (body === null) return [];
  const names = new Set<string>();
  const collect = (n: ALSyntaxNode): void => {
    if (DIRECTIVE_MARKERS.has(n.rawKind) || armOfNode(ctx, n) === "inactive") return;
    if (isIdentifierLike(n)) names.add(normalizeAlName(n.text));
    for (const c of n.namedChildren) collect(c);
  };
  for (const p of parts) collect(p);
  const assignments: ALSyntaxNode[] = [];
  const find = (n: ALSyntaxNode): void => {
    if (n.kind === ALNodeKind.assignment_statement) assignments.push(n);
    for (const c of n.namedChildren) find(c);
  };
  find(body);
  const out: ALSyntaxNode[] = [];
  const used = new Set<ALSyntaxNode>();
  for (let changed = true; changed; ) {
    changed = false;
    for (const a of assignments) {
      if (used.has(a)) continue;
      const left = a.childForFieldName("left");
      const right = a.childForFieldName("right");
      if (left === null || right === null) continue;
      const name = left.kind === ALNodeKind.field_access ? left.childForFieldName("member") : left;
      if (name === null || !isIdentifierLike(name) || !names.has(normalizeAlName(name.text))) {
        continue;
      }
      used.add(a);
      const fed = [
        right,
        ...a.namedChildren.filter((c) => c.rawKind === "preproc_conditional_expression_tail"),
      ];
      for (const f of fed) {
        out.push(f);
        collect(f);
      }
      changed = true;
    }
  }
  return out;
}

const BREAK_SCOPES: ReadonlySet<string> = new Set([
  "while_statement",
  "repeat_statement",
  "for_statement",
  "foreach_statement",
]);

const samePos = (a: ALSyntaxNode, b: ALSyntaxNode): boolean =>
  a.startIndex === b.startIndex && a.endIndex === b.endIndex;

/** Does the condition (active arms, tails included) read no name and call nothing? True for
 *  `while false` too, which does not loop at all: then the extra guards cost nothing. */
function conditionIsNameAndCallFree(parts: ALSyntaxNode[], ctx: SemanticContext): boolean {
  const walk = (n: ALSyntaxNode): boolean => {
    if (DIRECTIVE_MARKERS.has(n.rawKind)) return true;
    if (armOfNode(ctx, n) === "inactive") return true;
    if (n.rawKind === "call_expression" || isIdentifierLike(n)) return false;
    return n.namedChildren.every(walk);
  };
  return parts.length > 0 && parts.every(walk);
}

/** `CurrReport.Quit`/`Break` and their XMLport twins end the trigger, so the loop (R446). With or
 *  without `()`: both forms hold this `member_expression`. `Skip` is NOT here: its docs do not say
 *  it interrupts an AL loop. */
const REPORT_EXITS: ReadonlySet<string> = new Set(["quit", "break"]);
const REPORT_INSTANCES: ReadonlySet<string> = new Set(["currreport", "currxmlport"]);

/** Does `n` end `loop`: `exit`, `Error(...)` outside `asserterror`, `CurrReport.Quit`/`Break`, or a
 *  `break` whose nearest loop is `loop`. */
function exitsLoop(n: ALSyntaxNode, loop: ALSyntaxNode): boolean {
  if (n.rawKind === "exit_statement") return true;
  if (n.rawKind === "member_expression") return isReportExit(n);
  if (n.rawKind === "call_expression") return isRaisedError(n, loop);
  if (n.rawKind !== "break_statement") return false;
  for (let a = n.parent; a !== null; a = a.parent) {
    if (BREAK_SCOPES.has(a.rawKind)) return samePos(a, loop);
  }
  return false;
}

/** Every condition between a body exit and `loop`: `if` conditions, `case` selectors and patterns,
 *  inner loop conditions and `for` bounds, with their `#if` tails. */
function bodyExitGuards(loop: ALSyntaxNode): ALSyntaxNode[] {
  const body = loop.childForFieldName("body");
  if (body === null) return [];
  return exitGuards(body, loop, (n) => exitsLoop(n, loop));
}

/** `CurrReport.Quit`/`Break` or an XMLport twin, with or without `()`. */
function isReportExit(n: ALSyntaxNode): boolean {
  const obj = n.childForFieldName("object");
  const mem = n.childForFieldName("member");
  return (
    obj !== null &&
    mem !== null &&
    REPORT_INSTANCES.has(normalizeAlName(obj.text)) &&
    REPORT_EXITS.has(normalizeAlName(mem.text))
  );
}

/** An `Error(...)` call that no `asserterror` between it and `stop` catches. */
function isRaisedError(n: ALSyntaxNode, stop: ALSyntaxNode): boolean {
  if (n.rawKind !== "call_expression") return false;
  const f = n.childForFieldName("function");
  if (f === null || !isIdentifierLike(f) || normalizeAlName(f.text) !== "error") return false;
  for (let a = n.parent; a !== null && !samePos(a, stop); a = a.parent) {
    if (a.rawKind === "asserterror_statement") return false;
  }
  return true;
}

/** The guards of every node under `body` that `isExit` names, climbing to `loop` (R446). */
function exitGuards(
  body: ALSyntaxNode,
  loop: ALSyntaxNode,
  isExit: (n: ALSyntaxNode) => boolean,
): ALSyntaxNode[] {
  const out = new Map<number, ALSyntaxNode>();
  const add = (n: ALSyntaxNode | null): void => {
    if (n !== null) out.set(n.startIndex, n);
  };
  const visitN = (n: ALSyntaxNode): void => {
    if (isExit(n)) {
      for (let a = n.parent; a !== null && !samePos(a, loop); a = a.parent) {
        switch (a.rawKind) {
          case "if_statement":
          case "while_statement":
          case "repeat_statement":
            add(a.childForFieldName("condition"));
            break;
          case "case_statement":
            add(a.childForFieldName("expression"));
            break;
          case "case_branch":
            add(a.childForFieldName("pattern"));
            break;
          case "for_statement":
            add(a.childForFieldName("start"));
            add(a.childForFieldName("end"));
            break;
          case "foreach_statement":
            add(a.childForFieldName("iterable"));
            break;
        }
        for (const t of a.namedChildren) {
          if (t.rawKind === "preproc_conditional_expression_tail") add(t);
        }
      }
    }
    for (const c of n.namedChildren) visitN(c);
  };
  visitN(body);
  return [...out.values()];
}

/**
 * A loop's exit test: its `condition` field plus the `#if` tails the grammar puts BESIDE it (R402).
 * Exported so `shift-integer`'s loop-condition refusal reads the same parts (R454 shape 1).
 */
export function loopConditionParts(loop: ALSyntaxNode): ALSyntaxNode[] {
  const cond = conditionOf(loop);
  return [
    ...(cond !== null ? [cond] : []),
    ...loop.namedChildren.filter((c) => c.rawKind === "preproc_conditional_expression_tail"),
  ];
}

/**
 * R454 shape 3: a `Rec.Field` read or write, kept as TWO parts, the receiver's resolved declaration
 * and the normalised member name. Never joined into one string: `"A.B".C` and `A."B.C"` can share a
 * declaration list and would join to the same text. An unresolved receiver (`with`, implicit `Rec`)
 * gives null, so the site stays declined (spec 3.1).
 */
interface MemberRef {
  readonly receiver: NonNullable<ReturnType<typeof resolveVarRef>>;
  readonly member: string;
}

function memberRefOf(n: ALSyntaxNode, ctx: SemanticContext): MemberRef | null {
  if (n.kind !== ALNodeKind.field_access) return null;
  const obj = n.childForFieldName("object");
  const mem = n.childForFieldName("member");
  if (obj === null || mem === null || !isIdentifierLike(obj)) return null;
  const receiver = resolveVarRef(obj, ctx);
  return receiver === null ? null : { receiver, member: normalizeAlName(mem.text) };
}

/** Does the loop's condition read `target`? Same arm and marker rules as `conditionIdentifiers`. */
function conditionReadsMember(
  parts: ALSyntaxNode[],
  target: MemberRef,
  ctx: SemanticContext,
): boolean {
  const walk = (n: ALSyntaxNode): boolean => {
    if (DIRECTIVE_MARKERS.has(n.rawKind)) return false;
    if (armOfNode(ctx, n) === "inactive") return false;
    const ref = memberRefOf(n, ctx);
    if (
      ref !== null &&
      ref.member === target.member &&
      sameDeclaration(ref.receiver, target.receiver)
    ) {
      return true;
    }
    return n.namedChildren.some(walk);
  };
  return parts.some(walk);
}

/** The member target of the assignment at, or enclosing, `node`, as its receiver and member
 *  IDENTIFIERS read from the tree before any resolution (R-364: an unresolved receiver must still
 *  reach the name fallback), or null. `assignmentTargetOf` stays identifier-only, which the census
 *  scripts assert. */
function memberTargetOf(node: ALSyntaxNode): {
  readonly field: ALSyntaxNode;
  readonly receiver: ALSyntaxNode;
  readonly member: ALSyntaxNode;
} | null {
  for (let cur: ALSyntaxNode | null = node; cur !== null && !isScope(cur); cur = cur.parent) {
    if (cur.kind === ALNodeKind.assignment_statement) {
      const left = cur.childForFieldName("left") ?? cur.namedChildren[0] ?? null;
      if (left === null || left.kind !== ALNodeKind.field_access) return null;
      const receiver = left.childForFieldName("object");
      const member = left.childForFieldName("member");
      if (receiver === null || member === null || !isIdentifierLike(receiver)) return null;
      return { field: left, receiver, member };
    }
  }
  return null;
}

/**
 * R-364: a loop-condition target by NAME, for where no declaration can be resolved. Names are
 * compared as AL compares them (any case, quotes stripped); the matcher normalises them itself.
 * `receiver: null` is a plain variable; otherwise the target is `<receiver>.<member>`.
 * `implicitReceiver` (R-458): a plain target also matches `<implicitReceiver>.<member>`, and a
 * target on that receiver also matches a plain `<member>`.
 */
export type NameTarget = {
  readonly receiver: string | null;
  readonly member: string;
  readonly implicitReceiver?: string;
};

/**
 * R-364: does any enclosing loop's condition (to the procedure or trigger boundary) read `target`
 * by NAME? A plain target matches a plain identifier read, including a member read's receiver
 * (R294's `Txt.Contains`), never the member half of `R.Amount`. A member target matches the
 * (receiver, member) PAIR structurally, never joined text (`"A.B".C` is not `A."B.C"`). Same arm
 * and directive-marker rules as `conditionIdentifiers` and `conditionReadsMember`.
 *
 * A name match is a guess (spec 3.1), so this is no classifier by itself: a caller gates it.
 * R-364's gate is `classifyHangCapable` (unresolved target inside an unindexed object); R-458
 * reuses this matcher under its own gate.
 */
export function loopConditionReadsByName(
  assignment: ALSyntaxNode,
  target: NameTarget,
  ctx: SemanticContext,
): boolean {
  const receiver = target.receiver === null ? null : normalizeAlName(target.receiver);
  const member = normalizeAlName(target.member);
  const implicit =
    target.implicitReceiver === undefined ? null : normalizeAlName(target.implicitReceiver);
  const plainMatches = receiver === null || (implicit !== null && receiver === implicit);
  const wanted = receiver ?? implicit;
  const walk = (n: ALSyntaxNode): boolean => {
    if (DIRECTIVE_MARKERS.has(n.rawKind)) return false;
    if (armOfNode(ctx, n) === "inactive") return false;
    if (n.kind === ALNodeKind.field_access) {
      const obj = n.childForFieldName("object");
      const mem = n.childForFieldName("member");
      if (obj !== null && mem !== null && isIdentifierLike(obj) && wanted !== null) {
        if (normalizeAlName(obj.text) === wanted && normalizeAlName(mem.text) === member) {
          return true;
        }
      }
      // The member half is never a plain read; everything else (the receiver, arguments) is.
      return n.namedChildren.filter((c) => c.fieldName !== "member").some(walk);
    }
    if (plainMatches && isIdentifierLike(n) && normalizeAlName(n.text) === member) return true;
    return n.namedChildren.some(walk);
  };
  return enclosingExitParts(assignment, ctx).some((parts) => parts.some(walk));
}

/**
 * R-364's gate: is `node` inside an object the symbol table does not index (`unindexedObjects`,
 * R343), where no declaration outside a trigger's own `var` section can resolve? Its OWN enclosing
 * object, matched by file and span, never by wrapper identity or by offset alone (offsets repeat
 * across files). Objects in `unparsedObjects`, failed headers and other unindexed members are out
 * of scope and keep the declaration-only rule.
 */
function inUnindexedObject(node: ALSyntaxNode, ctx: SemanticContext): boolean {
  const unindexed = ctx.symbols.unindexedObjects;
  if (unindexed.length === 0) return false;
  const root = rootOf(node);
  return unindexed.some(
    (o) =>
      o.startIndex <= node.startIndex && node.endIndex <= o.endIndex && sameFile(rootOf(o), root),
  );
}

function rootOf(node: ALSyntaxNode): ALSyntaxNode {
  let cur = node;
  while (cur.parent !== null) cur = cur.parent;
  return cur;
}

/** Two file roots hold the same source. Identical sources give identical answers here, so this is
 *  exact for the question asked. */
function sameFile(a: ALSyntaxNode, b: ALSyntaxNode): boolean {
  return a.endIndex === b.endIndex && a.text === b.text;
}

/**
 * Do two resolved variable references name the SAME declaration?
 *
 * NOT `===`. Measured (probe against this package's own fixtures, 2026-09-06): `resolveVarRef`
 * resolves a TRIGGER-local through `receiver.ts`'s `triggerScopeVar`, which calls
 * `collectVarDeclarations` fresh on every call rather than reading a cached table. Deliberately so,
 * per that file's own comment, because trigger names repeat per-object and are not indexed in the
 * symbol table's maps. Two resolutions of the very same trigger-local `var N: Integer` therefore
 * come back as two DIFFERENT `VarSymbol` objects (verified: same name and type, `=== false`).
 * `globalsOf`/`localsOf`/`resolveProcedure` (the procedure-local and global paths) DO return a
 * cached object and `===` holds there, but a classifier that special-cased "except inside a
 * trigger" would be carrying a landmine for the next scope `lookupVar` grows.
 *
 * `startIndex` of the declaration node is used instead: two distinct declarations can never start
 * at the same byte offset in one file, so this is exactly as precise as reference identity where
 * reference identity happens to hold, and correct where it does not. This is position, not a name
 * match: two same-named locals in DIFFERENT procedures have different declaration offsets, so this
 * still tells them apart on the path where it matters, except that path never opens in the first
 * place. `classifyHangCapable`'s ancestor walk climbs `.parent` pointers only, and a parent-pointer
 * walk starting inside procedure A can reach shared ancestors (the object, the file) but can never
 * DESCEND into a sibling procedure B's subtree: there is no pointer from A's ancestors back down
 * into B. So a sibling procedure's same-named local is structurally unreachable from this walk
 * regardless of where SCOPE_KINDS stops it; the procedure/trigger boundary check never even gets a
 * chance to matter for that case, because the walk was never going to arrive there anyway.
 *
 * PRECONDITION, load-bearing: `startIndex` is a byte offset WITHIN ITS OWN FILE, so two
 * declarations in DIFFERENT files can share one. This comparison is sound here ONLY because both
 * `a` and `b` are always resolved from identifiers inside one procedure of one object, the
 * assignment's target and an enclosing loop's condition, so every symbol either side can resolve
 * to is necessarily declared in the SAME file `classifyHangCapable` was called with. If this
 * function, or its calling pattern, is ever reused to compare symbols that could come from
 * different files, this comparison is wrong and needs a file component added to the key. See
 * ROADMAP R209 for the underlying `resolveVarRef` identity gap this works around, and for why
 * fixing it at the source (caching `triggerScopeVar`'s result) is not a small change.
 *
 * AND THE NAME (R295): every name of `A, B: Integer` is its own symbol, but all of them share the
 * one declaration node. Position alone would make A and B one variable and tag
 * `while A < 10 do B := B + 1` as a hang. Compared as AL compares names: unquoted, any case.
 */
function sameDeclaration(
  a: NonNullable<ReturnType<typeof resolveVarRef>>,
  b: NonNullable<ReturnType<typeof resolveVarRef>>,
): boolean {
  return (
    a.node.startIndex === b.node.startIndex && normalizeAlName(a.name) === normalizeAlName(b.name)
  );
}

/**
 * Does any enclosing loop's condition read this assignment's target?
 *
 * Resolution is by DECLARATION first. In an indexed object an unresolvable target returns `null`:
 * a claim here can force LethAL to end a BC session on the user's own server, and a name match is
 * a guess (spec 3.1). R-364: inside an object the symbol table does not index (`unindexedObjects`,
 * R343) nothing outside a trigger's own `var` section can resolve, so there an unresolved target
 * is matched by NAME (`loopConditionReadsByName`). That is the safe direction: an extra refusal
 * costs a site, a missed one can hang a session. R-458: when the declaration path says no, the
 * target is also matched by name through every `with` subject and implicit record its name can bind
 * to (`byNameRefusal`).
 */
export function classifyHangCapable(
  node: ALSyntaxNode,
  ctx: SemanticContext,
): HangCapableReason | null {
  const target = assignmentTargetOf(node);
  if (target === null) {
    // R454 shape 3: a member target, matched by receiver declaration and member name separately.
    const parts = memberTargetOf(node);
    if (parts === null) return null;
    const ref = memberRefOf(parts.field, ctx);
    const byName = { receiver: parts.receiver.text, member: parts.member.text };
    if (ref === null) {
      return inUnindexedObject(node, ctx) && loopConditionReadsByName(node, byName, ctx)
        ? "loop-condition-target"
        : byNameRefusal(node, byName, ctx, "none");
    }
    if (enclosingExitParts(node, ctx).some((parts) => conditionReadsMember(parts, ref, ctx))) {
      return "loop-condition-target";
    }
    return byNameRefusal(node, byName, ctx, "local");
  }
  const byName = { receiver: null, member: target.text };
  const targetSym = resolveVarRef(target, ctx);
  if (targetSym === null) {
    return inUnindexedObject(node, ctx) && loopConditionReadsByName(node, byName, ctx)
      ? "loop-condition-target"
      : byNameRefusal(node, byName, ctx, "none");
  }

  let cur: ALSyntaxNode | null = node.parent;
  while (cur !== null && !isScope(cur)) {
    // R480 shape 4n: a write to an enclosing `for`'s control variable, by declaration. A separate
    // check: `for` is not in `LOOP_KINDS`, which the literal refusals of other operators read.
    if (cur.rawKind === "for_statement") {
      const variable = cur.childForFieldName("variable");
      const varSym = variable === null ? null : resolveVarRef(variable, ctx);
      if (varSym !== null && sameDeclaration(varSym, targetSym)) return "loop-condition-target";
    }
    cur = cur.parent;
  }
  for (const parts of enclosingExitParts(node, ctx)) {
    for (const ident of conditionIdentifiers(parts, ctx)) {
      const identSym = resolveVarRef(ident, ctx);
      if (identSym !== null && sameDeclaration(identSym, targetSym)) {
        return "loop-condition-target";
      }
    }
  }
  return byNameRefusal(node, byName, ctx, bindingOf(targetSym.node));
}

/**
 * R-458: what a resolved or unresolved target's name is bound to, as far as an implicit record can
 * take it over. "none": no declaration (a field of an implicit record or `with` subject, or a name
 * nothing declares). "global": an object-level variable, which an implicit record's field shadows
 * in some scopes (R294). "local": a local, a parameter, or a resolved member receiver, which only a
 * `with` subject's field shadows.
 */
type Binding = "none" | "global" | "local";

function bindingOf(declaration: ALSyntaxNode): Binding {
  for (let p = declaration.parent; p !== null; p = p.parent) if (isScope(p)) return "local";
  return "global";
}

/**
 * R-458: refuse when a loop condition reads the target by NAME through any record the target's
 * name can bind to here: every enclosing `with` subject, then (unless the target is a local) the
 * implicit records. Each candidate goes to R-364's matcher as `implicitReceiver`, so a plain
 * target also matches `<candidate>.<name>` and a target on the candidate matches a plain read.
 * A conservative list: a candidate without such a field costs an over-refusal, never a hang.
 */
function byNameRefusal(
  node: ALSyntaxNode,
  target: NameTarget,
  ctx: SemanticContext,
  binding: Binding,
): HangCapableReason | null {
  const candidates = [
    ...withSubjectsAt(node),
    ...(binding === "local" ? [] : implicitRecordsAt(node, ctx, binding)),
  ];
  return candidates.some((c) =>
    loopConditionReadsByName(node, { ...target, implicitReceiver: c }, ctx),
  )
    ? "loop-condition-target"
    : null;
}

/**
 * Every `with` whose BODY holds `node`, innermost first, to the procedure or trigger boundary. Inside
 * `with R do` a bare name binds R's field before any variable (`types.ts` `insideWithBody`), and an
 * outer subject's field when no inner one has it. A subject that is not a plain name gives "", which
 * pairs with no qualified read but still matches a plain one.
 */
function withSubjectsAt(node: ALSyntaxNode): string[] {
  const out: string[] = [];
  for (let p = node.parent; p !== null && !isScope(p); p = p.parent) {
    if (p.rawKind !== "with_statement") continue;
    const body = p.childForFieldName("body");
    if (body === null || node.startIndex < body.startIndex || node.endIndex > body.endIndex)
      continue;
    const subject = p.childForFieldName("record");
    out.push(subject !== null && isIdentifierLike(subject) ? subject.text : "");
  }
  return out;
}

/**
 * The implicit records a bare name at `node` can bind to, per R294's measured rules (`types.ts`
 * `implicitRecordShadowsGlobals`): `Rec` in a pageextension, a page with a `SourceTable`, a TableNo
 * codeunit's `OnRun`, a request page with a `SourceTable` (or any reportextension request page); the
 * name of EVERY enclosing report dataitem (an outer dataitem's field is visible too) and a
 * reportextension `modify(X)`'s X. In a table or tableextension `Rec` too, but only for a name with
 * no declaration: there a global wins over the field (R294).
 *
 * Known ceiling: in a reportextension `modify(Line)` the BASE report's outer dataitems are not
 * candidates, because the base report's structure is not read.
 */
function implicitRecordsAt(node: ALSyntaxNode, ctx: SemanticContext, binding: Binding): string[] {
  const out: string[] = [];
  let scope: ALSyntaxNode | null = null;
  for (let p = node.parent; p !== null; p = p.parent) {
    if (scope === null && isScope(p)) scope = p;
    switch (p.rawKind) {
      case "report_dataitem": {
        const name = p.childForFieldName("name");
        if (name !== null) out.push(name.text);
        continue;
      }
      case "modify_modification": {
        const name = p.childForFieldName("target");
        if (name !== null) out.push(name.text);
        continue;
      }
      case "requestpage_section":
        return hasProperty(p, "SourceTable", ctx) ||
          p.parent?.parent?.rawKind === "reportextension_declaration"
          ? [...out, "Rec"]
          : out;
    }
    switch (p.kind) {
      case ALNodeKind.pageextension:
        return [...out, "Rec"];
      case ALNodeKind.page:
        return hasProperty(p, "SourceTable", ctx) ? [...out, "Rec"] : out;
      case ALNodeKind.codeunit: {
        const onRun =
          scope !== null &&
          scope.kind === ALNodeKind.trigger &&
          normalizeAlName(scope.childForFieldName("name")?.text ?? "") === "onrun";
        return onRun && hasProperty(p, "TableNo", ctx) ? [...out, "Rec"] : out;
      }
      case ALNodeKind.table:
      case ALNodeKind.tableextension:
        return binding === "none" ? [...out, "Rec"] : out;
      case ALNodeKind.report:
        return out;
    }
    if (p.rawKind === "reportextension_declaration") return out;
  }
  return out;
}

/**
 * Does the object declare property `name`, including inside a member-level `#if`? A property in an
 * arm the build compiles out is absent; an undecided file, or no arm map, counts it as present (the
 * safe direction for a hang refusal: a candidate too many costs a site).
 */
function hasProperty(objectNode: ALSyntaxNode, name: string, ctx: SemanticContext): boolean {
  const want = normalizeAlName(name);
  const found = (m: ALSyntaxNode): boolean => {
    if (m.kind === ALNodeKind.property) {
      const n = m.childForFieldName("name");
      return n !== null && normalizeAlName(n.text) === want && armOfNode(ctx, m) !== "inactive";
    }
    return m.rawKind.startsWith("preproc_") && m.namedChildren.some(found);
  };
  return declarationMembers(objectNode).some(found);
}

/**
 * The hang-capable reason for the site an OPERATOR is mutating, or null.
 *
 * `classifyHangCapable` answers about an assignment statement. Only one of the four operators that
 * need an answer mutates one: `shift-integer`, `swap-additive` and `flip-boolean-literal` all
 * mutate a node inside an assignment's right-hand side. This walks out to the enclosing assignment
 * and asks about that, because the value written is what an enclosing loop's condition reads.
 *
 * One refusal here is deliberate and load-bearing: a node inside the assignment's `left` field is
 * part of the target expression rather than a value written to the target, so an operator mutating
 * the target itself gets no tag from this (test: "DECLINES the target identifier on the
 * assignment's left"). The `SCOPE_KINDS` check inside the walk below is NOT that kind of guard:
 * see the comment on it.
 *
 * Containment is tested by POSITION rather than by node identity, for the reason recorded in
 * [[R209]]: `resolveVarRef` returns freshly built `VarSymbol` objects for trigger-local variables,
 * and the AST wrapper nodes are reconstructed on access, so reference equality is not reliable
 * here. Positions are unique within a file, and this walk never leaves one.
 */
export function hangCapableForMutatedNode(
  node: ALSyntaxNode,
  ctx: SemanticContext,
): HangCapableReason | null {
  // R487 blanket rule: every site the hang-capable operators mutate inside an OPEN data item's code
  // (its triggers, its child items' triggers and columns, a reportextension dataset block anchored
  // on it) or in a same-object procedure reachable from that code is refused, whatever it writes
  // or reads.
  if (inOpenItemCode(node, ctx)) return "loop-condition-target";
  if (node.kind === ALNodeKind.assignment_statement) return classifyHangCapable(node, ctx);

  let cur: ALSyntaxNode | null = node.parent;
  while (cur !== null) {
    if (cur.kind === ALNodeKind.assignment_statement) {
      const right = cur.childForFieldName("right");
      if (right === null) return null;
      // A `#if` tail of the value (`Done := Go` `#if X and true #endif` `;`) sits BESIDE `right`,
      // the shape `conditionIdentifiers` reads for a loop condition, so it is value side too.
      const valueParts = [
        right,
        ...cur.namedChildren.filter((c) => c.rawKind === "preproc_conditional_expression_tail"),
      ];
      const insideValueSide = valueParts.some(
        (v) => node.startIndex >= v.startIndex && node.endIndex <= v.endIndex,
      );
      return insideValueSide ? classifyHangCapable(cur, ctx) : null;
    }
    // Early exit, not a guard that changes any answer: this walk climbs `.parent` pointers only,
    // so it can never descend into a sibling procedure's subtree to begin with, the same reason
    // `sameDeclaration`'s docstring gives (above) for `classifyHangCapable`'s identically shaped
    // walk. Without this line the loop would keep climbing to the file root and return the same
    // null, just after more hops. No test in this file can tell its presence from its absence.
    if (isScope(cur)) return null;
    cur = cur.parent;
  }
  return null;
}
