import { beforeAll, describe, expect, test } from "bun:test";
import { initParser } from "@lethal/engine";
import { testsInAlSource } from "../src/discovery";
import { subscriberFold, testDigestsOfSources, walkTest } from "../src/test-digest";
import { Scanner, buildTestAppModel } from "../src/testpage-scan";

/**
 * R-389 (plan docs/superpowers/plans/2026-10-04-R-389-variant-interface-reach.md, r2): a Variant
 * or an Interface handed to code in another app can hold a test-app codeunit, which that code can
 * run. The property tested is the real one: edit the codeunit, and the digest of every test that
 * can hand it out must move; edit a codeunit nothing hands out, and it must not (a fold, not the
 * whole-source fallback). Synthetic AL only. `Ext Runner`, `Ext Pub` and `Ext Iface` are not in
 * the test app: they stand for a dependency's code.
 */

beforeAll(async () => {
  await initParser();
});

const I = { dependencies: "d", buildInputs: "b" };

type Part = "mock" | "mock2" | "inner" | "inner2" | "unrelated" | "table" | "impl" | "page";
type Edits = Partial<Record<Part, string>>;
type Scenario = (e: Edits) => Record<string, string>;

/** The marker comment an edit changes: a comment edit inside a procedure is a real edit. */
const at = (e: Edits, part: Part): string => `        // ${e[part] ?? "as built"}\n`;

const proc = (name: string, vars: string, body: string, attr = "    [Test]\n"): string =>
  `${attr}    procedure ${name}\n${vars === "" ? "" : `    var\n${vars}`}    begin\n${body}    end;\n\n`;

const testUnit = (procs: string, globals = ""): string =>
  `codeunit 50100 "T"\n{\n    Subtype = Test;\n${globals === "" ? "" : `\n    var\n${globals}`}\n${procs}}\n`;

const IFACE = `interface "IFace"\n{\n    procedure Go();\n}\n`;
const IFACE2 = `interface "IFace2" extends "IFace"\n{\n}\n`;
const mock = (e: Edits, extra = "", globals = ""): string =>
  `codeunit 50101 "Mock" implements "IFace"\n{\n${globals === "" ? "" : `    var\n${globals}\n`}    procedure Go()\n    begin\n${at(e, "mock")}    end;\n${extra}}\n`;
const mock2 = (e: Edits): string =>
  `codeunit 50102 "Mock2" implements "IFace2"\n{\n    procedure Go()\n    begin\n${at(e, "mock2")}    end;\n}\n`;
const plain = (id: number, name: string, part: Part, e: Edits, impl = ""): string =>
  `codeunit ${id} "${name}"${impl}\n{\n    procedure Go()\n    begin\n${at(e, part)}    end;\n}\n`;
const table = (e: Edits): string =>
  `table 50110 "TT"\n{\n    fields\n    {\n        field(1; "No."; Code[20]) { }\n    }\n\n    trigger OnModify()\n    begin\n${at(e, "table")}    end;\n}\n`;
const subscribers = (procs: string, vars = ""): string =>
  `codeunit 50140 "Subs"\n{\n${vars === "" ? "" : `    var\n${vars}\n`}${procs}}\n`;
const sub = (name: string, params: string, vars: string, body: string): string =>
  proc(
    `${name}(${params})`,
    vars,
    body,
    `    [EventSubscriber(ObjectType::Codeunit, Codeunit::"Ext Pub", '${name}', '', false, false)]\n    local`,
  ).replace("    local    procedure", "    local procedure");

/** The objects every scenario holds besides its test codeunit. */
const base = (e: Edits, mockExtra = "", mockGlobals = ""): Record<string, string> => ({
  "IFace.al": IFACE,
  "IFace2.al": IFACE2,
  "Mock.al": mock(e, mockExtra, mockGlobals),
  "Mock2.al": mock2(e),
  "Unrelated.al": plain(50109, "Unrelated", "unrelated", e),
  "TT.al": table(e),
});

const EXT = `        Ext: Codeunit "Ext Runner";\n`;
const MOCK = `        Mock: Codeunit "Mock";\n`;
const V = "        V: Variant;\n";
/** A test that hands out nothing: what a subscriber-closure change reaches only through the fold. */
const TRIVIAL = proc("Trivial()", "", "        Message('x');\n");

