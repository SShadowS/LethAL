import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { initParser } from "@lethal/engine";
import {
  UpgradeClashRefusedError,
  UpgradeNotRestoredError,
  bcClashText,
  clashRefusedWithoutRestore,
} from "../src/app-version";
import { WALK_MAX_APPS } from "../src/dependents-warning";
import type { InstalledDependent } from "../src/harness";
import {
  type PackageMember,
  type SourceMember,
  bareAppId,
  compareMembers,
  compareMembersBySource,
  readExtensionEntry,
  splitQualified,
  unquoteName,
} from "../src/member-clash";
import {
  ObjectClashError,
  checkObjectClashes,
  declaredObjectsOfPackage,
  declaredObjectsOfSource,
  declaredObjectsOfSymbolReference,
  dependenciesOf,
} from "../src/object-clash";
import { upgradeNotRestored } from "../src/orchestrator";
import { buildFakeAppWithEntries } from "./helpers/fake-app";

/**
 * R845: fields and enum values. Every refusal asserts the error class AND its fields, so a refusal
 * from another check cannot pass. The packages under scripts/testdata are REAL alc 18.1 builds.
 */

const TESTDATA = join(import.meta.dir, "..", "..", "..", "scripts", "testdata");
const real = (f: string): Buffer => readFileSync(join(TESTDATA, f));
const BASE_ID = "5a0c4f6e-3b1d-4e57-9a28-7d6c1e0b8f31";
const EXT_ID = "8d2e6b94-1c7a-4f03-b5e9-3a4f0d7c2e65";
const EXT_DEP: InstalledDependent = {
  id: EXT_ID,
  name: "R845 Members Ext",
  publisher: "LethAL",
  version: "1.0.0.0",
};
const TARGET_ID = "11111111-aaaa-4aaa-8aaa-111111111111";
const TARGET_BARE = bareAppId(TARGET_ID);
const DEP_ID = "33333333-3333-4333-8333-333333333333";
const DEP: InstalledDependent = {
  id: DEP_ID,
  name: "Resident Tests",
  publisher: "LethAL",
  version: "1.2.3.4",
};

const pkg = (symbols: Record<string, unknown>, id = DEP_ID, version = "1.2.3.4"): Uint8Array =>
  new Uint8Array(
    buildFakeAppWithEntries({
      "SymbolReference.json": JSON.stringify({ AppId: id, Version: version, ...symbols }),
    }),
  );

/** A dependent whose table extension extends the TARGET's table `My Tbl`. */
const depExtendingTarget = (fields: unknown[], target = `#${TARGET_BARE}#My Tbl`): Uint8Array =>
  pkg({ TableExtensions: [{ Id: 1, Name: "DepTE", TargetObject: target, Fields: fields }] });
const depExtendingTargetEnum = (values: unknown[]): Uint8Array =>
  pkg({
    EnumExtensionTypes: [
      { Id: 2, Name: "DepEE", TargetObject: `#${TARGET_BARE}#My Enum`, Values: values },
    ],
  });

const TARGET_TABLE = `table 50400 "My Tbl"
{
    fields
    {
        field(1; Code; Code[10]) { }
        field(5; Other; Integer) { }
        field(7; Seven; Integer) { }
    }
}
`;
const TARGET_ENUM = `enum 50401 "My Enum"
{
    Extensible = true;
    value(0; Zero) { }
    value(7; Seven) { }
}
`;

function check(over: Partial<Parameters<typeof checkObjectClashes>[0]> = {}) {
  return checkObjectClashes({
    dependents: [DEP],
    testsAppId: undefined,
    targetFiles: [
      { path: "T.al", text: TARGET_TABLE },
      { path: "E.al", text: TARGET_ENUM },
    ],
    targetSymbols: [],
    injected: { selectorId: 901, controlId: 902, tableId: 903 },
    fetchPackage: async () => ({ unread: "not installed" }),
    readTestSources: async () => [],
    testSymbols: [],
    targetAppId: TARGET_ID,
    targetDependencies: [],
    transitive: [],
    startedMs: 0,
    now: () => 0,
    ...over,
  });
}

async function refusal(p: Promise<unknown>): Promise<ObjectClashError> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ObjectClashError);
  return err as ObjectClashError;
}

