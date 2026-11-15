import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initParser } from "@lethal/engine";
import {
  PERMISSIONS_MOCK_APP_ID,
  TESTS_TESTLIBRARIES_APP_ID,
  installsPermissionsMock,
  restrictiveDefaultAtRisk,
  testAppInstallsPermissionsMock,
} from "../src/restrictive-default";
import { buildTestAppModel } from "../src/testpage-scan";

beforeAll(async () => {
  await initParser();
});

const ref = (codeunitId: number, codeunitName: string, method: string) => ({
  codeunitId,
  codeunitName,
  method,
});

/** An invented test codeunit; `props` are its extra property lines. */
const codeunit = (
  id: number,
  name: string,
  props: string,
  body: string,
) => `codeunit ${id} "${name}"
{
    Subtype = Test;
    ${props}

    var
        Mock: Codeunit "Permissions Mock";
        Lower: Codeunit "Library - Lower Permissions";
        Lib: Codeunit "Some Library";

${body}
}
`;
const testProc = (name: string, lines: string) => `    [Test]
    procedure ${name}()
    var
        Row: Record "Cell Row";
        Temp: Record "Cell Row" temporary;
    begin
${lines}
    end;
`;

function atRisk(src: string, tests: { id: number; cu: string; m: string }[]) {
  const model = buildTestAppModel([{ path: "src/T.al", text: src }]);
  return restrictiveDefaultAtRisk(
    model,
    tests.map((t) => ref(t.id, t.cu, t.m)),
  );
}

