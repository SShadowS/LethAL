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
 * called name is itself opening-shaped, since the scanner cannot prove it is safe. Any other call
 * on a non-plain receiver (`Libs[1].Helper()`, `GetLib().Helper()`) is walked into every codeunit
 * the receiver's value can be; a receiver EXPRESSION of a kind the scanner does not model is a
 * loud error.
 * The undeclared-root rule: a receiver whose root NAME has no declaration the scanner collects is
 * read as a type name, a system object or a built-in function, never a codeunit instance, so no
 * call edge is followed from it. That is safe only because every form of declaration that can
 * hold a codeunit IS collected (parameters, var parameters, locals, globals, protected vars, named
 * return values, declarations inside `#if` regions); the test "declaration-form completeness:
 * every form that can hold a codeunit is in scope" in tests/testpage-scan.test.ts pins each form.
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
import { discoveredRelPaths } from "./line-filter";
import { testKeyOf } from "./selection";

/** Checked against Microsoft Learn's TestPage/TestRequestPage method lists (Task 1 Step 0). */
const OPENING_METHODS = new Set(["openview", "openedit", "opennew", "trap"]);
/** Anchored at the start, but `array[...] of TestPage X` is a TestPage-typed declaration too. */
const PAGE_TYPE = /^\s*(?:array\s*\[[^\]]*\]\s*of\s+)?test(request)?page\b/i;
const CODEUNIT_TYPE = /^\s*codeunit\s+(.+?)\s*$/i;
const NAME_KINDS = new Set(["identifier", "quoted_identifier"]);
/** The grammar's `extras` that can sit between any two tokens and so show up as NAMED children:
 *  counted as an argument or read as a member name they silently drop a call (final review #1). */
const TRIVIA = new Set([
  "comment",
  "multiline_comment",
  "pragma",
  "preproc_region",
  "preproc_endregion",
  "preproc_define",
  "preproc_undef",
]);
/** Named children minus trivia: every POSITIONAL or counted read goes through this. */
const realChildren = (n: ALSyntaxNode): ALSyntaxNode[] =>
  n.namedChildren.filter((c) => !TRIVIA.has(c.rawKind));
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

interface ErrorSite {
  readonly startIndex: number;
  /** The ERROR/MISSING node's own text: an unclosed object can swallow the next one whole, so its
   *  ERROR span can literally contain a later object's keyword (`docs/...`, review round 1 #5). */
  readonly text: string;
}

/** Every ERROR and MISSING node (MISSING carries the missing token's type, and its text is empty). */
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

const NO_WITH: readonly Recv[] = Object.freeze([]);

/** R-371: the target expression of every with-statement enclosing `n`, innermost first. */
function withTargets(n: ALSyntaxNode): readonly Recv[] {
  let out: Recv[] | undefined;
  let cur = n.parent;
  while (cur !== null) {
    if (cur.rawKind === "with_statement") {
      const r = cur.childForFieldName("record");
      out ??= [];
      out.push(r === null ? { k: "opaque", kind: "with_statement" } : toRecv(r));
    }
    if (cur.rawKind === "procedure" || cur.rawKind === "trigger_declaration") break;
    cur = cur.parent;
  }
  return out ?? NO_WITH;
}

/**
 * Plain facts only, no syntax nodes: no parse result may outlive the reading of its file. Under WASM a
 * kept tree lived in the wasm heap, and BC.History/BaseApp's 9,620 kept trees hit its 2,048 MB
 * ceiling and aborted; natively a kept ParsedAL still holds its source and flat arrays (R-236c's
 * memory test). A call site, in source pre-order, as the traversal will need it.
 */
type Site =
  /** A bare call (`Name(...)` or a call statement): same codeunit, possibly a with-receiver. */
  | {
      readonly kind: "bare";
      readonly name: string;
      readonly args: number;
      readonly inWith: boolean;
      /** R-371: the target of every enclosing with-statement, innermost first; empty outside one. */
      readonly withRecv: readonly Recv[];
      /** R-371: the first argument's text, read only for `Codeunit::X` in an object run. */
      readonly arg0: string | undefined;
      /** R-371: the arguments that can name a test-app object (`ArgFact`). */
      readonly argFacts: readonly ArgFact[];
    }
  /** `receiver.member`, called or not; `recv` is the receiver's shape, a bare name when plain. */
  | {
      readonly kind: "member";
      readonly recv: Recv;
      readonly receiver: string;
      readonly member: string;
      readonly args: number;
      readonly arg0: string | undefined;
      readonly argFacts: readonly ArgFact[];
    };

/**
 * R-371: an argument that can name a test-app object, as plain facts: an object reference
 * (`Report::"X"`, `Database::"T"`), a plain name (a variable, read against the caller's scope
 * later), `this`, or an integer literal (a codeunit id, read only for a run by id). Every other
 * argument shape (an expression, a field) is dropped. `at` is the argument's position.
 */
type ArgFact =
  | { readonly k: "ref"; readonly at: number; readonly kind: string; readonly name: string }
  | { readonly k: "int"; readonly at: number; readonly value: string }
  /** Any other argument but a literal or an operator's result: its shape, read in the caller. */
  | { readonly k: "expr"; readonly at: number; readonly recv: Recv };

const NO_ARGS: readonly ArgFact[] = Object.freeze([]);

/**
 * A receiver expression as plain facts, enough to ask "which codeunit could this value be?"
 * (run 002, review r1 #1): a non-plain receiver was dropped as safe unless its member was
 * opening-shaped, so `Libs[1].OpenIt()` never reached `OpenIt`.
 */
type Recv =
  | { readonly k: "name"; readonly name: string }
  | { readonly k: "index"; readonly base: Recv }
  /** `recv.member(...)` or the paren-less `recv.member`. */
  | { readonly k: "member"; readonly recv: Recv; readonly member: string; readonly args: number }
  | { readonly k: "call"; readonly name: string; readonly args: number; readonly inWith: boolean }
  | { readonly k: "either"; readonly options: readonly Recv[] }
  /** A literal, an operator's result or an enum value: never a codeunit instance. */
  | { readonly k: "value" }
  /** A shape the scanner does not model: its type is unknown, which fails loudly. */
  | { readonly k: "opaque"; readonly kind: string };

const VALUE_KINDS =
  /^(?:string_literal|integer|decimal|boolean|date_literal|time_literal|datetime_literal|qualified_enum_value|database_reference|(?:additive|multiplicative|unary|comparison|logical|relational|equality|binary|in|range)_expression)$/;

function toRecv(n: ALSyntaxNode): Recv {
  // A variable may be named like a keyword (`Page`, `Report`): the grammar calls it keyword_identifier.
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
        return { k: "call", name: fn.text, args, inWith: insideWithStatement(n) };
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
  /** R-371: `codeunit`, or the object kind of a non-codeunit unit (`table`, `pageextension`, ...). */
  readonly kind: string;
  readonly file: string;
  readonly id: number;
  readonly name: string; // normalised
  readonly display: string;
  readonly damaged: boolean;
  /** Every declared name -> EVERY type text it has across `#if` arms (run 003). */
  readonly globals: ReadonlyMap<string, readonly string[]>;
  /** R-371: the variables AL declares implicitly (`Rec`, `xRec`, a data item's name), read by
   *  the digest's walk only, so the TestPage scan's reading of a name did not change. */
  readonly implicit: ReadonlyMap<string, readonly string[]>;
  /** R-371: a non-codeunit object whose `Rec` type is not known here (see `buildObjectUnit`). */
  readonly implicitUnknown: boolean;
  readonly pageNamesAnywhere: ReadonlySet<string>;
  readonly procs: readonly Proc[];
  readonly problems: readonly string[];
  /** R-371: the codeunit's triggers (OnRun), or every trigger of a non-codeunit object, nested
   *  ones included. Apart from `procs`, so the TestPage scan never walks or matches one. */
  readonly triggers: readonly Proc[];
  /** R-371: holds an `[EventSubscriber]` procedure or says `EventSubscriberInstance = Manual`. */
  readonly subscriber: boolean;
  /** R-371: for a codeunit, SHA-256 of the object minus its procedures (the header, properties,
   *  globals and their initialisation, triggers, and the `#if` lines between members); for any
   *  other object, of its whole text. */
  readonly partsHash: string;
  /** R-371: SHA-256 of the whole object's text. */
  readonly textHash: string;
  /** R-371, non-codeunit units: `<kind>:<normalised name>` of the object it declares or, for an
   *  extension, extends. The units under one base key are one object's code. */
  readonly baseKey: string | undefined;
  /** R-371: the target of every `part(Name; Target)` in the object (a page's subpages), as
   *  written; `""` when the target could not be read. Empty for a codeunit. */
  readonly parts: readonly string[];
  /** R-371, an enum or enumextension: every implementation codeunit it names, as written
   *  (`Implementation = "I" = "C"` on a value, `DefaultImplementation`, ...). */
  readonly implementations: readonly string[];
}