describe("R845: REAL alc packages, read through declaredObjectsOfPackage", () => {
  test("base: the fields of a tableextension and the values of an enumextension, owned by its own app", () => {
    const bytes = real("r845-base.app");
    expect(bytes.subarray(0, 4).toString("latin1")).toBe("NAVX");
    const got = declaredObjectsOfPackage(bytes, { id: BASE_ID, version: "1.0.0.0" });
    if (!("objects" in got)) throw new Error(got.unreadable);
    expect(got.unresolved).toEqual([]);
    expect(got.appId).toBe(bareAppId(BASE_ID));
    const m = got.members.map(
      (x) => `${x.container}:${x.ownerName}:${x.id}:${x.name}:${x.ownerApp}`,
    );
    // A bare TargetObject ("R845 Base T") resolved to the declaring app; the enum's own values and
    // the table's own fields are not extension members and are not listed.
    expect(m.sort()).toEqual(
      [
        `Table:R845 Base T:50101:Own:${bareAppId(BASE_ID)}`,
        `Enum:R845 Base E:50103:Own:${bareAppId(BASE_ID)}`,
        `Enum:R845 Base E:8:Eight:${bareAppId(BASE_ID)}`,
      ].sort(),
    );
  });

  test("ext: '#<app id>#Name' targets another app's table and enum", () => {
    const got = declaredObjectsOfPackage(real("r845-ext.app"), { id: EXT_ID, version: "1.0.0.0" });
    if (!("objects" in got)) throw new Error(got.unreadable);
    expect(
      got.members.map((x) => [x.container, x.ownerName, x.ownerApp, x.id, x.name]).sort(),
    ).toEqual([
      ["Enum", "R845 Base E", bareAppId(BASE_ID), 50201, "Foreign"],
      ["Table", "R845 Base T", bareAppId(BASE_ID), 50200, "Foreign"],
    ]);
  });

  test("moved: a table and a field marked Moved are read as Moved", () => {
    const got = declaredObjectsOfPackage(real("r845-moved.app"));
    if (!("objects" in got)) throw new Error(got.unreadable);
    expect(got.objects.find((o) => o.kind === "Table")?.moved).toBe(true);
    const base = declaredObjectsOfPackage(real("r845-base.app"));
    if (!("objects" in base)) throw new Error(base.unreadable);
    expect(base.objects.some((o) => o.moved === true)).toBe(false);
  });

  test("end to end on the real ext package: a target extending the base's table and enum refuses", async () => {
    await initParser();
    const bytes = new Uint8Array(real("r845-ext.app"));
    const run = (src: string, deps: readonly { id: string }[] = [{ id: BASE_ID }]) =>
      check({
        dependents: [EXT_DEP],
        targetFiles: [{ path: "Mine.al", text: src }],
        targetDependencies: deps,
        fetchPackage: async () => bytes,
      });
    const tableExt = (field: string) =>
      `tableextension 50300 "Mine" extends "R845 Base T"\n{\n    fields\n    {\n        ${field}\n    }\n}\n`;
    const enumExt = (value: string) =>
      `enumextension 50301 "MineE" extends "R845 Base E"\n{\n    ${value}\n}\n`;

    const byId = await refusal(run(tableExt("field(50200; Mine; Integer) { }")));
    expect(byId.memberFindings).toHaveLength(1);
    expect(byId.memberFindings[0]).toMatchObject({
      rule: "field-id",
      container: "Table",
      ownerName: "R845 Base T",
      target: { id: 50200, name: "Mine", where: "Mine.al" },
      other: { id: 50200, name: "Foreign" },
      app: EXT_DEP,
      read: "installed-package",
    });
    expect(byId.findings).toEqual([]);

    const byName = await refusal(run(tableExt("field(50999; Foreign; Integer) { }")));
    expect(byName.memberFindings.map((f) => f.rule)).toEqual(["field-name"]);

    const ordinal = await refusal(run(enumExt("value(50201; Mine) { }")));
    expect(ordinal.memberFindings.map((f) => [f.rule, f.container])).toEqual([
      ["enum-ordinal", "Enum"],
    ]);
    const valueName = await refusal(run(enumExt("value(60000; Foreign) { }")));
    expect(valueName.memberFindings.map((f) => f.rule)).toEqual(["enum-value-name"]);

    // L5: names differing only in case are accepted by BC. A different id, so only the name could clash.
    expect(await run(tableExt("field(50999; foreign; Integer) { }"))).toEqual([]);
    // The same id on a DIFFERENT table is no clash.
    expect(
      await run(
        'tableextension 50302 "Other" extends "Some Other Table"\n{\n    fields\n    {\n        field(50200; Mine; Integer) { }\n    }\n}\n',
      ),
    ).toEqual([]);
    // The base app is not one the target depends on: the same-named table may be another app's.
    const warned = await run(tableExt("field(50200; Mine; Integer) { }"), []);
    expect(warned.join("\n")).toContain("may be another app's table");
  });
});

