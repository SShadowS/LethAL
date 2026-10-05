// R-389 offline cost probe (r2). Product code is NOT changed: the product's walk (walkTest,
// subscriberFold) runs as is, and the private `argHolds` is wrapped at runtime to see every
// argument the R-371 ruling reads (a test-app value handed to external or platform code).
// For every Variant / RecordRef / FieldRef / Interface argument it sees, the source of the value
// is classified under the R-389 rule, by reading the passing procedure's own assignments.
// r2 (review claude-adversary-r1 #1): also every HAND-OUT through a `var` parameter or a return
// value, in every procedure external code can call ("entries"): the [EventSubscriber] procedures
// and every procedure and trigger of an enum's implementation codeunit (both folded into every
// digest), and every procedure and trigger of a codeunit the new folds take in (class b / bi),
// to a fixpoint. Limit: argument sites INSIDE a newly folded codeunit are not re-walked through
// the product's argHolds (the probe does not change the product walk); the count of such units
// is printed, so a zero says the limit did not matter.
// Prints names and counts only, never AL source (the repo is PUBLIC).
// Usage: bun scripts/r389-probe/measure/r389-probe.ts <label> <test-dir> [--sites]
// Self-check: run it on scripts/r389-probe/measure/synth (every class must be found).
// Copy of /coord/handoff/R-389/r389-probe.ts (the path the owner question names), committed so the
// gated DC / do-rel2 measurement can be re-run from any checkout.
import {
  type ALSyntaxNode,
  initParser,
  normalizeAlName,
  parseAL,
  visit,
  wrapRoot,
} from "../../../packages/engine/src/index";
import { discoverTests } from "../../../packages/runner/src/discovery";
import { subscriberFold, walkTest } from "../../../packages/runner/src/test-digest";
import {
  type Proc,
  type ReachState,
  Scanner,
  type Unit,
  buildTestAppModel,
  readTestAppSources,
} from "../../../packages/runner/src/testpage-scan";

const [label, dir, flag] = process.argv.slice(2);
if (label === undefined || dir === undefined) throw new Error("usage: probe.ts <label> <dir>");
const showSites = flag === "--sites";
await initParser();
const files = await readTestAppSources(dir);
const model = buildTestAppModel(files);
const scanner = new Scanner(model);
// biome-ignore lint/suspicious/noExplicitAny: runtime access to private members, probe only
const S = scanner as any;

// ---- AST facts per procedure, keyed file|name|params (unioned over overloads and #if arms) ----
type Rv =
  | { k: "name"; name: string }
  | { k: "value" }
  | { k: "member"; recv: Rv; member: string; args: number }
  | { k: "call"; name: string; args: number; inWith: boolean }
  | { k: "index"; base: Rv }
  | { k: "opaque"; kind: string };
interface Facts {
  params: Set<string>;
  varParams: Map<string, string>; // r2: `var` parameter name -> declared type text
  assigns: Map<string, Rv[]>; // lhs root name -> every rhs
  elemAssigns: Set<string>; // `V[i] := ...`
  foreachVars: Set<string>;
  passed: Map<string, Array<{ callee: string; args: number; at: number }>>;
  exits: Rv[]; // r2: every `exit(<value>)`
  retName: string | undefined; // r2: the named return value
}
const VALUE =
  /^(?:string_literal|integer|decimal|boolean|date_literal|time_literal|datetime_literal|qualified_enum_value|database_reference|(?:additive|multiplicative|unary|comparison|logical|relational|equality|binary|in|range)_expression)$/;