function run(files: Record<string, string>) {
  const list = Object.entries(files).map(([path, text]) => ({ path, text }));
  const tests = list.flatMap((f) => testsInAlSource(f.path, f.text));
  const digests = testDigestsOfSources(list, tests, I);
  const model = buildTestAppModel(list);
  expect(model.damaged).toEqual([]);
  const scanner = new Scanner(model);
  const closure = subscriberFold(scanner, model).fallback;
  const why: Record<string, string | undefined> = {};
  for (const t of tests) why[t.method.toLowerCase()] = walkTest(scanner, model, t).fallback;
  return {
    digest: (m: string): string | undefined => digests[`50100::${m.toLowerCase()}`],
    why: (m: string): string | undefined => why[m.toLowerCase()],
    closure,
  };
}

/** Whether editing `part` moves the digest of test `m`. */
function moves(s: Scenario, part: Part, m: string): boolean {
  const before = run(s({})).digest(m);
  const after = run(s({ [part]: "edited" })).digest(m);
  expect(before).toBeDefined();
  return before !== after;
}

describe("R-389 part 1: a Variant handed out as an argument", () => {
  // 1
  const fromMock: Scenario = (e) => ({
    ...base(e),
    "T.al": testUnit(proc("A()", V + MOCK + EXT, "        V := Mock;\n        Ext.Go(V);\n")),
  });
  test("1. V := Mock; Ext.Go(V): an edit to Mock moves the digest, an unreached codeunit's does not", () => {
    expect(moves(fromMock, "mock", "A")).toBe(true);
    expect(moves(fromMock, "unrelated", "A")).toBe(false);
    expect(run(fromMock({})).why("A")).toBeUndefined();
  });

  // 2
  const fromIface: Scenario = (e) => ({
    ...base(e),
    "T.al": testUnit(
      proc(
        "A()",
        `${V}        I: Interface "IFace";\n${MOCK}${EXT}`,
        "        I := Mock;\n        V := I;\n        Ext.Go(V);\n",
      ),
    ),
  });
  test("2. I := Mock; V := I; Ext.Go(V): every implementation of I folds, through extends too", () => {
    expect(moves(fromIface, "mock", "A")).toBe(true);
    expect(moves(fromIface, "mock2", "A")).toBe(true);
    expect(moves(fromIface, "unrelated", "A")).toBe(false);
    expect(run(fromIface({})).why("A")).toBeUndefined();
  });

  // 3
  const chain: Scenario = (e) => ({
    ...base(e),
    "T.al": testUnit(
      proc(
        "A()",
        `${V}        W: Variant;\n${MOCK}${EXT}`,
        "        W := Mock;\n        V := W;\n        Ext.Go(V);\n",
      ),
    ),
  });
  test("3. W := Mock; V := W; Ext.Go(V): the Variant chain folds Mock", () => {
    expect(moves(chain, "mock", "A")).toBe(true);
    expect(moves(chain, "unrelated", "A")).toBe(false);
  });

  // 4, 5
  const unseenFiles = (): Record<string, string> => ({
    ...base({}),
    "T.al": testUnit(
      proc("ViaParam()", MOCK, "        PassOn(Mock);\n") +
        proc("FromGlobal()", EXT, "        Ext.Go(GlobalV);\n") +
        proc("ViaVarArg()", V + EXT, "        Fill(V);\n        Ext.Go(V);\n") +
        proc("FromReturn()", V + EXT, "        V := MakeVariant();\n        Ext.Go(V);\n") +
        proc(
          "ListElement()",
          `        L: List of [Variant];\n${EXT}`,
          "        Ext.Go(L.Get(1));\n",
        ) +
        proc(
          "ArrayElement()",
          `        Arr: array[2] of Variant;\n${EXT}`,
          "        Ext.Go(Arr[1]);\n",
        ) +
        proc(
          "Foreach()",
          `${V}        L: List of [Variant];\n${EXT}`,
          "        foreach V in L do\n            Ext.Go(V);\n",
        ) +
        proc(
          "FromListGet()",
          `${V}        L: List of [Variant];\n${EXT}`,
          "        L.Get(1, V);\n        Ext.Go(V);\n",
        ) +
        proc("WholeList()", `        L: List of [Variant];\n${EXT}`, "        Ext.Go(L);\n") +
        proc("CallReturn()", EXT, "        Ext.Go(MakeVariant());\n") +
        proc(
          "Cycle()",
          `${V}        W: Variant;\n${EXT}`,
          "        W := V;\n        V := W;\n        Ext.Go(V);\n",
        ) +
        proc("PassOn(P: Variant)", EXT, "        Ext.Go(P);\n", "    local") +
        proc("Fill(var X: Variant)", MOCK, "        X := Mock;\n", "    local") +
        proc("MakeVariant(): Variant", MOCK, "        exit(Mock);\n", "    local"),
      "        GlobalV: Variant;\n",
    ).replaceAll("    local    procedure", "    local procedure"),
  });
  let cached: ReturnType<typeof run> | undefined;
  const unseen = (): ReturnType<typeof run> => {
    cached ??= run(unseenFiles());
    return cached;
  };
  // R-389 option (a): a parameter is traced through every test-app caller (the "N1" tests below).
  test("4. a helper handing out its own Variant parameter: traced through its caller, no fallback", () => {
    expect(unseen().why("ViaParam")).toBeUndefined();
  });
  test("5. a global, a var argument, a call's return, an element: each falls back", () => {
    const u = unseen();
    expect(u.why("FromGlobal")).toContain("the global GlobalV");
    expect(u.why("ViaVarArg")).toContain("filled by Fill through a var parameter");
    expect(u.why("FromReturn")).toContain("assigned from a value of Variant");
    expect(u.why("ListElement")).toContain("an element or a return of List of [Variant]");
    expect(u.why("ArrayElement")).toContain("an element or a return of array[2] of Variant");
    expect(u.why("Foreach")).toContain("a foreach variable");
    expect(u.why("FromListGet")).toContain("filled by L.Get from a collection");
    expect(u.why("WholeList")).toContain("an array or collection of Variant");
    expect(u.why("CallReturn")).toContain("is handed a value of Variant");
    expect(u.why("Cycle")).toContain("is assigned in a cycle");
  });

  // Added with the build (proved by red-check, not seen red before the code): `this`, a page.
  const handsSelf: Scenario = (e) => ({
    ...base(e, proc("HandSelf()", V + EXT, "        V := this;\n        Ext.Go(V);\n", "")),
    "T.al": testUnit(proc("A()", MOCK, "        Mock.HandSelf();\n")),
  });
  test("14. V := this in a codeunit folds that codeunit whole", () => {
    expect(moves(handsSelf, "mock", "A")).toBe(true);
    expect(moves(handsSelf, "unrelated", "A")).toBe(false);
    expect(run(handsSelf({})).why("A")).toBeUndefined();
  });
  test("15. V := this in a table falls back", () => {
    const r = run({
      ...base({}),
      "TT.al": table({}).replace(
        "\n    trigger OnModify()",
        `\n${proc("HandSelf()", V + EXT, "        V := this;\n        Ext.Go(V);\n", "")}    trigger OnModify()`,
      ),
      "T.al": testUnit(
        proc("A()", `        TestRec: Record "TT";\n`, "        TestRec.HandSelf();\n"),
      ),
    });
    expect(r.why("A")).toContain("assigned from this in a table");
  });
  const handsPage: Scenario = (e) => ({
    ...base(e),
    // The page's own text is in the digest once the page is reached at all; what its triggers
    // run is in it only when the page is ENTERED.
    "PP.al": `page 50160 "PP"\n{\n    trigger OnOpenPage()\n    var\n        Inner: Codeunit "Inner2";\n    begin\n${at(e, "page")}        Inner.Go();\n    end;\n}\n`,
    "Inner2.al": plain(50104, "Inner2", "inner2", e),
    "T.al": testUnit(
      proc("A()", `${V}        P: Page "PP";\n${EXT}`, "        V := P;\n        Ext.Go(V);\n"),
    ),
  });
  test("16. V := a test-app page variable enters the page", () => {
    expect(moves(handsPage, "page", "A")).toBe(true);
    expect(moves(handsPage, "inner2", "A")).toBe(true);
    expect(moves(handsPage, "unrelated", "A")).toBe(false);
  });

  // 6, 7: pins, recorded at HEAD before R-389's code.
  test("6. V := Cust (a record): the digest is byte-identical to HEAD's", () => {
    const r = run({
      ...base({}),
      "T.al": testUnit(
        proc(
          "A()",
          `${V}        Cust: Record Customer;\n${EXT}`,
          "        V := Cust;\n        Ext.Go(V);\n",
        ),
      ),
    });
    expect(r.digest("A")).toBe(PIN_RECORD);
  });
  test("7. a RecordRef and a FieldRef handed out: digests byte-identical to HEAD's", () => {
    const r = run({
      ...base({}),
      "T.al": testUnit(
        proc("R()", `        RR: RecordRef;\n${EXT}`, "        Ext.Go(RR);\n") +
          proc("F()", `        FR: FieldRef;\n${EXT}`, "        Ext.Go(FR);\n"),
      ),
    });
    expect([r.digest("R"), r.digest("F")]).toEqual(PIN_REFS);
  });
});

