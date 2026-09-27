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