const NAMES = new Set(["identifier", "quoted_identifier", "keyword_identifier"]);
function rv(n: ALSyntaxNode): Rv {
  if (NAMES.has(n.rawKind)) return { k: "name", name: n.text };
  if (VALUE.test(n.rawKind)) return { k: "value" };
  if (n.rawKind === "parenthesized_expression") {
    const [i] = n.namedChildren;
    return i === undefined ? { k: "opaque", kind: n.rawKind } : rv(i);
  }
  if (n.rawKind === "subscript_expression") {
    const b = n.childForFieldName("object");
    return b === null ? { k: "opaque", kind: n.rawKind } : { k: "index", base: rv(b) };
  }
  if (n.rawKind === "member_expression") {
    const [r, m] = n.namedChildren;
    if (r === undefined || m === undefined) return { k: "opaque", kind: n.rawKind };
    return { k: "member", recv: rv(r), member: m.text, args: 0 };
  }
  if (n.rawKind === "call_expression") {
    const fn = n.childForFieldName("function");
    const list = n.namedChildren.find((c) => c.rawKind === "argument_list");
    const args = list === undefined ? 0 : list.namedChildren.length;
    if (fn !== null && NAMES.has(fn.rawKind))
      return { k: "call", name: fn.text, args, inWith: false };
    if (fn !== null && fn.rawKind === "member_expression") {
      const i = rv(fn);
      if (i.k === "member") return { ...i, args };
    }
  }
  return { k: "opaque", kind: n.rawKind };
}
const facts = new Map<string, Facts>();
const varPositions = new Map<string, Set<number>>(); // procName|args -> var param positions (any unit)
const implementsOf = new Map<string, Set<string>>(); // interface name -> test-app codeunits
const ifaceExtends = new Map<string, Set<string>>(); // interface -> what it extends
const norm = (s: string): string => normalizeAlName(s.trim().replace(/^"|"$/g, ""));
for (const f of files) {
  const root = wrapRoot(parseAL(f.text));
  visit(root, (n) => {
    if (n.rawKind === "codeunit_declaration") {
      const name = n.childForFieldName("object_name")?.text ?? "";
      for (const c of n.namedChildren)
        if (c.rawKind === "implements_clause")
          for (const i of c.namedChildren)
            if (i.fieldName === "interface") {
              const k = norm(i.text);
              const set = implementsOf.get(k) ?? new Set();
              set.add(norm(name));
              implementsOf.set(k, set);
            }
    }
    if (n.rawKind === "interface_declaration") {
      const name = norm(n.childForFieldName("object_name")?.text ?? "");
      for (const c of n.namedChildren)
        if (c.fieldName === "extends_interface") {
          const set = ifaceExtends.get(name) ?? new Set();
          set.add(norm(c.text));
          ifaceExtends.set(name, set);
        }
    }
    if (n.rawKind !== "procedure" && n.rawKind !== "trigger_declaration") return;
    const nm = n.childForFieldName("name") ?? n.namedChildren.find((c) => NAMES.has(c.rawKind));
    if (nm === undefined || nm === null) return;
    const plist = n.namedChildren.find((c) => c.rawKind === "parameter_list");
    const prms = plist?.namedChildren.filter((c) => c.rawKind === "parameter") ?? [];
    const key = `${f.path}|${normalizeAlName(nm.text)}|${prms.length}`;
    const fx: Facts = facts.get(key) ?? {
      params: new Set(),
      varParams: new Map(),
      assigns: new Map(),
      elemAssigns: new Set(),
      foreachVars: new Set(),
      passed: new Map(),
      exits: [],
      retName: undefined,
    };
    facts.set(key, fx);
    const rn = n.childForFieldName("return_value");
    if (rn !== null) fx.retName = normalizeAlName(rn.text);
    const vp = varPositions.get(`${normalizeAlName(nm.text)}|${prms.length}`) ?? new Set<number>();
    varPositions.set(`${normalizeAlName(nm.text)}|${prms.length}`, vp);
    for (const [i, p] of prms.entries()) {
      const pn = p.childForFieldName("name");
      if (pn !== null) fx.params.add(normalizeAlName(pn.text));
      if (p.childForFieldName("modifier") !== null) {
        vp.add(i);
        if (pn !== null)
          fx.varParams.set(normalizeAlName(pn.text), p.childForFieldName("type")?.text ?? "");
      }
    }
    const block = n.namedChildren.find((c) => c.rawKind === "code_block");
    if (block === undefined) return;
    visit(block, (x) => {
      if (x.rawKind === "exit_statement") {
        const v = x.childForFieldName("return_value");
        if (v !== null) fx.exits.push(rv(v));
      } else if (x.rawKind === "assignment_statement") {
        const l = x.childForFieldName("left");
        const r = x.childForFieldName("right");
        if (l === null || r === null) return;
        if (NAMES.has(l.rawKind)) {
          const k = normalizeAlName(l.text);
          const list = fx.assigns.get(k) ?? [];
          list.push(rv(r));
          fx.assigns.set(k, list);
        } else if (l.rawKind === "subscript_expression") {
          const b = l.childForFieldName("object");
          if (b !== null && NAMES.has(b.rawKind)) fx.elemAssigns.add(normalizeAlName(b.text));
        }
      } else if (x.rawKind === "foreach_statement") {
        const v = x.childForFieldName("variable");
        if (v !== null) fx.foreachVars.add(normalizeAlName(v.text));
      } else if (x.rawKind === "call_expression") {
        const fn = x.childForFieldName("function");
        const list = x.namedChildren.find((c) => c.rawKind === "argument_list");
        const args = list?.namedChildren ?? [];
        let callee: string | undefined;
        if (fn !== null && NAMES.has(fn.rawKind)) callee = fn.text;
        else if (fn !== null && fn.rawKind === "member_expression")
          callee = fn.namedChildren[1]?.text;
        if (callee === undefined) return;
        for (const [at, a] of args.entries()) {
          if (!NAMES.has(a.rawKind)) continue;
          const k = normalizeAlName(a.text);
          const list2 = fx.passed.get(k) ?? [];
          list2.push({ callee: normalizeAlName(callee), args: args.length, at });
          fx.passed.set(k, list2);
        }
      }
    });
  });
}
// Interface -> every test-app codeunit implementing it, or an interface extending it (transitive).
const extendedBy = new Map<string, Set<string>>();
for (const [child, parents] of ifaceExtends)
  for (const par of parents) extendedBy.set(par, (extendedBy.get(par) ?? new Set()).add(child));