describe("PR-36: #8160's at-risk tests, by parse", () => {
  test("the tier is over every access before the first lowering: Insert or Modify firm, then DeleteAll, then reads", () => {
    const src = codeunit(
      50100,
      "X",
      "",
      [
        testProc("InsertFirst", "        Row.Insert();\n        Mock.Set('A');"),
        testProc("ModifyFirst", "        Row.Modify();"),
        testProc(
          "DeleteAllOnly",
          "        Row.DeleteAll();\n        Mock.Set('A');\n        Row.Insert();",
        ),
        testProc(
          "ReadOnly",
          "        if Row.FindFirst() then;\n        Mock.Set('A');\n        Row.Insert();",
        ),
        // a read, then an Insert, both before lowering: firm (the read fails, or passes and the Insert fails)
        testProc("ReadThenInsert", "        if Row.FindFirst() then;\n        Row.Insert();"),
      ].join("\n"),
    );
    const got = atRisk(src, [
      { id: 50100, cu: "X", m: "InsertFirst" },
      { id: 50100, cu: "X", m: "ModifyFirst" },
      { id: 50100, cu: "X", m: "DeleteAllOnly" },
      { id: 50100, cu: "X", m: "ReadOnly" },
      { id: 50100, cu: "X", m: "ReadThenInsert" },
    ]);
    expect(got.map((g) => [g.test, g.tier, g.firstAccess])).toEqual([
      ["X.InsertFirst", "firm", "insert"],
      ["X.ModifyFirst", "firm", "modify"],
      ["X.DeleteAllOnly", "uncertain-write", "deleteall"],
      ["X.ReadOnly", "uncertain-read", "findfirst"],
      ["X.ReadThenInsert", "firm", "findfirst"],
    ]);
  });

  test("the other direction: lowering first, a temporary record, or only a library call is not at risk", () => {
    const src = codeunit(
      50101,
      "Y",
      "",
      [
        testProc("MockFirst", "        Mock.Set('A');\n        Row.Insert();"),
        testProc("LowerFirst", "        Lower.SetO365Basic();\n        Row.Insert();"),
        testProc("TemporaryOnly", "        Temp.Insert();\n        Mock.Set('A');"),
        testProc("LibraryOnly", "        Lib.CreateRow();\n        Mock.Set('A');"),
        // review: an expected error is not one BC's refusal turns red
        testProc("AssertErrorOnly", "        asserterror Row.Insert();\n        Mock.Set('A');"),
      ].join("\n"),
    );
    expect(
      atRisk(src, [
        { id: 50101, cu: "Y", m: "MockFirst" },
        { id: 50101, cu: "Y", m: "LowerFirst" },
        { id: 50101, cu: "Y", m: "TemporaryOnly" },
        { id: 50101, cu: "Y", m: "LibraryOnly" },
        { id: 50101, cu: "Y", m: "AssertErrorOnly" },
      ]),
    ).toEqual([]);
  });

  test("review: a mock declared namespace-qualified or by id lowers too", () => {
    const qualified = `codeunit 50106 "Q"
{
    Subtype = Test;

    var
        MockQ: Codeunit System.TestLibraries.Security.AccessControl."Permissions Mock";
        MockId: Codeunit 131006;

    [Test]
    procedure QualifiedFirst()
    var
        Row: Record "Cell Row";
    begin
        MockQ.Set('A');
        Row.Insert();
    end;

    [Test]
    procedure ByIdFirst()
    var
        Row: Record "Cell Row";
    begin
        MockId.Set('A');
        Row.Insert();
    end;
}
`;
    expect(
      atRisk(qualified, [
        { id: 50106, cu: "Q", m: "QualifiedFirst" },
        { id: 50106, cu: "Q", m: "ByIdFirst" },
      ]),
    ).toEqual([]);
  });

  test("a same-codeunit Initialize is followed in order: its write before the test's Set is at risk", () => {
    const src = codeunit(
      50102,
      "Z",
      "",
      `${testProc("ViaInitialize", "        Initialize();\n        Mock.Set('A');")}
    local procedure Initialize()
    var
        Row: Record "Cell Row";
    begin
        Row.DeleteAll();
    end;
`,
    );
    expect(atRisk(src, [{ id: 50102, cu: "Z", m: "ViaInitialize" }]).map((g) => g.tier)).toEqual([
      "uncertain-write",
    ]);
  });

  test("TestPermissions decides: Disabled and NonRestrictive are not exposed, Restrictive is", () => {
    const body = testProc("InsertFirst", "        Row.Insert();");
    const disabled = codeunit(50103, "D", "TestPermissions = Disabled;", body);
    const nonRestrictive = codeunit(50104, "N", "TestPermissions = NonRestrictive;", body);
    const restrictive = codeunit(50105, "R", "TestPermissions = Restrictive;", body);
    expect(atRisk(disabled, [{ id: 50103, cu: "D", m: "InsertFirst" }])).toEqual([]);
    expect(atRisk(nonRestrictive, [{ id: 50104, cu: "N", m: "InsertFirst" }])).toEqual([]);
    expect(
      atRisk(restrictive, [{ id: 50105, cu: "R", m: "InsertFirst" }]).map((g) => g.tier),
    ).toEqual(["firm"]);
  });

  test("the mock is installed through Permissions Mock or Tests-TestLibraries, and not otherwise", () => {
    const app = (ids: string[]) =>
      JSON.stringify({
        dependencies: ids.map((id) => ({
          id,
          name: "x",
          publisher: "Microsoft",
          version: "28.0.0.0",
        })),
      });
    expect(installsPermissionsMock(app([PERMISSIONS_MOCK_APP_ID]))).toBe(true);
    expect(installsPermissionsMock(app([TESTS_TESTLIBRARIES_APP_ID.toUpperCase()]))).toBe(true);
    expect(installsPermissionsMock(app(["dd0be2ea-f733-4d65-bb34-a28f4624fb14"]))).toBe(false);
    expect(installsPermissionsMock(JSON.stringify({}))).toBe(false);
  });

  test("a test project with no app.json installs no mock; a corrupt one throws, never reads as 'not installed'", async () => {
    const empty = await mkdtemp(join(tmpdir(), "pr36-noapp-"));
    expect(await testAppInstallsPermissionsMock(empty)).toBe(false);
    const corrupt = await mkdtemp(join(tmpdir(), "pr36-badapp-"));
    await writeFile(join(corrupt, "app.json"), "{ not json");
    await expect(testAppInstallsPermissionsMock(corrupt)).rejects.toThrow();
  });
});
