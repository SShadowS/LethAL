/**
 * R-371 measurement only: a COPY of packages/runner/src/testpage-scan.ts's Scanner (which is not
 * exported), cut to the walk and instrumented. Not product code: nothing imports this but
 * measure.ts. Changes from the product walk, all marked "R-371":
 *   - r1: [HandlerFunctions] handlers of a walked procedure are walked too (the product walk does
 *     not follow them: "handler-driven pages" is a documented limit there);
 *   - r2: every call edge is classified FOLLOWED, EXTERNAL or UNFOLLOWED, fail closed (the case
 *     list is `UNFOLLOWED_KINDS` below and RESULTS.md "r2 re-measure");
 *   - r2: a bare call inside a with-statement is resolved through the with-targets' declared types;
 *   - r2: a codeunit's OnRun trigger is walked when the codeunit is run;
 *   - r2: non-codeunit test-app objects (tables, pages, extensions, ...) are collected, and a
 *     test's reached OBJECTS are recorded, not only its reached procedures;
 *   - the file/test driver (analyzeTestPageSources) is replaced by measure.ts.
 * The r1 version of this file is in commit eb250b2c.
 */
import {
  type ALSyntaxNode,
  normalizeAlName,
  type parseAL,
  visit,
  wrapRoot,
} from "../../packages/engine/src/index";

const CODEUNIT_TYPE = /^\s*codeunit\s+(.+?)\s*$/i;
const NAME_KINDS = new Set(["identifier", "quoted_identifier"]);
const TRIVIA = new Set([
  "comment",
  "multiline_comment",
  "pragma",
  "preproc_region",
  "preproc_endregion",
  "preproc_define",
  "preproc_undef",
]);
const realChildren = (n: ALSyntaxNode): ALSyntaxNode[] =>
  n.namedChildren.filter((c) => !TRIVIA.has(c.rawKind));
const PREPROC_BRANCH_MARKER = new Set([
  "preproc_if",
  "preproc_elif",
  "preproc_else",
  "preproc_endif",
]);

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

interface ErrorSite {
  readonly startIndex: number;
  readonly text: string;
}

function errorOffsets(root: ALSyntaxNode): ErrorSite[] {
  if (!root.hasError) return [];
  const out: ErrorSite[] = [];
  const walk = (n: ALSyntaxNode): void => {
    if (n.rawKind === "ERROR" || n.isMissing) out.push({ startIndex: n.startIndex, text: n.text });
    for (const c of n.children) walk(c);
  };
  walk(root);
  return out;
}

const SWALLOWS_CODEUNIT = /\bcodeunit\b/i;
const within = (off: number, n: ALSyntaxNode) => off >= n.startIndex && off <= n.endIndex;

/** R-371 r2: the target expressions of every with-statement enclosing `n`, innermost first. */
function withTargets(n: ALSyntaxNode): Recv[] {
  const out: Recv[] = [];
  let cur = n.parent;
  while (cur !== null) {
    if (cur.rawKind === "with_statement") {
      const r = cur.childForFieldName("record");
      out.push(r === null ? { k: "opaque", kind: "with_statement" } : toRecv(r));
    }
    if (cur.rawKind === "procedure" || cur.rawKind === "trigger_declaration") break;
    cur = cur.parent;
  }
  return out;
}

export type Site =
  | {
      readonly kind: "bare";
      readonly name: string;
      readonly args: number;
      /** R-371 r2: enclosing with-targets, innermost first; empty outside any with. */
      readonly withRecv: readonly Recv[];
      /** R-371 r2: the first argument's text, used only to read `Codeunit::X` and a subscriber variable. */
      readonly arg0: string | undefined;
    }
  | {
      readonly kind: "member";
      readonly recv: Recv;
      readonly receiver: string;
      readonly member: string;
      readonly args: number;
      readonly arg0: string | undefined;
    };