function implUnits(raw: string): Unit[] {
  const out = new Set<Unit>();
  const seen = new Set<string>();
  const go = (i: string): void => {
    if (seen.has(i)) return;
    seen.add(i);
    for (const c of implementsOf.get(i) ?? [])
      for (const u of S.unitsNamed(`"${c}"`) as Unit[]) out.add(u);
    for (const ch of extendedBy.get(i) ?? []) go(ch);
  };
  go(norm(raw.split(".").pop() ?? raw));
  return [...out];
}

// ---- classification under the R-389 rule ----
// a: record only (today's table fold covers it)    b: test-app codeunit (fold it)
// bi: interface (fold its test-app implementations)    bo: other test-app object (page/report/...)
// c:*: untraceable -> safe fallback                 d: nothing test-app (value, external object)
// Every b / bi adds the codeunits to fold to `collect` (r2: their procedures become entries).
const VARIANT = /^\s*variant\s*$/i;
const RECREF = /^\s*(recordref|fieldref)\b/i;
const IFACE = /^\s*interface\s+(.+?)\s*$/i;
const ARRAY = /^\s*array\s*\[[^\]]*\]\s*of\s+([\s\S]*)$/i;
const COLL = /^\s*(?:list|dictionary)\s+of\s*\[([\s\S]*)\]\s*$/i;
const OBJ = /^\s*(page|report|query|xmlport|testpage)\s+(.+?)\s*$/i;
const KIND: Record<string, string> = {
  page: "page",
  testpage: "page",
  report: "report",
  query: "query",
  xmlport: "xmlport",
};
const holdsVariant = (t: string): boolean => {
  const inner = ARRAY.exec(t)?.[1] ?? t;
  if (VARIANT.test(inner) || RECREF.test(inner)) return true;
  const e = COLL.exec(inner)?.[1];
  return e !== undefined && /\bvariant\b|\brecordref\b|\bfieldref\b/i.test(e);
};
let collect = new Set<Unit>();

function classifyType(
  p: Proc,
  t: string,
  viaName: string | undefined,
  depth: number,
  seen: Set<string>,
): string[] {
  const inner = ARRAY.exec(t)?.[1] ?? t;
  if (/^\s*record\b/i.test(inner) || RECREF.test(inner)) return ["a"];
  if (VARIANT.test(inner)) {
    if (viaName === undefined) return ["c:variant-return"];
    return classifyVar(p, viaName, depth + 1, seen, false);
  }
  const im = IFACE.exec(inner);
  if (im?.[1] !== undefined) {
    for (const u of implUnits(im[1])) collect.add(u);
    return ["bi"];
  }
  if (/^\s*codeunit\b/i.test(inner)) {
    const us = scanner.unitsFor(inner);
    for (const u of us) collect.add(u);
    return us.length > 0 ? ["b"] : ["d"];
  }
  const m = OBJ.exec(inner);
  if (m?.[1] !== undefined && m[2] !== undefined)
    return S.objectsNamed(KIND[m[1].toLowerCase()] ?? m[1], m[2]).length > 0 ? ["bo"] : ["d"];
  if (COLL.test(inner)) return holdsVariant(inner) ? ["c:collection-element"] : ["d"];
  return ["d"];
}

