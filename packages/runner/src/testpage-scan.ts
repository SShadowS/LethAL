/**
 * R-236c: which discovered tests have a reachable call that may open a TestPage, read from the test
 * app's SOURCE before anything is sent. Sending such a test into the fenced session gets at best
 * BC's refusal (R69) and at worst a lost reply and a wedged server tier
 * (docs/measurements/2026-09-27-nst-wedge-incidents.md). The reply cannot be recovered (R-236b).
 *
 * A static, safety-first policy: conditions are not evaluated, so an opening behind
 * `if GuiAllowed then` is refused too, and same-arity overloads are all walked. A receiver the
 * scanner cannot resolve to a plain declared name (parenthesised, subscripted, a with-statement's
 * implicit receiver, or a same-codeunit call with no matching procedure) refuses too when the
 * called name is itself opening-shaped, since the scanner cannot prove it is safe.
 * Documented limits, sent as before: handler-driven pages, helpers outside the test app or in
 * non-codeunit objects, Codeunit.Run, event subscribers, interfaces, and a bare zero-argument call
 * without parentheses in expression position (`B := Helper;`).
 *
 * Scope is read from the AST here, NOT through the engine: `collectVarDeclarations` keeps only the
 * first name of `A, B: TestPage X`, and `resolveVarRef` never resolves a member receiver. Either
 * would read as "not a TestPage" and send the test (see the roadmap items filed by R-236c).
 */
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  type ALSyntaxNode,
  initParser,
  normalizeAlName,
  parseAL,
  visit,
  wrapRoot,
} from "@lethal/engine";
import type { TestMethodRef } from "./backend";
import { testKeyOf } from "./selection";

/** Checked against Microsoft Learn's TestPage/TestRequestPage method lists (Task 1 Step 0). */
const OPENING_METHODS = new Set(["openview", "openedit", "opennew", "trap"]);
/** Anchored at the start, but `array[...] of TestPage X` is a TestPage-typed declaration too. */
const PAGE_TYPE = /^\s*(?:array\s*\[[^\]]*\]\s*of\s+)?test(request)?page\b/i;
const CODEUNIT_TYPE = /^\s*codeunit\s+(.+?)\s*$/i;
const NAME_KINDS = new Set(["identifier", "quoted_identifier"]);
/** `#if`/`#elif`/`#else`/`#endif` branch markers inside a `preproc_conditional*` wrapper: not real
 *  content, dropped before recursing into the wrapper's branches. */
const PREPROC_BRANCH_MARKER = new Set([
  "preproc_if",
  "preproc_elif",
  "preproc_else",
  "preproc_endif",
]);

/**
 * Unwraps every `preproc_conditional`/`preproc_conditional_var`/`preproc_conditional_object` node,
 * keeping EVERY branch: the scanner is static and safety-first, so a procedure, object or
 * declaration inside any `#if`/`#elif`/`#else` arm must be visible, not only the arm that would be
 * active at compile time for one particular build.
 */
function flattenPreproc(nodes: readonly ALSyntaxNode[]): ALSyntaxNode[] {
  const out: ALSyntaxNode[] = [];
  for (const n of nodes) {
    if (n.rawKind.startsWith("preproc_conditional")) {
      out.push(
        ...flattenPreproc(n.namedChildren.filter((c) => !PREPROC_BRANCH_MARKER.has(c.rawKind))),
      );
    } else {
      out.push(n);
    }
  }
  return out;
}

/** Thrown before anything is sent: a test whose reachable source could not be read is not sent. */
export class TestPageScanError extends Error {
  constructor(readonly reasons: readonly string[]) {
    super(
      `TestPage scan could not classify the test app, so nothing was sent (R-236c): ${reasons.join("; ")}`,
    );
    this.name = "TestPageScanError";
  }
}

export interface TestPageAnalysis {
  readonly refused: ReadonlyMap<string, string>;
  readonly errors: readonly string[];
}

type TsNode = ReturnType<typeof parseAL>["rootNode"];

