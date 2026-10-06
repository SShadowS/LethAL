import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  type ALSyntaxNode,
  evaluateArms,
  hasDirectiveLine,
  maskAlNonCode,
  memberArms,
  parseAL,
  startsInInactiveArm,
  wrapRoot,
} from "@lethal/engine";
import type { TestMethodRef } from "./backend";
import { discoveredRelPaths } from "./line-filter";

const CODEUNIT_HEADER_GLOBAL = /codeunit\s+(\d+)\s+("([^"]+)"|(\w+))/gi;
const SUBTYPE_TEST = /Subtype\s*=\s*Test\s*;/i;
// `d`: R272 reads the name group's offset for the test's line.
const TEST_METHOD = /\[Test\]\s*(?:\[[^\]]*\]\s*)*procedure\s+("([^"]+)"|(\w+))\s*\(/dgi;

/** R272: the 1-based line of `offset` in `text`, counting `\n` (a CRLF line is one line). */
function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}
/** R420: one `[Test]` attribute token, read on the masked source. `TEST_METHOD` starts at one of
 *  these, so on one file the regex can never match more often than this does. */
const TEST_TOKEN = /\[\s*Test\s*\]/gi;

/**
 * R79: blank out everything the AL compiler does not read as code — comments AND string
 * literals — preserving every offset, so the sectioning regexes below see only code.
 *
 * Without this, PROSE of the shape `codeunit 50100 "Sales Post"` (ordinary AL commenting) opened
 * a bogus codeunit section; the rest of the file fell into it; it had no `Subtype = Test;`; and
 * every `[Test]` from that point on VANISHED. Silently: baseline green, empty `unsupportedTests`,
 * and the mutants those tests covered reported `no-coverage`. Measured on
 * `fixtures/sandbox-data-tests` — 22 `[Test]` in source, 21 discovered.
 *
 * Anchoring the header to line start would have fixed the comment case only; a string literal
 * carries the same shape mid-line. Masking fixes the class, and it fixes the other direction too:
 * a commented-out `Subtype = Test;` no longer promotes a helper codeunit into a test suite.
 *
 * R80: the state machine itself now lives in `@lethal/engine` (`maskAlNonCode`), shared with
 * schemata's `stripAlComments`, which had grown a second copy of it. Discovery keeps the
 * blank-string-contents policy — that is the half this bug turned on — while attribution keeps
 * the other; the flag records the difference instead of two lexers drifting apart.
 */
function maskNonCode(source: string): string {
  return maskAlNonCode(source, { blankStringContents: true });
}

/**
 * R79's second net. Every `[Test]` in a file must land inside some codeunit section, or a test
 * has been dropped by the parse rather than by a rule.
 *
 * The one LEGITIMATE way a discovered count comes out below the file's `[Test]` count is a
 * codeunit whose section carries no `Subtype = Test;` — a helper or handler codeunit, which BC
 * would refuse to run as a test anyway. Those `[Test]`s are still ATTRIBUTED to a section, so
 * they are counted here and the guard stays silent.
 *
 * What it catches is the other shape: a codeunit header `CODEUNIT_HEADER_GLOBAL` failed to match
 * at all, leaving its tests in no section — today that is a silent, total loss of that file's
 * suite, the same direction as the bug this guard was written alongside.
 *
 * R420: one count on both paths. Every `[Test]` TOKEN in the masked file (`tokens`, their offsets)
 * must be CONSUMED: by a test attributed to a codeunit (regex path: a `TEST_METHOD` match inside a
 * section, which starts at its token; tree path: a procedure the token decorates, in any codeunit),
 * or by a `test-shape-unsupported` warning. On the regex path, which runs only when the file's
 * token count equals its regex match count, this is exactly the pre-R420 check. On the tree path
 * it is what covers the candidates the regex never saw. `exempt` (tree path only) excuses a token
 * the parser places inside a procedure BODY, which no attribute can be: `Arr[Test]` indexes an
 * array by a variable named `Test`; since the R420 review, only in an object with no parse error
 * (`bodyToken`).
 */
function assertEveryTestConsumed(
  rel: string,
  tokens: readonly number[],
  consumed: ReadonlySet<number>,
  exempt: (offset: number) => boolean = () => false,
): void {
  const counted = tokens.filter((o) => consumed.has(o) || !exempt(o));
  const lost = counted.filter((o) => !consumed.has(o)).length;
  if (lost === 0) return;
  throw new Error(
    `Test discovery lost ${lost} of ${counted.length} [Test] procedures in "${rel}": they lie outside every codeunit section, so no codeunit id could be attributed to them. That means a codeunit header in this file did not parse, or a [Test] is followed by a declaration LethAL does not recognise (please report the shape; see R420). Refusing rather than reporting a smaller suite, which would silently turn the mutants those tests cover into no-coverage.`,
  );
}

/** R420: the offset of every `[Test]` token in a masked source. */
function testTokenOffsets(masked: string): number[] {
  return Array.from(masked.matchAll(TEST_TOKEN), (m) => m.index);
}