function classifyRv(p: Proc, r: Rv, depth: number, seen: Set<string>): string[] {
  if (r.k === "value") return ["d"];
  if (r.k === "opaque") return [`c:shape-${r.kind}`];
  if (r.k === "name" && normalizeAlName(r.name) === "this") {
    // r2 (review #2): `this` outside a codeunit is class c, the fallback.
    if (p.unit.kind !== "codeunit") return ["c:this-noncodeunit"];
    collect.add(p.unit);
    return ["b"];
  }
  if (r.k === "call" && !S.procNames.has(normalizeAlName(r.name))) return ["d"]; // built-in
  const types = S.typesOf(p, r);
  if (typeof types === "string") return ["c:unknown-type"];
  if (types.length === 0) return ["d"];
  const out: string[] = [];
  for (const t of types as string[]) {
    if (r.k === "index" && /\bvariant\b/i.test(t)) out.push("c:collection-element");
    else out.push(...classifyType(p, t, r.k === "name" ? r.name : undefined, depth, seen));
  }
  return out;
}

const factsOf = (p: Proc): Facts | undefined => facts.get(`${p.unit.file}|${p.name}|${p.params}`);

// `rootParam`: the name is the hand-out's own `var` parameter (r2), so being a parameter is not
// by itself "cannot see"; what is assigned to it is traced like a local.
function classifyVar(
  p: Proc,
  raw: string,
  depth: number,
  seen: Set<string>,
  rootParam: boolean,
): string[] {
  const k = normalizeAlName(raw);
  if (seen.has(k) || depth > 6) return ["c:cycle"];
  seen.add(k);
  const fx = factsOf(p);
  if (fx === undefined) return ["c:no-facts"];
  if (fx.params.has(k) && !rootParam) return ["c:parameter"];
  if (!p.scope.has(k)) return ["c:global"];
  const out: string[] = [];
  if (fx.foreachVars.has(k)) out.push("c:foreach");
  if (fx.elemAssigns.has(k)) out.push("c:element-assigned");
  for (const use of fx.passed.get(k) ?? []) {
    // Handed to a test-app procedure whose parameter at that position is `var`: set there.
    if (varPositions.get(`${use.callee}|${use.args}`)?.has(use.at)) out.push("c:var-argument");
  }
  for (const r of fx.assigns.get(k) ?? []) out.push(...classifyRv(p, r, depth, seen));
  if (out.length === 0) out.push("d:unassigned");
  return out;
}

// ---- r2: hand-outs through a `var` parameter or a return value, in an entry procedure ----
interface HandOut {
  proc: Proc;
  what: string; // `var <name>` or `return`
  argType: "variant" | "interface" | "recref";
  classes: string[];
}
function handOutsOf(p: Proc): HandOut[] {
  const fx = factsOf(p);
  if (fx === undefined) return [];
  const out: HandOut[] = [];
  const byType = (t: string, viaVar: string | undefined, what: string): void => {
    const isArr = ARRAY.test(t);
    const inner = ARRAY.exec(t)?.[1] ?? t;
    const elem = COLL.exec(inner)?.[1];
    const im = IFACE.exec(elem ?? inner);
    if (im?.[1] !== undefined) {
      // An Interface I hand-out can hold only an implementation of I: fold them all, no tracing.
      // With no test-app implementation of I there is nothing to fold: the digest is unchanged.
      const impls = implUnits(im[1]);
      for (const u of impls) collect.add(u);
      out.push({ proc: p, what, argType: "interface", classes: [impls.length > 0 ? "bi" : "bi:none"] });
    } else if (RECREF.test(elem ?? inner))
      out.push({ proc: p, what, argType: "recref", classes: ["a"] });
    else if (VARIANT.test(inner)) {
      let classes: string[];
      if (isArr) classes = ["c:array-variable"];
      else if (viaVar !== undefined) classes = classifyVar(p, viaVar, 0, new Set(), true);
      else {
        // An unnamed return value: every `exit(<value>)`.
        classes = fx.exits.flatMap((r) => classifyRv(p, r, 0, new Set()));
        if (classes.length === 0) classes = ["d:unassigned"];
      }
      out.push({ proc: p, what, argType: "variant", classes });
    } else if (elem !== undefined && /\bvariant\b/i.test(elem))
      out.push({ proc: p, what, argType: "variant", classes: ["c:collection-element"] });
  };
  for (const [name, t] of fx.varParams) byType(t, name, `var ${name}`);
  if (p.returnType !== undefined) {
    if (fx.retName !== undefined) {
      byType(p.returnType, fx.retName, "return");
      // A named return value can also be set by `exit(<value>)`.
      const last = out[out.length - 1];
      if (
        last !== undefined &&
        last.what === "return" &&
        last.argType === "variant" &&
        fx.exits.length > 0
      ) {
        last.classes = [
          ...last.classes.filter((c) => c !== "d:unassigned"),
          ...fx.exits.flatMap((r) => classifyRv(p, r, 0, new Set())),
        ];
      }
    } else byType(p.returnType, undefined, "return");
  }
  return out;
}

