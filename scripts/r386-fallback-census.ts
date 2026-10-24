#!/usr/bin/env bun
/**
 * R-386's census: for one test app, how many tests take the whole-source digest fallback, and
 * which SHAPE of unfollowed edge put each one there. Parse-only; no BC server. Output is counts,
 * shape ids and masked message templates, never AL source text (the input may be customer AL).
 *
 *   bun scripts/r386-fallback-census.ts <test-app-dir> <out.json>
 *
 * A test's reason is `walkTest(scanner, model, t).fallback`, else the app's `subscriberFold`
 * fallback (shape `subscriber-closure`, with the shape of the subscriber reason under
 * `subscriberShape`). The same method as /coord/handoff/R-431/digest-diff.ts `fallbacksWith`.
 *
 * The reason is classified by the message template of the `fallBack(st, ...)` site that built it
 * (packages/runner/src/testpage-scan.ts; the sites are named by function, not line). `R386` marks
 * the shapes R-386 still lists as open. Templates matched, as `shape-id: scan function`:
 *   parse-damage-subscriber: subscriberFold (test-digest.ts) "has parse damage"
 *   parse-damage-unit: reachUnit "does not parse cleanly"
 *   allobj-record-R390: reach "declares a Record <T>, whose object ids can be a test-app object's"
 *   handler-not-found: reach "handler H is named but not found in"
 *   parse-errors-hide-object: enterObject and outside "is not in the test app, which has parse errors"
 *   no-arity-match-own-object: reachOwn "which its object declares at no arity that matches"
 *   with-target-unknown: reachBare "inside a with-statement whose target's type is unknown"
 *   receiver-unmodelled-shape: reachMember "on a receiver of unmodelled shape"
 *   unknown-receiver: reachMember, reachBare-side "whose receiver's type is unknown"
 *   dynamic-object-run: objectRun "runs an object by id or through a variable"
 *   dynamic-codeunit-run: runById "runs a codeunit given by a variable or an expression"
 *   proc-no-arity: testAppObject "names a procedure of <kind> X at no arity it declares"
 *   non-plain-object-name: outside "names <kind> X, which is not one plain name"
 *   interface-dispatch: reachOn "dispatches through Interface"
 *   variant-method-call: reachOn "is called on a Variant"
 *   passesTestApp "L is handed W, a test-app object, by P" (W comes from argHolds), split on W:
 *     ref-handed-external (Kind::Name), this-handed-external (R386), unmodelled-arg-shape,
 *     unknown-arg-type, variant-container-element ("an element or a return of"),
 *     array-element and collection-element (R386; "an element of T", or a whole array/List/
 *     Dictionary variable), and, by the TYPE T of the variable ("N (T)" or "a value of T"):
 *     record-handed-external, page-var-handed-external, report-var-handed-external,
 *     xmlport-var-handed-external, query-var-handed-external (all R386), if-declaration (T is a
 *     plain Codeunit or Interface, so another arm of an `#if` declaration held a non-plain type;
 *     R386), variant-handed-external, other-handed-external.
 *   argHolds/handOutType "<why>: an array or collection of Variant, whose elements the walk cannot
 *     see": variant-container
 *   traceVariant (a Variant handed out; `<why>: ...`): variant-cycle ("is assigned in a cycle"),
 *     variant-global ("it can hold what the global"), variant-foreach, var-param-filled ("through
 *     a var parameter"), variant-from-collection ("from a collection")
 *   traceParam: variant-param-external-caller ("can be called from outside the test app"),
 *     variant-param-deep-chain, variant-param-caller-id ("passes N, a test-app X's id"),
 *     variant-param-unreached-caller ("passes Kind::Name"; R386)
 *   builtinArg: variant-unknown-type ("a value of unknown type (")
 *   traceValue: variant-assigned-unmodelled, variant-assigned-this ("assigned from this in a K";
 *     R386), variant-assigned-unresolved, variant-assigned-collection-element ("an element of"),
 *     variant-assigned-unknown-type, variant-assigned-variant, variant-assigned-array-or-collection
 *     ("an array or collection (T)", from holdType; R386)
 * Anything else goes under `unclassified` with its masked template, so nothing drops silently.
 * Limit: a message names only the FIRST non-plain type of an `#if` declaration, so a mixed
 * declaration is counted under that type's shape (or `if-declaration` when it is a plain one).
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { initParser } from "../packages/engine/src/index";
import { testsInAlSource } from "../packages/runner/src/discovery";
import { subscriberFold, walkTest } from "../packages/runner/src/test-digest";
import { Scanner, buildTestAppModel } from "../packages/runner/src/testpage-scan";

export interface ShapeRule {
  readonly id: string;
  readonly r386: boolean;
}

const typeShape = (t: string): ShapeRule => {
  if (/^\s*array\s*\[/i.test(t)) return { id: "array-element", r386: true };
  if (/^\s*(list|dictionary)\s+of\b/i.test(t)) return { id: "collection-element", r386: true };
  if (/^\s*(record|recordref|fieldref)\b/i.test(t))
    return { id: "record-handed-external", r386: true };
  if (/^\s*page\b/i.test(t)) return { id: "page-var-handed-external", r386: true };
  if (/^\s*report\b/i.test(t)) return { id: "report-var-handed-external", r386: true };
  if (/^\s*xmlport\b/i.test(t)) return { id: "xmlport-var-handed-external", r386: true };
  if (/^\s*query\b/i.test(t)) return { id: "query-var-handed-external", r386: true };
  if (/^\s*(codeunit|interface)\b/i.test(t)) return { id: "if-declaration", r386: true };
  if (/^\s*variant\b/i.test(t)) return { id: "variant-handed-external", r386: false };
  return { id: "other-handed-external", r386: false };
};

const handed = (what: string): ShapeRule => {
  if (/^\w+::/.test(what)) return { id: "ref-handed-external", r386: false };
  if (what === "this") return { id: "this-handed-external", r386: true };
  if (what.startsWith("an element or a return of "))
    return { id: "variant-container-element", r386: false };
  if (what.startsWith("an argument of a shape the walk"))
    return { id: "unmodelled-arg-shape", r386: false };
  if (what.startsWith("an argument of unknown type"))
    return { id: "unknown-arg-type", r386: false };
  const el = /^an element of (.*)$/s.exec(what);
  if (el?.[1] !== undefined) return typeShape(el[1]);
  const val = /^a value of (.*)$/s.exec(what);
  if (val?.[1] !== undefined) return typeShape(val[1]);
  const named = /^.* \(([^()]*)\)$/s.exec(what);
  return typeShape(named?.[1] ?? what);
};

const RULES: ReadonlyArray<readonly [RegExp, ShapeRule | ((m: RegExpExecArray) => ShapeRule)]> = [
  [
    /has parse damage, which can hide a subscriber codeunit/,
    { id: "parse-damage-subscriber", r386: false },
  ],
  [/does not parse cleanly/, { id: "parse-damage-unit", r386: false }],
  [/\(R390\)$/, { id: "allobj-record-R390", r386: false }],
  [/^handler .* is named but not found in /s, { id: "handler-not-found", r386: false }],
  [/which has parse errors that could hide it/, { id: "parse-errors-hide-object", r386: false }],
  [
    /which its object declares at no arity that matches/,
    { id: "no-arity-match-own-object", r386: false },
  ],
  [
    /inside a with-statement whose target's type is unknown/,
    { id: "with-target-unknown", r386: false },
  ],
  [/ on a receiver of unmodelled shape$/, { id: "receiver-unmodelled-shape", r386: false }],
  [/, whose receiver's type is unknown$/, { id: "unknown-receiver", r386: false }],
  [/ runs an object by id or through a variable$/, { id: "dynamic-object-run", r386: false }],
  [
    / runs a codeunit given by a variable or an expression$/,
    { id: "dynamic-codeunit-run", r386: false },
  ],
  [/ at no arity it declares$/, { id: "proc-no-arity", r386: false }],
  [
    /, which is not one plain name the test app's objects can be checked against$/,
    { id: "non-plain-object-name", r386: false },
  ],
  [/ dispatches through /, { id: "interface-dispatch", r386: false }],
  [/ is called on a Variant$/, { id: "variant-method-call", r386: false }],
  [/ is handed (.*), a test-app object, by /s, (m) => handed(m[1] ?? "")],
  [
    /: an array or collection of Variant, whose elements the walk cannot see$/,
    { id: "variant-container", r386: false },
  ],
  [/: .* is assigned in a cycle$/s, { id: "variant-cycle", r386: false }],
  [/: it can hold what the global /, { id: "variant-global", r386: false }],
  [/: .* is a foreach variable$/s, { id: "variant-foreach", r386: false }],
  [/: .* is filled by .* through a var parameter$/s, { id: "var-param-filled", r386: false }],
  [/: .* is filled by .* from a collection$/s, { id: "variant-from-collection", r386: false }],
  [
    /: .* is a parameter of .*, which can be called from outside the test app$/s,
    { id: "variant-param-external-caller", r386: false },
  ],
  [
    /: .* is passed down a chain of callers deeper than /s,
    { id: "variant-param-deep-chain", r386: false },
  ],
  [/: .* passes \d+, a test-app .*'s id$/s, { id: "variant-param-caller-id", r386: false }],
  [/: .* passes \w+::/s, { id: "variant-param-unreached-caller", r386: true }],
  [
    /: assigned from a shape the walk does not model /,
    { id: "variant-assigned-unmodelled", r386: false },
  ],
  [/: assigned from this in a /, { id: "variant-assigned-this", r386: true }],
  [
    /: assigned from .*, which the walk cannot resolve$/s,
    { id: "variant-assigned-unresolved", r386: false },
  ],
  [/: assigned from an element of /, { id: "variant-assigned-collection-element", r386: false }],
  [
    /: assigned from a value of unknown type \(/,
    { id: "variant-assigned-unknown-type", r386: false },
  ],
  [/: assigned from a value of Variant$/, { id: "variant-assigned-variant", r386: false }],
  [
    /: assigned from .*, an array or collection \(/s,
    { id: "variant-assigned-array-or-collection", r386: true },
  ],
  [/: a value of unknown type \(/, { id: "variant-unknown-type", r386: false }],
];

/** The shape of one fallback reason, or undefined when no template matches. */
export function classifyReason(why: string): ShapeRule | undefined {
  for (const [re, rule] of RULES) {
    const m = re.exec(why);
    if (m !== null) return typeof rule === "function" ? rule(m) : rule;
  }
  return undefined;
}