describe("R-389 part 2: hand-outs from entry procedures", () => {
  const withSubs = (procs: string, e: Edits, vars = ""): Record<string, string> => ({
    ...base(e),
    "Subs.al": subscribers(procs, vars),
    "T.al": testUnit(TRIVIAL + proc("B()", "", "        Message('y');\n")),
  });

  // 8
  const subVariant: Scenario = (e) =>
    withSubs(sub("OnGetHandler", "var Handler: Variant", MOCK, "        Handler := Mock;\n"), e);
  test("8. a subscriber's var Variant set to Mock: an edit to Mock moves EVERY digest", () => {
    expect(moves(subVariant, "mock", "Trivial")).toBe(true);
    expect(moves(subVariant, "mock", "B")).toBe(true);
    expect(moves(subVariant, "unrelated", "Trivial")).toBe(false);
    expect(run(subVariant({})).closure).toBeUndefined();
  });

  // 9
  const subIface: Scenario = (e) =>
    withSubs(sub("OnGetImpl", `var Impl: Interface "IFace"`, MOCK, "        Impl := Mock;\n"), e);
  test("9. a subscriber's var Interface: every implementation folds into every digest", () => {
    expect(moves(subIface, "mock", "Trivial")).toBe(true);
    expect(moves(subIface, "mock2", "B")).toBe(true);
    expect(moves(subIface, "unrelated", "Trivial")).toBe(false);
  });

  // 10
  const INNER = (e: Edits) => plain(50103, "InnerMock", "inner", e, ` implements "IFace"`);
  const handsOutMock =
    (mockExtra: string): Scenario =>
    (e) => ({
      ...base(e, mockExtra),
      "Inner.al": INNER(e),
      "Inner2.al": plain(50104, "Inner2", "inner2", e),
      "T.al": testUnit(
        proc("A()", V + MOCK + EXT, "        V := Mock;\n        Ext.Go(V);\n") + TRIVIAL,
      ),
    });
  test("10a. an Interface return of a handed-out codeunit folds the interface's implementations", () => {
    const s = handsOutMock(
      proc(
        'GetInner(): Interface "IFace"',
        `        Inner: Codeunit "InnerMock";\n`,
        "        exit(Inner);\n",
        "",
      ),
    );
    expect(moves(s, "inner", "A")).toBe(true);
    expect(moves(s, "inner", "Trivial")).toBe(false);
  });
  test("10b. a Variant return by exit, of a handed-out codeunit, folds what it returns", () => {
    const s = handsOutMock(
      proc(
        "GetAny(): Variant",
        `        Inner: Codeunit "Inner2";\n`,
        "        exit(Inner);\n",
        "",
      ),
    );
    expect(moves(s, "inner2", "A")).toBe(true);
    expect(moves(s, "inner2", "Trivial")).toBe(false);
    expect(moves(s, "unrelated", "A")).toBe(false);
  });
  test("10c. a NAMED Variant return in an enum's implementation codeunit folds into every digest", () => {
    const s: Scenario = (e) => ({
      ...base(e),
      "E.al": `enum 50130 "E" implements "IFace"\n{\n    Extensible = false;\n\n    value(0; Zero)\n    {\n        Implementation = "IFace" = "EnumImpl";\n    }\n}\n`,
      "EnumImpl.al": `codeunit 50131 "EnumImpl" implements "IFace"\n{\n${proc("Go()", "", "", "")}${proc("GetNamed() R: Variant", `        Inner: Codeunit "Inner2";\n`, "        R := Inner;\n", "")}}\n`,
      "Inner2.al": plain(50104, "Inner2", "inner2", e),
      "T.al": testUnit(TRIVIAL),
    });
    expect(moves(s, "inner2", "Trivial")).toBe(true);
    expect(moves(s, "unrelated", "Trivial")).toBe(false);
  });

  // 11
  const BAD = proc("GetBad(var X: Variant)", "", "        X := GlobalMockV;\n", "");
  test("11a. a handed-out codeunit filling a var Variant from a global: that test falls back", () => {
    const r = run({
      ...base({}, BAD, "        GlobalMockV: Variant;\n"),
      "T.al": testUnit(
        proc("A()", V + MOCK + EXT, "        V := Mock;\n        Ext.Go(V);\n") + TRIVIAL,
      ),
    });
    expect(r.why("A")).toContain("the global GlobalMockV");
    expect(r.why("A")).toContain("Mock.GetBad hands out X");
    expect(r.why("Trivial")).toBeUndefined();
    expect(r.closure).toBeUndefined();
  });
  test("11b. the same in a subscriber puts every test on the fallback", () => {
    const r = run(
      withSubs(
        sub("GetBad", "var X: Variant", "", "        X := GlobalSubV;\n"),
        {},
        "        GlobalSubV: Variant;\n",
      ),
    );
    expect(r.closure).toContain("the global GlobalSubV");
  });

  // 12
  const subRecRef: Scenario = (e) =>
    withSubs(
      sub(
        "OnX",
        "var RecRef: RecordRef",
        `        TestRec: Record "TT";\n`,
        "        RecRef.GetTable(TestRec);\n",
      ),
      e,
    );
  test("12. a subscriber's var RecordRef: an edit to a test-app table's trigger moves every digest", () => {
    expect(moves(subRecRef, "table", "Trivial")).toBe(true);
    expect(moves(subRecRef, "unrelated", "Trivial")).toBe(false);
  });

  const subRecord: Scenario = (e) =>
    withSubs(
      sub(
        "OnGetRec",
        "var Handler: Variant",
        `        TestRec: Record "TT";\n`,
        "        Handler := TestRec;\n",
      ),
      e,
    );
  test("12b. a subscriber's var Variant set to a test-app record folds every test-app table", () => {
    expect(moves(subRecord, "table", "Trivial")).toBe(true);
    expect(moves(subRecord, "unrelated", "Trivial")).toBe(false);
  });

  // 13: pins, recorded at HEAD before R-389's code.
  test("13. a never-assigned var Variant and by-value Variant / Interface parameters: digests byte-identical to HEAD's", () => {
    const r = run(
      withSubs(
        sub("OnA", "var Handler: Variant", "", "") +
          sub("OnB", `V: Variant; I: Interface "IFace"`, "", ""),
        {},
      ),
    );
    expect([r.digest("Trivial"), r.digest("B")]).toEqual(PIN_SUB_UNTOUCHED);
  });
});

