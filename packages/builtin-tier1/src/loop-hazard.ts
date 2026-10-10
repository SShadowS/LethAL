import {
  ALNodeKind,
  type ALSyntaxNode,
  type HangCapableReason,
  type ObjectSymbol,
  type SemanticContext,
  armOfNode,
  declarationMembers,
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
 * - two stated LIMITS, with their blind spots in their own comments: a write, before the item, of a
 *   global the item's exit reads (`writesPresetExitName`, shape 1), and the OnPreDataItem filter of
 *   an item that inserts into its own table (`altersSelfInsertFilter`, shape 3).
 * Two RULINGS: a reportextension outside the project cannot reach this project's open items (its
 * code is not in the run), and a `while`/`repeat` inside a BOUNDED item's code keeps
 * R196/R446/R480's loop rules only (shape 8; the loop that ends only by consuming its set is a
 * product-wide question, filed on its own).
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
    altersSelfInsertFilter(node, ctx) ||
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
  readonly args: ALSyntaxNode[];
}

/** A receiver's key: its normalized name (`Rec` is ""), or its whitespace-free text when it is not
 *  a plain name (`Buf[1]`). */
const r531Key = (n: ALSyntaxNode | null): string | null => {
  if (n === null) return null;
  if (!isIdentifierLike(n)) return `\u0001${n.text.replace(/\s+/g, "").toLowerCase()}`;
  const k = normalizeAlName(n.text);
  return k === "rec" ? "" : k;
};

