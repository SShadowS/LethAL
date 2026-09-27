import { beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { initParser, parseAL } from "@lethal/engine";
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
    const got = analyze(
      CLEAN_TEST,
      [ref(50100, "Fine")],
      [
        {
          path: "helper.al",
          text: helper(`
    procedure Run1()
    begin
        if then;
    end;`),
        },
      ],
    );
    expect(got.errors.join("\n")).toContain("helper.al");
    expect(() =>
      scan(
        CLEAN_TEST,
        [ref(50100, "Fine")],
        [
          {
            path: "helper.al",
            text: helper("    procedure Run1()\n    begin\n        if then;\n    end;"),
          },
        ],
      ),
    ).toThrow(TestPageScanError);
  });

  test("an error elsewhere in a reached codeunit counts too (it could hide an edge)", () => {
    const got = analyze(
      CLEAN_TEST,
      [ref(50100, "Fine")],
      [
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
      ],
    );
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
    const got = analyze(
      CLEAN_TEST,
      [ref(50100, "Fine")],
      [
        { path: "helper.al", text: helper("    procedure Run1()\n    begin\n    end;") },
        { path: "page.al", text: page },
      ],
    );
    expect(got.errors).toEqual([]);
  });

  test("a damaged codeunit no test reaches does not stop the run when every target resolved", () => {
    const got = analyze(
      CLEAN_TEST,
      [ref(50100, "Fine")],
      [
        { path: "helper.al", text: helper("    procedure Run1()\n    begin\n    end;") },
        {
          path: "other.al",
          text: unit(
            "    procedure X()\n    begin\n        if then;\n    end;",
            50400,
            "Other",
            false,
          ),
        },
      ],
    );
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
    const got = analyze(
      test,
      [ref(50100, "CallsUnknown")],
      [
        {
          path: "other.al",
          text: unit(
            "    procedure X()\n    begin\n        if then;\n    end;",
            50400,
            "Other",
            false,
          ),
        },
      ],
    );
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

describe("review round 1: fail-closed fixes (was silently NOT refused)", () => {
  test("this.Helper() calls the same codeunit's own procedure (#1)", () => {
    const got = scan(
      `codeunit 50100 "T"
{
    Subtype = Test;
    [Test]
    procedure A()
    begin
        this.Helper();
    end;
    local procedure Helper()
    var
        Card: TestPage "X";
    begin
        Card.OpenView();
    end;
}
`,
      [ref(50100, "A")],
    );
    expect(got.size).toBe(1);
  });

  test("a helper procedure wrapped in #if ... #endif is still reachable (#2)", () => {
    const got = scan(
      `codeunit 50100 "T"
{
    Subtype = Test;
    [Test]
    procedure A()
    begin
        Helper();
    end;
#if not CLEAN24
    local procedure Helper()
    var
        Card: TestPage "X";
    begin
        Card.OpenView();
    end;
#endif
}
`,
      [ref(50100, "A")],
    );
    expect(got.size).toBe(1);
  });

  test("a codeunit wrapped in #if ... #endif is still a resolvable call target (#2)", () => {
    const lib = `#if not CLEAN24
codeunit 50200 "Lib"
{
    procedure Open()
    var
        Card: TestPage "X";
    begin
        Card.OpenView();
    end;
}
#endif
`;
    const got = scan(
      unit(`
    var
        L: Codeunit Lib;

    [Test]
    procedure A()
    begin
        L.Open();
    end;`),
      [ref(50100, "A")],
      [{ path: "lib.al", text: lib }],
    );
    expect(got.size).toBe(1);
  });

  test("a namespace-qualified Codeunit type resolves on the last dotted segment (#3)", () => {
    const got = scan(
      `namespace My.Tests;
codeunit 50100 "T"
{
    Subtype = Test;
    [Test]
    procedure A()
    var
        Lib: Codeunit My.Tests."Lib";
    begin
        Lib.Open();
    end;
}
codeunit 50101 "Lib"
{
    procedure Open()
    var
        Card: TestPage "X";
    begin
        Card.OpenView();
    end;
}
`,
      [ref(50100, "A")],
    );
    expect(got.size).toBe(1);
  });

  test("an array of TestPage, opened through a subscript receiver (#4)", () => {
    const got = scan(
      unit(`
    [Test]
    procedure A()
    var
        Cards: array[2] of TestPage "X";
    begin
        Cards[1].OpenView();
    end;`),
      [ref(50100, "A")],
    );
    expect(got.size).toBe(1);
  });

  test("array[...] of TestPage is TestPage-typed for the out-of-scope loud rule too (#4)", () => {
    const src = unit(`
    trigger OnRun()
    var
        Hidden: array[2] of TestPage "X";
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

  test("a parenthesised receiver refuses when the member is opening-shaped (#4)", () => {
    const got = scan(
      unit(`
    [Test]
    procedure A()
    var
        Card: TestPage "X";
    begin
        (Card).OpenView();
    end;`),
      [ref(50100, "A")],
    );
    expect(got.size).toBe(1);
  });

  test("an unclosed page that swallows the next codeunit is suspect for an unresolved call (#5)", () => {
    const testSrc = unit(`
    var
        Lib: Codeunit "Lib";

    [Test]
    procedure Fine()
    begin
        Lib.Open();
    end;`);
    const page = `page 50300 "Broken"
{
    layout { area(content) { field(X; X) { } }
    trigger OnOpenPage()
    begin
    end;

codeunit 50101 "Lib"
{
    procedure Open()
    var
        Card: TestPage "X";
    begin
        Card.OpenView();
    end;
}
`;
    const got = analyze(testSrc, [ref(50100, "Fine")], [{ path: "page.al", text: page }]);
    expect(got.errors.join("\n")).toContain("Lib");
    expect(() => scan(testSrc, [ref(50100, "Fine")], [{ path: "page.al", text: page }])).toThrow(
      TestPageScanError,
    );
  });

  test("a with-statement's implicit receiver call refuses when opening-shaped (#6)", () => {
    const got = scan(
      unit(`
    [Test]
    procedure A()
    var
        Card: TestPage "X";
    begin
        with Card do
            OpenView();
    end;`),
      [ref(50100, "A")],
    );
    expect(got.size).toBe(1);
  });
});

describe("review round 2: fail-closed fixes", () => {
  test("a quoted Codeunit name containing a dot resolves without namespace splitting (#A)", () => {
    const lib = unit(
      `
    procedure Open()
    var
        Card: TestPage "X";
    begin
        Card.OpenView();
    end;`,
      50200,
      "Lib.Pages",
      false,
    );
    const got = scan(
      unit(`
    var
        Lib2: Codeunit "Lib.Pages";

    [Test]
    procedure A()
    begin
        Lib2.Open();
    end;`),
      [ref(50100, "A")],
      [{ path: "lib.al", text: lib }],
    );
    expect(got.size).toBe(1);
  });

  test("a quoted dotted Codeunit name still resolves when its declaration is wrapped in #if (#A)", () => {
    const lib = `#if not CLEAN24
${unit(
  `
    procedure Open()
    var
        Card: TestPage "X";
    begin
        Card.OpenView();
    end;`,
  50200,
  "Lib.Pages",
  false,
)}
#endif
`;
    const got = scan(
      unit(`
    var
        Lib2: Codeunit "Lib.Pages";

    [Test]
    procedure A()
    begin
        Lib2.Open();
    end;`),
      [ref(50100, "A")],
      [{ path: "lib.al", text: lib }],
    );
    expect(got.size).toBe(1);
  });

  test("with a Codeunit variable, a bare call unresolved in the current codeunit refuses (#B)", () => {
    const lib = unit(
      `
    procedure Open()
    var
        Card: TestPage "X";
    begin
        Card.OpenView();
    end;`,
      50200,
      "Lib",
      false,
    );
    const got = scan(
      unit(`
    var
        LibVar: Codeunit Lib;

    [Test]
    procedure A()
    begin
        with LibVar do
            Open();
    end;`),
      [ref(50100, "A")],
      [{ path: "lib.al", text: lib }],
    );
    expect(got.size).toBe(1);
  });
});

describe("review round 3: fail-closed fixes", () => {
  test("a namespace path is not shadowed by an unrelated codeunit whose OWN quoted name matches it as text (#A)", () => {
    const decoy = unit("    procedure Open()\n    begin\n    end;", 59901, "A.B", false);
    const real = `namespace A;
${unit(
  `
    procedure Open()
    var
        Card: TestPage "X";
    begin
        Card.OpenView();
    end;`,
  59902,
  "B",
  false,
)}`;
    const got = scan(
      unit(`
    var
        Lib: Codeunit A.B;

    [Test]
    procedure A()
    begin
        Lib.Open();
    end;`),
      [ref(50100, "A")],
      [
        { path: "decoy.al", text: decoy },
        { path: "real.al", text: real },
      ],
    );
    expect(got.size).toBe(1);
  });

  test("a quoted Codeunit name containing a dot still resolves (regression, #A)", () => {
    const lib = unit(
      `
    procedure Open()
    var
        Card: TestPage "X";
    begin
        Card.OpenView();
    end;`,
      50200,
      "Lib.Pages",
      false,
    );
    const got = scan(
      unit(`
    var
        Lib2: Codeunit "Lib.Pages";

    [Test]
    procedure A()
    begin
        Lib2.Open();
    end;`),
      [ref(50100, "A")],
      [{ path: "lib.al", text: lib }],
    );
    expect(got.size).toBe(1);
  });

  test("a namespace-qualified Codeunit type still resolves on the last segment (regression, #A)", () => {
    const got = scan(
      `namespace My.Tests;
codeunit 50100 "T"
{
    Subtype = Test;
    [Test]
    procedure A()
    var
        Lib: Codeunit My.Tests."Lib";
    begin
        Lib.Open();
    end;
}
codeunit 50101 "Lib"
{
    procedure Open()
    var
        Card: TestPage "X";
    begin
        Card.OpenView();
    end;
}
`,
      [ref(50100, "A")],
    );
    expect(got.size).toBe(1);
  });
});

describe("procedures the grammar places inside the global var section (R-236c round 2)", () => {
  // tree-sitter-al 4.4.1 parses an `#if` region that directly follows the global `var` section
  // INSIDE it (`var_section > var_body > preproc_conditional_var > procedure`); the AL compiler
  // puts the same procedures at codeunit level. BaseApp had 127 tests in this shape.
  const text = unit(`
    var
        Counter: Integer;
#if not CLEAN27
    [Test]
    procedure OpensInRegion()
    var
        Card: TestPage "X";
    begin
        Card.OpenView();
    end;

    [Test]
    procedure SafeInRegion()
    var
        Local: Integer;
    begin
        Counter := 1;
    end;
#else
    [Test]
    procedure OpensInElse()
    begin
        Helper();
    end;
#endif

    local procedure Helper()
    var
        Card: TestPage "X";
    begin
        Card.OpenEdit();
    end;`);

  test("every branch's procedures are found, and each test is classified", () => {
    const got = analyze(text, [
      ref(50100, "OpensInRegion"),
      ref(50100, "SafeInRegion"),
      ref(50100, "OpensInElse"),
    ]);
    expect(got.errors).toEqual([]);
    expect([...got.refused.keys()].sort()).toEqual(["50100::OpensInElse", "50100::OpensInRegion"]);
  });

  test("a hoisted procedure's locals do not become globals", () => {
    // `Card` is declared only inside OpensInRegion. Read from another procedure it must NOT resolve
    // as a global TestPage; it must stay the loud "cannot place in scope" error it is for any other
    // local of that name.
    const got = analyze(
      text.replace(
        "local procedure Helper()",
        `[Test]
    procedure UsesLeak()
    begin
        Card.OpenView();
    end;

    local procedure Helper()`,
      ),
      [ref(50100, "UsesLeak")],
    );
    expect(got.refused.size).toBe(0);
    expect(got.errors).toEqual([
      "T.UsesLeak: T.UsesLeak uses Card, which matches a TestPage declaration the scanner cannot place in scope",
    ]);
  });
});

describe("codeunit lookup index (R-236c round 2)", () => {
  // Many tests share library procedures. Each test's walk must not depend on which tests ran
  // before it: same refusals, same reasons, same errors in either order.
  const lib = unit(
    `
    procedure Opens()
    var
        Card: TestPage "X";
    begin
        Card.OpenView();
    end;

    procedure Safe()
    begin
    end;

    procedure Both()
    begin
        Safe();
        Opens();
    end;`,
    50200,
    "Lib",
    false,
  );
  const tests = unit(`
    var
        L: Codeunit "Lib";
        ById: Codeunit 50200;

    [Test]
    procedure A()
    begin
        L.Both();
    end;

    [Test]
    procedure B()
    begin
        ById.Opens();
    end;

    [Test]
    procedure C()
    begin
        L.Safe();
    end;

    [Test]
    procedure D()
    begin
        L.Missing();
        ById.Both();
    end;`);
  const refs = ["A", "B", "C", "D"].map((m) => ref(50100, m));
  const run = (order: TestMethodRef[]) => {
    const got = analyze(tests, order, [{ path: "lib.al", text: lib }]);
    return { refused: [...got.refused].sort(), errors: [...got.errors].sort() };
  };

  test("same verdicts and reasons in either test order", () => {
    const forward = run(refs);
    expect(forward.refused.map(([k]) => k)).toEqual(["50100::A", "50100::B", "50100::D"]);
    expect(forward.refused[0]?.[1]).toBe(
      'T.A -> Lib.Both -> Lib.Opens calls Card.OpenView on TestPage "X"',
    );
    expect(run([...refs].reverse())).toEqual(forward);
  });

  test("a key naming two codeunits (one by id, one by name) returns both", () => {
    const safe = unit(
      `
    procedure Run()
    begin
    end;`,
      50300,
      "Plain",
      false,
    );
    const opens = unit(
      `
    procedure Run()
    var
        Card: TestPage "X";
    begin
        Card.OpenView();
    end;`,
      50301,
      "50300",
      false,
    );
    const got = analyze(
      unit(`
    [Test]
    procedure A()
    var
        X: Codeunit 50300;
    begin
        X.Run();
    end;`),
      [ref(50100, "A")],
      [
        { path: "a.al", text: safe },
        { path: "b.al", text: opens },
      ],
    );
    expect([...got.refused.keys()]).toEqual(["50100::A"]);
  });
});

describe("final review: comments are trivia, never an argument or a member name", () => {
  const sameCodeunit = (call: string) =>
    scan(
      unit(`
    local procedure Helper(N: Integer)
    var
        Card: TestPage "X";
    begin
        Card.OpenView();
    end;

    [Test]
    procedure T()
    begin
        ${call}
    end;`),
      [ref(50100, "T")],
    );
  const viaLibrary = (call: string) =>
    scan(
      unit(`
    var
        L: Codeunit Lib;

    [Test]
    procedure T()
    begin
        ${call}
    end;`),
      [ref(50100, "T")],
      [
        {
          path: "lib.al",
          text: unit(
            `
    procedure Open(N: Integer)
    var
        C: TestPage "Z";
    begin
        C.OpenView();
    end;`,
            50200,
            "Lib",
            false,
          ),
        },
      ],
    );

  test("an inline block comment in a same-codeunit call's arguments", () => {
    expect(sameCodeunit("Helper(1 /* c */);").size).toBe(1);
  });
  test("a trailing line comment before the closing paren on the next line", () => {
    expect(sameCodeunit("Helper(1 // c\n        );").size).toBe(1);
  });
  test("a #pragma and a #region inside the arguments", () => {
    expect(
      sameCodeunit(
        "Helper(\n#pragma warning disable AA0001\n            1\n#region r\n#endregion\n        );",
      ).size,
    ).toBe(1);
  });
  test("a block comment through a codeunit variable", () => {
    expect(viaLibrary("L.Open(1 /* c */);").size).toBe(1);
  });
  test("a line comment through a codeunit variable", () => {
    expect(viaLibrary("L.Open(1 // c\n        );").size).toBe(1);
  });
  test("a comment between receiver and member, on a TestPage", () => {
    const got = scan(
      unit(`
    [Test]
    procedure T()
    var
        P: TestPage "X";
    begin
        P . /*z*/ OpenView();
    end;`),
      [ref(50100, "T")],
    );
    expect(got.get("50100::T")).toContain("P.OpenView");
  });
  test("a comment between receiver and member, through a codeunit variable", () => {
    expect(viaLibrary("L // q\n            .Open(1);").size).toBe(1);
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

describe("memory: every parse tree is released once its facts are read", () => {
  // BC.History/BaseApp (9,620 files) aborted inside web-tree-sitter when every tree was kept:
  // the wasm heap grew linearly to its 2,048 MB ceiling at file 9,007. Parsing that corpus here
  // would take far too long for a unit test, so this pins the mechanism instead: one
  // `Tree.delete()` per file, observed on web-tree-sitter's own `Tree` prototype with no
  // production hook, and a correct verdict for a call that crosses into the LAST file after every
  // tree is gone (so the traversal reads only extracted facts).
  test("3,000 files: every tree deleted, and a cross-file opening call still refused", () => {
    const files: Src[] = [];
    const n = 3000;
    for (let i = 1; i < n; i++) {
      const opens = i === n - 1;
      files.push({
        path: `lib${i}.al`,
        text: unit(
          `
    procedure Run()
    var
        Card: TestPage "X";
    begin
        ${opens ? "Card.OpenView();" : "Card.Close();"}
    end;`,
          60000 + i,
          `Lib ${i}`,
          false,
        ),
      });
    }
    const tree = parseAL("");
    const proto = Object.getPrototypeOf(tree) as { delete: () => void };
    tree.delete();
    const original = proto.delete;
    let deletes = 0;
    proto.delete = function (this: unknown) {
      deletes++;
      original.call(this);
    };
    try {
      const got = analyze(
        unit(`
    [Test]
    procedure Opens()
    var
        L: Codeunit "Lib ${n - 1}";
    begin
        L.Run();
    end;

    [Test]
    procedure Safe()
    var
        L: Codeunit "Lib 1";
    begin
        L.Run();
    end;`),
        [ref(50100, "Opens"), ref(50100, "Safe")],
        files,
      );
      expect(got.errors).toEqual([]);
      expect([...got.refused.keys()]).toEqual(["50100::Opens"]);
      expect(deletes).toBe(n);
    } finally {
      proto.delete = original;
    }
  });
});

describe("run 002 review r1 #1: a non-plain receiver whose member is not opening-shaped", () => {
  const lib = (extra = "") =>
    unit(
      `
    procedure OpenIt()
    var
        C: TestPage "Z";
    begin
        C.OpenView();
    end;

    procedure Self(): Codeunit Lib
    begin
    end;

    procedure Safe()
    begin
    end;${extra}`,
      50200,
      "Lib",
      false,
    );
  const run = (decls: string, call: string, more = "") =>
    analyze(
      unit(`
    var
        L: Codeunit Lib;
        Libs: array[2] of Codeunit Lib;
${decls}
    procedure GetLib(): Codeunit Lib
    begin
    end;

    procedure GetLibNamed() Result: Codeunit Lib
    begin
    end;
${more}
    [Test]
    procedure T()
    begin
        ${call}
    end;`),
      [ref(50100, "T")],
      [{ path: "lib.al", text: lib() }],
    );
  const refusedBy = (call: string, decls = "") => {
    const got = run(decls, call);
    expect(got.errors).toEqual([]);
    return got.refused.get("50100::T") ?? "";
  };

  test("an array element", () => {
    expect(refusedBy("Libs[1].OpenIt();")).toContain("OpenIt");
  });
  test("a parenthesised receiver", () => {
    expect(refusedBy("(L).OpenIt();")).toContain("OpenIt");
  });
  test("a same-codeunit function's return value", () => {
    expect(refusedBy("GetLib().OpenIt();")).toContain("OpenIt");
  });
  test("a named return value", () => {
    expect(refusedBy("GetLibNamed().OpenIt();")).toContain("OpenIt");
  });
  test("a member chain through a helper's return value", () => {
    expect(refusedBy("L.Self().OpenIt();")).toContain("OpenIt");
  });
  test("a longer chain: array element, return value, paren-less call", () => {
    expect(refusedBy("Libs[2].Self().Self().OpenIt;")).toContain("OpenIt");
  });
  test("this.GetLib() as the receiver", () => {
    expect(refusedBy("this.GetLib().OpenIt();")).toContain("OpenIt");
  });
  test("a ternary of two codeunit variables", () => {
    expect(refusedBy("(true ? L : Libs[1]).OpenIt();")).toContain("OpenIt");
  });
  test("control: the same shapes calling a safe helper are not refused", () => {
    for (const call of ["Libs[1].Safe();", "(L).Safe();", "GetLib().Safe();", "L.Self().Safe();"]) {
      const got = run("", call);
      expect(got.errors).toEqual([]);
      expect(got.refused.size).toBe(0);
    }
  });
  test("control: harmless chains on records, TestPage fields, text and enums raise nothing", () => {
    const decls = `        Rec: Record Customer;
        Page: TestPage "Customer Card";
        Txt: Text;
        Arr: array[3] of Text;`;
    for (const call of [
      "Rec.Name.ToUpper();",
      "Page.Lines.Amount.SetValue(1);",
      "Txt.Substring(1).ToUpper();",
      "Arr[1].ToUpper();",
      "Format(1).Contains('x');",
      "(Txt + Txt).ToUpper();",
      "'abc'.ToUpper();",
      '"Sales Document Type"::Order.AsInteger();',
      "Undeclared.Thing.Do();",
    ]) {
      const got = run(decls, call);
      expect({ call, errors: got.errors, refused: got.refused.size }).toEqual({
        call,
        errors: [],
        refused: 0,
      });
    }
  });
  test("an unresolvable receiver fails LOUDLY, never safe", () => {
    const got = run("        Rec: Record Customer;", "with Rec do\n            FromWith().Safe();");
    expect(got.errors.join("\n")).toContain("FromWith().Safe");
    expect(() =>
      scan(
        unit(`
    var
        Rec: Record Customer;

    [Test]
    procedure T()
    begin
        with Rec do
            FromWith().Safe();
    end;`),
        [ref(50100, "T")],
        [{ path: "lib.al", text: lib() }],
      ),
    ).toThrow(TestPageScanError);
  });
});

describe("run 002 re-review: a named return value is a variable in its procedure", () => {
  const lib = unit(
    `
    procedure OpenIt()
    var
        C: TestPage "Z";
    begin
        C.OpenView();
    end;`,
    50200,
    "Lib",
    false,
  );
  const run = (body: string) =>
    analyze(
      unit(`
    procedure H() R: Codeunit Lib
    begin
        ${body}
    end;

    [Test]
    procedure T()
    begin
        H();
    end;`),
      [ref(50100, "T")],
      [{ path: "lib.al", text: lib }],
    );

  test("called plainly", () => {
    const got = run("R.OpenIt();");
    expect(got.errors).toEqual([]);
    expect(got.refused.get("50100::T") ?? "").toContain("OpenIt");
  });
  test("parenthesised", () => {
    const got = run("(R).OpenIt();");
    expect(got.errors).toEqual([]);
    expect(got.refused.get("50100::T") ?? "").toContain("OpenIt");
  });
});