describe("R845: compareMembers (pure)", () => {
  const src = (over: Partial<SourceMember> = {}): SourceMember => ({
    container: "Table",
    ownerName: "My Tbl",
    ownerKey: "my tbl",
    own: true,
    id: 5,
    name: "Mine",
    moved: false,
    where: "T.al",
    ...over,
  });
  const pm = (over: Partial<PackageMember> = {}): PackageMember => ({
    container: "Table",
    ownerApp: TARGET_BARE,
    ownerName: "My Tbl",
    ownerKey: "my tbl",
    id: 5,
    name: "Theirs",
    moved: false,
    where: "SymbolReference.json",
    ...over,
  });
  const ctx = { targetApp: TARGET_BARE, otherApp: bareAppId(DEP_ID), trusted: new Set<string>() };
  const rules = (t: SourceMember[], o: PackageMember[], c = ctx) =>
    compareMembers(t, o, c).clashes.map((x) => x.rule);

  test("U1, U6, U2, L4: the target's own table or enum", () => {
    expect(rules([src()], [pm()])).toEqual(["field-id"]);
    expect(rules([src()], [pm({ id: 99, name: "Mine" })])).toEqual(["field-name"]);
    expect(rules([src({ container: "Enum" })], [pm({ container: "Enum" })])).toEqual([
      "enum-ordinal",
    ]);
    expect(
      rules([src({ container: "Enum" })], [pm({ container: "Enum", id: 99, name: "Mine" })]),
    ).toEqual(["enum-value-name"]);
  });

  test("L3e, L7b, L3f, L3g: a third app's table, when its owner is a dependency or Microsoft", () => {
    const third = "5e51037273b74af1841e42184d5d7479";
    const t = [src({ own: false })];
    const o = [pm({ ownerApp: third })];
    expect(rules(t, o, { ...ctx, trusted: new Set([third]) })).toEqual(["field-id"]);
    // A Microsoft app needs no dependency entry.
    expect(rules(t, [pm({ ownerApp: "437dbf0e84ff417a965ded2bb9650972" })])).toEqual(["field-id"]);
    // Neither: it may be another app's table of that name. A warning, never a refusal.
    const got = compareMembers(t, o, ctx);
    expect(got.clashes).toEqual([]);
    expect(got.soft.map((s) => s.reason)).toEqual(["owner-unknown"]);
  });

  test("L5: names that differ only in case pass", () => {
    expect(rules([src({ name: "Mine" })], [pm({ id: 99, name: "mine" })])).toEqual([]);
    expect(rules([src({ name: "Mine" })], [pm({ id: 99, name: "Mine " })])).toEqual([]);
  });

  test("the same id, name or ordinal on a DIFFERENT table or enum passes", () => {
    expect(rules([src()], [pm({ ownerName: "Another", ownerKey: "another" })])).toEqual([]);
    expect(rules([src()], [pm({ container: "Enum" })])).toEqual([]);
    expect(rules([src()], [pm({ ownerApp: "ffffffffffffffffffffffffffffffff" })])).toEqual([]);
  });

  test("a dependent's own table of the same name is not the table the target extends", () => {
    const own = pm({ ownerApp: bareAppId(DEP_ID), ownerName: "Setup", ownerKey: "setup" });
    const got = compareMembers(
      [src({ own: false, ownerName: "Setup", ownerKey: "setup" })],
      [own],
      ctx,
    );
    expect(got.clashes).toEqual([]);
    expect(got.soft).toEqual([]);
  });

  test("Moved on either side warns and does not refuse", () => {
    for (const [t, o] of [
      [src({ moved: true }), pm()],
      [src(), pm({ moved: true })],
    ] as const) {
      const got = compareMembers([t], [o], ctx);
      expect(got.clashes).toEqual([]);
      expect(got.soft.map((s) => s.reason)).toEqual(["moved"]);
    }
  });

  test("the fallback compares names only: every pair is returned, a tests-own table is left out", () => {
    const pairs = compareMembersBySource([src()], [src({ own: false, name: "Theirs" })]);
    expect(pairs.map((p) => p.rule)).toEqual(["field-id"]);
    expect(compareMembersBySource([src()], [src({ own: true })])).toEqual([]);
  });
});

