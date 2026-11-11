import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { initParser } from "@lethal/engine";
import { readPackageEntry } from "../src/app-package";
import { UpgradeNotRestoredError } from "../src/app-version";
import { readTargetSource } from "../src/baseline-snapshot";
import { UnfilteredExtensionsQueryError } from "../src/harness";
import type { InstalledDependent } from "../src/harness";
import { compareMembersBySource } from "../src/member-clash";
import {
  type DeclaredObject,
  ObjectClashError,
  checkObjectClashes,
  declaredObjectsOfPackage,
  declaredObjectsOfSource,
  declaredObjectsOfSymbolReference,
  findObjectClashes,
  injectedObjects,
} from "../src/object-clash";
import { compiledMembershipOf } from "../src/test-membership";
import { readTestAppSources } from "../src/testpage-scan";
import { buildFakeAppWithEntries } from "./helpers/fake-app";
import { r932PkgA } from "./helpers/proven-test-app";

const FIXTURES = join(import.meta.dir, "..", "..", "..", "fixtures");

/** A REAL alc build (alc 18.1, runtime 17.0) of one object of every kind, in the namespace
 *  `R843.Kinds`, plus an interface: NAVX header, deflated entries, a BOM on SymbolReference.json.
 *  Kept with the other real alc builds under scripts/testdata (the .gitignore exception for *.app). */
const KINDS_APP = join(import.meta.dir, "..", "..", "..", "scripts", "testdata", "r843-kinds.app");
const KINDS_APP_ID = "0b7e1b86-9a6b-4a4f-8f0a-2b1c3d4e5f60";

/** The selector ids every gate and fixture config in the repo uses, for the injected codeunits. */
const INJECTED_ID_SETS = [
  { selectorId: 79199, controlId: 79198, tableId: 79197 },
  { selectorId: 79399, controlId: 79398, tableId: 79397 },
  { selectorId: 79547, controlId: 79548, tableId: 79549 },
  { selectorId: 78849, controlId: 78848, tableId: 78847 },
  { selectorId: 79649, controlId: 79648, tableId: 79647 },
  { selectorId: 79849, controlId: 79848, tableId: 79847 },
  { selectorId: 79749, controlId: 79748, tableId: 79747 },
];

/** Every (target, tests) pair under fixtures/: `<name>` and `<name>-tests`, plus sandbox-app and
 *  sandbox-tests. `sandbox-harden-answers` is an answer key, not a tests app. */