interface ErrorSite {
  readonly startIndex: number;
  /** The ERROR/MISSING node's own text: an unclosed object can swallow the next one whole, so its
   *  ERROR span can literally contain a later object's keyword (`docs/...`, review round 1 #5). */
  readonly text: string;
}

/** Every ERROR and MISSING node (MISSING carries the missing token's type, and its text is empty). */
function errorOffsets(root: TsNode): ErrorSite[] {
  if (!root.hasError) return [];
  const out: ErrorSite[] = [];
  const walk = (n: TsNode): void => {
    if (n.type === "ERROR" || n.isMissing) out.push({ startIndex: n.startIndex, text: n.text });
    for (const c of n.children) if (c !== null) walk(c);
  };
  walk(root);
  return out;
}

/** An ERROR node's span can name an object kind it swallowed whole, not just the one it sits in. */
const SWALLOWS_CODEUNIT = /\bcodeunit\b/i;

const within = (off: number, n: ALSyntaxNode) => off >= n.startIndex && off <= n.endIndex;

/**
 * Is `n` lexically inside some enclosing `with_statement`'s body (not its `record:` target
 * expression)? A `with X do ...` shadows a bare call's receiver with `X`, which the scanner does
 * not resolve (review round 2, #B); stops at the enclosing procedure/trigger, since a with-statement
 * never spans a procedure boundary.
 */
function insideWithStatement(n: ALSyntaxNode): boolean {
  let cur = n.parent;
  while (cur !== null) {
    if (cur.rawKind === "with_statement") return true;
    if (cur.rawKind === "procedure" || cur.rawKind === "trigger_declaration") return false;
    cur = cur.parent;
  }
  return false;
}

/**
 * Plain facts only, no syntax nodes: every tree is deleted as soon as its file is read (a kept tree
 * lives in the wasm heap, and BC.History/BaseApp's 9,620 kept trees hit its 2,048 MB ceiling and
 * aborted). A call site, in source pre-order, as the traversal will need it.
 */
type Site =
  /** A bare call (`Name(...)` or a call statement): same codeunit, possibly a with-receiver. */
  | {
      readonly kind: "bare";
      readonly name: string;
      readonly args: number;
      readonly inWith: boolean;
    }
  /** `receiver.member`, called or not; `plain` when the receiver is a bare declared name. */
  | {
      readonly kind: "member";
      readonly plain: boolean;
      readonly receiver: string;
      readonly member: string;
      readonly args: number;
    };

interface Unit {
  readonly file: string;
  readonly id: number;
  readonly name: string; // normalised
  readonly display: string;
  readonly damaged: boolean;
  readonly globals: ReadonlyMap<string, string>; // every declared name -> type text
  readonly pageNamesAnywhere: ReadonlySet<string>;
  readonly procs: readonly Proc[];
  readonly problems: readonly string[];
}

interface Proc {
  readonly unit: Unit;
  /** Undefined when the procedure has no code block. */
  readonly sites: readonly Site[] | undefined;
  readonly name: string; // normalised
  readonly display: string;
  readonly params: number;
  readonly scope: ReadonlyMap<string, string>; // parameters and locals, every name
}

function nameNode(n: ALSyntaxNode): ALSyntaxNode | undefined {
  return n.namedChildren.find((c) => NAME_KINDS.has(c.rawKind));
}

/**
 * Every name of every `variable_declaration` under `section`, into `into`. With `skipProcedures`,
 * a `procedure` subtree is not entered: see `procsInVarSection`, whose procedures' locals must not
 * read as globals.
 */
function addDeclarations(
  section: ALSyntaxNode,
  into: Map<string, string>,
  where: string,
  problems: string[],
  skipProcedures = false,
): void {
  const walk = (d: ALSyntaxNode): void => {
    if (skipProcedures && d.rawKind === "procedure") return;
    if (d.rawKind === "variable_declaration") {
      const type = d.namedChildren.find((c) => c.rawKind === "type_specification")?.text ?? "";
      const names = d.namedChildren.filter((c) => NAME_KINDS.has(c.rawKind));
      if (names.length === 0 && PAGE_TYPE.test(type)) {
        problems.push(`${where}: a TestPage declaration whose name the scanner cannot read`);
      }
      for (const n of names) into.set(normalizeAlName(n.text), type);
    }
    for (const c of d.children) walk(c);
  };
  walk(section);
}