export interface DiscoverOptions {
  /**
   * R45: glob patterns naming which test FILES may contribute tests, matched against the
   * test-dir-relative path with forward slashes. Absent (or empty) means the whole suite.
   *
   * This narrows the BASELINE, which is where a real project's run time goes: measured on
   * Continia Document Output, baseline was 744.8s of a 953.8s run (78%), executing all 1,246
   * discovered tests for a run scoped by `--only` to a single codeunit. `--only` selects mutants,
   * not tests, so it does not touch that phase at all.
   *
   * UNLIKE `--only`, this narrowing can change VERDICTS in the unsafe direction: excluding the
   * test that would have killed a mutant turns that mutant into a survivor, and a false survivor
   * is the worst output this tool produces (R29). It is a deliberate speed/accuracy trade the
   * caller opts into, so it is recorded as a report caveat rather than treated as free.
   */
  readonly only?: readonly string[];
  /**
   * R421: the platform whose path rules apply to the discovered file names (`discoveredRelPaths`).
   * Absent means `process.platform`; tests pass `"win32"` to simulate a Windows readdir.
   */
  readonly platform?: NodeJS.Platform;
}

/**
 * Which test files a `--tests-only` pattern set admits, with the "matches nothing" refusal.
 *
 * Refusing matters more here than for `--only`: a pattern that silently matched no test file
 * would discover zero tests, and every mutant would then land as `no-coverage` (or, on a
 * coverage-less backend, be scored against nothing at all) — a confident-looking run over an
 * empty suite.
 */
function admittedTestFiles(
  relPaths: readonly string[],
  only: readonly string[],
): ReadonlySet<string> | undefined {
  if (only.length === 0) return undefined;
  const admitted = new Set<string>();
  const unmatched: string[] = [];
  for (const pattern of only) {
    const glob = new Bun.Glob(pattern);
    let matchedAny = false;
    for (const rel of relPaths) {
      if (glob.match(rel.replaceAll("\\", "/"))) {
        admitted.add(rel);
        matchedAny = true;
      }
    }
    if (!matchedAny) unmatched.push(pattern);
  }
  if (unmatched.length > 0) {
    throw new Error(
      `--tests-only matched no test file for ${unmatched.length === 1 ? "pattern" : "patterns"} ${unmatched.map((p) => `"${p}"`).join(", ")}. Patterns are matched against test-dir-relative paths using forward slashes (e.g. "Src/Documents/**"). Refusing rather than running with an empty test suite, which would report every mutant as no-coverage.`,
    );
  }
  return admitted;
}

/**
 * Every `[Test]` one AL SOURCE STRING declares, attributed to its codeunit.
 *
 * Split out of `discoverTests` for R139 check 2, which asks the same question of AL that came back
 * from the SERVER (inside the published app package) rather than off disk. Sharing this function
 * is the point: comparing a local list built by this parser against a remote list built by a second
 * one would report differences that are parser disagreements, and "your published app is missing a
 * test" is the wrong thing to say when the truth is "two regexes disagree".
 */
export function testsInAlSource(rel: string, source: string): TestMethodRef[] {
  return testsOfFile(rel, source).found.map((t) => t.ref);
}

/** One discovered test, with every offset the arm filter needs (UTF-16 code units, the unit the
 *  parser's offsets are in; the mask keeps every offset). */
interface FoundTest {
  readonly ref: TestMethodRef;
  /** The first `[Test]` attribute's offset: where the regex's match starts. */
  readonly offset: number;
  /** R420: every `[Test]` attribute that decorates the procedure, in any `#if` arm (the regex
   *  path: `[offset]`). The test is in a build when at least one of them is compiled in. */
  readonly testOffsets: readonly number[];
  /** R420, tree path: where the procedure starts, which must be compiled in too (a `[Test]` before
   *  an `#if` holding one whole procedure per arm decorates each arm's procedure). */
  readonly procedureOffset?: number;
  /** R420 review, tree path, index-aligned with `testOffsets`: each `[Test]` decorates this
   *  procedure only when every procedure at these offsets is compiled OUT. They are the procedures
   *  in an `#if`'s arms that would have taken the attribute first (S12: `[Test] #if X procedure A
   *  #endif procedure Helper`, where `Helper` is a test only when `A` is not compiled). Absent when
   *  no `[Test]` of the test has such a condition. */
  readonly unless?: ReadonlyArray<readonly number[]>;
}

/** R420 review: the parser's test list lost a test the regex found in the same file. The regex is
 *  only consulted on the tree path to name what the tree added, so without this check a test the
 *  parser swallowed (a mis-nested member read as a body) would vanish silently. */
export class TreeDiscoveryMismatchError extends Error {
  constructor(
    readonly file: string,
    /** `<codeunit id>.<method>` for each regex-found test the tree did not return, sorted. */
    readonly missing: readonly string[],
  ) {
    super(
      `Test discovery's parser did not return ${missing.length} test(s) the regular expression found in "${file}": ${missing.join(", ")}. The file most likely holds a syntax error that makes the parser read those procedures as part of another one, or the file uses a construct the parser (tree-sitter-al) does not read correctly yet; please report the file. Refusing rather than reporting a smaller suite, which would silently turn the mutants those tests cover into no-coverage (see R420).`,
    );
    this.name = "TreeDiscoveryMismatchError";
  }
}

