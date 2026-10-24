import {
  ALNodeKind,
  type ALSyntaxNode,
  type HangCapableReason,
  type ObjectSymbol,
  type SemanticContext,
  argumentList,
  argumentsReadable,
  armOfNode,
  declarationMembers,
  declarationStateAt,
  declaredNames,
  enclosingTrigger,
  fieldSegments,
  identifierTokens,
  isObjectContainer,
  isProcedureLike,
  lastFieldChild,
  maskAlNonCode,
  normalizeAlName,
  objectDeclarationsOf,
  procedureLikeArmNames,
  qualifiedObjectName,
  rawArmOf,
  recordTableObjectOfName,
  resolveReceiverTable,
  resolveVarRef,
  tableObjectOfRef,
  triggerLocalNames,
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
 * that code reaches by name.
 *
 * R500 (closed) took R487's exclusions shape by shape, at the dispatch check only:
 * - a `Date` item is open unless `MaxIteration` bounds it (shape 4), and an XMLport `tableelement`
 *   over `Integer` is a loop item like a report data item (shape 5; dormant while xmlport cannot
 *   carry the selector var, but it seeds shape 2);
 * - procedures in OTHER objects that open-item code calls, one hop (`inOneHopCallee`, shape 2);
 * - a filter call on an open item's record from outside its code (`altersOpenItemFilter`, 5b);
 * - an unparsed reportextension extends every report (shape 7); `CurrReport.P()` and a bare
 *   procedure name in an expression are calls (`hiddenCallee`, shape 9);
 * - a stated LIMIT, with its blind spots in its own comment: a write, before the item, of a
 *   global the item's exit reads (`writesPresetExitName`, shape 1);
 * - an item that inserts into its own table (shape 3): its OnPreDataItem filter
 *   (`altersSelfInsertFilter`), and, since R530 (`inSelfInsertItem`), (a) every site in its triggers
 *   and the helpers they reach, (b) the writers, outside that scope, of any name an exit guard in it
 *   reads (an assignment, or any call passing the name), (c) an outside filter call on it
 *   (`altersOpenItemFilter`). Not seen: an insert made in another object (R529, closed by ruling), a
 *   bound set only by a reportextension `modify()` trigger, a `with` receiver (measure.md, R530);
 * Two RULINGS: a reportextension outside the project cannot reach this project's open items (its
 * code is not in the run), and a `while`/`repeat` inside a BOUNDED item's code keeps
 * the product-wide loop rules only (shape 8): R196/R446/R480, R531's consuming loop, and R570's
 * cursor-shaped callee in another object, which apply inside report items as anywhere else.
 *
 * R501 (closed): the same scope now refuses EVERY operator, not only the four, through ONE check
 * the orchestrator asks at dispatch (`openItemHangRefuses`, no operator list, no exemption): the
 * condition-side mutants, the exit's own removal, and `loop-skip`/`loop-truncate` of an inner loop
 * the item's progress lives in. It also refuses the BOUND CLASS: any site that deletes or alters
 * (contains, or sits inside) the SetRange call that is a certified item's only bound
 * (`altersBoundCall`). R500's additions above are asked through the same check, for every operator.
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
      if (isLoopItem(p) && itemOpen(p, ctx)) return true;
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
 *  list on the context): yes, the safe direction. An item an extension adds is not extended.
 *  R565: a dependency report's context (`allReportsExtended`) answers yes for every report. */
