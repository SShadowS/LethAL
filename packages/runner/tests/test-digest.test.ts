import { beforeAll, describe, expect, test } from "bun:test";
import { initParser } from "@lethal/engine";
import { testsInAlSource } from "../src/discovery";
import { testDigestKey, testDigestsOfSources } from "../src/test-digest";
import { buildTestAppModel } from "../src/testpage-scan";

beforeAll(async () => {
  await initParser();
});

const unit = (methods: string, header = `codeunit 50100 "T"`) =>
  `${header}\n{\n    Subtype = Test;\n\n${methods}}\n`;
const A = "    [Test]\n    procedure A()\n    begin\n        X := 1;\n    end;\n";
const B = "    [Test]\n    procedure B()\n    begin\n    end;\n";

/** R-371: the dependency fingerprint and build inputs, fixed here. */
const I = { dependencies: "d", buildInputs: "b" };

/** Every discovered test's digest in one file. */
function digests(text: string): Record<string, string> {
  return testDigestsOfSources([{ path: "T.al", text }], testsInAlSource("T.al", text), I);
}
const digestOf = (text: string, method = "A") => digests(text)[`50100::${method.toLowerCase()}`];

describe("R-278: testDigestsOfSources", () => {
  test("a digest is recorded for every discovered test, keyed by codeunit id and lowercased method", () => {
    const d = digests(unit(A + B));
    expect(Object.keys(d).sort()).toEqual(["50100::a", "50100::b"]);
    expect(d["50100::a"]).toMatch(/^v2:[0-9a-f]{64}$/);
    expect(testDigestKey({ codeunitId: 50100, method: "MyTest" })).toBe(
      testDigestKey({ codeunitId: 50100, method: "mytest" }),
    );
  });

  test("CRLF and LF give equal digests, and trailing whitespace is ignored", () => {
    const lf = unit(A + B);
    expect(digestOf(lf.replaceAll("\n", "\r\n"))).toBe(digestOf(lf));
    expect(digestOf(lf.replace("X := 1;", "X := 1;  \t"))).toBe(digestOf(lf));
  });

  test("a comment edit inside the method changes the digest", () => {
    // Comment text against comment text, so a normalizer that stripped comments would equate them.
    const lf = unit(A + B).replace("X := 1;", "X := 1; // old");
    expect(digestOf(lf.replace("// old", "// now asserts"))).not.toBe(digestOf(lf));
  });

  test("an attribute change changes the digest", () => {
    const lf = unit(A + B);
    const withHandler = lf.replace(
      "[Test]\n    procedure A()",
      "[Test]\n    [HandlerFunctions('ConfirmYes')]\n    procedure A()",
    );
    expect(digestOf(withHandler)).not.toBe(digestOf(lf));
    const otherHandler = withHandler.replace("ConfirmYes", "ConfirmNo");
    expect(digestOf(otherHandler)).not.toBe(digestOf(withHandler));
  });

  test("an edit to a sibling method does not change the digest", () => {
    const lf = unit(A + B);
    expect(
      digestOf(lf.replace("procedure B()\n    begin", "procedure B()\n    begin\n        Y := 2;")),
    ).toBe(digestOf(lf));
  });

  test("a method declared in two #if arms is digested as both: an edit in either arm changes it", () => {
    const arms = (one: string, two: string) =>
      unit(
        `#if CLEAN\n    [Test]\n    procedure A()\n    begin\n${one}    end;\n#else\n    [Test]\n    procedure A()\n    begin\n${two}    end;\n#endif\n${B}`,
      );
    const base = digestOf(arms("        X := 1;\n", "        X := 2;\n"));
    expect(digestOf(arms("        X := 9;\n", "        X := 2;\n"))).not.toBe(base);
    expect(digestOf(arms("        X := 1;\n", "        X := 9;\n"))).not.toBe(base);
  });

  test("R-371: every procedure key is unique across the app, a codeunit in two #if arms included", () => {
    const text = `#if CLEAN
${unit(A)}#else
${unit(A)}#endif
`;
    const model = buildTestAppModel([{ path: "T.al", text }]);
    const keys = model.units.flatMap((u) => [...u.procs, ...u.triggers].map((p) => p.key));
    expect(keys.length).toBe(2);
    expect(new Set(keys).size).toBe(2);
  });

  test("a discovered test the parser cannot find throws, never digests nothing", () => {
    const text = unit(A);
    expect(() =>
      testDigestsOfSources(
        [{ path: "T.al", text }],
        [{ codeunitId: 50100, codeunitName: "T", method: "Missing", file: "T.al" }],
        I,
      ),
    ).toThrow(/found no procedure of that name/);
  });
});

