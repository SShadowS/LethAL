import {
  type ALSyntaxNode,
  type SemanticContext,
  argumentList,
  normalizeAlName,
} from "@lethal/engine";

/**
 * R865: does an additive mutant at `node` change a DEPTH ARGUMENT of a direct recursion? A depth
 * argument is one whose parameter a guard of the recursion reads, directly or through other
 * arguments: in `if Level >= 10 then exit; Walk(Level + 1);`, `Level + 1` to `Level - 1` or to
 * `Level` recurses without bound.
 *
 * Narrow on purpose (coord R-871: of 2,866 broader sites, a read sample was mostly good mutants).
 * A call to an OVERLOAD is never recursion: the call must pass as many arguments as the procedure
 * has parameters, and when another procedure of that name and count exists, every argument's type
 * must match this procedure's and no other's. Named limits (R865): a value that stops shrinking
 * through an assignment, a guard that re-enters in the same state, mutual recursion, recursion
 * through globals or another object, and a procedure split by `#if`.
 */
export function recursionDepthHangs(node: ALSyntaxNode, ctx: SemanticContext): boolean {
  // Cheap first: the calls around `node`, up to its procedure.
  const around: ALSyntaxNode[] = [];
  let proc: ALSyntaxNode | null = node.parent;
  while (proc !== null && proc.rawKind !== "procedure") {
    if (proc.rawKind === "call_expression") around.push(proc);
    proc = proc.parent;
  }
  if (proc === null || around.length === 0) return false;
  const p = proc;
  const params = paramsOf(p);
  const own = around
    .filter((call) => isSelfCall(call, p, params, ctx))
    .flatMap((call) => {
      const i = argumentList(call).findIndex((a) => within(node, a));
      return i < 0 ? [] : [i];
    });
  if (own.length === 0) return false;
  const selfCalls = descendants(p).filter((c) => isSelfCall(c, p, params, ctx));
  const isSelf = (y: ALSyntaxNode): boolean =>
    selfCalls.some((c) => c.startIndex === y.startIndex && c.endIndex === y.endIndex);

  // What the recursion's guards read: the condition of any `if` whose arm holds a self-call or an
  // `exit`, closed over "argument i feeds parameter i".
  const depth = new Set<string>();
  for (const ifs of descendants(p).filter((x) => x.rawKind === "if_statement")) {
    const [cond, ...arms] = ifs.namedChildren.filter((c) => !c.rawKind.endsWith("_keyword"));
    if (cond === undefined) continue;
    const armHolds = arms.some((a) =>
      descendants(a).some((y) => y.rawKind === "exit_statement" || isSelf(y)),
    );
    if (armHolds) for (const n of namesIn(cond)) depth.add(n);
  }
  for (let grew = true; grew; ) {
    grew = false;
    for (const call of selfCalls)
      argumentList(call).forEach((a, i) => {
        if (!depth.has(params[i]?.name ?? "")) return;
        for (const n of namesIn(a))
          if (!depth.has(n)) {
            depth.add(n);
            grew = true;
          }
      });
  }
  return own.some((i) => depth.has(params[i]?.name ?? ""));
}

interface Param {
  readonly name: string;
  readonly type: string;
}

function paramsOf(proc: ALSyntaxNode): Param[] {
  const out: Param[] = [];
  for (const list of proc.namedChildren.filter((c) => c.rawKind === "parameter_list"))
    for (const prm of list.namedChildren.filter((c) => c.rawKind === "parameter")) {
      const id = prm.namedChildren.find(isName);
      const type = prm.namedChildren.find((c) => c.rawKind === "type_specification");
      out.push({
        name: id === undefined ? "" : normalizeAlName(id.text),
        type: typeKey(type?.text),
      });
    }
  return out;
}

/** `Code[20]` and `code[10]` are one key: a length does not pick an overload. */
const typeKey = (t: string | null | undefined): string =>
  (t ?? "")
    .replace(/\[[^\]]*\]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

function procName(proc: ALSyntaxNode): string {
  const id = proc.namedChildren.find(isName);
  return id === undefined ? "" : normalizeAlName(id.text);
}

/** `Name(...)` or `this.Name(...)` that resolves to `proc` itself, never to an overload. */
function isSelfCall(
  call: ALSyntaxNode,
  proc: ALSyntaxNode,
  params: readonly Param[],
  ctx: SemanticContext,
): boolean {
  if (call.rawKind !== "call_expression") return false;
  const callee = call.namedChildren[0];
  // `descendants` walks every node of the procedure: the name test runs before any object walk.
  if (callee === undefined) return false;
  let name: string | null = null;
  if (isName(callee)) name = normalizeAlName(callee.text);
  else if (callee.rawKind === "member_expression") {
    const [recv, member] = callee.namedChildren;
    if (recv?.text.toLowerCase() === "this" && member !== undefined && isName(member))
      name = normalizeAlName(member.text);
  }
  const own = procName(proc);
  if (name === null || name !== own) return false;
  const args = argumentList(call);
  if (args.length !== params.length) return false;
  // Every procedure of this name and count in the object, `#if` arms included.
  let object: ALSyntaxNode | null = proc.parent;
  while (object !== null && object.parent !== null && object.parent.rawKind !== "source_file")
    object = object.parent;
  const twins = descendants(object ?? proc).filter(
    (q) => q.rawKind === "procedure" && procName(q) === own && paramsOf(q).length === args.length,
  );
  if (twins.length === 1) return true;
  // An overload of the same count: every argument's type must be known and match this one only.
  const argTypes = args.map((a) => typeKey(ctx.types.typeOf(a)));
  if (argTypes.some((t) => t === "")) return false;
  const fits = (q: ALSyntaxNode): boolean =>
    paramsOf(q).every((prm, i) => prm.type === argTypes[i]);
  return fits(proc) && twins.filter(fits).length === 1;
}

const isName = (n: ALSyntaxNode): boolean =>
  n.rawKind === "identifier" || n.rawKind === "quoted_identifier";

const within = (n: ALSyntaxNode, outer: ALSyntaxNode): boolean =>
  n.startIndex >= outer.startIndex && n.endIndex <= outer.endIndex;

function descendants(n: ALSyntaxNode): ALSyntaxNode[] {
  const out: ALSyntaxNode[] = [];
  const go = (x: ALSyntaxNode): void => {
    out.push(x);
    for (const c of x.namedChildren) go(c);
  };
  go(n);
  return out;
}

function namesIn(n: ALSyntaxNode): Set<string> {
  return new Set(
    descendants(n)
      .filter(isName)
      .map((x) => normalizeAlName(x.text)),
  );
}