/** Entries reachable from `units` (folded whole): their hand-outs, to a fixpoint. */
function entryClosure(
  roots: readonly Proc[],
  units: Iterable<Unit>,
  done: Set<Unit>,
): { hand: HandOut[]; folded: Set<Unit> } {
  const hand: HandOut[] = [];
  const folded = new Set<Unit>();
  const queue = [...units];
  const prev = collect;
  collect = new Set();
  for (const p of roots) hand.push(...handOutsOf(p));
  queue.push(...collect);
  while (queue.length > 0) {
    const u = queue.pop();
    if (u === undefined || done.has(u) || folded.has(u)) continue;
    folded.add(u);
    collect = new Set();
    for (const p of [...u.procs, ...u.triggers]) hand.push(...handOutsOf(p));
    queue.push(...collect);
  }
  collect = prev;
  return { hand, folded };
}

// ---- hook the product's argument reading ----
interface Ev {
  owner: string;
  proc: Proc;
  arg: string; // the variable name, or the shape
  argType: "variant" | "recref" | "interface" | "variant-shape";
  classes: string[];
  targets: Unit[]; // r2: codeunits a b / bi class folds
}
let owner = "closure";
const seenEv = new Set<string>();
const events = new Map<ReachState, Ev[]>();
const orig = S.argHolds.bind(scanner);
S.argHolds = (p: Proc, r: Rv, st: ReachState): string | undefined => {
  const push = (e: Omit<Ev, "owner" | "proc" | "targets">, targets: Unit[] = []): void => {
    const id = `${owner}|${p.key}|${e.arg}`;
    if (seenEv.has(id)) return;
    seenEv.add(id);
    const list = events.get(st) ?? [];
    list.push({ owner, proc: p, ...e, targets });
    events.set(st, list);
  };
  if (r.k === "name" && normalizeAlName(r.name) !== "this") {
    const k = normalizeAlName(r.name);
    const types: string[] = p.scope.get(k) ?? p.unit.globals.get(k) ?? p.unit.implicit.get(k) ?? [];
    const inner = types.map((t) => ARRAY.exec(t)?.[1] ?? t);
    if (inner.some((t) => VARIANT.test(t))) {
      collect = new Set();
      const classes = ARRAY.test(types[0] ?? "")
        ? ["c:array-variable"]
        : classifyVar(p, r.name, 0, new Set(), false);
      push({ arg: r.name, argType: "variant", classes }, [...collect]);
    } else if (inner.some((t) => RECREF.test(t)))
      push({ arg: r.name, argType: "recref", classes: ["a"] });
    // An Interface variable handed out directly: the fallback today and under R-389 (unchanged).
    else if (inner.some((t) => IFACE.test(t)))
      push({ arg: r.name, argType: "interface", classes: ["c:iface-direct-today"] });
  } else if (r.k === "index" || r.k === "member" || r.k === "call") {
    // A Variant reached through an element or a return: today folds nothing at all (R-371 reads
    // HOLDS_RECORD on a plain name only).
    let types: string[] | string = [];
    if (r.k === "index") types = S.typesOf(p, r.base);
    else if (r.k === "member") {
      // The member's return, or a built-in member of a Variant collection (`L.Get(1)`).
      const own = S.typesOf(p, r);
      const recv = S.typesOf(p, r.recv);
      types = [
        ...(typeof own === "string" ? [] : own),
        ...(typeof recv === "string"
          ? []
          : recv.filter((t: string) => ARRAY.test(t) || COLL.test(t))),
      ];
    } else if (S.procNames.has(normalizeAlName(r.name))) types = S.typesOf(p, r);
    if (typeof types !== "string" && types.some((t) => holdsVariant(t)))
      push({ arg: `<${r.k}>`, argType: "variant-shape", classes: ["c:element-or-return"] });
  }
  return orig(p, r, st);
};