describe("R845: reading the package, strictly", () => {
  test("an omitted Ordinal reads 0", () => {
    const e = readExtensionEntry(
      { TargetObject: `#${TARGET_BARE}#My Enum`, Name: "X", Values: [{ Name: "Zero" }] },
      "Enum",
    );
    expect("members" in e && e.members.map((m) => m.id)).toEqual([0]);
  });

  test("a bare TargetObject resolves to its own app; one that is not its own table is named and not compared", () => {
    const resolved = declaredObjectsOfSymbolReference(
      {
        AppId: DEP_ID,
        Tables: [{ Id: 70, Name: "Setup" }],
        TableExtensions: [
          { Id: 1, Name: "A", TargetObject: "setup", Fields: [{ Id: 5, Name: "F" }] },
          { Id: 2, Name: "B", TargetObject: "Nowhere", Fields: [{ Id: 6, Name: "G" }] },
        ],
      },
      "x",
    );
    if (!("objects" in resolved)) throw new Error(resolved.unreadable);
    expect(resolved.members.map((m) => [m.ownerApp, m.id])).toEqual([[bareAppId(DEP_ID), 5]]);
    expect(resolved.unresolved).toEqual(['B extends "Nowhere"']);
  });

  test("bad member entries make the package unreadable, never empty", () => {
    const ok = { TargetObject: `#${TARGET_BARE}#T`, Name: "X" };
    const bad: unknown[] = [
      { ...ok, TargetObject: undefined, Fields: [] },
      { ...ok, TargetObject: 7, Fields: [] },
      { ...ok, TargetObject: "#nothex#T", Fields: [] },
      { ...ok, Fields: {} },
      { ...ok, Fields: [null] },
      { ...ok, Fields: [{ Id: "5", Name: "F" }] },
      { ...ok, Fields: [{ Id: 5.5, Name: "F" }] },
      { ...ok, Fields: [{ Id: 5 }] },
      { ...ok, Fields: [{ Id: 5, Name: 7 }] },
      { ...ok, Fields: [{ Id: 5, Name: "F", Properties: {} }] },
    ];
    for (const ext of bad) {
      expect(
        declaredObjectsOfSymbolReference(
          { AppId: "a", TableExtensions: [{ Id: 1, ...(ext as object) }] },
          "x",
        ),
      ).toHaveProperty("unreadable");
    }
    const enumBad: unknown[] = [
      { Values: [{ Ordinal: "5", Name: "V" }] },
      { Values: [{ Ordinal: 5 }] },
      { Values: "x" },
    ];
    for (const ext of enumBad) {
      expect(
        declaredObjectsOfSymbolReference(
          { AppId: "a", EnumExtensionTypes: [{ Id: 1, ...ok, ...(ext as object) }] },
          "x",
        ),
      ).toHaveProperty("unreadable");
    }
    // A table extension with no fields at all is a valid package that declares nothing.
    const none = declaredObjectsOfSymbolReference(
      { AppId: "a", TableExtensions: [{ Id: 1, ...ok }] },
      "x",
    );
    expect("members" in none && none.members).toEqual([]);
    // A garbled package must not let check() read it as clean: it warns that nothing was compared.
  });

  test('"" unquotes to one quote, in a name and in a qualified base', () => {
    expect(unquoteName('"G ""q"""')).toBe('G "q"');
    expect(unquoteName("Plain")).toBe("Plain");
    expect(splitQualified('Foo.Two."Other ""Name"""')).toEqual({
      qualifier: "Foo.Two",
      name: 'Other "Name"',
    });
    expect(splitQualified('"pub table"')).toEqual({ qualifier: "", name: "pub table" });
  });
});

