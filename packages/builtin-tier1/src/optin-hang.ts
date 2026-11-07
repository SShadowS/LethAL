import {
  ALNodeKind,
  type ALSyntaxNode,
  type SemanticContext,
  argumentList,
  declaredNames,
  isProcedureLike,
  normalizeAlName,
  procedureLikeArmNames,
} from "@lethal/engine";
import {
  LOOP_KINDS,
  baseNameOf,
  cached,
  calleeOf,
  chainEffect,
  exitEffect,
  isIdentifierLike,
  isScope,
  objectOf,
  procEffect,
  procedureNamesOf,
  procsByName,
  r531Declares,
  visitAll,
} from "./loop-hazard";

/*
 * R868: the hang rules of the two opt-in operators `lethal.condition-true` (#36) and
 * `lethal.blank-argument` (#34). They live here and not in `loop-hazard.ts`, so a default run never
 * asks them. All are by NAME, the safe direction (R829: a wrong refusal loses one mutant, a miss can
 * end a run). Every rule is red-checked by a parsed AL source in `tests/r868-optin-hang.test.ts`.
 *
 * NAME MATCHING CANNOT SEE: another object (`Other.Run(Step)`, a table procedure, a page), a value
 * that goes through a record field, a setup table, a JSON or text round trip, an event publisher
 * whose subscribers step, `Codeunit.Run`, a `var` parameter written back to the caller, a key field
 * written on a cursor record, and a call graph that leaves the object and comes back.
 */

/**
 * RECURSION (R865). Both operators refuse a mutant on a self-call's guard (#36) or argument (#34),
 * and on a call chain that comes back to the enclosing procedure, inside one object. The rule rests
 * on no probe: R865 has not measured what unbounded AL recursion does on BC. When it has, widen or
 * narrow it HERE, in one place, for these operators only. Shipped operators do not read it.
 */
export const recursionRule = { on: true };

/** Does a call chain from any of `from` (same-object procedure names) reach a name in `targets`? */
function reaches(
  from: Iterable<string>,
  targets: ReadonlySet<string>,
  obj: ALSyntaxNode,
  ctx: SemanticContext,
): boolean {
  const byName = procsByName(obj, ctx);
  const seen = new Set<string>();
  const todo = [...from];
  for (let name = todo.pop(); name !== undefined; name = todo.pop()) {
    if (targets.has(name)) return true;
    if (seen.has(name)) continue;
    seen.add(name);
    for (const proc of byName.get(name) ?? []) todo.push(...procEffect(proc, ctx).calls);
  }
  return false;
}

/** The procedure (never a trigger) holding `node`, with every name it answers to. */
function enclosingProcedureNames(node: ALSyntaxNode): ReadonlySet<string> | null {
  for (let cur = node.parent; cur !== null; cur = cur.parent) {
    if (!isScope(cur)) continue;
    if (!isProcedureLike(cur) && cur.rawKind !== "procedure") return null;
    return new Set(procedureLikeArmNames(cur).map(normalizeAlName));
  }
  return null;
}

/**
 * Does `root` (inside procedure P) call P, or a same-object procedure that calls back to P through
 * any number of hops (A to B to A, and longer)? A one-hop mutual recursion is seen; so is a longer
 * cycle. A cycle that leaves the object is not.
 */
export function callsBackIntoEnclosing(root: ALSyntaxNode, ctx: SemanticContext): boolean {
  if (!recursionRule.on) return false;
  const own = enclosingProcedureNames(root);
  const obj = objectOf(root);
  if (own === null || obj === null) return false;
  const names = procedureNamesOf(obj, ctx);
  let found = false;
  visitAll(root, (n) => {
    if (found) return;
    const callee = calleeOf(n, names, ctx);
    if (callee !== null && reaches([callee], own, obj, ctx)) found = true;
  });
  return found;
}

/**
 * #34: is the procedure `call` calls (by name, in the SAME object) the enclosing procedure, or one
 * that calls back to it? Then the blanked argument may be the depth that ends the recursion
 * (`Next := Level + 1; Self(Next)`).
 */
export function calleeRecurses(
  call: ALSyntaxNode,
  calleeName: string,
  ctx: SemanticContext,
): boolean {
  if (!recursionRule.on) return false;
  const own = enclosingProcedureNames(call);
  const obj = objectOf(call);
  if (own === null || obj === null) return false;
  return reaches([normalizeAlName(calleeName)], own, obj, ctx);
}