/** R420: a test declaration discovery read and could not take, named rather than dropped
 *  silently. Emitted by `runSession` as a `warning` event with this code. */
export interface DiscoveryWarning {
  readonly code: "test-shape-unsupported";
  readonly file: string;
  readonly message: string;
}

/** R420: one file's tests, from the regex or (where the regex is blind) the parsed tree. */
interface FileTests {
  readonly found: FoundTest[];
  readonly warnings: DiscoveryWarning[];
  /** Tests the tree returned that the regex did not (empty on the regex path). */
  readonly treeOnly: TestMethodRef[];
  /** R424: tests the tree returned from a split-header procedure (empty on the regex path). */
  readonly split: TestMethodRef[];
  /** The tree path's parse, reused by the arm filter so a file is parsed once. */
  readonly root?: ALSyntaxNode;
}

/**
 * R420: the trigger. The regex result stands when the file's `[Test]` token count equals its regex
 * match count, which holds for every committed fixture, so their discovery is byte-identical and
 * adds no parse (R-371's budget). When the counts differ, some `[Test]` has a declaration the regex
 * cannot read (an `#if`, `#pragma` or `#region` line between it and `procedure`, an `internal`
 * modifier, ...), and the tree finder replaces the regex for the whole file.
 */
function testsOfFile(rel: string, source: string): FileTests {
  const masked = maskNonCode(source);
  const tokens = testTokenOffsets(masked);
  const regexMatches = Array.from(masked.matchAll(TEST_METHOD)).length;
  if (tokens.length === regexMatches) {
    const regex = regexTests(rel, masked);
    assertEveryTestConsumed(rel, tokens, regex.consumed);
    return { found: regex.found, warnings: [], treeOnly: [], split: [] };
  }
  const tree = treeTests(rel, source, masked);
  const regexFound = regexTests(rel, masked).found;
  assertTreeHoldsRegex(rel, regexFound, tree.found);
  assertEveryTestConsumed(rel, tokens, tree.consumed, (o) => bodyToken(tree.root, o));
  const regexKeys = new Set(regexFound.map((t) => refKey(t.ref)));
  return {
    found: tree.found,
    warnings: tree.warnings,
    treeOnly: tree.found.filter((t) => !regexKeys.has(refKey(t.ref))).map((t) => t.ref),
    split: tree.split,
    root: tree.root,
  };
}

function refKey(ref: TestMethodRef): string {
  return `${ref.codeunitId}:${ref.method.toLowerCase()}`;
}

/** R420 review: on the tree path every test the regex found must be among the tree's candidates
 *  (every arm, before arm filtering), by codeunit id and method, case-insensitive. */
function assertTreeHoldsRegex(
  rel: string,
  regexFound: readonly FoundTest[],
  treeFound: readonly FoundTest[],
): void {
  const treeKeys = new Set(treeFound.map((t) => refKey(t.ref)));
  const missing = regexFound
    .filter((t) => !treeKeys.has(refKey(t.ref)))
    .map((t) => `${t.ref.codeunitId}.${t.ref.method}`);
  if (missing.length > 0) throw new TreeDiscoveryMismatchError(rel, [...new Set(missing)].sort());
}

/** The regex finder (pre-R420 discovery), on the masked source. `consumed`: the token each match
 *  inside a codeunit section starts at. */
function regexTests(
  rel: string,
  masked: string,
): { readonly found: FoundTest[]; readonly consumed: Set<number> } {
  const found: FoundTest[] = [];
  const consumed = new Set<number>();
  // R79: section on CODE only. Prose of the shape `codeunit 50100 "Sales Post"` used to open a
  // bogus section and swallow every [Test] below it, without a word anywhere.
  const codeunitMatches = Array.from(masked.matchAll(CODEUNIT_HEADER_GLOBAL));

  for (let i = 0; i < codeunitMatches.length; i++) {
    const headerMatch = codeunitMatches[i];
    if (!headerMatch || headerMatch.index === undefined) continue;

    const codeunitId = Number(headerMatch[1]);
    const codeunitName = headerMatch[3] ?? headerMatch[4] ?? "";

    // Determine section boundaries: from this header to the next (or end of file)
    const sectionStart = headerMatch.index;
    const nextMatch = codeunitMatches[i + 1];
    const sectionEnd = nextMatch?.index ?? masked.length;

    const section = masked.substring(sectionStart, sectionEnd);
    const isTestCodeunit = SUBTYPE_TEST.test(section);

    for (const m of section.matchAll(TEST_METHOD)) {
      const offset = sectionStart + m.index;
      // Attributed to a section, test codeunit or not (a helper's `[Test]` is not lost).
      consumed.add(offset);
      if (!isTestCodeunit) continue;
      const nameAt = sectionStart + (m.indices?.[1]?.[0] ?? m.index);
      found.push({
        ref: {
          codeunitId,
          codeunitName,
          method: m[2] ?? m[3] ?? "",
          file: rel,
          line: lineAt(masked, nameAt),
        },
        offset,
        testOffsets: [offset],
      });
    }
  }
  return { found, consumed };
}