describe("R845: reading the target's source by tree", () => {
  const read = (text: string, symbols: string[] = []) =>
    declaredObjectsOfSource([{ path: "x.al", text }], symbols);

  test("own table and enum members, extensions, a quoted name with doubled quotes", async () => {
    await initParser();
    const got = read(`namespace Foo.Bar;

table 50000 "My T"
{
    fields
    {
        field(1; Code; Code[10]) { }
        field(2; "My ""F"""; Integer) { }
    }
}

tableextension 50001 "My TE" extends "pub table"
{
    fields { field(50001; G; Integer) { } }
}

tableextension 50002 "Own TE" extends "My T"
{
    fields { field(50002; H; Integer) { } }
}

tableextension 50003 "Away" extends Foo.Two."My T"
{
    fields { field(50003; I; Integer) { } }
}

tableextension 50004 "Here" extends Foo.Bar."My T"
{
    fields { field(50004; J; Integer) { } }
}

enum 50008 "My E"
{
    value(0; Zero) { }
    value(7; "Seven X") { }
}

enumextension 50009 "My EE" extends "My E"
{
    value(50009; Nine) { }
}
`);
    const m = got.members.map((x) => `${x.container}:${x.ownerName}:${x.id}:${x.name}:${x.own}`);
    expect(m).toEqual([
      "Table:My T:1:Code:true",
      'Table:My T:2:My "F":true',
      "Table:pub table:50001:G:false",
      "Table:My T:50002:H:true",
      // A qualified base pointing away from the target's own namespace is not "own".
      "Table:My T:50003:I:false",
      "Table:My T:50004:J:true",
      "Enum:My E:0:Zero:true",
      "Enum:My E:7:Seven X:true",
      "Enum:My E:50009:Nine:true",
    ]);
    expect(got.memberNotes).toEqual([]);
  });

  test("members under #if: the live arm counts; an undecided file leaves its conditional members out", async () => {
    await initParser();
    const text = `tableextension 50001 "TE" extends "T"
{
    fields
    {
        field(50001; Plain; Integer) { }
#if A
        field(50002; OnlyA; Integer) { }
#endif
    }
}
`;
    expect(read(text, ["A"]).members.map((m) => m.name)).toEqual(["Plain", "OnlyA"]);
    expect(read(text, []).members.map((m) => m.name)).toEqual(["Plain"]);
  });

  test("`undecided` warns by file, and members inside its conditionals are not compared", async () => {
    await initParser();
    const text = `tableextension 50001 "TE" extends "My Tbl"
{
    fields
    {
        field(5; Mine; Integer) { }
    }
}
codeunit 5 "Plain"
{
    procedure P()
    var
        T: Text;
    begin
        T.ToLower()
#if X
        .ToUpper()
#endif
        ;
    end;
}
#if X
tableextension 50002 "Wrapped" extends "My Tbl"
{
    fields
    {
        field(6; Hidden; Integer) { }
    }
}
#endif
`;
    await initParser();
    const got = read(text, ["X"]);
    expect(got.undecided.map((u) => u.file)).toEqual(["x.al"]);
    expect(got.members.map((m) => m.name)).toEqual(["Mine"]);
    const dep = depExtendingTarget([{ Id: 5, Name: "DepField" }]);
    const warnings = await check({
      targetSymbols: ["X"],
      targetFiles: [
        { path: "x.al", text: text.replace('"My Tbl"', '"My Tbl"') },
        { path: "T.al", text: TARGET_TABLE },
      ],
      fetchPackage: async () => dep,
    }).then(
      () => "no refusal",
      (e: unknown) => e,
    );
    // The plain extension's field 5 clashes with the dependent's field 5 on the target's own table.
    expect(warnings).toBeInstanceOf(ObjectClashError);
  });

  test("a Moved field is flagged on the member and a Moved table on the object", async () => {
    await initParser();
    const got = read(`table 1 "M"
{
    ObsoleteState = Moved;
    MovedTo = '11111111-1111-4111-8111-111111111111';
    fields
    {
        field(1; Code; Code[10])
        {
            ObsoleteState = Moved;
            MovedTo = '11111111-1111-4111-8111-111111111111';
        }
        field(2; Plain; Integer) { }
    }
}
`);
    expect(got.objects[0]?.moved).toBe(true);
    expect(got.members.map((m) => [m.name, m.moved])).toEqual([
      ["Code", true],
      ["Plain", false],
    ]);
  });

  test("a header split by #if: the object counts, its members are NOT compared and a note says so", async () => {
    await initParser();
    const got = read(
      `#if A
table 1 "S1"
#else
table 2 "S2"
#endif
{
    fields { field(1; F; Integer) { } }
}
`,
      ["A"],
    );
    expect(got.objects.map((o) => o.id)).toEqual([1]);
    expect(got.members).toEqual([]);
    expect(got.memberNotes.join("\n")).toContain("header is split by #if");
  });

  test("a field whose id is not a number is a note, not a silent skip", async () => {
    await initParser();
    const got = read(
      'table 1 "M"\n{\n    fields\n    {\n        field(x; F; Integer) { }\n    }\n}\n',
    );
    expect(got.members).toEqual([]);
    expect(got.memberNotes.length).toBeGreaterThan(0);
  });
});