// ---------------------------------------------------------------------------------------------
// #36 condition-true: the then-arm runs always.
// ---------------------------------------------------------------------------------------------

/** Cursor methods that only read, or change a field of the current row: no move, no new filter. */
const SAFE_ON_CURSOR: ReadonlySet<string> = new Set(
  (
    "modify validate testfield calcfields calcsums count isempty tablename fieldcaption fieldno " +
    "fieldname getfilter getfilters hasfilter isdirty tablecaption recordid getposition"
  ).split(" "),
);

/** The enclosing `while`/`repeat` loops of `node`, innermost first, up to the procedure. */
function enclosingLoops(node: ALSyntaxNode): ALSyntaxNode[] {
  const out: ALSyntaxNode[] = [];
  for (let cur = node.parent; cur !== null && !isScope(cur); cur = cur.parent) {
    if (LOOP_KINDS.has(cur.kind)) out.push(cur);
  }
  return out;
}

/**
 * Every name `arm` moves: assigned (a whole record, a variable, a field of a non-cursor), the
 * receiver of a call, an argument of a call, what a same-object callee chain writes.
 * `cursors` are the names an enclosing loop's exit steps (`until R.Next() = 0`): for those, a field
 * write, a read-only method and a plain `Next()` do not count; anything else on them does.
 */
function touchedBy(
  arm: ALSyntaxNode,
  obj: ALSyntaxNode,
  cursors: ReadonlySet<string>,
  ctx: SemanticContext,
): Set<string> {
  const out = new Set<string>();
  const names = procedureNamesOf(obj, ctx);
  visitAll(arm, (n) => {
    if (n.kind === ALNodeKind.assignment_statement) {
      const left = n.childForFieldName("left") ?? n.namedChildren[0] ?? null;
      const k = baseNameOf(left);
      if (left === null || k === null) return;
      if (cursors.has(k) && left.kind === ALNodeKind.field_access) return;
      out.add(k);
      // `Rec.Qty += 1` writes what a bare `Qty` reads.
      const m = left.kind === ALNodeKind.field_access ? left.childForFieldName("member") : null;
      if (m !== null) out.add(normalizeAlName(m.text));
      return;
    }
    if (n.rawKind === "for_statement" || n.rawKind === "foreach_statement") {
      const k = baseNameOf(n.childForFieldName("variable"));
      if (k !== null) out.add(k);
      return;
    }
    if (n.rawKind !== "call_expression" && n.rawKind !== "call_statement") return;
    const args = argumentList(n);
    const callee = calleeOf(n, names, ctx);
    if (callee !== null) {
      for (const k of chainEffect(callee, obj, ctx).writes) out.add(k);
    } else {
      const f = n.childForFieldName("function");
      const recv = f?.kind === ALNodeKind.field_access ? f.childForFieldName("object") : null;
      const method = normalizeAlName(f?.childForFieldName("member")?.text ?? "");
      const k = baseNameOf(recv);
      if (k !== null) {
        const harmless =
          cursors.has(k) &&
          (SAFE_ON_CURSOR.has(method) || (method === "next" && args.length === 0));
        if (!harmless) out.add(k);
      }
    }
    for (const a of args) {
      const k = baseNameOf(a);
      if (k === null) continue;
      // A field of the cursor record handed to a call (`Show(R.Amount)`) does not move it.
      if (cursors.has(k) && !isIdentifierLike(a)) continue;
      out.add(k);
    }
  });
  return out;
}

/** A cursor step in a condition inside a loop (`if R.Next() = 0 then`): forced true, it never runs. */
function conditionStepsCursor(cond: ALSyntaxNode): boolean {
  if (enclosingLoops(cond).length === 0) return false;
  let hit = false;
  visitAll(cond, (n) => {
    if (n.rawKind !== "call_expression" && n.rawKind !== "call_statement") return;
    const m = n.childForFieldName("function")?.childForFieldName("member");
    if (m !== null && m !== undefined && CURSOR_STEPS.has(normalizeAlName(m.text))) hit = true;
  });
  return hit;
}
const CURSOR_STEPS: ReadonlySet<string> = new Set(["next", "read", "movenext"]);