/**
 * tree-sitter-al 4.4.1 parses an `#if` region that directly follows the global `var` section INSIDE
 * that section (`var_section > var_body > preproc_conditional_var > procedure`), where the AL
 * compiler places the same procedures at codeunit level (upstream tree-sitter-al #29). Kept until
 * the grammar is fixed. Every branch's procedures are returned, in source order.
 */
function procsInVarSection(section: ALSyntaxNode): ALSyntaxNode[] {
  const out: ALSyntaxNode[] = [];
  const walk = (n: ALSyntaxNode): void => {
    if (n.rawKind === "procedure") {
      out.push(n);
      return;
    }
    for (const c of n.namedChildren) walk(c);
  };
  walk(section);
  return out;
}

function buildUnit(file: string, node: ALSyntaxNode, errors: readonly ErrorSite[]): Unit {
  const id = Number(node.namedChildren.find((c) => c.rawKind === "integer")?.text);
  const display = (nameNode(node)?.text ?? "").replace(/^"|"$/g, "");
  const body = node.namedChildren.find((c) => c.rawKind === "declaration_body");
  const problems: string[] = [];
  const globals = new Map<string, string>();
  const pageNamesAnywhere = new Set<string>();
  const unitShell = {
    file,
    id,
    name: normalizeAlName(display),
    display,
    damaged: errors.some((e) => within(e.startIndex, node)),
    globals,
    pageNamesAnywhere,
    problems,
    procs: [] as Proc[],
  };
  if (body !== undefined) {
    const members = flattenPreproc(body.namedChildren).flatMap((c) =>
      c.rawKind.endsWith("var_section") ? [c, ...procsInVarSection(c)] : [c],
    );
    for (const c of members) {
      if (c.rawKind.endsWith("var_section"))
        addDeclarations(c, globals, `${display} globals`, problems, true);
    }
    const all = new Map<string, string>();
    addDeclarations(body, all, `${display}`, []);
    for (const [n, t] of all) if (PAGE_TYPE.test(t)) pageNamesAnywhere.add(n);
    for (const p of members) {
      if (p.rawKind !== "procedure") continue;
      const id2 = nameNode(p);
      if (id2 === undefined) continue;
      const scope = new Map<string, string>();
      const plist = p.namedChildren.find((c) => c.rawKind === "parameter_list");
      const params = plist?.namedChildren.filter((c) => c.rawKind === "parameter") ?? [];
      for (const prm of params) {
        const n = nameNode(prm);
        const t = prm.namedChildren.find((c) => c.rawKind === "type_specification")?.text ?? "";
        if (n !== undefined) scope.set(normalizeAlName(n.text), t);
      }
      const vars = p.namedChildren.find((c) => c.rawKind === "var_section");
      if (vars !== undefined) addDeclarations(vars, scope, `${display}.${id2.text}`, problems);
      const block = p.namedChildren.find((c) => c.rawKind === "code_block");
      unitShell.procs.push({
        unit: unitShell,
        sites: block === undefined ? undefined : callSites(block),
        name: normalizeAlName(id2.text),
        display: `${display}.${id2.text}`,
        params: params.length,
        scope,
      });
    }
  }
  return unitShell;
}