describe("R845: checkObjectClashes, members of the target's own table and enum", () => {
  test("U1/U6: field id then field name against a dependent's extension of the target's table", async () => {
    await initParser();
    const byId = await refusal(
      check({ fetchPackage: async () => depExtendingTarget([{ Id: 5, Name: "DepField" }]) }),
    );
    expect(byId.memberFindings).toHaveLength(1);
    expect(byId.memberFindings[0]).toMatchObject({
      rule: "field-id",
      container: "Table",
      ownerName: "My Tbl",
      target: { id: 5, name: "Other", where: "T.al" },
      other: { id: 5, name: "DepField" },
      app: DEP,
      read: "installed-package",
    });
    expect(byId.message).toContain("field id 5");
    expect(byId.message).toContain("AL0206");
    expect(byId.message).toContain("Recovering a stripped server");

    const byName = await refusal(
      check({ fetchPackage: async () => depExtendingTarget([{ Id: 99, Name: "Seven" }]) }),
    );
    expect(byName.memberFindings.map((f) => [f.rule, f.other.id])).toEqual([["field-name", 99]]);
  });

  test("U2/L4: enum ordinal then enum value name; an omitted ordinal is 0", async () => {
    await initParser();
    const byOrdinal = await refusal(
      check({ fetchPackage: async () => depExtendingTargetEnum([{ Ordinal: 7, Name: "Dep" }]) }),
    );
    expect(byOrdinal.memberFindings.map((f) => [f.rule, f.container])).toEqual([
      ["enum-ordinal", "Enum"],
    ]);
    const byName = await refusal(
      check({ fetchPackage: async () => depExtendingTargetEnum([{ Ordinal: 99, Name: "Seven" }]) }),
    );
    expect(byName.memberFindings.map((f) => f.rule)).toEqual(["enum-value-name"]);
    // The target's value(0; Zero) and the dependent's value with the Ordinal left out (= 0).
    const zero = await refusal(
      check({ fetchPackage: async () => depExtendingTargetEnum([{ Name: "DepZero" }]) }),
    );
    expect(zero.memberFindings.map((f) => [f.rule, f.other.id])).toEqual([["enum-ordinal", 0]]);
  });

  test("a case-only name difference passes; the same id on another table passes", async () => {
    await initParser();
    expect(
      await check({ fetchPackage: async () => depExtendingTarget([{ Id: 99, Name: "seven" }]) }),
    ).toEqual([]);
    expect(
      await check({
        fetchPackage: async () =>
          depExtendingTarget([{ Id: 5, Name: "DepField" }], `#${TARGET_BARE}#Another Tbl`),
      }),
    ).toEqual([]);
  });

  test("a bare TargetObject is the dependent's own table: its own Setup passes against a target extending Setup", async () => {
    await initParser();
    const dep = pkg({
      Tables: [{ Id: 70, Name: "Setup" }],
      TableExtensions: [
        { Id: 1, Name: "DepTE", TargetObject: "Setup", Fields: [{ Id: 5, Name: "Mine" }] },
      ],
    });
    const warnings = await check({
      targetFiles: [
        {
          path: "X.al",
          text: 'tableextension 50300 "Mine" extends Setup\n{\n    fields\n    {\n        field(5; Mine; Integer) { }\n    }\n}\n',
        },
      ],
      fetchPackage: async () => dep,
    });
    expect(warnings).toEqual([]);
  });

  test("a bare TargetObject that is not the dependent's own table warns by name", async () => {
    await initParser();
    const dep = pkg({
      TableExtensions: [
        { Id: 1, Name: "DepTE", TargetObject: "Nowhere", Fields: [{ Id: 5, Name: "F" }] },
      ],
    });
    const warnings = await check({ fetchPackage: async () => dep });
    expect(warnings.join("\n")).toContain('DepTE extends "Nowhere"');
  });

  test("Moved warns, never refuses: a field and a table", async () => {
    await initParser();
    const movedField = await check({
      fetchPackage: async () =>
        depExtendingTarget([
          { Id: 5, Name: "DepField", Properties: [{ Name: "ObsoleteState", Value: "Moved" }] },
        ]),
    });
    expect(movedField.join("\n")).toContain("marked Moved");
    const movedTable = await check({
      targetFiles: [
        {
          path: "T.al",
          text: "table 50400 \"My Tbl\"\n{\n    ObsoleteState = Moved;\n    MovedTo = '11111111-1111-4111-8111-111111111111';\n    fields { field(1; Code; Code[10]) { } }\n}\n",
        },
      ],
      fetchPackage: async () => pkg({ Tables: [{ Id: 50400, Name: "Theirs" }] }),
    });
    expect(movedTable.join("\n")).toContain("Table 50400 is marked Moved on the target");
  });

  test("a garbled member entry is an unreadable package: warned by name, not read as clean", async () => {
    await initParser();
    const garbled = depExtendingTarget([{ Id: "5", Name: "DepField" }]);
    const warnings = await check({ fetchPackage: async () => garbled });
    expect(warnings.join("\n")).toContain("could not read the installed package of Resident Tests");
    expect(warnings.join("\n")).toContain("malformed");
  });
});