// R-371 M6: each edge kind as the ONLY path from the test to the edited code. Every case also
// edits an unreached codeunit ("Other") and expects NO change, so a test that took the
// whole-source fallback (where any edit changes the digest) cannot pass any case here.
describe("R-371: the reachable-set digest", () => {
  const T = (body: string, extra = "") =>
    `codeunit 50100 "T"\n{\n    Subtype = Test;\n\n    [Test]\n${body}\n${extra}}\n`;
  const LIB = `codeunit 50110 "Lib"
{
    SingleInstance = false;

    var
        G: Integer;

    trigger OnRun()
    begin
        G := 1;
        Help();
    end;

    procedure Help()
    begin
        G := 2;
    end;
}
`;
  const OTHER = `codeunit 50199 "Other"
{
    var
        OG: Integer;

    procedure Z()
    begin
        OG := 1;
    end;
}
`;
  const TABLE = (trigger: string, procs = "") => `table 50130 "TT"
{
    fields
    {
        field(1; "No."; Code[20]) { }
    }

${trigger}
${procs}}
`;
  type Files = Record<string, string>;
  const base = (test: string, more: Files = {}): Files => ({
    "T.al": test,
    "Lib.al": LIB,
    "Other.al": OTHER,
    ...more,
  });
  function digestA(files: Files): string | undefined {
    const list = Object.entries(files).map(([path, text]) => ({ path, text }));
    const tests = list.flatMap((f) => testsInAlSource(f.path, f.text));
    return testDigestsOfSources(list, tests, I)["50100::a"];
  }
  /** `files` with one exact substring of one file replaced; throws when it is not there. */
  function edit(files: Files, path: string, from: string, to: string): Files {
    const text = files[path];
    if (text === undefined || !text.includes(from)) throw new Error(`${from} not in ${path}`);
    return { ...files, [path]: text.replace(from, to) };
  }
  const unrelated = (files: Files) => edit(files, "Other.al", "OG := 1;", "OG := 9;");
  /** The edit turns A new, and an unreached edit does not (A is not on the fallback). */
  function expectReached(files: Files, path: string, from: string, to: string): void {
    const was = digestA(files);
    expect(was).toMatch(/^v2:/);
    expect(digestA(edit(files, path, from, to))).not.toBe(was);
    expect(digestA(unrelated(files))).toBe(was);
  }
  const callsLib = T(
    '    procedure A()\n    var\n        L: Codeunit "Lib";\n    begin\n        L.Help();\n    end;\n',
  );

  test("a same-codeunit helper", () => {
    const files = base(
      T(
        "    procedure A()\n    begin\n        Helper();\n    end;\n",
        "\n    local procedure Helper()\n    begin\n        X := 1;\n    end;\n",
      ),
    );
    expectReached(files, "T.al", "X := 1;", "X := 2;");
  });

  test("a helper in another test-app codeunit", () => {
    expectReached(base(callsLib), "Lib.al", "G := 2;", "G := 3;");
  });

  test("a [HandlerFunctions] handler", () => {
    const files = base(
      T(
        "    [HandlerFunctions('ConfirmYes')]\n    procedure A()\n    begin\n    end;\n",
        "\n    [ConfirmHandler]\n    procedure ConfirmYes(Question: Text[1024]; var Reply: Boolean)\n    begin\n        Reply := true;\n    end;\n",
      ),
    );
    expectReached(files, "T.al", "Reply := true;", "Reply := false;");
  });

  test("a bare call inside a with-statement, resolved through the target's declared type", () => {
    const files = base(
      T(
        '    procedure A()\n    var\n        L: Codeunit "Lib";\n    begin\n        with L do\n            Help();\n    end;\n',
      ),
    );
    expectReached(files, "Lib.al", "G := 2;", "G := 3;");
  });

  test("Codeunit.Run(Codeunit::X) walks X's OnRun", () => {
    const files = base(
      T('    procedure A()\n    begin\n        Codeunit.Run(Codeunit::"Lib");\n    end;\n'),
    );
    expectReached(files, "Lib.al", "G := 2;", "G := 3;");
  });

  test("the test codeunit's own OnRun, which runs before every method", () => {
    const files = base(
      T(
        "    procedure A()\n    begin\n    end;\n",
        '\n    var\n        L: Codeunit "Lib";\n\n    trigger OnRun()\n    begin\n        L.Help();\n    end;\n',
      ),
    );
    expectReached(files, "Lib.al", "G := 2;", "G := 3;");
  });

  test("a reached codeunit's globals, header properties and triggers", () => {
    const files = base(callsLib);
    expectReached(files, "Lib.al", "G: Integer;", "G: Decimal;");
    expectReached(files, "Lib.al", "SingleInstance = false;", "SingleInstance = true;");
    expectReached(files, "Lib.al", "G := 1;", "G := 7;"); // OnRun: never called, still covered
  });

  test("an event-subscriber codeunit is in every digest", () => {
    const sub = `codeunit 50120 "Sub"
{
    [EventSubscriber(ObjectType::Codeunit, Codeunit::"Lib", 'OnSomething', '', false, false)]
    local procedure OnSomething()
    begin
        S := 1;
    end;
}
`;
    const files = base(T("    procedure A()\n    begin\n    end;\n"), { "Sub.al": sub });
    expectReached(files, "Sub.al", "S := 1;", "S := 2;");
  });

  // Ruling 1: BindSubscription is NOT an edge, which is safe only because every subscriber
  // codeunit, a manual one included, is in every digest.
  test("ruling 1: a manual subscriber bound by BindSubscription is covered, and the bind takes no fallback", () => {
    const sub = `codeunit 50121 "Manual Sub"
{
    EventSubscriberInstance = Manual;

    [EventSubscriber(ObjectType::Codeunit, Codeunit::"Lib", 'OnSomething', '', false, false)]
    local procedure OnSomething()
    begin
        S := 1;
    end;
}
`;
    const files = base(
      T(
        '    procedure A()\n    var\n        M: Codeunit "Manual Sub";\n    begin\n        BindSubscription(M);\n        UnbindSubscription(M);\n    end;\n',
      ),
      { "Sub.al": sub },
    );
    expectReached(files, "Sub.al", "S := 1;", "S := 2;");
  });

  // A dependency's own code can fire a test-app extension's triggers on its object, so every
  // extension object is in every digest, with what its triggers reach.
  test("a test-app tableextension or pageextension trigger is in every digest", () => {
    const tableExt = `tableextension 50140 "SLExt" extends "Sales Line"
{
    trigger OnAfterInsert()
    var
        L: Codeunit "Lib";
    begin
        L.Help();
        E := 1;
    end;
}
`;
    const pageExt = `pageextension 50141 "CCExt" extends "Customer Card"
{
    trigger OnOpenPage()
    begin
        PE := 1;
    end;
}
`;
    const files = base(T("    procedure A()\n    begin\n    end;\n"), {
      "SLExt.al": tableExt,
      "CCExt.al": pageExt,
    });
    expectReached(files, "SLExt.al", "E := 1;", "E := 2;");
    expectReached(files, "Lib.al", "G := 2;", "G := 3;");
    expectReached(files, "CCExt.al", "PE := 1;", "PE := 2;");
  });

  test("an UNFOLLOWED edge in an extension trigger puts every test on the fallback", () => {
    const tableExt = `tableextension 50140 "SLExt" extends "Sales Line"
{
    trigger OnAfterInsert()
    begin
        Codeunit.Run(50110);
    end;
}
`;
    const files = base(T("    procedure A()\n    begin\n    end;\n"), { "SLExt.al": tableExt });
    expect(digestA(unrelated(files))).not.toBe(digestA(files));
  });

  test("parse damage that swallows a subscriber codeunit puts every test on the fallback", () => {
    // The unclosed table swallows the codeunit after it: "Sub" never becomes a unit.
    const broken = `table 50160 "Broken"
{
    fields
    {
        field(1; "No."; Code[20]
    }

codeunit 50120 "Sub"
{
    [EventSubscriber(ObjectType::Codeunit, Codeunit::"Lib", 'OnSomething', '', false, false)]
    local procedure OnSomething()
    begin
        S := 1;
    end;
}
`;
    const files = base(T("    procedure A()\n    begin\n    end;\n"), { "B.al": broken });
    expect(digestA(edit(files, "B.al", "S := 1;", "S := 2;"))).not.toBe(digestA(files));
  });

  test("an UNFOLLOWED edge (Codeunit.Run by id) takes the whole-source fallback", () => {
    const files = base(T("    procedure A()\n    begin\n        Codeunit.Run(50110);\n    end;\n"));
    expect(digestA(unrelated(files))).not.toBe(digestA(files));
  });

  test("EXTERNAL needs one plain name: a codeunit by id or namespace-qualified takes the fallback", () => {
    for (const type of ["Codeunit 50999", 'Codeunit My.Ns."Dep Lib"']) {
      const files = base(
        T(
          `    procedure A()\n    var\n        L: ${type};\n    begin\n        L.Foo();\n    end;\n`,
        ),
      );
      expect(digestA(unrelated(files))).not.toBe(digestA(files));
    }
  });

  test("negative: a classified EXTERNAL edge (a plain name the test app does not declare) takes no fallback", () => {
    const files = base(
      T(
        '    procedure A()\n    var\n        L: Codeunit "Dep Lib";\n    begin\n        L.Foo();\n    end;\n',
      ),
    );
    expect(digestA(unrelated(files))).toBe(digestA(files));
  });

  test("negative: an unreached codeunit's globals are not in the digest", () => {
    const files = base(callsLib);
    expect(digestA(edit(files, "Other.al", "OG: Integer;", "OG: Decimal;"))).toBe(digestA(files));
  });

  // Ruling B: cases 14, 15 and 16 are FOLLOWED by walking the object's code.
  test("ruling B, case 14: a trigger-capable RecordRef call walks every test-app table's triggers", () => {
    const files = base(
      T(
        "    procedure A()\n    var\n        RR: RecordRef;\n    begin\n        RR.Open(50130);\n        RR.Modify(true);\n    end;\n",
      ),
      { "TT.al": TABLE("    trigger OnModify()\n    begin\n        M := 1;\n    end;\n") },
    );
    expectReached(files, "TT.al", "M := 1;", "M := 2;");
  });

  test("ruling B, case 15: a test-app table's procedure is walked into what it calls", () => {
    const files = base(
      T(
        '    procedure A()\n    var\n        R: Record "TT";\n    begin\n        R.DoIt();\n    end;\n',
      ),
      {
        "TT.al": TABLE(
          "",
          '    procedure DoIt()\n    var\n        L: Codeunit "Lib";\n    begin\n        L.Help();\n    end;\n',
        ),
      },
    );
    expectReached(files, "Lib.al", "G := 2;", "G := 3;");
  });

  test("a bare call from a tableextension to a procedure of its test-app base table is walked", () => {
    const tab = `table 50131 "Tab"
{
    fields
    {
        field(1; "No."; Code[20]) { }
    }

    procedure BaseHelper()
    var
        L: Codeunit "Lib";
    begin
        L.Help();
    end;
}
`;
    const ext = `tableextension 50132 "TabExt" extends "Tab"
{
    procedure ExtProc()
    begin
        BaseHelper();
    end;
}
`;
    const files = base(
      T(
        '    procedure A()\n    var\n        R: Record "Tab";\n    begin\n        R.ExtProc();\n    end;\n',
      ),
      { "Tab.al": tab, "TabExt.al": ext },
    );
    expectReached(files, "Lib.al", "G := 2;", "G := 3;");
    // At an arity the base table does not declare, the call is not known to be a built-in.
    const odd = edit(files, "TabExt.al", "BaseHelper();", "BaseHelper(1);");
    expect(digestA(unrelated(odd))).not.toBe(digestA(odd));
  });

  test("a page part's page runs with its host page: its triggers are walked", () => {
    const page = (part: string) => `page 50150 "P"
{
    layout
    {
        area(Content)
        {
            part(Lines; ${part}) { }
        }
    }
}
`;
    const subPage = `page 50151 "SubP"
{
    trigger OnOpenPage()
    var
        L: Codeunit "Lib";
    begin
        L.Help();
    end;
}
`;
    const files = base(
      T('    procedure A()\n    begin\n        Page.Run(Page::"P");\n    end;\n'),
      { "P.al": page('"SubP"'), "SubP.al": subPage },
    );
    expectReached(files, "SubP.al", "L.Help();", "L.Help(); L.Help();");
    expectReached(files, "Lib.al", "G := 2;", "G := 3;");
    // A part the test app does not declare, by one plain name, is a dependency's page: EXTERNAL.
    const external = edit(files, "P.al", '"SubP"', '"Dep Page"');
    expect(digestA(unrelated(external))).toBe(digestA(external));
    // A namespace-qualified or numeric target does not parse in this grammar, so it falls back
    // through the parse-damage rule.
    const qualified = edit(files, "P.al", '"SubP"', 'My.Ns."Dep Page"');
    expect(digestA(unrelated(qualified))).not.toBe(digestA(qualified));
  });

  test("ruling B, case 16: a trigger-capable call on a test-app record walks its triggers", () => {
    const files = base(
      T(
        '    procedure A()\n    var\n        R: Record "TT";\n    begin\n        R.Insert(true);\n    end;\n',
      ),
      {
        "TT.al": TABLE(
          '    trigger OnInsert()\n    var\n        L: Codeunit "Lib";\n    begin\n        L.Help();\n    end;\n',
        ),
      },
    );
    expectReached(files, "Lib.al", "G := 2;", "G := 3;");
  });
});
