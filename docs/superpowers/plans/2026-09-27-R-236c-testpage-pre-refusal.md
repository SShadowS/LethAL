# R-236c: refuse TestPage tests before sending them - Implementation Plan (revision r3, final)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

## Revision history

**r3 (final)** answers gpt-6-sol's review r2 (`H:/lethal-coord/reviews/R-236c-plan/review-r2.md`) under the orchestrator's r2 rulings:
- **C1 (multi-name declarations).** `A, B: TestPage "X"` declares two names, and the engine's `collectVarDeclarations` keeps only the first (`childForFieldName("name")`). The scanner no longer resolves variables through the engine. It builds its own scope tables from the AST, keeping EVERY name of every declaration (Task 1, `scopeOf`), with a test that opens the SECOND name. A TestPage-typed declaration with no readable name, and a receiver whose name matches a TestPage declaration the scanner cannot place in scope, are loud errors. r2's engine task (`resolveReceiverVar`) is dropped because nothing uses it any more; the `resolveVarRef` receiver defect and the multi-name gap are filed as roadmap items (Task 6), not fixed.
- **C2 (negative memo).** No memo at all. Each test gets its own visited set and a full traversal of everything it can reach. Test added: tests entering an A/B cycle from each side, in both scan orders.
- **I1 (parse errors).** A loud error is scoped to what a test can reach: an ERROR or MISSING node inside any codeunit the test reaches (whole codeunit, conservatively, because a damaged spot can hide a call edge or a procedure declaration); or a call into a codeunit the scanner cannot find while the test app has a parse error in some codeunit or outside every object (which could be the missing codeunit). An error in a page, table or other non-codeunit object, or in a codeunit no test reaches while every call target was found, is unrelated and does not stop the run. Tests for both. New Task 2 runs a census over the seven GH-06 corpora BEFORE the wiring lands; if a loud error fires on a real suite, work stops and goes back to the orchestrator.
- **I2 (wording).** Everywhere: a test is refused when it "has a reachable call that may open a TestPage". This is a safety-first static policy: an opening call behind `if GuiAllowed then`, which would not run in the fenced session, is refused too, and a test with such a guard can lose a kill it would have earned. Test added. Same-arity overloads that disagree are now refused under the same policy instead of stopping the run.
- **I3 (verify, all refused).** A survivor whose every test is refused gets a structured result: verdict `error`, `notRun` listing every refused method, a named `failureNote`, and the output's `testPageRefused` list. No empty `VerifyError`.

**r2** answered review r1: cross-codeunit helpers, hub mode refuses, detection by opening calls, `verify` wired, explain schema v6, separate refused count, blocking per-mutant check.

---

**Goal:** On the bcdev backend (the fenced BC path, and the legacy hub modes, whose mutant runs are fenced too), LethAL never sends a test that has a reachable call that may open a TestPage, and reports each one by name as "TestPage refused, not run". "Reachable call that may open a TestPage" means: the test, or a procedure of a codeunit in the test app that the test can reach through calls, contains a call to `OpenView`, `OpenEdit`, `OpenNew` or `Trap` on a variable, parameter or global declared as `TestPage` or `TestRequestPage`. It is a static, safety-first policy: conditions are not evaluated (an opening behind `if GuiAllowed then` is refused), and when same-arity overloads disagree, the test is refused. NOT detected, and sent as before (documented limits): a page opened by the code under test and handled through a `[HandlerFunctions]` handler (`ModalPageHandler`, `PageHandler`, `RequestPageHandler`, which receive a TestPage as a parameter); helpers outside the test app's source (the target app, Microsoft's test libraries) and in non-codeunit objects; `Codeunit.Run`, event subscribers and interface dispatch; and a bare zero-argument call written without parentheses in expression position (a CodeCop AA0008 violation). The run stops with a typed error, before anything is sent, when a discovered test has no file, cannot be found by the parser, reaches a codeunit that does not parse cleanly, calls a codeunit it cannot find while a parse error elsewhere could be hiding it, or uses a TestPage declaration the scanner cannot place.

**Architecture:** A scanner (`packages/runner/src/testpage-scan.ts`) parses every `.al` file of the test app once, indexes its codeunits and procedures with their own scope tables, and walks each discovered test's reachable call graph with a fresh visited set. `runSession` runs it after discovery and before the run row exists. `dispatchUnmutated`, the one function every unmutated send goes through (baseline, and `verify`'s rerun), returns a synthetic `skip` verdict for a refused test instead of calling the backend. The baseline classification tags that verdict `tests-testpage-refused`, and the report folds it into an optional `SessionReport.testPageRefused`. `verify` scans in `planVerify` and never plans a refused method.

**Tech Stack:** Bun + TypeScript, `@lethal/engine` (`initParser`, `parseAL`, `wrapRoot`, `visit`, `normalizeAlName`), bun:test, live BC 28 container Cronus28.

**Spec (evidence this plan argues from):**
- `docs/measurements/2026-09-27-nst-wedge-incidents.md` sections 1 and 2 (26 lost replies and 4 wedges from sending one TestPage test; a TestPage over a page with triggers never returns and once left the NST stuck `StopPending`).
- `docs/roadmap/R236.md`, `docs/roadmap/R263.md`, `docs/roadmap/R069.md`.
- `docs/superpowers/plans/2026-09-27-R-236b-testpage-reply-fix.md` and its outcome: the reply cannot be recovered because the server wedges, so the only safe move is not to send.
- Owner direction and the orchestrator's r1 and r2 rulings, 2026-09-27.

## Global Constraints