/** R420: exported for the tree = regex test only. The regex finder's result for one file, with
 *  each test's `[Test]` offset, and R79's guard. */
export function regexTestsWithOffsets(
  rel: string,
  source: string,
): Array<{ readonly ref: TestMethodRef; readonly offset: number }> {
  const masked = maskNonCode(source);
  const regex = regexTests(rel, masked);
  assertEveryTestConsumed(rel, testTokenOffsets(masked), regex.consumed);
  return regex.found.map((t) => ({ ref: t.ref, offset: t.offset }));
}

/** R420: exported for the tree = regex test only. The tree finder forced on for one file, with
 *  R79's guard, whatever the trigger would choose. The caller must have called `initParser()`. */
export function treeTestsWithOffsets(
  rel: string,
  source: string,
): {
  readonly tests: Array<{ readonly ref: TestMethodRef; readonly offset: number }>;
  readonly warnings: readonly DiscoveryWarning[];
} {
  const masked = maskNonCode(source);
  const tree = treeTests(rel, source, masked);
  assertEveryTestConsumed(rel, testTokenOffsets(masked), tree.consumed, (o) =>
    bodyToken(tree.root, o),
  );
  return {
    tests: tree.found.map((t) => ({ ref: t.ref, offset: t.offset })),
    warnings: tree.warnings,
  };
}

/** Grammar extras that sit between a member's attributes and the member (tree-sitter-al 4.4.1). */
const MEMBER_TRIVIA: ReadonlySet<string> = new Set([
  "comment",
  "multiline_comment",
  "pragma",
  "preproc_region",
  "preproc_endregion",
]);
/** A procedure header split by `#if` (S10, R424): one name per arm, one shared body. A preamble has
 *  a `var` section per arm as well (measured: `[Test]` before it compiles exactly one arm's name). */
const SPLIT_PROCEDURES: ReadonlySet<string> = new Set([
  "preproc_split_procedure",
  "preproc_split_procedure_preamble",
]);

/** `[Test]`: named `Test` (case-insensitive), no arguments, and parsed cleanly. An attribute with
 *  an ERROR node (`[Test, HandlerFunctions(...)]`, which alc rejects as AL0104) is not a test. */
function isTestAttribute(item: ALSyntaxNode): boolean {
  if (item.hasError) return false;
  const content = item.childForFieldName("attribute");
  if (content === null || content.childForFieldName("arguments") !== null) return false;
  return content.childForFieldName("name")?.text.toLowerCase() === "test";
}

/** AL's name as the regex reads it: `"My Test"` -> `My Test`. */
function unquote(name: string): string {
  return name.startsWith('"') && name.endsWith('"') && name.length >= 2 ? name.slice(1, -1) : name;
}

/** Every codeunit in a file, in source order, through `#if`-wrapped objects (a codeunit inside
 *  `preproc_conditional_object`) and header-split ones (`preproc_split_declaration`). */
function codeunitsOf(n: ALSyntaxNode, out: ALSyntaxNode[] = []): ALSyntaxNode[] {
  for (const c of n.children) {
    if (c.rawKind === "codeunit_declaration") out.push(c);
    else if (
      c.rawKind === "preproc_split_declaration" &&
      c.children.some((k) => k.rawKind === "codeunit_keyword")
    ) {
      out.push(c);
    } else if (c.rawKind === "preproc_conditional_object") codeunitsOf(c, out);
  }
  return out;
}

/** The codeunit's id and name. A header split by `#if` has one per arm: the LAST is taken, as the
 *  regex's sectioning does (each header opens a section; the body falls in the last one). */
function codeunitHeader(cu: ALSyntaxNode): { readonly id: number; readonly name: string } {
  const last = (field: string) => cu.children.filter((c) => c.fieldName === field).at(-1);
  return {
    id: Number(last("object_id")?.text ?? Number.NaN),
    name: unquote(last("object_name")?.text ?? ""),
  };
}

/** Whether `offset` lies inside a procedure or trigger body (`code_block`). */
function insideCodeBlock(root: ALSyntaxNode, offset: number): boolean {
  let n: ALSyntaxNode | undefined = root;
  while (n !== undefined) {
    if (n.rawKind === "code_block") return true;
    n = n.children.find((c) => c.startIndex <= offset && offset < c.endIndex);
  }
  return false;
}

/**
 * R79's exemption on the tree path: a `[Test]` token inside a body (`Arr[Test]`), which no
 * attribute can be. R420 review: only where the object holding it parsed cleanly (no ERROR or
 * MISSING node). In an object with a syntax error the parser can read a mis-nested member as part
 * of the body before it, and exempting that member's `[Test]` would drop the test silently.
 */
function bodyToken(root: ALSyntaxNode, offset: number): boolean {
  const object = root.children.find((c) => c.startIndex <= offset && offset < c.endIndex);
  if (object === undefined || object.hasError) return false;
  return insideCodeBlock(object, offset);
}