function r531Call(n: ALSyntaxNode): R531Call | null {
  const argsOf = (c: ALSyntaxNode): ALSyntaxNode[] => [
    ...(c.namedChildren.find((x) => x.rawKind === "argument_list")?.namedChildren ?? []),
  ];
  if (n.rawKind === "call_expression") {
    const f = n.childForFieldName("function") ?? n.namedChildren[0] ?? null;
    if (f === null) return null;
    if (isIdentifierLike(f))
      return { recv: null, method: normalizeAlName(f.text), args: argsOf(n) };
    if (f.rawKind === "member_expression") {
      const m = f.childForFieldName("member");
      if (m === null) return null;
      const o = f.childForFieldName("object");
      return { recv: r531Key(o) ?? "\u0000", method: normalizeAlName(m.text), args: argsOf(n) };
    }
    return null;
  }
  if (n.rawKind === "call_statement") {
    const f = n.namedChildren[0] ?? null;
    if (f === null || !isIdentifierLike(f)) return null;
    return { recv: null, method: normalizeAlName(f.text), args: argsOf(n) };
  }
  if (n.rawKind === "member_expression" && n.parent?.rawKind !== "call_expression") {
    const m = n.childForFieldName("member");
    const o = r531Key(n.childForFieldName("object"));
    if (m === null || o === null) return null;
    return { recv: o, method: normalizeAlName(m.text), args: [] };
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
        const id =
          c.childForFieldName("name") ?? c.namedChildren.find((x) => isIdentifierLike(x)) ?? null;
        if (id !== null && normalizeAlName(id.text) === name) hit = true;
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
 *  `Record B` parameter, by value, `var` or `temporary` (alc probe, R-564). Narrowed per object. */
function r531ProcsIn(
  obj: ALSyntaxNode,
  name: string,
  arity: number,
  call: ALSyntaxNode,
  ctx: SemanticContext,
): ALSyntaxNode[] {
  const out: ALSyntaxNode[] = [];
  visitAll(obj, (x) => {
    if (
      (isProcedureLike(x) || x.rawKind === "procedure") &&
      procNames(x).includes(name) &&
      r531Arity(x) === arity
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
  arity: number,
  ctx: SemanticContext,
): ALSyntaxNode[] {
  if (n.rawKind !== "call_expression") return [];
  const fn = n.childForFieldName("function");
  const recv = fn?.rawKind === "member_expression" ? fn.childForFieldName("object") : null;
  let t = recv !== null && recv !== undefined ? declaredType(recv, ctx) : null;
  if (t === null) {
    const table = resolveReceiverTable(n, ctx);
    if (table !== null) t = { kind: "table", name: normalizeAlName(table), temporary: false };
  }
  if (t === null || t.kind !== "table") return [];
  return objectsOfType(t, ctx).flatMap((o) => r531ProcsIn(o, method, arity, n, ctx));
}

function r531Arity(proc: ALSyntaxNode): number {
  const list = proc.namedChildren.find((c) => c.rawKind === "parameter_list");
  return list?.namedChildren.filter((c) => c.rawKind === "parameter").length ?? 0;
}

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
  const arity = c.args.length;
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
      for (const [k, i] of passed) {
        const prm = r531Param(p, i);
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
    unresolved = !targets.some((t) => bodyOf(t.proc) !== null);
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
      const at = rt === "codeunit" ? 1 : 0;
      const id = c.args[0]?.text.replace(/^codeunit\s*::\s*/i, "") ?? "";
      const cus =
        rt === "codeunit"
          ? projectObjects(ctx).filter(
              (o) =>
                o.rawKind === "codeunit_declaration" &&
                (objectNameOf(o) === normalizeAlName(id) ||
                  o.childForFieldName("object_id")?.text === id),
            )
          : t !== null
            ? objectsOfType(t, ctx)
            : [];
      for (const o of cus) {
        if (!hasProperty(o, "TableNo", ctx)) continue;
        visitAll(o, (x) => {
          if (x.rawKind === "trigger_declaration" && triggerName(x) === "onrun")
            for (const [k, i] of passed) if (i === at) targets.push({ proc: x, key: "", r: k });
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
        const f = cc.args[0];
        if (d !== undefined && f !== undefined && (d.has("*") || d.has(normalizeAlName(f.text))))
          filters.push(m);
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
  return { hops, refuse: unresolved || hops.length > 0 };
}

/** FEEDS: assignments in `scope` whose target name `parts` read, to a fixpoint (R480
 *  `indirectFeeds`'s by-name rule, over the whole scope instead of one loop body). R532 passes
 *  `fed`, which receives every name read on the way, and also matches a target's ROOT name
 *  (`Arr[1] := X` feeds `Arr`, `R.X := Y` feeds `R` as well as `X`) and follows the `#if`
 *  expression tails `indirectFeeds` follows. R-531 passes nothing and is unchanged. */
function r531Feeds(
  scope: ALSyntaxNode,
  parts: ALSyntaxNode[],
  ctx: SemanticContext,
  fed?: Set<string>,
): ALSyntaxNode[] {
  const names = fed ?? new Set<string>();
  const collect = (n: ALSyntaxNode): void => {
    if (DIRECTIVE_MARKERS.has(n.rawKind) || armOfNode(ctx, n) === "inactive") return;
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
  let next = false;
  for (const p of loopConditionParts(loop)) {
    r531Walk(p, ctx, (n) => {
      let c = r531Call(n);
      if (c === null && isIdentifierLike(n) && n.parent?.rawKind !== "member_expression") {
        c = { recv: null, method: normalizeAlName(n.text), args: [] };
      }
      if (c === null) return;
      if (c.recv === null && !r531Implicit(n, ctx)) return;
      if (R531_COND.has(c.method)) recvs.add(c.recv ?? "");
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
  if (scope !== null) {
    for (let changed = true; changed; ) {
      changed = false;
      r531Walk(scope, ctx, (n) => {
        let pair: [string | null, string | null] | null = null;
        if (n.kind === ALNodeKind.assignment_statement) {
          const l = n.childForFieldName("left");
          const rt = n.childForFieldName("right");
          if (l !== null && rt !== null && isIdentifierLike(l) && isIdentifierLike(rt))
            pair = [r531Key(l), r531Key(rt)];
        } else {
          const c = r531Call(n);
          const a0 = c?.args[0];
          const a1 = c?.args[1];
          // `Copy(X, true)` shares the table; a non-literal second argument may be true too. A
          // bare `Copy` is the implicit Rec's (unless the object declares a procedure `Copy`).
          if (
            c !== null &&
            c.method === "copy" &&
            a0 !== undefined &&
            a1 !== undefined &&
            normalizeAlName(a1.text) !== "false"
          )
            pair = [
              c.recv ?? (r531Implicit(n, ctx) && !procs.has("copy") ? "" : null),
              r531Key(a0),
            ];
        }
        if (pair === null) return;
        const [x, y] = pair;
        if (x === null || y === null) return;
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
      const f = c.args[0];
      if (f === undefined) return;
      const s = filtered.get(r) ?? new Set<string>();
      s.add(normalizeAlName(f.text));
      filtered.set(r, s);
      filterCalls.push({ n, r, field: normalizeAlName(f.text) });
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
          all: c.method === "modifyall" ? normalizeAlName(c.args[0]?.text ?? "") : null,
        });
      } else if (R531_FILTER.has(c.method)) {
        consume(n, "refilter", r);
      } else if (R531_MARKS.has(c.method)) {
        consume(n, "mark", r);
        if (c.method === "mark") markRecvs.add(r);
      } else if (c.method === "insert") {
        inserts.add(r);
      } else if (c.method === "validate") {
        const f = c.args[0];
        if (f !== undefined) writes.push({ n, r, field: normalizeAlName(f.text) });
      } else if (
        !R531_BUILTIN.has(c.method) &&
        n.rawKind === "call_expression" &&
        // a bare name: only a table procedure the implicit Rec's table declares in the project
        (!bare || r531TableProcs(n, c.method, c.args.length, ctx).length > 0)
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
    const ws = writes.filter((w) => w.r === r && (f === undefined || f.has(w.field)));
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
      const hit = ws.filter((w) => f.has(w.field));
      const all = m.all !== null && f.has(m.all) ? m.all : null;
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
      return d !== undefined && (d.has("*") || d.has(c.field));
    }),
    ...markedOnly.filter((c) => markRecvs.has(c.r)),
  ]
    .filter((c) => c.n.endIndex <= loop.startIndex)
    .map((c) => c.n);
  const hops: R531Hop[] = [];
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
    const arity = h.c.args.length;
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
          const prm = r531Param(p, i);
          // a by-value parameter copies the VARIABLE, not the table (see r531CalleeHop)
          if (prm !== null) targets.push({ proc: p, key: prm[0], byValue: !prm[1] });
        });
      }
    }
    for (const t of targets) {
      const hop = r531CalleeHop(t.proc, t.key, ctx, t.byValue);
      if (hop !== null) hops.push(hop);
    }
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
 * included) is a FEED (R532, `presetFeeds`), refused like a write.
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
 * argument of a BARE call that is itself a preset write (`Evaluate(Continue, S)`) or of a call to a
 * same-object preset writer (`SetContinue(Tmp)`). Never from `Obj.Proc(Continue, H)`: a value that
 * reaches the name through another object's function is the cross-object part R532 closed by ruling
 * (seeding there cost 109 BaseApp mutants). Shape 1 treats a feed as a write.
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
  return cached(ctx, scope, "r532feeds", () => {
    const rights: ALSyntaxNode[] = [];
    visitAll(scope, (n) => {
      if (armOfNode(ctx, n) === "inactive") return;
      if (n.rawKind === "call_expression" || n.rawKind === "call_statement") {
        if (
          (bareCallee(n) !== null && directWrite(n, names, ctx)) ||
          callsPresetWriter(n, w, ctx, names.size > 0)
        )
          rights.push(...(n.childForFieldName("arguments")?.namedChildren ?? []));
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
  });
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
    const args = n.childForFieldName("arguments")?.namedChildren ?? [];
    return args.some(
      (a, i) =>
        isIdentifierLike(a) && names.has(normalizeAlName(a.text)) && argWritten(n, i, ctx, true),
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
  for (const o of projectObjects(ctx)) {
    if (o.rawKind === "report_declaration")
      add(objectNameOf(o), presetWriters(o, presetExitNames(o, ctx), ctx).procs);
    else if (o.rawKind === "reportextension_declaration")
      add(extendedBaseName(o), presetWriters(o, extensionPresetExitNames(o, ctx), ctx).procs);
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

/** An exit that can stop the rest of `scope`: `exit`, `CurrReport.Break/Quit/Skip` (and the XMLport
 *  twins), an `Error` outside `asserterror`, or a guard statement whose branches hold one. */
function isEarlyExit(n: ALSyntaxNode, scope: ALSyntaxNode): boolean {
  const exits = (x: ALSyntaxNode): boolean =>
    x.rawKind === "exit_statement" ||
    isRaisedError(x, scope) ||
    (x.rawKind === "member_expression" &&
      REPORT_INSTANCES.has(normalizeAlName(x.childForFieldName("object")?.text ?? "")) &&
      EARLY_EXITS.has(normalizeAlName(x.childForFieldName("member")?.text ?? "")));
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
          globals.add(normalizeAlName(v.childForFieldName("name")?.text ?? ""));
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
        for (const a of (g.childForFieldName("arguments")?.namedChildren ?? []).slice(1))
          readAll(a);
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
        // an argument is a write only for a var parameter or a writing built-in (unknown: no, which
        // keeps the name preset: the safe direction on this side)
        (n.childForFieldName("arguments")?.namedChildren ?? []).forEach((a, i) => {
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
      if (isLoopItem(n) && itemOpen(n, ctx))
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
 * name), in the item's triggers or a same-object procedure they reach. Not seen: an insert made
 * in another object, a bound set elsewhere (a callee, OnPreReport), and the item's other mutants (a
 * guard before the insert, a key value).
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

function selfInserts(item: ALSyntaxNode, ctx: SemanticContext): boolean {
  return cached(ctx, item, "selfins", () => {
    const table = itemTable(item);
    const obj = objectOf(item);
    const body = item.childForFieldName("body");
    if (obj === null || body === null) return false;
    const triggers = itemMembers(body, ctx).filter((m) => m.kind === ALNodeKind.trigger);
    // the item's triggers, then same-object procedures they reach, transitively
    const scopes: ALSyntaxNode[] = [...triggers];
    const seen = new Set<string>();
    for (let i = 0; i < scopes.length; i++) {
      const sc = scopes[i];
      if (sc === undefined) continue;
      visitAll(sc, (c) => {
        const callee = bareCallee(c);
        if (callee === null || seen.has(callee)) return;
        seen.add(callee);
        visitAll(obj, (p) => {
          if ((isProcedureLike(p) || p.rawKind === "procedure") && procNames(p).includes(callee))
            scopes.push(p);
        });
      });
    }
    return scopes.some((sc, i) => {
      let found = false;
      visitAll(sc, (c) => {
        if (found || (c.rawKind !== "call_expression" && c.rawKind !== "call_statement")) return;
        const f = c.childForFieldName("function");
        if (f === null) return;
        if (i < triggers.length && isIdentifierLike(f) && normalizeAlName(f.text) === "insert")
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
      });
      return found;
    });
  });
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
 * into a third object are not followed. Not seen: a receiver this cannot type (a RecordRef, a
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
    let pubObjs: ALSyntaxNode[];
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

/** The attribute items written directly before a procedure. */
function attributesOf(p: ALSyntaxNode): ALSyntaxNode[] {
  const par = p.parent;
  if (par === null) return [];
  const sibs = par.namedChildren;
  const i = sibs.findIndex((s) => samePos(s, p));
  const out: ALSyntaxNode[] = [];
  for (let j = i - 1; j >= 0; j--) {
    const s = sibs[j];
    if (s === undefined || s.rawKind !== "attribute_item") break;
    out.push(s);
  }
  return out;
}

export interface DeclaredType {
  /** `table` for a Record, else the object keyword: `codeunit`, `interface`, `report`, ... */
  readonly kind: string;
  /** The full object name, normalized (`normalizeAlName`): `"Cust. Ledger Entry"` stays one name. */
  readonly name: string;
  readonly temporary: boolean;
}

/** An object's own name, normalized the same way as `DeclaredType.name`. */
const objectNameOf = (o: ALSyntaxNode): string =>
  normalizeAlName(lastFieldChild(o, "object_name")?.text ?? "");

/**
 * The declared type of a receiver, read from the declaration's type NODE (`record_type` or
 * `object_reference_type`, its last `reference` segment through `lastFieldChild`, as the engine's
 * `classifyDeclaredType` does), never by splitting text: a quoted name with dots is one name. The
 * declaration is the symbol table's (`resolveVarRef`), else (an XMLport, which the symbol table does
 * not index) the nearest `var` declaration of that name in the enclosing trigger/procedure, then in
 * the object. Null when not found: the call is not followed.
 */
function declaredType(recv: ALSyntaxNode, ctx: SemanticContext): DeclaredType | null {
  let decl: ALSyntaxNode | null = resolveVarRef(recv, ctx)?.node ?? null;
  if (decl === null) {
    const name = normalizeAlName(recv.text);
    const find = (holder: ALSyntaxNode): ALSyntaxNode | null => {
      let t: ALSyntaxNode | null = null;
      const walk = (n: ALSyntaxNode): void => {
        for (const c of n.namedChildren) {
          if (t !== null) return;
          if (c.rawKind === "variable_declaration") {
            if (normalizeAlName(c.childForFieldName("name")?.text ?? "") === name) t = c;
          } else if (c.rawKind === "var_section" || c.rawKind === "var_body") {
            walk(c);
          }
        }
      };
      walk(holder);
      return t;
    };
    const scope = codeScope(recv);
    decl = scope === null ? null : find(scope);
    const body = objectOf(recv)?.childForFieldName("body") ?? null;
    if (decl === null && body !== null) decl = find(body);
  }
  const typeNode = decl?.childForFieldName("type") ?? null;
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

/** The project objects a declared type names: a codeunit; a table plus its tableextensions; or every
 *  codeunit that implements an interface. Names compared normalized, in full. Kind `report` stays
 *  `[]` on purpose: `callTargets` feeds R500 shape 2's callee follow, and widening it to reports is a
 *  separate decision from R555, whose report lookup is local (`crossWriters`). Exported for the
 *  test that pins that (internal). */
export function objectsOfType(t: DeclaredType, ctx: SemanticContext): ALSyntaxNode[] {
  const objects = projectObjects(ctx);
  if (t.kind === "codeunit") {
    return objects.filter(
      (o) => o.rawKind === "codeunit_declaration" && objectNameOf(o) === t.name,
    );
  }
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
  if (t.kind === "table") {
    return objects.filter(
      (o) =>
        (o.rawKind === "table_declaration" && objectNameOf(o) === t.name) ||
        (o.rawKind === "tableextension_declaration" &&
          normalizeAlName(lastFieldChild(o, "base_object")?.text ?? "") === t.name),
    );
  }
  return [];
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
): { readonly objs: ALSyntaxNode[]; readonly member: string; readonly kind: string } | null {
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
    const t = declaredType(recv, ctx);
    if (t !== null) {
      return { objs: objectsOfType(t, ctx), member, kind: t.kind === "table" ? "record" : t.kind };
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
        out.add(normalizeAlName(v.childForFieldName("name")?.text ?? ""));
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
 * "<kind>|<object name>|<event>", normalized.
 */
function subscriberKey(a: ALSyntaxNode, objects: readonly ALSyntaxNode[]): string | null {
  const content = a.childForFieldName("attribute");
  if (normalizeAlName(content?.childForFieldName("name")?.text ?? "") !== "eventsubscriber")
    return null;
  const list = content?.childForFieldName("arguments")?.namedChildren[0];
  const [kindArg, ref, event] = list?.namedChildren ?? [];
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
      // R340 (plan r2 review, Minor-1): a field of a trigger HEADER receiver (a parameter or named
      // return, which the hang path does not resolve) is matched by name too.
      const trigger = enclosingTrigger(node);
      const headerReceiver =
        trigger !== null && triggerLocalNames(trigger).has(normalizeAlName(parts.receiver.text));
      return (inUnindexedObject(node, ctx) || headerReceiver) &&
        loopConditionReadsByName(node, byName, ctx)
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
    return (inUnindexedObject(node, ctx) && loopConditionReadsByName(node, byName, ctx)) ||
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
  const arity = isCall ? (c.childForFieldName("arguments")?.namedChildren.length ?? 0) : 0;
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
        const a = (n.childForFieldName("arguments")?.namedChildren ?? []).find(
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