describe("R845: transitive dependents, the bound, and the source fallback", () => {
  test("a clash with a TRANSITIVE dependent refuses, naming it", async () => {
    await initParser();
    const other: InstalledDependent = {
      id: EXT_ID,
      name: "Far Away",
      publisher: "P",
      version: "1.0.0.0",
    };
    const far = pkg({ Codeunits: [{ Id: 100, Name: "Theirs" }] }, EXT_ID, "1.0.0.0");
    const e = await refusal(
      check({
        targetFiles: [{ path: "T.al", text: 'codeunit 100 "T"\n{\n}\n' }],
        dependents: [DEP],
        transitive: [other],
        fetchPackage: async (app) => (app.name === "Far Away" ? far : pkg({})),
      }),
    );
    expect(e.findings.map((f) => [f.app.name, f.kind, f.id])).toEqual([
      ["Far Away", "Codeunit", 100],
    ]);
  });

  test("the app bound: 40 apps are read, the 41st is not, and it warns instead of refusing", async () => {
    await initParser();
    const fetched: string[] = [];
    const many = Array.from(
      { length: WALK_MAX_APPS + 1 },
      (_, i): InstalledDependent => ({
        id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
        name: `App${i + 1}`,
        publisher: "P",
        version: "1.0.0.0",
      }),
    );
    const warnings = await check({
      dependents: many.slice(0, 1),
      transitive: many.slice(1),
      fetchPackage: async (app) => {
        fetched.push(app.name);
        const n = Number.parseInt(app.name.slice(3), 10);
        const d = many[n - 1];
        return pkg({}, d?.id, "1.0.0.0");
      },
    });
    expect(fetched).toHaveLength(WALK_MAX_APPS);
    expect(fetched).not.toContain("App41");
    const w = warnings.filter((x) => x.includes("were NOT read"));
    expect(w).toHaveLength(1);
    expect(w[0]).toContain("1 were NOT read");
    expect(w[0]).toContain("App41");
  });

  test("the time bound: past 120 s on the clock nothing more is read", async () => {
    await initParser();
    let t = 0;
    const fetched: string[] = [];
    const apps = [1, 2, 3].map(
      (i): InstalledDependent => ({
        id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
        name: `App${i}`,
        publisher: "P",
        version: "1.0.0.0",
      }),
    );
    const warnings = await check({
      dependents: apps.slice(0, 1),
      transitive: apps.slice(1),
      now: () => t,
      fetchPackage: async (app) => {
        fetched.push(app.name);
        t += 130_000; // the first read alone takes longer than the whole budget
        const d = apps.find((a) => a.name === app.name);
        return pkg({}, d?.id, "1.0.0.0");
      },
    });
    expect(fetched).toEqual(["App1"]);
    expect(warnings.join("\n")).toContain("120 s");
    expect(warnings.join("\n")).toContain("2 were NOT read");
  });

  test("the source fallback: a member clash WARNS, never refuses; a tests-own table is left out", async () => {
    await initParser();
    const testsSrc = (text: string) => async () => [{ path: "Tests.al", text }];
    const warnings = await check({
      testsAppId: DEP_ID,
      readTestSources: testsSrc(
        'tableextension 200 "TT" extends "My Tbl"\n{\n    fields\n    {\n        field(5; Theirs; Integer) { }\n    }\n}\n',
      ),
    });
    const w = warnings.filter((x) => x.includes("R845") && x.includes("not a refusal"));
    expect(w).toHaveLength(1);
    expect(w[0]).toContain('table "My Tbl"');
    expect(w[0]).toContain("a field id");
    // The tests app's own table "My Tbl": its extension fields are not the target's.
    const own = await check({
      testsAppId: DEP_ID,
      readTestSources: testsSrc(
        'table 300 "My Tbl"\n{\n    fields\n    {\n        field(5; Theirs; Integer) { }\n    }\n}\n',
      ),
    });
    expect(own.filter((x) => x.includes("not a refusal"))).toEqual([]);
  });

  test("the target's own id is never its own dependent: nothing is read for an empty list", async () => {
    await initParser();
    let fetches = 0;
    const warnings = await check({
      dependents: [],
      transitive: [],
      fetchPackage: async () => {
        fetches++;
        return { unread: "x" };
      },
    });
    expect(warnings).toEqual([]);
    expect(fetches).toBe(0);
  });
});