/** A reason with quoted names, dotted names and numbers masked, so equal templates group. */
export const maskTemplate = (why: string): string =>
  why
    .replace(/"[^"]*"/g, '"N"')
    .replace(/\S+\.\S+/g, "N")
    .replace(/\d+/g, "N");

const findAl = (app: string): string[] => {
  const files: string[] = [];
  const walk = (d: string, top: boolean): void => {
    if (!top && existsSync(join(d, "app.json"))) return;
    for (const e of readdirSync(d)) {
      if (e === ".alpackages" || e === ".git" || e === "node_modules") continue;
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p, false);
      else if (e.toLowerCase().endsWith(".al")) files.push(p);
    }
  };
  walk(app, true);
  return files.sort();
};

export async function census(app: string) {
  await initParser();
  const list = await Promise.all(
    findAl(app).map(async (p) => ({ path: relative(app, p), text: await Bun.file(p).text() })),
  );
  const model = buildTestAppModel(list);
  const scanner = new Scanner(model);
  const sub = subscriberFold(scanner, model).fallback;
  const subRule = sub === undefined ? undefined : classifyReason(sub);
  const tests = list.flatMap((f) => testsInAlSource(f.path, f.text));
  const shapes: Record<string, { tests: number; r386: boolean }> = {};
  const unclassified: Record<string, number> = {};
  let onFallback = 0;
  for (const t of tests) {
    const own = walkTest(scanner, model, t).fallback;
    const why = own ?? sub;
    if (why === undefined) continue;
    onFallback++;
    const rule: ShapeRule | undefined =
      own === undefined
        ? { id: "subscriber-closure", r386: subRule?.r386 === true }
        : classifyReason(own);
    if (rule === undefined) {
      const k = maskTemplate(why);
      unclassified[k] = (unclassified[k] ?? 0) + 1;
      continue;
    }
    const row = shapes[rule.id] ?? { tests: 0, r386: rule.r386 };
    row.tests++;
    shapes[rule.id] = row;
  }
  return {
    app,
    tests: tests.length,
    onFallback,
    subscriberShape: sub === undefined ? null : (subRule?.id ?? "unclassified"),
    shapes,
    unclassified,
  };
}

if (import.meta.main) {
  const [app, out] = process.argv.slice(2);
  if (app === undefined || out === undefined) {
    console.error("usage: bun scripts/r386-fallback-census.ts <test-app-dir> <out.json>");
    process.exit(2);
  }
  const r = await census(app);
  await Bun.write(out, JSON.stringify(r, null, 1));
  const top = Object.entries(r.shapes)
    .sort((a, b) => b[1].tests - a[1].tests)
    .slice(0, 3);
  const unc = Object.values(r.unclassified).reduce((a, b) => a + b, 0);
  console.log(
    `${app}: ${r.tests} tests, ${r.onFallback} on fallback (unclassified ${unc}); top ${
      top.map(([k, v]) => `${k}=${v.tests}`).join(", ") || "none"
    }`,
  );
}