function fixturePairs(): Array<{ target: string; tests: string }> {
  const dirs = readdirSync(FIXTURES, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
  const pairs = dirs
    .filter((d) => d.endsWith("-tests") && dirs.includes(d.slice(0, -"-tests".length)))
    .map((d) => ({ target: d.slice(0, -"-tests".length), tests: d }));
  if (dirs.includes("sandbox-app") && dirs.includes("sandbox-tests")) {
    pairs.push({ target: "sandbox-app", tests: "sandbox-tests" });
  }
  return pairs;
}

/** The symbols a fixture's `#if` lines name, so each pair is also run with every one defined. */
function symbolSets(sources: readonly { text: string }[]): string[][] {
  const names = new Set<string>();
  for (const s of sources) {
    for (const m of s.text.matchAll(/^\s*#(?:if|elif)\s+(?:not\s+)?([A-Za-z_]\w*)/gim)) {
      if (m[1] !== undefined) names.add(m[1]);
    }
  }
  const all = [...names];
  return [[], ...all.map((n) => [n]), ...(all.length > 1 ? [all] : [])];
}

describe("R843: no fixture target clashes with its tests app (source against source)", () => {
  test("there are fixture pairs to check", () => {
    // A guard against a vacuous pass: the fixtures dir really holds pairs.
    expect(fixturePairs().length).toBeGreaterThanOrEqual(9);
  });

  test("every pair, under every symbol set its #if lines name: 0 clashes", async () => {
    await initParser();
    let compared = 0;
    let membersSeen = 0;
    for (const { target, tests } of fixturePairs()) {
      const targetDir = join(FIXTURES, target);
      const testsDir = join(FIXTURES, tests);
      expect(existsSync(testsDir)).toBe(true);
      const targetFiles = [...(await readTargetSource(targetDir))]
        .filter(([p]) => p.toLowerCase().endsWith(".al"))
        .map(([path, b]) => ({ path, text: b.toString("utf8") }));
      const testFiles = await readTestAppSources(testsDir);
      expect(targetFiles.length).toBeGreaterThan(0);
      expect(testFiles.length).toBeGreaterThan(0);
      for (const symbols of symbolSets([...targetFiles, ...testFiles])) {
        const a = declaredObjectsOfSource(targetFiles, symbols);
        const b = declaredObjectsOfSource(testFiles, symbols);
        // Each side declares something, so an empty clash list is not an empty read.
        expect(a.objects.length).toBeGreaterThan(0);
        expect(b.objects.length).toBeGreaterThan(0);
        const clashes = findObjectClashes(a.objects, b.objects);
        expect(
          clashes.map((c) => `${target}/${tests} [${symbols}] ${c.target.kind} ${c.target.id}`),
        ).toEqual([]);
        // The three injected codeunits are part of the target's side, under every id set in use.
        for (const ids of INJECTED_ID_SETS) {
          const withInjected = findObjectClashes(
            [...a.objects, ...injectedObjects(ids)],
            b.objects,
          );
          expect(
            withInjected.map(
              (c) => `${target}/${tests} ${JSON.stringify(ids)} ${c.target.kind} ${c.target.id}`,
            ),
          ).toEqual([]);
        }
        // R845: the fields and enum values too. Source against source, by the real fallback
        // comparison (names only): any pair at all would be a candidate clash, and there are none.
        expect(
          compareMembersBySource(a.members, b.members).map(
            (c) => `${target}/${tests} [${symbols}] ${c.rule} ${c.target.ownerName}`,
          ),
        ).toEqual([]);
        expect(a.memberNotes).toEqual([]);
        expect(b.memberNotes).toEqual([]);
        membersSeen += a.members.length + b.members.length;
        compared++;
      }
    }
    expect(compared).toBeGreaterThanOrEqual(9);
    // Not a vacuous pass: the fixtures really do declare fields and enum values.
    expect(membersSeen).toBeGreaterThan(0);
  });
});

/** The compression method (8 = deflate) of one entry, from the zip's central directory. */
function zipMethodOf(buf: Buffer, entry: string): number | undefined {
  for (let i = 0; i + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(i) !== 0x02014b50) continue;
    const nameLen = buf.readUInt16LE(i + 28);
    if (buf.subarray(i + 46, i + 46 + nameLen).toString("utf8") === entry) {
      return buf.readUInt16LE(i + 10);
    }
  }
  return undefined;
}

const NS_XML = 'xmlns="http://schemas.microsoft.com/navx/2015/manifest"';
const manifestXml = (id: string, version: string) =>
  `<?xml version="1.0" encoding="utf-8"?><Package ${NS_XML}><App Id="${id}" Name="X" Publisher="P" Version="${version}" /></Package>`;

describe("R843: the readers", () => {
  test("a REAL alc package: NAVX header, deflate, BOM, one of every kind, a namespace", () => {
    const bytes = readFileSync(KINDS_APP);
    // What makes it real, asserted so a hand-built zip cannot stand in for it.
    expect(bytes.subarray(0, 4).toString("latin1")).toBe("NAVX");
    expect(zipMethodOf(bytes, "SymbolReference.json")).toBe(8);
    const raw = readPackageEntry(bytes, "SymbolReference.json");
    expect(raw?.[0]).toBe(0xef); // the UTF-8 BOM alc writes
    const json = JSON.parse((raw as Buffer).toString("utf8").replace(/^﻿/, ""));
    expect(json.Codeunits ?? []).toEqual([]); // every object sits inside the namespace
    expect(json.Namespaces).toHaveLength(1);
    expect(JSON.stringify(json.Namespaces)).toContain('"R843 I"'); // the interface is there, unread

    const got = declaredObjectsOfPackage(bytes, { id: KINDS_APP_ID, version: "1.0.0.0" });
    if (!("objects" in got)) throw new Error(`unreadable: ${got.unreadable}`);
    expect(got.objects.map((o) => `${o.kind}:${o.id}`).sort()).toEqual(
      [
        "Table:50000",
        "TableExtension:50001",
        "Page:50002",
        "PageExtension:50003",
        "Report:50004",
        "ReportExtension:50005",
        "Query:50006",
        "XmlPort:50007",
        "Enum:50008",
        "EnumExtension:50009",
        "PermissionSet:50010",
        "PermissionSetExtension:50011",
        "Codeunit:50012",
      ].sort(),
    );
  });

  test("a package must BE the installed app: another AppId or another Version is unreadable", () => {
    const bytes = readFileSync(KINDS_APP);
    const wrongId = declaredObjectsOfPackage(bytes, {
      id: "11111111-1111-4111-8111-111111111111",
      version: "1.0.0.0",
    });
    expect("unreadable" in wrongId && wrongId.unreadable).toContain("not the installed");
    const wrongVersion = declaredObjectsOfPackage(bytes, { id: KINDS_APP_ID, version: "2.0.0.0" });
    expect("unreadable" in wrongVersion && wrongVersion.unreadable).toContain("version 1.0.0.0");
    // The id compares case-insensitively, as BC's list may differ in case.
    const upper = declaredObjectsOfPackage(bytes, {
      id: KINDS_APP_ID.toUpperCase(),
      version: "1.0.0.0",
    });
    expect("objects" in upper).toBe(true);
    // Without an expectation the package is read as it is.
    expect("objects" in declaredObjectsOfPackage(bytes)).toBe(true);
  });

  test("R932: trailing NULs on SymbolReference.json are padding; a NUL in the middle is not", () => {
    const pkg = r932PkgA();
    expect(readPackageEntry(Buffer.from(pkg), "SymbolReference.json")?.at(-1)).toBe(0);
    const r = declaredObjectsOfPackage(pkg);
    expect("objects" in r).toBe(true);
    const mid = buildFakeAppWithEntries({ "SymbolReference.json": '{"AppId":\0"a"}' });
    const bad = declaredObjectsOfPackage(new Uint8Array(mid));
    expect(JSON.stringify(bad)).toContain("is not valid JSON");
  });

  test("R932: compiledMembershipOf reads the NUL-padded served package too; a middle NUL is refused", () => {
    const pkg = r932PkgA();
    const m = compiledMembershipOf(pkg);
    expect(m.kind).toBe("read");
    if (m.kind === "read") expect(m.tests.map((t) => t.method)).toContain("ControlPasses");
    const mid = buildFakeAppWithEntries({ "SymbolReference.json": '{"Codeunits":\0[]}' });
    const bad = compiledMembershipOf(new Uint8Array(mid));
    expect(bad.kind).toBe("none");
    if (bad.kind === "none") expect(bad.why).toContain("not valid JSON");
  });

  test("a garbled SymbolReference never reads as 'declares nothing'", () => {
    const bad: unknown[] = [
      {},
      null,
      [],
      "x",
      { Tables: [] },
      { AppId: 7 },
      { AppId: "a", Tables: "x" },
      { AppId: "a", Codeunits: [{ Id: "7" }] },
      { AppId: "a", Codeunits: [null] },
      { AppId: "a", Codeunits: {} },
      { AppId: "a", Namespaces: {} },
      { AppId: "a", Namespaces: [null] },
      { AppId: "a", Namespaces: [{ Pages: "x" }] },
    ];
    for (const j of bad) {
      expect(declaredObjectsOfSymbolReference(j, "x")).toHaveProperty("unreadable");
    }
    // A valid document that really declares nothing is NOT unreadable.
    const empty = declaredObjectsOfSymbolReference({ AppId: "a" }, "x");
    expect("objects" in empty && empty.objects).toEqual([]);
    // An interface array is not a compared kind: its odd ids are never read.
    const withInterface = declaredObjectsOfSymbolReference(
      { AppId: "a", Interfaces: [{ Id: 1224451106 }] },
      "x",
    );
    expect("objects" in withInterface && withInterface.objects).toEqual([]);
  });

  test("a garbled package or zip is unreadable too", () => {
    expect(declaredObjectsOfPackage(new Uint8Array([1, 2, 3]))).toHaveProperty("unreadable");
    const noSymbols = new Uint8Array(buildFakeAppWithEntries({ "NavxManifest.xml": "<x/>" }));
    expect(declaredObjectsOfPackage(noSymbols)).toHaveProperty("unreadable");
    const notJson = new Uint8Array(buildFakeAppWithEntries({ "SymbolReference.json": "{nope" }));
    expect(declaredObjectsOfPackage(notJson)).toHaveProperty("unreadable");
    const noAppId = new Uint8Array(buildFakeAppWithEntries({ "SymbolReference.json": "{}" }));
    expect(declaredObjectsOfPackage(noAppId)).toHaveProperty("unreadable");
  });

  test("a Ready-to-Run wrapped package is unwrapped (R820); a broken wrapper is unreadable, not a throw", () => {
    const id = "22222222-2222-4222-8222-222222222222";
    const inner = buildFakeAppWithEntries({
      "NavxManifest.xml": manifestXml(id, "3.0.0.0"),
      "SymbolReference.json": JSON.stringify({
        AppId: id,
        Version: "3.0.0.0",
        Codeunits: [{ Id: 77, Name: "Inside" }],
      }),
    });
    const wrapped = new Uint8Array(
      buildFakeAppWithEntries({
        "readytorunappmanifest.json": JSON.stringify({ EmbeddedAppId: id }),
        "Inner.app": inner,
      }),
    );
    const got = declaredObjectsOfPackage(wrapped, { id, version: "3.0.0.0" });
    expect("objects" in got && got.objects.map((o) => `${o.kind}:${o.id}`)).toEqual([
      "Codeunit:77",
    ]);
    const broken = new Uint8Array(
      buildFakeAppWithEntries({
        "readytorunappmanifest.json": JSON.stringify({ EmbeddedAppId: id }),
      }),
    );
    expect(declaredObjectsOfPackage(broken)).toHaveProperty("unreadable");
  });

  test("injected ids are in the sweep's reach: a test codeunit with the tableId clashes", async () => {
    await initParser();
    const testFiles = await readTestAppSources(join(FIXTURES, "sandbox-tests"));
    const own = declaredObjectsOfSource(testFiles, []).objects.find((o) => o.kind === "Codeunit");
    if (own === undefined) throw new Error("sandbox-tests declares no codeunit");
    const ids = { selectorId: 1, controlId: 2, tableId: own.id };
    const clashes = findObjectClashes(
      injectedObjects(ids),
      declaredObjectsOfSource(testFiles, []).objects,
    );
    expect(clashes.map((c) => c.target.where)).toEqual(["injected (tableId, a codeunit)"]);
  });

  test("source: a split header counts its LIVE arm only; a wrapped object likewise", async () => {
    await initParser();
    const text =
      '#if A\ncodeunit 1 "S1"\n#else\ncodeunit 2 "S2"\n#endif\n{\n}\n#if A\ncodeunit 3 "W1"\n{\n}\n#else\ncodeunit 4 "W2"\n{\n}\n#endif\n';
    const idsUnder = (symbols: string[]) =>
      declaredObjectsOfSource([{ path: "x.al", text }], symbols)
        .objects.map((o) => o.id)
        .sort();
    expect(idsUnder(["A"])).toEqual([1, 3]);
    expect(idsUnder([])).toEqual([2, 4]);
  });

  test("source: an undecided file is named and its conditional objects are left out", async () => {
    await initParser();
    const text =
      'codeunit 5 "Plain"\n{\n    procedure P()\n    var\n        T: Text;\n    begin\n        T.ToLower()\n#if X\n        .ToUpper()\n#endif\n        ;\n    end;\n}\n#if X\ncodeunit 6 "Wrapped"\n{\n}\n#endif\n';
    const got = declaredObjectsOfSource([{ path: "u.al", text }], ["X"]);
    expect(got.undecided.map((u) => u.file)).toEqual(["u.al"]);
    expect(got.objects.map((o) => o.id)).toEqual([5]);
  });

  test("a clash is by (kind, id): the same id in another kind is none", () => {
    const o = (kind: "Codeunit" | "Page", id: number) => ({ kind, id, name: "n", where: "w" });
    expect(findObjectClashes([o("Codeunit", 7)], [o("Page", 7)])).toEqual([]);
    expect(findObjectClashes([o("Codeunit", 7)], [o("Codeunit", 7)])).toHaveLength(1);
    expect(findObjectClashes([o("Codeunit", 7)], [o("Codeunit", 8)])).toEqual([]);
  });
});

describe("R843: UpgradeNotRestoredError names a clash as a clash", () => {
  const clash =
    "The application object of type 'CodeUnit' with the ID '79100' is defined in multiple apps. The original extensions could not be restored";
  test("BC's 'defined in multiple apps' is said as such, not as 'no longer compiles'", () => {
    const e = new UpgradeNotRestoredError(clash);
    expect(e.message).toContain("defined in multiple apps: the target and another installed app");
    expect(e.message).not.toContain("that depends on it declare");
    expect(e.message).not.toContain("no longer compiles");
    expect(e.message).toContain(clash);
  });
  test("any other text keeps the compile wording", () => {
    const e = new UpgradeNotRestoredError("The original extensions could not be restored");
    expect(e.message).toContain("no longer compiles against the new build");
    expect(e.message).not.toContain("defined in multiple apps");
  });
});

const DEP: InstalledDependent = {
  id: "33333333-3333-4333-8333-333333333333",
  name: "Resident Tests",
  publisher: "LethAL",
  version: "1.2.3.4",
};

function check(over: Partial<Parameters<typeof checkObjectClashes>[0]> = {}) {
  return checkObjectClashes({
    dependents: [DEP],
    testsAppId: DEP.id,
    targetFiles: [{ path: "T.al", text: 'codeunit 100 "T"\n{\n}\n' }],
    targetSymbols: [],
    injected: { selectorId: 901, controlId: 902, tableId: 903 },
    fetchPackage: async () => ({ unread: "not installed" }),
    readTestSources: async () => [{ path: "S.al", text: 'codeunit 200 "S"\n{\n}\n' }],
    testSymbols: ["TS"],
    targetAppId: "99999999-0000-4000-8000-000000000001",
    targetDependencies: [],
    transitive: [],
    startedMs: 0,
    now: () => 0,
    ...over,
  });
}

describe("R843: checkObjectClashes", () => {
  test("UnfilteredExtensionsQueryError is rethrown, never read as an unreadable package", async () => {
    await initParser();
    const err = new UnfilteredExtensionsQueryError("redirected to an unfiltered list");
    await expect(
      check({
        fetchPackage: async () => {
          throw err;
        },
      }),
    ).rejects.toBe(err);
    // Any other thrown error IS an unreadable package: a warning, and the tests app's source stands in.
    const warnings = await check({
      fetchPackage: async () => {
        throw new Error("connection reset");
      },
    });
    expect(warnings.join("\n")).toContain("connection reset");
  });

  test("a clean source fallback still warns: the installed package was not read", async () => {
    await initParser();
    const warnings = await check();
    const w = warnings.filter((x) => x.includes("was not read"));
    expect(w).toHaveLength(1);
    expect(w[0]).toContain("Resident Tests 1.2.3.4");
    expect(w[0]).toContain("not installed");
    expect(w[0]).toContain("[TS]");
  });

  test("a package that was read gives no such warning", async () => {
    await initParser();
    const pkg = new Uint8Array(
      buildFakeAppWithEntries({
        "SymbolReference.json": JSON.stringify({
          AppId: DEP.id,
          Version: DEP.version,
          Codeunits: [{ Id: 300, Name: "Theirs" }],
        }),
      }),
    );
    const warnings = await check({ fetchPackage: async () => pkg });
    expect(warnings).toEqual([]);
  });

  test("a package for another version is not trusted: source stands in, with a warning", async () => {
    await initParser();
    const stale = new Uint8Array(
      buildFakeAppWithEntries({
        "SymbolReference.json": JSON.stringify({
          AppId: DEP.id,
          Version: "0.0.0.1",
          Codeunits: [{ Id: 100, Name: "Old" }],
        }),
      }),
    );
    // Had it been trusted, codeunit 100 would clash with the target's.
    const warnings = await check({ fetchPackage: async () => stale });
    expect(warnings.join("\n")).toContain("version 0.0.0.1, not the installed 1.2.3.4");
  });
});

describe("R843: ObjectClashError", () => {
  const obj = (where: string, name = "N"): DeclaredObject => ({
    kind: "Codeunit",
    id: 5,
    name,
    where,
  });
  const finding = (where: string) => ({
    kind: "Codeunit" as const,
    id: 5,
    target: obj(where),
    other: obj("SymbolReference.json", "Theirs"),
    app: DEP,
    read: "installed-package" as const,
  });

  test("an injected id: advice is selectorIds in the config, not republishing", () => {
    const m = new ObjectClashError([finding("injected (selectorId)")]).message;
    expect(m).toContain("set selectorIds in the config");
    expect(m).not.toContain("Republish the named app");
  });

  test("a source object: advice is to republish or remove the named app", () => {
    const m = new ObjectClashError([finding("src/A.al")]).message;
    expect(m).toContain("Republish the named app");
    expect(m).not.toContain("selectorIds");
  });

  test("both kinds in one refusal give both pieces of advice", () => {
    const m = new ObjectClashError([finding("src/A.al"), finding("injected (tableId, a codeunit)")])
      .message;
    expect(m).toContain("Republish the named app");
    expect(m).toContain("selectorIds");
  });

  test("it says 'before the target is published', not 'before anything is published'", () => {
    const m = new ObjectClashError([finding("src/A.al")]).message;
    expect(m).toContain("before the target is published");
    expect(m).not.toContain("before anything is published");
  });
});

describe("R861: a tableextension that extends by id is compared on the table's name", () => {
  const TABLE_AL = 'table 50110 "Tmpl"\n{\n    fields { field(1; "No."; Code[20]) { } }\n}\n';
  const extAl = (base: string) =>
    `tableextension 50111 E extends ${base}\n{\n    fields { field(5; Mine; Integer) { } }\n}\n`;
  const ownerOf = async (base: string): Promise<string | undefined> => {
    await initParser();
    const read = declaredObjectsOfSource(
      [
        { path: "T.al", text: TABLE_AL },
        { path: "E.al", text: extAl(base) },
      ],
      [],
    );
    return read.members.find((m) => m.id === 5)?.ownerName;
  };
  test("resolved (`extends 50110`): the owner is the table's name (red: the id is the owner)", async () => {
    expect(await ownerOf("50110")).toBe("Tmpl");
  });
  test("unresolved (`extends 18`): stays the number, a named LIMIT (no name to compare on)", async () => {
    expect(await ownerOf("18")).toBe("18");
  });
  test("a plain name (control)", async () => {
    expect(await ownerOf("Tmpl")).toBe("Tmpl");
  });
});