/**
 * R420: the tree finder. For each codeunit (a Test codeunit decided exactly as `SUBTYPE_TEST`
 * decides it on the regex path: `Subtype = Test` in ANY arm), it walks the members in order with
 * a list of pending `[Test]` attributes:
 * - an `attribute_item` that is `[Test]` is added (any other attribute keeps the list);
 * - comments, `#pragma`, `#region` and `#endregion` are skipped;
 * - a `preproc_conditional` is walked arm by arm, each arm from the list as it stood before the
 *   `#if`, so a `[Test]` inside `#if` (S2, S9), a handler list inside `#if` (S1, S3), a whole
 *   member inside `#if` (R403's shape) and `[Test]` before one whole procedure per arm (S11) all
 *   read as the compiler reads them. What leaves the `#if` is `conditional`'s union (S12, S12b);
 * - a `procedure` with a pending `[Test]` is a candidate; the list is then cleared;
 * - a split-header procedure (S10, R424) gives one candidate per arm that carries a `[Test]`, the
 *   pending list's or the arm's own; its `procedureOffset` is the arm's NAME. A pending `[Test]`
 *   is consumed by the split member as a whole, an arm's own by that arm. Only an arm whose name
 *   cannot be read gets a `test-shape-unsupported` warning;
 * - any other node clears the list.
 */
interface Pending {
  /** The `[Test]` attribute's offset. */
  readonly at: number;
  /** It decorates the next procedure only when every procedure (or node) at these offsets is
   *  compiled out (`FoundTest.unless`). */
  readonly unless: readonly number[];
}
interface StepResult {
  readonly pending: readonly Pending[];
  /** The offsets of the nodes that ended a non-empty pending list. */
  readonly enders: readonly number[];
}
function treeTests(
  rel: string,
  source: string,
  masked: string,
): {
  readonly found: FoundTest[];
  readonly consumed: Set<number>;
  readonly warnings: DiscoveryWarning[];
  readonly root: ALSyntaxNode;
  /** R424: every candidate that is an arm of a split-header procedure. */
  readonly split: TestMethodRef[];
} {
  const root = wrapRoot(parseAL(source));
  const found: FoundTest[] = [];
  const consumed = new Set<number>();
  const warnings: DiscoveryWarning[] = [];
  const split: TestMethodRef[] = [];

  for (const cu of codeunitsOf(root)) {
    const { id: codeunitId, name: codeunitName } = codeunitHeader(cu);
    // No readable id: its `[Test]` tokens stay unconsumed, and R79's guard refuses the file.
    if (!Number.isInteger(codeunitId)) continue;
    const isTestCodeunit = SUBTYPE_TEST.test(masked.slice(cu.startIndex, cu.endIndex));
    const body = cu.childForFieldName("body");
    if (body === null) continue;

    /** One member; returns the pending list after it and the offset of every node that ended a
     *  non-empty pending list (a procedure that took it, or a node that cleared it). */
    const step = (n: ALSyntaxNode, pending: readonly Pending[]): StepResult => {
      if (n.rawKind === "attribute_item") {
        return {
          pending: isTestAttribute(n) ? [...pending, { at: n.startIndex, unless: [] }] : pending,
          enders: [],
        };
      }
      if (MEMBER_TRIVIA.has(n.rawKind)) return { pending, enders: [] };
      if (n.rawKind === "preproc_conditional") return conditional(n, pending);
      if (n.rawKind === "procedure") {
        if (pending.length === 0) return { pending: [], enders: [] };
        for (const p of pending) consumed.add(p.at);
        const nameNode = n.childForFieldName("name");
        if (isTestCodeunit && nameNode !== null) {
          const [first] = pending;
          found.push({
            ref: {
              codeunitId,
              codeunitName,
              method: unquote(nameNode.text),
              file: rel,
              line: nameNode.startPosition.row + 1,
            },
            offset: first?.at ?? n.startIndex,
            testOffsets: pending.map((p) => p.at),
            procedureOffset: n.startIndex,
            ...(pending.some((p) => p.unless.length > 0)
              ? { unless: pending.map((p) => p.unless) }
              : {}),
          });
        }
        return { pending: [], enders: [n.startIndex] };
      }
      if (SPLIT_PROCEDURES.has(n.rawKind)) {
        // R424: one candidate per arm that carries `[Test]`, through the run before the split
        // node (V1) or the arm's own attribute (V4). Each arm is filtered by where its NAME
        // starts, so exactly the compiled arm's name is in a decided build.
        const arms = memberArms(n).map((arm) => ({
          name: arm.find((c) => c.fieldName === "name"),
          own: arm
            .filter((c) => c.rawKind === "attribute_item" && isTestAttribute(c))
            .map((c) => c.startIndex),
        }));
        const all = [...pending.map((p) => p.at), ...arms.flatMap((a) => a.own)];
        if (all.length === 0) return { pending: [], enders: [] };
        for (const o of all) consumed.add(o);
        if (!isTestCodeunit) return { pending: [], enders: [n.startIndex] };
        const unnamed: number[] = [];
        for (const [i, arm] of arms.entries()) {
          const own: Pending[] = arm.own.map((at) => ({ at, unless: [] }));
          const tests = [...pending, ...own];
          if (tests.length === 0) continue;
          if (arm.name === undefined) {
            unnamed.push(i + 1);
            continue;
          }
          const [first] = tests;
          const ref = {
            codeunitId,
            codeunitName,
            method: unquote(arm.name.text),
            file: rel,
            line: arm.name.startPosition.row + 1,
          };
          found.push({
            ref,
            offset: first?.at ?? n.startIndex,
            testOffsets: tests.map((p) => p.at),
            procedureOffset: arm.name.startIndex,
            ...(tests.some((p) => p.unless.length > 0)
              ? { unless: tests.map((p) => p.unless) }
              : {}),
          });
          split.push(ref);
        }
        if (unnamed.length > 0) {
          warnings.push({
            code: "test-shape-unsupported",
            file: rel,
            message: `[lethal] "${rel}": a [Test] procedure in codeunit ${codeunitId} "${codeunitName}" has its header split by #if/#else, and LethAL could not read the name in arm ${unnamed.join(", ")}. That arm's test is NOT run, and the mutants only it would kill can score survived or no-coverage (see R424).`,
          });
        }
        return { pending: [], enders: [n.startIndex] };
      }
      return { pending: [], enders: pending.length > 0 ? [n.startIndex] : [] };
    };

    /**
     * An `#if`: every arm starts from the list as it stood before it (`before`), since only one
     * arm is compiled. What leaves the `#if` is the union of what leaves each arm:
     * - an attribute an arm added and did not consume, guarded by its own offset as before;
     * - an entry of `before` that some arm, or the implicit empty arm of an `#if` with no `#else`
     *   (measured, S12 and S12b), lets through. It now decorates the next procedure only when
     *   every node that ended the list in some arm is compiled out, so its `unless` gains them
     *   all. That is exact: the enders lie inside arms, and those of the arms not compiled in are
     *   compiled out anyway. An `#if` with an `#else` whose every arm ended the list lets nothing
     *   of `before` through.
     */
    const conditional = (n: ALSyntaxNode, before: readonly Pending[]): StepResult => {
      const beforeAt = new Set(before.map((p) => p.at));
      const through = new Map<number, Set<number>>();
      const added: Pending[] = [];
      const enders: number[] = [];
      let hasElse = false;
      let arm: readonly Pending[] = before;
      const endArm = (): void => {
        for (const p of arm) {
          if (!beforeAt.has(p.at)) {
            added.push(p);
            continue;
          }
          const guards = through.get(p.at) ?? new Set<number>();
          for (const g of p.unless) guards.add(g);
          through.set(p.at, guards);
        }
      };
      for (const c of n.children) {
        if (c.rawKind === "preproc_elif" || c.rawKind === "preproc_else") {
          endArm();
          hasElse ||= c.rawKind === "preproc_else";
          arm = before;
          continue;
        }
        if (c.rawKind === "preproc_if" || c.rawKind === "preproc_endif") continue;
        const r = step(c, arm);
        arm = r.pending;
        enders.push(...r.enders);
      }
      endArm();
      if (!hasElse) {
        // The implicit empty arm: compiled when no explicit arm is, and it consumes nothing.
        arm = before;
        endArm();
      }
      const kept = before
        .filter((p) => through.has(p.at))
        .map((p) => ({
          at: p.at,
          unless: [...new Set([...(through.get(p.at) ?? []), ...enders])],
        }));
      return { pending: [...kept, ...added], enders };
    };

    let pending: readonly Pending[] = [];
    for (const member of body.children) pending = step(member, pending).pending;
  }
  return { found, consumed, warnings, root, split };
}