export type Recv =
  | { readonly k: "name"; readonly name: string }
  | { readonly k: "index"; readonly base: Recv }
  | { readonly k: "member"; readonly recv: Recv; readonly member: string; readonly args: number }
  | { readonly k: "call"; readonly name: string; readonly args: number; readonly inWith: boolean }
  | { readonly k: "either"; readonly options: readonly Recv[] }
  | { readonly k: "value" }
  | { readonly k: "opaque"; readonly kind: string };

const VALUE_KINDS =
  /^(?:string_literal|integer|decimal|boolean|date_literal|time_literal|datetime_literal|qualified_enum_value|database_reference|(?:additive|multiplicative|unary|comparison|logical|relational|equality|binary|in|range)_expression)$/;

function toRecv(n: ALSyntaxNode): Recv {
  if (NAME_KINDS.has(n.rawKind) || n.rawKind === "keyword_identifier")
    return { k: "name", name: n.text };
  if (VALUE_KINDS.test(n.rawKind)) return { k: "value" };
  switch (n.rawKind) {
    case "parenthesized_expression": {
      const [inner] = realChildren(n);
      return inner === undefined ? { k: "opaque", kind: n.rawKind } : toRecv(inner);
    }
    case "subscript_expression": {
      const base = n.childForFieldName("object");
      return base === null ? { k: "opaque", kind: n.rawKind } : { k: "index", base: toRecv(base) };
    }
    case "member_expression": {
      const [recv, name] = realChildren(n);
      if (recv === undefined || name === undefined) return { k: "opaque", kind: n.rawKind };
      return { k: "member", recv: toRecv(recv), member: name.text, args: 0 };
    }
    case "call_expression": {
      const fn = n.childForFieldName("function");
      const list = n.namedChildren.find((c) => c.rawKind === "argument_list");
      const args = list === undefined ? 0 : realChildren(list).length;
      if (fn !== null && NAME_KINDS.has(fn.rawKind))
        return { k: "call", name: fn.text, args, inWith: withTargets(n).length > 0 };
      if (fn !== null && fn.rawKind === "member_expression") {
        const inner = toRecv(fn);
        if (inner.k === "member") return { ...inner, args };
      }
      return { k: "opaque", kind: n.rawKind };
    }
    case "ternary_expression": {
      const a = n.childForFieldName("then_value");
      const b = n.childForFieldName("else_value");
      if (a === null || b === null) return { k: "opaque", kind: n.rawKind };
      return { k: "either", options: [toRecv(a), toRecv(b)] };
    }
    default:
      return { k: "opaque", kind: n.rawKind };
  }
}

const ARRAY_OF = /^\s*array\s*\[[^\]]*\]\s*of\s+([\s\S]*)$/i;

export interface Unit {
  readonly file: string;
  readonly id: number;
  readonly name: string;
  readonly display: string;
  readonly damaged: boolean;
  readonly globals: ReadonlyMap<string, readonly string[]>;
  readonly procs: readonly Proc[];
  /** R-371 r2: the codeunit's text length in characters. */
  readonly chars: number;
  /** R-371 r2: the codeunit's text matches `EventSubscriberInstance = Manual`. */
  readonly manualBinding: boolean;
}

export interface Proc {
  readonly unit: Unit;
  readonly handlers: readonly string[];
  readonly isTest: boolean;
  readonly isSubscriber: boolean;
  /** R-371 r2: a trigger (OnRun, ...) rather than a procedure. */
  readonly isTrigger: boolean;
  readonly sites: readonly Site[] | undefined;
  readonly name: string;
  readonly display: string;
  readonly params: number;
  readonly returnType: string | undefined;
  readonly scope: ReadonlyMap<string, readonly string[]>;
}

/** R-371 r2: a non-codeunit test-app object. `key` is `<kind>:<normalised name>`. */
export interface OtherObject {
  readonly key: string;
  readonly display: string;
  readonly kind: string;
  /** For an extension: `<base kind>:<normalised base name>`. */
  readonly extendsKey: string | undefined;
  readonly procs: ReadonlySet<string>;
  readonly procCount: number;
  /** Any code block in it (trigger or procedure) makes a call. */
  readonly hasCalls: boolean;
  readonly chars: number;
}