describe("R-389 bi:none: an interface with no test-app implementation folds nothing", () => {
  // The shape that read "1,854 tests newly wider" in the probe's first DO run: an interface
  // handed out (in a test, and in the subscriber closure) that no test-app codeunit implements.
  const shape =
    (withImpl: boolean): Scenario =>
    (e) => ({
      ...base(e),
      ...(withImpl
        ? { "Impl.al": plain(50150, "Ext Impl", "impl", e, ` implements "Ext Iface"`) }
        : {}),
      "Subs.al": subscribers(sub("OnGetSender", `var Sender: Interface "Ext Iface"`, "", "")),
      "T.al": testUnit(
        proc(
          "A()",
          `${V}        Sender: Interface "Ext Iface";\n${EXT}`,
          "        V := Sender;\n        Ext.Go(V);\n",
        ) + TRIVIAL,
      ),
    });
  test("no implementation: every digest byte-identical to HEAD's, and no fallback", () => {
    const r = run(shape(false)({}));
    expect([r.digest("A"), r.digest("Trivial")]).toEqual(PIN_BI_NONE);
    expect(r.why("A")).toBeUndefined();
    expect(r.closure).toBeUndefined();
  });
  test("control: one test-app implementation is folded into every digest", () => {
    expect(moves(shape(true), "impl", "A")).toBe(true);
    expect(moves(shape(true), "impl", "Trivial")).toBe(true);
    expect(moves(shape(true), "unrelated", "Trivial")).toBe(false);
  });
});