/** The call sites under `block`, in the pre-order the traversal used to visit them live. */
function callSites(block: ALSyntaxNode): Site[] {
  const out: Site[] = [];
  const member = (m: ALSyntaxNode, args: number): void => {
    const [receiver, name] = m.namedChildren;
    if (receiver === undefined || name === undefined) return;
    out.push({
      kind: "member",
      plain: NAME_KINDS.has(receiver.rawKind),
      receiver: receiver.text,
      member: name.text,
      args,
    });
  };
  visit(block, (n) => {
    if (n.rawKind === "call_expression") {
      const fn = n.childForFieldName("function");
      const args =
        n.namedChildren.find((c) => c.rawKind === "argument_list")?.namedChildren.length ?? 0;
      if (fn === null) return;
      if (NAME_KINDS.has(fn.rawKind))
        out.push({ kind: "bare", name: fn.text, args, inWith: insideWithStatement(n) });
      else if (fn.rawKind === "member_expression") member(fn, args);
      return;
    }
    if (n.rawKind === "member_expression") {
      const parent = n.parent;
      const isCallee =
        parent !== null &&
        parent.rawKind === "call_expression" &&
        parent.childForFieldName("function")?.startIndex === n.startIndex;
      if (!isCallee) member(n, 0);
      return;
    }
    if (n.rawKind === "call_statement") {
      const id = nameNode(n);
      if (id !== undefined)
        out.push({ kind: "bare", name: id.text, args: 0, inWith: insideWithStatement(n) });
    }
  });
  return out;
}

interface TestState {
  readonly visited: Set<Proc>;
  readonly reached: Set<Unit>;
  readonly unresolvedTargets: Set<string>;
  readonly problems: string[];
  reason: string | undefined;
}

class Scanner {
  constructor(private readonly units: readonly Unit[]) {}

  /**
   * Every codeunit a `Codeunit <type text>` reference could plausibly name — ALL candidates, not
   * the first (review round 3): a reference is genuinely ambiguous without full AL symbol
   * resolution (which the scanner deliberately does not do), so every textually-plausible reading
   * is walked, and a call is resolved, or a test refused, if ANY of them says so.
   */
  unitsFor(typeText: string): Unit[] {
    const raw = CODEUNIT_TYPE.exec(typeText)?.[1];
    if (raw === undefined) return [];
    // A namespace-qualified reference (`Codeunit My.Tests."Lib"`) carries the namespace as leading
    // dotted segments OUTSIDE any quotes; the object itself is always the LAST such segment
    // (review round 1, #3). A quoted segment is kept whole even if it contains its own dot
    // (review round 2, #A): the quote-and-dot alternation matches a whole `"..."` run as one token.
    const segments = raw.match(/"[^"]*"|[^.]+/g) ?? [raw];
    const candidates = new Set<Unit>();
    // The WHOLE text as one literal name: only when it cannot itself be a namespace-dotted path,
    // i.e. it is a single quoted identifier or a bare name with no dots at all (one segment either
    // way). An UNQUOTED multi-segment reference (`Codeunit A.B`) must NOT be tried as a literal
    // name here, since it can coincidentally equal an UNRELATED codeunit's own quoted name
    // (`"A.B"`) that has nothing to do with namespace `A`'s object `B` (review round 3).
    if (segments.length === 1) {
      for (const u of this.byNameAll(normalizeAlName(raw))) candidates.add(u);
    }
    const last = segments[segments.length - 1] ?? raw;
    for (const u of this.byNameAll(normalizeAlName(last))) candidates.add(u);
    return [...candidates];
  }

  /** By id (numeric) or by declared name; both checked for every candidate string above. */
  private byNameAll(want: string): Unit[] {
    return this.units.filter((u) => String(u.id) === want || u.name === want);
  }

  walk(p: Proc, path: readonly string[], st: TestState): void {
    if (st.visited.has(p)) return;
    st.visited.add(p);
    st.reached.add(p.unit);
    const here = [...path, p.display];
    if (p.sites === undefined) return;
    for (const site of p.sites) {
      if (site.kind === "bare")
        this.sameCodeunitCall(p.unit, site.name, site.args, here, st, site.inWith);
      else this.member(p, site, here, st);
    }
  }

  /** Returns whether at least one procedure of `owner` matched (and was walked). */
  private calls(
    owner: Unit,
    rawName: string,
    args: number,
    path: readonly string[],
    st: TestState,
  ): boolean {
    const name = normalizeAlName(rawName);
    let matched = false;
    for (const c of owner.procs) {
      if (c.name === name && c.params === args) {
        matched = true;
        this.walk(c, path, st);
      }
    }
    return matched;
  }