/**
 * R868, `lethal.condition-true`: `if C then T` becomes `if true then T`, so T runs every time.
 * Refused here, beyond what `inLoopExitParts` and `deletedOperandHangs` ask of the condition:
 *  1. T holds a `while`/`repeat` whose exit does not step a cursor (`Next`, `Read`): its end may rest
 *     on the very test that was forced (`if Step > 0 then while I < N do I += Step`).
 *  2. T moves a name an enclosing loop's exit parts read: an assignment (`I -= 1`, `A := 0`), a call
 *     on it or with it as an argument, a same-object helper that writes it (reset, requeue). For a
 *     cursor the exit steps, only a harmful move counts: `R.FindFirst()`, `R.Next(-1)`, `R.Reset()`,
 *     `R := X`, `R` passed whole. A field write, `Modify`, `CalcFields` and a plain `Next()` do not.
 *  3. T calls back into the enclosing procedure (recursion, see `recursionRule`).
 *  4. The condition steps a cursor (`if R.Next() = 0 then`) inside a loop: true, it never steps.
 * A forced `break` or `exit` is NOT narrowed here: it ends the loop, it cannot hang it, and the
 * existing exit-guard rule still refuses most of them (measured, R-862: about 37 on DO, 85 on DC).
 *
 * NOT SEEN: a key field written on a cursor record (`R."No." := 'A'`, then `Next`), a loop inside a
 * callee T calls, a helper that restarts a cursor held in a global when it only reads it.
 */
export function thenArmHangs(ifNode: ALSyntaxNode, ctx: SemanticContext): boolean {
  // Asked up to three times per site (targets, generate, refusesHangCapable).
  return cached(ctx, ifNode, `thenArm|${recursionRule.on}`, () =>
    thenArmHangsUncached(ifNode, ctx),
  );
}

function thenArmHangsUncached(ifNode: ALSyntaxNode, ctx: SemanticContext): boolean {
  const arm = ifNode.childForFieldName("then_branch");
  const obj = objectOf(ifNode);
  if (arm === null || obj === null) return false;
  if (callsBackIntoEnclosing(arm, ctx)) return true;
  const cond = ifNode.childForFieldName("condition");
  if (cond !== null && conditionStepsCursor(cond)) return true;
  let loopInside = false;
  visitAll(arm, (x) => {
    if (LOOP_KINDS.has(x.kind) && exitEffect(x, ctx).steps.size === 0) loopInside = true;
  });
  if (loopInside) return true;
  const loops = enclosingLoops(ifNode);
  if (loops.length === 0) return false;
  const effects = loops.map((l) => exitEffect(l, ctx));
  const cursors = new Set(effects.flatMap((e) => [...e.steps]));
  const touched = touchedBy(arm, obj, cursors, ctx);
  return effects.some((e) => [...touched].some((k) => e.read.has(k)));
}

// ---------------------------------------------------------------------------------------------
// #34 blank-argument: the callee gets a blank for one parameter.
// ---------------------------------------------------------------------------------------------

const ANY_LOOP: ReadonlySet<string> = new Set([
  "while_statement",
  "repeat_statement",
  "for_statement",
]);

/** The parameter names of a procedure, in order. */
function parameterNames(proc: ALSyntaxNode): string[] {
  const list = proc.namedChildren.find((c) => c.rawKind === "parameter_list");
  if (list === undefined) return [];
  return list.namedChildren
    .filter((c) => c.rawKind === "parameter")
    .map((c) => normalizeAlName(declaredNames(c)[0] ?? ""));
}

/** Does `scope` read any of `names` inside a `while`, `repeat` or `for`? */
function readsInLoop(scope: ALSyntaxNode, names: ReadonlySet<string>): boolean {
  let hit = false;
  const scan = (n: ALSyntaxNode, looping: boolean): void => {
    if (hit) return;
    const now = looping || ANY_LOOP.has(n.rawKind);
    if (now && isIdentifierLike(n) && names.has(normalizeAlName(n.text))) hit = true;
    for (const c of n.namedChildren) scan(c, now);
  };
  scan(scope, false);
  return hit;
}