describe("R-389 final review (sol): three holes, each closed fail-closed", () => {
  // Hole 1: Format(V) gives the held codeunit's object id (live probe R4d), and the string can
  // reach a dependency's `Evaluate` + `Codeunit.Run` through any argument.
  const formatted =
    (body: string): Scenario =>
    (e) => ({
      ...base(e),
      "T.al": testUnit(
        proc("A()", `${V}        S: Text;\n${MOCK}${EXT}`, body),
        "        GlobalV: Variant;\n",
      ),
    });
  const viaFormat = formatted("        V := Mock;\n        Ext.RunFormatted(Format(V));\n");
  test("H1a. V := Mock; Ext.RunFormatted(Format(V)): an edit to Mock moves the digest", () => {
    expect(moves(viaFormat, "mock", "A")).toBe(true);
    expect(moves(viaFormat, "unrelated", "A")).toBe(false);
    expect(run(viaFormat({})).why("A")).toBeUndefined();
  });
  test("H1b. the same through StrSubstNo into a Text, handed out later", () => {
    const s = formatted(
      "        V := Mock;\n        S := StrSubstNo('%1', V);\n        Ext.RunFormatted(S);\n",
    );
    expect(moves(s, "mock", "A")).toBe(true);
    expect(moves(s, "unrelated", "A")).toBe(false);
  });
  test("H1c. Format of a Variant the walk cannot trace falls back", () => {
    const r = run(formatted("        Ext.RunFormatted(Format(GlobalV));\n")({}));
    expect(r.why("A")).toContain("the global GlobalV");
  });
  test("H1 control: Format of a Variant that holds only a value: digest byte-identical", () => {
    const r = run(formatted("        V := 5;\n        Ext.RunFormatted(Format(V));\n")({}));
    expect(r.digest("A")).toBe(PIN_FORMAT_VALUE);
  });

  // Hole 2: a parenthesis-less call is a call, never an undeclared (harmless) name.
  const own =
    (body: string, extra = ""): Scenario =>
    (e) => ({
      ...base(e),
      "T.al": testUnit(
        proc("A()", V + EXT, body) +
          proc("MakeVariant(): Variant", MOCK, "        exit(Mock);\n", "    local") +
          proc('MakeMock(): Codeunit "Mock"', MOCK, "        exit(Mock);\n", "    local") +
          extra,
      ).replaceAll("    local    procedure", "    local procedure"),
    });
  test("H2a. V := MakeVariant (no parentheses) falls back, as MakeVariant() does", () => {
    const r = run(own("        V := MakeVariant;\n        Ext.Go(V);\n")({}));
    expect(r.why("A")).toContain("assigned from a value of Variant");
  });
  test("H2b. Ext.Go(MakeVariant) (no parentheses) falls back", () => {
    const r = run(own("        Ext.Go(MakeVariant);\n")({}));
    expect(r.why("A")).toContain("a value of Variant");
  });
  test("H2c. V := MakeMock (no parentheses, returns a test-app codeunit) folds Mock", () => {
    const s = own("        V := MakeMock;\n        Ext.Go(V);\n");
    expect(moves(s, "mock", "A")).toBe(true);
    expect(moves(s, "unrelated", "A")).toBe(false);
    expect(run(s({})).why("A")).toBeUndefined();
  });
  test("H2d. a name that resolves to nothing the walk knows (V := Today) falls back", () => {
    const r = run(own("        V := Today;\n        Ext.Go(V);\n")({}));
    expect(r.why("A")).toContain("Today");
  });

  // Hole 3: an interface the test app does not declare can extend another (a dependency's
  // `IDerived extends IBase`), which the walk cannot see. A test-app codeunit implementing such
  // an interface, directly or through a test-app interface, may implement the one handed out.
  const ancestry =
    (handed: string): Scenario =>
    (e) => ({
      ...base(e),
      "Dep.al": plain(50170, "DepMock", "impl", e, ` implements "IDerived"`),
      "IX.al": `interface "IX" extends "IDerived"\n{\n}\n`,
      "Dep2.al": plain(50171, "DepMock2", "inner2", e, ` implements "IX"`),
      "T.al": testUnit(
        proc(
          "A()",
          `${V}        I: Interface "${handed}";\n${EXT}`,
          "        V := I;\n        Ext.Go(V);\n",
        ) + TRIVIAL,
      ),
      "Subs.al": subscribers(sub("OnGet", `var J: Interface "${handed}"`, "", "")),
    });
  test("H3. a dependency interface handed out folds every test-app codeunit of unknown ancestry", () => {
    const s = ancestry("IBase");
    expect(moves(s, "impl", "A")).toBe(true);
    expect(moves(s, "impl", "Trivial")).toBe(true);
    expect(moves(s, "inner2", "Trivial")).toBe(true);
    expect(moves(s, "unrelated", "Trivial")).toBe(false);
  });
  test("H3 control: a TEST-APP interface handed out does not fold them (no dependency can extend it)", () => {
    const s = ancestry("IFace");
    expect(moves(s, "impl", "A")).toBe(false);
    expect(moves(s, "inner2", "Trivial")).toBe(false);
    expect(moves(s, "mock", "Trivial")).toBe(true);
  });
});