const tests = await discoverTests(dir);
const fold = subscriberFold(scanner, model);
const closureEv = events.get(fold.reached) ?? [];
const closureFallbackToday = fold.fallback !== undefined;
type Worst = "fallback" | "fold" | "same";
const worst = (cs: string[]): Worst =>
  cs.some((c) => c.startsWith("c:"))
    ? "fallback"
    : cs.some((c) => c === "b" || c === "bi" || c === "bo")
      ? "fold"
      : "same";
// r2: the closure's entries: every [EventSubscriber] procedure, every procedure and trigger of an
// enum's implementation codeunit, and (through `entryClosure`) every codeunit a b / bi there folds.
const subscriberEntries = model.units.flatMap((u) => u.procs.filter((p) => p.subscriber));
const implCodeunits = model.objects.flatMap((o) =>
  o.implementations.flatMap((raw) => S.unitsNamed(raw) as Unit[]),
);
const closureArgTargets = closureEv.flatMap((e) => e.targets);
const closureEntry = entryClosure(
  subscriberEntries,
  [...implCodeunits, ...closureArgTargets],
  new Set(),
);
const closureHand = closureEntry.hand;
const closureClasses = [
  ...closureEv.flatMap((e) => e.classes),
  ...closureHand.flatMap((h) => h.classes),
];
const closureNew = worst(closureClasses);
// Does the closure already fold every test-app table? (An `a` there costs nothing new then.)
const closureTablesToday = closureEv.some((e) => e.argType === "recref" || e.argType === "variant");
const closureGainsTables = !closureTablesToday && closureHand.some((h) => h.classes.includes("a"));

