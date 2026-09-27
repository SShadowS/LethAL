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

interface Unit {
  readonly file: string;
  readonly node: ALSyntaxNode;
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
  readonly node: ALSyntaxNode;
  readonly name: string; // normalised
  readonly display: string;
  readonly params: number;
  readonly scope: ReadonlyMap<string, string>; // parameters and locals, every name
}

function nameNode(n: ALSyntaxNode): ALSyntaxNode | undefined {
  return n.namedChildren.find((c) => NAME_KINDS.has(c.rawKind));
}

/** Every name of every `variable_declaration` under `section`, into `into`. */
function addDeclarations(
  section: ALSyntaxNode,
  into: Map<string, string>,
  where: string,
  problems: string[],
): void {
  visit(section, (d) => {
    if (d.rawKind !== "variable_declaration") return;
    const type = d.namedChildren.find((c) => c.rawKind === "type_specification")?.text ?? "";
    const names = d.namedChildren.filter((c) => NAME_KINDS.has(c.rawKind));
    if (names.length === 0 && PAGE_TYPE.test(type)) {
      problems.push(`${where}: a TestPage declaration whose name the scanner cannot read`);
    }
    for (const n of names) into.set(normalizeAlName(n.text), type);
  });
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
    node,
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
    const members = flattenPreproc(body.namedChildren);
    for (const c of members) {
      if (c.rawKind.endsWith("var_section"))
        addDeclarations(c, globals, `${display} globals`, problems);
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
      unitShell.procs.push({
        unit: unitShell,
        node: p,
        name: normalizeAlName(id2.text),
        display: `${display}.${id2.text}`,
        params: params.length,
        scope,
      });
    }
  }
  return unitShell;
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

  unitFor(typeText: string): Unit | undefined {
    const raw = CODEUNIT_TYPE.exec(typeText)?.[1];
    if (raw === undefined) return undefined;
    // A bare quoted name can itself contain a dot (`Codeunit "Lib.Pages"`), which is NOT a
    // namespace separator: try the WHOLE normalised name first (review round 2, #A).
    const whole = this.byName(normalizeAlName(raw));
    if (whole !== undefined) return whole;
    // A namespace-qualified reference (`Codeunit My.Tests."Lib"`) carries the namespace as leading
    // dotted segments OUTSIDE any quotes; the object itself is always the LAST such segment
    // (review round 1, #3). A quoted segment is kept whole even if it contains its own dot.
    const segments = raw.match(/"[^"]*"|[^.]+/g) ?? [raw];
    const last = segments[segments.length - 1] ?? raw;
    return this.byName(normalizeAlName(last));
  }

  private byName(want: string): Unit | undefined {
    return this.units.find((u) => String(u.id) === want || u.name === want);
  }

  walk(p: Proc, path: readonly string[], st: TestState): void {
    if (st.visited.has(p)) return;
    st.visited.add(p);
    st.reached.add(p.unit);
    const here = [...path, p.display];
    const block = p.node.namedChildren.find((c) => c.rawKind === "code_block");
    if (block === undefined) return;
    visit(block, (n) => this.visitNode(p, n, here, st));
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
   * genuinely bare call (`site` given), when it sits inside a `with` body: the scanner does not
   * resolve the with-target's own type, so an unresolved bare call there could be a call into that
   * codeunit instead (safety-first; review round 2, #B). `this.Name` never passes `site`, since an
   * explicit receiver is not ambiguous with a with-statement's implicit one.
   */
  private sameCodeunitCall(
    unit: Unit,
    rawName: string,
    args: number,
    path: readonly string[],
    st: TestState,
    site?: ALSyntaxNode,
  ): void {
    const matched = this.calls(unit, rawName, args, path, st);
    if (matched) return;
    if (OPENING_METHODS.has(normalizeAlName(rawName))) {
      st.reason ??= `${path.join(" -> ")} calls ${rawName} (unresolved same-codeunit call, safety-first)`;
      return;
    }
    if (site !== undefined && insideWithStatement(site)) {
      st.reason ??= `${path.join(" -> ")} calls ${rawName} inside a with-statement, unresolved in this codeunit (safety-first)`;
    }
  }

  private visitNode(p: Proc, n: ALSyntaxNode, path: readonly string[], st: TestState): void {
    if (n.rawKind === "call_expression") {
      const fn = n.childForFieldName("function");
      const args =
        n.namedChildren.find((c) => c.rawKind === "argument_list")?.namedChildren.length ?? 0;
      if (fn === null) return;
      if (NAME_KINDS.has(fn.rawKind)) this.sameCodeunitCall(p.unit, fn.text, args, path, st, n);
      else if (fn.rawKind === "member_expression") this.member(p, fn, args, path, st);
      return;
    }
    if (n.rawKind === "member_expression") {
      const parent = n.parent;
      const isCallee =
        parent !== null &&
        parent.rawKind === "call_expression" &&
        parent.childForFieldName("function")?.startIndex === n.startIndex;
      if (!isCallee) this.member(p, n, 0, path, st);
      return;
    }
    if (n.rawKind === "call_statement") {
      const id = nameNode(n);
      if (id !== undefined) this.sameCodeunitCall(p.unit, id.text, 0, path, st, n);
    }
  }

  private member(
    p: Proc,
    m: ALSyntaxNode,
    args: number,
    path: readonly string[],
    st: TestState,
  ): void {
    const [receiver, member] = m.namedChildren;
    if (receiver === undefined || member === undefined) return;
    if (!NAME_KINDS.has(receiver.rawKind)) {
      // A non-plain receiver (parenthesised, subscripted, chained, ...) cannot be resolved to a
      // declared name, so scope cannot be checked. Refuse only when the member itself is
      // opening-shaped: safety-first, never silently "not an edge" (review round 1, #4).
      if (OPENING_METHODS.has(normalizeAlName(member.text))) {
        st.reason ??= `${path.join(" -> ")} calls ${receiver.text}.${member.text} on an unresolved receiver`;
      }
      return;
    }
    const key = normalizeAlName(receiver.text);
    if (key === "this") {
      // `this` refers to the codeunit instance itself (review round 1, #1): not a declared name,
      // so it is never in scope/globals, and must not silently fall through as "not a TestPage".
      this.sameCodeunitCall(p.unit, member.text, args, path, st);
      return;
    }
    const type = p.scope.get(key) ?? p.unit.globals.get(key);
    if (type === undefined) {
      if (p.unit.pageNamesAnywhere.has(key)) {
        st.problems.push(
          `${p.display} uses ${receiver.text}, which matches a TestPage declaration the scanner cannot place in scope`,
        );
      }
      return;
    }
    if (PAGE_TYPE.test(type) && OPENING_METHODS.has(normalizeAlName(member.text))) {
      st.reason ??= `${path.join(" -> ")} calls ${receiver.text}.${member.text} on ${type.trim()}`;
      return;
    }
    if (!CODEUNIT_TYPE.test(type)) return;
    const target = this.unitFor(type);
    if (target === undefined) {
      st.unresolvedTargets.add(type.trim());
      return;
    }
    st.reached.add(target);
    this.calls(target, member.text, args, path, st);
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
    const errors = errorOffsets(tree.rootNode);
    const root = wrapRoot(tree);
    const objects = flattenPreproc(root.namedChildren).filter(
      (c) => c.rawKind.endsWith("_declaration") && c.rawKind !== "namespace_declaration",
    );
    for (const o of objects) {
      if (o.rawKind === "codeunit_declaration") units.push(buildUnit(f.path, o, errors));
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
        suspect.push(`${f.path} at offset ${e.startIndex}`);
      }
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