describe("R-389 option (a), narrowing 1: a Variant parameter traced through its callers", () => {
  // DC's shape: a test-app assert helper formats its Variant parameter.
  const LIB = (e: Edits, attrs = "", impl = "", extra = ""): string =>
    `codeunit 50180 "Lib"${impl}\n{\n${attrs}    procedure Check(Result: Variant)\n    var\n${EXT}    begin\n        Ext.RunFormatted(Format(Result));\n    end;\n${impl === "" ? "" : "\n    procedure Go()\n    begin\n    end;\n"}${extra}}\n`;
  const LIBV = `        Lib: Codeunit "Lib";\n        Cust: Record Customer;\n`;
  const callers = (more = ""): string =>
    proc("A()", LIBV, "        Lib.Check(5);\n        Lib.Check(Cust);\n") + more;
  const s =
    (lib: (e: Edits) => string, more = "", globals = ""): Scenario =>
    (e) => ({
      ...base(e),
      "Lib.al": lib(e),
      "T.al": testUnit(callers(more), globals),
    });
  test("N1a. every caller passes a value or a record: no fallback (it fell back before)", () => {
    const r = run(s((e) => LIB(e))({}));
    expect(r.why("A")).toBeUndefined();
    expect(r.closure).toBeUndefined();
  });
  test("N1b. hole 1 through a parameter: a caller passing a Mock-holding Variant folds Mock", () => {
    const sc = s(
      (e) => LIB(e),
      proc("B()", LIBV + V + MOCK, "        V := Mock;\n        Lib.Check(V);\n"),
    );
    expect(moves(sc, "mock", "B")).toBe(true);
    expect(moves(sc, "mock", "A")).toBe(true); // the union over every caller
    expect(moves(sc, "unrelated", "A")).toBe(false);
    expect(run(sc({})).why("A")).toBeUndefined();
  });
  test("N1c. a caller the walk cannot trace (a global) keeps the fallback", () => {
    const r = run(
      s((e) => LIB(e), proc("B()", LIBV, "        Lib.Check(GlobalV);\n"), "        GlobalV: Variant;\n")({}),
    );
    expect(r.why("A")).toContain("the global GlobalV");
  });
  test("N1d. unseen callers keep the fallback: interface dispatch, a subscriber", () => {
    const viaIface = run(s((e) => LIB(e, "", ` implements "IFace"`))({}));
    expect(viaIface.why("A")).toContain("can be called from outside the test app");
    const sub = run(
      s((e) =>
        LIB(
          e,
          `    [EventSubscriber(ObjectType::Codeunit, Codeunit::"Ext Pub", 'OnX', '', false, false)]\n`,
        ),
      )({}),
    );
    expect(sub.closure ?? sub.why("A")).toContain("can be called from outside the test app");
  });
  test("N1e. a parameter passed on through a cycle of callers keeps the fallback", () => {
    const r = run(
      s((e) =>
        LIB(
          e,
          "",
          "",
          `\n    procedure Again(R: Variant)\n    begin\n        Check(R);\n        Again(R);\n    end;\n`,
        ).replace("        Ext.RunFormatted(Format(Result));\n", "        Ext.RunFormatted(Format(Result));\n        Again(Result);\n"),
      )({}),
    );
    expect(r.why("A")).toContain("cycle");
  });
});