function nameNode(n: ALSyntaxNode): ALSyntaxNode | undefined {
  return n.namedChildren.find((c) => NAME_KINDS.has(c.rawKind));
}

function addType(into: Map<string, string[]>, name: string, type: string): void {
  const key = normalizeAlName(name);
  const list = into.get(key);
  if (list === undefined) into.set(key, [type]);
  else if (!list.includes(type)) list.push(type);
}

function addDeclarations(
  section: ALSyntaxNode,
  into: Map<string, string[]>,
  skipProcedures = false,
): void {
  const walk = (d: ALSyntaxNode): void => {
    if (skipProcedures && d.rawKind === "procedure") return;
    if (d.rawKind === "variable_declaration") {
      const type = d.namedChildren.find((c) => c.rawKind === "type_specification")?.text ?? "";
      for (const n of d.namedChildren.filter((c) => NAME_KINDS.has(c.rawKind)))
        addType(into, n.text, type);
    }
    for (const c of d.children) walk(c);
  };
  walk(section);
}

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
  const globals = new Map<string, string[]>();
  const text = node.text;
  const unitShell = {
    file,
    id,
    name: normalizeAlName(display),
    display,
    damaged: errors.some((e) => within(e.startIndex, node)),
    globals,
    procs: [] as Proc[],
    chars: text.length,
    manualBinding: /EventSubscriberInstance\s*=\s*Manual/i.test(text),
  };
  if (body !== undefined) {
    const members = flattenPreproc(body.namedChildren).flatMap((c) =>
      c.rawKind.endsWith("var_section") ? [c, ...procsInVarSection(c)] : [c],
    );
    for (const c of members) {
      if (c.rawKind.endsWith("var_section")) addDeclarations(c, globals, true);
    }
    for (const p of members) {
      const isTrigger = p.rawKind === "trigger_declaration";
      if (p.rawKind !== "procedure" && !isTrigger) continue;
      const id2 = nameNode(p);
      if (id2 === undefined) continue;
      const scope = new Map<string, string[]>();
      const plist = p.namedChildren.find((c) => c.rawKind === "parameter_list");
      const params = plist?.namedChildren.filter((c) => c.rawKind === "parameter") ?? [];
      for (const prm of params) {
        const n = nameNode(prm);
        const t = prm.namedChildren.find((c) => c.rawKind === "type_specification")?.text ?? "";
        if (n !== undefined) addType(scope, n.text, t);
      }
      const returnType = p.childForFieldName("return_type")?.text;
      const returnValue = p.childForFieldName("return_value");
      if (returnValue !== null && returnType !== undefined)
        addType(scope, returnValue.text, returnType);
      const vars = p.namedChildren.find((c) => c.rawKind === "var_section");
      if (vars !== undefined) addDeclarations(vars, scope);
      const block = p.namedChildren.find((c) => c.rawKind === "code_block");
      const attrs = isTrigger ? [] : attributesOf(p);
      const handlerText = attrs.find((t) => /^\[\s*HandlerFunctions\s*\(/i.test(t));
      const handlers =
        handlerText === undefined
          ? []
          : (/\(\s*'([^']*)'/.exec(handlerText)?.[1] ?? "")
              .split(",")
              .map((h) => normalizeAlName(h.trim()))
              .filter((h) => h.length > 0);
      unitShell.procs.push({
        unit: unitShell,
        handlers,
        isTest: attrs.some((t) => /^\[\s*Test\s*\]$/i.test(t)),
        isSubscriber: attrs.some((t) => /^\[\s*EventSubscriber\s*\(/i.test(t)),
        isTrigger,
        sites: block === undefined ? undefined : callSites(block),
        name: normalizeAlName(id2.text),
        display: `${display}.${id2.text}`,
        params: params.length,
        returnType,
        scope,
      });
    }
  }
  return unitShell;
}

function attributesOf(proc: ALSyntaxNode): string[] {
  const out: string[] = [];
  const siblings = proc.parent?.namedChildren ?? [];
  let i = siblings.findIndex((s) => s.startIndex === proc.startIndex);
  for (i -= 1; i >= 0; i -= 1) {
    const s = siblings[i];
    if (s === undefined) break;
    if (s.rawKind === "attribute_item") out.push(s.text.trim());
    else if (!TRIVIA.has(s.rawKind)) break;
  }
  return out;
}

function argInfo(n: ALSyntaxNode): { args: number; arg0: string | undefined } {
  const list = n.namedChildren.find((c) => c.rawKind === "argument_list");
  const real = list === undefined ? [] : realChildren(list);
  return { args: real.length, arg0: real[0]?.text.trim() };
}

function callSites(block: ALSyntaxNode): Site[] {
  const out: Site[] = [];
  const member = (m: ALSyntaxNode, args: number, arg0: string | undefined): void => {
    const [receiver, name] = realChildren(m);
    if (receiver === undefined || name === undefined) return;
    out.push({
      kind: "member",
      recv: toRecv(receiver),
      receiver: receiver.text,
      member: name.text,
      args,
      arg0,
    });
  };
  visit(block, (n) => {
    if (n.rawKind === "call_expression") {
      const fn = n.childForFieldName("function");
      const { args, arg0 } = argInfo(n);
      if (fn === null) return;
      if (NAME_KINDS.has(fn.rawKind))
        out.push({ kind: "bare", name: fn.text, args, withRecv: withTargets(n), arg0 });
      else if (fn.rawKind === "member_expression") member(fn, args, arg0);
      return;
    }
    if (n.rawKind === "member_expression") {
      const parent = n.parent;
      const isCallee =
        parent !== null &&
        parent.rawKind === "call_expression" &&
        parent.childForFieldName("function")?.startIndex === n.startIndex;
      if (!isCallee) member(n, 0, undefined);
      return;
    }
    if (n.rawKind === "call_statement") {
      const id = nameNode(n);
      if (id !== undefined)
        out.push({
          kind: "bare",
          name: id.text,
          args: 0,
          withRecv: withTargets(n),
          arg0: undefined,
        });
    }
  });
  return out;
}

/**
 * R-371 r2: the classifier's UNFOLLOWED cases. Any one of them sends the test to the broad fallback
 * (a whole-test-app digest). FOLLOWED and EXTERNAL are the only other outcomes; see RESULTS.md.
 */
export const UNFOLLOWED_KINDS = [
  "BindSubscription/UnbindSubscription",
  "object run by id or variable",
  "interface dispatch",
  "Variant receiver",
  "RecordRef/FieldRef trigger-capable call",
  "procedure in a non-codeunit test-app object",
  "trigger-capable call on a non-codeunit test-app object with code",
  "object declared nowhere visible",
  "receiver of unmodelled shape",
  "with-statement target of unknown type",
  "handler named but not found",
] as const;
export type UnfollowedKind = (typeof UNFOLLOWED_KINDS)[number];

export interface TestState {
  readonly visited: Set<Proc>;
  readonly reached: Set<Unit>;
  /** R-371 r2: non-codeunit test-app objects reached (by `OtherObject.key`). */
  readonly reachedOthers: Set<string>;
  readonly unfollowed: Map<UnfollowedKind, Set<string>>;
  readonly external: Map<string, Set<string>>;
  followed: number;
}

export function newState(): TestState {
  return {
    visited: new Set(),
    reached: new Set(),
    reachedOthers: new Set(),
    unfollowed: new Map(),
    external: new Map(),
    followed: 0,
  };
}

/** R-371 r2: which objects the test app's dependencies declare, keyed `<kind>:<name or id>`. */
export interface DependencyIndex {
  /** "symbols": read from .app symbol packages; "not-in-test-app": no packages, so any object the
   *  test app does not declare is taken to be a dependency's. */
  readonly mode: "symbols" | "not-in-test-app";
  readonly declared: ReadonlySet<string>;
}

const OBJ_TYPE =
  /^\s*(codeunit|record|page|report|query|xmlport|testpage|testrequestpage)\s+(.+?)(?:\s+temporary)?\s*$/i;
const KIND_OF: Readonly<Record<string, string>> = {
  codeunit: "codeunit",
  record: "table",
  page: "page",
  testpage: "page",
  report: "report",
  testrequestpage: "report",
  query: "query",
  xmlport: "xmlport",
};
const RUN_ROOTS = new Set(["codeunit", "page", "report", "xmlport", "query"]);
const RUN_MEMBER = /^(run|execute|import|export|saveas|print|open|trap)/i;
const RECORD_TRIGGER = new Set([
  "insert",
  "modify",
  "delete",
  "deleteall",
  "modifyall",
  "validate",
  "rename",
]);

/** The object name a type or reference text ends in: the last dotted segment, quotes kept whole. */
export function lastSegment(raw: string): string {
  const segments = raw.trim().match(/"[^"]*"|[^.]+/g) ?? [raw];
  return normalizeAlName((segments[segments.length - 1] ?? raw).trim());
}

export class Scanner {
  private readonly byKey = new Map<string, Unit[]>();
  /** `<kind>:<name>` of an object -> the test-app objects declaring or extending it. */
  private readonly otherByBase = new Map<string, OtherObject[]>();

  constructor(
    units: readonly Unit[],
    others: ReadonlyMap<string, OtherObject>,
    private readonly deps: DependencyIndex,
  ) {
    for (const u of units) {
      for (const k of new Set([String(u.id), u.name])) {
        const list = this.byKey.get(k);
        if (list === undefined) this.byKey.set(k, [u]);
        else list.push(u);
      }
    }
    for (const o of others.values()) {
      for (const k of new Set([o.key, o.extendsKey ?? o.key])) {
        const list = this.otherByBase.get(k);
        if (list === undefined) this.otherByBase.set(k, [o]);
        else list.push(o);
      }
    }
  }

  unitsFor(typeText: string): Unit[] {
    const raw = CODEUNIT_TYPE.exec(typeText)?.[1];
    return raw === undefined ? [] : this.unitsNamed(raw);
  }

  private unitsNamed(raw: string): Unit[] {
    const segments = raw.match(/"[^"]*"|[^.]+/g) ?? [raw];
    const candidates = new Set<Unit>();
    if (segments.length === 1)
      for (const u of this.byKey.get(normalizeAlName(raw)) ?? []) candidates.add(u);
    const last = segments[segments.length - 1] ?? raw;
    for (const u of this.byKey.get(normalizeAlName(last)) ?? []) candidates.add(u);
    return [...candidates];
  }

  private depDeclares(kind: string, raw: string): boolean {
    return (
      this.deps.mode === "not-in-test-app" || this.deps.declared.has(`${kind}:${lastSegment(raw)}`)
    );
  }

  walk(p: Proc, path: readonly string[], st: TestState): void {
    if (st.visited.has(p)) return;
    st.visited.add(p);
    st.reached.add(p.unit);
    const here = [...path, p.display];
    for (const h of p.handlers) {
      let found = false;
      for (const c of p.unit.procs) {
        if (c.name === h && !c.isTrigger) {
          found = true;
          st.followed += 1;
          this.walk(c, here, st);
        }
      }
      if (!found) unfollowed(st, "handler named but not found", `${p.unit.display}.${h}`);
    }
    if (p.sites === undefined) return;
    for (const site of p.sites) {
      if (site.kind === "bare") this.bare(p, site, here, st);
      else this.member(p, site, here, st);
    }
  }

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
      if (!c.isTrigger && c.name === name && c.params === args) {
        matched = true;
        this.walk(c, path, st);
      }
    }
    return matched;
  }

  /** `X.Run()` on a test-app codeunit, or `Codeunit.Run(Codeunit::X)`: its OnRun trigger. */
  private runUnit(u: Unit, path: readonly string[], st: TestState): void {
    st.reached.add(u);
    for (const c of u.procs) if (c.isTrigger && c.name === "onrun") this.walk(c, path, st);
  }

  /**
   * A bare call. Matched in its own codeunit: FOLLOWED. Else BindSubscription: UNFOLLOWED. Else,
   * inside a with: resolved through every enclosing with-target's declared type (I4), UNFOLLOWED
   * when any target's type is unknown. Else a built-in function (Error, Format, ...): a bare name
   * with no procedure of that name in its own codeunit, outside any with, can only be a built-in.
   */
  private bare(
    p: Proc,
    site: Extract<Site, { kind: "bare" }>,
    path: readonly string[],
    st: TestState,
  ): void {
    if (this.calls(p.unit, site.name, site.args, path, st)) {
      st.followed += 1;
      return;
    }
    const nn = normalizeAlName(site.name);
    if (nn === "bindsubscription" || nn === "unbindsubscription") {
      unfollowed(st, "BindSubscription/UnbindSubscription", p.unit.display);
      return;
    }
    if (site.withRecv.length === 0) return;
    const types = this.resolveWith(p, site.withRecv);
    if (types === undefined) {
      unfollowed(st, "with-statement target of unknown type", `${p.display}: ${site.name}`);
      return;
    }
    for (const t of types) this.callOn(t, "(with)", site.name, site.args, undefined, path, st);
  }

  /** R-371 r2 (I4): every enclosing with-target's declared types, or undefined when any is unknown. */
  resolveWith(p: Proc, targets: readonly Recv[]): string[] | undefined {
    const out: string[] = [];
    for (const r of targets) {
      const t = this.typesOf(p, r);
      // A with-target is a declared variable: an empty type list is an undeclared name, unknown.
      if (typeof t === "string" || t.length === 0) return undefined;
      out.push(...t);
    }
    return out;
  }

  private member(
    p: Proc,
    site: Extract<Site, { kind: "member" }>,
    path: readonly string[],
    st: TestState,
  ): void {
    const { args, receiver, member, arg0 } = site;
    if (site.recv.k !== "name") {
      const types = this.typesOf(p, site.recv);
      if (typeof types === "string") {
        unfollowed(st, "receiver of unmodelled shape", types);
        return;
      }
      for (const t of types) this.callOn(t, receiver, member, args, arg0, path, st);
      return;
    }
    const key = normalizeAlName(site.recv.name);
    if (key === "this") {
      if (this.calls(p.unit, member, args, path, st)) st.followed += 1;
      return;
    }
    const types = p.scope.get(key) ?? p.unit.globals.get(key);
    if (types === undefined) {
      // An undeclared root is a type or system name. The only call edges from one are object runs.
      if (RUN_ROOTS.has(key) && RUN_MEMBER.test(member))
        this.objectRun(key, arg0, `${receiver}.${member}`, path, st);
      return;
    }
    for (const t of types) this.callOn(t, receiver, member, args, arg0, path, st);
  }

  /** `Codeunit.Run(Codeunit::X)` and friends: by name resolved; by id or variable UNFOLLOWED. */
  private objectRun(
    root: string,
    arg0: string | undefined,
    label: string,
    path: readonly string[],
    st: TestState,
  ): void {
    const m =
      arg0 === undefined ? null : /^(codeunit|page|report|xmlport|query)\s*::\s*(.+)$/i.exec(arg0);
    const kind = m?.[1]?.toLowerCase();
    const raw = m?.[2];
    if (kind === undefined || raw === undefined || kind !== root) {
      unfollowed(st, "object run by id or variable", label);
      return;
    }
    if (kind === "codeunit") {
      const us = this.unitsNamed(raw);
      if (us.length > 0) {
        for (const u of us) this.runUnit(u, path, st);
        st.followed += 1;
        return;
      }
    } else if (this.testAppObject(kind, raw, "run", label, st)) return;
    this.outside(kind, raw, label, st);
  }

  /**
   * A member on a variable of a non-codeunit test-app object (or a dependency object a test-app
   * extension extends). Returns true when it classified the edge; false when no test-app object
   * declares the base object, so it belongs to a dependency or to nothing visible.
   */
  private testAppObject(
    kind: string,
    raw: string,
    member: string,
    label: string,
    st: TestState,
  ): boolean {
    const os = this.otherByBase.get(`${kind}:${lastSegment(raw)}`);
    if (os === undefined) return false;
    for (const o of os) st.reachedOthers.add(o.key);
    const nm = normalizeAlName(member);
    if (os.some((o) => o.procs.has(nm))) {
      unfollowed(st, "procedure in a non-codeunit test-app object", `${raw.trim()}.${member}`);
      return true;
    }
    const triggerCapable = kind === "table" ? RECORD_TRIGGER.has(nm) : RUN_MEMBER.test(member);
    if (triggerCapable && os.some((o) => o.hasCalls)) {
      unfollowed(st, "trigger-capable call on a non-codeunit test-app object with code", label);
      return true;
    }
    if (os.some((o) => o.extendsKey === undefined)) {
      st.followed += 1;
      return true;
    }
    return false; // only extensions: the base object is a dependency's
  }

  private outside(kind: string, raw: string, label: string, st: TestState): void {
    if (this.depDeclares(kind, raw)) external(st, kind, raw.trim());
    else unfollowed(st, "object declared nowhere visible", `${label} (${kind} ${raw.trim()})`);
  }

  private callOn(
    rawType: string,
    receiver: string,
    member: string,
    args: number,
    arg0: string | undefined,
    path: readonly string[],
    st: TestState,
  ): void {
    const type = ARRAY_OF.exec(rawType)?.[1] ?? rawType;
    const nm = normalizeAlName(member);
    const label = `${receiver}.${member}`;
    if (/^\s*interface\b/i.test(type)) {
      unfollowed(st, "interface dispatch", type.trim());
      return;
    }
    if (/^\s*variant\s*$/i.test(type)) {
      // A Variant's own methods are type tests (IsRecord, IsDecimal, ...): not call edges.
      if (!/^is/i.test(member)) unfollowed(st, "Variant receiver", label);
      return;
    }
    if (/^\s*(recordref|fieldref)\b/i.test(type)) {
      if (RECORD_TRIGGER.has(nm))
        unfollowed(st, "RecordRef/FieldRef trigger-capable call", `${type.trim()}.${member}`);
      return;
    }
    const m = OBJ_TYPE.exec(type);
    const kw = m?.[1]?.toLowerCase();
    const raw = m?.[2];
    if (kw === undefined || raw === undefined) return; // a built-in type's method: not a call edge
    const kind = KIND_OF[kw] ?? kw;
    if (kind === "codeunit") {
      const targets = this.unitsNamed(raw);
      if (targets.length > 0) {
        for (const t of targets) {
          st.reached.add(t);
          if (!this.calls(t, member, args, path, st) && nm === "run") this.runUnit(t, path, st);
        }
        st.followed += 1;
        return;
      }
      this.outside("codeunit", raw, label, st);
      return;
    }
    if (this.testAppObject(kind, raw, member, label, st)) return;
    void arg0;
    this.outside(kind, raw, label, st);
  }

  private typesOf(p: Proc, r: Recv): string[] | string {
    switch (r.k) {
      case "value":
        return [];
      case "opaque":
        return `a ${r.kind}`;
      case "name": {
        const key = normalizeAlName(r.name);
        if (key === "this") return [`Codeunit ${p.unit.id}`];
        return [...(p.scope.get(key) ?? p.unit.globals.get(key) ?? [])];
      }
      case "either": {
        const out: string[] = [];
        for (const o of r.options) {
          const t = this.typesOf(p, o);
          if (typeof t === "string") return t;
          out.push(...t);
        }
        return out;
      }
      case "index": {
        const base = this.typesOf(p, r.base);
        if (typeof base === "string") return base;
        return base.flatMap((t) => ARRAY_OF.exec(t)?.[1] ?? []);
      }
      case "call": {
        const name = normalizeAlName(r.name);
        const procs = p.unit.procs.filter(
          (c) => !c.isTrigger && c.name === name && c.params === r.args,
        );
        if (procs.length === 0) return r.inWith ? `${r.name}() inside a with-statement` : [];
        return procs.flatMap((c) => c.returnType ?? []);
      }
      case "member": {
        const recvTypes = this.typesOf(p, r.recv);
        if (typeof recvTypes === "string") return recvTypes;
        const name = normalizeAlName(r.member);
        const out: string[] = [];
        for (const t of recvTypes) {
          if (!CODEUNIT_TYPE.test(t)) continue;
          for (const u of this.unitsFor(t))
            for (const c of u.procs)
              if (
                !c.isTrigger &&
                c.name === name &&
                c.params === r.args &&
                c.returnType !== undefined
              )
                out.push(c.returnType);
        }
        return out;
      }
    }
  }
}

const OTHER_KIND = /^(\w+?)(extension)?_declaration$/;

export function scanFile(
  path: string,
  parsed: ReturnType<typeof parseAL>,
  units: Unit[],
  suspect: string[],
  others: Map<string, OtherObject>,
): void {
  const root = wrapRoot(parsed);
  const errors = errorOffsets(root);
  const objects = flattenPreproc(root.namedChildren).filter(
    (c) => c.rawKind.endsWith("_declaration") && c.rawKind !== "namespace_declaration",
  );
  for (const o of objects) {
    if (o.rawKind === "codeunit_declaration") {
      units.push(buildUnit(path, o, errors));
      continue;
    }
    const km = OTHER_KIND.exec(o.rawKind);
    const n = nameNode(o);
    if (km === null || n === undefined) continue;
    const base = km[1] ?? "";
    const isExt = km[2] !== undefined;
    const kind = isExt ? `${base}extension` : base;
    let extendsKey: string | undefined;
    if (isExt) {
      const kids = o.namedChildren;
      const at = kids.findIndex((c) => c.rawKind === "extends_keyword");
      const target = at >= 0 ? kids[at + 1] : undefined;
      if (target !== undefined) extendsKey = `${base}:${lastSegment(target.text)}`;
    }
    const procs = new Set<string>();
    let procCount = 0;
    let hasCalls = false;
    visit(o, (x) => {
      if (x.rawKind === "procedure") {
        procCount += 1;
        const pn = nameNode(x);
        if (pn !== undefined) procs.add(normalizeAlName(pn.text));
      }
      if (x.rawKind === "call_expression" || x.rawKind === "call_statement") hasCalls = true;
    });
    const key = `${kind}:${normalizeAlName(n.text.replace(/^"|"$/g, ""))}`;
    const had = others.get(key);
    others.set(key, {
      key,
      display: `${kind} ${n.text}`,
      kind,
      extendsKey,
      procs: had === undefined ? procs : new Set([...had.procs, ...procs]),
      procCount: (had?.procCount ?? 0) + procCount,
      hasCalls: (had?.hasCalls ?? false) || hasCalls,
      chars: (had?.chars ?? 0) + o.text.length,
    });
  }
  for (const e of errors) {
    const owner = objects.find((o) => within(e.startIndex, o));
    if (
      owner === undefined ||
      owner.rawKind === "codeunit_declaration" ||
      SWALLOWS_CODEUNIT.test(e.text)
    )
      suspect.push(`${path} at offset ${e.startIndex}`);
  }
}

function unfollowed(st: TestState, kind: UnfollowedKind, target: string): void {
  const set = st.unfollowed.get(kind);
  if (set === undefined) st.unfollowed.set(kind, new Set([target]));
  else set.add(target);
}

function external(st: TestState, kind: string, target: string): void {
  const set = st.external.get(kind);
  if (set === undefined) st.external.set(kind, new Set([target]));
  else set.add(target);
}