function reportExtended(item: ALSyntaxNode, ctx: SemanticContext): boolean {
  const report = objectOf(item);
  if (report === null || report.rawKind !== "report_declaration") return false;
  const files = ctx.files;
  if (files === undefined || ctx.allReportsExtended === true) return true;
  let names = extendedReports.get(ctx);
  if (names === undefined) {
    names = new Set();
    for (const f of files) {
      for (const o of objectDeclarationsOf(f.root)) {
        if (o.rawKind !== "reportextension_declaration") continue;
        names.add(extendedBaseName(o) ?? ANY_REPORT);
      }
    }
    // R500 shape 7: a reportextension the grammar could not parse (inside an ERROR node, or with a
    // `#if`-split header) names no readable base: it counts as extending every report.
    for (const u of [...ctx.symbols.unparsedObjects, ...ctx.symbols.splitObjects]) {
      if (/\breportextension\b/i.test(u.text)) names.add(ANY_REPORT);
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

/** R500: a loop BC drives over a table: a report data item, or an XMLport `tableelement`. */
function isLoopItem(n: ALSyntaxNode): boolean {
  if (n.rawKind === "report_dataitem") return true;
  return (
    n.rawKind === "xmlport_element" &&
    /^tableelement/i.test(n.childForFieldName("element_type")?.text ?? "")
  );
}

/** The item's table, by its LAST name segment (a qualified `System.Utilities.Integer` has one child
 *  per segment): `table_name` on a report data item, `source` on an XMLport element. */
function itemTable(item: ALSyntaxNode): string {
  const field = item.rawKind === "report_dataitem" ? "table_name" : "source";
  return normalizeAlName(lastFieldChild(item, field)?.text ?? "");
}

function isIntegerItem(item: ALSyntaxNode): boolean {
  return itemTable(item) === "integer";
}

/** R500 shape 4: a report `Date` item. BC drives it like `Integer`, over every date of every period
 *  type; no `Number` certificate applies, so only `MaxIteration` bounds it. */
function isDateItem(item: ALSyntaxNode): boolean {
  return item.rawKind === "report_dataitem" && itemTable(item) === "date";
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

/**
 * R500 shape 9: a same-object call `bareCallee` does not see. `CurrReport.P()` / `CurrXMLport.P()`
 * naming a procedure of this object, and a bare name in an expression (`if IsOk then`, `X := GetVal;`)
 * that names one and does not resolve to a variable. A name that is not really a call only adds a
 * name to the reach set: an extra refusal, the safe direction.
 */
function hiddenCallee(
  n: ALSyntaxNode,
  names: ReadonlySet<string>,
  ctx: SemanticContext,
): string | null {
  if (n.rawKind === "call_expression" || n.rawKind === "call_statement") {
    const f = n.childForFieldName("function");
    if (f === null || f.rawKind !== "member_expression") return null;
    const o = normalizeAlName(f.childForFieldName("object")?.text ?? "");
    const m = normalizeAlName(f.childForFieldName("member")?.text ?? "");
    return (o === "currreport" || o === "currxmlport") && names.has(m) ? m : null;
  }
  if (!isIdentifierLike(n) || !names.has(normalizeAlName(n.text))) return null;
  if (n.fieldName === "function" || n.fieldName === "name" || n.fieldName === "member") return null;
  if (n.parent === null || n.parent.rawKind === "member_expression") return null;
  if (codeScope(n) === null || resolveVarRef(n, ctx) !== null) return null;
  return normalizeAlName(n.text);
}

/** Same-object procedures reachable (by name, transitively) from open-item code. */
function openReachable(obj: ALSyntaxNode, ctx: SemanticContext): Set<string> {
  return cached(ctx, obj, "reach", () => {
    const calls: { readonly callee: string; readonly scope: ALSyntaxNode | null }[] = [];
    const names = procedureNamesOf(obj, ctx);
    visitAll(obj, (n) => {
      const callee = bareCallee(n) ?? hiddenCallee(n, names, ctx);
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
  if (isDateItem(item)) return !maxIterationBounded(item, ctx);
  if (!isIntegerItem(item)) return false;
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
    if ((p === "dataitemtableview" || p === "sourcetableview") && viewBoundsNumber(m))
      viewBounded = true;
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
    if (
      p.kind === ALNodeKind.report ||
      p.rawKind === "reportextension_declaration" ||
      p.rawKind === "xmlport_declaration"
    ) {
      break;
    }
  }
  const mentions: ALSyntaxNode[] = [];
  visitAll(scope, (n) => {
    if (!isIdentifierLike(n) || normalizeAlName(n.text) !== name) return;
    if (
      n.fieldName === "name" ||
      n.fieldName === "table_name" ||
      // R500: an XMLport element's source table, not a mention (only under `xmlport_element`)
      (n.fieldName === "source" && n.parent?.rawKind === "xmlport_element") ||
      n.fieldName === "member"
    ) {
      return;
    }
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
  return certifiedCall(scan, name, triggers, ctx) !== null;
}

/** The call `certified` accepts, or null. R501: the one bound such an item has, so a mutant that
 *  deletes or alters it unbounds the item (`altersBoundCall`). */
function certifiedCall(
  scan: MentionScan,
  name: string,
  triggers: ALSyntaxNode[],
  ctx: SemanticContext,
): ALSyntaxNode | null {
  const { mentions, calls } = scan;
  if (mentions.length + calls.length !== 1) return null;
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
    if (member === null || outer === null || member.rawKind !== "member_expression") return null;
    const obj = member.childForFieldName("object");
    const fn = outer.childForFieldName("function");
    if (obj === null || !samePos(obj, m) || fn === null || !samePos(fn, member)) return null;
    call = outer;
    trigger =
      triggers.find((t) => t.startIndex <= outer.startIndex && outer.endIndex <= t.endIndex) ??
      null;
  }
  if (call === null || trigger === null || call.rawKind !== "call_expression") return null;
  return rangeCallOf(call, name)?.literal === true &&
    (triggerName(trigger) === "onpredataitem" || triggerName(trigger) === "onprexmlitem") &&
    armOfNode(ctx, call) === "active" &&
    unconditional(call, trigger)
    ? call
    : null;
}

/**
 * R501: the SetRange call that is an `Integer` item's ONLY bound (the single-mention certificate, no
 * `MaxIteration`), or null. A view-bounded item has zero mentions, so it has no such call. Reads the
 * symbol table (through `itemOpen`'s `modifiedItemOpen`) and `ctx.files` (through `reportExtended`).
 * `openItemHangRefuses` throws on a context without `files` (R500) before this is asked.
 */
function onlyBoundCall(item: ALSyntaxNode, ctx: SemanticContext): ALSyntaxNode | null {
  return cached(ctx, item, "boundcall", () => {
    if (!isIntegerItem(item) || maxIterationBounded(item, ctx) || itemOpen(item, ctx)) return null;
    const body = item.childForFieldName("body");
    if (body === null) return null;
    const name = normalizeAlName(item.childForFieldName("name")?.text ?? "");
    const triggers = itemMembers(body, ctx).filter((m) => m.kind === ALNodeKind.trigger);
    return certifiedCall(mentionScan(item, name, triggers), name, triggers, ctx);
  });
}

/**
 * R501: does the site at `node` delete or alter the only bound of its nearest enclosing data item?
 * It CONTAINS the call (`void-method-call` or `remove-setrange` on it, `empty-block` of a block
 * holding it) or lies INSIDE it (an operator on one of its arguments).
 */
function altersBoundCall(node: ALSyntaxNode, ctx: SemanticContext): boolean {
  let item: ALSyntaxNode | null = null;
  for (let p = node.parent; p !== null && item === null; p = p.parent) {
    if (isLoopItem(p)) item = p;
  }
  if (item === null) return false;
  const call = onlyBoundCall(item, ctx);
  if (call === null) return false;
  const contains = node.startIndex <= call.startIndex && call.endIndex <= node.endIndex;
  const inside = call.startIndex <= node.startIndex && node.endIndex <= call.endIndex;
  return contains || inside;
}

/**
 * R501: the ONE dispatch-level hang refusal. The orchestrator asks it for EVERY operator that
 * targets a site, with no exemption list and no environment read. It holds when the site is in
 * open-item code (`inOpenItemCode`, R487's scope), or deletes or alters a bounded item's only bound
 * (`altersBoundCall`). `loop-truncate` and `loop-skip` are refused too: they shorten the INNER loop,
 * and in an open item the item's own progress often lives in that inner loop (a skipped `while`
 * never sets the flag the item's Break reads). R500 adds the one-hop callees, the outside filter
 * calls and the two LIMITS (header). It needs `ctx.files` and throws without it.
 *
 * R-696 adds loops that move the record they walk (`inMovedWalk`): a Rename, Insert or key-field
 * ModifyAll by any non-temporary variable of the walked table, or a key-changing Modify by a second one.
 *
 * R-531 adds loops that end only by consuming their record set (`consumingLoopRefuses`). `op` is
 * the operator's name and is REQUIRED: that rule exempts `lethal.swap-find-direction` inside the
 * loop's own condition, and a caller that passes `undefined` gets no exemption (the safe default).
 */
export function openItemHangRefuses(
  node: ALSyntaxNode,
  ctx: SemanticContext,
  op: string | undefined,
): boolean {
  projectObjects(ctx); // R500: throws on a context without `files`, whatever the site
  return (
    inOpenItemCode(node, ctx) ||
    altersBoundCall(node, ctx) ||
    inOneHopCallee(node, ctx) ||
    inR570Callee(node, ctx) ||
    inR572Guard(node, ctx) ||
    altersSelfInsertFilter(node, ctx) ||
    inSelfInsertItem(node, ctx) ||
    inMovedWalk(node, ctx) ||
    altersOpenItemFilter(node, ctx) ||
    writesPresetExitName(node, ctx) ||
    consumingLoopRefuses(node, ctx, op)
  );
}

/*
 * R-531: a loop that ends only by CONSUMING its record set.
 *
 * THE SHAPE. A `while`/`repeat` (`LOOP_KINDS`; never a `for`) whose condition calls a cursor method (`Find`,
 * `FindFirst`, `FindLast`, `FindSet`, `IsEmpty`, `Count`; called or bare) on a record R and does NOT
 * call `Next`, and whose body holds at least one CONSUMER of R. `repeat ... until R.Next() = 0` is
 * never this shape: `Next` advances whatever the body does. Receivers compare by name (`Rec` and a
 * bare call are the implicit record; a non-identifier receiver such as `Buf[1]` by its text).
 *
 * THE CONSUMERS, by kind label (`r531Analyze(...).kinds`):
 * - `delete`, `deleteall`, `rename`: those methods on R;
 * - `refilter`: `SetRange`/`SetFilter` on R inside the loop;
 * - `mark`: a filter- or mark-changing method on R (Reset, Copy, CopyFilter(s), SetView, SetRecFilter,
 *   FilterGroup, Mark, MarkedOnly, ClearMarks);
 * - `modify-filtered`: `Modify`/`ModifyAll` on a plain local R after a write (`R.F :=` or
 *   `R.Validate(F, ...)`) of a field a `SetRange`/`SetFilter` on R in the procedure names, the write
 *   included; `modify-all`: the same when R is a global, a parameter or the implicit Rec (its filters
 *   can be set elsewhere), so EVERY written field counts; `modify-unseen`: no filter on R in the
 *   procedure, so every written field counts;
 * - `delete-reinsert`: a consumer plus an `Insert` of R with a filtered field written in the body (a
 *   rename by hand), the writes included;
 * - unknown, counted as consuming: `pass-rec` (a call passing R, not `Format`/`Message`/`Error`/
 *   `StrSubstNo`/`Confirm`/`Clear`/`Evaluate` nor a built-in method of another record), `recv-proc`
 *   (a call on R that is not a built-in record method: a table procedure, a `Dequeue`), `global-call`
 *   (a same-object procedure call while R is a global or the implicit Rec);
 * - `alias`: a consumer on a same-procedure ALIAS of R (`X := R`, `R := X`, `X.Copy(R, S)`,
 *   `R.Copy(X, S)` or a bare `Copy(X, S)` on the implicit Rec, where `S` is anything but the literal
 *   `false`; to a fixpoint, by name), which counts as R everywhere above.
 *
 * REFUSED, for every operator (owner rulings 2026-10-09: refusal only; no exemption for an `or`
 * operand that is not a cursor test, so a counter in such an `or` is a known false positive):
 * - BASE, inside the loop body: a site inside a consumer, a site containing one (its statement or
 *   block, `empty-block` of the body or a branch, `loop-skip`/`loop-truncate` of an inner loop
 *   holding it), and a site in a guard between a consumer, or a `continue` of this loop, and the loop
 *   (R446's `exitGuards`). Not an `exit`/`break`/`Error` (each ENDS the loop) nor a site after it.
 * - NEG, inside the loop's own condition: every operator but `lethal.swap-find-direction` (which
 *   swaps only FindFirst/FindLast, both "is the set non-empty"); `remove-not` on `not R.IsEmpty()`
 *   or `conditional-boundary` on `Count > 0` leaves the test true on an exhausted set.
 * - FILTER, before the loop in the same scope: every site inside a `SetRange`/`SetFilter` on R whose
 *   field the consumer changes (a write before `Modify` or a re-`Insert`, a `ModifyAll` field), or any
 *   such filter when the consumer is a `Rename` (its key fields are unknown without the table's key):
 *   `swap-rec-xrec` on an OnRename `SetRange(.., xRec.Name)` finds the renamed lines for ever. Also a
 *   pre-loop `MarkedOnly` on R when a consumer is `Mark(...)`.
 * - FEEDS: a same-scope assignment whose target name is read, to a fixpoint, by a consumer's
 *   arguments, a consumer write's right side, a consumer's guard, a pre-loop filter's arguments or a
 *   guard around a pre-loop filter call (R480's by-name `indirectFeeds` rule over the scope); and
 *   those guards around a pre-loop filter call.
 * - HOP, one hop into a same-object callee, EVERY overload whose parameter count fits the call
 *   (R564: only the one the argument types choose, when that is certain, see `r531ProcsIn`): for
 *   `pass-rec`, the callee's parameter at R's argument position; for `global-call`, the same global
 *   R (unless the callee declares a local of that name) or the implicit Rec; for `recv-proc`, the
 *   table procedure on R (`r531TableProcs`: `declaredType` + `objectsOfType`, else the table the
 *   engine binds: `Rec.P()`, or a bare `P()` that names no same-object procedure but a project table
 *   procedure of the implicit Rec in a table, tableextension or SourceTable page; R-562 build
 *   review), where R is the implicit Rec. The callee's
 *   consumers, the sites containing them and their guards are refused. A BY-VALUE Record parameter
 *   copies the variable, not the table: its Delete, DeleteAll, Rename and Modify (with its writes)
 *   are followed, its refilter, mark and unknown consumers are not (they change only the copy). A
 *   temporary record passed by value is treated the same way (its table sharing is unmeasured).
 * - FILTER HOP (R562), for a loop whose ending depends on a filter: every call in the scope that ENDS
 *   before the loop and is a table procedure on R (`R.SetFilters()`, `Rec.SetFilters()`, or a bare
 *   `SetTemplateFilter(xRec)` on the implicit Rec in a tableextension or SourceTable page, through
 *   `r531TableProcs`), a same-object procedure that sees R (global-call), passes R to a VAR parameter
 *   of a same-object procedure, or passes R to a VAR parameter of a project codeunit or table
 *   procedure, is followed one hop (every overload that fits by arity, narrowed by argument type as
 *   in HOP); so is `Codeunit.Run(X, R)` or
 *   `CU.Run(R)` into a project codeunit with a `TableNo`, whose OnRun's Rec is taken to BE R (ASSUMED:
 *   that Codeunit.Run passes its record by reference is not measured). A by-value Record is not
 *   followed: its filters are the copy's. In the
 *   callee, a `SetRange`/`SetFilter` on R passing FILTER's dependency test (and `MarkedOnly` for a
 *   `Mark` consumer) is refused with its containing sites and its guards, and so are the callee's
 *   `exit`s and raised `Error`s that start before its last such filter, with their guards (taking one
 *   skips the filter). The call itself joins the pre-loop filters (its sites, guards and FEEDS). A
 *   call that CANNOT be followed (a procedure on R not in the project, a same-object name with no
 *   overload of that arity taking R, R passed into an object outside the project) is refused the
 *   same way, the call only; `RecordRef.SetTable(R)` (it writes R) is refused that way too. Not calls:
 *   built-in record methods, `GetTable`, `Codeunit.Run` of anything but a project TableNo codeunit,
 *   `Page`/`Report`/`XmlPort`/`Query` runs and the pure functions above.
 *
 * LIMITS (stated): cross-object callees outside FILTER HOP, DotNet callees, more than one hop, event
 * subscribers (an empty publisher reads as setting no filter), a filter set on another variable then
 * moved with `CopyFilters`/`SetView`, a call between nested loops, the FILTER HOP callee's own FEEDS,
 * overloads chosen by arity wherever their argument types do not settle the choice (R564), comment
 * nodes counted as arguments (R567), and a refilter through a FieldRef. A bare name
 * that resolves to no project table procedure is neither followed nor refused (it cannot be told
 * from a global function such as `Commit`), nor is one in a pageextension (its Rec's table is not
 * resolved). The implicit Rec of a `with` subject or a report data item binds through the same
 * resolver (`resolveReceiverTable`).
 */
const R531_COND: ReadonlySet<string> = new Set([
  "find",
  "findfirst",
  "findlast",
  "findset",
  "isempty",
  "count",
]);
const R531_DEL: ReadonlySet<string> = new Set(["delete", "deleteall", "rename"]);
const R531_MOD: ReadonlySet<string> = new Set(["modify", "modifyall"]);
const R531_FILTER: ReadonlySet<string> = new Set(["setrange", "setfilter"]);
/** Filter- and mark-changing record methods: consumers of kind `mark` (checked before the built-ins). */
const R531_MARKS: ReadonlySet<string> = new Set(
  "reset copy copyfilter copyfilters setview setrecfilter filtergroup mark markedonly clearmarks".split(
    " ",
  ),
);
/** Built-in record methods that cannot consume the set (anything else on R is unknown). */
const R531_BUILTIN: ReadonlySet<string> = new Set(
  (
    "setrange setfilter reset get getbysystemid find findfirst findlast findset next isempty count " +
    "countapprox calcfields calcsums testfield validate init insert transferfields copy copyfilter " +
    "copyfilters setcurrentkey currentkey setautocalcfields setloadfields addloadfields areloadfields " +
    "fieldno fieldcaption fieldname tablecaption tablename getfilter getfilters getrangemin getrangemax " +
    "locktable mark marked markedonly clearmarks hasfilter filtergroup ascending getposition " +
    "setposition recordid setrecfilter readisolation istemporary setpermissionfilter fieldactive " +
    "fielderror relation readpermission writepermission consistent changecompany currentcompany " +
    "systemid recordlevellocking securityfiltering getview setview haslinks copylinks " +
    "deletelinks addlink deletelink truncate isdirty setascending"
  ).split(" "),
);
/** Global functions that take a record but cannot consume it. */
const R531_PURE: ReadonlySet<string> = new Set(
  "format strsubstno message error confirm clear evaluate".split(" "),
);
const SWAP_FIND_DIRECTION = "lethal.swap-find-direction";

/** A consumer found one hop away, in a same-object callee or a table procedure on R. */
export interface R531Hop {
  readonly proc: ALSyntaxNode;
  readonly consumers: ALSyntaxNode[];
  readonly guards: ALSyntaxNode[];
}

/** A loop of the R-531 shape (see the block comment above). */
export interface R531Loop {
  readonly loop: ALSyntaxNode;
  /** The consumer kind labels, sorted and distinct. */
  readonly kinds: string[];
  readonly consumers: ALSyntaxNode[];
  readonly guards: ALSyntaxNode[];
  /** Pre-loop filter (and `MarkedOnly`) calls the loop's ending depends on. */
  readonly preFilters: ALSyntaxNode[];
  /** Same-scope assignments feeding consumers, guards and pre-loop filters. */
  readonly feeds: ALSyntaxNode[];
  /** Conditions around a pre-loop filter call, up to the scope. */
  readonly preGuards: ALSyntaxNode[];
  readonly hops: R531Hop[];
}

interface R531Call {
  readonly recv: string | null; // null: bare (the implicit record, or a procedure)
  readonly method: string;
  /** `argumentList`: comments are not arguments (R567) */
  readonly args: readonly ALSyntaxNode[];
  /** R567: a `#pragma` (or other non-comment trivia) sits among the arguments, so a position is
   *  not an argument's position. Every reader then takes the direction that refuses MORE: any
   *  arity, every parameter, any field (`r531Field`). */
  readonly uncertain: boolean;
}

/** The field a filter/`Validate`/`ModifyAll` call names in its first argument; `"*"` (any field)
 *  when the arguments cannot be read by position (R567). */
const r531Field = (c: R531Call): string | null => {
  if (c.uncertain) return "*";
  const f = c.args[0];
  return f === undefined ? null : normalizeAlName(f.text);
};

/** Does a field set hold `field`, either side being `"*"` (any field)? */
const r531Has = (s: ReadonlySet<string>, field: string): boolean =>
  s.has("*") || field === "*" || s.has(field);

/** A receiver's key: its normalized name (`Rec` is ""), or its whitespace-free text when it is not
 *  a plain name (`Buf[1]`). */
const r531Key = (n: ALSyntaxNode | null): string | null => {
  if (n === null) return null;
  if (!isIdentifierLike(n)) return `\u0001${n.text.replace(/\s+/g, "").toLowerCase()}`;
  const k = normalizeAlName(n.text);
  return k === "rec" ? "" : k;
};

function r531Call(n: ALSyntaxNode): R531Call | null {
  const argsOf = (recv: string | null, method: string): R531Call => ({
    recv,
    method,
    args: argumentList(n),
    uncertain: !argumentsReadable(n),
  });
  if (n.rawKind === "call_expression") {
    const f = n.childForFieldName("function") ?? n.namedChildren[0] ?? null;
    if (f === null) return null;
    if (isIdentifierLike(f)) return argsOf(null, normalizeAlName(f.text));
    if (f.rawKind === "member_expression") {
      const m = f.childForFieldName("member");
      if (m === null) return null;
      const o = f.childForFieldName("object");
      return argsOf(r531Key(o) ?? "\u0000", normalizeAlName(m.text));
    }
    return null;
  }
  if (n.rawKind === "call_statement") {
    const f = n.namedChildren[0] ?? null;
    if (f === null || !isIdentifierLike(f)) return null;
    return argsOf(null, normalizeAlName(f.text));
  }
  if (n.rawKind === "member_expression" && n.parent?.rawKind !== "call_expression") {
    const m = n.childForFieldName("member");
    const o = r531Key(n.childForFieldName("object"));
    if (m === null || o === null) return null;
    return { recv: o, method: normalizeAlName(m.text), args: [], uncertain: false };
  }
  return null;
}

/** Is a bare name an implicit-Rec member (no declared variable of that name)? */
function r531Implicit(n: ALSyntaxNode, ctx: SemanticContext): boolean {
  const f = n.rawKind === "call_expression" ? n.childForFieldName("function") : n;
  return f !== null && resolveVarRef(f, ctx) === null;
}

/** Procedure names declared in the object holding `n`. */
function r531ObjectProcs(n: ALSyntaxNode, ctx: SemanticContext): Set<string> {
  const obj = objectOf(n);
  if (obj === null) return new Set();
  return cached(ctx, obj, "r531procs", () => {
    const out = new Set<string>();
    visitAll(obj, (x) => {
      if (isProcedureLike(x)) for (const p of procNames(x)) out.add(p);
    });
    return out;
  });
}

/** Is `name` declared in `scope`'s header: a local variable, or (with `params`) a parameter? */
function r531Declares(scope: ALSyntaxNode | null, name: string, params: boolean): boolean {
  if (scope === null || name === "") return false;
  let hit = false;
  const walk = (n: ALSyntaxNode): void => {
    for (const c of n.namedChildren) {
      if (hit) return;
      if (c.rawKind === "code_block" || (!params && c.rawKind === "parameter_list")) continue;
      if (c.rawKind === "variable_declaration" || c.rawKind === "parameter") {
        // R521: every name of a multi-name declaration (`A, B: Record X`), not only the first
        const names = declaredNames(c).map(normalizeAlName);
        if (names.length === 0) {
          const id = c.namedChildren.find((x) => isIdentifierLike(x)) ?? null;
          if (id !== null) names.push(normalizeAlName(id.text));
        }
        if (names.includes(name)) hit = true;
      } else walk(c);
    }
  };
  walk(scope);
  return hit;
}

function r531Walk(n: ALSyntaxNode, ctx: SemanticContext, f: (n: ALSyntaxNode) => void): void {
  if (DIRECTIVE_MARKERS.has(n.rawKind) || armOfNode(ctx, n) === "inactive") return;
  f(n);
  for (const c of n.namedChildren) r531Walk(c, ctx, f);
}

/** Every procedure-like node named `name` in object `obj` that takes `arity` parameters, narrowed
 *  by `call`'s argument types (R564) only when the choice is certain:
 *  1. no candidate is `#if`-split (one `parameter_list`, no preprocessor node in it);
 *  2. every argument resolves to a project table (`recordTableObjectOfName`);
 *  3. every parameter of every candidate is a `Record` of a resolved project table;
 *  4. exactly one candidate has the argument's table at every position (tables compared by
 *     IDENTITY, never by spelling), so every other one differs at some position.
 *  Otherwise every overload that fits by arity is followed: a wrongly dropped overload would
 *  re-deploy a hang, a kept one only over-refuses. AL has no conversion from Record A to a
 *  `Record B` parameter, by value, `var` or `temporary` (alc probe, R-564). Narrowed per object.
 *  `arity` null (an uncertain call, R567): every procedure of that name, never narrowed (2). */
function r531ProcsIn(
  obj: ALSyntaxNode,
  name: string,
  arity: number | null,
  call: ALSyntaxNode,
  ctx: SemanticContext,
): ALSyntaxNode[] {
  const out: ALSyntaxNode[] = [];
  visitAll(obj, (x) => {
    if (
      (isProcedureLike(x) || x.rawKind === "procedure") &&
      procNames(x).includes(name) &&
      (arity === null || r531Arity(x) === arity)
    )
      out.push(x);
  });
  if (out.length < 2) return out;
  const args = (r531Call(call)?.args ?? []).map((a) =>
    isIdentifierLike(a) ? recordTableObjectOfName(a, call, ctx) : null,
  );
  if (args.length !== arity || args.some((t) => t === null)) return out; // (2)
  const params = out.map((p) => r564ParamTables(p, ctx));
  if (params.some((ts) => ts === null || ts.some((t) => t === null))) return out; // (1), (3)
  const hits = out.filter((_, i) => params[i]?.every((t, j) => t === args[j]) === true);
  return hits.length === 1 ? hits : out; // (4)
}

/** R564: the project table object of each parameter of `proc`, `null` for a parameter that is not
 *  a `Record` of exactly one project table; `null` for the whole when `proc` is `#if`-split (more
 *  than one `parameter_list`, or a preprocessor or error node anywhere outside its body). */
function r564ParamTables(proc: ALSyntaxNode, ctx: SemanticContext): (ObjectSymbol | null)[] | null {
  const lists = proc.namedChildren.filter((c) => c.rawKind === "parameter_list");
  const [list] = lists;
  if (lists.length !== 1 || list === undefined) return null;
  // `#if` inside the parentheses parses as ERROR siblings of the first arm's parameter_list
  let split = false;
  for (const c of proc.namedChildren)
    if (c.rawKind !== "code_block")
      visitAll(c, (x) => {
        if (x.rawKind.startsWith("preproc") || x.rawKind === "ERROR") split = true;
      });
  if (split) return null;
  return list.namedChildren
    .filter((c) => c.rawKind === "parameter")
    .map((p) => {
      const rec =
        p.childForFieldName("type")?.namedChildren.find((c) => c.rawKind === "record_type") ?? null;
      if (rec === null) return null;
      const ref = qualifiedObjectName(fieldSegments(rec, "reference"), "table", ctx.symbols);
      return ref === null ? null : tableObjectOfRef(ref, ctx);
    });
}

/** HOP and FILTER HOP (shared): the project table procedures named `method` with `arity` parameters
 *  that call `n` on a record reaches: through the receiver's declared type, else through the record
 *  the engine binds (`resolveReceiverTable`): `Rec.P()`, or a bare `P()` on the implicit Rec of a
 *  table, a tableextension (the base table) or a page with a `SourceTable`. The table's
 *  tableextensions are included (`objectsOfType`). [] when the table is not in the project. */
function r531TableProcs(
  n: ALSyntaxNode,
  method: string,
  arity: number | null,
  ctx: SemanticContext,
): ALSyntaxNode[] {
  if (n.rawKind !== "call_expression") return [];
  const fn = n.childForFieldName("function");
  const recv = fn?.rawKind === "member_expression" ? fn.childForFieldName("object") : null;
  // R737: an ambiguous receiver follows every table type
  let ts = recv !== null && recv !== undefined ? declaredTypes(recv, ctx) : [];
  if (ts.length === 0) {
    const table = resolveReceiverTable(n, ctx);
    if (table !== null) ts = [{ kind: "table", name: normalizeAlName(table), temporary: false }];
  }
  return ts
    .filter((t) => t.kind === "table")
    .flatMap((t) => objectsOfType(t, ctx))
    .flatMap((o) => r531ProcsIn(o, method, arity, n, ctx));
}

/** The arity a call's candidates must have: null (any) for an uncertain call (R567). */
const r531CallArity = (c: R531Call): number | null => (c.uncertain ? null : c.args.length);

/** The parameter positions of `proc` that argument `i` of `c` may bind: `[i]`, or every one for an
 *  uncertain call (R567), so a pass-rec is never lost. */
const r531Positions = (c: R531Call, i: number, proc: ALSyntaxNode): number[] =>
  c.uncertain ? Array.from({ length: r531Arity(proc) }, (_, j) => j) : [i];

function r531Arity(proc: ALSyntaxNode): number {
  const list = proc.namedChildren.find((c) => c.rawKind === "parameter_list");
  return list?.namedChildren.filter((c) => c.rawKind === "parameter").length ?? 0;
}

/** A parameter's name keyed as `r531Key` keys a receiver: a parameter named `Rec` is `""`, which
 *  is how its `Rec.M()` calls read (R570 build review, BLOCKING 1; the same fix for R531's HOP). */
const r531ParamKey = (name: string): string => (name === "rec" ? "" : name);

/** The i-th parameter of `proc` as [name, isVar], or null. */
function r531Param(proc: ALSyntaxNode, i: number): [string, boolean] | null {
  const list = proc.namedChildren.find((c) => c.rawKind === "parameter_list");
  const p = list?.namedChildren.filter((c) => c.rawKind === "parameter")[i];
  if (p === undefined) return null;
  const id =
    p.childForFieldName("name") ?? p.namedChildren.find((x) => isIdentifierLike(x)) ?? null;
  if (id === null) return null;
  return [normalizeAlName(id.text), p.namedChildren.some((c) => c.rawKind === "var_keyword")];
}

/** HOP: the consumers of receiver `key` in callee `proc`'s body (no further hop) and their guards.
 *  `byValue`: `key` is a by-value parameter. A by-value Record copies the VARIABLE, not the table,
 *  so its Delete, DeleteAll, Rename and Modify still change the rows R's loop reads; its filters
 *  and marks are its own, so its refilter, mark and unknown consumers are not followed. */
function r531CalleeHop(
  proc: ALSyntaxNode,
  key: string,
  ctx: SemanticContext,
  byValue: boolean,
): R531Hop | null {
  const body = proc.namedChildren.find((c) => c.rawKind === "code_block") ?? null;
  if (body === null) return null;
  const procs = r531ObjectProcs(proc, ctx);
  const consumers: ALSyntaxNode[] = [];
  const writes: ALSyntaxNode[] = [];
  let modifies = false;
  r531Walk(body, ctx, (n) => {
    if (n.kind === ALNodeKind.assignment_statement) {
      const left = n.childForFieldName("left") ?? n.namedChildren[0] ?? null;
      if (
        left?.rawKind === "member_expression" &&
        r531Key(left.childForFieldName("object")) === key
      )
        writes.push(n);
      else if (
        key === "" &&
        left !== null &&
        isIdentifierLike(left) &&
        resolveVarRef(left, ctx) === null
      )
        writes.push(n);
      return;
    }
    const c = r531Call(n);
    if (c === null) return;
    const r = c.recv ?? (r531Implicit(n, ctx) && !procs.has(c.method) ? "" : null);
    if (r === key) {
      if (R531_MOD.has(c.method)) {
        modifies = true;
        consumers.push(n);
      } else if (
        R531_DEL.has(c.method) ||
        (!byValue &&
          (R531_FILTER.has(c.method) ||
            R531_MARKS.has(c.method) ||
            (!R531_BUILTIN.has(c.method) && c.recv !== null && n.rawKind === "call_expression")))
      )
        consumers.push(n);
      return;
    }
    if (byValue) return;
    if (c.args.some((a) => r531Key(a) === key && (key !== "" || normalizeAlName(a.text) === "rec")))
      if (!R531_PURE.has(c.method) && !(c.recv !== null && R531_BUILTIN.has(c.method)))
        consumers.push(n);
  });
  if (modifies) consumers.push(...writes);
  if (consumers.length === 0) return null;
  const isC = (n: ALSyntaxNode): boolean => consumers.some((c) => samePos(c, n));
  return { proc, consumers, guards: exitGuards(body, body, isC) };
}

/** Methods that set no filter on a record they are called on or passed (R562 FILTER HOP). */
const r562NotAProc = (m: string): boolean =>
  R531_BUILTIN.has(m) || R531_DEL.has(m) || R531_MOD.has(m) || m === "insert";

/** The conditions around `n`, up to `stop` (exclusive). */
function guardsUpTo(n: ALSyntaxNode, stop: ALSyntaxNode): ALSyntaxNode[] {
  const out: ALSyntaxNode[] = [];
  for (let a = n.parent; a !== null && !samePos(a, stop); a = a.parent) {
    let g: ALSyntaxNode | null = null;
    if (
      a.rawKind === "if_statement" ||
      a.rawKind === "while_statement" ||
      a.rawKind === "repeat_statement"
    )
      g = a.childForFieldName("condition");
    else if (a.rawKind === "case_statement") g = a.childForFieldName("expression");
    else if (a.rawKind === "case_branch") g = a.childForFieldName("pattern");
    if (g !== null) out.push(g);
  }
  return out;
}

/** R562 FILTER HOP (see the block comment above `R531_COND`): a pre-loop call `n` on R or passing
 *  R. Returns the hops into its callees that filter R as the loop's ending depends on, and whether
 *  the call itself is refused (a callee qualifies, or the call cannot be followed). */
function r562FilterHop(
  n: ALSyntaxNode,
  ctx: SemanticContext,
  recvs: Set<string>,
  scope: ALSyntaxNode,
  depends: Map<string, Set<string>>,
  markRecvs: Set<string>,
): { hops: R531Hop[]; refuse: boolean } {
  const none = { hops: [], refuse: false };
  const c = r531Call(n);
  const obj = objectOf(n);
  if (c === null || n.rawKind === "member_expression" || obj === null) return none;
  const arity = r531CallArity(c);
  const passed: [string, number][] = [];
  c.args.forEach((a, i) => {
    const k = r531Key(a);
    if (k !== null && recvs.has(k) && (k !== "" || normalizeAlName(a.text) === "rec"))
      passed.push([k, i]);
  });
  const targets: { proc: ALSyntaxNode; key: string; r: string }[] = [];
  // R passed into these overloads: a BY-VALUE copy's filters never reach the caller's R
  const passInto = (ps: ALSyntaxNode[]): void => {
    for (const p of ps)
      for (const [k, i] of passed)
        for (const j of r531Positions(c, i, p)) {
          const prm = r531Param(p, j);
          if (prm?.[1]) targets.push({ proc: p, key: prm[0], r: k });
        }
  };
  const bodyOf = (p: ALSyntaxNode): ALSyntaxNode | null =>
    p.namedChildren.find((x) => x.rawKind === "code_block") ?? null;
  const fn = n.rawKind === "call_expression" ? n.childForFieldName("function") : null;
  const recvNode = fn?.rawKind === "member_expression" ? fn.childForFieldName("object") : null;
  let unresolved = false;
  // a bare name that is not a same-object procedure, on the implicit Rec of a table, tableextension
  // or SourceTable page: a table procedure on R when the project declares one
  const bareRec =
    c.recv === null &&
    recvs.has("") &&
    !r531ObjectProcs(n, ctx).has(c.method) &&
    !r562NotAProc(c.method) &&
    r531Implicit(n, ctx)
      ? r531TableProcs(n, c.method, arity, ctx)
      : [];
  if (c.recv !== null && recvs.has(c.recv)) {
    // recv-proc: a table procedure on R, where R is the implicit Rec
    if (r562NotAProc(c.method) || n.rawKind !== "call_expression") return none;
    for (const p of r531TableProcs(n, c.method, arity, ctx))
      targets.push({ proc: p, key: "", r: c.recv });
    unresolved = !targets.some((t) => bodyOf(t.proc) !== null) || r737Partial(n, ctx);
  } else if (bareRec.length > 0) {
    for (const p of bareRec) targets.push({ proc: p, key: "", r: "" });
  } else if (c.recv === null && r531ObjectProcs(n, ctx).has(c.method)) {
    // global-call (R a global the callee does not shadow, or the implicit Rec) and pass-rec
    const ps = r531ProcsIn(obj, c.method, arity, n, ctx);
    for (const p of ps)
      for (const r of recvs)
        if (r === "" || (!r531Declares(scope, r, true) && !r531Declares(p, r, true)))
          targets.push({ proc: p, key: r, r });
    passInto(ps);
    unresolved = passed.length > 0 && ps.length === 0;
  } else {
    // R passed into another object
    if (passed.length === 0 || R531_PURE.has(c.method) || r562NotAProc(c.method)) return none;
    if (c.method === "gettable") return none;
    const rt = normalizeAlName(recvNode?.text ?? "");
    if (/^(page|report|xmlport|query)$/.test(rt)) return none;
    const t = recvNode !== null && isIdentifierLike(recvNode) ? declaredType(recvNode, ctx) : null;
    if (c.method === "run" && (rt === "codeunit" || t?.kind === "codeunit")) {
      // `Codeunit.Run(X, R)` / `CU.Run(R)`: followed into a project TableNo codeunit's OnRun, whose
      // Rec is R (assumed passed by reference, not measured); anything else runs on a copy
      // an uncertain call (R567): any project codeunit, R at any position
      const at = rt === "codeunit" ? 1 : 0;
      const id = c.args[0]?.text.replace(/^codeunit\s*::\s*/i, "") ?? "";
      const cus =
        rt === "codeunit"
          ? projectObjects(ctx).filter(
              (o) =>
                o.rawKind === "codeunit_declaration" &&
                (c.uncertain ||
                  objectNameOf(o) === normalizeAlName(id) ||
                  o.childForFieldName("object_id")?.text === id),
            )
          : t !== null
            ? objectsOfType(t, ctx)
            : [];
      for (const o of cus) {
        if (!hasProperty(o, "TableNo", ctx)) continue;
        visitAll(o, (x) => {
          if (x.rawKind === "trigger_declaration" && triggerName(x) === "onrun")
            for (const [k, i] of passed)
              if (i === at || c.uncertain) targets.push({ proc: x, key: "", r: k });
        });
      }
    } else {
      const ps =
        t !== null && (t.kind === "codeunit" || t.kind === "table")
          ? objectsOfType(t, ctx).flatMap((o) => r531ProcsIn(o, c.method, arity, n, ctx))
          : [];
      unresolved = ps.length === 0;
      passInto(ps);
    }
  }
  const hops: R531Hop[] = [];
  for (const t of targets) {
    const body = bodyOf(t.proc);
    if (body === null) continue;
    const cprocs = r531ObjectProcs(t.proc, ctx);
    const filters: ALSyntaxNode[] = [];
    r531Walk(body, ctx, (m) => {
      const cc = r531Call(m);
      if (cc === null || m.rawKind === "member_expression") return;
      const r = cc.recv ?? (r531Implicit(m, ctx) && !cprocs.has(cc.method) ? "" : null);
      if (r !== t.key) return;
      if (R531_FILTER.has(cc.method)) {
        // FILTER's dependency test
        const d = depends.get(t.r);
        const f = r531Field(cc);
        if (d !== undefined && f !== null && r531Has(d, f)) filters.push(m);
      } else if (cc.method === "markedonly" && markRecvs.has(t.r)) filters.push(m);
    });
    if (filters.length === 0) continue;
    const guards = filters.flatMap((f) => guardsUpTo(f, body));
    // an exit or a raised Error before the last such filter skips it
    const last = Math.max(...filters.map((f) => f.startIndex));
    const isExit = (x: ALSyntaxNode): boolean =>
      x.startIndex < last && (x.rawKind === "exit_statement" || isRaisedError(x, body));
    visitAll(body, (x) => {
      if (isExit(x)) guards.push(x);
    });
    guards.push(...exitGuards(body, body, isExit));
    hops.push({ proc: t.proc, consumers: filters, guards });
  }
  // an uncertain call is refused itself (R567): it may pass R where this could not see
  return { hops, refuse: unresolved || hops.length > 0 || c.uncertain };
}

/** R568: does R532's feed search stop at the arguments of non-bare call `c`? The arguments feed
 *  unless the receiver is typed as an object (codeunit, report, page, query, xmlport, testpage,
 *  interface; in the project or not) or is a record whose table or a project tableextension declares
 *  the member as a procedure: that is another object's function, closed by ruling in R532. So
 *  `Cust.Get(Key)`, `Txt.Contains(T)`, `CurrReport.X(T)` and a receiver nothing resolves feed their
 *  arguments (the safe direction for a refusal). Residual: a platform method on an object-typed
 *  variable (`Rpt.SaveAsPdf(F)`, `Cu.Run(Rec)`) still stops. */
function r568StopsAt(c: ALSyntaxNode, ctx: SemanticContext): boolean {
  const f = c.childForFieldName("function");
  const recv = f?.rawKind === "member_expression" ? f.childForFieldName("object") : null;
  if (recv === null || recv === undefined || !isIdentifierLike(recv)) return false;
  // ponytail: R737 guard for an ambiguous receiver (never stops: its arguments feed). The census
  // found no such receiver on any corpus (R_amb = 0), so it has no test; add one if it ever fires.
  if (declaredTypes(recv, ctx).length > 1) return false;
  const t = declaredType(recv, ctx);
  if (t !== null && t.kind !== "table") return true;
  const tg = callTargets(c, ctx);
  return tg?.objs.some((o) => procedureNamesOf(o, ctx).has(tg.member)) === true;
}

/** FEEDS: assignments in `scope` whose target name `parts` read, to a fixpoint (R480
 *  `indirectFeeds`'s by-name rule, over the whole scope instead of one loop body). R532 passes
 *  `fed`, which receives every name read on the way, and also matches a target's ROOT name
 *  (`Arr[1] := X` feeds `Arr`, `R.X := Y` feeds `R` as well as `X`) and follows the `#if`
 *  expression tails `indirectFeeds` follows. Under `fed`, at a non-bare call that is another
 *  object's function (`r568StopsAt`) it reads only the receiver (`Obj.Proc(A)` feeds `Obj`, not
 *  `A`): a value that reaches the name through another object's function is closed by ruling in
 *  R532. A platform method's arguments feed (R568). R-531 passes nothing and is unchanged. */
function r531Feeds(
  scope: ALSyntaxNode,
  parts: ALSyntaxNode[],
  ctx: SemanticContext,
  fed?: Set<string>,
): ALSyntaxNode[] {
  const names = fed ?? new Set<string>();
  const collect = (n: ALSyntaxNode): void => {
    if (DIRECTIVE_MARKERS.has(n.rawKind) || armOfNode(ctx, n) === "inactive") return;
    if (
      fed !== undefined &&
      (n.rawKind === "call_expression" || n.rawKind === "call_statement") &&
      bareCallee(n) === null &&
      r568StopsAt(n, ctx)
    ) {
      const f = n.childForFieldName("function");
      if (f !== null) collect(f);
      return;
    }
    if (isIdentifierLike(n)) names.add(normalizeAlName(n.text));
    for (const c of n.namedChildren) collect(c);
  };
  for (const p of parts) collect(p);
  const assignments: ALSyntaxNode[] = [];
  visitAll(scope, (n) => {
    if (n.kind === ALNodeKind.assignment_statement) assignments.push(n);
  });
  const out: ALSyntaxNode[] = [];
  const used = new Set<number>();
  for (let changed = true; changed; ) {
    changed = false;
    for (const a of assignments) {
      if (used.has(a.startIndex)) continue;
      const left = a.childForFieldName("left");
      const right = a.childForFieldName("right");
      if (left === null || right === null) continue;
      const name =
        left.rawKind === "member_expression" || left.kind === ALNodeKind.field_access
          ? left.childForFieldName("member")
          : left;
      const hit = name !== null && isIdentifierLike(name) && names.has(normalizeAlName(name.text));
      if (!hit && (fed === undefined || !names.has(rootName(left)))) continue;
      used.add(a.startIndex);
      out.push(a);
      collect(right);
      if (fed !== undefined) for (const t of exprTails(a)) collect(t);
      changed = true;
    }
  }
  return out;
}

/** The R-531 analysis of a loop, or null when it is not the shape (no cursor method in its
 *  condition, a `Next` in it, or no consumer in its body). Cached per loop. */
export function r531Analyze(loop: ALSyntaxNode, ctx: SemanticContext): R531Loop | null {
  if (!LOOP_KINDS.has(loop.kind)) return null;
  return cached(ctx, loop, "r531", () => r531AnalyzeOnce(loop, ctx));
}

function r531AnalyzeOnce(loop: ALSyntaxNode, ctx: SemanticContext): R531Loop | null {
  const recvs = new Set<string>();
  // the condition receivers by key, with a receiver node (null: the implicit Rec, flag unknown)
  const roots = new Map<string, ALSyntaxNode | null>();
  let next = false;
  for (const p of loopConditionParts(loop)) {
    r531Walk(p, ctx, (n) => {
      let c = r531Call(n);
      if (c === null && isIdentifierLike(n) && n.parent?.rawKind !== "member_expression") {
        c = { recv: null, method: normalizeAlName(n.text), args: [], uncertain: false };
      }
      if (c === null) return;
      if (c.recv === null && !r531Implicit(n, ctx)) return;
      if (R531_COND.has(c.method)) {
        recvs.add(c.recv ?? "");
        const m = n.rawKind === "call_expression" ? n.childForFieldName("function") : n;
        const o = m?.rawKind === "member_expression" ? m.childForFieldName("object") : null;
        roots.set(c.recv ?? "", c.recv === null ? null : o);
      }
      if (c.method === "next") next = true;
    });
  }
  if (next || recvs.size === 0) return null;
  const body = loop.childForFieldName("body");
  if (body === null) return null;
  const scope = codeScope(loop);
  const procs = r531ObjectProcs(loop, ctx);
  // same-procedure aliases of R count as R
  const aliases = new Set<string>();
  const copyLinked = new Set<string>(); // every name a `Copy` call names (R571: never temp-skipped)
  if (scope !== null) {
    for (let changed = true; changed; ) {
      changed = false;
      r531Walk(scope, ctx, (n) => {
        const pairs: [string | null, string | null][] = [];
        if (n.kind === ALNodeKind.assignment_statement) {
          const l = n.childForFieldName("left");
          const rt = n.childForFieldName("right");
          if (l !== null && rt !== null && isIdentifierLike(l) && isIdentifierLike(rt))
            pairs.push([r531Key(l), r531Key(rt)]);
        } else {
          const c = r531Call(n);
          const a0 = c?.args[0];
          const a1 = c?.args[1];
          // `Copy(X, true)` shares the table; a non-literal second argument may be true too. A
          // bare `Copy` is the implicit Rec's (unless the object declares a procedure `Copy`).
          // An uncertain `Copy` (R567) aliases every argument.
          if (c !== null && c.method === "copy") {
            const self = c.recv ?? (r531Implicit(n, ctx) && !procs.has("copy") ? "" : null);
            for (const k of [self, ...c.args.map(r531Key)]) if (k !== null) copyLinked.add(k);
            if (c.uncertain) for (const a of c.args) pairs.push([self, r531Key(a)]);
            else if (a0 !== undefined && a1 !== undefined && normalizeAlName(a1.text) !== "false")
              pairs.push([self, r531Key(a0)]);
          }
        }
        for (const [x, y] of pairs) {
          if (x === null || y === null) continue;
          for (const [p, q] of [
            [x, y],
            [y, x],
          ] as const) {
            if (recvs.has(q) && !recvs.has(p)) {
              recvs.add(p);
              aliases.add(p);
              changed = true;
            }
          }
        }
      });
    }
  }
  // filters on R anywhere in the scope, and the pre-loop `MarkedOnly` calls on R
  const filtered = new Map<string, Set<string>>();
  const filterCalls: { n: ALSyntaxNode; r: string; field: string }[] = [];
  const markedOnly: { n: ALSyntaxNode; r: string }[] = [];
  if (scope !== null) {
    r531Walk(scope, ctx, (n) => {
      const c = r531Call(n);
      if (c === null) return;
      const isFilter = R531_FILTER.has(c.method);
      if (!isFilter && c.method !== "markedonly") return;
      const r = c.recv ?? (r531Implicit(n, ctx) ? "" : null);
      if (r === null || !recvs.has(r)) return;
      if (!isFilter) {
        markedOnly.push({ n, r });
        return;
      }
      const field = r531Field(c);
      if (field === null) return;
      const s = filtered.get(r) ?? new Set<string>();
      s.add(field);
      filtered.set(r, s);
      filterCalls.push({ n, r, field });
    });
  }
  // the fields whose filter the loop's ending depends on ("*": any filter, for Rename)
  const depends = new Map<string, Set<string>>();
  const dep = (r: string, f: string): void => {
    const s = depends.get(r) ?? new Set<string>();
    s.add(f);
    depends.set(r, s);
  };
  const consumers: ALSyntaxNode[] = [];
  const kinds: string[] = [];
  const consume = (n: ALSyntaxNode, kind: string, r: string): void => {
    consumers.push(n);
    kinds.push(kind);
    if (aliases.has(r)) kinds.push("alias");
  };
  const modifies: { n: ALSyntaxNode; r: string; all: string | null }[] = [];
  const writes: { n: ALSyntaxNode; r: string; field: string }[] = [];
  const inserts = new Set<string>();
  const markRecvs = new Set<string>();
  const hopCands: { n: ALSyntaxNode; kind: string; c: R531Call }[] = [];
  r531Walk(body, ctx, (n) => {
    if (n.kind === ALNodeKind.assignment_statement) {
      const left = n.childForFieldName("left") ?? n.namedChildren[0] ?? null;
      if (left?.rawKind === "member_expression") {
        const r = r531Key(left.childForFieldName("object"));
        const m = left.childForFieldName("member");
        if (r !== null && recvs.has(r) && m !== null)
          writes.push({ n, r, field: normalizeAlName(m.text) });
      } else if (
        left !== null &&
        isIdentifierLike(left) &&
        recvs.has("") &&
        resolveVarRef(left, ctx) === null
      ) {
        writes.push({ n, r: "", field: normalizeAlName(left.text) });
      }
      return;
    }
    const c = r531Call(n);
    if (c === null) return;
    const bare = c.recv === null;
    const r = c.recv ?? (r531Implicit(n, ctx) && !procs.has(c.method) ? "" : null);
    if (r !== null && recvs.has(r)) {
      if (R531_DEL.has(c.method)) {
        consume(n, c.method, r);
        if (c.method === "rename") dep(r, "*");
      } else if (R531_MOD.has(c.method)) {
        modifies.push({
          n,
          r,
          all: c.method === "modifyall" ? (r531Field(c) ?? "") : null,
        });
      } else if (R531_FILTER.has(c.method)) {
        consume(n, "refilter", r);
      } else if (R531_MARKS.has(c.method)) {
        consume(n, "mark", r);
        if (c.method === "mark") markRecvs.add(r);
      } else if (c.method === "insert") {
        inserts.add(r);
      } else if (c.method === "validate") {
        const field = r531Field(c);
        if (field !== null) writes.push({ n, r, field });
      } else if (
        !R531_BUILTIN.has(c.method) &&
        n.rawKind === "call_expression" &&
        // a bare name: only a table procedure the implicit Rec's table declares in the project
        (!bare || r531TableProcs(n, c.method, r531CallArity(c), ctx).length > 0)
      ) {
        consume(n, "recv-proc", r);
        hopCands.push({ n, kind: "recv-proc", c });
      }
      return;
    }
    // a call passing R whole
    const passes = c.args.some((a) => {
      const k = r531Key(a);
      return k !== null && recvs.has(k) && (k !== "" || normalizeAlName(a.text) === "rec");
    });
    if (passes && !R531_PURE.has(c.method) && !(c.recv !== null && R531_BUILTIN.has(c.method))) {
      consume(n, "pass-rec", "");
      hopCands.push({ n, kind: "pass-rec", c });
      return;
    }
    // a bare same-object procedure call that can see R (a global, or the implicit Rec)
    if (
      bare &&
      procs.has(c.method) &&
      [...recvs].some((x) => x === "" || !r531Declares(scope, x, true))
    ) {
      consume(n, "global-call", "");
      hopCands.push({ n, kind: "global-call", c });
    }
  });
  // a consumer plus a re-Insert under a changed filtered field is a rename by hand
  for (const r of inserts) {
    const f = filtered.get(r);
    const ws = writes.filter((w) => w.r === r && (f === undefined || r531Has(f, w.field)));
    if (ws.length > 0 && consumers.length > 0) {
      kinds.push("delete-reinsert");
      for (const w of ws) {
        consumers.push(w.n);
        dep(r, w.field);
      }
    }
  }
  for (const m of modifies) {
    const f = filtered.get(m.r);
    const ws = writes.filter((w) => w.r === m.r);
    if (f === undefined) {
      // no filter on R in the procedure: it is set elsewhere, so every written field counts
      consume(m.n, "modify-unseen", m.r);
      for (const w of ws) {
        consumers.push(w.n);
        dep(m.r, w.field); // R562: the filter may come from a pre-loop call
      }
      if (m.all !== null) dep(m.r, m.all);
    } else if (!r531Declares(scope, m.r, false)) {
      // R a global, a parameter or the implicit Rec: filters can be set elsewhere too
      if (ws.length === 0 && m.all === null) continue;
      consume(m.n, "modify-all", m.r);
      for (const w of ws) {
        consumers.push(w.n);
        dep(m.r, w.field);
      }
      if (m.all !== null) dep(m.r, m.all);
    } else {
      const hit = ws.filter((w) => r531Has(f, w.field));
      const all = m.all !== null && r531Has(f, m.all) ? m.all : null;
      if (hit.length === 0 && all === null) continue;
      consume(m.n, "modify-filtered", m.r);
      for (const w of hit) {
        consumers.push(w.n);
        dep(m.r, w.field);
      }
      if (all !== null) dep(m.r, all);
    }
  }
  if (consumers.length === 0) return null;
  // the filter calls BEFORE the loop, same scope, that the ending depends on
  const preFilters = [
    ...filterCalls.filter((c) => {
      const d = depends.get(c.r);
      return d !== undefined && r531Has(d, c.field);
    }),
    ...markedOnly.filter((c) => markRecvs.has(c.r)),
  ]
    .filter((c) => c.n.endIndex <= loop.startIndex)
    .map((c) => c.n);
  const hops: R531Hop[] = [];
  // R571's caller-side temp-flag skip: an assignment alias of R (never one named in a `Copy`)
  // whose temporary flag is KNOWN and differs from every condition receiver's known flag
  const rootFlags = [...roots.values()].map((id) => (id === null ? null : r571KnownTemp(id, ctx)));
  const skipArg = (a: ALSyntaxNode, k: string): boolean => {
    if (!r571TempSkip.on || !aliases.has(k) || copyLinked.has(k) || rootFlags.length === 0)
      return false;
    const f = r571KnownTemp(a, ctx);
    return f !== null && rootFlags.every((r) => r !== null && r !== f);
  };
  // FILTER HOP (R562): a pre-loop call whose callee sets such a filter, or that cannot be followed
  if (scope !== null && depends.size + markRecvs.size > 0)
    r531Walk(scope, ctx, (n) => {
      if (n.endIndex > loop.startIndex) return;
      const h = r562FilterHop(n, ctx, recvs, scope, depends, markRecvs);
      hops.push(...h.hops);
      if (h.refuse) preFilters.push(n);
    });
  const isConsumer = (n: ALSyntaxNode): boolean => consumers.some((c) => samePos(c, n));
  const isContinue = (n: ALSyntaxNode): boolean => {
    if (n.rawKind !== "continue_statement") return false;
    for (let a = n.parent; a !== null; a = a.parent) {
      if (BREAK_SCOPES.has(a.rawKind)) return samePos(a, loop);
    }
    return false;
  };
  const guards = [...exitGuards(body, loop, isConsumer), ...exitGuards(body, loop, isContinue)];
  // HOP: one hop into same-object callees and table procedures on R
  const obj = objectOf(loop);
  for (const h of hopCands) {
    const targets: { proc: ALSyntaxNode; key: string; byValue: boolean }[] = [];
    const arity = r531CallArity(h.c);
    if (h.kind === "recv-proc") {
      for (const p of r531TableProcs(h.n, h.c.method, arity, ctx))
        targets.push({ proc: p, key: "", byValue: false });
    } else if (h.c.recv === null && obj !== null) {
      for (const p of r531ProcsIn(obj, h.c.method, arity, h.n, ctx)) {
        if (h.kind === "global-call")
          for (const r of recvs) {
            // only R the callee can see: a global it does not shadow, or the implicit Rec
            if (r === "" || (!r531Declares(scope, r, true) && !r531Declares(p, r, true)))
              targets.push({ proc: p, key: r, byValue: false });
          }
        h.c.args.forEach((a, i) => {
          const k = r531Key(a);
          if (k === null || !recvs.has(k)) return;
          for (const j of r531Positions(h.c, i, p)) {
            const prm = r531Param(p, j);
            // a by-value parameter copies the VARIABLE, not the table (see r531CalleeHop)
            if (prm !== null)
              targets.push({ proc: p, key: r531ParamKey(prm[0]), byValue: !prm[1] });
          }
        });
      }
    }
    for (const t of targets) {
      const hop = r531CalleeHop(t.proc, t.key, ctx, t.byValue);
      if (hop !== null)
        hops.push(r574Seam.on ? (r571Hop(hop.proc, hop.consumers, ctx) ?? hop) : hop);
    }
    if (r571Seam.on && targets.length === 0 && obj !== null && h.n.rawKind === "call_expression")
      hops.push(...r571CrossHops(h.n, h.c, h.kind, recvs, obj, ctx, skipArg));
  }
  // FEEDS: indirect feeds, and the guards around a pre-loop filter call
  let feeds: ALSyntaxNode[] = [];
  const preGuards: ALSyntaxNode[] = [];
  if (scope !== null) {
    for (const f of preFilters) preGuards.push(...guardsUpTo(f, scope));
    const parts: ALSyntaxNode[] = [...guards, ...preGuards];
    for (const c of [...consumers, ...preFilters]) {
      if (c.kind === ALNodeKind.assignment_statement) {
        const rt = c.childForFieldName("right");
        if (rt !== null) parts.push(rt);
      } else {
        const call = r531Call(c);
        if (call !== null) parts.push(...call.args);
      }
    }
    feeds = r531Feeds(scope, parts, ctx).filter((a) => !consumers.some((c) => samePos(c, a)));
  }
  return {
    loop,
    kinds: [...new Set(kinds)].sort(),
    consumers,
    guards,
    preFilters,
    feeds,
    preGuards,
    hops,
  };
}

/** R574: R531's same-object HOP (a same-object callee, or a table procedure on R) is built by
 *  R571's `r571Hop`, so it also refuses the callee's EARLY EXITS (exits, raised Errors and breaks),
 *  their guards and the feeds of every hop guard, as the cross-object hop does. */
export const r574Seam = { on: true };

/**
 * R571: R531's HOP into a consumer in ANOTHER project object. When the same-object HOP above finds
 * no target for a `pass-rec` or `recv-proc` consumer, the call is resolved through `callTargets`
 * (declared type; `objectsOfType` adds tableextensions and interface implementers; else the bound
 * record) and R564's `r531ProcsIn`. Only procedures in another object are taken.
 * - `pass-rec`: the callee's parameter that receives R counts as R. A `var` parameter counts every
 *   R531 consumer kind; a by-value one only Delete, DeleteAll, Rename and Modify (R531's by-value
 *   rule). A parameter named `Rec` is keyed "" like a `Rec.M()` receiver (R570's `r531ParamKey`).
 *   An argument the caller-side temp-flag skip names is not followed (`r571TempSkip`).
 * - `recv-proc` on a receiver that is NOT a record (a codeunit or interface variable the loop's
 *   condition tests by name, `while not Socket.IsEmpty() do Socket.Pop()`): the callee's object holds
 *   the set itself, so every GLOBAL of that object that the callee does not shadow with a local or
 *   parameter counts as R. These globals are never temp-skipped: they ARE the set. A bare call in
 *   the callee to a procedure of its own object that can see one of those globals counts as a
 *   consumer too (`r571HelperCalls`).
 * What is refused: the callee's consumers, the sites containing them, their guards, and its early
 * exits (`r571Hop`).
 * Not followed (each errs toward deploying): a second cross-object hop, the body of a callee's
 * own same-object helper, `Codeunit.Run` targets, event subscribers, and objects outside the
 * project.
 */
export const r571Seam = { on: true };

/**
 * R571's caller-side temp-flag skip, behind its own seam. An argument passed into the cross-object
 * callee is not followed when it is an alias of R made by ASSIGNMENT (`:=`), it is named in no `Copy`
 * call of the scope (`Copy(X, true)` shares the table), and its temporary flag and every loop
 * condition receiver's flag are KNOWN (`r571KnownTemp`) and differ. An assignment copies the record,
 * never a temporary table: measured on BC (scripts/r571-assign-probe).
 */
export const r571TempSkip = { on: true };

/**
 * A record variable's temporary flag when it is KNOWN, else null. Known true: the declaration says
 * `temporary`. Known false: a `Record X` local or global (never a parameter, which can bind a
 * temporary record) without the keyword, whose table X is a project table not declared
 * `TableType = Temporary`. Anything else (a parameter, a table outside the project, the implicit
 * Rec, a codeunit variable) is unknown.
 */
function r571KnownTemp(id: ALSyntaxNode, ctx: SemanticContext): boolean | null {
  if (!isIdentifierLike(id)) return null;
  const decl = resolveVarRef(id, ctx)?.node ?? null;
  const rec =
    decl?.childForFieldName("type")?.namedChildren.find((c) => c.rawKind === "record_type") ?? null;
  if (decl === null || rec === null) return null;
  if (rec.namedChildren.some((x) => x.rawKind === "temporary_keyword")) return true;
  if (decl.rawKind !== "variable_declaration") return null;
  const ref = qualifiedObjectName(fieldSegments(rec, "reference"), "table", ctx.symbols);
  const table = ref === null ? null : tableObjectOfRef(ref, ctx);
  if (table === null) return null;
  let tempType = false;
  visitAll(table.node, (x) => {
    if (
      x.kind === ALNodeKind.property &&
      normalizeAlName(x.childForFieldName("name")?.text ?? "") === "tabletype" &&
      normalizeAlName(x.childForFieldName("value")?.text ?? "") === "temporary"
    )
      tempType = true;
  });
  return tempType ? null : false;
}

/** R571: the hops into another project object for consumer call `n` (see `r571Seam`). */
function r571CrossHops(
  n: ALSyntaxNode,
  c: R531Call,
  kind: string,
  recvs: ReadonlySet<string>,
  obj: ALSyntaxNode,
  ctx: SemanticContext,
  skip: (a: ALSyntaxNode, k: string) => boolean,
): R531Hop[] {
  const tg = callTargets(n, ctx);
  if (tg === null) return [];
  const arity = r531CallArity(c);
  const out: R531Hop[] = [];
  for (const o of tg.objs) {
    if (samePos(o, obj) && sameFile(rootOf(o), rootOf(obj))) continue;
    const globals = objectGlobalNames(o);
    for (const p of r531ProcsIn(o, tg.member, arity, n, ctx)) {
      const consumers: ALSyntaxNode[] = [];
      const take = (key: string, byValue: boolean): void => {
        consumers.push(...(r531CalleeHop(p, key, ctx, byValue)?.consumers ?? []));
      };
      if (kind === "pass-rec")
        c.args.forEach((a, i) => {
          const k = r531Key(a);
          if (k === null || !recvs.has(k) || skip(a, k)) return;
          for (const j of r531Positions(c, i, p)) {
            const prm = r531Param(p, j);
            if (prm !== null) take(r531ParamKey(prm[0]), !prm[1]);
          }
        });
      else if (kind === "recv-proc" && tg.kind !== "record") {
        for (const g of globals) if (!r531Declares(p, g, true)) take(g, false);
        consumers.push(...r571HelperCalls(p, o, globals, ctx));
      }
      const hop = r571Hop(p, consumers, ctx);
      if (hop !== null) out.push(hop);
    }
  }
  return out;
}

/** R571 (plan r2 item 2): the bare calls in `proc` to a procedure of its own object `o` that can see
 *  one of `globals` (declares no local or parameter of that name), as R531's `global-call` in a loop
 *  body. The helper's own body is not followed. */
function r571HelperCalls(
  proc: ALSyntaxNode,
  o: ALSyntaxNode,
  globals: ReadonlySet<string>,
  ctx: SemanticContext,
): ALSyntaxNode[] {
  const body = proc.namedChildren.find((x) => x.rawKind === "code_block") ?? null;
  if (body === null || globals.size === 0) return [];
  const procs = r531ObjectProcs(proc, ctx);
  const out: ALSyntaxNode[] = [];
  r531Walk(body, ctx, (n) => {
    if (n.rawKind !== "call_expression" && n.rawKind !== "call_statement") return;
    const c = r531Call(n);
    if (c === null || c.recv !== null || !procs.has(c.method) || !r531Implicit(n, ctx)) return;
    const helpers = r531ProcsIn(o, c.method, r531CallArity(c), n, ctx);
    if (helpers.some((h) => [...globals].some((g) => !r531Declares(h, g, true)))) out.push(n);
  });
  return out;
}

/** R571: the hop into `proc` for `consumers`, with their guards and the callee's EARLY EXITS: every
 *  `exit` or raised `Error` that starts before the last consumer, or that sits in a loop whose body
 *  holds a consumer (the next pass can reach it first), every `break` that leaves such a loop,
 *  plus their guards (`if not Buf.FindLast() then exit` negated returns without deleting while the
 *  set is not empty), and the assignments in
 *  the callee body that feed those guards and exits (R531's FEEDS). */
function r571Hop(
  proc: ALSyntaxNode,
  consumers: ALSyntaxNode[],
  ctx: SemanticContext,
): R531Hop | null {
  const body = proc.namedChildren.find((x) => x.rawKind === "code_block") ?? null;
  if (body === null || consumers.length === 0) return null;
  const inside = (a: ALSyntaxNode, b: ALSyntaxNode): boolean =>
    b.startIndex <= a.startIndex && a.endIndex <= b.endIndex;
  const last = Math.max(...consumers.map((c) => c.startIndex));
  const loops: ALSyntaxNode[] = [];
  visitAll(body, (x) => {
    if (BREAK_SCOPES.has(x.rawKind) && consumers.some((c) => inside(c, x))) loops.push(x);
  });
  // the loop a `break` leaves: its nearest enclosing loop
  const breaks = (x: ALSyntaxNode): ALSyntaxNode | null => {
    for (let a = x.parent; a !== null && !samePos(a, body); a = a.parent)
      if (BREAK_SCOPES.has(a.rawKind)) return a;
    return null;
  };
  const isExit = (x: ALSyntaxNode): boolean => {
    if (x.rawKind === "break_statement") {
      const l = breaks(x);
      return l !== null && loops.some((c) => samePos(c, l));
    }
    return (
      (x.rawKind === "exit_statement" || isRaisedError(x, body)) &&
      (x.startIndex < last || loops.some((l) => inside(x, l)))
    );
  };
  const isC = (x: ALSyntaxNode): boolean => consumers.some((c) => samePos(c, x));
  const guards = [...exitGuards(body, body, isC), ...exitGuards(body, body, isExit)];
  visitAll(body, (x) => {
    if (isExit(x)) guards.push(x);
  });
  // FEEDS over the callee body: `Found := Buf.FindLast(); if not Found then exit;`
  guards.push(...r531Feeds(body, guards, ctx).filter((a) => !isC(a)));
  return { proc, consumers, guards };
}

/** The names an object declares in its own `var` sections (its globals). */
function objectGlobalNames(o: ALSyntaxNode): Set<string> {
  const out = new Set<string>();
  for (const c of o.childForFieldName("body")?.namedChildren ?? []) {
    if (c.rawKind !== "var_section") continue;
    visitAll(c, (v) => {
      if (v.rawKind === "variable_declaration")
        for (const nm of declaredNames(v)) out.add(normalizeAlName(nm));
    });
  }
  return out;
}

/** Every R-531 loop in a scope (FILTER and FEEDS sites can sit outside the loop). */
function r531ScopeLoops(scope: ALSyntaxNode, ctx: SemanticContext): R531Loop[] {
  return cached(ctx, scope, "r531scope", () => {
    const out: R531Loop[] = [];
    visitAll(scope, (x) => {
      const a = r531Analyze(x, ctx);
      if (a !== null) out.push(a);
    });
    return out;
  });
}

const r531HopMemo = new WeakMap<object, R531Hop[]>();
/** HOP: every hop of every R-531 loop in the project, built once per context. */
function r531HopIndex(ctx: SemanticContext): R531Hop[] {
  const hit = r531HopMemo.get(ctx);
  if (hit !== undefined) return hit;
  const out: R531Hop[] = [];
  r531HopMemo.set(ctx, out);
  for (const f of ctx.files ?? []) {
    visitAll(f.root, (x) => {
      const a = r531Analyze(x, ctx);
      if (a !== null) out.push(...a.hops);
    });
  }
  return out;
}

/** R-531's refusal (see the block comment above `R531_COND`). */
function consumingLoopRefuses(
  node: ALSyntaxNode,
  ctx: SemanticContext,
  op: string | undefined,
): boolean {
  const inside = (a: ALSyntaxNode, b: ALSyntaxNode): boolean =>
    b.startIndex <= a.startIndex && a.endIndex <= b.endIndex;
  for (let cur = node.parent; cur !== null && !isScope(cur); cur = cur.parent) {
    const a = r531Analyze(cur, ctx);
    if (a === null) continue;
    // NEG: every operator but swap-find-direction inside the loop's own condition
    if (op !== SWAP_FIND_DIRECTION && loopConditionParts(cur).some((p) => inside(node, p)))
      return true;
    const body = cur.childForFieldName("body");
    if (body === null || !inside(node, body)) continue;
    if (a.consumers.some((c) => inside(node, c) || inside(c, node))) return true;
    if (a.guards.some((g) => inside(node, g))) return true;
  }
  const scope = codeScope(node);
  if (scope === null) return false;
  if (
    r531ScopeLoops(scope, ctx).some((a) =>
      [...a.preFilters, ...a.feeds, ...a.preGuards].some((f) => inside(node, f)),
    )
  )
    return true;
  const root = rootOf(node);
  for (const h of r531HopIndex(ctx)) {
    if (!samePos(h.proc, scope) || !sameFile(rootOf(h.proc), root)) continue;
    if (
      h.consumers.some(
        (c) =>
          inside(node, c) || (inside(c, node) && inside(node, h.proc) && !samePos(node, h.proc)),
      )
    )
      return true;
    if (h.guards.some((g) => inside(node, g))) return true;
  }
  return false;
}

/**
 * R500 shape 1 (a stated LIMIT, not a full rule). A GLOBAL that an open item's exit guard (Break,
 * Quit, Error) or SetRange/SetFilter argument reads, in any open-item scope (the open items' triggers,
 * Date items included, and the same-object procedures they reach), and that open-item code never
 * writes (never an assignment target, a `var` argument, a call receiver or a loop variable), is fixed
 * for the whole walk: its value comes only from code that runs before the item. `Finance Charge Memo
 * - Test`'s DimensionLoop breaks on `not Continue`, which only an earlier sibling sets; a mutant there
 * that leaves it true walks forever. Refused, outside open-item code: a site that contains or sits in
 * a write of such a name; the condition of an if/while/repeat/case whose body holds such a write; and
 * an early exit (`exit`, Break/Quit/Skip, `Error`, or a guard holding one) that comes before such a
 * write in its scope. Not seen: a write in another object other than a call to a report's writer
 * through a typed `Report X` receiver (R555, below; the unresolvable receivers are filed), and a value
 * that reaches the name from another procedure or object (closed by ruling in R532). A value that
 * reaches it through another variable in the same scope (an argument of a same-object writer call
 * whose parameter the writer feeds included) is a FEED (R532, `presetFeeds`), refused like a write;
 * an argument of another object's function (`Obj.Proc(A)`) is not one.
 *
 * R548: inside a reportextension the names are the extension's own (`presetExitNames` over its
 * blocks, its globals seeded with the base's protected names) plus every base candidate's preset
 * names that the base declares `protected var` (`extensionPresetExitNames`). A non-protected base
 * global is not accessible from an extension (AL0161). Not seen (R548 residuals): a BASE write of a
 * protected name only an extension's guard reads.
 *
 * R555: a CALL to a preset writer (`presetWriters`: a procedure that writes such a name, directly or
 * through another writer) is a write too, so the call, its guards, its enclosing blocks and an early
 * exit before it are refused like an inline write. In ANY object, a call through a receiver declared
 * `Report X` to a writer of project report X, or of a project reportextension of X, is one as well
 * (`crossWriterCall`; alc 18.0.43 binds an extension procedure through `Report X`, R555 build.md).
 */
function writesPresetExitName(node: ALSyntaxNode, ctx: SemanticContext): boolean {
  const obj = objectOf(node);
  if (obj === null) return false;
  let names: Set<string> = new Set();
  if (obj.rawKind === "report_declaration") names = presetExitNames(obj, ctx);
  else if (obj.rawKind === "reportextension_declaration")
    names = extensionPresetExitNames(obj, ctx);
  const w =
    obj.rawKind === "report_declaration" || obj.rawKind === "reportextension_declaration"
      ? presetWriters(obj, names, ctx)
      : null;
  // an extension with no names of its own can still call a base writer (the bypass of R548's return)
  const local = w !== null && (names.size > 0 || w.procs.size > 0 || w.unreadProcs.size > 0);
  const cross = crossWriters(ctx).all.size > 0;
  // open-item code is refused by `openItemHangRefuses`' first part already, cross-object or not
  if ((!local && !cross) || inOpenItemCode(node, ctx)) return false;
  const scope = codeScope(node);
  const feeds =
    local && w !== null && scope !== null && r532FeedSeam.on
      ? presetFeeds(scope, names, w, ctx)
      : null;
  const isFeed = (n: ALSyntaxNode): boolean =>
    feeds !== null &&
    feeds.names.size > 0 &&
    ((n.rawKind === "assignment_statement" && feeds.assigns.has(n.startIndex)) ||
      directWrite(n, feeds.names, ctx));
  const writes = (n: ALSyntaxNode): boolean =>
    (local &&
      w !== null &&
      (directWrite(n, names, ctx) || callsPresetWriter(n, w, ctx, names.size > 0) || isFeed(n))) ||
    (cross && crossWriterCall(n, ctx));
  const containsWrite = (n: ALSyntaxNode, after = -1): boolean => {
    let found = false;
    visitAll(n, (x) => {
      if (!found && x.startIndex >= after && writes(x)) found = true;
    });
    return found;
  };
  for (
    let a: ALSyntaxNode | null = node;
    a !== null && (scope === null || !samePos(a, scope));
    a = a.parent
  ) {
    if (writes(a)) return true;
    // the condition of an if/while/repeat/case whose body holds such a write (a mutant there decides
    // whether, or how often, the write runs: ReminderTest's backward line scan)
    const p = a.parent;
    const field = p === null ? undefined : GUARDED.get(p.rawKind);
    if (
      p !== null &&
      field !== undefined &&
      samePos(p.childForFieldName(field) ?? p, a) &&
      containsWrite(p)
    ) {
      return true;
    }
    // an early exit before such a write in this scope (`if Hide then CurrReport.Break(); ...
    // Continue := ...`): a mutant there decides whether the write runs at all
    if (scope !== null && isEarlyExit(a, scope) && containsWrite(scope, a.endIndex)) return true;
  }
  return containsWrite(node);
}

/** R532: a test-only seam. Tests switch `on` off to show a mutant IS emitted without the feeds. */
export const r532FeedSeam = { on: true };

/**
 * R532: the FEEDS of shape 1's preset writes in `scope` (a procedure or trigger outside open-item
 * code; a feed in open-item code is R-501's already). A feed is an assignment whose value flows by
 * name, to a fixpoint, into the right side (or `#if` tails) of an assignment to a preset exit name
 * (`r531Feeds` with `fed`), or a `directWrite` of a name read on the way: a `var` argument
 * (`Compute(Tmp)`), `Clear`/`Evaluate`, or an unknown callee. The search also starts from every
 * argument of a BARE call that is itself a preset write (`Evaluate(Continue, S)`), and from each
 * argument of a call to a same-object preset writer whose parameter that writer itself feeds
 * (`SetContinue(Tmp)` with `Continue := B`; `writerFedArgs`). Never from `Obj.Proc(Continue, H)`,
 * and never from an argument of another object's function in a right side (`r568StopsAt`: an
 * object-typed receiver or a project table procedure; `Continue := Fmt.Bill(A, B)` with `Fmt` a
 * codeunit feeds `Fmt`, not `A` or `B`; a platform method's arguments do feed), nor from a parameter a writer only hands to `Obj.Proc(...)`: a value that
 * reaches the name through another object's function is the cross-object part R532 closed by ruling
 * (seeding there cost BaseApp 67 more mutants than the built rule). Shape 1 treats a feed as a write.
 * By name: a same-named variable written after the preset write is refused too (the safe direction).
 * Not seen (R532's residuals): a record method that changes what the write reads (`Buf.Insert`
 * before `Continue := not Buf.IsEmpty()`), the other arguments of a feeding call, and every value
 * that comes from another procedure or object (closed by ruling in R532).
 */
function presetFeeds(
  scope: ALSyntaxNode,
  names: ReadonlySet<string>,
  w: PresetWriters,
  ctx: SemanticContext,
): { readonly assigns: ReadonlySet<number>; readonly names: ReadonlySet<string> } {
  const key = `${scope.startIndex}|${scope.endIndex}`;
  // a writer already being read (recursion, or a cycle of writers) feeds nothing
  if (r532Reading.has(key)) return { assigns: new Set<number>(), names: new Set<string>() };
  // Only the outermost call caches: a result computed while another writer is in progress saw that
  // writer as feeding nothing, so caching it would make the answer depend on visit order.
  // ponytail: nested writers are recomputed per outermost call; memoize per object if chains get deep
  const outermost = r532Reading.size === 0;
  r532Reading.add(key);
  try {
    return outermost
      ? cached(ctx, scope, "r532feeds", () => presetFeedsOnce(scope, names, w, ctx))
      : presetFeedsOnce(scope, names, w, ctx);
  } finally {
    r532Reading.delete(key);
  }
}

const r532Reading = new Set<string>();

function presetFeedsOnce(
  scope: ALSyntaxNode,
  names: ReadonlySet<string>,
  w: PresetWriters,
  ctx: SemanticContext,
): { readonly assigns: ReadonlySet<number>; readonly names: ReadonlySet<string> } {
  const rights: ALSyntaxNode[] = [];
  visitAll(scope, (n) => {
    if (armOfNode(ctx, n) === "inactive") return;
    if (n.rawKind === "call_expression" || n.rawKind === "call_statement") {
      // R567: comments are not arguments; unreadable positions seed every argument (the safe side)
      const args = argumentList(n);
      if (bareCallee(n) !== null && directWrite(n, names, ctx)) rights.push(...args);
      else if (callsPresetWriter(n, w, ctx, names.size > 0)) {
        const fedAt = argumentsReadable(n) ? writerFedArgs(n, names, w, ctx) : () => true;
        rights.push(...args.filter((_, i) => fedAt(i)));
      }
      return;
    }
    if (n.rawKind !== "assignment_statement") return;
    const l = n.childForFieldName("left");
    const r = n.childForFieldName("right");
    if (l !== null && r !== null && names.has(rootName(l))) rights.push(r, ...exprTails(n));
  });
  const fed = new Set<string>();
  if (rights.length === 0) return { assigns: new Set<number>(), names: fed };
  const assigns = new Set(r531Feeds(scope, rights, ctx, fed).map((a) => a.startIndex));
  return { assigns, names: fed };
}

/**
 * R532: which arguments of `n`, a call to a same-object preset writer, seed the feed search: those
 * whose parameter the writer itself feeds into a preset write (its own `presetFeeds` names), so a
 * `Hdr` the writer only hands to another object's function is not one. Every argument when the
 * callee does not resolve to exactly one procedure of this object (the safe direction).
 */
function writerFedArgs(
  n: ALSyntaxNode,
  names: ReadonlySet<string>,
  w: PresetWriters,
  ctx: SemanticContext,
): (i: number) => boolean {
  const c = bareCallee(n) ?? hiddenCallee(n, w.known, ctx);
  const obj = objectOf(n);
  const procs: ALSyntaxNode[] = [];
  if (c !== null && obj !== null)
    visitAll(obj, (p) => {
      if ((isProcedureLike(p) || p.rawKind === "procedure") && procNames(p).includes(c))
        procs.push(p);
    });
  const [p] = procs;
  if (procs.length !== 1 || p === undefined) return () => true;
  const fed = presetFeeds(p, names, w, ctx).names;
  return (i) => {
    const q = r531Param(p, i);
    return q !== null && fed.has(q[0]);
  };
}

/** An assignment's `#if` expression tails (R480 `indirectFeeds` follows them). */
const exprTails = (a: ALSyntaxNode): ALSyntaxNode[] =>
  a.namedChildren.filter((c) => c.rawKind === "preproc_conditional_expression_tail");

/** R500 shape 1's direct write of a name in `names`: an assignment to it, or a call that passes it
 *  to a `var` parameter (an unresolved callee counts as writing, the safe direction on this side). */
function directWrite(n: ALSyntaxNode, names: ReadonlySet<string>, ctx: SemanticContext): boolean {
  if (n.rawKind === "assignment_statement") {
    const l = n.childForFieldName("left");
    return l !== null && names.has(rootName(l));
  }
  if (n.rawKind === "call_expression" || n.rawKind === "call_statement") {
    // unreadable positions (R567): a passed name counts as written, the safe direction here
    const readable = argumentsReadable(n);
    return argumentList(n).some(
      (a, i) =>
        isIdentifierLike(a) &&
        names.has(normalizeAlName(a.text)) &&
        (!readable || argWritten(n, i, ctx, true)),
    );
  }
  return false;
}

interface PresetWriters {
  /** every name of every writer procedure */
  readonly procs: ReadonlySet<string>;
  /** every procedure name the scanned objects declare */
  readonly known: ReadonlySet<string>;
  /** names an UNPARSED base candidate declares as `procedure <name>` (a reportextension only) */
  readonly unreadProcs: ReadonlySet<string>;
  /** names declared as `procedure <name>` inside an ERROR descendant of a parse-damaged report */
  readonly damagedProcs: ReadonlySet<string>;
}

/**
 * R555: the procedures whose call writes a preset exit name: a procedure with a `directWrite` of
 * one, or a call (`bareCallee`, `hiddenCallee`, the shapes `openReachable` follows) to such a
 * procedure, to a fixpoint. In a report: its own procedures over `names`. In a reportextension: its
 * own over `names`, plus every base candidate's (`baseCandidatesOf`) over `names` and that base's
 * own `presetExitNames`, since a base procedure can write a base-private name the extension cannot
 * spell. `names` must be the object's own (`presetExitNames` / `extensionPresetExitNames`): the
 * result is cached per object.
 */
function presetWriters(
  obj: ALSyntaxNode,
  names: ReadonlySet<string>,
  ctx: SemanticContext,
): PresetWriters {
  return cached(ctx, obj, "presetwriters", () => {
    const bases =
      obj.rawKind === "reportextension_declaration"
        ? baseCandidatesOf(obj, ctx)
        : { objs: [], unread: [] };
    const scans = [
      { o: obj, ns: names },
      ...bases.objs.map((b) => ({ o: b, ns: new Set([...names, ...presetExitNames(b, ctx)]) })),
    ];
    const known = new Set<string>();
    for (const { o } of scans) for (const k of procedureNamesOf(o, ctx)) known.add(k);
    const procs: { names: string[]; direct: boolean; calls: string[] }[] = [];
    for (const { o, ns } of scans) {
      visitAll(o, (p) => {
        if (!isProcedureLike(p) && p.rawKind !== "procedure") return;
        let direct = false;
        const calls: string[] = [];
        visitAll(p, (n) => {
          if (!direct && ns.size > 0 && directWrite(n, ns, ctx)) direct = true;
          const c = bareCallee(n) ?? hiddenCallee(n, known, ctx);
          if (c !== null) calls.push(c);
        });
        procs.push({ names: procNames(p), direct, calls });
      });
    }
    const out = new Set<string>();
    for (let changed = true; changed; ) {
      changed = false;
      for (const p of procs) {
        if (p.names.every((k) => out.has(k))) continue;
        if (p.direct || p.calls.some((c) => out.has(c))) {
          for (const k of p.names) out.add(k);
          changed = true;
        }
      }
    }
    const unreadProcs = new Set<string>();
    for (const u of bases.unread)
      for (const k of declaredProcedureNames(u.text)) unreadProcs.add(k);
    const damagedProcs = new Set<string>();
    if (obj.rawKind === "report_declaration" && obj.hasError)
      visitAll(obj, (n) => {
        if (n.rawKind === "ERROR")
          for (const k of declaredProcedureNames(n.text)) damagedProcs.add(k);
      });
    return { procs: out, known, unreadProcs, damagedProcs };
  });
}

/**
 * R555: does `n` call a preset writer of its own object (`w`)? Also, an unknown callee (no parsed
 * procedure declares it) that may be a writer the parse could not read: in a reportextension, one
 * an unparsed base candidate declares (`procedure <name>`); in a parse-damaged report with preset
 * names (`hasNames`), one declared inside an ERROR descendant. Any other unknown bare name is a
 * built-in, which cannot write a report global (as `argWritten` reads built-ins).
 */
function callsPresetWriter(
  n: ALSyntaxNode,
  w: PresetWriters,
  ctx: SemanticContext,
  hasNames: boolean,
): boolean {
  const c = bareCallee(n) ?? hiddenCallee(n, w.known, ctx);
  if (c === null) return false;
  if (w.procs.has(c)) return true;
  if (w.known.has(c)) return false;
  return w.unreadProcs.has(c) || (hasNames && w.damagedProcs.has(c));
}

/**
 * R555 (F5): the names `text` declares as `procedure <name>` (two tokens in sequence), comments
 * masked. Matching the bare token instead would make `Error`, `Message` or `Format` a writer
 * wherever an unread text mentions them. A match inside a string only adds a refusal.
 */
function declaredProcedureNames(text: string): Set<string> {
  const out = new Set<string>();
  let prev = "";
  const code = maskAlNonCode(text, { blankStringContents: false });
  for (const m of code.matchAll(/"([^"\n]*)"|[\p{L}_][\p{L}\p{N}_]*/gu)) {
    const t = (m[1] ?? m[0]).toLowerCase();
    if (prev === "procedure") out.add(t);
    prev = t;
  }
  return out;
}

const crossWritersMemo = new WeakMap<object, CrossWriters>();
interface CrossWriters {
  /** report name -> the writers callable through `Report <name>` */
  readonly byReport: ReadonlyMap<string, ReadonlySet<string>>;
  /** the writers of reportextensions with no readable base name: callable through any report */
  readonly anyReport: ReadonlySet<string>;
  /** every such writer name (a cheap prefilter) */
  readonly all: ReadonlySet<string>;
}

/**
 * R555: per report name, the preset writers a `Report X` receiver can call: every project report
 * named X (`presetWriters` over its own names) and every project reportextension of X (over the
 * extension's names, base candidates included): alc 18.0.43 binds an extension procedure through a
 * `Report X` variable from a codeunit (the R555 probe, AL0432 at the call). An extension with no
 * readable base name counts for every report, the safe direction.
 */
function crossWriters(ctx: SemanticContext): CrossWriters {
  const hit = crossWritersMemo.get(ctx);
  if (hit !== undefined) return hit;
  const byReport = new Map<string, Set<string>>();
  const anyReport = new Set<string>();
  const add = (key: string | null, ws: ReadonlySet<string>): void => {
    if (ws.size === 0) return;
    let s = anyReport;
    if (key !== null) {
      s = byReport.get(key) ?? new Set();
      byReport.set(key, s);
    }
    for (const k of ws) s.add(k);
  };
  // names and ids, so neither spelling of a project report is looked up outside
  const projectReports = new Set<string>();
  for (const o of projectObjects(ctx)) {
    if (o.rawKind === "report_declaration") {
      projectReports.add(objectNameOf(o));
      const id = o.childForFieldName("object_id")?.text;
      if (id !== undefined) projectReports.add(id);
      add(objectNameOf(o), presetWriters(o, presetExitNames(o, ctx), ctx).procs);
    } else if (o.rawKind === "reportextension_declaration")
      add(extendedBaseName(o), presetWriters(o, extensionPresetExitNames(o, ctx), ctx).procs);
  }
  // R565: every `Report X` type in the project whose X (a name or an id) is not a project report:
  // X's source and its dependency reportextensions, read from the packages (`dependencyReport`),
  // each object over its own names in X's own context. Their writers are keyed by X as spelled,
  // which is what `declaredType` answers for the receiver.
  const dep = ctx.dependencyReport;
  if (dep !== undefined) {
    const outside = new Set<string>();
    for (const o of projectObjects(ctx))
      visitAll(o, (n) => {
        if (
          n.rawKind === "object_reference_type" &&
          normalizeAlName(n.childForFieldName("object_type")?.text ?? "") === "report"
        ) {
          const x = normalizeAlName(lastFieldChild(n, "reference")?.text ?? "");
          if (x !== "" && !projectReports.has(x)) outside.add(x);
        }
      });
    for (const x of [...outside].sort()) {
      const got = dep(x);
      if (got === null) continue;
      for (const root of got.roots)
        for (const r of objectDeclarationsOf(root)) {
          if (r.rawKind === "report_declaration" && objectNameOf(r) === got.name)
            add(x, presetWriters(r, presetExitNames(r, got.ctx), got.ctx).procs);
          // the reader picked these files by their symbols' `Target`, whatever spelling the AL uses
          else if (r.rawKind === "reportextension_declaration")
            add(x, presetWriters(r, extensionPresetExitNames(r, got.ctx), got.ctx).procs);
        }
    }
  }
  const all = new Set<string>(anyReport);
  for (const s of byReport.values()) for (const k of s) all.add(k);
  const out: CrossWriters = { byReport, anyReport, all };
  crossWritersMemo.set(ctx, out);
  return out;
}

/**
 * R555: `Rep.M(...)` in any object, where `Rep` is declared `Report X` (a variable or a parameter,
 * `Sender` in a subscriber too: `declaredType`) and `M` is one of X's writers (`crossWriters`).
 * `CurrReport.M()` and `this.M()` are the same-object shapes `callsPresetWriter` reads. The report
 * lookup is local to this rule: `objectsOfType` stays `[]` for kind `report`.
 */
function crossWriterCall(n: ALSyntaxNode, ctx: SemanticContext): boolean {
  if (n.rawKind !== "call_expression" && n.rawKind !== "call_statement") return false;
  const f = n.childForFieldName("function");
  if (f === null || f.rawKind !== "member_expression") return false;
  const m = normalizeAlName(f.childForFieldName("member")?.text ?? "");
  const cw = crossWriters(ctx);
  if (!cw.all.has(m)) return false;
  const recv = f.childForFieldName("object");
  if (recv === null || !isIdentifierLike(recv)) return false;
  const t = declaredType(recv, ctx);
  if (t === null || t.kind !== "report") return false;
  return cw.byReport.get(t.name)?.has(m) === true || cw.anyReport.has(m);
}

/** The one exit set `isEarlyExit` and R530's feed rule (`inSelfInsertItem`) share: `exit`, an
 *  `Error` outside `asserterror`, and `CurrReport.Break/Skip/Quit` (the bare member form too). */
function endsScope(x: ALSyntaxNode, scope: ALSyntaxNode): boolean {
  return (
    x.rawKind === "exit_statement" ||
    isRaisedError(x, scope) ||
    (x.rawKind === "member_expression" &&
      REPORT_INSTANCES.has(normalizeAlName(x.childForFieldName("object")?.text ?? "")) &&
      EARLY_EXITS.has(normalizeAlName(x.childForFieldName("member")?.text ?? "")))
  );
}

/** An exit that can stop the rest of `scope`: `exit`, `CurrReport.Break/Quit/Skip` (and the XMLport
 *  twins), an `Error` outside `asserterror`, or a guard statement whose branches hold one. */
function isEarlyExit(n: ALSyntaxNode, scope: ALSyntaxNode): boolean {
  const exits = (x: ALSyntaxNode): boolean => endsScope(x, scope);
  const fn =
    n.rawKind === "call_expression" || n.rawKind === "call_statement"
      ? n.childForFieldName("function")
      : null;
  if (exits(n) || (fn !== null && exits(fn))) return true;
  const field = GUARDED.get(n.rawKind);
  if (field === undefined) return false;
  const cond = n.childForFieldName(field);
  let found = false;
  visitAll(n, (x) => {
    if (cond !== null && x.startIndex >= cond.startIndex && x.endIndex <= cond.endIndex) return;
    if (exits(x)) found = true;
  });
  return found;
}

const EARLY_EXITS: ReadonlySet<string> = new Set(["quit", "break", "skip"]);

/** Built-in functions that write their first argument. */
const WRITING_BUILTINS: ReadonlySet<string> = new Set(["clear", "evaluate"]);

/**
 * Does call `c` write its argument at position `i`? Yes for a `var` parameter of a project
 * procedure it resolves to (same object, a reportextension's base report candidates for a bare name
 * (R548), or through `callTargets`), or for a writing built-in; no for
 * a by-value parameter, another built-in, or a record method. `unknown` answers for a project-style
 * call whose target cannot be found.
 */
function argWritten(c: ALSyntaxNode, i: number, ctx: SemanticContext, unknown: boolean): boolean {
  const f = c.childForFieldName("function");
  if (f === null) return unknown;
  const procs: ALSyntaxNode[] = [];
  const own = bareCallee(c);
  const obj = objectOf(c);
  const collect = (o: ALSyntaxNode, name: string): void => {
    visitAll(o, (p) => {
      if ((isProcedureLike(p) || p.rawKind === "procedure") && procNames(p).includes(name))
        procs.push(p);
    });
  };
  const isVarAt = (p: ALSyntaxNode): boolean => {
    const params = (p.childForFieldName("parameters")?.namedChildren ?? []).filter(
      (x) => x.rawKind === "parameter",
    );
    return params[i]?.childForFieldName("modifier")?.rawKind === "var_keyword";
  };
  if (own !== null && obj !== null && procedureNamesOf(obj, ctx).has(own)) collect(obj, own);
  else if (own !== null && obj?.rawKind === "reportextension_declaration") {
    // R548 (F4): a bare name (or `this.P`) in a reportextension may be a BASE report procedure.
    // Candidates that disagree, or one that cannot be read, answer `unknown`.
    const { objs, unread } = baseCandidatesOf(obj, ctx);
    // R555 (F5): an unread base answers only for a name it declares as `procedure <name>`
    if (unread.some((o) => declaredProcedureNames(o.text).has(own))) return unknown;
    for (const o of objs) if (procedureNamesOf(o, ctx).has(own)) collect(o, own);
    if (procs.length === 0)
      return isIdentifierLike(f) ? WRITING_BUILTINS.has(own) && i === 0 : unknown;
    const answers = new Set(procs.map(isVarAt));
    return answers.size === 1 ? answers.has(true) : unknown;
  } else if (isIdentifierLike(f)) return WRITING_BUILTINS.has(normalizeAlName(f.text)) && i === 0;
  else {
    // ponytail: R737 guard, an ambiguous receiver reads `unknown`; R_amb = 0 on every corpus, so
    // no test; add one if the census ever finds one.
    const ambRecv = f.rawKind === "member_expression" ? f.childForFieldName("object") : null;
    if (ambRecv !== null && isIdentifierLike(ambRecv) && declaredTypes(ambRecv, ctx).length > 1)
      return unknown;
    const t = callTargets(c, ctx);
    if (t === null) {
      // a record method on a record receiver writes no argument; anything else is unknown
      const recv = f.childForFieldName("object");
      const dt = recv === null || !isIdentifierLike(recv) ? null : declaredType(recv, ctx);
      return dt?.kind === "table" ? false : unknown;
    }
    for (const o of t.objs) collect(o, t.member);
    if (procs.length === 0) return t.kind === "record" ? false : unknown;
  }
  if (procs.length === 0) return unknown;
  return procs.some(isVarAt);
}

/** The variable an assignment target writes: its LEFTMOST identifier node (`X`, `X.F`, `X[i]`,
 *  `"No. of Lines".F`), read from the tree, never by splitting text. */
function rootName(n: ALSyntaxNode): string {
  let c: ALSyntaxNode | undefined = n;
  while (c !== undefined && !isIdentifierLike(c)) c = c.namedChildren[0];
  return c === undefined ? "" : normalizeAlName(c.text);
}

/** R548: a reportextension's preset exit names (see `writesPresetExitName`). */
function extensionPresetExitNames(ext: ALSyntaxNode, ctx: SemanticContext): Set<string> {
  return cached(ctx, ext, "extpresetexit", () => {
    const { objs, unread } = baseCandidatesOf(ext, ctx);
    const prot = new Set<string>();
    const out = new Set<string>();
    for (const b of [...objs, ...unread]) {
      const p = protectedVarNames(b);
      for (const n of p) prot.add(n);
      for (const n of presetExitNames(b, ctx)) if (p.has(n)) out.add(n);
    }
    for (const n of presetExitNames(ext, ctx, prot)) out.add(n);
    return out;
  });
}

/** R500 shape 1: an object's preset exit names (see `writesPresetExitName`). Exported for the R555
 *  test that asserts a parse-damaged report still has some (internal). */
export function presetExitNames(
  obj: ALSyntaxNode,
  ctx: SemanticContext,
  inherited: ReadonlySet<string> = new Set(),
): Set<string> {
  return cached(ctx, obj, "presetexit", () => {
    const globals = new Set<string>(inherited);
    for (const c of obj.childForFieldName("body")?.namedChildren ?? []) {
      if (c.rawKind !== "var_section") continue;
      visitAll(c, (v) => {
        if (v.rawKind === "variable_declaration")
          for (const nm of declaredNames(v)) globals.add(normalizeAlName(nm));
      });
    }
    const reads = new Set<string>();
    const written = new Set<string>();
    const readAll = (n: ALSyntaxNode): void =>
      visitAll(n, (x) => {
        if (isIdentifierLike(x) && x.fieldName !== "member") reads.add(normalizeAlName(x.text));
      });
    // exit guards and bounds in EVERY open-item scope: the open items' triggers (Date items
    // included) and the same-object procedures they reach
    visitAll(obj, (s) => {
      if (s.rawKind !== "trigger_declaration" && !isProcedureLike(s) && s.rawKind !== "procedure")
        return;
      const body = s.childForFieldName("body");
      if (body === null || !inOpenItemCode(body, ctx)) return;
      visitAll(s, (g) => {
        const field = GUARDED.get(g.rawKind);
        if (field !== undefined && guardHoldsExit(g, s)) {
          const cond = g.childForFieldName(field);
          if (cond !== null) readAll(cond);
        }
        if (g.rawKind !== "call_expression" && g.rawKind !== "call_statement") return;
        const f = g.childForFieldName("function");
        const m = normalizeAlName(f?.childForFieldName("member")?.text ?? f?.text ?? "");
        if (m !== "setrange" && m !== "setfilter") return;
        for (const a of argumentList(g).slice(1)) readAll(a);
      });
    });
    visitAll(obj, (n) => {
      if (n.rawKind === "assignment_statement" && inOpenItemCode(n, ctx)) {
        const l = n.childForFieldName("left");
        if (l !== null) written.add(rootName(l));
      }
      if (
        (n.rawKind === "call_expression" || n.rawKind === "call_statement") &&
        inOpenItemCode(n, ctx)
      ) {
        // an argument is a write only for a var parameter or a writing built-in (unknown, or
        // unreadable positions (R567): no, which keeps the name preset: the safe direction here)
        if (argumentsReadable(n))
          argumentList(n).forEach((a, i) => {
            if (isIdentifierLike(a) && argWritten(n, i, ctx, false))
              written.add(normalizeAlName(a.text));
          });
        const f = n.childForFieldName("function");
        const o = f?.rawKind === "member_expression" ? f.childForFieldName("object") : null;
        if (o !== null && o !== undefined && isIdentifierLike(o))
          written.add(normalizeAlName(o.text));
      }
      if (
        (n.rawKind === "for_statement" || n.rawKind === "foreach_statement") &&
        inOpenItemCode(n, ctx)
      ) {
        const v = n.childForFieldName("variable") ?? n.namedChildren[0];
        if (v !== undefined && v !== null) written.add(normalizeAlName(v.text));
      }
    });
    return new Set([...reads].filter((r) => globals.has(r) && !written.has(r)));
  });
}

/**
 * R500 shape 5b: a filter call on an OPEN loop item's own record made from OUTSIDE the item's code
 * (`Loop.SetRange(Number, 1, N)` in OnPreReport or a parent item). The item is open (any outside
 * mention voids its certificates), and that call may be its real bound: a site that contains it or
 * sits inside it is refused.
 */
function altersOpenItemFilter(node: ALSyntaxNode, ctx: SemanticContext): boolean {
  const obj = objectOf(node);
  if (obj === null) return false;
  const calls = cached(ctx, obj, "outsidefilters", () => {
    const open = new Set<string>();
    visitAll(obj, (n) => {
      // R530 (M6): a self-inserting report data item counts like an open one
      if (
        isLoopItem(n) &&
        (itemOpen(n, ctx) || (n.rawKind === "report_dataitem" && selfInserts(n, ctx)))
      )
        open.add(normalizeAlName(n.childForFieldName("name")?.text ?? ""));
    });
    const out: ALSyntaxNode[] = [];
    if (open.size === 0) return out;
    visitAll(obj, (c) => {
      if (c.rawKind !== "call_expression" && c.rawKind !== "call_statement") return;
      const f = c.childForFieldName("function");
      if (f === null || f.rawKind !== "member_expression") return;
      const o = normalizeAlName(f.childForFieldName("object")?.text ?? "");
      const m = normalizeAlName(f.childForFieldName("member")?.text ?? "");
      if (open.has(o) && ITEM_FILTERS.has(m) && !inOpenItemCode(c, ctx)) out.push(c);
    });
    return out;
  });
  return calls.some(
    (c) =>
      (node.startIndex <= c.startIndex && c.endIndex <= node.endIndex) ||
      (c.startIndex <= node.startIndex && node.endIndex <= c.endIndex),
  );
}

const ITEM_FILTERS: ReadonlySet<string> = new Set([
  "setrange",
  "setfilter",
  "setview",
  "reset",
  "copyfilter",
  "copyfilters",
]);

/**
 * R500 shape 3 (a stated LIMIT). A data item over an ordinary table ends when its records end,
 * unless its own code inserts into the table it walks (Date Compress: new entries land after the
 * cursor, and only a `SetRange("Entry No.", 0, LastEntryNo)` keeps the walk off them). In such an
 * item, a site that deletes or alters (contains, or sits inside) a filter call on the item's own
 * record in its OnPreDataItem is refused. "Inserts into its own table": an unqualified `Insert` in
 * the item's triggers, or `X.Insert` where `X` is declared `Record <the item's table>` and NOT
 * temporary, or is a record the engine binds to that table (`resolveReceiverTable`: a data item's
 * name), in the item's triggers or a same-object procedure they reach. This rule covers only the
 * OnPreDataItem filter; the rest of such an item (its other sites, the writers of a name its exit
 * guard reads, an outside filter call) is `inSelfInsertItem` (R530). Not seen: an insert made in
 * another object (R529, closed by ruling).
 */
function altersSelfInsertFilter(node: ALSyntaxNode, ctx: SemanticContext): boolean {
  const s = codeScope(node);
  if (s === null || s.rawKind !== "trigger_declaration" || triggerName(s) !== "onpredataitem")
    return false;
  let item: ALSyntaxNode | null = null;
  for (let p = s.parent; p !== null && item === null; p = p.parent) {
    if (p.rawKind === "report_dataitem") item = p;
  }
  if (item === null) return false;
  const table = itemTable(item);
  if (table === "integer" || table === "date") return false;
  const name = normalizeAlName(item.childForFieldName("name")?.text ?? "");
  let hit = false;
  visitAll(s, (c) => {
    if (hit || (c.rawKind !== "call_expression" && c.rawKind !== "call_statement")) return;
    const f = c.childForFieldName("function");
    if (f === null) return;
    const own =
      (isIdentifierLike(f) && ITEM_FILTERS.has(normalizeAlName(f.text))) ||
      (f.rawKind === "member_expression" &&
        normalizeAlName(f.childForFieldName("object")?.text ?? "") === name &&
        ITEM_FILTERS.has(normalizeAlName(f.childForFieldName("member")?.text ?? "")));
    if (!own) return;
    const contains = node.startIndex <= c.startIndex && c.endIndex <= node.endIndex;
    const inside = c.startIndex <= node.startIndex && node.endIndex <= c.endIndex;
    if (contains || inside) hit = true;
  });
  return hit && selfInserts(item, ctx);
}

/**
 * The item's own triggers (first), then the same-object procedures they reach, transitively. The
 * closure follows every call shape `openReachable` follows (`P()`, `this.P()`, `CurrReport.P()`, a
 * bare name in an expression; R530, S4). That also widens `selfInserts`' own insert detection: a
 * helper reached only by `CurrReport.P()` or a bare name now counts, so shape 3 may refuse a few more
 * OnPreDataItem filters than before.
 */
function itemScopes(item: ALSyntaxNode, ctx: SemanticContext): ALSyntaxNode[] {
  const obj = objectOf(item);
  const body = item.childForFieldName("body");
  if (obj === null || body === null) return [];
  const names = procedureNamesOf(obj, ctx);
  const scopes: ALSyntaxNode[] = itemMembers(body, ctx).filter(
    (m) => m.kind === ALNodeKind.trigger,
  );
  const seen = new Set<string>();
  for (let i = 0; i < scopes.length; i++) {
    const sc = scopes[i];
    if (sc === undefined) continue;
    visitAll(sc, (c) => {
      const callee = bareCallee(c) ?? hiddenCallee(c, names, ctx);
      if (callee === null || seen.has(callee)) return;
      seen.add(callee);
      visitAll(obj, (p) => {
        if ((isProcedureLike(p) || p.rawKind === "procedure") && procNames(p).includes(callee))
          scopes.push(p);
      });
    });
  }
  return scopes;
}

function selfInserts(item: ALSyntaxNode, ctx: SemanticContext): boolean {
  return cached(ctx, item, "selfins", () => {
    const table = itemTable(item);
    const scopes = itemScopes(item, ctx);
    return scopes.some((sc) => {
      let found = false;
      visitAll(sc, (c) => {
        if (found || (c.rawKind !== "call_expression" && c.rawKind !== "call_statement")) return;
        const f = c.childForFieldName("function");
        if (f === null) return;
        if (
          sc.kind === ALNodeKind.trigger &&
          isIdentifierLike(f) &&
          normalizeAlName(f.text) === "insert"
        )
          found = true;
        if (f.rawKind !== "member_expression") return;
        if (normalizeAlName(f.childForFieldName("member")?.text ?? "") !== "insert") return;
        const recv = f.childForFieldName("object");
        const t = recv === null || !isIdentifierLike(recv) ? null : declaredType(recv, ctx);
        if (t !== null && t.kind === "table" && !t.temporary && t.name === table) found = true;
        // a data item's own name (`Entry.Insert()`), which `declaredType` cannot type: the record
        // the engine binds, as `callTargets` reads it
        if (t === null && normalizeAlName(resolveReceiverTable(c, ctx) ?? "") === table)
          found = true;
        // R725: an Insert on a receiver the engine refuses to resolve may be a self-insert (fail
        // closed, as R720)
        if (
          !found &&
          t === null &&
          recv !== null &&
          isIdentifierLike(recv) &&
          r725Seam.on &&
          resolveReceiverTable(c, ctx) === null &&
          declarationStateAt(recv, ctx) === "unknown"
        )
          found = true;
      });
      return found;
    });
  });
}

/**
 * R530 (shape 3, widened). A report data item that inserts into its own table (`selfInserts`; not
 * an `Integer` or `Date` item) can walk the rows it adds. Refused, for every operator:
 * (a) every site in the item's own triggers and the same-object procedures they reach
 *     (`itemScopes`);
 * (b) the writers, OUTSIDE that scope and anywhere in the report object, of any name an exit guard
 *     in the scope reads (`endsScope`): an assignment to it, or ANY call that passes the name as an
 *     argument (fail closed: a callee that is not in the project, such as `GetLastEntry(LastEntryNo, ...)`,
 *     is still refused). A site that contains or sits inside such a writer is refused.
 * (c) an outside filter call on such an item is refused in `altersOpenItemFilter`.
 *     An argument counts by its root name (`GetLast(Setup."Last Entry No.")` passes `Setup`).
 * Not seen: an insert made in another object (R529, closed by ruling), a bound set only by a
 * reportextension `modify()` trigger, a `with` receiver, and the body of a feed call's same-object
 * callee (only the call is refused). Over-refusal: a field name an exit guard reads (`"Entry No."`)
 * also counts as a feed name, about 3 sites in a 19-report sample. Cost and mechanisms: measure.md, R530.
 */
function inSelfInsertItem(node: ALSyntaxNode, ctx: SemanticContext): boolean {
  const obj = objectOf(node);
  if (obj === null) return false;
  const { scope, feeds } = cached(ctx, obj, "selfinsscope", () => {
    const scope: { s: number; e: number }[] = [];
    const names = new Set<string>();
    visitAll(obj, (item) => {
      if (item.rawKind !== "report_dataitem") return;
      const t = itemTable(item);
      if (t === "integer" || t === "date" || !selfInserts(item, ctx)) return;
      for (const sc of itemScopes(item, ctx)) {
        scope.push({ s: sc.startIndex, e: sc.endIndex });
        for (const g of exitGuards(sc, sc, (x) => endsScope(x, sc)))
          visitAll(g, (x) => {
            if (isIdentifierLike(x)) names.add(normalizeAlName(x.text));
          });
      }
    });
    const feeds: { s: number; e: number }[] = [];
    if (names.size === 0) return { scope, feeds };
    visitAll(obj, (n) => {
      if (scope.some((r) => r.s <= n.startIndex && n.endIndex <= r.e)) return;
      let feed = false;
      if (n.rawKind === "assignment_statement") {
        const l = n.childForFieldName("left");
        feed = l !== null && names.has(rootName(l));
      } else if (n.rawKind === "call_expression" || n.rawKind === "call_statement") {
        // unreadable arguments (a pragma among them): fail closed
        feed = !argumentsReadable(n) || argumentList(n).some((a) => names.has(rootName(a)));
      }
      if (feed) feeds.push({ s: n.startIndex, e: n.endIndex });
    });
    return { scope, feeds };
  });
  return (
    scope.some((r) => r.s <= node.startIndex && node.endIndex <= r.e) ||
    feeds.some(
      (r) =>
        (node.startIndex <= r.s && r.e <= node.endIndex) ||
        (r.s <= node.startIndex && node.endIndex <= r.e),
    )
  );
}

/**
 * R696: a test-only seam. Tests and cost measurements switch `on` off to get master's behaviour.
 */
export const r696Seam = { on: true };

/**
 * R696. A loop that MOVES THE RECORD IT WALKS. Measured on bc2 (probe results, pre-commitment
 * a67f292f): `Next` sees a row that a SECOND variable of the walked table moved ahead of the cursor
 * (a Rename, or a Modify that changed a field of the current sort key), or that an insert put ahead
 * of it, under `FindSet`, `FindSet(true)` and `Find('-')`, in code and in a report data item. A move
 * by the walked variable's own Modify never revisits a row. So the walk ends only because an exit
 * works, and a mutant that removes the exit (or a `CurrReport.Skip`) never ends. Refused, for every
 * operator, as R531 does (a site inside a span, or containing one inside its limit):
 *
 * SHAPE B, a `repeat .. until R.Next() ..` or `while R.Next() .. do` loop (any object) over a
 * non-temporary R, whose BODY holds a mover: `Rename` on a non-temporary variable of R's table (R
 * itself too: no Rename leg was probed); `ModifyAll(F, ..)` with F in R's sort key (R too);
 * `Insert` on such a variable (R too); `Modify` on another such variable after a write of a field of
 * R's sort key or of the whole record (`V.F :=`, `V.Validate(F, ..)`, `TransferFields`, `V := X`,
 * `Copy`, `Init`); the implicit Rec counts as that other variable when R is a local. Refused: the
 * exits that leave the walk and their guards; the mover and its writes; the pre-loop filter calls on
 * R (`SetRange`, `SetFilter`, `SetCurrentKey`, `Copy*`, `SetView`, `Reset`; one inside an enclosing
 * loop counts as pre-loop), the guards around them; and the assignments that feed all of these
 * (`r531Feeds`). R's sort key: the primary key plus the union of every pre-loop `SetCurrentKey` on
 * R; EVERY field after a `SetView` or `Copy` on R, for a table the project does not declare, and
 * when R is a parameter, a global or the implicit Rec with no `SetCurrentKey` (the caller set it).
 *
 * SHAPE A, a report data item or XMLport table element over an ordinary table that R530 does not
 * already take: the same movers through another variable, or a one-hop callee (or `V.P()` on a
 * variable of the item's table) that inserts into the item's table. Refused: every site in the
 * item's triggers and the same-object procedures they reach, plus the filter calls on the item
 * anywhere in the object and their feeds. The key is the item's SORTING, a `SetCurrentKey` on it,
 * and the primary key.
 *
 * LIMITS, accepted: shape B follows no callee for a mover (R passed to a call is not followed;
 * R702 measured the callee case and closed it by ruling; R717 reads only whether a one-hop callee
 * or a bare same-object procedure INSERTS, for `r717Fixups`) and does not read a guard in a
 * helper; a bound set by
 * a caller; an XMLport self-insert item (outside R530 and this). R696 roadmap item, "Done". A
 * walk declared temporary is refused only through a variable sharing its rows (`r702Shared`,
 * R702); any other walk is refused through such a sharer too, as well as by the movers above.
 */
function inMovedWalk(node: ALSyntaxNode, ctx: SemanticContext): boolean {
  if (!r696Seam.on) return false;
  const obj = objectOf(node);
  if (obj === null) return false;
  return cached(ctx, obj, "r696spans", () => r696Spans(obj, ctx)).some(
    (sp) =>
      (sp.s <= node.startIndex && node.endIndex <= sp.e) ||
      (!sp.inside &&
        node.startIndex <= sp.s &&
        sp.e <= node.endIndex &&
        sp.limS <= node.startIndex &&
        node.endIndex <= sp.limE),
  );
}

/** A refused span: a site INSIDE it is refused; a site CONTAINING it and sitting inside its limit is
 *  refused too, unless `inside` (inside only, the R530 way). */
interface R696Span {
  readonly s: number;
  readonly e: number;
  readonly inside: boolean;
  readonly limS: number;
  readonly limE: number;
}
type R696Push = (n: ALSyntaxNode, limit: ALSyntaxNode | null, inside?: boolean) => void;

/** The sort key fields of a walk; "all" when it cannot be known (fail closed). */
type R696Keys = ReadonlySet<string> | "all";
const r696InKey = (k: R696Keys, f: string): boolean => k === "all" || f === "*" || k.has(f);

const R696_FILTER: ReadonlySet<string> = new Set([
  "setrange",
  "setfilter",
  "setcurrentkey",
  "copyfilters",
  "copyfilter",
  "copy",
  "setview",
  "setrecfilter",
  "reset",
]);
/** Calls that write the whole record. */
const R696_WHOLE: ReadonlySet<string> = new Set(["transferfields", "copy", "init"]);
const R696_MOVE: ReadonlySet<string> = new Set(["rename", "modify", "modifyall", "insert"]);

const r696IsCall = (n: ALSyntaxNode): boolean =>
  n.rawKind === "call_expression" || n.rawKind === "call_statement";

function r696Spans(obj: ALSyntaxNode, ctx: SemanticContext): R696Span[] {
  const out: R696Span[] = [];
  const push: R696Push = (n, limit, inside = false) => {
    out.push({
      s: n.startIndex,
      e: n.endIndex,
      inside,
      limS: limit?.startIndex ?? -1,
      limE: limit?.endIndex ?? -1,
    });
  };
  visitAll(obj, (n) => {
    if (isLoopItem(n)) r696Item(n, obj, ctx, push);
    else if (n.rawKind === "while_statement" || n.rawKind === "repeat_statement")
      r696Loop(n, ctx, push);
  });
  return out;
}

/** The primary key fields of a project table; null when the project does not declare it. */
function r696Pk(table: string, ctx: SemanticContext): Set<string> | null {
  const t = objectsOfType({ kind: "table", name: table, temporary: false }, ctx).find(
    (o) => o.rawKind === "table_declaration",
  );
  if (t === undefined) return null;
  return cached(ctx, t, "r696pk", () => {
    const first: Set<string>[] = [];
    visitAll(t, (k) => {
      if (first.length > 0 || k.rawKind !== "key_declaration") return;
      const list = k.namedChildren.find((c) => c.rawKind === "field_list");
      first.push(
        new Set(
          (list?.namedChildren ?? []).filter(isIdentifierLike).map((f) => normalizeAlName(f.text)),
        ),
      );
    });
    const [pk] = first;
    return pk === undefined || pk.size === 0 ? null : pk;
  });
}

/** The table a call's receiver names, and whether it is temporary: the declared type, else the
 *  record the engine binds (`resolveReceiverTable`: a data item's name, the implicit Rec), else,
 *  for a receiver whose declaration is "unknown" (R725), a wildcard that matches every table. */
function r696Table(call: ALSyntaxNode, ctx: SemanticContext): DeclaredType | null {
  const f = call.rawKind === "member_expression" ? call : call.childForFieldName("function");
  const recv = f?.rawKind === "member_expression" ? f.childForFieldName("object") : null;
  const ident = recv !== null && recv !== undefined && isIdentifierLike(recv) ? recv : null;
  const t = ident !== null ? declaredType(ident, ctx) : null;
  if (t !== null) return t.kind === "table" ? t : null;
  const name = resolveReceiverTable(call, ctx);
  if (name !== null) return { kind: "table", name: normalizeAlName(name), temporary: false };
  // R725: a receiver the engine refuses to resolve (a swallowed member, a var-section `#if`
  // global, an every-arm-ambiguous name) may be a record of any table: fail closed (R720).
  return ident !== null && r725Seam.on && declarationStateAt(ident, ctx) === "unknown"
    ? { kind: "table", name: R725_ANY_TABLE, temporary: false }
    : null;
}

/** R725: a test-only seam, as `r696Seam`; off restores reading an "unknown" name as absent. */
export const r725Seam = { on: true };
/** R737: a test-only seam; off restores `declaredType` as master read it (no descent into a var
 *  section's `#if`, first match only). */
export const r737Seam = { on: true };
/** R725: the table of a receiver whose declaration is "unknown"; it matches every table. */
const R725_ANY_TABLE = "\u0000unknown";
const sameTable = (a: string, b: string): boolean =>
  a === b || a === R725_ANY_TABLE || b === R725_ANY_TABLE;

/** The field a Validate/ModifyAll call names (`F` or `Rec.F`); "*" when unreadable. */
function r696Field(c: R531Call): string | null {
  if (c.uncertain) return "*";
  const a = c.args[0];
  if (a === undefined) return null;
  const m = a.rawKind === "member_expression" ? a.childForFieldName("member") : null;
  return normalizeAlName((m ?? a).text);
}

interface R696Write {
  readonly node: ALSyntaxNode;
  /** "*": the whole record */
  readonly field: string;
  /** what the write reads: feeds */
  readonly reads: ALSyntaxNode[];
}

/** The writes to variable `vkey` under `body`: `V.F :=`, a bare `F :=` (the implicit Rec),
 *  `V.Validate(F, ..)`, and the whole-record writes `V := X`, `TransferFields`, `Copy`, `Init`. */
function r696Writes(body: ALSyntaxNode, vkey: string, ctx: SemanticContext): R696Write[] {
  const out: R696Write[] = [];
  visitAll(body, (n) => {
    if (n.kind === ALNodeKind.assignment_statement) {
      const l = n.childForFieldName("left");
      const r = n.childForFieldName("right");
      if (l === null) return;
      const reads = r === null ? [] : [r];
      if (l.rawKind === "member_expression") {
        const m = l.childForFieldName("member");
        if (m !== null && r531Key(l.childForFieldName("object")) === vkey)
          out.push({ node: n, field: normalizeAlName(m.text), reads });
      } else if (isIdentifierLike(l)) {
        const isRec = normalizeAlName(l.text) === "rec";
        const declared = resolveVarRef(l, ctx) !== null;
        // R725: an "unknown" name is read BOTH ways: a variable's whole-record write, and a field
        // of the implicit Rec (fail closed)
        const unknown = !declared && r725Seam.on && declarationStateAt(l, ctx) === "unknown";
        if ((isRec || declared || unknown) && r531Key(l) === vkey)
          out.push({ node: n, field: "*", reads });
        if (!isRec && !declared && vkey === "")
          out.push({ node: n, field: normalizeAlName(l.text), reads });
      }
      return;
    }
    if (!r696IsCall(n)) return;
    const c = r531Call(n);
    if (c === null || (c.recv ?? (r531Implicit(n, ctx) ? "" : null)) !== vkey) return;
    if (c.method === "validate") {
      const f = r696Field(c);
      if (f !== null) out.push({ node: n, field: f, reads: [...c.args] });
    } else if (R696_WHOLE.has(c.method)) out.push({ node: n, field: "*", reads: [...c.args] });
  });
  return out;
}

interface R696Mover {
  readonly call: ALSyntaxNode;
  readonly writes: R696Write[];
}
interface R696Walk {
  /** the receiver keys that name the walked record */
  readonly rkeys: ReadonlySet<string>;
  readonly table: string;
  readonly keys: R696Keys;
  /** the walked variable's own Rename, ModifyAll and Insert move too (not its Modify) */
  readonly self: boolean;
  /** the implicit Rec is a variable other than the walked one */
  readonly recDistinct: boolean;
  /** R702: the variables sharing R's rows (`r702Shared`); a temporary one of them moves R too */
  readonly shared?: ReadonlySet<string>;
  /** R702: R is declared temporary, so ONLY a sharer moves it (not R itself, not a permanent one) */
  readonly temp?: boolean;
}

/** The movers under `body` (see `inMovedWalk`). */
function r696Movers(body: ALSyntaxNode, w: R696Walk, ctx: SemanticContext): R696Mover[] {
  const out: R696Mover[] = [];
  const writes = new Map<string, R696Write[]>();
  visitAll(body, (c) => {
    if (!r696IsCall(c)) return;
    const rc = r531Call(c);
    if (rc === null || !R696_MOVE.has(rc.method)) return;
    const vkey = rc.recv ?? (r531Implicit(c, ctx) ? "" : null);
    if (vkey === null || vkey.startsWith("\u0001")) return;
    const t = r696Table(c, ctx);
    if (t === null || !sameTable(t.name, w.table)) return;
    const viaShare = w.shared?.has(vkey) ?? false;
    if (!viaShare && (w.temp === true || t.temporary)) return;
    if (w.rkeys.has(vkey)) {
      if (!w.self || rc.method === "modify") return;
    } else if (rc.method === "modify" && vkey === "" && !w.recDistinct && !viaShare) return;
    if (rc.method === "rename") out.push({ call: c, writes: [] });
    else if (rc.method === "modifyall") {
      const f = r696Field(rc);
      if (f !== null && r696InKey(w.keys, f)) out.push({ call: c, writes: [] });
    } else {
      const all = writes.get(vkey) ?? r696Writes(body, vkey, ctx);
      writes.set(vkey, all);
      const before = all.filter((x) => x.node.startIndex < c.startIndex);
      if (rc.method === "insert") out.push({ call: c, writes: before });
      else {
        const keyed = before.filter((x) => r696InKey(w.keys, x.field));
        if (keyed.length > 0) out.push({ call: c, writes: keyed });
      }
    }
  });
  return out;
}

/** The `Next` call in a loop's condition, or null. */
function r696Next(loop: ALSyntaxNode): ALSyntaxNode | null {
  const hits: ALSyntaxNode[] = [];
  for (const p of loopConditionParts(loop))
    visitAll(p, (c) => {
      if (hits.length === 0 && r696IsCall(c) && r531Call(c)?.method === "next") hits.push(c);
    });
  return hits[0] ?? null;
}

/** The filter and key calls on `rkey` that run before `loop`: earlier in the text, or anywhere in a
 *  loop that encloses it (they run before its next pass). */
function r696PreFilters(
  scope: ALSyntaxNode,
  loop: ALSyntaxNode,
  rkey: string,
  ctx: SemanticContext,
): ALSyntaxNode[] {
  const enclosing: ALSyntaxNode[] = [];
  for (let a = loop.parent; a !== null && !samePos(a, scope); a = a.parent)
    if (BREAK_SCOPES.has(a.rawKind)) enclosing.push(a);
  const out: ALSyntaxNode[] = [];
  visitAll(scope, (n) => {
    if (!r696IsCall(n)) return;
    const c = r531Call(n);
    if (c === null || !R696_FILTER.has(c.method)) return;
    if ((c.recv ?? (r531Implicit(n, ctx) ? "" : null)) !== rkey) return;
    if (loop.startIndex <= n.startIndex && n.endIndex <= loop.endIndex) return;
    if (
      n.endIndex <= loop.startIndex ||
      enclosing.some((e) => e.startIndex <= n.startIndex && n.endIndex <= e.endIndex)
    )
      out.push(n);
  });
  return out;
}

/** The sort key of a walk: the primary key plus every `SetCurrentKey` field in `calls`; "all" after
 *  a `SetView`/`Copy`/`CopyFilters`, for a table the project lacks, and (`callerKey`) when nothing
 *  in this procedure set a key. */
function r696Keys(
  table: string,
  calls: ALSyntaxNode[],
  callerKey: boolean,
  ctx: SemanticContext,
): R696Keys {
  const pk = r696Pk(table, ctx);
  if (pk === null) return "all";
  const keys = new Set(pk);
  let set = false;
  for (const n of calls) {
    const c = r531Call(n);
    if (c === null) continue;
    if (c.method === "setcurrentkey") {
      set = true;
      if (c.uncertain) return "all";
      for (const a of c.args) keys.add(normalizeAlName(a.text));
    } else if (c.method === "setview" || c.method === "copy" || c.method === "copyfilters")
      return "all";
  }
  return callerKey && !set ? "all" : keys;
}

/** R702: a test-only seam, as `r696Seam`; off restores R696's skip of every temporary walk. */
export const r702Seam = { on: true };

/**
 * R702 gap 2. The variables that may share a temporary R's rows: those joined to R by a chain of
 * `A.Copy(B, true)` calls (either direction, through any third variable, in any order: a later
 * Copy can re-point a link, so this fails closed) that run before the walk, inside it, or inside
 * a loop that encloses it, as `r696PreFilters` reads order (the share
 * argument read as true unless absent or a literal `false`; any argument when they are
 * unreadable). Measured on bc2 (R702 probe, run 3): such an X moving a row's key ahead of the
 * cursor, or inserting ahead of it, keeps a temporary walk going; a by-value copy holds none of
 * R's rows, and R's own Modify and Insert never revisit. LIMITS: the Copy and the mover in one
 * procedure (a callee is not followed, as R696 shape B); a global X bound in another procedure;
 * an array element as sharer; R's own Rename and ModifyAll on a walk declared temporary (not
 * probed, not refused).
 */
function r702Shared(
  scope: ALSyntaxNode,
  loop: ALSyntaxNode,
  rkey: string,
  ctx: SemanticContext,
): Set<string> {
  const out = new Set<string>();
  if (!r702Seam.on) return out;
  const pairs: [string, string][] = [];
  const enclosing: ALSyntaxNode[] = [];
  for (let a = loop.parent; a !== null && !samePos(a, scope); a = a.parent)
    if (BREAK_SCOPES.has(a.rawKind)) enclosing.push(a);
  visitAll(scope, (n) => {
    if (!r696IsCall(n)) return;
    const c = r531Call(n);
    if (c === null || c.method !== "copy") return;
    if (
      n.endIndex > loop.endIndex &&
      !enclosing.some((e) => e.startIndex <= n.startIndex && n.endIndex <= e.endIndex)
    )
      return;
    const recv = c.recv ?? (r531Implicit(n, ctx) ? "" : null);
    // a literal or array-element key ("\u0001...", "\u0000") would chain unrelated variables
    const plain = (k: string | null): k is string => k !== null && !/^[\u0000\u0001]/.test(k);
    if (!plain(recv)) return;
    const share = c.args[1];
    if (!c.uncertain && (share === undefined || normalizeAlName(share.text) === "false")) return;
    for (const a of c.uncertain ? c.args : c.args.slice(0, 1)) {
      const k = r531Key(a);
      if (plain(k)) pairs.push([recv, k]);
    }
  });
  out.add(rkey);
  for (let grew = true; grew; ) {
    grew = false;
    for (const [a, b] of pairs)
      if (out.has(a) !== out.has(b)) {
        out.add(a);
        out.add(b);
        grew = true;
      }
  }
  out.delete(rkey);
  return out;
}

/** R717: a test-only seam, as `r696Seam`; off drops the filter fix-up refusal. */
export const r717Seam = { on: true };

/**
 * R717. A walk that INSERTS into its own table (an Insert among its movers, a one-hop callee that
 * inserts: `r696CalleeInserts`, or a bare procedure of the same object that does) relies on a
 * fix-up that moves the inserted row out of the walk's FILTER: a second variable's Modify after a
 * write of a filtered field, or its ModifyAll of a filtered field (DC's `CDC Template.Clone` shape,
 * read by parse in R-717's measure.md). A mutant deleting the fix-up keeps the row in the walk,
 * which can then meet its own copies forever; it is a deleted statement, not a deleted exit, so
 * R696's exit refusal does not take it, and a filter field is no key field. Refused (by
 * `r696Loop`, as R696's movers): the fix-up, its writes, the walk's pre-loop filters (deleting one
 * has the same effect) with their guards, and the feeds of all of these. The filtered fields are
 * R's pre-loop `SetRange`/`SetFilter` fields, or EVERY field when R is not a local (its caller set
 * the filters), when R or a field of R is an argument of a call before the walk (a helper, an
 * event subscriber or `X.CopyFilter(X.F, R.F)` may filter it), or when a filter field is
 * unreadable. A key write is R696's mover already. LIMITS: a filter set outside this procedure
 * (by a caller, helper or subscriber) is not itself refused, as R696 accepts a caller's bound; a
 * fix-up made inside a callee; an insert through a callee on a temporary receiver, `this.P()`, or
 * a tableextension's bare call to its base table. Cost by parse (R-717): DC 11 specs, BaseApp 19
 * (all from the widening above, no real fix-up), DO and CDO 0.
 */
function r717Fixups(
  body: ALSyntaxNode,
  loop: ALSyntaxNode,
  scope: ALSyntaxNode,
  w: R696Walk,
  movers: readonly R696Mover[],
  filters: readonly ALSyntaxNode[],
  rLocal: boolean,
  ctx: SemanticContext,
): R696Mover[] {
  if (!r717Seam.on) return [];
  const inserts =
    movers.some((m) => r531Call(m.call)?.method === "insert") ||
    r696CalleeInserts(body, w.table, ctx) ||
    r717BareInserts(body, w.table, ctx);
  if (!inserts) return [];
  const [rkey = ""] = w.rkeys;
  const namesR = (a: ALSyntaxNode): boolean =>
    r531Key(a) === rkey ||
    (a.rawKind === "member_expression" && r531Key(a.childForFieldName("object")) === rkey);
  let all = !rLocal;
  visitAll(scope, (n) => {
    if (!all && r696IsCall(n) && n.endIndex <= loop.startIndex && r531Call(n)?.args.some(namesR))
      all = true;
  });
  const fields = new Set<string>();
  for (const f of filters) {
    const c = r531Call(f);
    if (c === null || (c.method !== "setrange" && c.method !== "setfilter")) continue;
    const fld = r696Field(c);
    if (fld === "*") all = true;
    else if (fld !== null) fields.add(fld);
  }
  // an Insert found here is one of R696's movers already
  return r696Movers(body, { ...w, keys: all ? "all" : fields, self: false }, ctx);
}

/** R717: does code under `body` call, bare, a procedure of its own object that inserts into
 *  `table`? (`callTargets` leaves a same-object call to the caller.) */
function r717BareInserts(body: ALSyntaxNode, table: string, ctx: SemanticContext): boolean {
  const obj = objectOf(body);
  if (obj === null) return false;
  const procs = r531ObjectProcs(body, ctx);
  let found = false;
  visitAll(body, (n) => {
    if (found || !r696IsCall(n)) return;
    const c = r531Call(n);
    if (c === null || c.recv !== null || !procs.has(c.method)) return;
    visitAll(obj, (p) => {
      if (!found && isProcedureLike(p) && procNames(p).includes(c.method))
        found = r696Inserts(p, obj, table, ctx);
    });
  });
  return found;
}

function r696Loop(loop: ALSyntaxNode, ctx: SemanticContext, push: R696Push): void {
  const nc = r696Next(loop);
  const scope = codeScope(loop);
  const body = loop.childForFieldName("body");
  if (nc === null || scope === null || body === null) return;
  const rc = r531Call(nc);
  const rkey = rc?.recv ?? "";
  if (rc === null || rkey.startsWith("\u0001")) return;
  const rt = r696Table(nc, ctx);
  if (rt === null) return;
  // R702: read for every walk, since a walker not declared temporary (a `var` parameter, a
  // temporary-source Rec) can be one at run time; Copy(R, true) only runs when it is.
  const shared = r702Shared(scope, loop, rkey, ctx);
  if (rt.temporary && shared.size === 0) return;
  const rLocal = rkey !== "" && r531Declares(scope, rkey, false);
  const filters = r696PreFilters(scope, loop, rkey, ctx);
  const walk: R696Walk = {
    rkeys: new Set([rkey]),
    table: rt.name,
    keys: r696Keys(rt.name, filters, !rLocal, ctx),
    self: true,
    recDistinct: rLocal,
    shared,
    temp: rt.temporary,
  };
  const movers = r696Movers(body, walk, ctx);
  const fixes = r717Fixups(body, loop, scope, walk, movers, filters, rLocal, ctx);
  if (movers.length === 0 && fixes.length === 0) return;
  const parts: ALSyntaxNode[] = [];
  for (const m of [...movers, ...fixes]) {
    push(m.call, loop);
    parts.push(...(r531Call(m.call)?.args ?? []));
    for (const x of m.writes) {
      push(x.node, loop);
      parts.push(...x.reads);
    }
  }
  // R717's fix-ups alone refuse no exit: the hazard there is the deleted fix-up, not an exit
  if (movers.length > 0) {
    const isExit = (x: ALSyntaxNode): boolean =>
      endsScope(x, scope) || (x.rawKind === "break_statement" && exitsLoop(x, loop));
    visitAll(body, (x) => {
      if (isExit(x)) push(x.parent !== null && r696IsCall(x.parent) ? x.parent : x, loop);
    });
    for (const g of exitGuards(body, loop, isExit)) {
      push(g, loop);
      parts.push(g);
    }
  }
  for (const f of filters) {
    push(f, scope);
    parts.push(...(r531Call(f)?.args ?? []));
    for (const g of guardsUpTo(f, scope)) {
      push(g, scope);
      parts.push(g);
    }
  }
  for (const a of r531Feeds(scope, parts, ctx)) push(a, scope);
}

/** Does procedure `p` of object `o` insert into `table`: a bare `Insert` in a procedure of the table
 *  (or its tableextension), or `V.Insert` on a non-temporary `Record <table>` variable? */
function r696Inserts(
  p: ALSyntaxNode,
  o: ALSyntaxNode,
  table: string,
  ctx: SemanticContext,
): boolean {
  const ownTable =
    (o.rawKind === "table_declaration" && objectNameOf(o) === table) ||
    (o.rawKind === "tableextension_declaration" &&
      normalizeAlName(lastFieldChild(o, "base_object")?.text ?? "") === table);
  let found = false;
  visitAll(p, (x) => {
    if (found || !r696IsCall(x)) return;
    const c = r531Call(x);
    if (c === null || c.method !== "insert") return;
    if (c.recv === null) {
      if (ownTable && r531Implicit(x, ctx)) found = true;
      return;
    }
    const t = r696Table(x, ctx);
    if (t !== null && !t.temporary && sameTable(t.name, table)) found = true;
  });
  return found;
}

/** Does code under `scope` call (one hop) a procedure that inserts into `table`? `V.P()` counts only
 *  for a non-temporary V. */
function r696CalleeInserts(scope: ALSyntaxNode, table: string, ctx: SemanticContext): boolean {
  let found = false;
  visitAll(scope, (c) => {
    if (found || !r696IsCall(c)) return;
    const tg = callTargets(c, ctx);
    if (tg === null || tg.member === "") return;
    const f = c.childForFieldName("function");
    const recv = f?.rawKind === "member_expression" ? f.childForFieldName("object") : null;
    const rt =
      recv !== null && recv !== undefined && isIdentifierLike(recv)
        ? declaredType(recv, ctx)
        : null;
    if (rt?.kind === "table" && rt.temporary) return;
    for (const o of tg.objs)
      visitAll(o, (p) => {
        if (found || !(isProcedureLike(p) || p.rawKind === "procedure")) return;
        if (procNames(p).includes(tg.member) && r696Inserts(p, o, table, ctx)) found = true;
      });
  });
  return found;
}

function r696Item(
  item: ALSyntaxNode,
  obj: ALSyntaxNode,
  ctx: SemanticContext,
  push: R696Push,
): void {
  const table = itemTable(item);
  if (table === "integer" || table === "date" || table === "" || selfInserts(item, ctx)) return;
  const iname = normalizeAlName(item.childForFieldName("name")?.text ?? "");
  const scopes = itemScopes(item, ctx);
  // filter and key calls on the item, anywhere in the object (OnPreReport, helpers)
  const onItem: ALSyntaxNode[] = [];
  visitAll(obj, (n) => {
    if (!r696IsCall(n)) return;
    const c = r531Call(n);
    if (c === null || !R696_FILTER.has(c.method)) return;
    // a bare call counts when it sits in the item's own code: the implicit Rec is the item there
    const bare =
      (c.recv === "" || (c.recv === null && r531Implicit(n, ctx))) &&
      scopes.some((sc) => sc.startIndex <= n.startIndex && n.endIndex <= sc.endIndex);
    if (c.recv === iname || bare) onItem.push(n);
  });
  const sorting: ALSyntaxNode[] = [];
  const body = item.childForFieldName("body");
  for (const m of body === null ? [] : itemMembers(body, ctx)) {
    const name = normalizeAlName(m.childForFieldName("name")?.text ?? "");
    const v = m.childForFieldName("value");
    if (
      m.rawKind === "property" &&
      v !== null &&
      /^(dataitemtableview|sourcetableview)$/.test(name)
    )
      visitAll(v, (w) => {
        if (w.rawKind === "sorting_value") sorting.push(w);
      });
  }
  const sortKeys = new Set<string>();
  for (const s of sorting)
    for (const c of s.namedChildren) if (isIdentifierLike(c)) sortKeys.add(normalizeAlName(c.text));
  const base = r696Keys(table, onItem, false, ctx);
  const keys: R696Keys = base === "all" ? base : new Set([...base, ...sortKeys]);
  const walk: R696Walk = {
    rkeys: new Set([iname, ""]),
    table,
    keys,
    self: false,
    recDistinct: false,
  };
  if (
    !scopes.some((sc) => r696Movers(sc, walk, ctx).length > 0 || r696CalleeInserts(sc, table, ctx))
  )
    return;
  for (const sc of scopes) push(sc, null, true);
  const parts: ALSyntaxNode[] = [];
  for (const f of onItem) {
    push(f, obj);
    parts.push(...(r531Call(f)?.args ?? []));
  }
  for (const a of r531Feeds(obj, parts, ctx)) push(a, obj);
}

/**
 * R500 shape 2 (option A, one hop). A procedure in ANOTHER object of the project that open-item
 * code calls is refused, with the same-object procedures it reaches. The calls followed: every call
 * of open-item code, plus every call anywhere in the object on a receiver variable that open-item
 * code also calls (an iterator initialized in OnPreReport). A callee is found through the receiver's
 * declared type (`Codeunit X`; `Record X` with X's project tableextensions; `Interface X`, meaning
 * every project codeunit that implements X), or through a record the engine binds (`resolveReceiverTable`:
 * a data item's name, an implicit record). Event subscribers count too: of an event open-item code
 * raises, and of an event a refused callee raises. ONE object hop, a stated cap: a callee's own calls
 * into a third object are not followed, except those whose value feeds an exit (R569,
 * `exitFedHop2`). Not seen: a receiver this cannot type (a RecordRef, a
 * parameter of another procedure, an object in a `#if` wrapper), table triggers, events raised deeper,
 * cross-app objects, `interface B extends A`, `Codeunit.Run`/`Report.Run` targets and
 * tableextension-published events.
 */
function inOneHopCallee(node: ALSyntaxNode, ctx: SemanticContext): boolean {
  const s = codeScope(node);
  if (s === null || !isProcedureLike(s)) return false;
  const obj = objectOf(s);
  if (obj === null) return false;
  const reach = oneHopReach(ctx).get(objectKey(obj));
  return reach !== undefined && procNames(s).some((k) => reach.has(k));
}

const objectKey = (o: ALSyntaxNode): string => `${o.rawKind}|${objectNameOf(o)}`;

const oneHopReaches = new WeakMap<object, Map<string, Set<string>>>();
/** object key -> procedure names reached in it, one hop from open-item code. */
function oneHopReach(ctx: SemanticContext): Map<string, Set<string>> {
  const hit = oneHopReaches.get(ctx);
  if (hit !== undefined) return hit;
  const objects = projectObjects(ctx);
  const out = new Map<string, Set<string>>();
  oneHopReaches.set(ctx, out);
  const add = (o: ALSyntaxNode, name: string): void => {
    const k = objectKey(o);
    const set = out.get(k) ?? new Set<string>();
    if (set.has(name)) return;
    set.add(name);
    out.set(k, set);
    // same-object closure inside the callee's object, through every call shape `openReachable`
    // follows (`P()`, `this.P()`, `CurrReport.P()`, a bare `P` in an expression)
    const names = procedureNamesOf(o, ctx);
    visitAll(o, (n) => {
      if (!isProcedureLike(n) && n.rawKind !== "procedure") return;
      if (!procNames(n).includes(name)) return;
      visitAll(n, (c) => {
        const callee = bareCallee(c) ?? hiddenCallee(c, names, ctx);
        if (callee !== null) add(o, callee);
      });
    });
  };
  // Event subscribers in the project, by "<object kind>|<object name>|<event name>" (`subscriberKey`).
  const subscribers = new Map<string, { obj: ALSyntaxNode; proc: string }[]>();
  for (const o of objects) {
    visitAll(o, (p) => {
      if (!isProcedureLike(p) && p.rawKind !== "procedure") return;
      for (const a of attributesOf(p)) {
        const k = subscriberKey(a, objects);
        if (k === null) continue;
        const list = subscribers.get(k) ?? [];
        for (const nm of procNames(p)) list.push({ obj: o, proc: nm });
        subscribers.set(k, list);
      }
    });
  }
  /** The subscribers of the event call `c` (inside object `o`) raises, or an empty list. */
  const raised = (c: ALSyntaxNode, o: ALSyntaxNode): { obj: ALSyntaxNode; proc: string }[] => {
    let pubObjs: readonly ALSyntaxNode[];
    let name = bareCallee(c);
    if (name !== null) pubObjs = [o];
    else {
      const t = callTargets(c, ctx);
      if (t === null) return [];
      pubObjs = t.objs;
      name = t.member;
    }
    const found: { obj: ALSyntaxNode; proc: string }[] = [];
    for (const po of pubObjs) {
      visitAll(po, (p) => {
        if (
          (!isProcedureLike(p) && p.rawKind !== "procedure") ||
          !procNames(p).includes(name ?? "")
        )
          return;
        if (!attributeNamesOf(p).some((a) => PUBLISHERS.has(a))) return;
        const kind = po.rawKind.replace("_declaration", "");
        found.push(...(subscribers.get(`${kind}|${objectNameOf(po)}|${name}`) ?? []));
        // an unreadable subscriber (`subscriberKey` "*", R567) may subscribe to this one
        found.push(...(subscribers.get("*") ?? []));
      });
    }
    return found;
  };
  const calls = (s: ALSyntaxNode): ALSyntaxNode[] => {
    const r: ALSyntaxNode[] = [];
    visitAll(s, (c) => {
      if (c.rawKind === "call_expression" || c.rawKind === "call_statement") r.push(c);
    });
    return r;
  };
  const receiverOf = (c: ALSyntaxNode): string | null => {
    const f = c.childForFieldName("function");
    const r = f?.rawKind === "member_expression" ? f.childForFieldName("object") : null;
    return r !== null && r !== undefined && isIdentifierLike(r) ? normalizeAlName(r.text) : null;
  };
  for (const o of objects) {
    if (!LOOP_OBJECTS.has(o.rawKind)) continue;
    const all = calls(o);
    const openCalls = all.filter((c) => inOpenItemCode(c, ctx));
    if (openCalls.length === 0) continue;
    const openRecvs = new Set(openCalls.map(receiverOf).filter((r): r is string => r !== null));
    const openSet = new Set(openCalls);
    const seeds = [
      ...openCalls,
      ...all.filter((c) => {
        const r = receiverOf(c);
        return !openSet.has(c) && r !== null && openRecvs.has(r);
      }),
    ];
    for (const c of seeds) {
      const t = callTargets(c, ctx);
      if (t !== null) for (const obj of t.objs) add(obj, t.member);
    }
    for (const c of openCalls) for (const s of raised(c, o)) add(s.obj, s.proc);
    if (r569Seam.on) exitFedHop2(o, ctx, (obj, proc) => add(obj, proc));
  }
  // events raised from the refused callee procedures themselves (PEPPOL Management's OnFindNext*)
  for (const [k, procs] of [...out]) {
    const obj = objects.find((x) => objectKey(x) === k);
    if (obj === undefined) continue;
    visitAll(obj, (p) => {
      if (
        (!isProcedureLike(p) && p.rawKind !== "procedure") ||
        !procNames(p).some((n) => procs.has(n))
      )
        return;
      for (const c of calls(p)) for (const s of raised(c, obj)) add(s.obj, s.proc);
    });
  }
  return out;
}

/** R569: a test-only seam. Tests switch `on` off to get master's behaviour (no second hop). */
export const r569Seam = { on: true };

/** One procedure the R569 second hop refuses: the report it starts from, the hop-1 callee it came
 *  through (`Object.Procedure`), the hop-2 object's name and procedure, and how its value feeds
 *  the hop-1 callee's return: `exit` (its result) or `ret-var` (it writes a `var` argument). */
export interface R569Target {
  report: string;
  hop1: string;
  obj: string;
  proc: string;
  tag: "exit" | "ret-var";
}

/** R569, for measurement scripts: every hop-2 target the rule finds in the project of `ctx`, one
 *  record per find (repeats are possible). Computed fresh on each call; no module state. */
export function r569HopTargets(ctx: SemanticContext): R569Target[] {
  const out: R569Target[] = [];
  for (const o of projectObjects(ctx)) {
    if (!LOOP_OBJECTS.has(o.rawKind)) continue;
    exitFedHop2(o, ctx, (obj, proc, tag, hop1) =>
      out.push({ report: objectNameOf(o), hop1, obj: objectNameOf(obj), proc, tag }),
    );
  }
  return out;
}

/**
 * R569: the exit-fed second hop. R500 refuses a procedure of another object that open-item code
 * calls (hop 1), but not that callee's own calls into a third object (hop 2). This adds the hop-2
 * procedures whose value decides when an open item stops, and no others.
 *
 * 1. EXITS. Start from the exit parts of every `while`/`repeat` loop in open-item code
 *    (`loopExitParts`) and from the guard of every `CurrReport.Break`/`Quit` (and XMLport twins)
 *    there. An `OnPreDataItem` Break counts too, although it can only shorten a run: a stated
 *    over-refusal (Whse.-Source - Create Document's AsmExistsForJobPlanningLine).
 * 2. FEEDS. In the exit's own scope, `r531Feeds` with `fed` finds the assignments whose value flows
 *    by name into the exit, under R532/R568's boundary (another object's function feeds only its
 *    receiver, so `Fmt.Wrap(PPM.NextDate(D))` follows `Fmt.Wrap` and not `PPM.NextDate`). The calls
 *    followed are those in the exit parts and in the right sides of those assignments.
 * 3. RETURN VALUE. A followed call into a procedure is followed through what it RETURNS: its
 *    `exit(...)` values, its named return variable and the guards of its `exit`s; step 2 runs again
 *    from there. A procedure of the same object stays on the same hop; one of another project
 *    object is the hop-1 callee; from a hop-1 callee (or its same-object procedures) a call into a
 *    third object is the hop-2 target, refused exactly like a hop-1 callee (`add`: the whole
 *    procedure, its same-object closure, and the event subscribers the closing pass follows).
 * 4. VAR WRITES. Inside a procedure reached through its return value (a report helper, the hop-1
 *    callee, their same-object procedures), a call that writes a fed name through a `var` parameter
 *    is followed too (`Helper.Calc(Result); exit(Result)`), since it feeds the returned value; from
 *    a report helper such a call into another object enters the hop-1 callee. In the exit's own
 *    trigger or procedure, and in procedures it reaches only through `var` arguments, a `var` call
 *    into a procedure of the SAME object is followed; a `var` call into ANOTHER object's procedure
 *    is NOT (the entry-var path).
 *
 * Not followed (residuals in R569): a hop-1 callee entered through a `var` argument from the
 * exit's own scope (measured 906 in Fixed Asset - Projected Value, each loop sampled with a second
 * exit that progresses on its own); a `var` write made by an event subscriber; events raised on the way;
 * globals written in another trigger; hop 3.
 */
function exitFedHop2(
  report: ALSyntaxNode,
  ctx: SemanticContext,
  add: (o: ALSyntaxNode, name: string, tag: R569Target["tag"], hop1: string) => void,
): void {
  const seen = new Set<string>();
  const arityOf = (c: ALSyntaxNode): number | null =>
    c.rawKind === "call_expression" || c.rawKind === "call_statement"
      ? argumentsReadable(c)
        ? argumentList(c).length
        : null
      : null;
  const exitParts = (proc: ALSyntaxNode): { values: ALSyntaxNode[]; guards: ALSyntaxNode[] } => {
    const values: ALSyntaxNode[] = [];
    visitAll(proc, (x) => {
      if (x.rawKind !== "exit_statement") return;
      const v = x.childForFieldName("return_value");
      if (v !== null) values.push(v);
    });
    const body = proc.childForFieldName("body");
    const guards =
      body === null ? [] : exitGuards(body, body, (x) => x.rawKind === "exit_statement");
    return { values, guards };
  };
  const visitProc = (
    proc: ALSyntaxNode,
    hop: 0 | 1,
    names: string[],
    ret: boolean,
    tag: R569Target["tag"],
    hop1: string,
    viaRet: boolean,
  ): void => {
    const obj = objectOf(proc);
    if (obj === null) return;
    const vr = viaRet || ret;
    const key = `${objectKey(obj)}|${proc.startIndex}|${hop}|${ret}|${vr}|${tag}|${[...names].sort().join(",")}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (!ret) {
      site(proc, [], names, hop, tag, hop1, vr);
      return;
    }
    const { values, guards } = exitParts(proc);
    const rv = proc.childForFieldName("return_value");
    const rnames = rv === null ? names : [...names, normalizeAlName(rv.text)];
    site(proc, values, rnames, hop, tag, hop1, vr);
    if (guards.length > 0) site(proc, guards, names, hop, tag, hop1, vr);
  };
  /** `viaRet`: the scope was reached through a procedure's return value (step 3), not only from
   *  the exit's own scope and `var` arguments; there a hop-0 `var` call into another object is
   *  followed (step 4). */
  const site = (
    scope: ALSyntaxNode,
    parts: ALSyntaxNode[],
    names: string[],
    hop: 0 | 1,
    tag: R569Target["tag"],
    hop1: string,
    viaRet: boolean,
  ): void => {
    const obj = objectOf(scope);
    if (obj === null) return;
    const own = procedureNamesOf(obj, ctx);
    const fed = new Set(names);
    const assigns = r531Feeds(scope, parts, ctx, fed);
    const exprs = [...parts];
    for (const a of assigns) {
      const r = a.childForFieldName("right");
      if (r !== null) exprs.push(r);
      exprs.push(...exprTails(a));
    }
    const onCall = (c: ALSyntaxNode, argIdx: number | null, t: R569Target["tag"]): void => {
      const bare = bareCallee(c) ?? hiddenCallee(c, own, ctx);
      let targets: { o: ALSyntaxNode; member: string }[];
      if (bare !== null && own.has(bare)) targets = [{ o: obj, member: bare }];
      else {
        if (c.rawKind !== "call_expression" && c.rawKind !== "call_statement") return;
        const tg = callTargets(c, ctx);
        if (tg === null) return;
        targets = tg.objs.map((o) => ({ o, member: tg.member }));
      }
      for (const { o, member } of targets) {
        const procs = r531ProcsIn(o, member, arityOf(c), c, ctx);
        for (const p of procs) {
          let pnames: string[] = [];
          if (argIdx !== null) {
            const prm = r531Param(p, argIdx);
            if (prm === null || !prm[1]) continue;
            pnames = [prm[0]];
          }
          const same = objectKey(o) === objectKey(obj);
          // the entry-var path: the exit's own scope (or code it reaches by `var`) passing a fed
          // name to another object's `var` parameter
          if (argIdx !== null && hop === 0 && !same && !viaRet) continue;
          const nextHop: 0 | 1 = same ? hop : 1;
          if (!same && hop === 1) {
            add(o, member, t, hop1);
            continue;
          }
          const h1 = !same ? `${objectNameOf(o)}.${member}` : hop1;
          visitProc(p, nextHop, pnames, argIdx === null, t, h1, viaRet);
        }
      }
    };
    const scan = (n: ALSyntaxNode): void => {
      if (DIRECTIVE_MARKERS.has(n.rawKind) || armOfNode(ctx, n) === "inactive") return;
      const isCall = n.rawKind === "call_expression" || n.rawKind === "call_statement";
      if (isCall || hiddenCallee(n, own, ctx) !== null) onCall(n, null, tag);
      if (isCall && bareCallee(n) === null && r568StopsAt(n, ctx)) {
        const f = n.childForFieldName("function");
        if (f !== null) scan(f);
        return;
      }
      for (const ch of n.namedChildren) scan(ch);
    };
    for (const e of exprs) scan(e);
    // a call that writes a fed name through a `var` parameter (step 4; `onCall` drops the entry)
    visitAll(scope, (n) => {
      if (n.rawKind !== "call_expression" && n.rawKind !== "call_statement") return;
      if (armOfNode(ctx, n) === "inactive") return;
      argumentList(n).forEach((a, i) => {
        if (fed.has(rootName(a))) onCall(n, i, hop === 1 || viaRet ? "ret-var" : tag);
      });
    });
  };
  visitAll(report, (n) => {
    const s = codeScope(n);
    if (s === null) return;
    let parts: ALSyntaxNode[] | null = null;
    if (LOOP_KINDS.has(n.kind) && inOpenItemCode(n, ctx)) parts = loopExitParts(n, ctx);
    else if (n.rawKind === "member_expression" && isReportExit(n) && inOpenItemCode(n, ctx))
      parts = exitGuards(s, s, (x) => samePos(x, n));
    if (parts !== null && parts.length > 0) site(s, parts, [], 0, "exit", "", false);
  });
}

/*
 * R570: a `while`/`repeat` loop of ANY object kind (a report item's own trigger included) whose exit
 * calls a cursor-shaped procedure in ANOTHER project object. Every site in that procedure is
 * refused, for every operator: the measured hangs are flipped final returns, negated end-of-set
 * tests, removed index increments, row deletes and "first done" flags, not only return sites.
 * - EXIT CALLS: the calls in the loop's condition, and the calls in a body exit guard (`exit`, a
 *   `break` of THIS loop, `Error` outside `asserterror`: R446's `bodyExitGuards`) when the condition
 *   names no cursor method (R480 `namesCursorMethod`), or when the guard call shares the
 *   condition's cursor (that receiver is the call's own receiver, or is passed to a `var`
 *   parameter) AND the callee TOUCHES that record (`r570Touches`, orchestrator option b; such a
 *   callee is refused even when it is not cursor-shaped). Otherwise a guard callee can only end
 *   the loop EARLIER (measured: no hang).
 * - RESOLVED through `callTargets`, `objectsOfType` (tableextensions, interface implementers),
 *   `r531TableProcs` and R564's `r531ProcsIn`; an uncertain call (R567) follows every candidate.
 * - CURSOR-SHAPED: the callee calls `Find*`, `Next`, `IsEmpty` or `Count` on anything, by NAME (a
 *   List or Dictionary `Count` too: the index iterators the sample found hanging), or holds a loop.
 * - DELEGATION: every call inside an `exit(...)` of the callee that resolves to a project procedure,
 *   same-object or not, is followed, up to `R570_HOPS` hops (which also ends a cycle). Every
 *   procedure on a chain that reaches a cursor-shaped one is refused. Only built-in record and list
 *   methods end a chain, so a wrapper over a `Next`-named project procedure reaches the real one.
 * - SAME-OBJECT FIRST HOP (I3b): an exit call to a procedure of the loop's OWN object whose
 *   `exit(<call>)` reaches such a chain in another object refuses that procedure and the chain.
 * - BY NAME: every overload of a refused name in that object is refused (R564 narrowing finds the
 *   callee but does not narrow the refusal).
 * NOT DONE, stated (each errs toward deploying, none can false-kill): the callee's other
 * same-object helpers (DC 31 -> 737 deployed, over the bar); `Codeunit.Run` targets; delegation
 * through a named return value; event subscribers of an exit callee; non-cursor callees (a "has
 * next page" Boolean read from JSON); a loop flag fed by a callee's result (I3a, R572: CDO 0.075%,
 * over the bar); a record consumer in another object on R531's side (R571).
 */
const R570_CURSOR: ReadonlySet<string> = new Set([
  "find",
  "findfirst",
  "findlast",
  "findset",
  "next",
  "isempty",
  "count",
]);
const R570_HOPS = 4;
/** How far `r570Touches` follows the shared record (option d; the delegation chain keeps 4). */
const R570_TOUCH_HOPS = 8;

function inR570Callee(node: ALSyntaxNode, ctx: SemanticContext): boolean {
  const s = codeScope(node);
  if (s === null || !isProcedureLike(s)) return false;
  const obj = objectOf(s);
  if (obj === null) return false;
  const reach = r570Reach(ctx).get(objectKey(obj));
  return reach !== undefined && procNames(s).some((k) => reach.has(k));
}

const r570Reaches = new WeakMap<object, Map<string, Set<string>>>();
/** object key -> the procedure names R570 refuses in it. */
function r570Reach(ctx: SemanticContext): Map<string, Set<string>> {
  const hit = r570Reaches.get(ctx);
  if (hit !== undefined) return hit;
  const out = new Map<string, Set<string>>();
  r570Reaches.set(ctx, out);
  for (const o of projectObjects(ctx)) {
    r531Walk(o, ctx, (loop) => {
      if (!LOOP_KINDS.has(loop.kind)) return;
      for (const p of [...r570LoopCallees(loop, o, ctx), ...r572LoopRefusals(loop, o, ctx)]) {
        const po = objectOf(p);
        if (po === null) continue;
        const set = out.get(objectKey(po)) ?? new Set<string>();
        for (const k of procNames(p)) set.add(k);
        out.set(objectKey(po), set);
      }
    });
  }
  return out;
}

/** The procedures R570 refuses for one loop of object `obj`: its exit callees and their chains. */
function r570LoopCallees(
  loop: ALSyntaxNode,
  obj: ALSyntaxNode,
  ctx: SemanticContext,
): ALSyntaxNode[] {
  const cond = loopConditionParts(loop);
  const steps = namesCursorMethod(cond, ctx);
  // the receivers the condition steps (`""` is the implicit Rec, as for a bare call)
  const cursors = new Set<string>();
  for (const part of cond)
    r531Walk(part, ctx, (n) => {
      const c = r531Call(n);
      if (c !== null && CURSOR_METHODS.has(c.method)) cursors.add(c.recv ?? "");
    });
  const filtered = r570LoopFilters(loop, cursors, ctx);
  /** The names under which guard call `c` hands the condition's cursor to callee `q`: `""` (its
   *  implicit Rec) when that record is the receiver and `q` is a table procedure, a `var`
   *  parameter's name when it is passed there, `R570_UNKNOWN` when the binding cannot be read
   *  (another receiver kind, an uncertain call). Empty: `c` does not share the cursor. */
  const shared = (c: R531Call, q: ALSyntaxNode): string[] => {
    const out: string[] = [];
    if (cursors.has(c.recv ?? "")) {
      const kind = objectOf(q)?.rawKind;
      const table = kind === "table_declaration" || kind === "tableextension_declaration";
      out.push(table ? "" : R570_UNKNOWN);
    }
    c.args.forEach((a, i) => {
      const k = isIdentifierLike(a) ? r531Key(a) : null;
      if (k === null || !cursors.has(k)) return;
      for (const j of r531Positions(c, i, q)) {
        const p = r531Param(q, j);
        if (p?.[1] === true) out.push(c.uncertain ? R570_UNKNOWN : r531ParamKey(p[0]));
      }
    });
    return out;
  };
  const sameObject = (q: ALSyntaxNode): boolean => {
    const qo = objectOf(q);
    return qo === null || (samePos(qo, obj) && sameFile(rootOf(qo), rootOf(obj)));
  };
  const out: ALSyntaxNode[] = [];
  const take = (parts: ALSyntaxNode[], guard: boolean): void => {
    for (const part of parts)
      r531Walk(part, ctx, (n) => {
        const c = r531Call(n);
        if (c === null) return;
        for (const q of r570Targets(n, c, ctx)) {
          if (guard && steps) {
            // option (b): a guard that shares the cursor counts only if it TOUCHES that record
            const touched = shared(c, q).flatMap((k) =>
              k === R570_UNKNOWN ? [q] : r570Touches(q, k, false, 0, filtered, ctx),
            );
            if (touched.length === 0) continue;
            out.push(...touched.filter((t) => !sameObject(t)));
          }
          if (!sameObject(q)) {
            out.push(...r570Chain(q, 0, ctx));
            continue;
          }
          // I3b: a same-object first hop whose `exit(<call>)` reaches another object's chain
          const hop = r570ExitTargets(q, ctx)
            .filter((t) => !sameObject(t))
            .flatMap((t) => r570Chain(t, 1, ctx));
          if (hop.length > 0) out.push(q, ...hop);
        }
      });
  };
  take(cond, false);
  take(bodyExitGuards(loop), true);
  return out;
}

/**
 * R572: a loop whose exit is fed by another object's STATEFUL procedure. Three shapes reach it:
 * a flag (`Found := X.NextEntry(..); until not Found`), a `var` argument the call writes
 * (`X.Step(Buf, More)`), and a call in the exit itself (`while It.HasNext() do`).
 *
 * The calls followed are those in R480's feeds of the exit parts, the exit parts' own calls, and
 * body calls that pass a name the exit reads to a `var` parameter of a simple type. A call into
 * another object follows its `exit(<call>)` chain up to 4 hops (`r572Chain`). A same-object
 * wrapper is followed through its `exit(<call>)` into another object (I3b).
 *
 * The chain is refused when a procedure on it is STATEFUL (`r572Stateful`, rule P). Then every
 * procedure in a chain object that writes the chain's VALUE PATH is refused too, whoever calls it
 * (`r572ValueWriters`, a fixpoint).
 *
 * Option D: a loop whose own step alone forces the exit (`r572ForcedSteps`) keeps only the calls
 * that get that cursor, and of those only the ones that touch it (`r570Touches`).
 *
 * Stated limits (each errs toward deploying):
 * - A stateless callee fed its own result (`D := X.NextDate(D)`), or whose result is added into the
 *   flag, is not refused. `scripts/r572-flag-census.ts` prints such rows as `RE-OPEN SHAPE`;
 *   re-open R572 if one sits in a loop with no other stop.
 * - Statefulness is read by name, 4 calls deep; past that it is UNKNOWN, which counts as stateful.
 * - Narrowing (a)'s proof is by name. A write through RecordRef or FieldRef is a call it cannot
 *   resolve, so it counts as a write and the loop is refused.
 * - Event subscribers are not followed, as in R570.
 */
export interface R572Row {
  readonly loop: ALSyntaxNode;
  readonly call: ALSyntaxNode;
  /** the feed's target name (`""` for a var-out argument the call writes) */
  readonly flag: string;
  readonly varOut: boolean;
  readonly wrapper: ALSyntaxNode | null;
  readonly chain: ALSyntaxNode[];
  readonly stateful: boolean;
  /** the flag is also an argument of the call: a stepper fed its own result */
  readonly selfFeed: boolean;
  /** the flag is accumulated from the call (`T := T + X.Delta()`, `T += X.Delta()`) */
  readonly additive: boolean;
  readonly writers: ALSyntaxNode[];
}

/** Test seam: R572 on or off as a whole. */
export const r572Seam = { on: true };

/**
 * Narrowing (a), behind its own seam. Option D also accepts:
 * - `R.Next(X)` where X is an Integer LOCAL or BY-VALUE parameter that is invariant by proof in the
 *   loop (`r572StepInvariant`);
 * - the same forced step reached through a same-object HELPER (`until Helper()`, `until Helper() =
 *   0`) when every exit of the helper carries it and nothing in the helper moves the cursor back
 *   (`r572HelperKeys`);
 * - a FLAG that only that helper writes, once per pass (`EndLoop := Helper(); until EndLoop`).
 */
export const r572InvariantStep = { on: true };

/**
 * The zero-step refusal under narrowing (a): X must be a local that is assigned only non-zero
 * integer literals outside the loop, one of them before the loop on every path.
 *
 * MEASURED (orchestrator ruling 2 of 2026-10-21 on R572; /coord/handoff/R-572/next0-probe.md, BC
 * build 28.4.53241.56590 on bc1): `Next(0)` on a Record (real, temporary or virtual) or a RecordRef
 * returns 0 and leaves the cursor where it is, so a zero X ENDS `until R.Next(X) = 0`. The refusal
 * is therefore LIFTED where the probed fact is all that X does in the loop: every read of X there
 * is the step argument of `Next` on a Record or RecordRef (`r572OnlyNextUses`), or, for the helper
 * form, an argument bound to a helper parameter whose every read is such a step. It is KEPT when X
 * reaches anything else: an integer counter (`I += Step`), a custom `Advance(Step)` whose body is
 * not a `Next(<step>)`. Seam: off lifts it everywhere (the pre-ruling measurement leg).
 */
export const r572RequireNonZeroStep = { on: true };

/**
 * Is every read of the plain name `k` under `n` the step argument (argument 1) of `Next` on a
 * Record or RecordRef (the implicit Rec included), or a call argument `extra` accepts?
 */
function r572OnlyNextUses(
  n: ALSyntaxNode,
  k: string,
  ctx: SemanticContext,
  extra?: (call: ALSyntaxNode, i: number) => boolean,
): boolean {
  let ok = true;
  visitAll(n, (x) => {
    if (!ok || !isIdentifierLike(x) || x.fieldName === "member") return;
    if (normalizeAlName(x.text) !== k) return;
    let call: ALSyntaxNode | null = x.parent;
    for (let d = 0; call !== null && d < 2 && call.rawKind !== "call_expression"; d++)
      call = call.parent;
    const c = call === null || call.rawKind !== "call_expression" ? null : r531Call(call);
    const i = c === null ? -1 : c.args.findIndex((a) => samePos(a, x));
    if (call === null || c === null || i < 0) ok = false;
    else if (c.method === "next" && i === 0 && r572CursorCall(call, ctx)) return;
    else if (extra === undefined || !extra(call, i)) ok = false;
  });
  return ok;
}

/** Is call `l` made on a Record, a RecordRef or the implicit Rec? */
function r572CursorCall(l: ALSyntaxNode, ctx: SemanticContext): boolean {
  const c = r531Call(l);
  if (c === null || c.uncertain) return false;
  if (c.recv === null) return r531Implicit(l, ctx);
  if (c.recv === "") return true;
  const recv = r572Receiver(l);
  if (recv === null) return false;
  const t = declaredType(recv, ctx);
  const isRecRef =
    normalizeAlName(
      resolveVarRef(recv, ctx)?.node.childForFieldName("type")?.namedChildren[0]?.text ?? "",
    ) === "recordref";
  return isRecRef || (t !== null && t.kind === "table");
}

/**
 * Option D, precise (plan r2 review 2): the cursors (keyed in the loop's procedure) whose step
 * ALONE forces the loop's exit. For a `while`, a top-level AND conjunct `R.Next() <> 0` or
 * `R.Next() > 0`; for an `until`, a top-level OR disjunct `R.Next() = 0`. Negations are pushed
 * through `not` and De Morgan first. The receiver must be declared a record (or a RecordRef), and
 * the step argument must be absent or a literal, or pass narrowing (a). Empty: anything else
 * (`while More or (R.Next() <> 0)`, `until not More and (R.Next() = 0)`, `while not (Done and EOS)`).
 */
function r572ForcedSteps(loop: ALSyntaxNode, ctx: SemanticContext): Set<string> {
  const out = new Set<string>();
  const parts = loopConditionParts(loop);
  const top = parts.length === 1 ? parts[0] : undefined;
  const scope = codeScope(loop);
  if (top === undefined || scope === null) return out;
  const isWhile = loop.rawKind === "while_statement";
  if (!isWhile && loop.rawKind !== "repeat_statement") return out;
  // an `until` exits when its test is true, a `while` when it is false
  for (const k of r572Forcing(top, !isWhile, { loop, scope, helper: null }, ctx)) out.add(k);
  return out;
}

/** Where a forced test is read: the loop's own procedure, or a same-object helper it calls. */
interface R572Frame {
  readonly loop: ALSyntaxNode;
  /** the loop's procedure or trigger */
  readonly scope: ALSyntaxNode;
  /** in a helper: the helper and the loop's call of it */
  readonly helper: {
    readonly proc: ALSyntaxNode;
    readonly call: R531Call;
    /** the loop's call node */
    readonly node: ALSyntaxNode;
  } | null;
  /** flags being expanded (`r572FlagKeys`): a flag fed from itself (`Done := not Done`, or a
   *  ring `A := B; B := A`) is never forced, and must not recurse for ever (re-price, BaseApp) */
  readonly flags?: ReadonlySet<string>;
  /** how many flags deep the expansion is (the backstop's count, independent of `flags`) */
  readonly flagDepth?: number;
}

const r572Unparen = (n: ALSyntaxNode): ALSyntaxNode => {
  let c = n;
  while (c.rawKind === "parenthesized_expression" && c.namedChildren.length === 1) {
    const k = c.namedChildren[0];
    if (k === undefined) break;
    c = k;
  }
  return c;
};

/** Nodes that make a statement inside them run only sometimes. */
const R572_BRANCHES: ReadonlySet<string> = new Set([
  "if_statement",
  "case_statement",
  "case_branch",
  "case_else_branch",
  "while_statement",
  "repeat_statement",
  "for_statement",
  "foreach_statement",
  "asserterror_statement",
  "preproc_conditional_statement",
]);

/** Does `n` run whenever `stop` (an ancestor) does: no branch, loop or `#if` arm between them? */
function r572Unconditional(n: ALSyntaxNode, stop: ALSyntaxNode): boolean {
  for (let a = n.parent; a !== null && !samePos(a, stop); a = a.parent)
    if (R572_BRANCHES.has(a.rawKind)) return false;
  return true;
}

/**
 * The cursors (keyed in the LOOP's procedure) whose step forces test `e` to exit, where the loop
 * exits when `e` is `exitWhenTrue`. Splits OR (exit on true) or AND (exit on false), pushes `not`
 * through, and reads each atom: `R.Next(..) op 0`; under narrowing (a) also a same-object helper
 * (`H() op 0`, or a Boolean `H()`) and, in the loop itself, a flag only that helper writes.
 */
function r572Forcing(
  e0: ALSyntaxNode,
  exitWhenTrue: boolean,
  frame: R572Frame,
  ctx: SemanticContext,
): string[] {
  const e = r572Unparen(e0);
  if (e.rawKind === "unary_expression" && /^not\b/i.test(e.text.trim())) {
    const o = e.childForFieldName("operand");
    return o === null ? [] : r572Forcing(o, !exitWhenTrue, frame, ctx);
  }
  if (e.rawKind === "logical_expression") {
    const l = e.childForFieldName("left");
    const r = e.childForFieldName("right");
    if (l === null || r === null) return [];
    const op = e.text
      .slice(l.endIndex - e.startIndex, r.startIndex - e.startIndex)
      .trim()
      .toLowerCase();
    if (op !== (exitWhenTrue ? "or" : "and")) return [];
    return [
      ...r572Forcing(l, exitWhenTrue, frame, ctx),
      ...r572Forcing(r, exitWhenTrue, frame, ctx),
    ];
  }
  if (e.rawKind === "comparison_expression") {
    const l = e.childForFieldName("left");
    const r = e.childForFieldName("right");
    const op = e.childForFieldName("operator")?.text.trim() ?? "";
    if (l === null || r === null || r.text.trim() !== "0" || l.rawKind !== "call_expression")
      return [];
    const forces = exitWhenTrue ? op === "=" : op === "<>" || op === ">";
    if (!forces) return [];
    const k = r572NextKey(l, frame, ctx);
    if (k !== null) return [k];
    // `Helper() = 0`: every exit of the helper is itself the step
    return r572HelperKeys(l, frame, ctx, (x, hf) => {
      const s = r572Unparen(x);
      const hk = s.rawKind === "call_expression" ? r572NextKey(s, hf, ctx) : null;
      return hk === null ? [] : [hk];
    });
  }
  if (e.rawKind === "call_expression")
    // a Boolean helper: every exit of it forces under the same polarity
    return r572HelperKeys(e, frame, ctx, (x, hf) => r572Forcing(x, exitWhenTrue, hf, ctx));
  if (isIdentifierLike(e)) return r572FlagKeys(e, exitWhenTrue, frame, ctx);
  return [];
}

/**
 * `l` is `R.Next(..)` (or a bare `Next(..)` on the implicit Rec) on a record or RecordRef whose step
 * argument is absent, a literal, or proven invariant (narrowing (a)): its cursor's key in the
 * LOOP's procedure, or null. In a helper the record must be the object's global (not shadowed in
 * either procedure), the implicit Rec, or a `var` parameter bound to a plain name.
 */
function r572NextKey(l: ALSyntaxNode, frame: R572Frame, ctx: SemanticContext): string | null {
  const c = r531Call(l);
  const key = c === null ? null : (c.recv ?? (r531Implicit(l, ctx) ? "" : null));
  if (c === null || c.method !== "next" || key === null) return null;
  if (c.uncertain || c.args.length > 1) return null;
  const a = c.args[0];
  if (a !== undefined && !/^-?\d+$/.test(a.text.trim()) && !r572StepArgOk(a, l, frame, ctx))
    return null;
  const recv = r572Receiver(l);
  const t = recv === null ? null : declaredType(recv, ctx);
  // a Record, or a RecordRef (whose `Next` steps a record set the same way)
  const isRecRef =
    recv !== null &&
    normalizeAlName(
      resolveVarRef(recv, ctx)?.node.childForFieldName("type")?.namedChildren[0]?.text ?? "",
    ) === "recordref";
  if (key !== "" && !isRecRef && (t === null || t.kind !== "table")) return null;
  const h = frame.helper;
  if (h === null || key === "") return key;
  // map the helper's record to the loop's procedure
  if (objectGlobalNames(objectOf(h.proc) ?? h.proc).has(key) && !r531Declares(h.proc, key, true))
    return r531Declares(frame.scope, key, true) ? null : key;
  for (let i = 0; ; i++) {
    const p = r531Param(h.proc, i);
    if (p === null) return null;
    if (r531ParamKey(p[0]) !== key) continue;
    const arg = h.call.args[i];
    if (!p[1] || h.call.uncertain || arg === undefined || !isIdentifierLike(arg)) return null;
    return r531Key(arg);
  }
}

/**
 * Narrowing (a): may step argument `a` of the step call `next` stand in a forced test? In the loop's
 * own procedure, X must be an Integer local or by-value parameter that the loop never writes
 * (`r572StepInvariant`). In a helper, X must be a by-value parameter the helper never writes, bound
 * to a literal or to a name that passes the loop's own test.
 */
function r572StepArgOk(
  a: ALSyntaxNode,
  next: ALSyntaxNode,
  frame: R572Frame,
  ctx: SemanticContext,
): boolean {
  if (!r572InvariantStep.on || !isIdentifierLike(a)) return false;
  const h = frame.helper;
  if (h === null) return r572StepInvariant(a, frame.loop, frame.scope, next, ctx);
  const k = normalizeAlName(a.text);
  if (r531Declares(h.proc, k, false) || !r572IntegerVar(a, ctx)) return false;
  for (let i = 0; ; i++) {
    const p = r531Param(h.proc, i);
    if (p === null) return false;
    if (p[0] !== k) continue;
    if (p[1] || h.call.uncertain || r572WritesName(h.proc, k, new Set([r572At(next)]), ctx))
      return false;
    const arg = h.call.args[i];
    if (arg === undefined) return false;
    if (/^-?\d+$/.test(arg.text.trim())) return true;
    // the zero-step waiver: the helper's parameter is only ever a `Next` step, so the loop's
    // name may also be handed to this very call, at this position
    const hb = h.proc.namedChildren.find((x) => x.rawKind === "code_block") ?? null;
    const viaHelper =
      hb !== null && r572OnlyNextUses(hb, k, ctx)
        ? (cn: ALSyntaxNode, j: number) => samePos(cn, h.node) && j === i
        : undefined;
    return (
      isIdentifierLike(arg) && r572StepInvariant(arg, frame.loop, frame.scope, null, ctx, viaHelper)
    );
  }
}

/** A node's position key: wrapper nodes are not identical objects across walks. */
const r572At = (n: ALSyntaxNode): string => `${n.startIndex}|${n.endIndex}|${n.rawKind}`;

const r572IntegerVar = (x: ALSyntaxNode, ctx: SemanticContext): boolean => {
  const t = normalizeAlName(resolveVarRef(x, ctx)?.typeText ?? "");
  return t === "integer" || t === "biginteger";
};

/**
 * Narrowing (a) in the loop's procedure: X is an Integer LOCAL or BY-VALUE parameter (never a
 * global, a record field or a `var` parameter) and the loop never writes it (`r572WritesName`,
 * every `#if` arm read). With `r572RequireNonZeroStep`, X must also be a local whose every write
 * outside the loop is a non-zero integer literal, one of them before the loop on every path.
 */
function r572StepInvariant(
  x: ALSyntaxNode,
  loop: ALSyntaxNode,
  scope: ALSyntaxNode,
  next: ALSyntaxNode | null,
  ctx: SemanticContext,
  viaHelper?: (call: ALSyntaxNode, i: number) => boolean,
): boolean {
  const k = normalizeAlName(x.text);
  if (!r572IntegerVar(x, ctx)) return false;
  const local = r531Declares(scope, k, false);
  if (!local) {
    let byValue = false;
    for (let i = 0; ; i++) {
      const p = r531Param(scope, i);
      if (p === null) break;
      if (p[0] === k) byValue = !p[1];
    }
    if (!byValue) return false;
  }
  if (r572WritesName(loop, k, new Set(next === null ? [] : [r572At(next)]), ctx)) return false;
  if (!r572RequireNonZeroStep.on) return true;
  // the probed fact (see `r572RequireNonZeroStep`): X is only ever a cursor's `Next` step here
  if (r572OnlyNextUses(loop, k, ctx, viaHelper)) return true;
  if (!local) return false;
  const body = scope.namedChildren.find((c) => c.rawKind === "code_block") ?? null;
  if (body === null) return false;
  const inLoop = (n: ALSyntaxNode): boolean =>
    n.startIndex >= loop.startIndex && n.endIndex <= loop.endIndex;
  let ok = true;
  let before = false;
  const loopAncestors = new Set<number>();
  for (let a = loop.parent; a !== null; a = a.parent) loopAncestors.add(a.startIndex);
  visitAll(body, (n) => {
    if (!ok || inLoop(n) || n.kind !== ALNodeKind.assignment_statement) return;
    const l = n.childForFieldName("left");
    if (l === null || !isIdentifierLike(l) || normalizeAlName(l.text) !== k) return;
    const op = n.childForFieldName("operator")?.text.trim() ?? "";
    const v = n.childForFieldName("right")?.text.replace(/\s+/g, "") ?? "";
    if (op !== ":=" || !/^-?\d+$/.test(v) || Number(v) === 0) {
      ok = false;
      return;
    }
    if (n.startIndex >= loop.startIndex) return;
    // before the loop on every path: no branch between it and the block it shares with the loop
    let a = n.parent;
    while (a !== null && !loopAncestors.has(a.startIndex)) {
      if (R572_BRANCHES.has(a.rawKind)) return;
      a = a.parent;
    }
    if (a !== null && !R572_BRANCHES.has(a.rawKind)) before = true;
  });
  // any other write outside the loop (a `var` or built-in pass) also refuses
  const outside = r572WritesName(body, k, new Set(), ctx, (n) => !inLoop(n), false);
  return ok && before && !outside;
}

/**
 * Does anything under `n` (EVERY `#if` arm) write the plain name `k`: an assignment to it, or a
 * call that gets it as a bare argument, unless that call resolves to project procedures whose
 * parameter there is by value? A built-in (`Evaluate`, `Clear`, any other), an unresolved call and
 * an uncertain one (R567) count as writes. Calls in `skip` (the step itself) are not read; `where`
 * limits the nodes read; `assigns` false reads calls only.
 */
function r572WritesName(
  n: ALSyntaxNode,
  k: string,
  skip: ReadonlySet<string>,
  ctx: SemanticContext,
  where: (n: ALSyntaxNode) => boolean = () => true,
  assigns = true,
): boolean {
  let hit = false;
  visitAll(n, (x) => {
    if (hit || !where(x)) return;
    if (x.kind === ALNodeKind.assignment_statement) {
      const l = x.childForFieldName("left");
      if (assigns && l !== null && rootName(l) === k) hit = true;
      return;
    }
    if (skip.has(r572At(x))) return;
    const c = r531Call(x);
    if (c === null) return;
    c.args.forEach((a, i) => {
      if (hit || !isIdentifierLike(a) || normalizeAlName(a.text) !== k) return;
      const ts = c.uncertain ? [] : r570Targets(x, c, ctx, true);
      if (ts.length === 0) hit = true;
      for (const t of ts) {
        const p = r531Param(t, i);
        if (p === null || p[1]) hit = true;
      }
    });
  });
  return hit;
}

/**
 * Narrowing (a), the helper form: `call` resolves only to procedures of the loop's own object, and
 * EVERY exit of each one carries a forced step (`each` reads one exit's value in the helper's
 * frame): its last statement is an `exit(<value>)`, no exit is bare, and all exits force the same
 * cursor. The stepped record must not be touched otherwise in the helper (`r572HelperKeeps`: a
 * re-find each pass would never end). Returns that cursor's key in the loop's procedure.
 */
function r572HelperKeys(
  call: ALSyntaxNode,
  frame: R572Frame,
  ctx: SemanticContext,
  each: (x: ALSyntaxNode, hf: R572Frame) => string[],
): string[] {
  if (!r572InvariantStep.on || frame.helper !== null) return [];
  const c = r531Call(call);
  const obj = objectOf(frame.loop);
  if (c === null || obj === null) return [];
  const ts = r570Targets(call, c, ctx, true);
  if (ts.length === 0) return [];
  let common: Set<string> | null = null;
  for (const t of ts) {
    const to = objectOf(t);
    if (to === null || !samePos(to, obj) || !sameFile(rootOf(to), rootOf(obj))) return [];
    const body = t.namedChildren.find((x) => x.rawKind === "code_block") ?? null;
    const stmts = body?.namedChildren.find((x) => x.rawKind === "statement_block")?.namedChildren;
    const last = stmts?.filter((x) => !x.rawKind.includes("comment")).at(-1);
    if (body === null || last === undefined || last.rawKind !== "exit_statement") return [];
    const hf: R572Frame = {
      loop: frame.loop,
      scope: frame.scope,
      helper: { proc: t, call: c, node: call },
    };
    let keys: Set<string> | null = null;
    const steps = new Set<string>();
    let bad = false;
    visitAll(body, (x) => {
      if (bad || x.rawKind !== "exit_statement") return;
      const v = x.childForFieldName("return_value");
      const got = v === null ? [] : each(v, hf);
      if (got.length === 0) bad = true;
      else keys = new Set(got.filter((g) => keys === null || keys.has(g)));
      if (v !== null)
        visitAll(v, (y) => {
          if (r531Call(y)?.method === "next") steps.add(r572At(y));
        });
    });
    if (bad || keys === null) return [];
    const kept: string[] = [...(keys as Set<string>)].filter((k) =>
      r572HelperKeeps(t, r572HelperKey(t, k, c), steps, ctx),
    );
    common = new Set(kept.filter((k) => common === null || common.has(k)));
  }
  return common === null ? [] : [...common];
}

/** The helper's own key for the loop-frame cursor `k` (the inverse of `r572NextKey`'s mapping). */
function r572HelperKey(t: ALSyntaxNode, k: string, c: R531Call): string {
  for (let i = 0; ; i++) {
    const p = r531Param(t, i);
    if (p === null) return k; // a global, or the implicit Rec
    const a = c.args[i];
    if (p[1] && a !== undefined && isIdentifierLike(a) && r531Key(a) === k)
      return r531ParamKey(p[0]);
  }
}

/**
 * Does helper `t` leave its record `key` alone apart from the steps in `steps`? No other method on
 * it but a read-only one, no write to it or its fields, and no call that gets it (`r570Touches`
 * through a project procedure; anything else counts as touching). For a global or the implicit Rec,
 * a call to any procedure of the same object that names it counts as touching.
 */
function r572HelperKeeps(
  t: ALSyntaxNode,
  key: string,
  steps: ReadonlySet<string>,
  ctx: SemanticContext,
): boolean {
  const body = t.namedChildren.find((x) => x.rawKind === "code_block") ?? null;
  if (body === null) return false;
  const own = r531ObjectProcs(t, ctx);
  const global = !r531Declares(t, key, true);
  let moved = false;
  visitAll(body, (n) => {
    if (moved || steps.has(r572At(n))) return;
    if (n.kind === ALNodeKind.assignment_statement) {
      const l = n.childForFieldName("left");
      if (l !== null && (r531Key(l) === key || rootName(l) === key)) moved = true;
      if (key === "" && l !== null && isIdentifierLike(l) && r531Implicit(l, ctx)) moved = true;
      return;
    }
    const c = r531Call(n);
    if (c === null) return;
    const implicit = key === "" && c.recv === null && !own.has(c.method) && r531Implicit(n, ctx);
    if ((c.recv === key || implicit) && n.rawKind !== "member_expression") {
      if (!R572_READ_ONLY.has(c.method)) moved = true;
      return;
    }
    if (global && c.recv === null && own.has(c.method)) {
      for (const q of r570Targets(n, c, ctx))
        if (key === "" || r572Globals(q, ctx).has(key)) moved = true;
    }
    c.args.forEach((a, i) => {
      if (moved || !isIdentifierLike(a) || r531Key(a) !== key) return;
      const ts = c.uncertain ? [] : r570Targets(n, c, ctx, true);
      if (ts.length === 0) {
        if (!(c.recv === null && R531_PURE.has(c.method) && c.method !== "clear")) moved = true;
        return;
      }
      for (const q of ts) {
        const p = r531Param(q, i);
        if (p === null) moved = true;
        else if (r570Touches(q, r531ParamKey(p[0]), !p[1], 0, new Set(["*"]), ctx).length > 0)
          moved = true;
      }
    });
  });
  return !moved;
}

/**
 * Narrowing (a), the flag form, in the loop's own procedure: `k` is a LOCAL that the loop body
 * writes exactly once, unconditionally, by plain assignment, and never hands to a call (no
 * `var`-out pass, `Clear` or `Evaluate`; a local cannot be written by a subscriber). Then the flag
 * forces the exit when its assigned value does.
 */
/** Backstops (each REFUSES on its cut-off, never admits; counted as `backstopCutOffs`). */
const R572_FLAG_DEPTH = 8;
const R572_SLICE_PROCS = 64;

function r572FlagKeys(
  id: ALSyntaxNode,
  exitWhenTrue: boolean,
  frame: R572Frame,
  ctx: SemanticContext,
): string[] {
  if (!r572InvariantStep.on || frame.helper !== null) return [];
  const k = normalizeAlName(id.text);
  // the CAUSE of the BaseApp overflow (re-price): a flag fed from itself is a cycle; the visited set
  // ends it (never forced, so refused)
  if (frame.flags?.has(k) === true) return [];
  // BACKSTOP on top of it: a flag chain deeper than R572_FLAG_DEPTH is not followed (refused)
  if ((frame.flagDepth ?? 0) >= R572_FLAG_DEPTH) {
    if (r572GapSink !== null) r572GapSink.backstopCutOffs++;
    return [];
  }
  const body = frame.loop.childForFieldName("body");
  if (body === null || !r531Declares(frame.scope, k, false)) return [];
  const writes: ALSyntaxNode[] = [];
  let passed = false;
  visitAll(body, (n) => {
    // a `continue` of THIS loop can skip the write, and with it the step
    if (n.rawKind === "continue_statement") {
      let a = n.parent;
      while (a !== null && !BREAK_SCOPES.has(a.rawKind)) a = a.parent;
      if (a !== null && samePos(a, frame.loop)) passed = true;
      return;
    }
    if (n.kind === ALNodeKind.assignment_statement) {
      const l = n.childForFieldName("left");
      if (l !== null && rootName(l) === k) writes.push(n);
      return;
    }
    const c = r531Call(n);
    if (c?.args.some((a) => rootName(a) === k) === true) passed = true;
  });
  const [w] = writes;
  if (passed || writes.length !== 1 || w === undefined) return [];
  const l = w.childForFieldName("left");
  const v = w.childForFieldName("right");
  if (w.childForFieldName("operator")?.text.trim() !== ":=" || l === null || !isIdentifierLike(l))
    return [];
  if (v === null || !r572Unconditional(w, frame.loop)) return [];
  const flags = new Set([...(frame.flags ?? []), k]);
  const flagDepth = (frame.flagDepth ?? 0) + 1;
  return r572Forcing(v, exitWhenTrue, { ...frame, flags, flagDepth }, ctx);
}

/** Record and variable methods that leave the receiver as it was (anything else writes it). */
const R572_READ_ONLY: ReadonlySet<string> = new Set(
  (
    "count countapprox isempty getfilter getfilters getrangemin getrangemax fieldno fieldcaption " +
    "fieldname tablecaption tablename currentkey getposition recordid istemporary hasfilter marked " +
    "ascending getview systemid currentcompany readpermission writepermission fieldactive testfield " +
    "fielderror areloadfields isdirty haslinks"
  ).split(" "),
);

function r572LoopRows(loop: ALSyntaxNode, obj: ALSyntaxNode, ctx: SemanticContext): R572Row[] {
  const cond = loopConditionParts(loop);
  // the cursors whose step alone forces the exit; then a body exit guard can only end it sooner
  const forced = r572ForcedSteps(loop, ctx);
  const parts = forced.size > 0 ? cond : [...cond, ...bodyExitGuards(loop)];
  const feeds = indirectFeeds(loop, parts, ctx);
  const names = new Set<string>();
  for (const p of [...parts, ...feeds])
    r531Walk(p, ctx, (n) => {
      if (isIdentifierLike(n)) names.add(normalizeAlName(n.text));
    });
  const sameObject = (q: ALSyntaxNode): boolean => {
    const qo = objectOf(q);
    return qo === null || (samePos(qo, obj) && sameFile(rootOf(qo), rootOf(obj)));
  };
  const calls: {
    n: ALSyntaxNode;
    c: R531Call;
    flag: string;
    varOut: boolean;
    additive: boolean;
    ts: ALSyntaxNode[];
  }[] = [];
  for (const f of feeds) {
    const a = f.parent;
    const l = a?.kind === ALNodeKind.assignment_statement ? a.childForFieldName("left") : null;
    const ln =
      l === null || l === undefined
        ? null
        : isIdentifierLike(l)
          ? l
          : l.childForFieldName("member");
    const flag = ln === null ? "" : normalizeAlName(ln.text);
    // `T += X.D()` or `T := T + X.D()`: the call's result is accumulated into the flag
    let additive = false;
    if (a !== null && l !== null && l !== undefined && flag !== "") {
      const opText = a.text.slice(l.endIndex - a.startIndex, f.startIndex - a.startIndex).trim();
      if (opText === "+=" || opText === "-=") additive = true;
      r531Walk(f, ctx, (x) => {
        if (isIdentifierLike(x) && x.fieldName !== "member" && normalizeAlName(x.text) === flag)
          additive = true;
      });
    }
    r531Walk(f, ctx, (n) => {
      const c = r531Call(n);
      if (c !== null)
        calls.push({ n, c, flag, varOut: false, additive, ts: r570Targets(n, c, ctx) });
    });
  }
  // the exit parts' own calls (`while It.HasNext() do`): R570 refuses them only when the callee is
  // cursor-SHAPED; a stateful but unshaped callee is decided here by P (plan r2 review 1)
  for (const part of parts)
    r531Walk(part, ctx, (n) => {
      const c = r531Call(n);
      if (c !== null)
        calls.push({ n, c, flag: "", varOut: false, additive: false, ts: r570Targets(n, c, ctx) });
    });
  const body = loop.childForFieldName("body");
  if (body !== null)
    r531Walk(body, ctx, (n) => {
      const c = r531Call(n);
      if (c === null) return;
      const ts = r570Targets(n, c, ctx);
      c.args.forEach((a, i) => {
        if (!isIdentifierLike(a) || !names.has(normalizeAlName(a.text))) return;
        // a var-out FLAG is a simple value (Boolean, number, date, text): a record, codeunit or
        // other object handed by var is the cursor or helper, not a flag (R570/R531 territory)
        const decl = resolveVarRef(a, ctx)?.node ?? null;
        // the cheap var-position test first: `declarationStateAt` scans the whole object
        const hit = ts.filter((t) =>
          r531Positions(c, i, t).some((j) => r531Param(t, j)?.[1] === true),
        );
        if (hit.length === 0) return;
        // R725: a name the engine refuses to resolve ("unknown") may be a simple flag: count it
        // (fail closed, as R720); only a declaration that is provably not simple is skipped
        if (decl !== null || !r725Seam.on || declarationStateAt(a, ctx) !== "unknown") {
          const tn = decl?.childForFieldName("type")?.namedChildren[0] ?? null;
          const tk = tn?.rawKind ?? null;
          if (tk === null || !R572_SIMPLE_TYPES.has(tk)) return;
          if (tk === "basic_type" && !R572_SIMPLE_BASIC.has(normalizeAlName(tn?.text ?? "")))
            return;
        }
        calls.push({
          n,
          c,
          flag: normalizeAlName(a.text),
          varOut: true,
          additive: false,
          ts: hit,
        });
      });
    });
  const cursors = new Set(forced.keys());
  const filtered = cursors.size > 0 ? r570LoopFilters(loop, cursors, ctx) : new Set<string>();
  /** The names under which call `c` hands a forcing cursor to callee `q` (as R570's `shared`):
   *  `""` for a table procedure called on it, a `var` parameter's key, `R570_UNKNOWN` when the
   *  binding cannot be read; `byValue` for a by-value parameter. */
  const shared = (c: R531Call, q: ALSyntaxNode): { key: string; byValue: boolean }[] => {
    const out: { key: string; byValue: boolean }[] = [];
    if (cursors.has(c.recv ?? "")) {
      const kind = objectOf(q)?.rawKind;
      const table = kind === "table_declaration" || kind === "tableextension_declaration";
      out.push({ key: table ? "" : R570_UNKNOWN, byValue: false });
    }
    c.args.forEach((a, i) => {
      const k = isIdentifierLike(a) ? r531Key(a) : null;
      if (k === null || !cursors.has(k)) return;
      for (const j of r531Positions(c, i, q)) {
        const p = r531Param(q, j);
        if (p === null) out.push({ key: R570_UNKNOWN, byValue: false });
        else out.push({ key: c.uncertain ? R570_UNKNOWN : r531ParamKey(p[0]), byValue: !p[1] });
        // R604 census (M3): a RecordRef cursor handed BY VALUE (its sharing is not measured)
        if (r572GapSink !== null && p !== null && !p[1] && r572IsRecRef(a, ctx))
          r572GapSink.m3RecRefByValue++;
      }
    });
    return out;
  };
  const rows: R572Row[] = [];
  for (const { n, c, flag, varOut, additive, ts } of calls) {
    for (const q of ts) {
      /** R-604b: this same-object callee was refused by an M1 rule below (so it is not "dropped") */
      let m1Refused = false;
      if (cursors.size > 0) {
        const sh = shared(c, q);
        const own = sameObject(q);
        /** R-604b: refuse callee `q` and `chain` (stateful, no writers; the guard-writer rule follows) */
        const refuse = (reason: keyof R572Gaps, chain: ALSyntaxNode[]): void => {
          m1Refused = true;
          if (r572GapSink !== null) {
            r572GapSink.m1Refused++;
            r572GapSink[reason]++;
          }
          rows.push({
            loop,
            call: n,
            flag,
            varOut,
            wrapper: q,
            chain,
            stateful: true,
            selfFeed: false,
            additive,
            writers: [],
          });
        };
        // R-604b (I2): a forced GLOBAL cursor that a same-object callee names (not shadowed) is
        // shared by `var`, counted by name as `r572HelperKeeps` does
        const viaGlobal = new Set<string>();
        if (own) {
          const og = objectOf(q);
          const gn = og === null ? new Set<string>() : objectGlobalNames(og);
          const named = r572Globals(q, ctx);
          for (const k of cursors)
            if (k !== "" && gn.has(k) && named.has(k) && !sh.some((s) => s.key === k)) {
              sh.push({ key: k, byValue: false });
              viaGlobal.add(k);
            }
        }
        // R-604b (A0): a same-object callee that gets the cursor and inserts or renames rows of
        // the iterated table (any record: temporary, real or unknown) within R570_HOPS calls
        if (own && (sh.length > 0 || r572GapSink !== null)) {
          const ins = r604Inserters(q, r604CursorTables(loop, cursors, ctx), ctx);
          if (ins.length > 0 && sh.length > 0) refuse("m1RefusedA0", [q, ...ins]);
          // counted only: a callee that gets no cursor but inserts into the iterated table
          else if (ins.length > 0 && r572GapSink !== null) r572GapSink.m1A0NoCursor++;
        }
        // option D: the loop's own step alone forces the exit and the callee does not get that
        // cursor, so the callee can only end the loop sooner
        if (sh.length === 0) continue;
        // cursor touch (option b of R570): the callee gets the cursor but never moves, filters or
        // rewrites it (`r570Touches`): this ROW (this callee and its chain) is exempt
        if (
          sh.every(
            (s) =>
              s.key !== R570_UNKNOWN &&
              r570Touches(q, s.key, s.byValue, 0, filtered, ctx).length === 0,
          )
        )
          continue;
        // R-604b (var-touch): a same-object callee that gets the cursor unreadably, or by `var`,
        // and touches it for ANY r570Scan reason is refused with its touches (an unreadable
        // binding: with the touches of its record parameters). By value keeps today's drop.
        if (own) {
          const hit = sh.flatMap((s) =>
            s.key === R570_UNKNOWN
              ? [q, ...r604RecordParamTouches(q, filtered, ctx)]
              : s.byValue
                ? []
                : r570Touches(q, s.key, false, 0, filtered, ctx),
          );
          if (hit.length > 0)
            refuse(
              sh.some((s) => s.key === R570_UNKNOWN)
                ? "m1RefusedUnknown"
                : sh.some((s) => viaGlobal.has(s.key) && !s.byValue)
                  ? "m1RefusedGlobal"
                  : "m1RefusedVar",
              hit,
            );
        }
      }
      let wrapper: ALSyntaxNode | null = null;
      let chain: ALSyntaxNode[];
      if (!sameObject(q)) chain = r572Chain(q, 0, ctx);
      else {
        chain = r570ExitTargets(q, ctx)
          .filter((t) => !sameObject(t))
          .flatMap((t) => r572Chain(t, 1, ctx));
        if (chain.length === 0) {
          // R604 census (M1): a same-object callee that gets and TOUCHES the forced cursor, with no
          // `exit(<call>)` into another object, and that no M1 rule refused: dropped
          if (r572GapSink !== null && cursors.size > 0 && !m1Refused) r572GapSink.m1Dropped++;
          continue;
        }
        wrapper = q;
      }
      const stateful = chain.some((p) => r572Stateful(p, R572_STATE_HOPS, ctx));
      const selfFeed =
        flag !== "" &&
        !varOut &&
        c.args.some((a) => isIdentifierLike(a) && normalizeAlName(a.text) === flag);
      const writers = stateful ? r572ValueWriters(chain, loop, ctx) : [];
      rows.push({
        loop,
        call: n,
        flag,
        varOut,
        wrapper,
        chain,
        stateful,
        selfFeed,
        additive,
        writers,
      });
    }
  }
  return rows;
}

/**
 * R604: counters for the gaps master already has (R572 review r1 H2, M1, M2, M3), filled while
 * `r572Census` runs and never read by the refusal itself. Each counts a SHAPE, not mutants:
 * - `h2SplitQueue`: a pure (non-stateful) exit chain that reads a local REAL record of table T,
 *   with a loop-body call into the same object that inserts, modifies, deletes or renames T;
 * - M1 (R-604b narrowed it; two counters were split out of the old `m1TouchViaWrapper`):
 *   `m1Dropped` is a same-object callee that gets and touches the cursor, has no `exit(<call>)`
 *   into another object, and that no M1 rule refused (so it is still dropped, e.g. a cursor by
 *   value); `m1Refused` counts the refusals the M1 rules add, one per rule row, split by reason
 *   into `m1RefusedA0` (inserts or renames rows of the iterated table), `m1RefusedVar` (a `var`
 *   cursor touched), `m1RefusedUnknown` (an unreadable binding) and `m1RefusedGlobal` (a forced
 *   global cursor named in the callee); `m1A0NoCursor` is a callee that gets NO cursor but
 *   inserts into the iterated table (counted only, limit L2);
 * - `m2ReachCutOff`: a stateful chain whose writer reach stopped at the hop cap with calls unread;
 * - `m3CopyShared`: a `Copy(X, true)` in a refused chain's object (an alias of shared state);
 * - `m3RecRefByValue`: a forced RecordRef cursor handed BY VALUE to a callee;
 * - `s3AliasViaVarCallee`: a refused chain procedure hands a name to a same-object callee's `var`
 *   parameter that the callee assigns from a global (`CopyInto(L)` doing `R := G`);
 * - `s4WithGlobal`: a refused chain procedure holds a `with G do` whose subject is a global.
 * Not an R604 gap: `backstopCutOffs` counts each time a depth BACKSTOP cut a walk off and refused
 * (`R572_FLAG_DEPTH`, `R572_SLICE_PROCS`), so the backstops' cost shows in the re-price.
 */
export interface R572Gaps {
  h2SplitQueue: number;
  m1Dropped: number;
  m1Refused: number;
  m1RefusedA0: number;
  m1RefusedVar: number;
  m1RefusedUnknown: number;
  m1RefusedGlobal: number;
  m1A0NoCursor: number;
  m2ReachCutOff: number;
  m3CopyShared: number;
  m3RecRefByValue: number;
  s3AliasViaVarCallee: number;
  s4WithGlobal: number;
  backstopCutOffs: number;
}
let r572GapSink: R572Gaps | null = null;

const r572IsRecRef = (a: ALSyntaxNode, ctx: SemanticContext): boolean =>
  isIdentifierLike(a) &&
  normalizeAlName(
    resolveVarRef(a, ctx)?.node.childForFieldName("type")?.namedChildren[0]?.text ?? "",
  ) === "recordref";

/** The tables `p` reaches through LOCAL non-temporary records, with `methods` on them. */
function r572LocalTables(
  p: ALSyntaxNode,
  methods: ReadonlySet<string>,
  ctx: SemanticContext,
): Set<string> {
  const out = new Set<string>();
  r531Walk(p, ctx, (n) => {
    const c = r531Call(n);
    if (c === null || c.recv === null || !methods.has(c.method)) return;
    if (!r531Declares(p, c.recv, false)) return;
    const recv = r572Receiver(n);
    const t = recv === null ? null : declaredType(recv, ctx);
    if (t !== null && t.kind === "table" && !t.temporary) out.add(t.name);
  });
  return out;
}

/** Census (scripts/r572-flag-census.ts): every R572 row of the project, the procedures R572
 *  adds to R570's own refusals (by procedure, not yet by name), and what the `r572-guard-writer`
 *  reason refuses: its guard expressions in loop bodies and the procedures they call. */
export function r572Census(ctx: SemanticContext): {
  rows: R572Row[];
  extra: ALSyntaxNode[];
  guards: { sites: ALSyntaxNode[]; procs: ALSyntaxNode[] };
  gaps: R572Gaps;
} {
  const gaps: R572Gaps = {
    h2SplitQueue: 0,
    m1Dropped: 0,
    m1Refused: 0,
    m1RefusedA0: 0,
    m1RefusedVar: 0,
    m1RefusedUnknown: 0,
    m1RefusedGlobal: 0,
    m1A0NoCursor: 0,
    m2ReachCutOff: 0,
    m3CopyShared: 0,
    m3RecRefByValue: 0,
    s3AliasViaVarCallee: 0,
    s4WithGlobal: 0,
    backstopCutOffs: 0,
  };
  r572GapSink = gaps;
  try {
    return { ...r572CensusRun(ctx, gaps), gaps };
  } finally {
    r572GapSink = null;
  }
}

const R572_READS: ReadonlySet<string> = new Set([...R570_CURSOR]);

/** R-604b: the tables of the loop's forced cursors; `null` in the set = a cursor of unknown table. */
function r604CursorTables(
  loop: ALSyntaxNode,
  cursors: ReadonlySet<string>,
  ctx: SemanticContext,
): Set<string | null> {
  const out = new Set<string | null>();
  const found = new Set<string>();
  for (const part of loopConditionParts(loop))
    r531Walk(part, ctx, (n) => {
      const c = r531Call(n);
      if (c === null || !cursors.has(c.recv ?? "")) return;
      const recv = r572Receiver(n);
      const t = recv === null ? null : declaredType(recv, ctx);
      found.add(c.recv ?? "");
      if (t !== null && t.kind === "table") out.add(t.name);
      else if (c.recv === "" || c.recv === null) {
        const o = objectOf(loop);
        out.add(o === null ? null : r604ObjectTable(o));
      } else out.add(null);
    });
  for (const k of cursors) if (!found.has(k)) out.add(null);
  return out;
}

/** The table a table or tableextension object is (normalized), else null. */
function r604ObjectTable(o: ALSyntaxNode): string | null {
  if (o.rawKind === "table_declaration") return objectNameOf(o);
  if (o.rawKind === "tableextension_declaration") {
    const t = o.childForFieldName("base_object") ?? o.childForFieldName("target");
    return t === null ? null : normalizeAlName(t.text);
  }
  return null;
}

const R604_ROWS_IN: ReadonlySet<string> = new Set(["insert", "rename"]);

/** R-604b (A0): procedures within R570_HOPS calls of `q` (any object, `q` included) that insert or
 *  rename rows of a table in `tables` through ANY record; an unknown table on either side matches.
 *  A paren-less `X.Insert;` is a member expression and counts (N1). Not followed (limits): `Codeunit.Run`,
 *  page, report and XMLport inserts, and inserts deeper than R570_HOPS calls. */
function r604Inserters(
  q: ALSyntaxNode,
  tables: ReadonlySet<string | null>,
  ctx: SemanticContext,
): ALSyntaxNode[] {
  const seen = new Map<string, ALSyntaxNode>([[r572Id(q), q]]);
  let todo = [q];
  const out: ALSyntaxNode[] = [];
  const matches = (name: string | null): boolean =>
    name === null || tables.has(null) || tables.has(name);
  for (let d = 0; d <= R570_HOPS && todo.length > 0; d++) {
    const next: ALSyntaxNode[] = [];
    for (const p of todo) {
      let hit = false;
      r531Walk(p, ctx, (n) => {
        const c = r531Call(n);
        if (c === null) return;
        if (!hit && R604_ROWS_IN.has(c.method)) {
          if (c.recv === "" || (c.recv === null && r531Implicit(n, ctx))) {
            const o = objectOf(p);
            if (matches(o === null ? null : r604ObjectTable(o))) hit = true;
          } else if (c.recv !== null) {
            const recv = r572Receiver(n);
            const t = recv === null ? null : declaredType(recv, ctx);
            if (t === null || (t.kind === "table" && matches(t.name))) hit = true;
          }
        }
        for (const t of r570Targets(n, c, ctx)) {
          const id = r572Id(t);
          if (seen.has(id)) continue;
          seen.set(id, t);
          next.push(t);
        }
      });
      if (hit) out.push(p);
    }
    todo = next;
  }
  return out;
}

/** R-604b (I3): `r570Touches` over each record parameter of `q`, by its own var/by-value mode. */
function r604RecordParamTouches(
  q: ALSyntaxNode,
  filtered: ReadonlySet<string>,
  ctx: SemanticContext,
): ALSyntaxNode[] {
  const list = q.namedChildren.find((c) => c.rawKind === "parameter_list");
  const ps = list?.namedChildren.filter((c) => c.rawKind === "parameter") ?? [];
  const out: ALSyntaxNode[] = [];
  ps.forEach((p, i) => {
    if (!/:\s*record/i.test(p.text)) return;
    const prm = r531Param(q, i);
    if (prm === null) return;
    out.push(...r570Touches(q, r531ParamKey(prm[0]), !prm[1], 0, filtered, ctx));
  });
  return out;
}

function r572CensusRun(
  ctx: SemanticContext,
  gaps: R572Gaps,
): {
  rows: R572Row[];
  extra: ALSyntaxNode[];
  guards: { sites: ALSyntaxNode[]; procs: ALSyntaxNode[] };
} {
  const base = new Map<string, Set<string>>();
  const rows: R572Row[] = [];
  const guards = { sites: [] as ALSyntaxNode[], procs: [] as ALSyntaxNode[] };
  const copyObjects = new Set<string>();
  for (const o of projectObjects(ctx))
    r531Walk(o, ctx, (loop) => {
      if (!LOOP_KINDS.has(loop.kind)) return;
      for (const p of r570LoopCallees(loop, o, ctx)) {
        const po = objectOf(p);
        if (po === null) continue;
        const set = base.get(objectKey(po)) ?? new Set<string>();
        for (const k of procNames(p)) set.add(k);
        base.set(objectKey(po), set);
      }
      const lr = r572LoopRows(loop, o, ctx);
      rows.push(...lr);
      const refused = lr
        .filter((r) => r.stateful)
        .flatMap((r) => [...(r.wrapper === null ? [] : [r.wrapper]), ...r.chain, ...r.writers]);
      if (refused.length > 0) {
        const g = r572WriterGuards(loop, refused, ctx);
        guards.sites.push(...g.exprs);
        guards.procs.push(...g.procs);
      }
      // R604 (M3): `Copy(X, true)` anywhere in a refused chain's object, once per object
      for (const p of refused) {
        const po = objectOf(p);
        const key = po === null ? null : `${r572Id(rootOf(po))}|${objectKey(po)}`;
        if (po === null || key === null || copyObjects.has(key)) continue;
        copyObjects.add(key);
        visitAll(po, (n) => {
          const c = r531Call(n);
          const share = c?.args[1]?.text.trim().toLowerCase();
          if (c?.method === "copy" && c.args.length === 2 && share === "true") gaps.m3CopyShared++;
        });
      }
      // R604 (H2): a pure exit chain reading a local real table T, and a body call into the same
      // object that writes T
      const body = loop.childForFieldName("body");
      for (const r of lr) {
        if (r.stateful || body === null) continue;
        const reads = new Set(r.chain.flatMap((p) => [...r572LocalTables(p, R572_READS, ctx)]));
        if (reads.size === 0) continue;
        const objs = r.chain.map(objectOf).filter((x): x is ALSyntaxNode => x !== null);
        let hit = false;
        r531Walk(body, ctx, (n) => {
          const c = hit ? null : r531Call(n);
          if (c === null) return;
          for (const t of r570Targets(n, c, ctx)) {
            const to = objectOf(t);
            if (to === null || !objs.some((x) => samePos(x, to) && sameFile(rootOf(x), rootOf(to))))
              continue;
            for (const w of r572LocalTables(t, R572_ROWS, ctx)) if (reads.has(w)) hit = true;
          }
        });
        if (hit) gaps.h2SplitQueue++;
      }
      // R604 (S3, S4): aliases of a global the value path does not follow, in a refused chain
      for (const r of lr) {
        if (!r.stateful) continue;
        for (const p of r.chain) {
          const o = objectOf(p);
          if (o === null) continue;
          const globals = objectGlobalNames(o);
          visitAll(p, (n) => {
            if (n.rawKind === "with_statement") {
              const s = n.childForFieldName("record");
              if (s !== null && isIdentifierLike(s) && globals.has(normalizeAlName(s.text)))
                gaps.s4WithGlobal++;
              return;
            }
            const c = r531Call(n);
            if (c === null || c.args.length === 0) return;
            for (const t of r570Targets(n, c, ctx)) {
              const to = objectOf(t);
              if (to === null || !samePos(to, o) || !sameFile(rootOf(to), rootOf(o))) continue;
              c.args.forEach((_a, i) => {
                const prm = r531Param(t, i);
                if (prm === null || !prm[1]) return;
                const k = r531ParamKey(prm[0]);
                visitAll(t, (x) => {
                  if (x.kind !== ALNodeKind.assignment_statement) return;
                  const l = x.childForFieldName("left");
                  const rhs = x.childForFieldName("right");
                  if (l === null || rhs === null || rootName(l) !== k) return;
                  if (isIdentifierLike(rhs) && globals.has(normalizeAlName(rhs.text)))
                    gaps.s3AliasViaVarCallee++;
                });
              });
            }
          });
        }
      }
    });
  const extra = new Map<string, ALSyntaxNode>();
  for (const r of rows) {
    if (!r.stateful) continue;
    for (const p of [...(r.wrapper === null ? [] : [r.wrapper]), ...r.chain, ...r.writers]) {
      const po = objectOf(p);
      const b = po === null ? undefined : base.get(objectKey(po));
      if (b !== undefined && procNames(p).some((k) => b.has(k))) continue;
      extra.set(`${po === null ? "" : objectKey(po)}|${p.startIndex}`, p);
    }
  }
  return { rows, extra: [...extra.values()], guards };
}

function r572LoopRefusals(
  loop: ALSyntaxNode,
  obj: ALSyntaxNode,
  ctx: SemanticContext,
): ALSyntaxNode[] {
  if (!r572Seam.on) return [];
  const refused = r572LoopRows(loop, obj, ctx)
    .filter((r) => r.stateful)
    .flatMap((r) => [...(r.wrapper === null ? [] : [r.wrapper]), ...r.chain, ...r.writers]);
  if (refused.length === 0 || !r572GuardWriter.on) return refused;
  const g = r572WriterGuards(loop, refused, ctx);
  const sites = r572GuardSiteMap.get(ctx) ?? [];
  sites.push(...g.exprs);
  r572GuardSiteMap.set(ctx, sites);
  return [...refused, ...g.procs];
}

/**
 * Orchestrator ruling 2026-10-21 (R572 ruling 2), refusal reason `r572-guard-writer`: a guard
 * that DOMINATES a call into a refused procedure inside the loop body
 * (`if It.ShouldAdvance() then It.Advance()`) is part of the protected slice. A mutant there can
 * keep the body from ever calling the writer, and the loop never ends. Refused: every site in such
 * a guard expression (`inR572Guard`) and every procedure a call in it reaches (the callee, and its
 * `exit(<call>)` chain when it is in another object). A call NOT under such a guard is unchanged.
 * Test seam: off gives the plan-r4 rule (the re-price's off leg counts what this adds); the census
 * (`r572Census().guards`, `scripts/r572-flag-census.ts`) counts the sites and procedures.
 */
export const r572GuardWriter = { on: true };

/** ctx -> the guard expressions `r572-guard-writer` refuses (filled while `r570Reach` runs). */
const r572GuardSiteMap = new WeakMap<object, ALSyntaxNode[]>();

function r572WriterGuards(
  loop: ALSyntaxNode,
  refused: readonly ALSyntaxNode[],
  ctx: SemanticContext,
): { exprs: ALSyntaxNode[]; procs: ALSyntaxNode[] } {
  const body = loop.childForFieldName("body");
  if (body === null) return { exprs: [], procs: [] };
  const ids = new Set(refused.map(r572Id));
  const obj = objectOf(loop);
  const sameObject = (q: ALSyntaxNode): boolean => {
    const qo = objectOf(q);
    return qo === null || obj === null || (samePos(qo, obj) && sameFile(rootOf(qo), rootOf(obj)));
  };
  /** Does same-object procedure `q` call a refused procedure, itself or through same-object calls
   *  (R570_HOPS deep)? (review r1 P5: `if T.ShouldAdvance() then DoAdvance()`) */
  const wraps = (q: ALSyntaxNode, depth: number, seen: Set<string>): boolean => {
    if (depth >= R570_HOPS || seen.has(r572Id(q))) return false;
    seen.add(r572Id(q));
    let hit = false;
    r531Walk(q, ctx, (n) => {
      const c = hit ? null : r531Call(n);
      if (c === null) return;
      for (const t of r570Targets(n, c, ctx))
        if (ids.has(r572Id(t)) || (sameObject(t) && wraps(t, depth + 1, seen))) hit = true;
    });
    return hit;
  };
  const callsRefused = (n: ALSyntaxNode): boolean => {
    const c = r531Call(n);
    return (
      c !== null &&
      r570Targets(n, c, ctx).some(
        (t) => ids.has(r572Id(t)) || (sameObject(t) && wraps(t, 0, new Set())),
      )
    );
  };
  const exprs = exitGuards(body, loop, callsRefused);
  // review r1 P1: the guard of a `continue` of THIS loop that comes before a writer call skips it
  let lastWriter = -1;
  visitAll(body, (n) => {
    if (callsRefused(n)) lastWriter = Math.max(lastWriter, n.startIndex);
  });
  const skips = (n: ALSyntaxNode): boolean => {
    if (n.rawKind !== "continue_statement" || n.startIndex >= lastWriter) return false;
    let a = n.parent;
    while (a !== null && !BREAK_SCOPES.has(a.rawKind)) a = a.parent;
    return a !== null && samePos(a, loop);
  };
  exprs.push(...exitGuards(body, loop, skips));
  // review r1 P2: what feeds a guard (`Adv := T.ShouldAdvance(); if Adv then ...`), R480's feeds
  if (exprs.length > 0) exprs.push(...indirectFeeds(loop, [...exprs], ctx));
  const procs: ALSyntaxNode[] = [];
  for (const e of exprs)
    r531Walk(e, ctx, (n) => {
      const c = r531Call(n);
      if (c === null) return;
      for (const q of r570Targets(n, c, ctx)) {
        if (!sameObject(q)) {
          procs.push(...r572Chain(q, 0, ctx));
          continue;
        }
        // review r1 P3: a same-object guard helper, and (I3b) its `exit(<call>)` into another object
        procs.push(
          q,
          ...r570ExitTargets(q, ctx)
            .filter((t) => !sameObject(t))
            .flatMap((t) => r572Chain(t, 1, ctx)),
        );
      }
    });
  return { exprs, procs };
}

/** Is `node` inside a guard expression `r572-guard-writer` refuses? */
function inR572Guard(node: ALSyntaxNode, ctx: SemanticContext): boolean {
  r570Reach(ctx);
  const root = rootOf(node);
  return (r572GuardSiteMap.get(ctx) ?? []).some(
    (e) =>
      node.startIndex >= e.startIndex &&
      node.endIndex <= e.endIndex &&
      samePos(rootOf(e), root) &&
      sameFile(rootOf(e), root),
  );
}

/** `p` and the procedures its `exit(<call>)` chain reaches, no shape test (R570_HOPS deep). */
function r572Chain(p: ALSyntaxNode, depth: number, ctx: SemanticContext): ALSyntaxNode[] {
  return depth < R570_HOPS
    ? [p, ...r570ExitTargets(p, ctx).flatMap((t) => r572Chain(t, depth + 1, ctx))]
    : [p];
}

/** How deep `r572Stateful` follows the calls in a body; deeper is UNKNOWN, so stateful. */
const R572_STATE_HOPS = 4;
const R572_PERSIST: ReadonlySet<string> = new Set(
  "find findfirst findlast findset next delete deleteall".split(" "),
);
const R572_ROWS: ReadonlySet<string> = new Set(
  "insert modify modifyall delete deleteall rename".split(" "),
);
const R572_SIMPLE_TYPES: ReadonlySet<string> = new Set(["basic_type", "text_type", "code_type"]);
const R572_SIMPLE_BASIC: ReadonlySet<string> = new Set(
  "boolean integer biginteger decimal date time datetime duration char byte option guid".split(" "),
);
const R572_UNKNOWN_KINDS: ReadonlySet<string> = new Set(["codeunit", "interface"]);
const R572_RUNNABLE_KINDS: ReadonlySet<string> = new Set(["page", "report", "xmlport", "query"]);

/** The globals of `p`'s object that `p` names (not shadowed by a local or a parameter). */
function r572Globals(p: ALSyntaxNode, ctx: SemanticContext): Set<string> {
  return cached(ctx, p, "r572globals", () => {
    const out = new Set<string>();
    const o = objectOf(p);
    const body = p.namedChildren.find((x) => x.rawKind === "code_block") ?? null;
    if (o === null || body === null) return out;
    const globals = new Set<string>();
    for (const c of o.childForFieldName("body")?.namedChildren ?? [])
      if (c.rawKind === "var_section")
        visitAll(c, (v) => {
          if (v.rawKind === "variable_declaration")
            for (const nm of declaredNames(v)) globals.add(normalizeAlName(nm));
        });
    if (globals.size === 0) return out;
    r531Walk(body, ctx, (n) => {
      if (!isIdentifierLike(n) || n.fieldName === "member") return;
      const k = normalizeAlName(n.text);
      if (globals.has(k) && !r531Declares(p, k, true)) out.add(k);
    });
    return out;
  });
}

/** The receiver node of a member call, or null. */
function r572Receiver(n: ALSyntaxNode): ALSyntaxNode | null {
  const f = n.rawKind === "member_expression" ? n : n.childForFieldName("function");
  if (f === null || f.rawKind !== "member_expression") return null;
  const o = f.childForFieldName("object");
  return o !== null && isIdentifierLike(o) ? o : null;
}

/**
 * R572: can `p`'s result depend on state that outlives the call? STATEFUL when, within `hops`
 * calls: it names a global of its object; it moves or deletes rows of its implicit Rec or a `var`
 * record parameter; it inserts, modifies, deletes or renames rows of any record that is not a LOCAL
 * TEMPORARY one; or it reaches UNKNOWN code: an event publisher, `Codeunit.Run`, a call into a
 * codeunit or interface with no project body, a parenthesised call of a table procedure with no
 * project body, a procedure with no body, or a call past the hop cap.
 */
function r572Stateful(p: ALSyntaxNode, hops: number, ctx: SemanticContext): boolean {
  // plan r2 review 4: a result reached while a cycle member was skipped is cached only once the
  // outermost call settles (nothing else in progress), never mid-cycle
  let byRoot = r572Memo.get(ctx);
  if (byRoot === undefined) {
    byRoot = new WeakMap();
    r572Memo.set(ctx, byRoot);
  }
  const root = rootOf(p);
  let m = byRoot.get(root);
  if (m === undefined) {
    m = new Map();
    byRoot.set(root, m);
  }
  const k = `${p.startIndex}|${p.endIndex}|${hops}`;
  const hit = m.get(k);
  if (hit !== undefined) return hit;
  const before = r572CycleSkips;
  const v = r572StatefulOnce(p, hops, ctx);
  if (r572CycleSkips === before || r572InProgress.size === 0) m.set(k, v);
  return v;
}
const r572Memo = new WeakMap<object, WeakMap<ALSyntaxNode, Map<string, boolean>>>();
let r572CycleSkips = 0;
const r572Id = (p: ALSyntaxNode): string => {
  let id = r572RootIds.get(rootOf(p));
  if (id === undefined) {
    id = r572RootIds.size + 1;
    // ponytail: a counter per root object; fine for one process' contexts
    r572RootIds.set(rootOf(p), id);
  }
  return `${id}|${p.startIndex}|${p.endIndex}`;
};
const r572RootIds = new Map<ALSyntaxNode, number>();

/** The `OnRun` triggers a `Codeunit.Run(Codeunit::X)` or `CU.Run()` call starts, or []. */
function r572RunTargets(n: ALSyntaxNode, c: R531Call, ctx: SemanticContext): ALSyntaxNode[] {
  if (c.method !== "run") return [];
  const names: string[] = [];
  if (c.recv === "codeunit" || c.recv === "\u0001codeunit") {
    const ref = c.args[0];
    const tn = ref?.rawKind === "database_reference" ? ref.childForFieldName("table_name") : null;
    if (tn !== null && tn !== undefined) names.push(normalizeAlName(tn.text));
  } else {
    const recv = r572Receiver(n);
    // R737: an ambiguous receiver starts every codeunit type's OnRun
    for (const t of recv === null ? [] : declaredTypes(recv, ctx))
      if (t.kind === "codeunit") names.push(t.name);
  }
  const out: ALSyntaxNode[] = [];
  for (const name of names)
    for (const o of objectsOfType({ kind: "codeunit", name, temporary: false }, ctx))
      visitAll(o, (x) => {
        if (x.rawKind !== "trigger_declaration") return;
        const nm = x.childForFieldName("name") ?? x.namedChildren.find((y) => isIdentifierLike(y));
        if (nm !== undefined && nm !== null && normalizeAlName(nm.text) === "onrun") out.push(x);
      });
  return out;
}

/** Receivers that are built-in namespaces, not variables (`Database.`, `CurrReport.`, ...). */
const R572_STATIC_RECEIVERS: ReadonlySet<string> = new Set(
  (
    "database page report xmlport query currreport currpage currxmlport system session " +
    "taskscheduler numbersequence isolatedstorage navapp"
  ).split(" "),
);

function r572StatefulOnce(p: ALSyntaxNode, hops: number, ctx: SemanticContext): boolean {
  {
    if (hops < 0) return true;
    if (attributeNamesOf(p).some((a) => PUBLISHERS.has(a))) return true;
    const body = p.namedChildren.find((x) => x.rawKind === "code_block") ?? null;
    if (body === null) return true;
    if (r572Globals(p, ctx).size > 0) return true;
    const vars = new Set<string>();
    for (let i = 0; ; i++) {
      const prm = r531Param(p, i);
      if (prm === null) break;
      if (prm[1]) vars.add(r531ParamKey(prm[0]));
    }
    const own = r531ObjectProcs(p, ctx);
    // a revisit while in progress reads as not stateful (the cycle adds no state of its own)
    r572InProgress.add(r572Id(p));
    let hit = false;
    r531Walk(body, ctx, (n) => {
      if (hit) return;
      if (n.kind === ALNodeKind.assignment_statement) {
        // writing a `var` parameter writes the CALLER's variable: state that outlives the call
        // (CDO String Functions.CutAtSeperator consumes its `var` text a token at a time)
        const l = n.childForFieldName("left");
        const ln = l === null ? null : isIdentifierLike(l) ? l : l.childForFieldName("object");
        if (ln !== null && vars.has(r531Key(ln) ?? "\u0003")) hit = true;
        return;
      }
      const c = r531Call(n);
      if (c === null) return;
      const paren = n.rawKind !== "member_expression";
      if ((c.recv === "codeunit" || c.recv === "\u0001codeunit") && c.method === "run") {
        hit = true;
        return;
      }
      const implicit = c.recv === null && r531Implicit(n, ctx) && !own.has(c.method);
      if (
        R572_PERSIST.has(c.method) &&
        (c.recv === "" || implicit || (c.recv !== null && vars.has(c.recv)))
      ) {
        hit = true;
        return;
      }
      const recv = r572Receiver(n);
      const t = recv === null ? null : declaredType(recv, ctx);
      if (paren && R572_ROWS.has(c.method)) {
        if (c.recv === "" || implicit) hit = true;
        else if (
          t !== null &&
          t.kind === "table" &&
          !(t.temporary && r531Declares(p, c.recv ?? "", false))
        )
          hit = true;
        if (hit) return;
      }
      const ts = r570Targets(n, c, ctx, true);
      if (ts.length === 0) {
        // UNKNOWN (plan r2 review 7): no target and no resolved built-in
        if (c.recv === null) {
          // a bare name: a global function (CopyStr, CalcDate, ...), unless it is a procedure of a
          // base (non-project) table that a tableextension extends
          if (
            objectOf(p)?.rawKind === "tableextension_declaration" &&
            implicit &&
            !R531_BUILTIN.has(c.method) &&
            !R572_ROWS.has(c.method) &&
            !r570ProjectRec(p, ctx)
          )
            hit = true;
          return;
        }
        if (t !== null) {
          if (t.kind === "table") {
            if (paren && !R531_BUILTIN.has(c.method) && !R572_ROWS.has(c.method)) hit = true;
          } else if (R572_UNKNOWN_KINDS.has(t.kind)) hit = true;
          else if (paren && R572_RUNNABLE_KINDS.has(t.kind)) hit = true; // a page/report's code
          return;
        }
        if (!paren) return; // a field read (`R.Field`), not a call
        const f = n.childForFieldName("function");
        const o = f?.rawKind === "member_expression" ? f.childForFieldName("object") : null;
        if (o === null || o === undefined) return;
        if (o.rawKind === "keyword_identifier") return; // `Database.`, `CurrReport.`, ...
        if (isIdentifierLike(o)) {
          if (R572_STATIC_RECEIVERS.has(normalizeAlName(o.text))) return;
          // a declared simple-type variable (Text, List, JsonObject, ...): its built-in
          // R725: an "unknown" name (e.g. an every-arm-ambiguous local record, which r531Declares
          // reads by text) is not proven simple: it falls through to `hit` (fail closed)
          if (
            resolveVarRef(o, ctx) !== null ||
            (r531Declares(p, normalizeAlName(o.text), true) &&
              !(r725Seam.on && declarationStateAt(o, ctx) === "unknown"))
          )
            return;
        }
        hit = true; // a chained or field receiver, or a name nothing declares
        return;
      }
      for (const q of ts) {
        if (r572InProgress.has(r572Id(q))) {
          r572CycleSkips++;
          continue;
        }
        if (r572Stateful(q, hops - 1, ctx)) {
          hit = true;
          return;
        }
      }
    });
    r572InProgress.delete(r572Id(p));
    return hit;
  }
}
const r572InProgress = new Set<string>();

/**
 * Narrowing (b) with the plan-r4 fixpoint: the procedures that WRITE the chain's VALUE PATH.
 *
 * Candidates are the procedures reachable (R572_STATE_HOPS calls, any object, `Codeunit.Run` steps
 * followed into `OnRun`) from the chain AND from every call in the loop's body (a split iterator
 * whose writer the body calls: `while It.GetNext() <> '' do It.Advance()`, PowerBI's TransitionTo).
 *
 * The path starts, per chain object, as the globals each chain procedure's RESULT is computed from
 * (`r572ValueNames`: exits, named return, `var` parameters, the guards above them, by name to a
 * fixpoint). A candidate in that object that writes a path global (`r572WritesNode`) is a writer;
 * every global it names joins the path, and this repeats until nothing changes (F1). Every writer
 * found is refused. A global is written at RECORD level (F6): any method on it but a read-only one,
 * any field assignment, any pass to a call but a resolved by-value parameter (F2).
 */
function r572ValueWriters(
  chain: ALSyntaxNode[],
  loop: ALSyntaxNode,
  ctx: SemanticContext,
): ALSyntaxNode[] {
  const reached = new Map(chain.map((p) => [r572Id(p), p]));
  let todo: ALSyntaxNode[] = [...chain];
  const step = (from: ALSyntaxNode): ALSyntaxNode[] => {
    const next: ALSyntaxNode[] = [];
    r531Walk(from, ctx, (n) => {
      const c = r531Call(n);
      if (c === null) return;
      for (const t of [...r570Targets(n, c, ctx), ...r572RunTargets(n, c, ctx)]) {
        const id = r572Id(t);
        if (reached.has(id)) continue;
        reached.set(id, t);
        next.push(t);
      }
    });
    return next;
  };
  const body = loop.childForFieldName("body");
  if (body !== null) todo.push(...step(body));
  for (let d = 0; d < R572_STATE_HOPS && todo.length > 0; d++) todo = todo.flatMap((x) => step(x));
  // R604 census (M2): the reach was cut off with calls still unread, so a writer may lie deeper
  // (read only: `step` would add to `reached`)
  if (r572GapSink !== null) {
    let cut = false;
    for (const x of todo)
      r531Walk(x, ctx, (n) => {
        const c = cut ? null : r531Call(n);
        if (c === null) return;
        for (const t of [...r570Targets(n, c, ctx), ...r572RunTargets(n, c, ctx)])
          if (!reached.has(r572Id(t))) cut = true;
      });
    if (cut) r572GapSink.m2ReachCutOff++;
  }
  const objKey = (p: ALSyntaxNode): string | null => {
    const o = objectOf(p);
    return o === null ? null : `${r572Id(rootOf(o))}|${objectKey(o)}`;
  };
  // the value path, per chain object
  const path = new Map<string, Set<string>>();
  for (const p of chain) {
    const k = objKey(p);
    if (k === null) continue;
    // the object's globals on the path (`r572ValueNames` returns GLOBAL names only: a name a
    // parameter or local of the procedure shadows is not one), including a same-object callee's
    const o = objectOf(p);
    const names = cached(ctx, p, "r572valuenames", () => r572ValueNames(p, ctx, new Set()));
    const set = path.get(k) ?? new Set<string>();
    for (const x of o === null ? [] : objectGlobalNames(o))
      if (names === null || names.has(x)) set.add(x);
    path.set(k, set);
  }
  const out = new Map<string, ALSyntaxNode>();
  for (let changed = true; changed; ) {
    changed = false;
    for (const [id, w] of reached) {
      const k = objKey(w);
      const g = k === null ? undefined : path.get(k);
      if (out.has(id) || g === undefined) continue;
      const wg = new Set([...r572Globals(w, ctx)].filter((x) => g.has(x)));
      if (wg.size === 0) continue;
      const wb = w.namedChildren.find((x) => x.rawKind === "code_block") ?? null;
      let writes = false;
      if (wb !== null)
        visitAll(wb, (n) => {
          if (!writes && r572WritesNode(n, wg, ctx)) writes = true;
        });
      if (!writes) continue;
      out.set(id, w);
      // F1: what the writer reads joins the path
      for (const x of r572Globals(w, ctx)) g.add(x);
      changed = true;
    }
  }
  return [...out.values()];
}

/** Global functions that never write an argument (anything else unresolved counts as writing). */
const R572_NO_WRITE: ReadonlySet<string> = new Set(
  "format strsubstno message error confirm strlen".split(" "),
);

/**
 * Does node `n` (an assignment or a call) write one of `names` (plain names of the scope `n` is
 * in)? An assignment whose target's ROOT is one of them (`G := `, `G.F := `, `G[i] := `). A call ON
 * one of them, unless the method is read-only (a parenless `G.Insert` counts; a field read `G.F`
 * does not). A call that gets one of them, or a member of one (`Buf.Val`, F2), as an argument,
 * unless every target resolves with a by-value parameter there and the argument is not a record
 * (a by-value temporary record shares its rows), or the call is a global function that never
 * writes (`Format`). Uncertain arguments (R567) count as writes.
 */
function r572WritesNode(
  n: ALSyntaxNode,
  names: ReadonlySet<string>,
  ctx: SemanticContext,
): boolean {
  if (n.kind === ALNodeKind.assignment_statement) {
    const l = n.childForFieldName("left");
    return l !== null && names.has(rootName(l));
  }
  const c = r531Call(n);
  if (c === null) return false;
  if (c.recv !== null && names.has(c.recv) && !R572_READ_ONLY.has(c.method)) {
    if (n.rawKind !== "member_expression") return true;
    if (R531_BUILTIN.has(c.method) || R572_ROWS.has(c.method)) return true;
  }
  let hit = false;
  c.args.forEach((a, i) => {
    if (hit || !names.has(rootName(a))) return;
    if (c.uncertain) {
      hit = true;
      return;
    }
    const ts = r570Targets(n, c, ctx, true);
    if (ts.length === 0) {
      if (!(c.recv === null && R572_NO_WRITE.has(c.method))) hit = true;
      return;
    }
    const recv = isIdentifierLike(a) ? declaredType(a, ctx) : null;
    if (recv !== null && recv.kind === "table") hit = true;
    for (const t of ts) {
      const js = r531Positions(c, i, t);
      if (js.length === 0) hit = true;
      for (const j of js) {
        const p = r531Param(t, j);
        if (p === null || p[1]) hit = true;
      }
    }
  });
  return hit;
}

/**
 * Narrowing (b): the plain names `p`'s RESULT is computed from (a backward slice, by name). Seeds:
 * every `exit(...)` value, the named return, the `var` parameters, and the guards above every exit
 * (F5). Then, to a fixpoint: an assignment to a path name adds its right side and the guards above
 * it; a call that WRITES a path name (`r572WritesNode`: `Buf.SetRange(F, X)`, `Evaluate(V, S)`)
 * adds its arguments and its guards; a path expression's call into a procedure of `p`'s own object
 * adds that procedure's path globals. null: undecidable (a same-object callee with no body, an
 * uncertain call in a path expression), so every global counts.
 */
function r572ValueNames(
  p: ALSyntaxNode,
  ctx: SemanticContext,
  seen: Set<string>,
): Set<string> | null {
  const body = p.namedChildren.find((x) => x.rawKind === "code_block") ?? null;
  if (body === null) return null;
  const path = new Set<string>();
  if (seen.has(r572Id(p))) return path;
  // BACKSTOP (the `seen` set already ends cycles): a slice through more than R572_SLICE_PROCS
  // same-object procedures is undecidable, so every global counts (refuses more)
  if (seen.size >= R572_SLICE_PROCS) {
    if (r572GapSink !== null) r572GapSink.backstopCutOffs++;
    return null;
  }
  seen.add(r572Id(p));
  const obj = objectOf(p);
  const rv = p.childForFieldName("return_value");
  if (rv !== null) path.add(normalizeAlName(rv.text));
  for (let i = 0; ; i++) {
    const prm = r531Param(p, i);
    if (prm === null) break;
    if (prm[1]) path.add(r531ParamKey(prm[0]));
  }
  const exprs: ALSyntaxNode[] = [];
  const guards = (n: ALSyntaxNode): void => {
    for (let a = n.parent; a !== null && !samePos(a, p); a = a.parent)
      exprs.push(...guardPartsOf(a));
  };
  visitAll(body, (x) => {
    if (x.rawKind !== "exit_statement") return;
    const v = x.childForFieldName("return_value");
    if (v !== null) exprs.push(v);
    guards(x);
  });
  let unknown = false;
  const done = new Set<string>();
  const fromCallees = new Set<string>();
  for (let changed = true; changed && !unknown; ) {
    changed = false;
    for (let e = exprs.pop(); e !== undefined && !unknown; e = exprs.pop())
      r531Walk(e, ctx, (n) => {
        if (isIdentifierLike(n) && n.fieldName !== "member") {
          const k = normalizeAlName(n.text);
          if (!path.has(k)) {
            path.add(k);
            changed = true;
          }
          return;
        }
        const c = r531Call(n);
        if (c === null) return;
        if (c.uncertain) unknown = true;
        for (const t of r570Targets(n, c, ctx)) {
          const to = objectOf(t);
          if (
            obj === null ||
            to === null ||
            !samePos(to, obj) ||
            !sameFile(rootOf(to), rootOf(obj))
          )
            continue;
          const s = r572ValueNames(t, ctx, seen);
          if (s === null) unknown = true;
          // the callee's GLOBALS: kept apart from `path`, whose names are `p`'s own (a local of
          // `p` with the same name is not the callee's global)
          else for (const x of s) fromCallees.add(x);
        }
      });
    visitAll(body, (n) => {
      if (unknown || done.has(r572At(n)) || !r572WritesNode(n, path, ctx)) return;
      done.add(r572At(n));
      changed = true;
      if (n.kind === ALNodeKind.assignment_statement) {
        const r = n.childForFieldName("right");
        const l = n.childForFieldName("left");
        if (r !== null) exprs.push(r);
        if (l !== null) exprs.push(l);
      } else exprs.push(...(r531Call(n)?.args ?? []));
      guards(n);
    });
  }
  if (unknown) return null;
  // re-price fix (Item Jnl.-Post Line, BaseApp): a name resolves to the object's GLOBAL only when
  // no parameter or local of `p` shadows it; a shadowed name is `p`'s own and never on the path
  const globals = new Set([...path].filter((x) => !r531Declares(p, x, true)));
  for (const x of fromCallees) globals.add(x);
  return globals;
}

const R570_UNKNOWN = "\u0002";
/** Record methods that move the cursor, change filters, marks, keys or rows, or run trigger code
 *  (`Validate`, `Insert`): a call of one on the shared record TOUCHES it. `Modify` and `ModifyAll`
 *  are not here: they touch under the field-write rule (`r570Touches`). */
const R570_TOUCH: ReadonlySet<string> = new Set(
  (
    "find findfirst findlast findset next get getbysystemid setposition reset setrange setfilter " +
    "setview setrecfilter copyfilters copy delete deleteall rename mark markedonly " +
    "clearmarks validate insert truncate setcurrentkey setascending changecompany"
  ).split(" "),
);
/** What still reaches the loop through a BY-VALUE copy: row changes (R531's by-value rule). */
const R570_CONSUME: ReadonlySet<string> = new Set(
  "delete deleteall rename insert truncate validate".split(" "),
);

/**
 * The fields the loop's cursor is filtered on in the loop's own procedure or trigger (`SetRange`/
 * `SetFilter` on it), `"*"` (any field) when that cannot be read: the cursor is the implicit Rec,
 * a parameter or a global (filtered elsewhere), a filter call's field is unreadable (R567), or the
 * cursor goes to a call that may set filters (a table procedure on it, a filter- or mark-changing
 * built-in, or any call it is passed to other than a pure function or another record's built-in).
 */
function r570LoopFilters(
  loop: ALSyntaxNode,
  cursors: ReadonlySet<string>,
  ctx: SemanticContext,
): ReadonlySet<string> {
  const out = new Set<string>();
  const scope = codeScope(loop);
  for (const k of cursors) {
    if (k === "" || scope === null || !r531Declares(scope, k, false)) {
      out.add("*");
      continue;
    }
    r531Walk(scope, ctx, (n) => {
      const c = r531Call(n);
      if (c === null) return;
      if (c.recv === k) {
        if (R531_FILTER.has(c.method)) out.add(r531Field(c) ?? "*");
        else if (R531_MARKS.has(c.method)) out.add("*");
        else if (!R531_BUILTIN.has(c.method)) {
          // a table procedure on the cursor: the filters it sets on its implicit Rec, one level
          // (ponytail: a deeper call, or none resolved, reads as any field)
          const ts = r570Targets(n, c, ctx, true);
          if (ts.length === 0) out.add("*");
          for (const t of ts) {
            const own = r531ObjectProcs(t, ctx);
            r531Walk(t, ctx, (m) => {
              const d = r531Call(m);
              if (d === null || (d.recv !== "" && d.recv !== null)) return;
              if (d.recv === null && own.has(d.method)) out.add("*");
              else if (R531_FILTER.has(d.method)) out.add(r531Field(d) ?? "*");
              else if (R531_MARKS.has(d.method)) out.add("*");
            });
          }
        }
        return;
      }
      if (!c.args.some((a) => isIdentifierLike(a) && r531Key(a) === k)) return;
      const pure = c.recv === null && R531_PURE.has(c.method) && c.method !== "clear";
      const otherBuiltin = c.recv !== null && R531_BUILTIN.has(c.method);
      if (!pure && !otherBuiltin) out.add("*");
    });
  }
  return out;
}

/** The shared record's table, for the field-write rule: its fields and every field of any of its
 *  keys (the table's and its project tableextensions'), or null when unknown (not a project table,
 *  no readable key). `key` `""` is `p`'s implicit Rec, else a parameter of `p`. */
function r570TableOf(
  p: ALSyntaxNode,
  key: string,
  ctx: SemanticContext,
): { fields: Set<string>; keys: Set<string> } | null {
  return cached(ctx, p, `r570table|${key}`, () => {
    let name: string | null = null;
    const o = objectOf(p);
    if (key === "" && o?.rawKind === "table_declaration") name = objectNameOf(o);
    else if (key === "" && o?.rawKind === "tableextension_declaration")
      name = normalizeAlName(lastFieldChild(o, "base_object")?.text ?? "");
    else {
      // a parameter of `p` (one named `Rec` is keyed `""`, `r531ParamKey`)
      const list = p.namedChildren.find((c) => c.rawKind === "parameter_list");
      const prms = list?.namedChildren.filter((c) => c.rawKind === "parameter") ?? [];
      prms.forEach((prm, i) => {
        const nm = r531Param(p, i)?.[0];
        if (nm === undefined || r531ParamKey(nm) !== key) return;
        const rec =
          prm.childForFieldName("type")?.namedChildren.find((c) => c.rawKind === "record_type") ??
          null;
        if (rec !== null) name = normalizeAlName(lastFieldChild(rec, "reference")?.text ?? "");
      });
    }
    if (name === null || name === "") return null;
    const objs = objectsOfType({ kind: "table", name, temporary: false }, ctx);
    if (!objs.some((o) => o.rawKind === "table_declaration")) return null;
    const keys = new Set<string>();
    for (const o of objs)
      visitAll(o, (k) => {
        if (k.rawKind !== "key_declaration") return;
        const fl = k.namedChildren.find((c) => c.rawKind === "field_list");
        for (const f of fl?.namedChildren ?? [])
          if (isIdentifierLike(f)) keys.add(normalizeAlName(f.text));
      });
    if (keys.size === 0) return null;
    const fields = new Set(ctx.symbols.fieldsOf(name).map((f) => normalizeAlName(f.name)));
    return { fields, keys };
  });
}

/** Is the implicit Rec of `p`'s object a table the project declares (a table, or a tableextension
 *  of a project table)? Otherwise a bare name there may be one of the base table's procedures. */
function r570ProjectRec(p: ALSyntaxNode, ctx: SemanticContext): boolean {
  const o = objectOf(p);
  if (o?.rawKind === "table_declaration") return true;
  if (o?.rawKind !== "tableextension_declaration") return false;
  const base = normalizeAlName(lastFieldChild(o, "base_object")?.text ?? "");
  return objectsOfType({ kind: "table", name: base, temporary: false }, ctx).some(
    (t) => t.rawKind === "table_declaration",
  );
}

/**
 * Option (b): the procedures through which `p` TOUCHES the record it knows as `key` (`""`: its
 * implicit Rec): `[p, ...]` when it does, `[]` when it does not. A `R570_TOUCH` method on it
 * (`R570_CONSUME` only when `byValue`), an assignment to it, a FIELD write under the field-write
 * rule (a field in any key of its table, one that cannot be resolved, or a field the loop filters
 * on, `r570LoopFilters`; `ModifyAll` of such a field; the same through a by-value copy, whose
 * `Modify` writes the row), `Modify(true)` (it runs OnModify),
 * `X.Copy(R, true)` (X then shares R's table), or handing it to a same-object helper, a table
 * procedure or a parameter that touches it in turn (up to `R570_TOUCH_HOPS`, with a visited set so
 * a cycle ends; orchestrator option d); every procedure on such a
 * path is returned, so it is refused too (build review IMPORTANT 2). UNKNOWN COUNTS AS TOUCHING:
 * an unresolved call that receives it, an uncertain call (R567) that may, a method on it that is
 * neither built in nor a project procedure, `Clear(R)`, a bare unknown name where the implicit
 * Rec's table is not the project's, and anything past the hop cap. Two readings that do not
 * touch: a read-only built-in (a field read, `TestField`, `CalcFields`, `Copy`/`TransferFields`
 * INTO another record, `GetTable`), and a bare name in a PROJECT table that is no procedure there
 * (a global function such as `Commit`, R531's rule).
 */
function r570Touches(
  p: ALSyntaxNode,
  key: string,
  byValue: boolean,
  depth: number,
  filtered: ReadonlySet<string>,
  ctx: SemanticContext,
): ALSyntaxNode[] {
  // option (d): VISITED, by procedure and the parameter the record is in: each is scanned once, a
  // revisit only adds an edge. Review fix 2: whether a node touches is settled on the whole graph
  // afterwards (it touches itself, or reaches one that does), never from a half-finished visit, so
  // every member of a touching cycle is refused from whichever member the walk entered at.
  const graph = new Map<string, { node: ALSyntaxNode; direct: boolean; kids: string[] }>();
  const visit = (n: ALSyntaxNode, k: string, bv: boolean, d: number): string => {
    const id = `${objectKey(objectOf(n) ?? n)}|${n.startIndex}|${k}|${bv}`;
    if (graph.has(id)) return id;
    const entry = { node: n, direct: false, kids: [] as string[] };
    graph.set(id, entry);
    const scan = r570Scan(n, k, bv, d, filtered, ctx);
    entry.direct = scan.direct;
    for (const [t, k2, bv2] of scan.next) entry.kids.push(visit(t, k2, bv2, d + 1));
    return id;
  };
  const root = visit(p, key, byValue, depth);
  const touching = new Set([...graph].filter(([, e]) => e.direct).map(([id]) => id));
  for (let changed = true; changed; ) {
    changed = false;
    for (const [id, e] of graph)
      if (!touching.has(id) && e.kids.some((k) => touching.has(k))) {
        touching.add(id);
        changed = true;
      }
  }
  if (!touching.has(root)) return [];
  return [...touching].flatMap((id) => {
    const e = graph.get(id);
    return e === undefined ? [] : [e.node];
  });
}

/** One procedure of `r570Touches`' walk: does it touch the record directly, and where does it hand
 *  the record on (procedure, the record's key there, by value)? */
function r570Scan(
  p: ALSyntaxNode,
  key: string,
  byValue: boolean,
  depth: number,
  filtered: ReadonlySet<string>,
  ctx: SemanticContext,
): { direct: boolean; next: [ALSyntaxNode, string, boolean][] } {
  const next: [ALSyntaxNode, string, boolean][] = [];
  const body = p.namedChildren.find((x) => x.rawKind === "code_block") ?? null;
  if (body === null || depth > R570_TOUCH_HOPS) return { direct: true, next };
  const hits = byValue ? R570_CONSUME : R570_TOUCH;
  const own = r531ObjectProcs(p, ctx);
  let direct = false;
  const follow = (t: ALSyntaxNode, k: string, bv: boolean): void => {
    next.push([t, k, bv]);
  };
  /** `ts` see the same implicit Rec; none resolved: unknown, so touching. */
  const viaRec = (ts: ALSyntaxNode[]): void => {
    if (ts.length === 0) direct = true;
    for (const t of ts) follow(t, "", byValue);
  };
  /** The field-write rule: "touch" for a field in any key of the table, or one that cannot be
   *  resolved (a table outside the project, unreadable keys, an unknown field); "filtered" for a
   *  field the loop filters on; "none" otherwise. */
  const fieldClass = (f: string | null): "touch" | "filtered" | "none" => {
    const t = r570TableOf(p, key, ctx);
    if (f === null || f === "*" || t === null || !t.fields.has(f) || t.keys.has(f)) return "touch";
    return filtered.has("*") || filtered.has(f) ? "filtered" : "none";
  };
  const fieldWrite = (f: string | null): void => {
    // review fix 1: a filtered field touches by itself, like a key field; waiting for a `Modify`
    // in the same body let a write in one procedure and the Modify in another escape. The same on
    // a BY-VALUE copy (its `Modify` writes the row): no `Modify` is awaited there either.
    if (fieldClass(f) !== "none") direct = true;
  };
  /** Does a call of `c`'s method on the shared record touch it? */
  const recMethod = (c: R531Call): boolean => {
    if (c.method === "modify") {
      // review fix 3: `Modify(true)` (any argument but the literal false) runs OnModify
      const a = c.args[0];
      return c.uncertain || (a !== undefined && normalizeAlName(a.text) !== "false");
    }
    if (c.method === "modifyall") return fieldClass(r531Field(c)) !== "none";
    return hits.has(c.method) || (c.method === "transferfields" && !byValue);
  };
  r531Walk(body, ctx, (n) => {
    if (n.kind === ALNodeKind.assignment_statement) {
      const l = n.childForFieldName("left");
      if (l === null) return;
      if (isIdentifierLike(l)) {
        if (r531Key(l) === key) {
          if (!byValue) direct = true; // `R := X`
        } else if (key === "" && r531Implicit(l, ctx)) fieldWrite(normalizeAlName(l.text)); // `Qty := 0`
      } else if (r531Key(l.childForFieldName("object")) === key) {
        // `R.Field := X`
        fieldWrite(normalizeAlName(l.childForFieldName("member")?.text ?? "") || null);
      }
      return;
    }
    const c = r531Call(n);
    if (c === null) return;
    if (c.recv === key) {
      // `R.M(...)` (or `Rec.M(...)` for the implicit Rec)
      if (recMethod(c)) direct = true;
      else if (c.method !== "modify" && c.method !== "modifyall" && !R531_BUILTIN.has(c.method)) {
        const ts = r570Targets(n, c, ctx);
        // a paren-less `R.X` that names no procedure is a field read
        if (c.uncertain) direct = true;
        else if (n.rawKind !== "member_expression" || ts.length > 0) viaRec(ts);
      }
    } else if (key === "" && c.recv === null && n.rawKind !== "member_expression") {
      if (own.has(c.method)) {
        viaRec(r570Targets(n, c, ctx)); // a same-object helper sees the same implicit Rec
      } else if (r531Implicit(n, ctx)) {
        if (recMethod(c)) direct = true;
        else if (c.method !== "modify" && c.method !== "modifyall" && !R531_BUILTIN.has(c.method)) {
          const ts = r570Targets(n, c, ctx, true);
          if (ts.length > 0) viaRec(ts);
          else if (!r570ProjectRec(p, ctx)) direct = true; // maybe the base table's procedure
        }
      }
    }
    // the record handed on as an argument
    const at = c.args.flatMap((a, i) => (isIdentifierLike(a) && r531Key(a) === key ? [i] : []));
    if (at.length === 0) return;
    if (c.uncertain) {
      direct = true;
      return;
    }
    if (c.recv === null && R531_PURE.has(c.method) && c.method !== "clear") return;
    if (c.method === "copy" && c.recv !== key && c.args.length > 1 && !byValue) {
      // `X.Copy(R, true)`: X shares R's table (`ShareTable`); any non-literal-false flag counts
      if (normalizeAlName(c.args[1]?.text ?? "") !== "false") direct = true;
      return;
    }
    const ts = r570Targets(n, c, ctx, true);
    if (ts.length === 0) {
      const readOnly =
        c.recv !== null &&
        c.recv !== key &&
        (R531_BUILTIN.has(c.method) || c.method === "gettable");
      if (!readOnly) direct = true;
      return;
    }
    for (const t of ts)
      for (const i of at)
        for (const j of r531Positions(c, i, t)) {
          const prm = r531Param(t, j);
          if (prm === null) direct = true;
          else follow(t, r531ParamKey(prm[0]), byValue || !prm[1]);
        }
  });
  return { direct, next };
}

/** The project procedures (with a body) that call `n` names, in any object. */
function r570Targets(
  n: ALSyntaxNode,
  c: R531Call,
  ctx: SemanticContext,
  complete = false,
): ALSyntaxNode[] {
  // R737: `complete` readers (an empty list means unresolved, strict) get [] for a partial union
  if (complete && r737Partial(n, ctx)) return [];
  const arity = r531CallArity(c);
  const own = objectOf(n);
  const same = bareCallee(n);
  let procs: ALSyntaxNode[];
  if (same !== null && own !== null && procedureNamesOf(own, ctx).has(same)) {
    procs = r531ProcsIn(own, same, arity, n, ctx);
  } else if (n.rawKind === "member_expression") {
    // a paren-less member call `CU.P`
    const recv = n.childForFieldName("object");
    const ts = recv !== null && isIdentifierLike(recv) ? declaredTypes(recv, ctx) : [];
    procs = ts
      .flatMap((t) => objectsOfType(t, ctx))
      .flatMap((o) => r531ProcsIn(o, c.method, 0, n, ctx));
  } else {
    const t = n.rawKind === "call_expression" ? callTargets(n, ctx) : null;
    procs = t === null ? [] : t.objs.flatMap((o) => r531ProcsIn(o, t.member, arity, n, ctx));
    if (c.recv === null) procs.push(...r531TableProcs(n, c.method, arity, ctx));
  }
  return procs.filter((p) => p.namedChildren.some((x) => x.rawKind === "code_block"));
}

/** Does `p` call a cursor method (by name, on a receiver or its implicit Rec) or hold a loop? */
function r570Shaped(p: ALSyntaxNode, ctx: SemanticContext): boolean {
  return cached(ctx, p, "r570shape", () => {
    const body = p.namedChildren.find((x) => x.rawKind === "code_block") ?? null;
    if (body === null) return false;
    const own = r531ObjectProcs(p, ctx);
    let hit = false;
    r531Walk(body, ctx, (n) => {
      if (hit) return;
      if (LOOP_KINDS.has(n.kind)) hit = true;
      const c = r531Call(n);
      if (c === null || !R570_CURSOR.has(c.method)) return;
      if (c.recv !== null || (r531Implicit(n, ctx) && !own.has(c.method))) hit = true;
    });
    return hit;
  });
}

/** `p` and every procedure its `exit(<call>)` chain reaches from hop `depth`, when `p` or a
 *  procedure on the chain is cursor-shaped; else []. The hop cap also ends a cycle. */
function r570Chain(p: ALSyntaxNode, depth: number, ctx: SemanticContext): ALSyntaxNode[] {
  const out =
    depth < R570_HOPS ? r570ExitTargets(p, ctx).flatMap((t) => r570Chain(t, depth + 1, ctx)) : [];
  return out.length > 0 || r570Shaped(p, ctx) ? [p, ...out] : [];
}

/** The project procedures the calls inside `p`'s `exit(...)` statements name. */
function r570ExitTargets(p: ALSyntaxNode, ctx: SemanticContext): ALSyntaxNode[] {
  const body = p.namedChildren.find((x) => x.rawKind === "code_block") ?? null;
  const out: ALSyntaxNode[] = [];
  if (body !== null)
    r531Walk(body, ctx, (e) => {
      if (e.rawKind !== "exit_statement") return;
      r531Walk(e, ctx, (n) => {
        const c = r531Call(n);
        if (c !== null) out.push(...r570Targets(n, c, ctx));
      });
    });
  return out;
}

const LOOP_OBJECTS: ReadonlySet<string> = new Set([
  "report_declaration",
  "reportextension_declaration",
  "xmlport_declaration",
]);

const PUBLISHERS: ReadonlySet<string> = new Set([
  "integrationevent",
  "businessevent",
  "internalevent",
]);

/** The attribute items written directly before a procedure. A comment or a `#pragma` between
 *  them is skipped (R567). */
function attributesOf(p: ALSyntaxNode): ALSyntaxNode[] {
  const par = p.parent;
  if (par === null) return [];
  const sibs = par.namedChildren;
  const i = sibs.findIndex((s) => samePos(s, p));
  const out: ALSyntaxNode[] = [];
  for (let j = i - 1; j >= 0; j--) {
    const s = sibs[j];
    if (s !== undefined && ATTRIBUTE_TRIVIA.has(s.rawKind)) continue;
    if (s === undefined || s.rawKind !== "attribute_item") break;
    out.push(s);
  }
  return out;
}

const ATTRIBUTE_TRIVIA: ReadonlySet<string> = new Set(["comment", "multiline_comment", "pragma"]);

export interface DeclaredType {
  /** `table` for a Record, else the object keyword: `codeunit`, `interface`, `report`, ... */
  readonly kind: string;
  /** The full object name, normalized (`normalizeAlName`): `"Cust. Ledger Entry"` stays one name. */
  readonly name: string;
  readonly temporary: boolean;
}

/** An object's own name, normalized the same way as `DeclaredType.name`. */
const objectNameOf = (o: ALSyntaxNode): string => {
  objectNameCalls++;
  return normalizeAlName(lastFieldChild(o, "object_name")?.text ?? "");
};
/** Test hook: how many times `objectNameOf` ran. */
export let objectNameCalls = 0;
/** Test hook: reset `objectNameCalls`. */
export function resetObjectNameCalls(): void {
  objectNameCalls = 0;
}

/**
 * The declared type of a receiver, read from the declaration's type NODE (`record_type` or
 * `object_reference_type`, its last `reference` segment through `lastFieldChild`, as the engine's
 * `classifyDeclaredType` does), never by splitting text: a quoted name with dots is one name. The
 * declaration is the symbol table's (`resolveVarRef`), else (an XMLport, which the symbol table does
 * not index) the nearest `var` declaration of that name in the enclosing trigger/procedure, then in
 * the object. Null when not found: the call is not followed.
 */
function declaredType(recv: ALSyntaxNode, ctx: SemanticContext): DeclaredType | null {
  const all = declaredTypes(recv, ctx);
  const [one] = all;
  return all.length === 1 && one !== undefined ? one : null;
}

/**
 * R737: every type the receiver may have. One for a name the symbol table resolves, or a plain
 * declaration. The text fallback also descends a var section's `#if` (`preproc_*`, never a
 * split-header procedure, whose locals are another procedure's): a decided file reads only the live
 * arm; an undecided file (or a context with no arm map) reads every arm. A declaration under no
 * `#if`, or in a live arm of a decided file, is CERTAIN. Scope order: a certain local wins alone;
 * else the local's uncertain declarations join the object's (certain ones alone, else uncertain).
 * Two or more types is ambiguous: `declaredType` answers null, the follow readers use the union.
 * Seam off: master (no descent, first match).
 */
function declaredTypes(recv: ALSyntaxNode, ctx: SemanticContext): DeclaredType[] {
  const resolved = resolveVarRef(recv, ctx)?.node ?? null;
  if (resolved !== null) {
    const t = typeOfDecl(resolved);
    return t === null ? [] : [t];
  }
  const name = normalizeAlName(recv.text);
  const hasMap = rawArmOf(ctx) !== undefined;
  const find = (holder: ALSyntaxNode): { decl: ALSyntaxNode; certain: boolean }[] => {
    const hits: { decl: ALSyntaxNode; certain: boolean }[] = [];
    const walk = (n: ALSyntaxNode, underIf: boolean): void => {
      for (const c of n.namedChildren) {
        if (c.rawKind === "variable_declaration") {
          // R521: any name of a multi-name declaration (PEPPOL's `A, B: Interface X`)
          // the `#if` node itself is not inside an inactive range; its compiled-out arm's body is
          if (
            (!r737Seam.on || armOfNode(ctx, c) !== "inactive") &&
            declaredNames(c).some((nm) => normalizeAlName(nm) === name)
          )
            hits.push({
              decl: c,
              certain: !underIf || (hasMap && armOfNode(ctx, c) === "active"),
            });
        } else if (c.rawKind === "var_section" || c.rawKind === "var_body") {
          walk(c, underIf);
        } else if (
          r737Seam.on &&
          c.rawKind.startsWith("preproc_") &&
          !isProcedureLike(c) &&
          armOfNode(ctx, c) !== "inactive"
        ) {
          walk(c, true);
        }
      }
    };
    walk(holder, false);
    return hits;
  };
  const scope = codeScope(recv);
  const body = objectOf(recv)?.childForFieldName("body") ?? null;
  const local = scope === null ? [] : find(scope);
  const globals = body === null ? [] : find(body);
  let picked: { decl: ALSyntaxNode; certain: boolean }[];
  if (!r737Seam.on) {
    const [first] = local.length > 0 ? local : globals;
    picked = first === undefined ? [] : [first];
  } else if (local.some((h) => h.certain)) {
    picked = local.filter((h) => h.certain);
  } else {
    const certainGlobals = globals.filter((h) => h.certain);
    picked = [...local, ...(certainGlobals.length > 0 ? certainGlobals : globals)];
  }
  const seen = new Set<string>();
  const out: DeclaredType[] = [];
  for (const h of picked) {
    const t = typeOfDecl(h.decl);
    if (t === null) continue;
    const key = `${t.kind}|${t.name}|${t.temporary}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

function typeOfDecl(decl: ALSyntaxNode): DeclaredType | null {
  const typeNode = decl.childForFieldName("type");
  if (typeNode === null) return null;
  for (const c of typeNode.namedChildren) {
    const ref = normalizeAlName(lastFieldChild(c, "reference")?.text ?? "");
    if (c.rawKind === "record_type") {
      return {
        kind: "table",
        name: ref,
        temporary: c.namedChildren.some((x) => x.rawKind === "temporary_keyword"),
      };
    }
    if (c.rawKind === "object_reference_type") {
      return {
        kind: normalizeAlName(c.childForFieldName("object_type")?.text ?? ""),
        name: ref,
        temporary: false,
      };
    }
  }
  return null;
}

/** Every object declaration of the project, per context (`ctx.files` required). */
const projectObjectsMemo = new WeakMap<object, ALSyntaxNode[]>();
function projectObjects(ctx: SemanticContext): ALSyntaxNode[] {
  const hit = projectObjectsMemo.get(ctx);
  if (hit !== undefined) return hit;
  const files = ctx.files;
  if (files === undefined) {
    throw new Error(
      "R500: the open-item hang refusal needs a SemanticContext with `files` (buildSemanticContext sets it)",
    );
  }
  const objs = files.flatMap((f) => objectDeclarationsOf(f.root));
  projectObjectsMemo.set(ctx, objs);
  return objs;
}

/** R737 (build review MUST 1): is `n`'s receiver typed two or more ways with ANY type naming no
 *  project object (a dependency codeunit)? Its target union is then PARTIAL: follow readers use it
 *  (they follow what exists), but a reader that takes an empty list as "unresolved, strict" must not
 *  see a partial list as complete (`r570Targets(..., true)`). */
function r737Partial(n: ALSyntaxNode, ctx: SemanticContext): boolean {
  const fn = n.rawKind === "call_expression" ? n.childForFieldName("function") : n;
  const recv = fn?.rawKind === "member_expression" ? fn.childForFieldName("object") : null;
  if (recv === null || recv === undefined || !isIdentifierLike(recv)) return false;
  const ts = declaredTypes(recv, ctx);
  return ts.length > 1 && ts.some((t) => objectsOfType(t, ctx).length === 0);
}

/** The project objects a declared type names: a codeunit; a table plus its tableextensions; or every
 *  codeunit that implements an interface. Names compared normalized, in full. Kind `report` stays
 *  `[]` on purpose: `callTargets` feeds R500 shape 2's callee follow, and widening it to reports is a
 *  separate decision from R555, whose report lookup is local (`crossWriters`). Exported for the
 *  test that pins that (internal). */
export function objectsOfType(t: DeclaredType, ctx: SemanticContext): readonly ALSyntaxNode[] {
  if (t.kind === "codeunit") return objectNameIndex(ctx).get(`codeunit:${t.name}`) ?? [];
  if (t.kind === "table") return objectNameIndex(ctx).get(`table:${t.name}`) ?? [];
  const objects = projectObjects(ctx);
  if (t.kind === "interface") {
    return objects.filter(
      (o) =>
        o.rawKind === "codeunit_declaration" &&
        o.namedChildren.some(
          (c) =>
            c.rawKind === "implements_clause" &&
            c.namedChildren.some(
              (i) => i.fieldName === "interface" && normalizeAlName(i.text) === t.name,
            ),
        ),
    );
  }
  return [];
}

/** `codeunit:<name>` and `table:<name>` (a table and its tableextensions, in project order) to the
 *  objects, per context: one pass over `projectObjects`, where each lookup used to filter it. */
const objectNameIndexMemo = new WeakMap<object, Map<string, ALSyntaxNode[]>>();
function objectNameIndex(ctx: SemanticContext): Map<string, ALSyntaxNode[]> {
  const hit = objectNameIndexMemo.get(ctx);
  if (hit !== undefined) return hit;
  const index = new Map<string, ALSyntaxNode[]>();
  for (const o of projectObjects(ctx)) {
    let key: string;
    if (o.rawKind === "codeunit_declaration") key = `codeunit:${objectNameOf(o)}`;
    else if (o.rawKind === "table_declaration") key = `table:${objectNameOf(o)}`;
    else if (o.rawKind === "tableextension_declaration")
      key = `table:${normalizeAlName(lastFieldChild(o, "base_object")?.text ?? "")}`;
    else continue;
    const list = index.get(key);
    if (list === undefined) index.set(key, [o]);
    else list.push(o);
  }
  objectNameIndexMemo.set(ctx, index);
  return index;
}

/** Every procedure name an object declares (all arm names). */
function procedureNamesOf(o: ALSyntaxNode, ctx: SemanticContext): Set<string> {
  return cached(ctx, o, "procnames", () => {
    const names = new Set<string>();
    visitAll(o, (n) => {
      if (isProcedureLike(n) || n.rawKind === "procedure")
        for (const k of procNames(n)) names.add(k);
    });
    return names;
  });
}

/**
 * The project objects and procedure name a call names in ANOTHER object: a member call through a
 * typed receiver (`declaredType`), else through a record the engine can bind (`resolveReceiverTable`:
 * a data item's name, `Rec`); or an unqualified call in a report or reportextension that names no
 * procedure of its own object, on the enclosing data item's implicit record.
 */
function callTargets(
  c: ALSyntaxNode,
  ctx: SemanticContext,
): {
  readonly objs: readonly ALSyntaxNode[];
  readonly member: string;
  readonly kind: string;
} | null {
  const f = c.childForFieldName("function");
  if (f === null) return null;
  const onTable = (table: string | null, member: string) =>
    table === null
      ? null
      : {
          objs: objectsOfType(
            { kind: "table", name: normalizeAlName(table), temporary: false },
            ctx,
          ),
          member,
          kind: "record",
        };
  if (f.rawKind === "member_expression") {
    const recv = f.childForFieldName("object");
    const member = normalizeAlName(f.childForFieldName("member")?.text ?? "");
    if (recv === null || !isIdentifierLike(recv)) return null;
    // R547: `this.P()` in a reportextension binds a base-report procedure, protected ones too
    // (alc 18.0.43, runtime 16; BaseApp's MfgGetOutboundSourceDocs calls `this.GetLocation`). The
    // extension's own `P` is `bareCallee`'s same-object shape, not followed here.
    const obj = objectOf(c);
    if (
      normalizeAlName(recv.text) === "this" &&
      obj?.rawKind === "reportextension_declaration" &&
      !procedureNamesOf(obj, ctx).has(member)
    ) {
      const bases = baseProceduresOwners(obj, member, ctx);
      return bases.length === 0 ? null : { objs: bases, member, kind: "report" };
    }
    // R737: an ambiguous receiver follows every type's objects; kind "ambiguous" when they differ
    const ts = declaredTypes(recv, ctx);
    const [t0] = ts;
    if (t0 !== undefined) {
      const kinds = new Set(ts.map((t) => (t.kind === "table" ? "record" : t.kind)));
      const [k0] = kinds;
      return {
        objs: ts.flatMap((t) => objectsOfType(t, ctx)),
        member,
        kind: kinds.size === 1 && k0 !== undefined ? k0 : "ambiguous",
      };
    }
    return onTable(resolveReceiverTable(c, ctx), member);
  }
  if (!isIdentifierLike(f)) return null;
  const obj = objectOf(c);
  const member = normalizeAlName(f.text);
  if (obj === null || procedureNamesOf(obj, ctx).has(member)) return null;
  if (obj.rawKind !== "report_declaration" && obj.rawKind !== "reportextension_declaration")
    return null;
  const tbl = onTable(resolveReceiverTable(c, ctx), member);
  if (obj.rawKind === "report_declaration") return tbl;
  // R547: a bare name in a reportextension also binds a procedure of the BASE report; every
  // candidate declaring it is followed, beside the data item's table. (`CurrReport.P()` there does
  // not compile, AL0161 for a public and a protected `P` alike, alc 18.0.43, so `CurrReport` needs
  // no mapping; `this.P()` does, above.)
  const bases = baseProceduresOwners(obj, member, ctx);
  if (bases.length === 0) return tbl;
  return { objs: [...(tbl?.objs ?? []), ...bases], member, kind: tbl?.kind ?? "report" };
}

/** R547: the base-report candidates of `ext` that declare procedure `member` (an unparsed one by
 *  its tokens). */
function baseProceduresOwners(
  ext: ALSyntaxNode,
  member: string,
  ctx: SemanticContext,
): ALSyntaxNode[] {
  const { objs, unread } = baseCandidatesOf(ext, ctx);
  return [
    ...objs.filter((o) => procedureNamesOf(o, ctx).has(member)),
    ...unread.filter((o) => identifierTokens(o.text).has(member)),
  ];
}

/**
 * R-547: every project object a reportextension's base name may denote. `objs`: each
 * `report_declaration` of that name (in a `#if` wrapper too, every arm: `projectObjects`), and
 * each split-header object (`symbols.splitObjects`, whose body parses like any object's) whose
 * text names a report and the base by the conservative token rule `projectDeclaresProcedureOnTable`
 * uses. `unread`: an unparsed object passing the same rule; its structure cannot be read. Both
 * empty: the base is a dependency. Over-matching only adds refusals.
 */
function baseCandidatesOf(
  ext: ALSyntaxNode,
  ctx: SemanticContext,
): { readonly objs: ALSyntaxNode[]; readonly unread: ALSyntaxNode[] } {
  return cached(ctx, ext, "bases", () => {
    const base = extendedBaseName(ext);
    const names = (o: ALSyntaxNode): boolean => {
      const t = identifierTokens(o.text);
      return t.has("report") && (base === null || t.has(base));
    };
    return {
      objs: [
        ...projectObjects(ctx).filter(
          (o) => o.rawKind === "report_declaration" && (base === null || objectNameOf(o) === base),
        ),
        ...ctx.symbols.splitObjects.filter(names),
      ],
      unread: ctx.symbols.unparsedObjects.filter(names),
    };
  });
}

/** The names a report declares in a `protected var` section (accessible from its extensions). */
function protectedVarNames(report: ALSyntaxNode): Set<string> {
  const out = new Set<string>();
  for (const c of report.childForFieldName("body")?.namedChildren ?? []) {
    if (
      c.rawKind !== "var_section" ||
      !c.namedChildren.some((k) => k.rawKind === "protected_keyword")
    )
      continue;
    visitAll(c, (v) => {
      if (v.rawKind === "variable_declaration")
        for (const nm of declaredNames(v)) out.add(normalizeAlName(nm));
    });
  }
  return out;
}

/** The attribute names written directly before a procedure (`EventSubscriber`, `IntegrationEvent`). */
function attributeNamesOf(p: ALSyntaxNode): string[] {
  return attributesOf(p).map((a) =>
    normalizeAlName(a.childForFieldName("attribute")?.childForFieldName("name")?.text ?? ""),
  );
}

/**
 * An `[EventSubscriber(ObjectType::K, K::"Name", Event, ...)]` read from the attribute's argument
 * NODES. The object: a `database_reference`'s last `table_name` segment; a namespace-qualified
 * reference (`Codeunit::Microsoft.Sales."Sales-Post"`, a `member_expression`) by its last `member`;
 * an integer object id (`ObjectType::Codeunit, 80`) through the project object of that kind and
 * `object_id` (none: not followed). The event: a quoted string or a bare identifier. Key
 * "<kind>|<object name>|<event>", normalized; `"*"` when a pragma sits among the arguments (R567:
 * the subscriber is then reached by EVERY event a refused scope raises, an over-reach).
 */
function subscriberKey(a: ALSyntaxNode, objects: readonly ALSyntaxNode[]): string | null {
  const content = a.childForFieldName("attribute");
  if (normalizeAlName(content?.childForFieldName("name")?.text ?? "") !== "eventsubscriber")
    return null;
  // the list node, not the wrapper's first child: a comment before the first argument is a wrapper
  // child BEFORE the list (measured), as trigger-skip's `subscribesToTable` reads it
  const list = content
    ?.childForFieldName("arguments")
    ?.namedChildren.find((c) => c.rawKind === "attribute_argument_list");
  if (list === undefined) return null;
  // R567: comments are not arguments; a pragma among them hides the event, so any event (`*`)
  if (!argumentsReadable(list)) return "*";
  const [kindArg, ref, event] = argumentList(list);
  if (kindArg === undefined || ref === undefined || event === undefined) return null;
  const k = normalizeAlName(kindArg.childForFieldName("value")?.text ?? "");
  const kind = k === "database" ? "table" : k;
  let obj: string;
  if (ref.rawKind === "integer") {
    const byId = objects.find(
      (o) =>
        o.rawKind === `${kind}_declaration` && o.childForFieldName("object_id")?.text === ref.text,
    );
    if (byId === undefined) return null;
    obj = objectNameOf(byId);
  } else if (ref.rawKind === "member_expression") {
    obj = normalizeAlName(ref.childForFieldName("member")?.text ?? "");
  } else {
    obj = normalizeAlName(lastFieldChild(ref, "table_name")?.text ?? "");
  }
  const ev =
    event.rawKind === "string_literal"
      ? normalizeAlName(event.text.replace(/^'|'$/g, ""))
      : normalizeAlName(event.text);
  return `${kind}|${obj}|${ev}`;
}

const GUARDED: ReadonlyMap<string, string> = new Map([
  ["if_statement", "condition"],
  ["while_statement", "condition"],
  ["repeat_statement", "condition"],
  ["case_statement", "expression"],
]);

/** Does guard statement `g` hold a Break/Quit or a raised `Error` outside its own condition? */
function guardHoldsExit(g: ALSyntaxNode, scope: ALSyntaxNode): boolean {
  let found = false;
  const cond = g.childForFieldName(GUARDED.get(g.rawKind) ?? "");
  visitAll(g, (n) => {
    if (cond !== null && n.startIndex >= cond.startIndex && n.endIndex <= cond.endIndex) return;
    if (n.rawKind === "member_expression" && isReportExit(n)) found = true;
    if (isRaisedError(n, scope)) found = true;
  });
  return found;
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
  // a pragma among the arguments (R567) reads as no integer: not a literal bound
  const rest = argumentList(n).slice(1);
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
    if (isExit(n))
      for (let a = n.parent; a !== null && !samePos(a, loop); a = a.parent)
        for (const g of guardPartsOf(a)) add(g);
    for (const c of n.namedChildren) visitN(c);
  };
  visitN(body);
  return [...out.values()];
}

/** The parts of statement `a` that decide whether a statement inside it runs: an `if`/`while`/
 *  `until` condition, a `case` expression or branch pattern, `for` bounds, a `foreach` iterable,
 *  and the `#if` tails the grammar puts beside them. */
function guardPartsOf(a: ALSyntaxNode): ALSyntaxNode[] {
  const out: (ALSyntaxNode | null)[] = [];
  switch (a.rawKind) {
    case "if_statement":
    case "while_statement":
    case "repeat_statement":
      out.push(a.childForFieldName("condition"));
      break;
    case "case_statement":
      out.push(a.childForFieldName("expression"));
      break;
    case "case_branch":
      out.push(a.childForFieldName("pattern"));
      break;
    case "for_statement":
      out.push(a.childForFieldName("start"), a.childForFieldName("end"));
      break;
    case "foreach_statement":
      out.push(a.childForFieldName("iterable"));
      break;
  }
  for (const t of a.namedChildren)
    if (t.rawKind === "preproc_conditional_expression_tail") out.push(t);
  return out.filter((x): x is ALSyntaxNode => x !== null);
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
 * R340 (plan r2, review C1): a write to a name the enclosing TRIGGER declares in its own header
 * (a parameter, its named return, or any header local) that the hang path cannot resolve as a
 * declaration (`triggerScopeVar` reads only the plain `var` section), matched by NAME against the
 * enclosing loops' exit conditions and any enclosing `for`'s control variable, as R-364 does for an
 * unindexed object. Only ever adds a refusal. Before R340 this was already a hole for
 * remove-assignment (master emitted it hang-capable); R340's typing made swap-additive reach it too.
 */
function triggerHeaderLoopWrite(node: ALSyntaxNode, name: string, ctx: SemanticContext): boolean {
  const trigger = enclosingTrigger(node);
  if (trigger === null || !triggerLocalNames(trigger).has(normalizeAlName(name))) return false;
  return loopReadsNameAt(node, name, ctx);
}

/**
 * R340 (plan r2 review, Important-1): does a loop enclosing `node` (within its scope) read the plain
 * name `name`, by NAME: an enclosing `for`'s control variable, or any enclosing loop's exit parts
 * (`loopConditionReadsByName`)? Used where no declaration is resolved: a trigger header name above,
 * and `swap-call-arguments`, whose swap can redirect a `var` write away from the loop's variable
 * (`while Steps > 0 do Dec(Steps, One)` -> `Dec(One, Steps)`), which compiles and never ends.
 */
export function loopReadsNameAt(node: ALSyntaxNode, name: string, ctx: SemanticContext): boolean {
  const wanted = normalizeAlName(name);
  for (
    let cur: ALSyntaxNode | null = node.parent;
    cur !== null && !isScope(cur);
    cur = cur.parent
  ) {
    if (cur.rawKind !== "for_statement") continue;
    const variable = cur.childForFieldName("variable");
    if (variable !== null && normalizeAlName(variable.text) === wanted) return true;
  }
  return loopConditionReadsByName(node, { receiver: null, member: name }, ctx);
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
 * costs a site, a missed one can hang a session. R720: the same by-name match applies when the
 * engine's three-state lookup (`declarationStateAt`) says "unknown" rather than provably absent (a
 * swallowed `#if` member, a global declared inside `#if`, an every-arm-ambiguous name), for a plain
 * target and for a member target's receiver. R-458: when the declaration path says no, the
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
      // R340 (plan r2 review, Minor-1): a field of a trigger HEADER receiver (a parameter or named
      // return, which the hang path does not resolve) is matched by name too.
      const trigger = enclosingTrigger(node);
      const headerReceiver =
        trigger !== null && triggerLocalNames(trigger).has(normalizeAlName(parts.receiver.text));
      // R720: a receiver the engine refuses to resolve ("unknown") is matched by name too. The
      // cheap loop-name test runs first: `declarationStateAt` scans the whole object.
      return loopConditionReadsByName(node, byName, ctx) &&
        (inUnindexedObject(node, ctx) ||
          headerReceiver ||
          declarationStateAt(parts.receiver, ctx) === "unknown")
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
    // R720: "unknown" (not provably absent) is matched by name too, including an enclosing `for`'s
    // control variable (R480, `loopReadsNameAt`). The cheap loop-name test runs first:
    // `declarationStateAt` scans the whole object.
    return (loopReadsNameAt(node, target.text, ctx) &&
      (inUnindexedObject(node, ctx) || declarationStateAt(target, ctx) === "unknown")) ||
      triggerHeaderLoopWrite(node, target.text, ctx)
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
  // R500: an XMLport element is open-item code only for the DISPATCH check, which the orchestrator
  // skips in a file that cannot carry the selector var; here it would move those sites out of the
  // `skipped` row, so this in-operator path keeps R487's report-only scope.
  if (inOpenItemCode(node, ctx) && objectOf(node)?.rawKind !== "xmlport_declaration") {
    return "loop-condition-target";
  }
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

// ---------------------------------------------------------------------------------------------
// R532 census (measurement only; `scripts/r532-preset-feed-census.ts`). Refuses nothing.
// ---------------------------------------------------------------------------------------------

/** One census row per preset write outside open-item code. Names and positions only. */
export interface R532CensusRow {
  readonly file: string;
  readonly object: string;
  readonly scope: string;
  readonly name: string;
  readonly kind: "assign" | "var-arg";
  /** classes (see the script's header): A-*, A', A?-*, B, B-obj-preset, B-obj-other, P, F, L-unwritten, G-unwritten, C */
  readonly tags: string[];
  readonly callees: string[];
  readonly feeds: number;
  readonly feedA: number;
  readonly line: number | undefined;
}

/** Procedures named `name` in `o` (any arity when `arity` < 0). */
function r532Procs(o: ALSyntaxNode, name: string, arity: number): ALSyntaxNode[] {
  const out: ALSyntaxNode[] = [];
  visitAll(o, (x) => {
    if (
      (isProcedureLike(x) || x.rawKind === "procedure") &&
      procNames(x).includes(name) &&
      (arity < 0 || r531Arity(x) === arity)
    )
      out.push(x);
  });
  return out;
}

/** The census class of a call (or a hidden paren-less call) and the project procedures it reaches. */
function r532CallClass(
  c: ALSyntaxNode,
  obj: ALSyntaxNode,
  ctx: SemanticContext,
): { cls: string; procs: ALSyntaxNode[] } | null {
  const known = procedureNamesOf(obj, ctx);
  const own = bareCallee(c) ?? hiddenCallee(c, known, ctx);
  const isCall = c.rawKind === "call_expression" || c.rawKind === "call_statement";
  const arity = isCall ? argumentList(c).length : 0;
  if (own !== null && known.has(own)) {
    const procs = r532Procs(obj, own, arity);
    return {
      cls: openReachable(obj, ctx).has(own) ? "A'open" : "A'",
      procs: procs.length > 0 ? procs : r532Procs(obj, own, -1),
    };
  }
  if (!isCall) return null;
  const f = c.childForFieldName("function");
  if (f === null) return { cls: "A?-unresolved", procs: [] };
  const viaTargets = (): { cls: string; procs: ALSyntaxNode[] } | null => {
    const t = callTargets(c, ctx);
    if (t === null) return null;
    const procs = t.objs.flatMap((o) => r532Procs(o, t.member, arity));
    if (procs.length > 0) return { cls: `A-${t.kind}`, procs };
    return {
      cls: t.objs.length === 0 ? `A?-notproject-${t.kind}` : `A?-builtin-${t.kind}`,
      procs: [],
    };
  };
  if (f.rawKind === "member_expression") {
    const recv = f.childForFieldName("object");
    const member = normalizeAlName(f.childForFieldName("member")?.text ?? "");
    const dt = recv !== null && isIdentifierLike(recv) ? declaredType(recv, ctx) : null;
    if (dt !== null && dt.kind === "report") {
      const procs = projectObjects(ctx)
        .filter(
          (o) =>
            (o.rawKind === "report_declaration" && objectNameOf(o) === dt.name) ||
            (o.rawKind === "reportextension_declaration" && extendedBaseName(o) === dt.name),
        )
        .flatMap((o) => r532Procs(o, member, arity));
      return { cls: procs.length > 0 ? "A-report" : "A?-report", procs };
    }
    return (
      viaTargets() ?? {
        cls: dt !== null ? `A?-notproject-${dt.kind}` : "A?-unresolved",
        procs: [],
      }
    );
  }
  const t = viaTargets();
  if (t !== null && t.procs.length > 0) return t;
  return { cls: normalizeAlName(f.text) === "clear" ? "C-clear" : "A?-system", procs: [] };
}

/** The calls inside `expr`, hidden paren-less same-object calls included. */
function r532CallsIn(expr: ALSyntaxNode, obj: ALSyntaxNode, ctx: SemanticContext) {
  const out: { node: ALSyntaxNode; cls: string; procs: ALSyntaxNode[] }[] = [];
  const known = procedureNamesOf(obj, ctx);
  visitAll(expr, (x) => {
    if (armOfNode(ctx, x) === "inactive") return;
    const isCall = x.rawKind === "call_expression" || x.rawKind === "call_statement";
    if (!isCall && hiddenCallee(x, known, ctx) === null) return;
    const r = r532CallClass(x, obj, ctx);
    if (r !== null) out.push({ node: x, ...r });
  });
  return out;
}

/**
 * R532's census: every preset write outside open-item code (an assignment to a preset exit name,
 * or a call passing one to a written argument), classified by where its value comes from. Uses
 * R-531's `r531Feeds` as measured (assignments only, targets as written), so the counts R532's
 * ruling cites reproduce; the built rule (`presetFeeds`) is wider.
 */
export function r532PresetFeedCensus(ctx: SemanticContext): R532CensusRow[] {
  const fileOf = new Map<string, string>();
  for (const f of ctx.files ?? [])
    for (const o of objectDeclarationsOf(f.root)) fileOf.set(objectKey(o), f.path);
  const scopeName = (s: ALSyntaxNode | null): string =>
    s === null
      ? "?"
      : isProcedureLike(s)
        ? `procedure ${procNames(s)[0] ?? "?"}`
        : s.rawKind === "trigger_declaration"
          ? `trigger ${triggerName(s)}`
          : s.rawKind;
  const rows: R532CensusRow[] = [];
  for (const o of projectObjects(ctx)) {
    let names: Set<string> = new Set();
    if (o.rawKind === "report_declaration") names = presetExitNames(o, ctx);
    else if (o.rawKind === "reportextension_declaration") names = extensionPresetExitNames(o, ctx);
    if (names.size === 0) continue;
    visitAll(o, (n) => {
      if (armOfNode(ctx, n) === "inactive" || inOpenItemCode(n, ctx)) return;
      let name: string;
      let rhs: ALSyntaxNode | null = null;
      if (n.rawKind === "assignment_statement") {
        const l = n.childForFieldName("left");
        if (l === null || !names.has(rootName(l))) return;
        name = rootName(l);
        rhs = n.childForFieldName("right");
      } else if (
        (n.rawKind === "call_expression" || n.rawKind === "call_statement") &&
        directWrite(n, names, ctx)
      ) {
        const a = argumentList(n).find(
          (x) => isIdentifierLike(x) && names.has(normalizeAlName(x.text)),
        );
        name = a === undefined ? "?" : normalizeAlName(a.text);
      } else return;
      const scope = codeScope(n);
      const tags = new Set<string>();
      const callees: string[] = [];
      const calls = r532CallsIn(rhs ?? n, o, ctx);
      for (const c of calls) {
        tags.add(rhs === null ? `V:${c.cls}` : c.cls);
        for (const p of c.procs) callees.push(`${objectKey(objectOf(p) ?? p)}.${procNames(p)[0]}`);
      }
      let feeds = 0;
      let feedA = 0;
      if (rhs !== null) {
        const callAt = new Set(calls.map((c) => c.node.startIndex));
        const fs = scope === null ? [] : r531Feeds(scope, [rhs], ctx).filter((a) => !samePos(a, n));
        feeds = fs.length;
        for (const f of fs) {
          const r = f.childForFieldName("right");
          if (r === null) continue;
          for (const c of r532CallsIn(r, o, ctx)) {
            tags.add(`B>${c.cls}`);
            if (c.cls.startsWith("A-")) feedA++;
          }
        }
        visitAll(rhs, (x) => {
          if (!isIdentifierLike(x) || x.fieldName === "member" || x.fieldName === "function")
            return;
          if (x.parent?.rawKind === "qualified_enum_value" || callAt.has(x.startIndex)) return;
          const nm = normalizeAlName(x.text);
          if (nm === "rec" || nm === "xrec" || nm === "currreport") {
            tags.add("F");
            return;
          }
          if (scope !== null && r531Feeds(scope, [x], ctx).some((a) => !samePos(a, n))) {
            tags.add("B");
            return;
          }
          const d = resolveVarRef(x, ctx);
          if (d === null) tags.add("F");
          else if (d.node.rawKind === "parameter") tags.add("P");
          else if (codeScope(d.node) !== null) tags.add("L-unwritten");
          else {
            let objWrite = false;
            visitAll(o, (a) => {
              if (objWrite || a.rawKind !== "assignment_statement") return;
              const l = a.childForFieldName("left");
              if (l !== null && rootName(l) === nm && !samePos(a, n)) objWrite = true;
            });
            // B-obj-preset: the global is itself a preset exit name, so shape 1 refuses its write
            tags.add(objWrite ? (names.has(nm) ? "B-obj-preset" : "B-obj-other") : "G-unwritten");
          }
        });
        if (tags.size === 0) tags.add("C");
      } else if (tags.size === 0) tags.add("V:none");
      rows.push({
        file: fileOf.get(objectKey(o)) ?? "?",
        object: objectKey(o),
        scope: scopeName(scope),
        name,
        kind: rhs === null ? "var-arg" : "assign",
        tags: [...tags].sort(),
        callees,
        feeds,
        feedA,
        line: n.startPosition?.row,
      });
    });
  }
  return rows;
}