describe("R-389 option (a), narrowing 2: namespace-qualified names", () => {
  const qualified =
    (type: string, call = "SetCode(200)"): Scenario =>
    (e) => ({
      ...base(e),
      "T.al": testUnit(proc("A()", `        Resp: Codeunit ${type};\n`, `        Resp.${call};\n`)),
    });
  test("N2a. a qualified name the test app does not declare is a dependency's: no fallback", () => {
    expect(run(qualified(`System.RestClient."Http Response Message"`)({})).why("A")).toBeUndefined();
  });
  test("N2b. a qualified name whose object IS in the test app is walked into", () => {
    const sc = qualified(`My.Ns."Mock"`, "Go()");
    expect(moves(sc, "mock", "A")).toBe(true);
    expect(moves(sc, "unrelated", "A")).toBe(false);
    expect(run(sc({})).why("A")).toBeUndefined();
  });
  test("N2c. a reference the walk still cannot read (an id) keeps the fallback", () => {
    expect(run(qualified("50999")({})).why("A")).toContain("not one plain name");
  });
  test("N2d. hole 3 kept: a dependency-ancestry implementer naming a qualified codeunit still folds, closure clean", () => {
    const sc: Scenario = (e) => ({
      ...base(e),
      "Dep.al": `codeunit 50170 "DepMock" implements "IDerived"\n{\n    procedure Go()\n    var\n        Resp: Codeunit System.RestClient."Http Response Message";\n    begin\n${at(e, "impl")}        Resp.SetCode(200);\n    end;\n}\n`,
      "Subs.al": subscribers(sub("OnGet", `var J: Interface "IBase"`, "", "")),
      "T.al": testUnit(TRIVIAL),
    });
    expect(moves(sc, "impl", "Trivial")).toBe(true);
    expect(run(sc({})).closure).toBeUndefined();
  });
});