let trig = 0;
let trigVariant = 0;
let trigIface = 0;
let todayFb = 0;
const outcome = { same: 0, fold: 0, fallback: 0 };
const outcomeR1 = { same: 0, fold: 0, fallback: 0 };
let newFb = 0;
let newFoldOnly = 0;
let newFbR1 = 0;
let newFoldOnlyR1 = 0;
let testsWithFoldHandOuts = 0;
const siteClasses = new Map<string, number>();
const sites = new Map<string, Ev>();
const handSites = new Map<string, HandOut>();
const newFoldUnits = new Set<Unit>();
for (const t of tests) {
  owner = `${t.codeunitId}::${t.method}`;
  const st = walkTest(scanner, model, t);
  const ev = events.get(st) ?? [];
  const onFb = st.fallback !== undefined || closureFallbackToday;
  if (onFb) todayFb++;
  // r2: the codeunits this test's own b / bi sites fold, and their entries' hand-outs.
  const fx = entryClosure(
    [],
    ev.flatMap((e) => e.targets),
    closureEntry.folded,
  );
  for (const u of fx.folded) newFoldUnits.add(u);
  if (fx.hand.length > 0) testsWithFoldHandOuts++;
  for (const h of fx.hand) handSites.set(`${h.proc.key}|${h.what}`, h);
  const r1Classes = [...ev, ...closureEv].flatMap((e) => e.classes);
  const r2Classes = [
    ...r1Classes,
    ...closureHand.flatMap((h) => h.classes),
    ...fx.hand.flatMap((h) => h.classes),
  ];
  if (ev.length > 0) trig++;
  if (ev.some((e) => e.argType === "variant" || e.argType === "variant-shape")) trigVariant++;
  if (ev.some((e) => e.argType === "interface")) trigIface++;
  for (const e of ev) sites.set(`${e.proc.key}|${e.arg}`, e);
  const w1 = worst(r1Classes);
  const w2: Worst = closureGainsTables && worst(r2Classes) === "same" ? "fold" : worst(r2Classes);
  if (r1Classes.length > 0) outcomeR1[w1]++;
  if (r2Classes.length > 0 || w2 !== "same") outcome[w2]++;
  if (!onFb && w1 === "fallback") newFbR1++;
  if (!onFb && w1 === "fold") newFoldOnlyR1++;
  if (!onFb && w2 === "fallback") newFb++;
  if (!onFb && w2 === "fold") newFoldOnly++;
}
for (const e of [...sites.values(), ...closureEv]) {
  for (const c of new Set(e.classes))
    siteClasses.set(`${e.argType}:${c}`, (siteClasses.get(`${e.argType}:${c}`) ?? 0) + 1);
}
const count = (hs: Iterable<HandOut>): string => {
  const m = new Map<string, number>();
  for (const h of hs)
    for (const c of new Set(h.classes))
      m.set(`${h.argType}:${c}`, (m.get(`${h.argType}:${c}`) ?? 0) + 1);
  return (
    [...m]
      .sort()
      .map(([k, n]) => `${k} ${n}`)
      .join(", ") || "none"
  );
};
// Every entry procedure's `var` parameters and return of a hand-out type, before classing: how
// many such signatures exist at all in the closure's entries.
const pct = (n: number): string => ((100 * n) / Math.max(1, tests.length)).toFixed(1);
console.log(
  `${label}: ${tests.length} tests, ${model.units.length} codeunits, ${model.objects.length} other objects`,
);
console.log(
  `  today on whole-source fallback: ${todayFb}; subscriber closure on fallback today: ${closureFallbackToday}`,
);
console.log(
  `  [r1] closure argument sites: ${closureEv.length} (${closureEv.map((e) => `${e.argType}:${[...new Set(e.classes)].join("+")}`).join(", ") || "none"})`,
);
console.log(
  `  [r1] tests whose walk hands a Variant/RecordRef/FieldRef/Interface to external code: ${trig} (Variant ${trigVariant}, Interface ${trigIface})`,
);
console.log(`  [r1] distinct argument sites: ${sites.size}`);
console.log(
  `  [r1] site classes (argType:class -> sites): ${[...siteClasses]
    .sort()
    .map(([k, n]) => `${k} ${n}`)
    .join(", ")}`,
);
console.log(
  `  [r1] per affected test, worst class: same ${outcomeR1.same}, fold ${outcomeR1.fold}, fallback ${outcomeR1.fallback}`,
);
console.log(
  `  [r1] NEW whole-source fallback: ${newFbR1} of ${tests.length} (${pct(newFbR1)}%); newly wider by a fold only: ${newFoldOnlyR1}`,
);
console.log(
  `  [r2] closure entries: ${subscriberEntries.length} subscriber procedures, ${new Set(implCodeunits).size} enum implementation codeunits, ${closureEntry.folded.size} codeunits folded whole in all`,
);
console.log(
  `  [r2] closure hand-outs (var parameter / return, argType:class -> sites): ${count(closureHand)}; closure gains the table fold: ${closureGainsTables} (folds it today: ${closureTablesToday})`,
);
console.log(
  `  [r2] closure outcome under R-389 r2: ${closureClasses.length === 0 ? "unchanged" : closureNew}`,
);
console.log(
  `  [r2] per-test new folds: ${newFoldUnits.size} codeunits; tests with a hand-out in them: ${testsWithFoldHandOuts}; hand-out classes: ${count(handSites.values())}`,
);
console.log(
  `  [r2] per affected test, worst class: same ${outcome.same}, fold ${outcome.fold}, fallback ${outcome.fallback}`,
);
console.log(
  `  [r2] NEW whole-source fallback (not on it today): ${newFb} of ${tests.length} (${pct(newFb)}%); newly wider by a fold only: ${newFoldOnly}`,
);
const impls = [...implementsOf].map(([i, cs]) => `${i}:${cs.size}`);
console.log(
  `  test-app interface implementations: ${impls.length === 0 ? "none" : impls.join(", ")}; test-app interfaces extending another: ${ifaceExtends.size}`,
);
if (showSites) {
  for (const e of sites.values())
    console.log(
      `    site ${e.proc.display} arg ${e.arg} (${e.argType}) -> ${[...new Set(e.classes)].join("+")}`,
    );
  for (const h of closureHand)
    console.log(
      `    closure hand-out ${h.proc.display} ${h.what} (${h.argType}) -> ${[...new Set(h.classes)].join("+")}`,
    );
  for (const h of handSites.values())
    console.log(
      `    fold hand-out ${h.proc.display} ${h.what} (${h.argType}) -> ${[...new Set(h.classes)].join("+")}`,
    );
}