/** Names that hold a copy of the value in `from`, by assignment or by being handed to a call. */
function copiesOf(
  proc: ALSyntaxNode,
  from: ReadonlySet<string>,
  obj: ALSyntaxNode,
  ctx: SemanticContext,
): Set<string> {
  const tainted = new Set(from);
  const names = procedureNamesOf(obj, ctx);
  const reads = (n: ALSyntaxNode): boolean => {
    let hit = false;
    visitAll(n, (x) => {
      if (isIdentifierLike(x) && x.fieldName !== "member" && tainted.has(normalizeAlName(x.text))) {
        hit = true;
      }
    });
    return hit;
  };
  for (let grew = true; grew; ) {
    grew = false;
    const add = (k: string | null): void => {
      if (k !== null && !tainted.has(k)) {
        tainted.add(k);
        grew = true;
      }
    };
    visitAll(proc, (n) => {
      if (n.kind === ALNodeKind.assignment_statement) {
        const left = n.childForFieldName("left") ?? n.namedChildren[0] ?? null;
        const right = n.childForFieldName("right");
        if (left === null || right === null || !reads(right)) return;
        add(baseNameOf(left));
        const m = left.kind === ALNodeKind.field_access ? left.childForFieldName("member") : null;
        if (m !== null) add(normalizeAlName(m.text));
      } else if (n.rawKind === "call_expression" || n.rawKind === "call_statement") {
        // `Items.Add(Step)`, `Setup.SetStep(Step)`: the receiver now holds it.
        if (calleeOf(n, names, ctx) !== null) return;
        if (!argumentList(n).some(reads)) return;
        const f = n.childForFieldName("function");
        if (f?.kind === ALNodeKind.field_access) add(baseNameOf(f.childForFieldName("object")));
      }
    });
  }
  return tainted;
}

/**
 * R868, `lethal.blank-argument`: can the value this callee gets for parameter `param` stop a loop
 * making progress, or end one early? True when the parameter, or a copy of it, is read in a loop:
 *  - in the callee, directly (`while I < N do I += Step`);
 *  - through a copy: a local (`L := Step; while I < N do I += L`), also `L := Step * 2`;
 *  - through a global it is stored in (a setter, `Held := Step`) that ANY loop of the object reads;
 *  - through a receiver it is handed to (`Items.Add(Step)`);
 *  - through another same-object procedure the callee hands it to as an argument (followed, to
 *    `MAX_DEPTH` calls deep, each overload of that arity).
 * NAME MATCHING CANNOT SEE: another object (a record field, a setup table, `Other.Use(Step)`), a
 * `var` parameter written back, a text or JSON round trip, a subscriber, `Codeunit.Run`.
 */
export function calleeLoopUsesParam(
  proc: ALSyntaxNode,
  param: string,
  ctx: SemanticContext,
): boolean {
  return cached(ctx, proc, `calleeLoop|${param}`, () => calleeLoopUncached(proc, param, ctx));
}

function calleeLoopUncached(proc: ALSyntaxNode, param: string, ctx: SemanticContext): boolean {
  const seen = new Set<string>();
  const walk = (p: ALSyntaxNode, name: string, depth: number): boolean => {
    const key = `${p.startIndex}-${p.endIndex}-${p.text.length}|${name}`;
    if (seen.has(key) || depth > MAX_DEPTH) return false;
    seen.add(key);
    const obj = objectOf(p);
    if (obj === null) return readsInLoop(p, new Set([name]));
    const tainted = copiesOf(p, new Set([name]), obj, ctx);
    const returned = p.childForFieldName("return_value");
    const local = (k: string): boolean =>
      r531Declares(p, k, true) || (returned !== null && normalizeAlName(returned.text) === k);
    const inProc = new Set([...tainted].filter(local));
    const global = new Set([...tainted].filter((k) => !local(k)));
    if (inProc.size > 0 && readsInLoop(p, inProc)) return true;
    if (global.size > 0 && readsInLoop(obj, global)) return true;
    // Followed into a same-object procedure that gets a copy as an argument.
    const names = procedureNamesOf(obj, ctx);
    const byName = procsByName(obj, ctx);
    let hit = false;
    visitAll(p, (n) => {
      if (hit) return;
      if (n.rawKind !== "call_expression" && n.rawKind !== "call_statement") return;
      const callee = calleeOf(n, names, ctx);
      if (callee === null) return;
      const args = argumentList(n);
      args.forEach((a, i) => {
        let uses = false;
        visitAll(a, (x) => {
          if (
            isIdentifierLike(x) &&
            x.fieldName !== "member" &&
            tainted.has(normalizeAlName(x.text))
          ) {
            uses = true;
          }
        });
        if (!uses) return;
        for (const inner of byName.get(callee) ?? []) {
          const params = parameterNames(inner);
          const target = params[i];
          if (
            params.length === args.length &&
            target !== undefined &&
            walk(inner, target, depth + 1)
          ) {
            hit = true;
          }
        }
      });
    });
    return hit;
  };
  return walk(proc, normalizeAlName(param), 0);
}

const MAX_DEPTH = 4;