/** R403 phase B: the id of every codeunit `source` declares (on code only, every arm read). The
 *  `--tests-only` scope for the compiled-membership check maps a compiled codeunit to its file
 *  through these, BEFORE arm filtering, so a codeunit whose tests are all compiled out of the
 *  local build is still in scope. */
function declaredCodeunitIds(source: string): number[] {
  return Array.from(maskNonCode(source).matchAll(CODEUNIT_HEADER_GLOBAL), (m) => Number(m[1]));
}

/** An `#if` or `#endif` line (`#elif` / `#else` stay inside the same region). */
const REGION_LINE = /^﻿?[ \t]*#[ \t]*(if|endif)\b/gim;

/**
 * R403 phase B: whether a `[Test]` at `offset` lies between an `#if` and its `#endif`, in ANY
 * arm. That is the test whose membership depends on the build's symbols, which is what the
 * `test-symbols-unverified` caveat names when no compiled package can say which build was
 * published. Read on the masked source, so a directive inside a comment does not count; an
 * unbalanced file counts every test as conditional (the caveat errs toward naming a file).
 */
function conditionalTestOffsets(source: string, offsets: readonly number[]): boolean[] {
  const marks = Array.from(maskNonCode(source).matchAll(REGION_LINE), (m) => ({
    at: m.index,
    open: (m[1] ?? "").toLowerCase() === "if",
  }));
  let depth = 0;
  for (const m of marks) {
    depth += m.open ? 1 : -1;
    if (depth < 0) return offsets.map(() => true);
  }
  if (depth !== 0) return offsets.map(() => true);
  return offsets.map((offset) => {
    let d = 0;
    for (const m of marks) {
      if (m.at >= offset) break;
      d += m.open ? 1 : -1;
    }
    return d > 0;
  });
}