describe("R845: dependenciesOf reads app.json strictly", () => {
  test("ids are read; none is none; a garbled list is refused by name, never a shorter list", () => {
    expect(dependenciesOf({})).toEqual([]);
    expect(dependenciesOf({ dependencies: [{ id: "a" }, { appId: "b", publisher: "P" }] })).toEqual(
      [{ id: "a" }, { id: "b" }],
    );
    expect(() => dependenciesOf({ dependencies: {} })).toThrow("not an array");
    expect(() => dependenciesOf({ dependencies: [{ id: "a" }, { name: "x" }] })).toThrow(
      "dependencies[1] has no string id",
    );
    expect(() => dependenciesOf({ dependencies: [null] })).toThrow("dependencies[0]");
  });
});

describe("R845: BC's three texts, through one helper", () => {
  const TEXTS = {
    object:
      "The application object of type 'CodeUnit' with the ID '91550' is defined in multiple apps. The apps are: A; B.",
    field:
      "The field ID '91535' can only appear once in the table 'T'. The field is declared in multiple apps",
    "enum-value":
      "Failing delta: Type: 'EnumValueAddDelta'; The error was: NavErrorException - Metadata delta application failed due to the following error(s):",
  } as const;
  const RESTORE_FAILED =
    ". The original extensions could not be restored due to X..\nExtensions that were previously installed but could not be reinstalled. These extensions should be manually reinstalled. If they are part of an upgrade command to do so:\nT by P\nD by P\n\n";

  test("bcClashText names each of the three, and nothing else", () => {
    for (const [kind, text] of Object.entries(TEXTS)) expect(bcClashText(text)).toBe(kind as never);
    expect(
      bcClashText(
        "Cannot install the extension because a newer version 1.0.0.2 was already installed",
      ),
    ).toBeUndefined();
    expect(bcClashText("")).toBeUndefined();
  });

  test("UpgradeNotRestoredError says each in BC's words, and not 'no longer compiles'", () => {
    const said: Record<string, string> = {
      object: "defined in multiple apps: the target and another installed app",
      field: "'can only appear once in the table'",
      "enum-value": "'Metadata delta application failed'",
    };
    for (const [kind, text] of Object.entries(TEXTS)) {
      const e = new UpgradeNotRestoredError(text + RESTORE_FAILED);
      expect(e.message).toContain(said[kind] ?? "?");
      expect(e.message).not.toContain("no longer compiles");
      expect(e.message).toContain("Recovering a stripped server");
    }
    // A text with none of the three keeps the compile wording.
    expect(new UpgradeNotRestoredError(`x${RESTORE_FAILED}`).message).toContain(
      "no longer compiles",
    );
  });

  test("U3: a clash text with no restore sentence is the named UpgradeClashRefusedError", () => {
    for (const text of Object.values(TEXTS)) {
      expect(clashRefusedWithoutRestore(text)).toBe(true);
      const e = upgradeNotRestored(new Error(text));
      expect(e).toBeInstanceOf(UpgradeClashRefusedError);
      expect(e).not.toBeInstanceOf(UpgradeNotRestoredError);
      expect(e?.message).toContain("Recovering a stripped server");
      expect(e?.message).toContain("made no attempt to restore");
      // A restore that failed is the other error; a clean restore is neither.
      expect(clashRefusedWithoutRestore(text + RESTORE_FAILED)).toBe(false);
      expect(upgradeNotRestored(new Error(text + RESTORE_FAILED))).toBeInstanceOf(
        UpgradeNotRestoredError,
      );
      const clean = `Publishing failed due to '${text}'. The original extensions have been restored.`;
      expect(clashRefusedWithoutRestore(clean)).toBe(false);
      expect(upgradeNotRestored(new Error(clean))).toBeUndefined();
    }
    expect(clashRefusedWithoutRestore("some other publish failure")).toBe(false);
  });
});