export interface Proc {
  readonly unit: Unit;
  /** Undefined when the procedure has no code block. */
  readonly sites: readonly Site[] | undefined;
  readonly name: string; // normalised
  readonly display: string;
  readonly params: number;
  /** The declared return type's text, when there is one. */
  readonly returnType: string | undefined;
  /** Parameters, named return value and locals -> every type text across `#if` arms. A name here
   *  hides every global of that name (ordinary shadowing). */
  readonly scope: ReadonlyMap<string, readonly string[]>;
  /** R-371: the normalised names a `[HandlerFunctions('A,B')]` attribute lists. */
  readonly handlers: readonly string[];
  /** R-371: SHA-256 of the procedure's span, its attributes included (R-278's span). */
  readonly spanHash: string;
  /** R-371: unique within the test app: `[<kind> ]<id>:<display>`, `#<n>` for a repeat (one
   *  counter over the whole app, so two `#if` arms of one object get two keys). Read only to
   *  explain a too-many-new-tests refusal, never to decide a verdict. */
  readonly key: string;
  /** R-371: carries an `[EventSubscriber]` attribute. */
  readonly subscriber: boolean;
  /** R-371: every `Codeunit::X` name and every integer literal of 1000 or more in the body, as
   *  written: where a codeunit id an Integer can carry may come from (`Scanner.foldIdTargets`). */
  readonly idRefs: readonly string[];
}

/** R-371: one parse of the test app, as plain facts, shared by the TestPage scan and the digest. */
export interface TestAppModel {
  /** The codeunits: the only units the TestPage scan reads. */
  readonly units: readonly Unit[];
  /** R-371: every other object with a name, as a walkable unit. */
  readonly objects: readonly Unit[];
  /** Parse damage inside a codeunit or outside every object: either could hide a target. */
  readonly suspect: readonly string[];
  /** R-371: every file with any parse damage; the digest's walk trusts no EXTERNAL then. */
  readonly damaged: readonly string[];
  /** SHA-256 of every file's normalised text, sorted: the whole-source fallback's input. */
  readonly fileHashes: readonly string[];
}

/** R-278's normalisation: line endings and trailing spaces and tabs only, and R-372's BOM. */
export const normalizeSource = (text: string): string =>
  text
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+$/gm, "");

export const sha256 = (text: string): string =>
  new Bun.CryptoHasher("sha256").update(text).digest("hex");

function nameNode(n: ALSyntaxNode): ALSyntaxNode | undefined {
  return n.namedChildren.find((c) => NAME_KINDS.has(c.rawKind));
}

/** Adds `type` to `name`'s types: a name declared in two `#if` arms keeps BOTH (run 003, review r2:
 *  a Map that kept the last type walked only one arm's codeunit). Not named `declare`: Bun's
 *  transpiler dropped a statement `declare(...)` as a TypeScript ambient declaration, silently. */
function addType(into: Map<string, string[]>, name: string, type: string): void {
  const key = normalizeAlName(name);
  const list = into.get(key);
  if (list === undefined) into.set(key, [type]);
  else if (!list.includes(type)) list.push(type);
}

/**
 * Every name of every `variable_declaration` under `section`, into `into`. With `skipProcedures`,
 * a `procedure` subtree is not entered: see `procsInVarSection`, whose procedures' locals must not
 * read as globals.
 */
function addDeclarations(
  section: ALSyntaxNode,
  into: Map<string, string[]>,
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
      for (const n of names) addType(into, n.text, type);
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

/** Every `attribute_item` in an `#if` that holds attributes only, every arm, in source order. */
function attributesInConditional(n: ALSyntaxNode, out: ALSyntaxNode[] = []): ALSyntaxNode[] {
  for (const c of n.namedChildren) {
    if (c.rawKind === "attribute_item") out.push(c);
    else if (c.rawKind === "preproc_conditional") attributesInConditional(c, out);
  }
  return out;
}

/**
 * R420: whether `n` is an `#if` whose every arm holds attributes only (comments and nested
 * attribute-only `#if`s allowed), with at least one attribute: `#if X [HandlerFunctions('H')]
 * #endif` in a member's attribute run. Its attributes belong to the member after it.
 */
function isAttributeConditional(n: ALSyntaxNode): boolean {
  if (n.rawKind !== "preproc_conditional") return false;
  const onlyAttributes = (c: ALSyntaxNode): boolean =>
    c.namedChildren.every(
      (x) =>
        x.rawKind === "attribute_item" ||
        PREPROC_BRANCH_MARKER.has(x.rawKind) ||
        TRIVIA.has(x.rawKind) ||
        (x.rawKind === "preproc_conditional" && onlyAttributes(x)),
    );
  return onlyAttributes(n) && attributesInConditional(n).length > 0;
}

/** Where an arm of a `preproc_conditional` starts. */
const ARM_START = new Set(["preproc_if", "preproc_elif", "preproc_else"]);

/** A member's attribute run: the source it spans and the attributes in it. */
interface AttributeRun {
  /** `[from, to)` pieces in source order; the last ends at the member's end. One piece, except
   *  for S11 below. */
  readonly pieces: ReadonlyArray<readonly [number, number]>;
  /** Every attribute in the run, every `#if` arm's included, nearest first. */
  readonly attributes: readonly ALSyntaxNode[];
}

/**
 * `decl`'s attribute run, R-278's span rule as R420 extends it. The run is the siblings directly
 * before `decl`: attributes, trivia between them, and (R420) an `#if` that holds attributes only,
 * whose attributes are taken from EVERY arm (the union: the digest walks every handler a build
 * might use, the TestPage scan sees every TestPage one might touch). The span starts at the run's
 * first node, so editing a handler list inside `#if` edits the test.
 *
 * With `andTrivia`, trivia directly before is taken too: R-371's object parts leave a doc comment
 * above a procedure out, so adding a commented test to a codeunit does not read as an edit to its
 * header.
 *
 * S11 (`[Test]` then `#if X procedure A ... #else procedure B ... #endif`): the compiler gives
 * each arm's procedure the attributes before the `#if`. When the run inside the arm reaches the
 * arm's start, and the run before the `#if` holds an attribute, that run is the procedure's too.
 * The span is then two pieces, that outer run and the arm's own run to the procedure's end, so
 * an edit to the other arm's procedure is not an edit to this one.
 */
function attributeRun(decl: ALSyntaxNode, andTrivia = false, end = decl.endIndex): AttributeRun {
  let start = decl.startIndex;
  const attributes: ALSyntaxNode[] = [];
  const siblings = decl.parent?.namedChildren ?? [];
  let i = siblings.findIndex((x) => x.startIndex === decl.startIndex);
  let atArmStart = false;
  for (i -= 1; i >= 0; i -= 1) {
    const x = siblings[i];
    if (x === undefined) break;
    if (x.rawKind === "attribute_item") {
      attributes.push(x);
      start = x.startIndex;
    } else if (isAttributeConditional(x)) {
      attributes.push(...attributesInConditional(x).reverse());
      start = x.startIndex;
    } else if (TRIVIA.has(x.rawKind)) {
      if (andTrivia) start = x.startIndex;
    } else {
      atArmStart = ARM_START.has(x.rawKind);
      break;
    }
  }
  const own: AttributeRun = { pieces: [[start, end]], attributes };
  const cond = decl.parent;
  if (!atArmStart || cond === null || cond.rawKind !== "preproc_conditional") return own;
  const outer = attributeRun(cond, andTrivia, cond.startIndex);
  if (outer.attributes.length === 0) return own;
  return {
    pieces: [...outer.pieces, [start, end]],
    attributes: [...attributes, ...outer.attributes],
  };
}

/** A span's text: its pieces joined by a newline (one piece is the plain slice, as before R420). */
const spanText = (source: string, run: AttributeRun): string =>
  run.pieces.map(([from, to]) => source.slice(from, to)).join("\n");
const HANDLER_ATTRIBUTE = /^\[\s*HandlerFunctions\s*\(\s*'([^']*)'/i;
const SUBSCRIBER_ATTRIBUTE = /^\[\s*EventSubscriber\s*\(/i;
const MANUAL_BINDING = /EventSubscriberInstance\s*=\s*Manual/i;

/**
 * R-371: `node`'s text with every procedure span in it cut out (attributes and the comments
 * directly above included), each remaining piece trimmed and blank ones dropped. What is left is
 * the object's header, properties, globals, triggers and the `#if` lines between members, and
 * adding or editing a procedure leaves it unchanged.
 */
function partsText(source: string, node: ALSyntaxNode): string {
  const cuts: Array<readonly [number, number]> = [];
  visit(node, (n) => {
    if (n.rawKind === "procedure") cuts.push(...attributeRun(n, true).pieces);
  });
  cuts.sort((x, y) => x[0] - y[0]);
  const pieces: string[] = [];
  let at = node.startIndex;
  for (const [from, to] of cuts) {
    // Nested inside a cut already taken, or (S11) the outer run two arms' procedures share.
    if (from < at) {
      at = Math.max(at, to);
      continue;
    }
    pieces.push(source.slice(at, from));
    at = to;
  }
  pieces.push(source.slice(at, node.endIndex));
  return pieces
    .map((x) => normalizeSource(x).trim())
    .filter((x) => x.length > 0)
    .join("\n");
}

/** A procedure or trigger as plain facts; `problems` is the scan's list, `null` for R-371 only. */
function procOf(
  p: ALSyntaxNode,
  unit: Unit,
  source: string,
  problems: string[] | null,
  keys: Map<string, number>,
): Proc | undefined {
  const isTrigger = p.rawKind === "trigger_declaration";
  const id2 = nameNode(p);
  if (id2 === undefined) return undefined;
  const scope = new Map<string, string[]>();
  const plist = p.namedChildren.find((c) => c.rawKind === "parameter_list");
  const params = plist?.namedChildren.filter((c) => c.rawKind === "parameter") ?? [];
  for (const prm of params) {
    const n = nameNode(prm);
    const t = prm.namedChildren.find((c) => c.rawKind === "type_specification")?.text ?? "";
    if (n !== undefined) addType(scope, n.text, t);
  }
  // A named return value (`procedure H() R: Codeunit Lib`) is a variable in its procedure
  // (run 002 re-review): unscoped, `R.Helper()` read as an undeclared name and was dropped.
  const returnType = p.childForFieldName("return_type")?.text;
  const returnValue = p.childForFieldName("return_value");
  if (returnValue !== null && returnType !== undefined)
    addType(scope, returnValue.text, returnType);
  const vars = p.namedChildren.find((c) => c.rawKind === "var_section");
  // A trigger's locals, and anything outside a codeunit, are read by R-371's walk only, so they
  // report no scan problem.
  if (vars !== undefined)
    addDeclarations(
      vars,
      scope,
      `${unit.display}.${id2.text}`,
      isTrigger || problems === null ? [] : problems,
    );
  const block = p.namedChildren.find((c) => c.rawKind === "code_block");
  const run = attributeRun(p);
  const attributes = run.attributes.map((x) => x.text.trim());
  // R420: every `[HandlerFunctions]` in the run, so every `#if` arm's (the union).
  const handlers = [
    ...new Set(
      attributes
        .flatMap((t) => (HANDLER_ATTRIBUTE.exec(t)?.[1] ?? "").split(","))
        .map((h) => normalizeAlName(h.trim()))
        .filter((h) => h.length > 0),
    ),
  ];
  const display = `${unit.display}.${id2.text}`;
  const kind = unit.kind === "codeunit" ? "" : `${unit.kind} `;
  const suffix = isTrigger ? " (trigger)" : "";
  const keyBase = `${kind}${unit.id}:${display}${suffix}`.toLowerCase();
  const seen = keys.get(keyBase) ?? 0;
  keys.set(keyBase, seen + 1);
  return {
    unit,
    sites: block === undefined ? undefined : callSites(block),
    idRefs: block === undefined ? NO_IDS : idRefsIn(block),
    name: normalizeAlName(id2.text),
    display,
    params: params.length,
    returnType,
    scope,
    handlers,
    spanHash: sha256(normalizeSource(spanText(source, run))),
    key: `${kind}${unit.id}:${display}${seen > 0 ? `#${seen}` : ""}${suffix}`,
    subscriber: attributes.some((t) => SUBSCRIBER_ATTRIBUTE.test(t)),
  };
}

/** The value of a declaration_body-level property (`TableNo`, `SourceTable`), as written. */
function propertyValue(body: ALSyntaxNode | undefined, name: string): string | undefined {
  for (const c of flattenPreproc(body?.namedChildren ?? [])) {
    if (c.rawKind !== "property") continue;
    const m = /^\s*([A-Za-z]+)\s*=\s*([\s\S]*?)\s*;?\s*$/.exec(c.text);
    if (m?.[1] !== undefined && m[1].toLowerCase() === name.toLowerCase()) return m[2];
  }
  return undefined;
}

function buildUnit(
  file: string,
  node: ALSyntaxNode,
  errors: readonly ErrorSite[],
  source: string,
  keys: Map<string, number>,
): Unit {
  const id = Number(node.namedChildren.find((c) => c.rawKind === "integer")?.text);
  const display = (nameNode(node)?.text ?? "").replace(/^"|"$/g, "");
  const body = node.namedChildren.find((c) => c.rawKind === "declaration_body");
  const problems: string[] = [];
  const globals = new Map<string, string[]>();
  const pageNamesAnywhere = new Set<string>();
  const text = source.slice(node.startIndex, node.endIndex);
  // R-371: a codeunit with `TableNo` has an implicit `Rec` of that table in its OnRun.
  const implicit = new Map<string, string[]>();
  const tableNo = propertyValue(body, "TableNo");
  if (tableNo !== undefined) addType(implicit, "Rec", `Record ${tableNo}`);
  const unitShell = {
    kind: "codeunit",
    file,
    id,
    name: normalizeAlName(display),
    display,
    damaged: errors.some((e) => within(e.startIndex, node)),
    globals,
    implicit,
    implicitUnknown: false,
    pageNamesAnywhere,
    problems,
    procs: [] as Proc[],
    triggers: [] as Proc[],
    subscriber: MANUAL_BINDING.test(text),
    partsHash: sha256(partsText(source, node)),
    textHash: sha256(normalizeSource(text)),
    baseKey: undefined,
    parts: [],
    implementations: [],
  };
  if (body !== undefined) {
    const members = flattenPreproc(body.namedChildren).flatMap((c) =>
      c.rawKind.endsWith("var_section") ? [c, ...procsInVarSection(c)] : [c],
    );
    for (const c of members) {
      if (c.rawKind.endsWith("var_section"))
        addDeclarations(c, globals, `${display} globals`, problems, true);
    }
    const all = new Map<string, string[]>();
    addDeclarations(body, all, `${display}`, []);
    for (const [n, ts] of all) if (ts.some((t) => PAGE_TYPE.test(t))) pageNamesAnywhere.add(n);
    for (const p of members) {
      if (p.rawKind !== "procedure" && p.rawKind !== "trigger_declaration") continue;
      const proc = procOf(p, unitShell, source, problems, keys);
      if (proc === undefined) continue;
      if (proc.subscriber) unitShell.subscriber = true;
      (p.rawKind === "trigger_declaration" ? unitShell.triggers : unitShell.procs).push(proc);
    }
  }
  return unitShell;
}

/** `<x>Implementation = "I" = "C", "J" = D;`: every `C` and `D`, as written. */
function implementationsIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\b\w*Implementation\s*=\s*([^;]*);/gi)) {
    for (const pair of (m[1] ?? "").match(/(?:"[^"]*"|[^,"])+/g) ?? []) {
      const impl = /=\s*("[^"]*"|[^=]+?)\s*$/.exec(pair)?.[1];
      out.push(impl ?? "");
    }
  }
  return out;
}