/** R403: one file's arms under `buildSymbols`. `filtered` keeps undecided files' tests. */
function armsOfFile(
  rel: string,
  source: string,
  file: Pick<FileTests, "found" | "root">,
  buildSymbols: readonly string[],
): { filtered: TestMethodRef[]; excluded: TestExclusion[]; directive: boolean } {
  const { found } = file;
  const directive = hasDirectiveLine(source);
  // A file with no directive line compiles every test it declares; skipping its parse keeps
  // `lethal verify` at one parse per test file (R-371).
  if (found.length === 0 || !directive) {
    return { filtered: found.map((t) => t.ref), excluded: [], directive };
  }
  const filtered: TestMethodRef[] = [];
  const excluded: TestExclusion[] = [];
  // Offsets: `evaluateArms` returns offsets into the RAW source, in UTF-16 code units (the native
  // parser's unit). The regex matches on the masked source, which keeps every offset (R403 fixed
  // `maskAlNonCode` for characters outside the BMP), so the two compare directly. R420: the tree
  // path's parse is reused, so a file is never parsed twice here.
  const arms = evaluateArms(file.root ?? wrapRoot(parseAL(source)), source, buildSymbols);
  for (const { ref, testOffsets, procedureOffset, unless } of found) {
    // R420: in the build when the procedure is compiled in and at least one of its `[Test]`
    // attributes is (S2: the only `[Test]` is inside `#if`; S9: one `[Test]` per arm), with every
    // procedure that would have taken that attribute first compiled out (S12, S12b).
    const compiledIn = (inactive: readonly (readonly [number, number])[]): boolean =>
      (procedureOffset === undefined || !startsInInactiveArm(inactive, procedureOffset)) &&
      testOffsets.some(
        (o, i) =>
          !startsInInactiveArm(inactive, o) &&
          (unless?.[i] ?? []).every((g) => startsInInactiveArm(inactive, g)),
      );
    if (arms.kind === "undecided") {
      filtered.push(ref);
      excluded.push({
        test: ref,
        file: rel,
        reason: "preproc-undecided-kept",
        detail: arms.reason,
      });
    } else if (!compiledIn(arms.inactive)) {
      excluded.push({ test: ref, file: rel, reason: "compiled-out" });
    } else {
      filtered.push(ref);
    }
  }
  return { filtered, excluded, directive };
}

/**
 * R403 phase B: `testsInAlSource` with the arm filter applied under `buildSymbols`, exactly as
 * arm-aware discovery applies it (undecided files keep every test). R139's source-to-source
 * comparison runs this over the PUBLISHED package's source when the session runs the filtered
 * suite, so both sides are filtered alike. The caller must have called `initParser()`.
 */
export function armFilteredTestsInAlSource(
  rel: string,
  source: string,
  buildSymbols: readonly string[],
): TestMethodRef[] {
  return armsOfFile(rel, source, testsOfFile(rel, source), buildSymbols).filtered;
}

/** R403: options for arm-aware discovery. `buildSymbols` is the TEST app's derived symbol set
 *  (`effectiveBuildSymbols(testDir, ...)`: the config's symbols, the test `app.json`'s, and on
 *  al-runner its measured predefined ones). A file's own `#define` / `#undef` are applied per file
 *  by `evaluateArms`. The caller must have called `initParser()`: each file with a `[Test]` is
 *  parsed, and an uninitialised parser throws. */
export interface ArmAwareDiscoverOptions extends DiscoverOptions {
  readonly buildSymbols: readonly string[];
}

/** R403: why a discovered `[Test]` is recorded. `compiled-out`: its attribute starts in an arm the
 *  build compiles out, so it is not in the filtered list. `preproc-undecided-kept`: its file's arms
 *  could not be evaluated exactly as alc does (`evaluateArms` returned `undecided`), so it is KEPT
 *  in the filtered list, as before R403, and recorded. */
export type TestExclusionReason = "compiled-out" | "preproc-undecided-kept";

export interface TestExclusion {
  readonly test: TestMethodRef;
  readonly file: string;
  readonly reason: TestExclusionReason;
  /** `preproc-undecided-kept` only: `evaluateArms`'s reason code (never source text). */
  readonly detail?: string;
}

/**
 * R403: both lists, because the choice between them depends on evidence not known at discovery
 * time (plan §7): on al-runner the filtered list is the suite al-runner compiles; on bcdev only the
 * published package's compiled membership can say which build is published (R-403 phase B).
 */