  /**
   * A call into the CALLING procedure's own codeunit (a bare name, `this.Name`, or a
   * with-statement's implicit receiver, which parses as a bare name too). When no procedure of
   * that name and arity exists, an ordinary call could not have compiled, so this is either a
   * with-statement's implicit receiver method or a shape the scanner does not otherwise resolve.
   * Refused when the name itself is opening-shaped (safety-first; review round 1, #6), or, for a
   * genuinely bare call, when it sits inside a `with` body: the scanner does not
   * resolve the with-target's own type, so an unresolved bare call there could be a call into that
   * codeunit instead (safety-first; review round 2, #B). `this.Name` passes `inWith` false, since an
   * explicit receiver is not ambiguous with a with-statement's implicit one.
   */
  private sameCodeunitCall(
    unit: Unit,
    rawName: string,
    args: number,
    path: readonly string[],
    st: TestState,
    inWith: boolean,
  ): void {
    const matched = this.calls(unit, rawName, args, path, st);
    if (matched) return;
    if (OPENING_METHODS.has(normalizeAlName(rawName))) {
      st.reason ??= `${path.join(" -> ")} calls ${rawName} (unresolved same-codeunit call, safety-first)`;
      return;
    }
    if (inWith) {
      st.reason ??= `${path.join(" -> ")} calls ${rawName} inside a with-statement, unresolved in this codeunit (safety-first)`;
    }
  }

  private member(
    p: Proc,
    site: Extract<Site, { kind: "member" }>,
    path: readonly string[],
    st: TestState,
  ): void {
    const { args, receiver, member } = site;
    if (!site.plain) {
      // A non-plain receiver (parenthesised, subscripted, chained, ...) cannot be resolved to a
      // declared name, so scope cannot be checked. Refuse only when the member itself is
      // opening-shaped: safety-first, never silently "not an edge" (review round 1, #4).
      if (OPENING_METHODS.has(normalizeAlName(member))) {
        st.reason ??= `${path.join(" -> ")} calls ${receiver}.${member} on an unresolved receiver`;
      }
      return;
    }
    const key = normalizeAlName(receiver);
    if (key === "this") {
      // `this` refers to the codeunit instance itself (review round 1, #1): not a declared name,
      // so it is never in scope/globals, and must not silently fall through as "not a TestPage".
      this.sameCodeunitCall(p.unit, member, args, path, st, false);
      return;
    }
    const type = p.scope.get(key) ?? p.unit.globals.get(key);
    if (type === undefined) {
      if (p.unit.pageNamesAnywhere.has(key)) {
        st.problems.push(
          `${p.display} uses ${receiver}, which matches a TestPage declaration the scanner cannot place in scope`,
        );
      }
      return;
    }
    if (PAGE_TYPE.test(type) && OPENING_METHODS.has(normalizeAlName(member))) {
      st.reason ??= `${path.join(" -> ")} calls ${receiver}.${member} on ${type.trim()}`;
      return;
    }
    if (!CODEUNIT_TYPE.test(type)) return;
    const targets = this.unitsFor(type);
    if (targets.length === 0) {
      st.unresolvedTargets.add(type.trim());
      return;
    }
    // Resolved if ANY candidate was found; walk every one, like overloads (review round 3).
    for (const target of targets) {
      st.reached.add(target);
      this.calls(target, member, args, path, st);
    }
  }
}