// Recorded on lethal/r389 at e458eb55, BEFORE the final-review fixes.
const PIN_FORMAT_VALUE = "v3:f76b1742a86bdd76bae3c61adefbfaf6ee5c07e64c0f3e18a117cd89897cbb95";

// Recorded on lethal/r389 at 48598264 (master 5c0631a5 merged), BEFORE R-389's code: these
// shapes must digest exactly as they did, so a change here is a regression, never a re-record.
const PIN_RECORD = "v3:bed9abb7629d75d7adea58a19093f9aa35bbc94cdb65f43c0cae918ce2908d8b";
const PIN_REFS = [
  "v3:40a021e0bdd1e0751352ca66a7f951ec1da31be2cbefb4af2cc4c65fe76d7b02",
  "v3:84c3a61e922a71dd90b5e425e148f8a9915b5fafae5839c28998e375d0838249",
];
const PIN_SUB_UNTOUCHED = [
  "v3:f8732cc9c930cddb0d47dde2ac578288c0760434df50384b47379531de8e0a11",
  "v3:46e021429fff7e230a0c1b503e0551b8d1bddab987cc559881f2445ab182cdaf",
];
const PIN_BI_NONE = [
  "v3:8152f53d3850547021a2d99d9e3d39dd0110426f55cb6fcef64cafd631093400",
  "v3:d1d0656ce309cbcdc8f8cfdddd96d228e6e1de4e067aa4aa07913ba512cefe81",
];
