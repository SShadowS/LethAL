import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { initParser } from "@lethal/engine";
import { UpgradeNotRestoredError } from "../src/app-version";
import { readTargetSource } from "../src/baseline-snapshot";
import {
  declaredObjectsOfSource,
  declaredObjectsOfSymbolReference,
  findObjectClashes,
} from "../src/object-clash";
import { readTestAppSources } from "../src/testpage-scan";

const FIXTURES = join(import.meta.dir, "..", "..", "..", "fixtures");

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
        compared++;
      }
    }
    expect(compared).toBeGreaterThanOrEqual(9);
  });
});

describe("R843: the readers", () => {
  test("SymbolReference: every one of the 13 kinds, through Namespaces; an interface is not read", () => {
    const json = {
      Tables: [{ Id: 1, Name: "T" }],
      Codeunits: [{ Id: 2, Name: "C" }],
      Interfaces: [{ Id: 1224451106, Name: "I" }],
      Namespaces: [
        {
          Name: "A",
          Pages: [{ Id: 3, Name: "P" }],
          Namespaces: [
            {
              Name: "B",
              Reports: [{ Id: 4, Name: "R" }],
              Queries: [{ Id: 5, Name: "Q" }],
              XmlPorts: [{ Id: 6, Name: "X" }],
              EnumTypes: [{ Id: 7, Name: "E" }],
              EnumExtensionTypes: [{ Id: 8, Name: "EE" }],
              PermissionSets: [{ Id: 9, Name: "PS" }],
              PermissionSetExtensions: [{ Id: 10, Name: "PSE" }],
              TableExtensions: [{ Id: 11, Name: "TE" }],
              PageExtensions: [{ Id: 12, Name: "PE" }],
              ReportExtensions: [{ Id: 13, Name: "RE" }],
            },
          ],
        },
      ],
    };
    const got = declaredObjectsOfSymbolReference(json, "x").map((o) => `${o.kind}:${o.id}`);
    expect(got.sort()).toEqual(
      [
        "Table:1",
        "Codeunit:2",
        "Page:3",
        "Report:4",
        "Query:5",
        "XmlPort:6",
        "Enum:7",
        "EnumExtension:8",
        "PermissionSet:9",
        "PermissionSetExtension:10",
        "TableExtension:11",
        "PageExtension:12",
        "ReportExtension:13",
      ].sort(),
    );
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
    expect(e.message).toContain("defined in multiple apps: the target and an installed app");
    expect(e.message).not.toContain("no longer compiles");
    expect(e.message).toContain(clash);
  });
  test("any other text keeps the compile wording", () => {
    const e = new UpgradeNotRestoredError("The original extensions could not be restored");
    expect(e.message).toContain("no longer compiles against the new build");
    expect(e.message).not.toContain("defined in multiple apps");
  });
});