/** A report, query or xmlport data item's name and table: `dataitem(Name; Table)`. */
const DATA_ITEM =
  /^\s*(?:dataitem|tableelement)\s*\(\s*("[^"]*"|[A-Za-z_]\w*)\s*;\s*([^)]+?)\s*\)/i;
const DATA_ITEM_KIND = /dataitem|tableelement/;

/**
 * R-371 (ruling B): a non-codeunit test-app object (table, page, report, extension, ...) as a
 * walkable unit. Its procedures and EVERY trigger in it, nested ones (field, action, data item)
 * included, so a walk that enters the object can walk them all. `partsHash` is its whole text:
 * any edit to the object is an edit to what a test that reaches it runs. Never seen by the
 * TestPage scan.
 */
function buildObjectUnit(
  file: string,
  node: ALSyntaxNode,
  errors: readonly ErrorSite[],
  source: string,
  kind: string,
  baseKey: string | undefined,
  extendsText: string | undefined,
  keys: Map<string, number>,
): Unit {
  const id = Number(node.namedChildren.find((c) => c.rawKind === "integer")?.text);
  const nameText = nameNode(node)?.text ?? "";
  const display = nameText.replace(/^"|"$/g, "");
  const body = node.namedChildren.find((c) => c.rawKind === "declaration_body");
  const globals = new Map<string, string[]>();
  for (const c of flattenPreproc(body?.namedChildren ?? [])) {
    if (c.rawKind.endsWith("var_section")) addDeclarations(c, globals, display, [], true);
  }
  // The implicit record variables AL declares for the object's code. Where their type is not
  // known here (a page with no SourceTable, a page or report extension), `implicitUnknown` makes
  // a trigger-capable call on one fall back.
  const implicit = new Map<string, string[]>();
  let recType: string | undefined;
  if (kind === "table") recType = `Record ${nameText}`;
  else if (kind === "tableextension" && extendsText !== undefined)
    recType = `Record ${extendsText}`;
  else if (kind === "page") {
    const src = propertyValue(body, "SourceTable");
    if (src !== undefined) recType = `Record ${src}`;
  }
  if (recType !== undefined) {
    addType(implicit, "Rec", recType);
    addType(implicit, "xRec", recType);
  }
  const parts: string[] = [];
  visit(node, (x) => {
    if (x.rawKind === "part_section") {
      const target = realChildren(x).filter((c) => c.rawKind !== "part_keyword")[1];
      parts.push(target === undefined || target.rawKind === "declaration_body" ? "" : target.text);
    }
    if (DATA_ITEM_KIND.test(x.rawKind)) {
      const m = DATA_ITEM.exec(x.text);
      if (m?.[1] !== undefined && m[2] !== undefined) addType(implicit, m[1], `Record ${m[2]}`);
    }
  });
  const text = normalizeSource(source.slice(node.startIndex, node.endIndex));
  const hash = sha256(text);
  const unit = {
    kind,
    file,
    id,
    name: normalizeAlName(display),
    display: `${kind} ${display}`,
    damaged: errors.some((e) => within(e.startIndex, node)),
    globals,
    implicit,
    implicitUnknown: recType === undefined,
    pageNamesAnywhere: new Set<string>(),
    problems: [],
    procs: [] as Proc[],
    triggers: [] as Proc[],
    subscriber: false,
    partsHash: hash,
    textHash: hash,
    baseKey,
    parts,
    implementations: kind.startsWith("enum") ? implementationsIn(text) : [],
  };
  const walk = (n: ALSyntaxNode): void => {
    if (n.rawKind === "procedure" || n.rawKind === "trigger_declaration") {
      const proc = procOf(n, unit, source, null, keys);
      if (proc !== undefined)
        (n.rawKind === "trigger_declaration" ? unit.triggers : unit.procs).push(proc);
      return;
    }
    for (const c of n.namedChildren) walk(c);
  };
  walk(node);
  return unit;
}
/**
 * The argument count, and the first argument's text when it is an object reference
 * (`Codeunit::X`, which R-371's walk reads for an object run); `""` for any other first argument,
 * so no argument's text is kept that nothing reads.
 */
function argInfo(call: ALSyntaxNode): {
  args: number;
  arg0: string | undefined;
  argFacts: readonly ArgFact[];
} {
  const list = call.namedChildren.find((c) => c.rawKind === "argument_list");
  const real = list === undefined ? [] : realChildren(list);
  const first = real[0];
  let argFacts: ArgFact[] | undefined;
  for (const [at, a] of real.entries()) {
    let f: ArgFact | undefined;
    if (a.rawKind === "database_reference") {
      const m = /^\s*(\w+)\s*::\s*(.+?)\s*$/.exec(a.text);
      if (m?.[1] !== undefined && m[2] !== undefined)
        f = { k: "ref", at, kind: m[1].toLowerCase(), name: m[2] };
    } else if (a.rawKind === "integer") {
      f = { k: "int", at, value: a.text.trim() };
    } else {
      const recv = toRecv(a);
      if (recv.k !== "value") f = { k: "expr", at, recv };
    }
    if (f === undefined) continue;
    argFacts ??= [];
    argFacts.push(f);
  }
  return {
    args: real.length,
    arg0:
      first === undefined
        ? undefined
        : first.rawKind === "database_reference"
          ? first.text.trim()
          : "",
    argFacts: argFacts ?? NO_ARGS,
  };
}

const NO_IDS: readonly string[] = Object.freeze([]);

/** `Proc.idRefs`: `Codeunit::X` names and integer literals of 1000 or more under `block`. */
function idRefsIn(block: ALSyntaxNode): readonly string[] {
  let out: string[] | undefined;
  visit(block, (n) => {
    let v: string | undefined;
    if (n.rawKind === "database_reference") {
      const m = /^\s*codeunit\s*::\s*(.+?)\s*$/i.exec(n.text);
      v = m?.[1];
    } else if (n.rawKind === "integer" && n.text.trim().length >= 4) v = n.text.trim();
    if (v === undefined) return;
    out ??= [];
    out.push(v);
  });
  return out ?? NO_IDS;
}

/** The call sites under `block`, in the pre-order the traversal used to visit them live. */
function callSites(block: ALSyntaxNode): Site[] {
  const out: Site[] = [];
  const member = (
    m: ALSyntaxNode,
    args: number,
    arg0: string | undefined,
    argFacts: readonly ArgFact[],
  ): void => {
    const [receiver, name] = realChildren(m);
    if (receiver === undefined || name === undefined) return;
    out.push({
      kind: "member",
      recv: toRecv(receiver),
      receiver: receiver.text,
      member: name.text,
      args,
      arg0,
      argFacts,
    });
  };
  const bare = (
    n: ALSyntaxNode,
    name: string,
    args: number,
    arg0: string | undefined,
    argFacts: readonly ArgFact[],
  ): void => {
    const withRecv = withTargets(n);
    out.push({ kind: "bare", name, args, inWith: withRecv.length > 0, withRecv, arg0, argFacts });
  };
  visit(block, (n) => {
    if (n.rawKind === "call_expression") {
      const fn = n.childForFieldName("function");
      const { args, arg0, argFacts } = argInfo(n);
      if (fn === null) return;
      if (NAME_KINDS.has(fn.rawKind)) bare(n, fn.text, args, arg0, argFacts);
      else if (fn.rawKind === "member_expression") member(fn, args, arg0, argFacts);
      return;
    }
    if (n.rawKind === "member_expression") {
      const parent = n.parent;
      const isCallee =
        parent !== null &&
        parent.rawKind === "call_expression" &&
        parent.childForFieldName("function")?.startIndex === n.startIndex;
      if (!isCallee) member(n, 0, undefined, NO_ARGS);
      return;
    }
    if (n.rawKind === "call_statement") {
      const id = nameNode(n);
      if (id !== undefined) bare(n, id.text, 0, undefined, NO_ARGS);
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

/** R-371: what one digest walk reached. Built per test, hashed, and dropped at once. */
export interface ReachState {
  readonly procs: Set<Proc>;
  readonly units: Set<Unit>;
  /** Non-codeunit objects whose triggers were walked (`enterObject`), by base key. */
  readonly entered: Set<string>;
  /** The first UNFOLLOWED edge met, in words; undefined while every edge was classified. */
  fallback: string | undefined;
}

export const newReachState = (): ReachState => ({
  procs: new Set(),
  units: new Set(),
  entered: new Set(),
  fallback: undefined,
});

function fallBack(st: ReachState, why: string): void {
  st.fallback ??= why;
}

/** The object name a type or reference text ends in: the last dotted segment, quotes kept whole. */
function lastSegment(raw: string): string {
  const segments = raw.trim().match(/"[^"]*"|[^.]+/g) ?? [raw];
  return normalizeAlName((segments[segments.length - 1] ?? raw).trim());
}

/**
 * R-371 (the orchestrator's EXTERNAL condition): whether a reference is ONE plain name that the
 * test app's objects can be checked against: a bare identifier, or one quoted name (dots inside
 * the quotes are part of the name). An id, a namespace-qualified name and any other shape are
 * not, and a reference the test app does not declare is then UNFOLLOWED, never EXTERNAL.
 */
const PLAIN_NAME = /^\s*(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_]*)\s*$/;

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
/** Names AL declares in non-codeunit code whose calls reach only the object's own triggers
 *  (walked whenever its code is entered) or the platform. */
const SYSTEM_ROOTS = new Set([
  "currpage",
  "currreport",
  "currxmlport",
  "currquery",
  "database",
  "session",
  "system",
  "companyproperty",
  "requestoptionspage",
]);

/** R-371: a type whose value may be a record of any table (folded, not fallen back). */
const HOLDS_RECORD = /^\s*(variant|recordref|fieldref)\b/i;
/** R-371: the position(s) of the codeunit-id arguments of a platform run by id, by `root.member`;
 *  the bare `StartSession` is `reachBare`'s. */
const RUN_BY_ID: Readonly<Record<string, readonly number[]>> = {
  "session.startsession": [1],
  "taskscheduler.createtask": [0, 1],
  "currpage.enqueuebackgroundtask": [1],
};
/** R-371: `List of [...]` and `Dictionary of [...]`, with the element types' text. */
const COLLECTION_OF = /^\s*(?:list|dictionary)\s+of\s*\[([\s\S]*)\]\s*$/i;
const NO_RUN: ReadonlySet<number> = new Set();

export class Scanner {
  /** Every unit by `String(id)` and by name, in `units` order: a linear filter per call site was
   *  349 of BaseApp's 415 s (CPU profile, R-236c round 2). */
  private readonly byKey = new Map<string, Unit[]>();
  /** R-371: `<kind>:<name or id>` of an object -> the test-app units declaring or extending it. */
  private readonly otherByBase = new Map<string, Unit[]>();
  /** R-371: every test-app table and tableextension unit (case 14). */
  private readonly tableUnits: readonly Unit[];
  /** R-371: the name of every procedure any test-app object declares. */
  private readonly procNames = new Set<string>();
  /** R-371: any file of the test app has parse damage. */
  private readonly anyDamage: boolean;
  /** R-371: a test-app codeunit's id is below 1000, which `Proc.idRefs` does not keep. */
  private readonly lowIds: boolean;
  /** `normalizeAlName` per distinct text, once: a walk asks for the same few names millions of
   *  times on a large suite, and each answer was a fresh string (R-371's RSS measurement). */
  private readonly normCache = new Map<string, string>();
  /** `unitsFor` per distinct type text, once, for the same reason. */
  private readonly unitsForCache = new Map<string, Unit[]>();

  private norm(raw: string): string {
    let v = this.normCache.get(raw);
    if (v === undefined) {
      v = normalizeAlName(raw);
      this.normCache.set(raw, v);
    }
    return v;
  }

  constructor(model: TestAppModel) {
    const add = (map: Map<string, Unit[]>, k: string, u: Unit): void => {
      const list = map.get(k);
      if (list === undefined) map.set(k, [u]);
      else if (!list.includes(u)) list.push(u);
    };
    for (const u of model.units) {
      for (const k of new Set([String(u.id), u.name])) add(this.byKey, k, u);
      for (const p of u.procs) this.procNames.add(p.name);
    }
    for (const u of model.objects) {
      const kind = u.kind.replace(/extension$/, "");
      if (u.baseKey !== undefined) add(this.otherByBase, u.baseKey, u);
      if (!u.kind.endsWith("extension")) add(this.otherByBase, `${kind}:${u.id}`, u);
      for (const p of u.procs) this.procNames.add(p.name);
    }
    this.tableUnits = model.objects.filter(
      (u) => u.kind === "table" || u.kind === "tableextension",
    );
    this.anyDamage = model.damaged.length > 0;
    this.lowIds = model.units.some((u) => u.id < 1000);
  }

  /**
   * Every codeunit a `Codeunit <type text>` reference could plausibly name, ALL candidates, not
   * the first (review round 3): a reference is genuinely ambiguous without full AL symbol
   * resolution (which the scanner deliberately does not do), so every textually-plausible reading
   * is walked, and a call is resolved, or a test refused, if ANY of them says so.
   */
  unitsFor(typeText: string): Unit[] {
    let v = this.unitsForCache.get(typeText);
    if (v === undefined) {
      const raw = CODEUNIT_TYPE.exec(typeText)?.[1];
      v = raw === undefined ? [] : this.unitsNamed(raw);
      this.unitsForCache.set(typeText, v);
    }
    return v;
  }

  /** R-371: `unitsFor` on a reference that is already the name (`Codeunit::X` gives `X`). */
  private unitsNamed(raw: string): Unit[] {
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
      for (const u of this.byNameAll(this.norm(raw))) candidates.add(u);
    }
    const last = segments[segments.length - 1] ?? raw;
    for (const u of this.byNameAll(this.norm(last))) candidates.add(u);
    return [...candidates];
  }

  /** By id (numeric) or by declared name; both checked for every candidate string above. */
  private byNameAll(want: string): Unit[] {
    return this.byKey.get(want) ?? [];
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
    const name = this.norm(rawName);
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
    if (OPENING_METHODS.has(this.norm(rawName))) {
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
    if (site.recv.k !== "name") {
      // A non-plain receiver (parenthesised, subscripted, chained, ...): an opening-shaped member
      // refuses outright (review round 1, #4). Any other member is a call edge on whatever
      // codeunit the receiver's value can be, walked like a plain one; a receiver whose type the
      // scanner cannot work out fails loudly, never "not an edge" (run 002, review r1 #1).
      if (OPENING_METHODS.has(this.norm(member))) {
        st.reason ??= `${path.join(" -> ")} calls ${receiver}.${member} on an unresolved receiver`;
        return;
      }
      const types = this.typesOf(p, site.recv);
      if (typeof types === "string") {
        st.problems.push(
          `${p.display} calls ${receiver}.${member}, and the scanner cannot tell what ${receiver} is (${types})`,
        );
        return;
      }
      for (const t of types) this.callOn(t, receiver, member, args, path, st);
      return;
    }
    const key = this.norm(site.recv.name);
    if (key === "this") {
      // `this` refers to the codeunit instance itself (review round 1, #1): not a declared name,
      // so it is never in scope/globals, and must not silently fall through as "not a TestPage".
      this.sameCodeunitCall(p.unit, member, args, path, st, false);
      return;
    }
    const types = p.scope.get(key) ?? p.unit.globals.get(key);
    if (types === undefined) {
      if (p.unit.pageNamesAnywhere.has(key)) {
        st.problems.push(
          `${p.display} uses ${receiver}, which matches a TestPage declaration the scanner cannot place in scope`,
        );
      }
      return;
    }
    for (const t of types) this.callOn(t, receiver, member, args, path, st);
  }

  /** `receiver.member(args)` where the receiver's declared type text is `type`. */
  private callOn(
    type: string,
    receiver: string,
    member: string,
    args: number,
    path: readonly string[],
    st: TestState,
  ): void {
    if (PAGE_TYPE.test(type) && OPENING_METHODS.has(this.norm(member))) {
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

  // ---------------------------------------------------------------------------------------------
  // R-371: the digest's walk. Every call edge is FOLLOWED, EXTERNAL or UNFOLLOWED, fail closed: an
  // edge not positively FOLLOWED or EXTERNAL is UNFOLLOWED, and an UNFOLLOWED edge sends the test
  // to the broad fallback (a digest of the whole test-app source). The cases are numbered as in
  // scripts/r371-reach-measure/RESULTS.md ("The classifier's cases"); cases 14, 15 and 16 are
  // FOLLOWED by walking the object's code (the r2 ruling on the subscriber closure, option B).
  // The TestPage scan above is not changed by any of this: it walks `walk`, which reads none of
  // R-371's facts.
  // ---------------------------------------------------------------------------------------------

  /** Walks `p` and everything it reaches into `st`. */
  reach(p: Proc, st: ReachState): void {
    if (st.procs.has(p)) return;
    st.procs.add(p);
    this.reachUnit(p.unit, st);
    // Any code of a non-codeunit object can fire that object's triggers (`Modify(true)`,
    // `CurrPage.Update()`, ...): walk them all, and the test app's extensions' with them.
    if (p.unit.kind !== "codeunit" && p.unit.baseKey !== undefined)
      this.enterObject(p.unit.baseKey, st);
    // Case 4: a `[HandlerFunctions]` handler is looked up in the test's own codeunit; case 20.
    for (const h of p.handlers) {
      let found = false;
      for (const c of p.unit.procs) {
        if (c.name === h) {
          found = true;
          this.reach(c, st);
        }
      }
      if (!found) fallBack(st, `handler ${h} is named but not found in ${p.unit.display}`);
    }
    for (const site of p.sites ?? []) {
      if (site.kind === "bare") this.reachBare(p, site, st);
      else this.reachMember(p, site, st);
    }
  }

  private reachUnit(u: Unit, st: ReachState): void {
    if (st.units.has(u)) return;
    st.units.add(u);
    if (u.damaged) fallBack(st, `${u.display} (${u.file}) does not parse cleanly`);
  }

  /**
   * R-371: walks EVERY trigger of every test-app unit under `baseKey` (the object and the test
   * app's extensions of it), nested field, action and data-item triggers included. Complete for
   * "which of this object's code can run": in AL an object's code is its triggers and its
   * procedures, a procedure runs only when called (and every call from a walked trigger is itself
   * a walked site), and `buildObjectUnit` collects every trigger in the object's text.
   */
  private enterObject(baseKey: string, st: ReachState): void {
    if (st.entered.has(baseKey)) return;
    st.entered.add(baseKey);
    for (const u of this.otherByBase.get(baseKey) ?? []) {
      this.reachUnit(u, st);
      for (const t of u.triggers) this.reach(t, st);
      // A page part's page runs with its host: its code is entered too. A part the test app does
      // not declare is a dependency's page (EXTERNAL) only by the same condition as any object.
      for (const raw of u.parts) {
        const found = this.objectsNamed("page", raw);
        for (const f of found) {
          this.reachUnit(f, st);
          if (f.baseKey !== undefined) this.enterObject(f.baseKey, st);
        }
        if (found.length === 0) this.outside("page", raw, `${u.display} part ${raw}`, st);
      }
    }
  }

  /** Cases 1-3: every same-arity procedure of that name in `owner`. */
  private reachCalls(owner: Unit, rawName: string, args: number, st: ReachState): boolean {
    const name = this.norm(rawName);
    let matched = false;
    for (const c of owner.procs) {
      if (c.name === name && c.params === args) {
        matched = true;
        this.reach(c, st);
      }
    }
    return matched;
  }

  /**
   * A bare or `this.` call in `u`'s own code. In a codeunit it resolves to the codeunit's own
   * procedures only. In any other object it can also resolve to a procedure of the object it
   * extends, or that its base declares (a tableextension's code calling its table's procedure),
   * so every test-app unit under the same base key is searched. A name one of them declares at no
   * arity that matched is not known to be a built-in, so it falls back. Returns whether the call
   * was handled (walked, or fallen back).
   */
  private reachOwn(u: Unit, rawName: string, args: number, st: ReachState): boolean {
    if (this.reachCalls(u, rawName, args, st)) return true;
    if (u.kind === "codeunit" || u.baseKey === undefined) return false;
    const name = this.norm(rawName);
    const kin = this.otherByBase.get(u.baseKey) ?? [];
    let matched = false;
    for (const k of kin) if (k !== u && this.reachCalls(k, rawName, args, st)) matched = true;
    if (matched) return true;
    if (kin.some((k) => k.procs.some((c) => c.name === name))) {
      fallBack(
        st,
        `${u.display} calls ${rawName}, which its object declares at no arity that matches`,
      );
      return true;
    }
    return false;
  }

  /** `X.Run()` on a test-app codeunit, or `Codeunit.Run(Codeunit::X)`: its OnRun trigger. */
  private runUnit(u: Unit, st: ReachState): void {
    this.reachUnit(u, st);
    for (const t of u.triggers) if (t.name === "onrun") this.reach(t, st);
  }

  private reachBare(p: Proc, site: Extract<Site, { kind: "bare" }>, st: ReachState): void {
    if (this.reachOwn(p.unit, site.name, site.args, st)) return;
    // Ruling 1 (R-371 r2): Bind/UnbindSubscription is NOT an edge. What it binds is a test-app
    // subscriber codeunit, and every such codeunit, with everything it reaches, is already in
    // EVERY test's digest (`subscriberFold` in test-digest.ts). Treating it as UNFOLLOWED would
    // only add the whole-source fallback a second time, for no coverage it does not already have.
    const nn = this.norm(site.name);
    if (nn === "bindsubscription" || nn === "unbindsubscription") return;
    // A bare name its own object does not declare, outside any `with`, is a built-in function:
    // only a built-in compiles there. Not an edge. (A built-in such as `Modify` in a table's code
    // can fire the object's own triggers, which `reach` walks on entering the object.) Unless it
    // is handed a reference to a test-app object (`StartSession(Id, Codeunit::"X")`): the
    // platform may run that object, which the walk does not follow.
    if (site.withRecv.length === 0) {
      const ran =
        nn === "startsession" ? this.runById(site.argFacts, site.args, [1], site.name, st) : NO_RUN;
      // In an extension, a name no test-app unit under its base declares may be a procedure of
      // the DEPENDENCY's base object, which runs code the walk does not follow: every argument
      // is read, not only object references.
      const inExtension = p.unit.kind.endsWith("extension");
      this.passesTestApp(p, site.argFacts, !inExtension, site.name, st, ran);
      return;
    }
    // Case 7 (I4): through every enclosing with-target's declared types; case 19 when unknown.
    const types: string[] = [];
    for (const r of site.withRecv) {
      const t = this.typesOf(p, r);
      // A with-target is a declared variable: an empty list is an undeclared name, unknown.
      if (typeof t === "string" || t.length === 0) {
        fallBack(
          st,
          `${p.display} calls ${site.name} inside a with-statement whose target's type is unknown`,
        );
        return;
      }
      types.push(...t);
    }
    for (const t of types) this.reachOn(t, "(with)", site.name, site.args, st, p, site.argFacts);
  }

  private reachMember(p: Proc, site: Extract<Site, { kind: "member" }>, st: ReachState): void {
    const { args, receiver, member, arg0 } = site;
    const nm = this.norm(member);
    const inObject = p.unit.kind !== "codeunit";
    if (site.recv.k !== "name") {
      const types = this.typesOf(p, site.recv);
      if (typeof types === "string") {
        // Case 18.
        fallBack(st, `${p.display} calls ${receiver}.${member} on a receiver of unmodelled shape`);
        return;
      }
      // In a non-codeunit object's code, a chain the walk types as nothing (`CurrPage.Part.Page`)
      // may still name a test-app procedure: not known complete, so it falls back.
      if (inObject && types.length === 0 && this.procNames.has(nm)) {
        fallBack(st, `${p.display} calls ${receiver}.${member}, whose receiver's type is unknown`);
        return;
      }
      for (const t of types) this.reachOn(t, receiver, member, args, st, p, site.argFacts);
      return;
    }
    const key = this.norm(site.recv.name);
    if (key === "this") {
      if (!this.reachOwn(p.unit, member, args, st) && p.unit.kind.endsWith("extension"))
        this.passesTestApp(p, site.argFacts, false, `this.${member}`, st);
      return;
    }
    const types = p.scope.get(key) ?? p.unit.globals.get(key) ?? p.unit.implicit.get(key);
    if (types === undefined) {
      // An undeclared root is a type or system name (the scan's rule). The only call edges from
      // one are object runs (cases 5, 9 and 11).
      if (RUN_ROOTS.has(key) && RUN_MEMBER.test(member)) {
        this.objectRun(key, arg0, `${receiver}.${member}`, st, p, site.argFacts);
        return;
      }
      // A system call handed a reference to a test-app object may run it (`TaskScheduler`).
      const at = RUN_BY_ID[`${key}.${nm}`];
      const ran =
        at === undefined
          ? NO_RUN
          : this.runById(site.argFacts, args, at, `${receiver}.${member}`, st);
      this.passesTestApp(p, site.argFacts, true, `${receiver}.${member}`, st, ran);
      // Outside a codeunit, AL declares names the walk may not type (`Rec` on a page extension, a
      // report extension's data items): a call on one that could run test-app code falls back.
      if (
        inObject &&
        !SYSTEM_ROOTS.has(key) &&
        (RECORD_TRIGGER.has(nm) || RUN_MEMBER.test(member) || this.procNames.has(nm))
      )
        fallBack(st, `${p.display} calls ${receiver}.${member}, whose receiver's type is unknown`);
      return;
    }
    for (const t of types) this.reachOn(t, receiver, member, args, st, p, site.argFacts);
  }

  /** `Codeunit.Run(Codeunit::X)` and friends: by name, resolved; by id or variable, case 11. */
  private objectRun(
    root: string,
    arg0: string | undefined,
    label: string,
    st: ReachState,
    p: Proc,
    argFacts: readonly ArgFact[],
  ): void {
    const m =
      arg0 === undefined ? null : /^(codeunit|page|report|xmlport|query)\s*::\s*(.+)$/i.exec(arg0);
    const kind = m?.[1]?.toLowerCase();
    const raw = m?.[2];
    if (kind === undefined || raw === undefined || kind !== root) {
      fallBack(st, `${label} runs an object by id or through a variable`);
      return;
    }
    if (kind === "codeunit") {
      const us = this.unitsNamed(raw);
      if (us.length > 0) {
        for (const u of us) this.runUnit(u, st);
        return;
      }
    } else if (this.testAppObject(kind, raw, "run", 0, label, st)) return;
    this.outside(kind, raw, label, st, p, argFacts);
  }

  /**
   * The ruling on arguments (R-371): a test-app object handed to code the walk does not follow
   * (an EXTERNAL call, or a platform call) can have its code run there, unseen: a mock codeunit
   * through an interface parameter, a record whose triggers the callee fires, a report the callee
   * runs. Such a call is UNFOLLOWED. Read: an object reference to a test-app object; with
   * `refsOnly` false also `this` and a variable whose declared type is a test-app codeunit,
   * record, page or other object, or an Interface (its implementation may be a test-app
   * codeunit, which is not known here). An extension's object is not counted: every
   * test-app extension is in every digest already (`subscriberFold`).
   */
  private passesTestApp(
    p: Proc,
    facts: readonly ArgFact[],
    refsOnly: boolean,
    label: string,
    st: ReachState,
    skipAt: ReadonlySet<number> = NO_RUN,
  ): void {
    for (const f of facts) {
      if (skipAt.has(f.at)) continue;
      // External review r1 #3: an external callee can run a codeunit by the id it is handed.
      if (f.k === "int") {
        if (!refsOnly && this.byNameAll(f.value).length > 0)
          fallBack(st, `${label} is handed ${f.value}, a test-app codeunit's id, by ${p.display}`);
        continue;
      }
      let what: string | undefined;
      if (f.k === "ref") {
        if (this.isTestAppObject(f.kind === "database" ? "table" : f.kind, f.name))
          what = `${f.kind}::${f.name}`;
      } else if (refsOnly) continue;
      else what = this.argHolds(p, f.recv, st);
      if (what !== undefined) {
        fallBack(st, `${label} is handed ${what}, a test-app object, by ${p.display}`);
        return;
      }
    }
  }

  /**
   * Whether an argument's value can be a test-app object, in words, or undefined when it cannot.
   * Fail closed: a shape the walk does not model counts. A name is typed through the caller's
   * scope (`this` is the caller's own object); a subscript or member of an array or a collection
   * whose element can hold a test-app object counts; a call or member is typed by its return.
   */
  private argHolds(p: Proc, r: Recv, st: ReachState): string | undefined {
    switch (r.k) {
      case "value":
        return undefined;
      case "opaque":
        return `an argument of a shape the walk does not model (${r.kind})`;
      case "either":
        for (const o of r.options) {
          const w = this.argHolds(p, o, st);
          if (w !== undefined) return w;
        }
        return undefined;
      case "name": {
        const key = this.norm(r.name);
        if (key === "this") return "this";
        const types = p.scope.get(key) ?? p.unit.globals.get(key) ?? p.unit.implicit.get(key);
        // A Variant or RecordRef may hold a record of any test-app table: every test-app table,
        // with its triggers and what they reach, is folded in (an unfollowed edge there falls
        // back). Stated limit: a Variant holding a test-app codeunit or interface, run by the
        // external code, is not seen.
        if (types?.some((t) => HOLDS_RECORD.test(ARRAY_OF.exec(t)?.[1] ?? t))) this.foldTables(st);
        const held = types?.find((t) => this.holdsTestApp(t));
        return held === undefined ? undefined : `${r.name} (${held.trim()})`;
      }
      case "index":
      case "member": {
        const base = r.k === "index" ? r.base : r.recv;
        const baseTypes =
          base.k === "name" && this.norm(base.name) !== "this"
            ? (p.scope.get(this.norm(base.name)) ??
              p.unit.globals.get(this.norm(base.name)) ??
              p.unit.implicit.get(this.norm(base.name)) ??
              [])
            : this.typesOf(p, base);
        if (typeof baseTypes === "string") return `an argument of unknown type (${baseTypes})`;
        const coll = baseTypes.find(
          (t) => (ARRAY_OF.test(t) || COLLECTION_OF.test(t)) && this.holdsTestApp(t),
        );
        if (coll !== undefined) return `an element of ${coll.trim()}`;
        if (r.k === "index") return undefined;
        break;
      }
      case "call":
        // A name no test-app object declares is a built-in or a dependency's procedure, and
        // neither can return a test-app type (a dependency cannot name one).
        if (!this.procNames.has(this.norm(r.name))) return undefined;
        break;
    }
    const types = this.typesOf(p, r);
    if (typeof types === "string") return `an argument of unknown type (${types})`;
    const held = types.find((t) => this.holdsTestApp(t));
    return held === undefined ? undefined : `a value of ${held.trim()}`;
  }

  /**
   * R-371 (external review r1 #3): every test-app codeunit a reached procedure names as a value
   * (`Codeunit::X`, or its literal id), folded whole, with what it reaches. Code outside the walk
   * can run a codeunit by an id it is handed, through an Integer argument, a field it reads back
   * or a global, and the walk does not follow values. Iterates to a fixpoint (a `Set` visits what
   * is added while it is iterated). `extra` are procedures whose ids count although they were not
   * reached (the test codeunit's other methods, whose writes the test can read back). With a
   * test-app codeunit whose id is below 1000 (`idRefs` keeps no such literal), every test-app
   * codeunit is folded. Stated limit: an id read from the platform (an AllObj loop) is not seen.
   */
  foldIdTargets(st: ReachState, extra: readonly Proc[] = []): void {
    const fold = (raw: string): void => {
      for (const u of this.byNameAll(this.norm(raw))) {
        this.reachUnit(u, st);
        for (const c of [...u.procs, ...u.triggers]) this.reach(c, st);
      }
    };
    if (this.lowIds) {
      for (const list of this.byKey.values()) for (const u of list) fold(String(u.id));
      return;
    }
    for (const p of extra) for (const r of p.idRefs) fold(r);
    for (const p of st.procs) for (const r of p.idRefs) fold(r);
  }

  /** R-371: an object folded into every digest: entered, with its parts (`enterObject`). */
  foldObject(u: Unit, st: ReachState): void {
    this.reachUnit(u, st);
    if (u.baseKey !== undefined) this.enterObject(u.baseKey, st);
  }

  /**
   * R-371: an enum's implementation codeunit, folded into every digest: every procedure and
   * trigger of every test-app codeunit the name can be, and what they reach. A name the test app
   * does not declare is EXTERNAL only under `outside`'s condition. Returns the units found.
   */
  foldImplementation(raw: string, label: string, st: ReachState): Unit[] {
    const us = this.unitsNamed(raw);
    for (const u of us) {
      this.reachUnit(u, st);
      for (const c of [...u.procs, ...u.triggers]) this.reach(c, st);
    }
    if (us.length === 0) this.outside("codeunit", raw, label, st);
    return us;
  }

  /** Every test-app table and tableextension, entered: its parts, its triggers, what they reach. */
  private foldTables(st: ReachState): void {
    for (const u of this.tableUnits) if (u.baseKey !== undefined) this.enterObject(u.baseKey, st);
  }

  /**
   * A platform call that runs a codeunit by id (`StartSession`, `TaskScheduler.CreateTask`): the
   * codeunit argument at each position in `at` is followed into its OnRun when it is a
   * `Codeunit::X` reference or an id literal naming a test-app codeunit, is EXTERNAL (or no
   * codeunit, 0) otherwise, and falls back when it is a variable or an expression. Returns the
   * positions it handled, so the ruling on arguments does not read them again.
   */
  private runById(
    facts: readonly ArgFact[],
    args: number,
    at: readonly number[],
    label: string,
    st: ReachState,
  ): ReadonlySet<number> {
    for (const i of at) {
      if (i >= args) continue;
      const f = facts.find((x) => x.at === i);
      if (f?.k === "ref" && f.kind === "codeunit")
        for (const u of this.unitsNamed(f.name)) this.runUnit(u, st);
      else if (f?.k === "int") for (const u of this.byNameAll(f.value)) this.runUnit(u, st);
      // A variable, or an expression (which keeps no fact).
      else fallBack(st, `${label} runs a codeunit given by a variable or an expression`);
    }
    return new Set(at);
  }

  /** Whether the test app itself declares (not only extends) the `kind` object `raw` names. */
  private isTestAppObject(kind: string, raw: string): boolean {
    if (kind === "codeunit") return this.unitsNamed(raw).length > 0;
    return this.objectsNamed(kind, raw).some((u) => !u.kind.endsWith("extension"));
  }

  /** Whether a variable of declared type `rawType` can hold a test-app object. */
  private holdsTestApp(rawType: string): boolean {
    const type = ARRAY_OF.exec(rawType)?.[1] ?? rawType;
    // A Variant or RecordRef is not a fallback: `argHolds` folds every test-app table instead.
    if (/^\s*interface\b/i.test(type)) return true;
    const elements = COLLECTION_OF.exec(type)?.[1];
    if (elements !== undefined)
      return (elements.match(/(?:"[^"]*"|[^,"])+/g) ?? []).some((e) => this.holdsTestApp(e));
    const m = OBJ_TYPE.exec(type);
    const kw = m?.[1]?.toLowerCase();
    const raw = m?.[2];
    if (kw === undefined || raw === undefined) return false;
    return this.isTestAppObject(KIND_OF[kw] ?? kw, raw);
  }

  /** Every test-app unit declaring or extending the `kind` object `raw` names, by name or id. */
  private objectsNamed(kind: string, raw: string): Unit[] {
    return [
      ...new Set([
        ...(this.otherByBase.get(`${kind}:${lastSegment(raw)}`) ?? []),
        ...(/^\s*\d+\s*$/.test(raw) ? (this.otherByBase.get(`${kind}:${raw.trim()}`) ?? []) : []),
      ]),
    ];
  }

  /**
   * A member on a variable of a non-codeunit test-app object, or of a dependency's object a
   * test-app extension extends (cases 6, 15, 16). True when a test-app object declares the object
   * itself; false when only extensions of it are in the test app, so the object is a dependency's
   * or nothing visible (`outside` decides).
   */
  private testAppObject(
    kind: string,
    raw: string,
    member: string,
    args: number,
    label: string,
    st: ReachState,
  ): boolean {
    const us = this.objectsNamed(kind, raw);
    if (us.length === 0) return false;
    for (const u of us) this.reachUnit(u, st);
    const nm = this.norm(member);
    // Case 15: a procedure the object (or a test-app extension of it) declares is walked like a
    // codeunit's: every same-arity declaration. Complete, because a member call on an object
    // variable resolves only to the object's own procedures or to a built-in; a name the object
    // declares at another arity alone is not known to be a built-in, so it falls back.
    const named = us.filter((u) => u.procs.some((c) => c.name === nm));
    if (named.length > 0) {
      let matched = false;
      for (const u of named) if (this.reachCalls(u, member, args, st)) matched = true;
      if (!matched)
        fallBack(st, `${label} names a procedure of ${kind} ${raw.trim()} at no arity it declares`);
      return us.some((u) => !u.kind.endsWith("extension"));
    }
    // Case 16: a call that can fire a trigger walks EVERY trigger of the object and of the test
    // app's extensions of it, field and action triggers included (`enterObject`). Complete: which
    // trigger fires depends on runtime data, and every one is walked.
    const triggerCapable = kind === "table" ? RECORD_TRIGGER.has(nm) : RUN_MEMBER.test(member);
    if (triggerCapable) {
      for (const u of us) if (u.baseKey !== undefined) this.enterObject(u.baseKey, st);
    }
    // Case 6: any other member is a built-in that runs no test-app code; the object is reached.
    return us.some((u) => !u.kind.endsWith("extension"));
  }

  /**
   * Case 8, EXTERNAL: an object the test app does not declare. The test app compiled, so only a
   * dependency (or the platform) declares it, and the dependency fingerprint covers it. "Not in
   * the test app" is decided by resolving the name against the test app's own objects
   * (case-insensitively, the last dotted segment), NOT against the dependencies' symbol packages:
   * reading those cost about 500 MB on DO (RESULTS.md, r2) and adds no safety over a compile.
   * UNFOLLOWED instead (case 17) when the test app has parse damage that could hide the
   * declaration, or when the reference is not one plain name the resolver could check (an id, a
   * namespace-qualified name, any other shape): the orchestrator's condition on EXTERNAL.
   */
  private outside(
    kind: string,
    raw: string,
    label: string,
    st: ReachState,
    p?: Proc,
    argFacts: readonly ArgFact[] = NO_ARGS,
  ): void {
    if (this.anyDamage) {
      fallBack(
        st,
        `${label} (${kind} ${raw.trim()}) is not in the test app, which has parse errors that could hide it`,
      );
    } else if (!PLAIN_NAME.test(raw)) {
      fallBack(
        st,
        `${label} names ${kind} ${raw.trim()}, which is not one plain name the test app's objects can be checked against`,
      );
    } else if (p !== undefined) this.passesTestApp(p, argFacts, false, label, st);
  }

  private reachOn(
    rawType: string,
    receiver: string,
    member: string,
    args: number,
    st: ReachState,
    p: Proc,
    argFacts: readonly ArgFact[],
  ): void {
    const type = ARRAY_OF.exec(rawType)?.[1] ?? rawType;
    const nm = this.norm(member);
    const label = `${receiver}.${member}`;
    if (/^\s*interface\b/i.test(type)) {
      fallBack(st, `${label} dispatches through ${type.trim()}`); // case 12
      return;
    }
    if (/^\s*variant\s*$/i.test(type)) {
      // Case 13. A Variant's own methods are type tests (IsRecord, IsDecimal, ...): not edges.
      if (!/^is/i.test(member)) fallBack(st, `${label} is called on a Variant`);
      return;
    }
    if (/^\s*(recordref|fieldref)\b/i.test(type)) {
      // Case 14: a RecordRef/FieldRef call that can fire a trigger walks EVERY trigger (table and
      // field triggers) of EVERY test-app table and tableextension. Complete: the record's table
      // is not known statically, a test-app trigger can only be in one of those objects, and a
      // dependency's table is EXTERNAL through the dependency fingerprint.
      if (RECORD_TRIGGER.has(nm)) {
        for (const u of this.tableUnits)
          if (u.baseKey !== undefined) this.enterObject(u.baseKey, st);
      }
      return;
    }
    const m = OBJ_TYPE.exec(type);
    const kw = m?.[1]?.toLowerCase();
    const raw = m?.[2];
    if (kw === undefined || raw === undefined) {
      // A built-in type's method: not an edge, unless it is handed a reference to a test-app
      // object it may run (`Notification.AddAction(..., Codeunit::"X", ...)`).
      this.passesTestApp(p, argFacts, true, label, st);
      return;
    }
    const kind = KIND_OF[kw] ?? kw;
    if (kind === "codeunit") {
      const targets = this.unitsNamed(raw);
      if (targets.length > 0) {
        for (const t of targets) {
          this.reachUnit(t, st);
          if (!this.reachCalls(t, member, args, st) && nm === "run") this.runUnit(t, st);
        }
        return;
      }
      this.outside("codeunit", raw, label, st, p, argFacts);
      return;
    }
    if (this.testAppObject(kind, raw, member, args, label, st)) return;
    this.outside(kind, raw, label, st, p, argFacts);
  }

  /**
   * Every type text the value `r` can have, read in `p`, or a string saying why that is unknown.
   * An empty list means "not a test-app codeunit": a literal, an operator's result, a built-in's
   * return, an undeclared (system) name as for a plain receiver, or a member of a record, a
   * TestPage or a codeunit outside the test app (which cannot name a test-app type). Walks
   * nothing: every call inside `r` is its own call site.
   */
  private typesOf(p: Proc, r: Recv): string[] | string {
    switch (r.k) {
      case "value":
        return [];
      case "opaque":
        return `a ${r.kind}`;
      case "name": {
        const key = this.norm(r.name);
        if (key === "this") {
          if (p.unit.kind === "codeunit") return [`Codeunit ${p.unit.id}`];
          // In a table or tableextension `this` is the record; elsewhere it is not modelled.
          if (p.unit.kind.startsWith("table")) return [...(p.unit.implicit.get("rec") ?? [])];
          return `this in a ${p.unit.kind}`;
        }
        return [...(p.scope.get(key) ?? p.unit.globals.get(key) ?? p.unit.implicit.get(key) ?? [])];
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
        const name = this.norm(r.name);
        const procs = p.unit.procs.filter((c) => c.name === name && c.params === r.args);
        // None: a built-in, unless a with-statement's target could own it.
        if (procs.length === 0) return r.inWith ? `${r.name}() inside a with-statement` : [];
        return procs.flatMap((c) => c.returnType ?? []);
      }
      case "member": {
        const recvTypes = this.typesOf(p, r.recv);
        if (typeof recvTypes === "string") return recvTypes;
        const name = this.norm(r.member);
        const out: string[] = [];
        for (const t of recvTypes) {
          // External review r1 #2: a procedure of a test-app table, page or other object (or a
          // test-app extension of one) can return a test-app codeunit too. An object the test
          // app does not declare or extend is a dependency's, and cannot return a test-app type.
          let owners: Unit[];
          if (CODEUNIT_TYPE.test(t)) owners = this.unitsFor(t);
          else {
            const m = OBJ_TYPE.exec(ARRAY_OF.exec(t)?.[1] ?? t);
            const kw = m?.[1]?.toLowerCase();
            const raw = m?.[2];
            owners =
              kw === undefined || raw === undefined
                ? []
                : this.objectsNamed(KIND_OF[kw] ?? kw, raw);
          }
          for (const u of owners)
            for (const c of u.procs)
              if (c.name === name && c.params === r.args && c.returnType !== undefined)
                out.push(c.returnType);
        }
        return out;
      }
    }
  }
}

const OTHER_KIND = /^(\w+?)(extension)?_declaration$/;

/** Reads one file's objects and parse damage into plain facts; `parsed` is not kept. */
function scanFile(
  path: string,
  source: string,
  parsed: ReturnType<typeof parseAL>,
  units: Unit[],
  suspect: string[],
  others: Unit[],
  keys: Map<string, number>,
): void {
  const root = wrapRoot(parsed);
  const errors = errorOffsets(root);
  const objects = flattenPreproc(root.namedChildren).filter(
    (c) => c.rawKind.endsWith("_declaration") && c.rawKind !== "namespace_declaration",
  );
  for (const o of objects) {
    if (o.rawKind === "codeunit_declaration") {
      units.push(buildUnit(path, o, errors, source, keys));
      continue;
    }
    // R-371: every other object, for the digest's walk. The TestPage scan never reads these.
    const km = OTHER_KIND.exec(o.rawKind);
    if (km === null || nameNode(o) === undefined) continue;
    const base = km[1] ?? "";
    const isExt = km[2] !== undefined;
    let baseKey = `${base}:${normalizeAlName((nameNode(o)?.text ?? "").replace(/^"|"$/g, ""))}`;
    let extendsText: string | undefined;
    if (isExt) {
      const kids = o.namedChildren;
      const at = kids.findIndex((c) => c.rawKind === "extends_keyword");
      extendsText = at >= 0 ? kids[at + 1]?.text : undefined;
      baseKey = `${base}:${extendsText === undefined ? "" : lastSegment(extendsText)}`;
    }
    others.push(
      buildObjectUnit(
        path,
        o,
        errors,
        source,
        isExt ? `${base}extension` : base,
        baseKey,
        extendsText,
        keys,
      ),
    );
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

/**
 * R-371: parses every file ONCE into the plain facts both the TestPage scan and the per-test
 * digest read. No syntax node and no source text outlives this call: each span is hashed while
 * its file's tree is alive, and only the hash is kept.
 */
export function buildTestAppModel(
  files: ReadonlyArray<{ path: string; text: string }>,
): TestAppModel {
  const units: Unit[] = [];
  const objects: Unit[] = [];
  const suspect: string[] = [];
  const damaged: string[] = [];
  const fileHashes: string[] = [];
  // One counter for the whole app, so `Proc.key` is unique across it (`#if` arms, duplicates).
  const keys = new Map<string, number>();
  for (const f of files) {
    const parsed = parseAL(f.text);
    if (wrapRoot(parsed).hasError) damaged.push(f.path);
    scanFile(f.path, f.text, parsed, units, suspect, objects, keys);
    fileHashes.push(sha256(normalizeSource(f.text)));
  }
  return { units, objects, suspect, damaged, fileHashes: fileHashes.sort() };
}

export function analyzeTestPageSources(
  files: ReadonlyArray<{ path: string; text: string }>,
  tests: readonly TestMethodRef[],
): TestPageAnalysis {
  return analyzeTestPageModel(buildTestAppModel(files), tests);
}

export function analyzeTestPageModel(
  model: TestAppModel,
  tests: readonly TestMethodRef[],
): TestPageAnalysis {
  const { units, suspect } = model;
  const scanner = new Scanner(model);
  const refused = new Map<string, string>();
  const errors: string[] = [];
  for (const t of tests) {
    const label = `${t.codeunitName}.${t.method}`;
    if (t.file === undefined) {
      errors.push(`${label} has no file`);
      continue;
    }
    // EVERY codeunit with the test's id and EVERY parameterless procedure of its name: a codeunit
    // or a test declared in two `#if` arms is walked in both, never only the first (run 003).
    const decls = units
      .filter((u) => u.id === t.codeunitId)
      .flatMap((u) =>
        u.procs.filter((p) => p.name === normalizeAlName(t.method) && p.params === 0),
      );
    if (decls.length === 0) {
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
    for (const decl of decls) scanner.walk(decl, [], st);
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
  return scanTestPageModel(buildTestAppModel(files), tests);
}

/** R-371: the scan over a model already parsed, so the digest can share the one parse. */
export function scanTestPageModel(
  model: TestAppModel,
  tests: readonly TestMethodRef[],
): ReadonlyMap<string, string> {
  const { refused, errors } = analyzeTestPageModel(model, tests);
  if (errors.length > 0) throw new TestPageScanError(errors);
  return refused;
}

/** R421: `path` is the `/`-separated form (`discoveredRelPaths`); the file is read through its raw
 *  name. `platform` defaults to `process.platform`; tests pass `"win32"` to simulate Windows. */
export async function readTestAppSources(
  testDir: string,
  platform: NodeJS.Platform = process.platform,
): Promise<Array<{ path: string; text: string }>> {
  const entries = await readdir(testDir, { recursive: true });
  const alFiles = discoveredRelPaths(
    entries.filter((e) => e.toLowerCase().endsWith(".al")),
    platform,
  );
  return Promise.all(
    alFiles.map(async ({ rel, raw }) => ({
      path: rel,
      text: await readFile(join(testDir, raw), "utf8"),
    })),
  );
}

export async function scanTestPageTests(
  testDir: string,
  tests: readonly TestMethodRef[],
): Promise<ReadonlyMap<string, string>> {
  await initParser();
  return scanTestPageSources(await readTestAppSources(testDir), tests);
}