- No `!` non-null assertions. Destructure, then check `undefined`.
- `exactOptionalPropertyTypes`: build optional props with `...(v !== undefined ? { k: v } : {})`.
- Typed error classes extend `Error` DIRECTLY: `TestPageScanError extends Error`.
- Fail loudly on unknown source that a test can reach: never return "nothing refused" for code the scanner could not read.
- Wording everywhere (code comments, diagnosis, report, README, gate comments): "has a reachable call that may open a TestPage". Never "opens a TestPage" as a claim about what the test does at runtime.
- No em dashes anywhere. Plain English.
- `SessionReport` field ripple per `CLAUDE.md`: `events.ts`, `report-fold.ts`, `report.ts` (type, builder, banner), `bun scripts/generate-schemas.ts`, `tests/schemas.test.ts`, snapshots, and a new `Caveat` needs `CAVEAT_INTERPRETATIONS` plus the counts in `interpretation.test.ts` and `report.test.ts`.
- `REPORT_SCHEMA_VERSION` stays 2 (optional field). `EXPLAIN_SCHEMA_VERSION` 5 -> 6, new file, `explain-v5.schema.json` kept byte-for-byte. `VERIFY_SCHEMA_VERSION` stays 2 (fields added, no value domain changed: the all-refused result uses the existing verdict `error`).
- Do NOT change `TESTPAGE_DIAGNOSIS` (it is in `packages/runner/tests/fixtures/golden-report-*.json` and two committed campaign reports). The `scoreDescribes` sentence must stay byte-identical when nothing is refused.
- Do NOT change `resolveVarRef` or `collectVarDeclarations` (loop-hazard and the operators depend on today's behaviour); file both gaps.
- Build loop: `bun run typecheck`, then `rm -rf packages/*/dist`, then `bun test`. Biome only on touched files.
- Every fix is red-checked (`mutation-red-checker`): revert the fix, the named test goes red, restore, report both.
- Task 4 (wiring) does not land until Task 2's census is clean or the orchestrator has ruled on what it found.
- Live gates on Cronus28 only under a coord lease. A differing verdict is a BLOCK.
- No fixture AL, no control app change. No live probe, no opt-out flag.

## The decisions, with reasons

### D1. The detection rule

Measured on the vendored grammar 2026-09-27 (scratch probes): `TestPage "X"` parses as `variable_declaration > type_specification > object_reference_type > testpage_keyword` (`testrequestpage_keyword` likewise, any keyword case); `A, B: TestPage X` puts both names as `identifier` children of ONE `variable_declaration`; a parameter is `parameter > identifier, type_specification`; `Card.OpenView()` is `call_expression(function: member_expression(Card, OpenView), argument_list)`; a bare `Helper;` is `call_statement > identifier`; a paren-less `Lib.OpenIt;` is a bare `member_expression` in the statement block.

**Why not the engine's symbol table for variables.** `collectVarDeclarations` builds one symbol per declaration from `childForFieldName("name")`, so the second name in `A, B: TestPage X` is unknown to it, and `resolveVarRef` answers `null` for every member receiver (wrapper nodes are compared by reference). Either gap would read as "not a TestPage" and send the test. The scanner therefore reads scope from the AST itself: every name of every declaration, parameters, locals and globals. Procedure overloads are kept apart because every declaration is its own entry with its own parameter count and scope table (the r1 concern about a name-only map).

**Opening methods.** `OpenView`, `OpenEdit`, `OpenNew`, `Trap` on a `TestPage` receiver. Every other TestPage method acts on a page that is already open. `TestRequestPage` has no opening method (the platform hands one to a `RequestPageHandler`); the same four names are checked on it for safety. Task 1 Step 0 re-checks the list against Microsoft Learn before the scanner is written.

**Scope.** For a receiver name inside procedure `p`: `p`'s parameters and locals first, then the codeunit's globals, all with every declared name. A local shadowing a global wins. Trigger `var` sections are not in scope for procedures; a receiver that is unresolved in scope but whose name matches a TestPage declaration anywhere in the codeunit (for example a trigger's) is a loud error, since the scanner cannot place it.

**Calls** from a procedure body (`code_block`):
1. `call_expression` with an `identifier` function: procedures of the same codeunit with that name and that many parameters.
2. `call_expression` with a `member_expression` function and an `identifier` receiver: if the receiver's type is TestPage/TestRequestPage and the member is an opening method, the test has a reachable opening call. If the type is `Codeunit <X>` and X is a codeunit of the test app (by id or case-insensitive name), procedures of X with that name and argument count. If X is not in the test app, the call is recorded as unresolved (see loud rule 3).
3. A `member_expression` that is not the function of a `call_expression`: as 2 with zero arguments.
4. `call_statement > identifier`: as 1 with zero arguments.

Every candidate overload is walked. A built-in (`Clear(Card)`, `Error(...)`) matches no procedure and is not an edge.

**Traversal.** Per test, a fresh visited set and a full walk of everything reachable; the first opening call found becomes the reason (as a call path); the set of codeunits reached (owners of walked procedures, plus codeunits named as call targets) is kept for the loud rules. No result is cached between tests, so no answer can come from an unfinished node.

**Loud errors (`TestPageScanError`, thrown before anything is sent), per test:**
1. The test has no `file`, or the parser does not find its codeunit and exactly one parameterless procedure of that name.
2. A codeunit the test reaches contains an ERROR or MISSING node anywhere (conservative: a damaged span can hide a call edge or a declaration).
3. The test makes a call into a codeunit not found in the test app, AND the test app has an ERROR or MISSING node inside some codeunit or outside every top-level object (either could be the codeunit that was not found).
4. A TestPage-typed declaration with no readable name in a reached codeunit, or a receiver in a reached procedure that is unresolved in scope while a TestPage declaration of that name exists in its codeunit.

An ERROR/MISSING node inside a page, table, report or other non-codeunit object, or inside a codeunit no test reaches while all of that test's call targets were found, does not stop the run. Refusal does not excuse a loud error: rules 1 to 4 are checked for every test, refused or not, as ruled.

**Handler ruling (orchestrator):** handler-driven openings stay a documented limit. Parameters are not openings; a handler is only walked if a test calls it directly.

### D2. Which sessions refuse

`caps.authoritative`: the bcdev backend in every coverage mode, including `itest:envtool`. In the hub modes (`procedure`, `line`) the baseline would run on the hub, where a TestPage opens, but the test would then be green and enter the covering set, whose runs are FENCED. al-runner and the in-memory backend are not BC servers: unchanged, no scan.

### D3. Where the refusal lives, and what is reused

- `tests-testpage-unsupported` / `SessionReport.testPageUnsupported` (R69) stays: BC's own refusal of a test LethAL SENT. The new category is separate because it is LethAL's static decision.
- R69's routed path was deleted in `c1da575`; nothing to reuse.
- The refused test's synthetic verdict is `skip` (an existing `TestOutcome`): never green, never a covering test, not in `unsupportedTests`, and `baselineGreen` false as its failure made it before.
- Classification keys on an exact message PREFIX (the `stale-test-app` pattern), so a `--resume` reusing an old baseline snapshot reports that old verdict as BC's refusal.
- New: `testpage-scan.ts`; `TESTPAGE_NOT_RUN_PREFIX`, `testPageNotRunMessage`, `isTestPageNotRunMessage`, `TESTPAGE_REFUSED_DIAGNOSIS`; `BatchScope.testPageRefused`; caveat and classification `tests-testpage-refused`; `SessionReport.testPageRefused`; verify fields `testPageRefused` and per-result `notRun`; `scripts/r236c-testpage-census.ts`.

Consequence, stated in the diagnosis: a mutant only a refused test would have reached is `no-coverage` where before it could be `error`; both are score-excluded. Because the policy is static, a refused test whose opening call would not have run here (a `GuiAllowed` guard) can lose a kill it would have earned, which can turn a `killed` into `survived` or `no-coverage` on another suite; the per-test reason in the report is what lets a reader see that. On `itest:tables` the prediction that nothing moves rests on (a) the test's recorded baseline coverage never naming an artifact object (`.superpowers/sdd/2026-08-12-r134-r136-operator-waves/task-A10-report.md`), (b) `Data Value Card` having no `SourceTable`, and (c) the test never passing at baseline. `tables.baseline.json` does not store covering sets, so the live per-mutant comparison (Task 7) is the blocking check.

### D4. Opt-out flag

None (orchestrator ruling).

### D5. Gate impact

`grep -rn "TestPage\|TestRequestPage" fixtures --include=*.al` finds a declaration only in `fixtures/sandbox-data-tests` (`PageActionComputesNonZero`) and `fixtures/sandbox-probes` (not discovered by any gate). Task 1 pins per gate test app that exactly the expected tests are refused and that no loud error fires.
- `itest:tables`: assertion changes (Task 7). `itest:chunked`: same test app, stops sending the test, figures unchanged.
- `itest:bcdev`, `itest:envtool`, `itest:verify`, `itest:hang`, `itest:harden`, `itest:agreement`: unchanged by construction. `itest:alrunner`: no scan.

## Review Focus

1. **The second name of a multi-name declaration** (`A, B: TestPage X; ... B.OpenView()`): refused. Test in Task 1.
2. **A call cycle entered from either side, in either scan order:** both tests refused. Test in Task 1.
3. **A parse error the test can reach, vs one it demonstrably cannot:** the first stops the run naming the file; a damaged page property, or a damaged codeunit no test reaches while all targets resolve, does not. Tests in Task 1, and Task 4 for "before anything is sent".
4. **An opening behind `if GuiAllowed then`:** refused (the static policy), and the reason names the call. Test in Task 1.
5. **Verify, every test of a survivor refused:** a structured `error` result with `notRun` and the output's `testPageRefused`, not an empty refusal. Test in Task 5.

---

### Task 1: The source scanner

**Files:**
- Create: `packages/runner/src/testpage-scan.ts`
- Test: `packages/runner/tests/testpage-scan.test.ts`

**Interfaces:**
- Consumes: engine `initParser`, `parseAL`, `wrapRoot`, `visit`, `normalizeAlName`, type `ALSyntaxNode`; `TestMethodRef` (`./backend`); `testKeyOf` (`./selection`).
- Produces:
  - `export class TestPageScanError extends Error` with `readonly reasons: readonly string[]`.
  - `export interface TestPageAnalysis { readonly refused: ReadonlyMap<string, string>; readonly errors: readonly string[] }` (key `testKeyOf(ref)`, value the reason).
  - `export function analyzeTestPageSources(files: ReadonlyArray<{ path: string; text: string }>, tests: readonly TestMethodRef[]): TestPageAnalysis` (never throws for content; parser must be initialised).
  - `export function scanTestPageSources(files, tests): ReadonlyMap<string, string>` (throws `TestPageScanError` when `errors` is non-empty).
  - `export async function readTestAppSources(testDir: string): Promise<Array<{ path: string; text: string }>>` (every `.al` under `testDir`, recursive, sorted).
  - `export async function scanTestPageTests(testDir: string, tests: readonly TestMethodRef[]): Promise<ReadonlyMap<string, string>>` (calls `initParser()`).

- [ ] **Step 0: Check the opening-method list** against Microsoft Learn's "TestPage data type" and "TestRequestPage data type" method pages (WebFetch). Add any other opening method to `OPENING_METHODS` with a test. Record the pages read in the task report.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/runner/tests/testpage-scan.test.ts
import { beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { initParser } from "@lethal/engine";
import type { TestMethodRef } from "../src/backend";
import { discoverTests } from "../src/discovery";
import {
  TestPageScanError,
  analyzeTestPageSources,
  scanTestPageSources,
  scanTestPageTests,
} from "../src/testpage-scan";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
const ref = (codeunitId: number, method: string, file = "t.al"): TestMethodRef => ({
  codeunitId,
  codeunitName: "T",
  method,
  file,
});
const unit = (body: string, id = 50100, name = "T", test = true) => `codeunit ${id} "${name}"
{
${test ? "    Subtype = Test;\n" : ""}${body}
}
`;
type Src = { path: string; text: string };
const scan = (text: string, refs: TestMethodRef[], more: Src[] = []) =>
  scanTestPageSources([{ path: "t.al", text }, ...more], refs);
const analyze = (text: string, refs: TestMethodRef[], more: Src[] = []) =>
  analyzeTestPageSources([{ path: "t.al", text }, ...more], refs);

beforeAll(async () => {
  await initParser();
});

describe("refused: the test has a reachable call that may open a TestPage", () => {
  test("an opening call on the test's own TestPage variable", () => {
    const got = scan(
      unit(`
    [Test]
    procedure OpensCard()
    var
        Card: TestPage "Data Value Card";
    begin
        Card.OpenView();
        Card.Close();
    end;`),
      [ref(50100, "OpensCard")],
    );
    expect([...got.keys()]).toEqual(["50100::OpensCard"]);
    expect(got.get("50100::OpensCard")).toContain("OpenView");
  });

  for (const m of ["OpenEdit", "OpenNew", "Trap"]) {
    test(`${m} is an opening call too`, () => {
      const got = scan(
        unit(`
    [Test]
    procedure Opens()
    var
        Card: TESTPAGE "X";
    begin
        Card.${m}();
    end;`),
        [ref(50100, "Opens")],
      );
      expect(got.size).toBe(1);
    });
  }

  test("the SECOND name of a multi-name declaration (review r2, C1)", () => {
    const got = scan(
      unit(`
    [Test]
    procedure SecondName()
    var
        First, Second: TestPage "X";
    begin
        Second.OpenView();
    end;`),
      [ref(50100, "SecondName")],
    );
    expect(got.get("50100::SecondName")).toContain("Second.OpenView");
  });

  test("an opening behind if GuiAllowed is refused too (static, safety-first policy)", () => {
    const got = scan(
      unit(`
    [Test]
    procedure Guarded()
    var
        Card: TestPage "X";
    begin
        if GuiAllowed() then
            Card.OpenView();
    end;`),
      [ref(50100, "Guarded")],
    );
    expect(got.size).toBe(1);
  });

  test("a same-codeunit helper, bare and parenthesised, two levels deep, named as a path", () => {
    const got = scan(
      unit(`
    [Test]
    procedure ViaHelpers()
    begin
        Initialize;
    end;

    local procedure Initialize()
    begin
        OpenIt();
    end;

    local procedure OpenIt()
    var
        P: TestPage "X";
    begin
        P.OpenEdit();
    end;`),
      [ref(50100, "ViaHelpers")],
    );
    const why = got.get("50100::ViaHelpers") ?? "";
    expect(why).toContain("Initialize");
    expect(why).toContain("OpenIt");
  });

  test("a helper codeunit elsewhere in the test app, through a multi-name Codeunit declaration", () => {
    const lib = unit(
      `
    procedure OpenCard(var Card: TestPage "X")
    begin
        Card.OpenView();
    end;`,
      50200,
      "Library - Pages",
      false,
    );
    const got = scan(
      unit(`
    var
        Other, Pages: Codeunit "library - pages";

    [Test]
    procedure ViaLibrary()
    var
        Card: TestPage "X";
    begin
        Pages.OpenCard(Card);
    end;`),
      [ref(50100, "ViaLibrary")],
      [{ path: "lib.al", text: lib }],
    );
    expect(got.get("50100::ViaLibrary")).toContain("Library - Pages");
  });

  test("a paren-less member call into a helper codeunit", () => {
    const lib = unit(
      `
    procedure OpenIt()
    var
        C: TestPage "Z";
    begin
        C.Trap();
    end;`,
      50200,
      "Lib",
      false,
    );
    const got = scan(
      unit(`
    var
        L: Codeunit Lib;

    [Test]
    procedure Bare()
    begin
        L.OpenIt;
    end;`),
      [ref(50100, "Bare")],
      [{ path: "lib.al", text: lib }],
    );
    expect(got.size).toBe(1);
  });

  test("a global TestPage variable opened in the test", () => {
    const got = scan(
      unit(`
    var
        Shared: TestPage "X";

    [Test]
    procedure UsesGlobal()
    begin
        Shared.OpenView();
    end;`),
      [ref(50100, "UsesGlobal")],
    );
    expect(got.size).toBe(1);
  });

  test("overloads are told apart by argument count; same-arity disagreement refuses", () => {
    const got = scan(
      unit(`
    [Test]
    procedure CallsOneArg()
    begin
        Helper(1);
    end;

    [Test]
    procedure CallsNoArg()
    begin
        Helper();
    end;

    local procedure Helper(N: Integer)
    var
        P: TestPage "X";
    begin
        P.OpenView();
    end;

    local procedure Helper(T: Text)
    begin
    end;

    local procedure Helper()
    begin
    end;`),
      [ref(50100, "CallsOneArg"), ref(50100, "CallsNoArg")],
    );
    expect([...got.keys()]).toEqual(["50100::CallsOneArg"]);
  });

  const CYCLE = unit(`
    [Test]
    procedure EntersAtA()
    begin
        A();
    end;

    [Test]
    procedure EntersAtB()
    begin
        B();
    end;

    local procedure A()
    var
        P: TestPage "X";
    begin
        if P.Editable() then
            B();
        P.OpenView();
    end;

    local procedure B()
    begin
        if false then
            A();
    end;`);

  test("a cycle entered from either side is refused in either scan order (review r2, C2)", () => {
    const forward = scan(CYCLE, [ref(50100, "EntersAtA"), ref(50100, "EntersAtB")]);
    const backward = scan(CYCLE, [ref(50100, "EntersAtB"), ref(50100, "EntersAtA")]);
    expect([...forward.keys()].sort()).toEqual(["50100::EntersAtA", "50100::EntersAtB"]);
    expect([...backward.keys()].sort()).toEqual(["50100::EntersAtA", "50100::EntersAtB"]);
  });

  test("keys by codeunit id: the same method name in two codeunits", () => {
    const two = `${unit(`
    [Test]
    procedure Same()
    var
        P: TestPage "X";
    begin
        P.OpenView();
    end;`)}
${unit(
  `
    [Test]
    procedure Same()
    begin
    end;`,
  50101,
  "U",
)}`;
    const got = scan(two, [ref(50100, "Same"), ref(50101, "Same")]);
    expect([...got.keys()]).toEqual(["50100::Same"]);
  });
});

describe("not refused", () => {
  test("a TestPage variable that is only declared, cleared or closed", () => {
    const got = scan(
      unit(`
    [Test]
    procedure NoOpen()
    var
        Card: TestPage "Data Value Card";
    begin
        Clear(Card);
        Card.Close();
    end;`),
      [ref(50100, "NoOpen")],
    );
    expect(got.size).toBe(0);
  });

  test("a local that shadows a global TestPage", () => {
    const got = scan(
      unit(`
    var
        Card: TestPage "X";

    [Test]
    procedure Shadowed()
    var
        Card: Codeunit "Other";
    begin
        Card.OpenView();
    end;`),
      [ref(50100, "Shadowed")],
    );
    expect(got.size).toBe(0);
  });

  test("a call into a codeunit outside the test app, even if a same-named local helper opens a page", () => {
    const got = scan(
      unit(`
    var
        Lib: Codeunit "Not In This App";

    [Test]
    procedure CallsOutside()
    begin
        Lib.OpenCard();
    end;

    local procedure OpenCard()
    var
        P: TestPage "X";
    begin
        P.OpenView();
    end;`),
      [ref(50100, "CallsOutside")],
    );
    expect(got.size).toBe(0);
  });

  test("a handler's TestPage parameter does not refuse the test that names the handler", () => {
    const got = scan(
      unit(`
    [Test]
    [HandlerFunctions('CardHandler')]
    procedure UsesHandler()
    var
        N: Integer;
    begin
        N := 1;
    end;

    [ModalPageHandler]
    procedure CardHandler(var Card: TestPage "X")
    begin
        Card.OK().Invoke();
    end;`),
      [ref(50100, "UsesHandler")],
    );
    expect(got.size).toBe(0);
  });
});

describe("loud errors, scoped to what a test can reach (review r2, I1)", () => {
  const CLEAN_TEST = unit(`
    var
        H: Codeunit Helper;

    [Test]
    procedure Fine()
    begin
        H.Run1();
    end;`);
  const helper = (body: string) => unit(body, 50200, "Helper", false);

  test("an error inside a codeunit the test reaches stops the run, naming the file", () => {
    const got = analyze(CLEAN_TEST, [ref(50100, "Fine")], [
      {
        path: "helper.al",
        text: helper(`
    procedure Run1()
    begin
        if then;
    end;`),
      },
    ]);
    expect(got.errors.join("\n")).toContain("helper.al");
    expect(() =>
      scan(CLEAN_TEST, [ref(50100, "Fine")], [
        { path: "helper.al", text: helper("    procedure Run1()\n    begin\n        if then;\n    end;") },
      ]),
    ).toThrow(TestPageScanError);
  });

  test("an error elsewhere in a reached codeunit counts too (it could hide an edge)", () => {
    const got = analyze(CLEAN_TEST, [ref(50100, "Fine")], [
      {
        path: "helper.al",
        text: helper(`
    procedure Run1()
    begin
    end;

    procedure Unrelated()
    begin
        if then;
    end;`),
      },
    ]);
    expect(got.errors.length).toBe(1);
  });

  test("a damaged page property in an unrelated object does not stop the run", () => {
    const page = `page 50300 "Some Page"
{
    layout
    {
        area(Content)
        {
            field(Type; Rec.Type)
            {
                Visible = Type = Type::X;
            }
        }
    }
}
`;
    const got = analyze(CLEAN_TEST, [ref(50100, "Fine")], [
      { path: "helper.al", text: helper("    procedure Run1()\n    begin\n    end;") },
      { path: "page.al", text: page },
    ]);
    expect(got.errors).toEqual([]);
  });

  test("a damaged codeunit no test reaches does not stop the run when every target resolved", () => {
    const got = analyze(CLEAN_TEST, [ref(50100, "Fine")], [
      { path: "helper.al", text: helper("    procedure Run1()\n    begin\n    end;") },
      {
        path: "other.al",
        text: unit("    procedure X()\n    begin\n        if then;\n    end;", 50400, "Other", false),
      },
    ]);
    expect(got.errors).toEqual([]);
  });

  test("an unresolved call target plus a damaged codeunit elsewhere stops the run", () => {
    const test = unit(`
    var
        Lib: Codeunit "Maybe Damaged";

    [Test]
    procedure CallsUnknown()
    begin
        Lib.Go();
    end;`);
    const got = analyze(test, [ref(50100, "CallsUnknown")], [
      {
        path: "other.al",
        text: unit("    procedure X()\n    begin\n        if then;\n    end;", 50400, "Other", false),
      },
    ]);
    expect(got.errors.join("\n")).toContain("Maybe Damaged");
  });

  test("a discovered test with no file", () => {
    const got = analyze(CLEAN_TEST, [{ codeunitId: 50100, codeunitName: "T", method: "Fine" }]);
    expect(got.errors.join("\n")).toContain("no file");
  });

  test("a discovered test the parser cannot find", () => {
    const got = analyze(unit(""), [ref(50100, "Ghost")]);
    expect(got.errors.join("\n")).toContain("Ghost");
  });

  test("a receiver matching a TestPage declared out of the scanner's scope", () => {
    const src = unit(`
    trigger OnRun()
    var
        Hidden: TestPage "X";
    begin
    end;

    [Test]
    procedure UsesHidden()
    begin
        Hidden.OpenView();
    end;`);
    const got = analyze(src, [ref(50100, "UsesHidden")]);
    expect(got.errors.join("\n")).toContain("Hidden");
  });
});

describe("scanTestPageTests on the real fixtures (offline pin of the live gates)", () => {
  test("sandbox-data-tests: exactly PageActionComputesNonZero", async () => {
    const dir = join(REPO_ROOT, "fixtures", "sandbox-data-tests");
    const tests = await discoverTests(dir);
    const refused = await scanTestPageTests(dir, tests);
    const names = tests
      .filter((t) => refused.has(`${t.codeunitId}::${t.method}`))
      .map((t) => `${t.codeunitName}.${t.method}`);
    expect(names).toEqual(["Data Tests.PageActionComputesNonZero"]);
  });

  for (const fixture of ["sandbox-tests", "sandbox-hang-tests", "sandbox-harden-tests"]) {
    test(`${fixture}: no loud error and nothing refused, so its gates cannot move`, async () => {
      const dir = join(REPO_ROOT, "fixtures", fixture);
      const refused = await scanTestPageTests(dir, await discoverTests(dir));
      expect(refused.size).toBe(0);
    });
  }
});
```

Implementer notes: the page-property case copies R288's shape (`Type = Type::X` parses into an ERROR node on tree-sitter-al 4.3.0); if it does not produce `hasError` on the vendored grammar, replace it with any page-level construct that does, and say which in the task report, since the point is an ERROR in a non-codeunit object. If any other case's source has an unintended parse error, fix the TEST source, not the rule.

- [ ] **Step 2: Run to verify it fails.** `bun test packages/runner/tests/testpage-scan.test.ts`. Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```ts
// packages/runner/src/testpage-scan.ts
/**
 * R-236c: which discovered tests have a reachable call that may open a TestPage, read from the test
 * app's SOURCE before anything is sent. Sending such a test into the fenced session gets at best
 * BC's refusal (R69) and at worst a lost reply and a wedged server tier
 * (docs/measurements/2026-09-27-nst-wedge-incidents.md). The reply cannot be recovered (R-236b).
 *
 * A static, safety-first policy: conditions are not evaluated, so an opening behind
 * `if GuiAllowed then` is refused too, and same-arity overloads are all walked.
 * Documented limits, sent as before: handler-driven pages, helpers outside the test app or in
 * non-codeunit objects, Codeunit.Run, event subscribers, interfaces, and a bare zero-argument call
 * without parentheses in expression position.
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
const PAGE_TYPE = /^\s*test(request)?page\b/i;
const CODEUNIT_TYPE = /^\s*codeunit\s+(.+?)\s*$/i;
const NAME_KINDS = new Set(["identifier", "quoted_identifier"]);

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

/** Start offsets of every ERROR and MISSING node (MISSING carries the missing token's type). */
function errorOffsets(root: TsNode): number[] {
  if (!root.hasError) return [];
  const out: number[] = [];
  const walk = (n: TsNode): void => {
    if (n.type === "ERROR" || n.isMissing) out.push(n.startIndex);
    for (const c of n.children) if (c !== null) walk(c);
  };
  walk(root);
  return out;
}

const within = (off: number, n: ALSyntaxNode) => off >= n.startIndex && off <= n.endIndex;

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

function buildUnit(file: string, node: ALSyntaxNode, errors: readonly number[]): Unit {
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
    damaged: errors.some((e) => within(e, node)),
    globals,
    pageNamesAnywhere,
    problems,
    procs: [] as Proc[],
  };
  if (body !== undefined) {
    for (const c of body.namedChildren) {
      if (c.rawKind.endsWith("var_section")) addDeclarations(c, globals, `${display} globals`, problems);
    }
    const all = new Map<string, string>();
    addDeclarations(body, all, `${display}`, []);
    for (const [n, t] of all) if (PAGE_TYPE.test(t)) pageNamesAnywhere.add(n);
    for (const p of body.namedChildren) {
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
    const want = normalizeAlName(raw);
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

  private calls(owner: Unit, rawName: string, args: number, path: readonly string[], st: TestState) {
    const name = normalizeAlName(rawName);
    for (const c of owner.procs) {
      if (c.name === name && c.params === args) this.walk(c, path, st);
    }
  }

  private visitNode(p: Proc, n: ALSyntaxNode, path: readonly string[], st: TestState): void {
    if (n.rawKind === "call_expression") {
      const fn = n.childForFieldName("function");
      const args =
        n.namedChildren.find((c) => c.rawKind === "argument_list")?.namedChildren.length ?? 0;
      if (fn === null) return;
      if (NAME_KINDS.has(fn.rawKind)) this.calls(p.unit, fn.text, args, path, st);
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
      if (id !== undefined) this.calls(p.unit, id.text, 0, path, st);
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
    if (receiver === undefined || member === undefined || !NAME_KINDS.has(receiver.rawKind)) return;
    const key = normalizeAlName(receiver.text);
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
    const objects = root.namedChildren.filter(
      (c) => c.rawKind.endsWith("_declaration") && c.rawKind !== "namespace_declaration",
    );
    for (const o of objects) {
      if (o.rawKind === "codeunit_declaration") units.push(buildUnit(f.path, o, errors));
    }
    for (const e of errors) {
      const owner = objects.find((o) => within(e, o));
      if (owner === undefined || owner.rawKind === "codeunit_declaration") {
        suspect.push(`${f.path} at offset ${e}`);
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
    const decls = owner?.procs.filter((p) => p.name === normalizeAlName(t.method) && p.params === 0) ?? [];
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
      if (u.damaged) errors.push(`${label} reaches ${u.display} (${u.file}), which does not parse cleanly`);
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
```

Notes for the implementer:
- `buildUnit` builds a mutable shell so each `Proc` can point back at its `Unit`; keep the exported types readonly.
- `rawKind.endsWith("_declaration")` for top-level objects: check the vendored grammar's names for `namespace` and `using` lines (`scripts/lib/grammar-crosscheck.ts` and the node-kinds file); an error in one of those lines is "outside every object" and so suspect, which is the conservative reading.
- `testKeyOf` keeps discovery's spelling of the method, so `dispatchUnmutated` finds the key.

- [ ] **Step 4: Run to verify it passes.** `bun test packages/runner/tests/testpage-scan.test.ts`. Expected: PASS. If a fixture test app reports an error, or `sandbox-data-tests` refuses more than one test, STOP and report: Task 7's predictions would be wrong.

- [ ] **Step 5: Red-checks (`mutation-red-checker`)**
  - `addDeclarations` keeps only the first name (`names.slice(0, 1)`): "the SECOND name" and "through a multi-name Codeunit declaration" go red.
  - Add a cross-test cache of negative answers (a `Map<Proc, boolean>` filled at the end of `walk`, consulted at its start): the cycle test goes red in one of the two orders. This is the reviewer's C2 reproduced.
  - Drop the `OPENING_METHODS` check: "only declared, cleared or closed" goes red.
  - Resolve globals before locals: "a local that shadows a global" goes red.
  - Drop `c.params === args`: "overloads are told apart" goes red.
  - Mark every file's errors as suspect and every unit as damaged: "a damaged page property" and "a damaged codeunit no test reaches" go red.
  - Remove the `u.damaged` check: "an error inside a codeunit the test reaches" goes red.
  Report red and restored output for each.

- [ ] **Step 6: Commit**

```bash
bun run typecheck && rm -rf packages/*/dist
bunx biome check packages/runner/src/testpage-scan.ts packages/runner/tests/testpage-scan.test.ts
git add packages/runner/src/testpage-scan.ts packages/runner/tests/testpage-scan.test.ts
git commit -m "feat(runner): find tests with a reachable call that may open a TestPage, loud on unreadable reachable source (R-236c)"
```

---

### Task 2: Census over the GH-06 corpora (gates Task 4)

**Files:**
- Create: `scripts/r236c-testpage-census.ts`
- Create: `docs/measurements/2026-09-27-r236c-testpage-census.md` (the result, no source code quoted)

**Interfaces:**
- Consumes: `discoverTests` (`packages/runner/src/discovery.ts`), `readTestAppSources`, `analyzeTestPageSources` (Task 1), `initParser`.

- [ ] **Step 1: Write the script**

```ts
// scripts/r236c-testpage-census.ts
// R-236c census: on each corpus, how many discovered tests the TestPage scan refuses, and whether
// any loud error fires. Run BEFORE the wiring lands. Prints names and counts only, never source.
import { initParser } from "@lethal/engine";
import { discoverTests } from "../packages/runner/src/discovery";
import {
  analyzeTestPageSources,
  readTestAppSources,
} from "../packages/runner/src/testpage-scan";

await initParser();
for (const dir of process.argv.slice(2)) {
  const started = Date.now();
  try {
    const tests = await discoverTests(dir);
    const files = await readTestAppSources(dir);
    const { refused, errors } = analyzeTestPageSources(files, tests);
    console.log(
      JSON.stringify({
        corpus: dir,
        files: files.length,
        tests: tests.length,
        refused: refused.size,
        loudErrors: errors.length,
        firstErrors: errors.slice(0, 20),
        ms: Date.now() - started,
      }),
    );
  } catch (e) {
    console.log(JSON.stringify({ corpus: dir, threw: e instanceof Error ? e.message : String(e) }));
  }
}
```

Add it to `scripts/tsconfig.json`'s file list (R280: a script missing there is not type-checked).

- [ ] **Step 2: Run** (foreground; BaseApp is ~9,600 files):

```bash
bun scripts/r236c-testpage-census.ts fixtures/sandbox-data-tests fixtures/sandbox-tests fixtures/sandbox-hang-tests fixtures/sandbox-harden-tests "U:/Git/do-rel2/Cloud" "U:/Git/DC/Cloud" "U:/Git/BusinessCentral.Sentinel" "U:/Git/BC.History/BusinessFoundation" "U:/Git/BC.History/System Application" "U:/Git/BC.History/BaseApp"
```

- [ ] **Step 3: Decide.** Write the table (corpus, files, tests, refused, loud errors, time) to `docs/measurements/2026-09-27-r236c-testpage-census.md`, with each loud error's reason text (names and offsets only). If ANY real corpus has `loudErrors > 0` or `threw`, STOP: send the table to the orchestrator and do not start Task 4 until it rules. A corpus with zero discovered tests is recorded as "no tests", not as a pass. Also record the refused count as a sanity check of the policy's reach (Continia Document Output is known to have 9 of 104 test files declaring a TestPage).

- [ ] **Step 4: Commit** (the report is names and counts only; check it for source text before committing, this repo is public):

```bash
git add scripts/r236c-testpage-census.ts scripts/tsconfig.json docs/measurements/2026-09-27-r236c-testpage-census.md
git commit -m "measure: R-236c TestPage scan census over the GH-06 corpora"
```

---

### Task 3: The "refused, not run" category through events, report and explain

**Files:**
- Modify: `packages/runner/src/testpage-unsupported.ts` (append constants and helpers)
- Modify: `packages/runner/src/events.ts` (`BASELINE_CLASSIFICATIONS`, near line 54)
- Modify: `packages/runner/src/report-fold.ts` (`FoldedReport` near line 131, accumulator near 224, `baseline-batch-finished` case near 320, output spread near 595)
- Modify: `packages/runner/src/report.ts` (`Caveat` near 191; `CAVEAT_INTERPRETATIONS["baseline-red"]` near 235 and a new entry after `"tests-testpage-unsupported"` near 317; `SessionReport.testPageRefused` after `testPageUnsupported` near 1047; `baselineTests` doc near 704; caveat push near 2283; `baselineText` near 2451; builder spread near 2486; banner near 2718)
- Modify: `packages/runner/src/explain.ts` (`EXPLAIN_SCHEMA_VERSION = 6`, line 183)
- Create: `schemas/explain-v6.schema.json`; keep `schemas/explain-v5.schema.json` unchanged
- Modify: `schemas/README.md`, `docs/using-lethal-from-an-agent.md` (lines 200, 240)
- Modify tests: `report.test.ts` (line 264), `interpretation.test.ts` (line 44), `schemas.test.ts` (lines 232, 997, the root-required map near 832, the R233 literal list near 934), `report-fold.test.ts`, `testpage-unsupported.test.ts`
- Regenerate: `bun scripts/generate-schemas.ts`

**Interfaces:**
- Produces: `TESTPAGE_NOT_RUN_PREFIX`, `testPageNotRunMessage(reason: string): string`, `isTestPageNotRunMessage(text: string | undefined): boolean`, `TESTPAGE_REFUSED_DIAGNOSIS`; `Caveat`/`BaselineClassification` member `"tests-testpage-refused"`; `FoldedReport.testPageRefusedTests?: readonly string[]`; `SessionReport.testPageRefused?: { readonly tests: readonly string[]; readonly diagnosis: string }`.

- [ ] **Step 1: Write the failing tests.** In `report-fold.test.ts`, with the file's minimal-stream helper for a `baseline-batch-finished` event (called `buildWithBaseline` below; use the file's real name):

```ts
test("R-236c: a test refused before sending is named on its own list, never as a failure", () => {
  const report = buildWithBaseline([
    { name: "Data Tests.Green", outcome: "pass", classification: [] },
    {
      name: "Data Tests.OpensPage",
      outcome: "skip",
      classification: ["tests-testpage-refused"],
      failureMessage: testPageNotRunMessage("Data Tests.OpensPage calls Card.OpenView on TestPage \"X\""),
    },
  ]);
  expect(report.testPageRefused?.tests).toEqual(["Data Tests.OpensPage"]);
  expect(report.testPageRefused?.diagnosis).toBe(TESTPAGE_REFUSED_DIAGNOSIS);
  expect(report.validity.caveats).toContain("tests-testpage-refused");
  expect(report.validity.caveats).not.toContain("tests-testpage-unsupported");
  expect(report.unsupportedTests).toEqual([]);
  expect(report.validity.baselineTests).toEqual({ total: 2, failing: 0 });
  expect(report.baselineGreen).toBe(false);
  expect(report.validity.scoreDescribes).toContain("0 of 2 baseline tests failing");
  expect(report.validity.scoreDescribes).toContain("1 refused before sending (TestPage), not run");
});

test("R-236c: nothing refused leaves the score sentence exactly as before", () => {
  const report = buildWithBaseline([
    { name: "Data Tests.Green", outcome: "pass", classification: [] },
    { name: "Data Tests.Red", outcome: "fail", classification: [] },
  ]);
  expect(report.validity.scoreDescribes).toContain(", with 1 of 2 baseline tests failing");
  expect(report.validity.scoreDescribes).not.toContain("refused");
});

test("R-236c: BC's own TestPage refusal stays BC's, never relabelled 'not run' (resume)", () => {
  const report = buildWithBaseline([
    {
      name: "Data Tests.OpensPage",
      outcome: "error",
      classification: ["tests-testpage-unsupported"],
      failureMessage:
        "System.NotSupportedException: Specified method is not supported. at Microsoft.Dynamics.Nav.Runtime.NavSession.CreateNavTestService()",
    },
  ]);
  expect(report.testPageRefused).toBeUndefined();
  expect(report.testPageUnsupported?.tests).toEqual(["Data Tests.OpensPage"]);
});
```

In `testpage-unsupported.test.ts`:

```ts
test("R-236c: the not-run message is recognised by prefix and trips neither older diagnosis", () => {
  const m = testPageNotRunMessage("T.X calls Card.OpenView on TestPage \"X\"");
  expect(isTestPageNotRunMessage(m)).toBe(true);
  expect(isTestPageNotRunMessage("some other failure")).toBe(false);
  expect(isTestPageNotRunMessage(undefined)).toBe(false);
  expect(describeTestPageUnsupported(m)).toBeUndefined();
});

test("R-236c: the diagnosis states the static policy, not a runtime claim", () => {
  expect(TESTPAGE_REFUSED_DIAGNOSIS).toContain("reachable call that may open a TestPage");
  expect(TESTPAGE_REFUSED_DIAGNOSIS).toContain("GuiAllowed");
});
```

In `interpretation.test.ts`, beside the count test:

```ts
test("R-236c: baseline-red names the refused, not-run case", () => {
  expect(CAVEAT_INTERPRETATIONS["baseline-red"].meaning).toContain("refused before sending");
});
```

- [ ] **Step 2: Run to verify they fail.** `bun test packages/runner/tests/report-fold.test.ts packages/runner/tests/testpage-unsupported.test.ts packages/runner/tests/interpretation.test.ts`.

- [ ] **Step 3: Implement.**

`testpage-unsupported.ts`, append:

```ts
/**
 * R-236c: the failure text of a test LethAL refused BEFORE sending, because it has a reachable call
 * that may open a TestPage. An exact prefix, like the stale-test-app sentinel, so classification
 * reads the VERDICT: a resumed baseline recorded before this existed keeps BC's own refusal. It
 * must never contain the text `describeTestPageUnsupported` or the permission regexes match.
 */
export const TESTPAGE_NOT_RUN_PREFIX =
  "not run: LethAL refused this test before sending it, because it has a reachable call that may open a TestPage";

export function testPageNotRunMessage(reason: string): string {
  return `${TESTPAGE_NOT_RUN_PREFIX} (${reason}).`;
}

export function isTestPageNotRunMessage(text: string | undefined): boolean {
  return text?.startsWith(TESTPAGE_NOT_RUN_PREFIX) ?? false;
}

export const TESTPAGE_REFUSED_DIAGNOSIS =
  "LethAL did not send these tests. Each one has a reachable call that may open a TestPage: the " +
  "test, or a procedure it can call in the test app, calls OpenView, OpenEdit, OpenNew or Trap on a " +
  "TestPage, found by reading the test source before the run. This is a safety-first static policy: " +
  "conditions are not evaluated, so a call behind `if GuiAllowed then`, which would not run here, " +
  "is refused too. The session LethAL runs tests in (GuiAllowed=No, ClientType=ODataV4) cannot run " +
  "a TestPage, and sending one got at best BC's refusal and at worst a lost reply that left the BC " +
  "server unable to answer until restarted (R236). These tests are not in the green set, so a " +
  "mutant only they would reach is reported no-coverage: no test LethAL RAN reaches it, which is " +
  "not the same as no test in your suite, and a guarded test may have lost a kill. Each test's " +
  "failure text names the call path it was refused for. Not detected, and sent as before: a page " +
  "opened by the code under test and handled through a handler function, and helpers outside the " +
  "test app.";
```

`events.ts`: `"tests-testpage-refused"` after `"tests-testpage-unsupported"` in `BASELINE_CLASSIFICATIONS`; the doc comment gains: "`tests-testpage-refused` (R-236c) is keyed on the exact `TESTPAGE_NOT_RUN_PREFIX`, not on outcome, because its verdict is a synthetic `skip`."

`report.ts`:
- `Caveat`: `| "tests-testpage-refused"` after `"tests-testpage-unsupported"`.
- `baseline-red` meaning: `"The baseline was not green: some tests failed or errored before any mutant ran, or were refused before sending because they have a reachable call that may open a TestPage (see tests-testpage-refused). " + "Consequence (R55): baseline-red dropped those tests from the green set, so mutants " + "covered only by them read \`no-coverage\`, not \`survived\`. Resolve this before reading " + "survivors."` (`entailedNegative` and `basis` unchanged).
- New interpretation after `"tests-testpage-unsupported"`:

```ts
  "tests-testpage-refused": {
    meaning: TESTPAGE_REFUSED_DIAGNOSIS,
    entailedNegative:
      "Distinct from `tests-testpage-unsupported`: that one is BC's own refusal of a test LethAL " +
      "sent; this one is LethAL's static decision from the test source, and the test never reached " +
      "BC. It does not say the test is wrong, nor that it would open a page on this path.",
    basis: "R236",
  },
```

- `SessionReport`, after `testPageUnsupported`:

```ts
  /**
   * R-236c: tests LethAL did not send because each has a reachable call that may open a TestPage
   * (see `CAVEAT_INTERPRETATIONS["tests-testpage-refused"]`). NOT part of `unsupportedTests` or of
   * `validity.baselineTests.failing`: nothing ran. Absent when no test was refused.
   */
  readonly testPageRefused?: {
    readonly tests: readonly string[];
    readonly diagnosis: string;
  };
```

- `baselineTests` doc gains: "`failing` counts fail/error only; tests refused before sending (R-236c) are in `testPageRefused`, not here."
- Caveat push (before `baselineText` is computed; move it up if needed):

```ts
  // See CAVEAT_INTERPRETATIONS["tests-testpage-refused"].
  const testPageRefusedTests = input.testPageRefusedTests ?? [];
  if (testPageRefusedTests.length > 0) caveats.push("tests-testpage-refused");
```

- `baselineText`:

```ts
  const refusedText =
    testPageRefusedTests.length > 0
      ? ` and ${testPageRefusedTests.length} refused before sending (TestPage), not run`
      : "";
  const baselineText = degraded
    ? `, with ${input.unsupportedTests.length} of ${input.baselineTests.length} baseline tests failing${refusedText}`
    : "";
```

- Builder spread after `testPageUnsupported`:

```ts
    ...(testPageRefusedTests.length > 0
      ? {
          testPageRefused: {
            tests: [...testPageRefusedTests].sort(),
            diagnosis: TESTPAGE_REFUSED_DIAGNOSIS,
          },
        }
      : {}),
```

- Banner after the `TESTPAGE UNSUPPORTED ON THIS PATH` block:

```ts
  if (r.testPageRefused !== undefined) {
    const n = r.testPageRefused.tests.length;
    lines.push(`TESTPAGE REFUSED, NOT RUN: ${n} test(s) were not sent. ${r.testPageRefused.diagnosis}`);
    for (const t of r.testPageRefused.tests.slice(0, 10)) lines.push(`  ${t}`);
    if (n > 10) lines.push(`  ... ${n - 10} more`);
  }
```

- Import `TESTPAGE_REFUSED_DIAGNOSIS` beside `TESTPAGE_DIAGNOSIS`.

`report-fold.ts`: `FoldedReport` gains `readonly testPageRefusedTests?: readonly string[];`; `const testPageRefusedTests = new Set<string>();`; in the loop `if (v.classification.includes("tests-testpage-refused")) testPageRefusedTests.add(v.name);`; output `...(testPageRefusedTests.size > 0 ? { testPageRefusedTests: [...testPageRefusedTests].sort() } : {}),`.

Explain v6:
- `explain.ts`: `export const EXPLAIN_SCHEMA_VERSION = 6;` and one doc line "6: R-236c added the caveat value `tests-testpage-refused`."
- `cp schemas/explain-v5.schema.json schemas/explain-v6.schema.json`; in v6 only: `$id` `explain-v5` -> `explain-v6`, the `explainSchemaVersion` `const` 5 -> 6, `"tests-testpage-refused"` after `"tests-testpage-unsupported"` in the `caveats.items.properties.caveat` enum, and any title/description naming version 5. `git diff --no-index schemas/explain-v5.schema.json schemas/explain-v6.schema.json` must show only those lines.
- `schemas/README.md`: a v6 row (`EXPLAIN_SCHEMA_VERSION` = 6); the v5 row becomes "the same, from builds before R-236c; kept so a stored v5 document stays checkable (v6 added the caveat `tests-testpage-refused`)"; update the file counts below the table (eight files, six hand-written).
- `docs/using-lethal-from-an-agent.md`: link at line 200 to `explain-v6.schema.json`; `explainSchemaVersion: 6` at line 240.
- Tests: `report.test.ts` union object gains `"tests-testpage-refused": true,`; `interpretation.test.ts` `toBe(19)` -> `toBe(20)`; `schemas.test.ts` loads `explain-v6.schema.json` at both sites, adds the v6 entry (same list as v5) to the root-required map, and adds the caveat to the R233 literal list.

- [ ] **Step 4: Regenerate and run**

```bash
bun scripts/generate-schemas.ts
bun run typecheck && rm -rf packages/*/dist
bun test packages/runner
```

Expected: PASS. Read any `report-equality` snapshot diff first: the only allowed changes are the new caveat in an enum/interpretation listing and the `baseline-red` meaning; then `--update-snapshots`. The golden `scoreDescribes` must not change. The gift-card rehearsal report must still validate; if not, STOP and report.

- [ ] **Step 5: Red-checks.** (a) Remove the fold line: the first fold test goes red. (b) Drop `refusedText`: the first fold test goes red on the sentence. (c) Leave `EXPLAIN_SCHEMA_VERSION` at 5 with v6 present: `schemas.test.ts` goes red. Restore, report both.

- [ ] **Step 6: Commit**

```bash
bunx biome check packages/runner/src/testpage-unsupported.ts packages/runner/src/report.ts packages/runner/src/events.ts packages/runner/src/report-fold.ts packages/runner/src/explain.ts packages/runner/tests/report-fold.test.ts packages/runner/tests/testpage-unsupported.test.ts packages/runner/tests/report.test.ts packages/runner/tests/interpretation.test.ts packages/runner/tests/schemas.test.ts
git add packages/runner/src packages/runner/tests schemas docs/using-lethal-from-an-agent.md
git commit -m "feat(report): TestPage refused, not run, as its own category; explain schema v6 (R-236c)"
```

---

### Task 4: Wire the refusal into `runSession` (only after Task 2 is clean or ruled)

**Files:**
- Modify: `packages/runner/src/orchestrator.ts`: `interface BatchScope` (near 2971) gains `readonly testPageRefused?: ReadonlyMap<string, string>;`; `dispatchUnmutated` (near 3260); `scoreBatch`'s classification block (near 3487); `runSession` right after `if (tests.length === 0) throw new Error("no tests discovered");` (near 3864, before `reportPublishedTestApp` and `createRun`); the `const scope: BatchScope = {` literal (near 4206).
- Test: `packages/runner/tests/orchestrator.test.ts` (new `describe` after the R69 block, near line 1480)

**Interfaces:**
- Consumes: `scanTestPageTests`, `TestPageScanError` (Task 1); `testPageNotRunMessage`, `isTestPageNotRunMessage` (Task 3); `testKeyOf` (already imported).

- [ ] **Step 1: Write the failing tests**

```ts
describe("R-236c: a test with a reachable call that may open a TestPage is refused before sending", () => {
  const PAGE_TEST_AL = `codeunit 79100 "Sandbox Tests"
{
    Subtype = Test;

    [Test]
    procedure GreenTest()
    begin
    end;

    [Test]
    procedure UnsupportedTest()
    var
        Card: TestPage "Some Card";
    begin
        Card.OpenView();
    end;
}
`;

  class RecordingBackend extends QualificationBackend {
    baselineSent: string[] = [];
    constructor(private readonly caps: BackendCapabilities) {
      super((method: string) =>
        method === "UnsupportedTest"
          ? { outcome: "error" as const, procedure: "IsUnderBudget" }
          : { outcome: "pass" as const, procedure: "IsOverBudget" },
      );
    }
    override capabilities() {
      return this.caps;
    }
    override async run(ref: TestMethodRef, opts: RunOpts): Promise<TestVerdict> {
      if ((this.activations.at(-1) ?? null) === null) this.baselineSent.push(ref.method);
      return super.run(ref, opts);
    }
  }

  async function project(testAl = PAGE_TEST_AL) {
    const dirs = await makeProject(testAl);
    await Bun.write(join(dirs.projectDir, "SandboxLogic.Codeunit.al"), TWO_PROC_AL);
    return dirs;
  }
  const FENCED = { ...CAPS_NST, coverage: "fenced" as const };

  test("fenced: never sent, named, recorded as skip with the reason", async () => {
    const dirs = await project();
    const backend = new RecordingBackend(FENCED);
    const store = new ResultsStore(":memory:");
    const report = await runSession({ backend, store, ...dirs, selectorIds });

    expect(backend.baselineSent).toEqual(["GreenTest"]);
    expect(report.testPageRefused?.tests).toEqual(["Sandbox Tests.UnsupportedTest"]);
    expect(report.unsupportedTests).toEqual([]);
    expect(report.validity.baselineTests.failing).toBe(0);
    expect(report.validity.caveats).toContain("tests-testpage-refused");
    expect(report.validity.caveats).not.toContain("tests-testpage-unsupported");
    expect(report.baselineGreen).toBe(false);
    const rows = store.db
      .query("SELECT outcome, failure_message AS msg FROM test_results WHERE method = 'UnsupportedTest'")
      .all() as { outcome: string; msg: string }[];
    expect(rows.map((r) => r.outcome)).toEqual(["skip"]);
    expect(rows[0]?.msg).toContain("OpenView");
    const underBudget = report.mutants.filter((m) => m.procedureName === "IsUnderBudget");
    expect(underBudget.length).toBe(3);
    for (const m of underBudget) expect(m.verdict).toBe("no-coverage");
  });

  test("hub coverage mode refuses too: its mutant runs are fenced", async () => {
    const dirs = await project();
    const backend = new RecordingBackend(CAPS_NST); // coverage "procedure"
    const store = new ResultsStore(":memory:");
    const report = await runSession({ backend, store, ...dirs, selectorIds });
    expect(backend.baselineSent).toEqual(["GreenTest"]);
    expect(report.testPageRefused?.tests).toEqual(["Sandbox Tests.UnsupportedTest"]);
  });

  test("a non-authoritative backend is unchanged: no scan, the test is sent", async () => {
    const dirs = await project();
    const backend = new RecordingBackend({ ...FENCED, authoritative: false });
    const store = new ResultsStore(":memory:");
    const report = await runSession({ backend, store, ...dirs, selectorIds });
    expect(backend.baselineSent).toContain("UnsupportedTest");
    expect(report.testPageRefused).toBeUndefined();
  });

  test("a reachable parse error stops the run before anything is sent and before a run row", async () => {
    const broken = PAGE_TEST_AL.replace(
      "procedure GreenTest()\n    begin",
      "procedure GreenTest()\n    begin\n        if then;",
    );
    const dirs = await project(broken);
    const backend = new RecordingBackend(FENCED);
    const store = new ResultsStore(":memory:");
    const err = await runSession({ backend, store, ...dirs, selectorIds }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(TestPageScanError);
    expect(backend.baselineSent).toEqual([]);
    expect(backend.deploys).toEqual([]);
    const runs = store.db.query("SELECT COUNT(*) AS n FROM runs").get() as { n: number };
    expect(runs.n).toBe(0);
  });

  test("every test refused: nothing sent, every mutant error, the sentence names the refusals", async () => {
    const allPages = PAGE_TEST_AL.replace(
      "procedure GreenTest()\n    begin",
      'procedure GreenTest()\n    var\n        P: TestPage "X";\n    begin\n        P.OpenView();',
    );
    const dirs = await project(allPages);
    const backend = new RecordingBackend(FENCED);
    const store = new ResultsStore(":memory:");
    const report = await runSession({ backend, store, ...dirs, selectorIds });
    expect(backend.baselineSent).toEqual([]);
    expect(report.testPageRefused?.tests.length).toBe(2);
    expect(report.mutants.length).toBeGreaterThan(0);
    for (const m of report.mutants) expect(m.verdict).toBe("error");
    expect(report.validity.scoreDescribes).toContain("2 refused before sending (TestPage), not run");
  });
});
```

Implementer notes: add missing imports. Check `store.ts`'s `test_results` column names and the `runs` table name; adjust the QUERY, never the assertion. If `coverage: "fenced"` needs a stub hook the test backend lacks, report it rather than switching to `"none"`.

- [ ] **Step 2: Run to verify they fail.** `bun test packages/runner/tests/orchestrator.test.ts -t "R-236c"`.

- [ ] **Step 3: Implement.**

`dispatchUnmutated`, first statement after destructuring `scope`:

```ts
  // R-236c: a test with a reachable call that may open a TestPage is never sent. Its verdict is a
  // synthetic `skip` carrying the reason, recorded like any baseline row, so the report names it and
  // nothing downstream mistakes it for an answer from BC.
  const refusedFor = scope.testPageRefused?.get(testKeyOf(ref));
  if (refusedFor !== undefined) {
    const skipped: TestVerdict = {
      ref,
      outcome: "skip",
      durationMs: 0,
      failureMessage: testPageNotRunMessage(refusedFor),
    };
    store.recordTestResult(runId, null, null, ref, "skip", 0, skipped.failureMessage);
    return { verdict: skipped, stop: false };
  }
```

Classification block, beside the `stale-test-app` check:

```ts
      if (isTestPageNotRunMessage(b.verdict.failureMessage)) {
        classification.push("tests-testpage-refused");
      }
```

`runSession`, right after the `tests.length === 0` throw:

```ts
  // R-236c: before the run row and before anything reaches a server, in every bcdev coverage mode
  // (a hub-mode baseline would make the test green and send it FENCED in the covering loop). Throws
  // TestPageScanError when source a test can reach cannot be read: an unread test is not sent.
  const testPageRefused: ReadonlyMap<string, string> = caps.authoritative
    ? await scanTestPageTests(cfg.testDir, tests)
    : new Map();
```

and `testPageRefused,` in the `scope` literal. Check how `cli.ts` handles an error thrown from `runSession` (it already does for `StaleTestAppError`); if it maps error classes to exit codes, map `TestPageScanError` to the same refusal code and add a CLI test beside that mapping's test.

- [ ] **Step 4: Run** `bun run typecheck && rm -rf packages/*/dist && bun test packages/runner`. Expected: PASS; the existing R69 tests stay green unchanged.

- [ ] **Step 5: Red-checks.** (a) Delete the `dispatchUnmutated` short-circuit: "fenced: never sent" goes red. (b) Predicate `caps.authoritative && !isHubCoverageMode(caps.coverage)`: "hub coverage mode refuses too" goes red. (c) Move the scan below `createRun`: "a reachable parse error" goes red on the run-row count. (d) Delete the classification push: "fenced: never sent" goes red on `testPageRefused`. Restore, report both.

- [ ] **Step 6: Commit**

```bash
bunx biome check packages/runner/src/orchestrator.ts packages/runner/tests/orchestrator.test.ts
git add packages/runner/src/orchestrator.ts packages/runner/tests/orchestrator.test.ts
git commit -m "feat(runner): never send a test with a reachable TestPage-opening call, in any bcdev mode (R-236c)"
```

---

### Task 5: Wire `lethal verify`

**Files:**
- Modify: `packages/runner/src/verify.ts` (`VerifyPlan` near 545, `planVerify` near 620, `VerifyResult` near 740, `VerifyOutput` near 775, `runVerify` near 997 to 1100)
- Modify: `schemas/verify-v2.schema.json` (add two optional properties; no bump: no value domain changes, the all-refused result uses the existing verdict `error`)
- Test: `packages/runner/tests/verify.test.ts`; `schemas.test.ts` stays green

**Interfaces:**
- Consumes: `scanTestPageTests` (Task 1), `TESTPAGE_REFUSED_DIAGNOSIS` (Task 3).
- Produces: `VerifyPlan.testPageRefused: ReadonlyMap<string, { readonly test: string; readonly reason: string }>` (key `testKeyOf`); `VerifyPlan.notRun: ReadonlyMap<string, readonly string[]>` (mutant code -> qualified names of requested methods refused); `VerifyPlan.allRefused: ReadonlySet<string>` (mutant codes with no method left); `VerifyResult.notRun?: readonly string[]`; `VerifyOutput.testPageRefused?: { readonly tests: readonly string[]; readonly diagnosis: string }`.

`verify` always runs on the bcdev backend, so it always scans.

- [ ] **Step 1: Write the failing tests** (inside `describe("planVerify")`, reusing `source`, `manifest`, `entry`, `project`, `row`, `keys`):

```ts
  function pageTestDir(withGreenA = true): string {
    const dir = mkdtempSync(join(tmpdir(), "lethal-verify-tp-"));
    const a = withGreenA ? "    [Test]\n    procedure A()\n    begin\n    end;\n\n" : "";
    writeFileSync(
      join(dir, "50100.Codeunit.al"),
      `codeunit 50100 "Old"\n{\n    Subtype = Test;\n\n${a}    [Test]\n    procedure P()\n    var\n        Card: TestPage "X";\n    begin\n        Card.OpenView();\n    end;\n}\n`,
    );
    writeFileSync(
      join(dir, "50101.Codeunit.al"),
      `codeunit 50101 "New"\n{\n    Subtype = Test;\n\n    [Test]\n    procedure NP()\n    var\n        Card: TestPage "X";\n    begin\n        Card.Trap();\n    end;\n}\n`,
    );
    return dir;
  }

  test("R-236c: refused covering and new tests are never planned, and are named as not run", async () => {
    const plan = await planVerify({
      source: source(project(), [{ mutantCode: "M0001", coveringTests: ["Old.A", "Old.P"] }]),
      manifest: manifest([entry("M0001")]),
      sourceBaseline: [row(50100, "Old", "A"), row(50100, "Old", "P")],
      testDir: pageTestDir(),
    });
    expect(keys(plan.requests[0]?.methods ?? [])).toEqual(["50100::A"]);
    expect(keys(plan.newTests)).toEqual([]);
    expect(plan.notRun.get("M0001")).toEqual(["Old.P", "New.NP"]);
    expect([...plan.testPageRefused.keys()].sort()).toEqual(["50100::P", "50101::NP"]);
    expect(plan.allRefused.size).toBe(0);
  });

  test("R-236c: a survivor whose every test is refused is planned as all-refused, never as an empty refusal", async () => {
    const plan = await planVerify({
      source: source(project(), [{ mutantCode: "M0001", coveringTests: ["Old.P"] }]),
      manifest: manifest([entry("M0001")]),
      sourceBaseline: [row(50100, "Old", "P")],
      testDir: pageTestDir(false),
    });
    expect(plan.requests).toEqual([]);
    expect([...plan.allRefused]).toEqual(["M0001"]);
    expect(plan.notRun.get("M0001")).toEqual(["Old.P", "New.NP"]);
  });
```

And in the `runVerify` tests (the ones that stub `runNamed`): for the all-refused plan, `runVerify` must NOT call `runNamed` (the stub throws if called), and its output must have `results[0]` = `{ verdict: "error", notRun: ["Old.P", "New.NP"], testsRun: [], failureNote: <contains "TestPage refused, not run"> }`, `testPageRefused.tests` = `["New.NP", "Old.P"]`, `newTests` = `[]`, `refused` absent, and `exitCode` = `VERIFY_EXIT.nothingMeasured`. For the mixed plan: `testsRun` excludes `Old.P`, `notRun` is present, and `newTests` has no entry for `New.NP` (so it never reads `red` or `stable`).

- [ ] **Step 2: Run to verify they fail.** `bun test packages/runner/tests/verify.test.ts`.

- [ ] **Step 3: Implement.** In `planVerify`, after `const discovered = await discoverTests(testDir);`:

```ts
  // R-236c: verify runs fenced, so a test with a reachable call that may open a TestPage is never
  // planned. Throws TestPageScanError on unreadable reachable source, before anything is published.
  const refusedWhy = await scanTestPageTests(testDir, discovered);
  const testPageRefused = new Map(
    discovered.flatMap((ref) => {
      const reason = refusedWhy.get(testKeyOf(ref));
      return reason === undefined ? [] : [[testKeyOf(ref), { test: qualifiedTestName(ref), reason }] as const];
    }),
  );
  const isRefused = (ref: TestMethodRef) => testPageRefused.has(testKeyOf(ref));
  const newTests = discovered.filter((ref) => !baselineKeys.has(testKeyOf(ref)) && !isRefused(ref));
  const refusedNew = discovered.filter((ref) => !baselineKeys.has(testKeyOf(ref)) && isRefused(ref));
```

(replacing the existing `newTests` line). In the per-target loop, send refused covering matches to a `notRunHere: string[]` instead of `add(ref)`, then append `refusedNew.map(qualifiedTestName)`; `if (notRunHere.length > 0) notRun.set(t.mutantCode, notRunHere);`. When `methods.length === 0`: if `notRunHere.length > 0`, add `t.mutantCode` to `allRefused` and do NOT push a request or a `noTests` entry; otherwise keep today's `noTests` refusal. Return `{ requests, newTests, skipped, entries, testPageRefused, notRun, allRefused }`; the early `running.length === 0` return gains empty maps and set. Update the `VerifyPlan.requests` doc: "`[]` only when every target was skipped or all-refused".

In `runVerify`: call `runNamed` only when `plan.requests.length > 0` (already guarded). In the per-target result map, BEFORE the outcome lookup:

```ts
      if (plan.allRefused.has(t.mutantCode)) {
        return {
          ...base,
          verdict: "error",
          testsRun: [],
          notRun: plan.notRun.get(t.mutantCode) ?? [],
          failureNote:
            "TestPage refused, not run: every test that reaches this mutant has a reachable call that may open a TestPage, so none was sent (R-236c)",
        };
      }
```

For measured results, bind `const notRun = plan.notRun.get(t.mutantCode);` and spread `...(notRun !== undefined ? { notRun } : {})`. On the output, when `plan.testPageRefused.size > 0`: `testPageRefused: { tests: [...plan.testPageRefused.values()].map((v) => v.test).sort(), diagnosis: TESTPAGE_REFUSED_DIAGNOSIS }`. `testsRun` for measured results needs no change: `request.methods` no longer holds a refused method.

`schemas/verify-v2.schema.json`: add `notRun` (array of string) to the result item's `properties`, and `testPageRefused` (object: `tests` array of string, `diagnosis` string, both required, `additionalProperties: false`) to the root `properties`; neither goes into a `required` list.

- [ ] **Step 4: Run** `bun run typecheck && rm -rf packages/*/dist && bun test packages/runner/tests/verify.test.ts packages/runner/tests/schemas.test.ts`. Expected: PASS.

- [ ] **Step 5: Red-checks.** (a) Drop `&& !isRefused(ref)` from `newTests`: the first test goes red. (b) Route the all-refused case back to `noTests`: the second test goes red (a `VerifyError`). (c) Remove the `allRefused` branch in `runVerify`: the all-refused `runVerify` test goes red. Restore, report both.

- [ ] **Step 6: Commit**

```bash
bunx biome check packages/runner/src/verify.ts packages/runner/tests/verify.test.ts
git add packages/runner/src/verify.ts packages/runner/tests/verify.test.ts schemas/verify-v2.schema.json
git commit -m "feat(verify): never plan a TestPage test; name it TestPage refused, not run (R-236c)"
```

---

### Task 6: Prose and roadmap items

**Files:**
- Modify: `README.md` (bullets near lines 621 and 709)
- Create: two roadmap items (re-check the free ids with `ls docs/roadmap/` immediately before writing; R288 is the last today), then `bun scripts/roadmap-index.ts`

- [ ] **Step 1: README.** Rewrite the line-709 bullet: LethAL reads the test app before the run and never sends a test that has a reachable call that may open a TestPage (itself or through a helper codeunit in the test app); the report lists it as "TestPage refused, not run"; the policy is static and safety-first, so a call behind `if GuiAllowed then` is refused too; a parse error the test can reach stops the run with the file named; the limits (handler-driven pages, helpers outside the test app) are sent as before, and for those the old table still describes what can happen (relabel it "what can happen to a TestPage test LethAL cannot see"). Delete the "Mitigation that works today: run with `coverageMode: "procedure"`" paragraph: hub mode now refuses the same tests. Keep "What is still not recovered", reworded to "reported `no-coverage`, with the refused tests named in the report". Shorten line 621 to match. No em dashes.
- [ ] **Step 2: Roadmap item A**, title "`resolveVarRef` returns null for every member-expression receiver: `isMemberName` compares rebuilt wrapper nodes by reference", status `open`. Evidence: the R-236c plan's D1 and a three-line reproduction (a `Card.OpenView()` receiver resolves to null). Consequence to measure before any fix: `builtin-tier1/src/loop-hazard.ts` `classifyHangCapable` never resolves a receiver in a loop condition, so a fix can add hang-capable tags and move gate figures.
- [ ] **Step 3: Roadmap item B**, title "`collectVarDeclarations` keeps only the first name of `A, B: T`: every later name is invisible to scope resolution", status `open`. Evidence: `packages/engine/src/semantic/symbol-table.ts` `collectVarDeclarations` (`childForFieldName("name")`) and R-236c's Task 1 test "the SECOND name". Consequence to measure before any fix: Tier-2 receivers and `resolveVarRef` refuse on the later names today; a fix can add claimed sites and move gate figures. R-236c's scanner does its own collection and does not depend on the fix.
- [ ] **Step 4:** `bun scripts/roadmap-index.ts && bun test scripts/roadmap-index.test.ts`, expected PASS.
- [ ] **Step 5: Commit:** `git add README.md docs/roadmap ROADMAP.md && git commit -m "docs: TestPage pre-refusal in the README; file the two scope gaps it exposed (R-236c)"`

Not edited here (open question 3): `CLAUDE.md`'s `itest:tables` paragraph, `fixtures/README.md` near line 603, `docs/directions-emea-2026-runbook.md` line 210, `docs/directions-emea-2026-talk.md` line 128.

---

### Task 7: `itest:tables` assertion, pre-commitment, live gates, close R236

**Files:**
- Modify: `packages/runner/itest/tables.itest.ts` (`assertVerdictTable`, the block after the R78 comment near line 924)
- Create: `docs/superpowers/specs/2026-09-27-r236c-testpage-pre-refusal-precommitment.md` (committed ALONE, before any live run)
- Modify after the gate result: `docs/roadmap/R236.md`, `ROADMAP.md`

- [ ] **Step 1: Change the gate assertion.** Replace the three asserts (`unsupportedTests.length === 1`, `unsupportedTests[0]`, the `tests-testpage-unsupported` caveat) and the comment above them:

```ts
  // R-236c replaced R78's "exactly one baseline FAILURE" with "exactly one TestPage refusal, NOT
  // RUN". `PageActionComputesNonZero` has a reachable call that may open a TestPage; sending it into
  // the fenced session lost its reply and wedged the container repeatedly (R236), so LethAL now
  // refuses it from source before sending. The guard keeps its strength: ANY test failing at
  // baseline fails the gate (the list must be empty), the refusal is named, by name, and BC's own
  // TestPage refusal must be ABSENT, which is what shows the test was never sent.
  assert.deepEqual(
    report.unsupportedTests,
    [],
    `expected no baseline failure, got ${report.unsupportedTests.length}: ${report.unsupportedTests.join(", ")}`,
  );
  assert.deepEqual(
    report.testPageRefused?.tests,
    ["Data Tests.PageActionComputesNonZero"],
    "the only refused test must be the TestPage test, by name",
  );
  assert.ok(
    report.validity.caveats.includes("tests-testpage-refused"),
    "the refusal must be NAMED in the report",
  );
  assert.ok(
    !report.validity.caveats.includes("tests-testpage-unsupported"),
    "BC refused a TestPage test, so one was SENT: the pre-refusal did not engage",
  );
  assert.equal(report.validity.baselineTests.failing, 0, "failing counts real failures only");
  assert.equal(
    report.baselineGreen,
    false,
    "a refused test is not a green one: baselineGreen keeps its meaning (every discovered test passed)",
  );
```

`bun run typecheck && rm -rf packages/*/dist`, `bunx biome check packages/runner/itest/tables.itest.ts`, then `git commit -m "test(itest): tables pins one named TestPage refusal, not run (R-236c)" -- packages/runner/itest/tables.itest.ts`.

- [ ] **Step 2: Write and commit the pre-commitment ALONE** (fill only the Step 1 commit hash):

```markdown
# Pre-commitment: R-236c TestPage pre-refusal on the live gates

Written and committed before any live run of the R-236c build (<Step 1 commit>). Nothing above
OUTCOME changes after a run.

## Container and protocol
Cronus28, under a coord lease, control app 1.0.0.19, fixture apps as published for GH-24.

`itest:tables` cannot pass end to end at HEAD: `EXPECTED` holds 397 sites while GH-24's arm
generates 407 (docs/superpowers/specs/2026-09-25-gh24-reach-control-precommitment.md, section 5 and
OUTCOME). So it runs as GH-24's protocol RUN 1: `EXPECTED` set to section 5's figures in the
working tree only (407 sites, 301 / 68 / 18, score 301 / 369, groupedCalls 382, warmKills 13), the
committed `tables.baseline.json` KEPT. The edit is a patch in the scratchpad, reverted with
`git apply -R`, never committed.

## Predictions (every one BLOCKING)
1. `itest:tables` run 1: `assertVerdictTable` passes in full: `unsupportedTests` empty;
   `testPageRefused.tests` exactly `["Data Tests.PageActionComputesNonZero"]`; caveat
   `tests-testpage-refused` present and `tests-testpage-unsupported` absent;
   `baselineTests.failing` 0; `baselineGreen` false; counts 301 / 68 / 18; no quarantine; no
   `TestPageScanError`; `assertSessionLiveness` passes. The run then stops in
   `assertMatchesBaseline` with EXACTLY ten "present in after but missing from before"
   differences, all `Data Reach Ops`, and ZERO differences of any kind on the 377 existing mutants
   (verdict, killingTest, coverageFiltered, errorClass). The four `Data Value Card` /
   `Data Value Source` mutants stay `no-coverage`.
2. In that run's store, `Data Tests.PageActionComputesNonZero` has one `test_results` row per
   session, outcome `skip`, message starting "not run: LethAL refused this test before sending it".
3. `itest:bcdev`: PASS, 3 / 12 / 4, groupedCalls 15, warmKills 0, `vacuous`; no `testPageRefused`.
4. `itest:chunked`: PASS, both legs 17 / 7 / 2 with identical verdicts and killingTest, control
   warmKills 9 / groupedCalls 33, chunked 5 / 57; its reports carry
   `testPageRefused.tests == ["Data Tests.PageActionComputesNonZero"]`.

A verdict or field difference on any existing mutant, a count other than predicted, a
`TestPageScanError`, or a `tests-testpage-unsupported` caveat on a sandbox-data run is a BLOCK,
filed before anything else moves.

## OUTCOME
(Filled in after the runs.)
```

```bash
git add docs/superpowers/specs/2026-09-27-r236c-testpage-pre-refusal-precommitment.md
git commit -m "spec: pre-commit R-236c's live gate predictions"
```

- [ ] **Step 3: Offline gate.** `bun run typecheck && rm -rf packages/*/dist && bun test`: full suite green.

- [ ] **Step 4: Live runs** (foreground, never poll), on Cronus28 under a coord lease:

```bash
LETHAL_ITEST_BCDEV=1 bun run itest:bcdev
LETHAL_ITEST_CHUNKED=1 bun run itest:chunked
# tables: apply the scratch EXPECTED patch (GH-24 section 5 figures), keep tables.baseline.json
LETHAL_ITEST_TABLES=1 bun run itest:tables
# then: git apply -R <scratchpad>/r236c-expected.patch ; git status must show no change to tables.itest.ts
```

Read the `assertMatchesBaseline` output line by line against prediction 1: count the "missing from before" lines, confirm every one is `Data Reach Ops`, and confirm there is no other difference line. That per-mutant comparison is the BLOCKING check that no verdict moved, not the counts. For prediction 2, query the run's store before the gate removes its scratch directory; if it is gone, run `lethal run` once on `fixtures/sandbox-data` with `--out` and read that run's rows.

- [ ] **Step 5: Fill OUTCOME** with each prediction's result, the verbatim counts and the `testPageRefused` report lines. Commit: `git commit -m "spec: R-236c live outcome" -- docs/superpowers/specs/2026-09-27-r236c-testpage-pre-refusal-precommitment.md`.

- [ ] **Step 6: Close R236 (owner ruling: when `itest:tables` passes).** Here "passes" means prediction 1 held exactly, since the end-to-end pass waits on GH-24's re-record; if the orchestrator rules that only GH-24 run 2 counts, do this step after that run. Set `status: "done (<Task 4 commit>)"` in `docs/roadmap/R236.md` and append: "2026-09-27, R-236c: LethAL no longer sends a test with a reachable call that may open a TestPage, in any bcdev coverage mode, so the fixture test behind every recorded hit is no longer sent by any gate. Measured on Cronus28: <prediction 1 result>. The platform behaviour itself (R263) stays open." Then `bun scripts/roadmap-index.ts && bun test scripts/roadmap-index.test.ts` and `git commit -m "roadmap: close R236 (R-236c)" -- docs/roadmap/R236.md ROADMAP.md`.

- [ ] **Step 7: Hand-off.** Tell the orchestrator that GH-24's re-record (section 5 figures into `EXPECTED`, delete and re-record `tables.baseline.json`, GH-24 run 2) can proceed on the merged tree, and that run 2 must pass END TO END, including the determinism check, before the recorded file is kept.

---

## Open questions for the orchestrator

1. **R236's closing point.** Task 7 closes it on prediction 1 (run 1 passes every R-236c assertion and the per-mutant check), because the end-to-end pass waits on GH-24's re-record. Or only on GH-24 run 2?
2. **Census outcome.** Task 2 stops the landing if a loud error fires on any GH-06 corpus. The expected risk is loud rule 3 (an unresolved call target, which is common because tests call Microsoft's libraries, combined with any codeunit parse error anywhere in the app). If it fires, the choices are to narrow rule 3 or accept the stop on that suite.
3. **Prose outside this plan:** `CLAUDE.md`'s `itest:tables` paragraph ("exactly ONE expected baseline failure ... fails"; needs the owner), `fixtures/README.md` near line 603, and the EMEA runbook and talk.