export interface ArmAwareDiscovery {
  /** The symbol set the arms were evaluated under, as passed. */
  readonly buildSymbols: readonly string[];
  /** Every discovered test whose `[Test]` is not compiled out under `buildSymbols`. */
  readonly filtered: TestMethodRef[];
  /** Every discovered test, every arm read: exactly what `discoverTests` returned before R403. */
  readonly unfiltered: TestMethodRef[];
  /** Every `compiled-out` test and every `preproc-undecided-kept` one, in discovery order. */
  readonly excluded: readonly TestExclusion[];
  /** Whether any test file discovery read (within `only`) holds a directive line. When none
   *  does, no symbol set can change the suite, so the resume fingerprint omits the test set. */
  readonly anyDirective: boolean;
  /**
   * R403 phase B: with `--tests-only`, the id of every codeunit declared in an admitted file, every
   * arm read (BEFORE arm filtering). The compiled-membership check compares only the compiled
   * codeunits in this set. Absent when nothing narrowed the suite: every compiled codeunit is in
   * scope.
   */
  readonly inScopeCodeunits?: ReadonlySet<number>;
  /** R403 phase B: every file in scope with a `[Test]` between an `#if` and its `#endif` (any arm),
   *  or in a file whose arms are undecided, sorted. What `test-symbols-unverified` names. */
  readonly conditionalTestFiles: readonly string[];
  /** R420: test declarations discovery read and could not take (`test-shape-unsupported`; since
   *  R424 only a split-header arm whose name cannot be read), in file order. `runSession` emits
   *  each as a warning. */
  readonly warnings: readonly DiscoveryWarning[];
  /** R420: every test (unfiltered, every arm) the tree finder returned that the regex did not.
   *  Non-empty means the suite differs from what discovery returned before R420, which the resume
   *  fingerprint records as `tree-v1`. */
  readonly treeOnlyTests: readonly TestMethodRef[];
  /** R424: every test (unfiltered, every arm) the tree finder returned from a split-header
   *  procedure. Non-empty means the suite differs from what discovery returned before R424, which
   *  the resume fingerprint records as `split-v1`. */
  readonly splitTests: readonly TestMethodRef[];
}

/**
 * Every `[Test]` in the test project. Without `buildSymbols` it reads every `#if` arm and returns
 * the list (the pre-R403 shape, kept for every caller that has no symbol set). With `buildSymbols`
 * it also evaluates each file's arms and returns both lists (`ArmAwareDiscovery`).
 */
export async function discoverTests(
  testDir: string,
  options?: DiscoverOptions,
): Promise<TestMethodRef[]>;
export async function discoverTests(
  testDir: string,
  options: ArmAwareDiscoverOptions,
): Promise<ArmAwareDiscovery>;
export async function discoverTests(
  testDir: string,
  options: DiscoverOptions | ArmAwareDiscoverOptions = {},
): Promise<TestMethodRef[] | ArmAwareDiscovery> {
  const buildSymbols = "buildSymbols" in options ? options.buildSymbols : undefined;
  const unfiltered: TestMethodRef[] = [];
  const filtered: TestMethodRef[] = [];
  const excluded: TestExclusion[] = [];
  let anyDirective = false;
  const conditionalTestFiles: string[] = [];
  const warnings: DiscoveryWarning[] = [];
  const treeOnlyTests: TestMethodRef[] = [];
  const splitTests: TestMethodRef[] = [];
  const entries = await readdir(testDir, { recursive: true });
  // R421: normalised to `/` once and sorted in that form; matched and labelled with `rel`, read
  // through the raw name.
  const discovered = discoveredRelPaths(
    entries.filter((e) => e.toLowerCase().endsWith(".al")),
    options.platform,
  );
  const admitted = admittedTestFiles(
    discovered.map((d) => d.rel),
    options.only ?? [],
  );
  const inScopeCodeunits = admitted !== undefined ? new Set<number>() : undefined;
  for (const { rel, raw } of discovered) {
    if (admitted !== undefined && !admitted.has(rel)) continue;
    const source = await readFile(join(testDir, raw), "utf8");
    const file = testsOfFile(rel, source);
    const { found } = file;
    unfiltered.push(...found.map((t) => t.ref));
    warnings.push(...file.warnings);
    treeOnlyTests.push(...file.treeOnly);
    splitTests.push(...file.split);
    if (buildSymbols === undefined) continue;
    if (inScopeCodeunits !== undefined) {
      for (const id of declaredCodeunitIds(source)) inScopeCodeunits.add(id);
    }
    const arms = armsOfFile(rel, source, file, buildSymbols);
    anyDirective ||= arms.directive;
    filtered.push(...arms.filtered);
    excluded.push(...arms.excluded);
    if (
      arms.directive &&
      found.length > 0 &&
      (arms.excluded.length > 0 ||
        conditionalTestOffsets(
          source,
          found.flatMap((t) => [
            ...t.testOffsets,
            ...(t.procedureOffset !== undefined ? [t.procedureOffset] : []),
            ...(t.unless ?? []).flat(),
          ]),
        ).some((c) => c))
    ) {
      conditionalTestFiles.push(rel);
    }
  }
  if (buildSymbols === undefined) return unfiltered;
  return {
    buildSymbols,
    filtered,
    unfiltered,
    excluded,
    anyDirective,
    ...(inScopeCodeunits !== undefined ? { inScopeCodeunits } : {}),
    conditionalTestFiles,
    warnings,
    treeOnlyTests,
    splitTests,
  };
}