/** Reads one file's codeunits and parse damage into plain facts; `tree` is not kept. */
function scanFile(
  path: string,
  tree: ReturnType<typeof parseAL>,
  units: Unit[],
  suspect: string[],
): void {
  const errors = errorOffsets(tree.rootNode);
  const root = wrapRoot(tree);
  const objects = flattenPreproc(root.namedChildren).filter(
    (c) => c.rawKind.endsWith("_declaration") && c.rawKind !== "namespace_declaration",
  );
  for (const o of objects) {
    if (o.rawKind === "codeunit_declaration") units.push(buildUnit(path, o, errors));
  }
  for (const e of errors) {
    const owner = objects.find((o) => within(e.startIndex, o));
    // Suspect exactly as before (inside a codeunit, or outside every object) PLUS an ERROR span
    // that itself names a `codeunit` keyword: an unclosed object can swallow the next one whole,
    // so the swallowed codeunit never becomes a `Unit` and a call into it reads as "not found"
    // rather than as the parse damage it actually is (review round 1, #5).
    if (
      owner === undefined ||
      owner.rawKind === "codeunit_declaration" ||
      SWALLOWS_CODEUNIT.test(e.text)
    ) {
      suspect.push(`${path} at offset ${e.startIndex}`);
    }
  }
}

export function analyzeTestPageSources(
  files: ReadonlyArray<{ path: string; text: string }>,
  tests: readonly TestMethodRef[],
): TestPageAnalysis {
  const units: Unit[] = [];
  /** Errors inside a codeunit, or outside every top-level object: either could hide a target. */
  const suspect: string[] = [];
  for (const f of files) {
    const tree = parseAL(f.text);
    try {
      scanFile(f.path, tree, units, suspect);
    } finally {
      // Units hold plain facts only, so the tree can go now (see `Site`).
      tree.delete();
    }
  }
  const scanner = new Scanner(units);
  const refused = new Map<string, string>();
  const errors: string[] = [];
  for (const t of tests) {
    const label = `${t.codeunitName}.${t.method}`;
    if (t.file === undefined) {
      errors.push(`${label} has no file`);
      continue;
    }
    const owner = units.find((u) => u.id === t.codeunitId);
    const decls =
      owner?.procs.filter((p) => p.name === normalizeAlName(t.method) && p.params === 0) ?? [];
    const [decl] = decls;
    if (decl === undefined || decls.length > 1) {
      errors.push(
        `${label} (codeunit ${t.codeunitId}) was discovered but the parser found it ${decls.length} time(s) as a parameterless procedure`,
      );
      continue;
    }
    const st: TestState = {
      visited: new Set(),
      reached: new Set(),
      unresolvedTargets: new Set(),
      problems: [],
      reason: undefined,
    };
    scanner.walk(decl, [], st);
    for (const u of st.reached) {
      if (u.damaged)
        errors.push(`${label} reaches ${u.display} (${u.file}), which does not parse cleanly`);
      for (const p of u.problems) errors.push(`${label}: ${p}`);
    }
    for (const p of st.problems) errors.push(`${label}: ${p}`);
    if (st.unresolvedTargets.size > 0 && suspect.length > 0) {
      errors.push(
        `${label} calls ${[...st.unresolvedTargets].join(", ")}, not found in the test app, while the test app has parse errors that could hide it (${suspect.join(", ")})`,
      );
    }
    if (st.reason !== undefined) refused.set(testKeyOf(t), st.reason);
  }
  return { refused, errors: [...new Set(errors)] };
}

export function scanTestPageSources(
  files: ReadonlyArray<{ path: string; text: string }>,
  tests: readonly TestMethodRef[],
): ReadonlyMap<string, string> {
  const { refused, errors } = analyzeTestPageSources(files, tests);
  if (errors.length > 0) throw new TestPageScanError(errors);
  return refused;
}

export async function readTestAppSources(
  testDir: string,
): Promise<Array<{ path: string; text: string }>> {
  const entries = await readdir(testDir, { recursive: true });
  const alFiles = entries.filter((e) => e.toLowerCase().endsWith(".al")).sort();
  return Promise.all(
    alFiles.map(async (path) => ({ path, text: await readFile(join(testDir, path), "utf8") })),
  );
}

export async function scanTestPageTests(
  testDir: string,
  tests: readonly TestMethodRef[],
): Promise<ReadonlyMap<string, string>> {
  await initParser();
  return scanTestPageSources(await readTestAppSources(testDir), tests);
}
