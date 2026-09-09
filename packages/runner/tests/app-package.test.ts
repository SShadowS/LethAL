import { describe, expect, it, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppMethodIndex, objectTypeName } from "../src/app-package";
import { thinCoverageEvidence } from "../src/bcdev-backend";
import { buildFakeApp } from "./helpers/fake-app";

describe("objectTypeName", () => {
  test("maps known AL object type integers to names", () => {
    expect(objectTypeName(5)).toBe("Codeunit");
    expect(objectTypeName(1)).toBe("Table");
    expect(objectTypeName(8)).toBe("Page");
  });

  test("falls back to the raw number for unknown types", () => {
    expect(objectTypeName(999)).toBe("999");
  });
});

describe("AppMethodIndex.fromSymbolReference", () => {
  test("resolves a public procedure's coverage methodId to its name", () => {
    const index = AppMethodIndex.fromSymbolReference({
      Codeunits: [
        {
          Id: 79000,
          Name: "Sandbox Logic",
          Methods: [{ Id: -352596841, Name: "IsOverBudget" }],
        },
      ],
    });
    expect(index.lookup(5, 79000, -352596841)).toBe("IsOverBudget");
  });

  test("returns undefined for an unresolvable methodId", () => {
    const index = AppMethodIndex.fromSymbolReference({ Codeunits: [] });
    expect(index.lookup(5, 79000, 123)).toBeUndefined();
  });

  // R62: the extension arrays exist in SymbolReference.json with exactly this shape (measured by
  // compiling a probe with one of each, alc 18.0.38.8509) — before they were indexed, every
  // extension procedure fell to object level. 14/15 are BC's numeric extension object types,
  // measured live under R40.
  test("resolves tableextension and pageextension methods, and declares both objects", () => {
    const index = AppMethodIndex.fromSymbolReference({
      TableExtensions: [
        { Id: 79481, Name: "My Table Ext", Methods: [{ Id: -111, Name: "OnInsertHelper" }] },
      ],
      PageExtensions: [
        { Id: 79482, Name: "My Page Ext", Methods: [{ Id: 222, Name: "OnActionHelper" }] },
      ],
    });
    expect(index.lookup(15, 79481, -111)).toBe("OnInsertHelper");
    expect(index.lookup(14, 79482, 222)).toBe("OnActionHelper");
    expect(index.declaredObjects().has("tableextension:79481")).toBe(true);
    expect(index.declaredObjects().has("pageextension:79482")).toBe(true);
  });
});

describe("AppMethodIndex.fromAppFile", () => {
  test("extracts and resolves SymbolReference.json from a real zip package", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lethal-app-package-test-"));
    try {
      const appPath = join(dir, "fake.app");
      await writeFile(
        appPath,
        buildFakeApp({
          Codeunits: [
            { Id: 79000, Name: "Sandbox Logic", Methods: [{ Id: 42, Name: "ClampPercent" }] },
          ],
        }),
      );
      const index = await AppMethodIndex.fromAppFile(appPath);
      expect(index.lookup(5, 79000, 42)).toBe("ClampPercent");
      expect(index.lookup(5, 79000, 999)).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("objectTypeName — BC's numeric object types (R40)", () => {
  test("maps the extension types measured against a live server", async () => {
    // MEASURED, not read from documentation: a probe exercising a tableextension's and a
    // pageextension's own procedures came back as `15:<id>` and `14:<id>` from BC 28
    // (docs/measurements/tableextension-coverage-probe.al). Before these entries existed,
    // objectTypeName fell through to String(objectType), so coverage keyed "15:79481" while the
    // mutant manifest keyed "tableextension:79481" — a mismatch indistinguishable from
    // "nothing covered this object", which would have reported every extension mutant as
    // no-coverage.
    const { objectTypeName } = await import("../src/app-package");
    expect(objectTypeName(15)).toBe("TableExtension");
    expect(objectTypeName(14)).toBe("PageExtension");
    // The pre-existing mappings must be untouched.
    expect(objectTypeName(1)).toBe("Table");
    expect(objectTypeName(5)).toBe("Codeunit");
    expect(objectTypeName(8)).toBe("Page");
  });

  test("an unmapped type still falls back to its number, but does not do so silently", async () => {
    // Aborting a run over an object kind that merely appears in coverage would be worse than the
    // gap. But the SILENT version of this fallback is exactly what hid the extension defect, so
    // it must announce itself.
    const { objectTypeName } = await import("../src/app-package");
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (msg: unknown) => warnings.push(String(msg));
    try {
      expect(objectTypeName(9999)).toBe("9999");
    } finally {
      console.warn = original;
    }
    expect(warnings.join("\n")).toContain("unmapped BC object type 9999");
  });
});

/**
 * R58's scope rule. The fenced coverage payload is the ENTIRE `Code Coverage` table, so the line
 * map needs a hard "is this row from the artifact we compiled?" before it dares name a procedure.
 */
describe("AppMethodIndex.declaredObjects", () => {
  test("keys every declared object as <lowercase type>:<id>, matching line-map's own key", () => {
    const index = AppMethodIndex.fromSymbolReference({
      Tables: [{ Id: 79300, Name: "Data Main" }],
      Codeunits: [{ Id: 79100, Name: "Sandbox Logic" }],
      Pages: [{ Id: 79484, Name: "Card" }],
      Queries: [{ Id: 79302, Name: "Q" }],
      XmlPorts: [{ Id: 79303, Name: "X" }],
      Reports: [{ Id: 79304, Name: "R" }],
    });
    expect([...index.declaredObjects()].sort()).toEqual([
      "codeunit:79100",
      "page:79484",
      "query:79302",
      "report:79304",
      "table:79300",
      "xmlport:79303",
    ]);
  });

  // MEASURED 2026-07-28 by compiling a probe with one tableextension and one pageextension: the
  // arrays are named `TableExtensions`/`PageExtensions`. Getting these names wrong is silent — the
  // extension is simply not declared, its coverage rows are skipped, and every mutant in it reads
  // `no-coverage` with nothing logged anywhere.
  test("includes the two EXTENSION kinds, whose coverage comes under their own object id", () => {
    const index = AppMethodIndex.fromSymbolReference({
      TableExtensions: [{ Id: 79481, Name: "LX Base Ext" }],
      PageExtensions: [{ Id: 79485, Name: "LX Base Card Ext" }],
    });
    expect([...index.declaredObjects()].sort()).toEqual([
      "pageextension:79485",
      "tableextension:79481",
    ]);
  });

  test("is empty for a symbol reference declaring nothing", () => {
    expect(AppMethodIndex.fromSymbolReference({}).declaredObjects().size).toBe(0);
  });

  test("does not leak non-object arrays (enums, interfaces, permission sets) into the scope", () => {
    // They carry ids too, but no coverage row names them and `line-map.ts` never maps them — a
    // declared object with no map entry THROWS, so a stray entry here would abort a real run.
    const index = AppMethodIndex.fromSymbolReference({
      EnumTypes: [{ Id: 79310, Name: "E" }],
      Interfaces: [{ Id: 79311, Name: "I" }],
      PermissionSets: [{ Id: 79312, Name: "P" }],
      Profiles: [{ Id: 79313, Name: "Pr" }],
    });
    expect(index.declaredObjects().size).toBe(0);
  });
});

/**
 * Issue #9, root cause. A namespaced app declared NOTHING, so fenced coverage attributed nothing
 * and every mutant came back `no-coverage` on a suite that demonstrably kills more than half.
 *
 * The shape below is MEASURED, not invented: `alc` 18.0.2668733 was run twice on one codeunit,
 * once plain and once with `namespace Pageworks.Barcode.Engine;`, and the two SymbolReference.json
 * files compared. Plain puts the object in a root `Codeunits` array. Namespaced leaves that root
 * array EMPTY and moves the object into a `Namespaces` tree, one level per dotted segment, each
 * level carrying its own full set of object arrays.
 *
 * `fromSymbolReference` read the root arrays only, so every object in a namespaced app was
 * invisible: `declaredObjects()` returned an empty set and `lookup` never resolved a method name.
 * Namespaces are the modern default for an AppSource app, so this was not an edge case.
 */
describe("fromSymbolReference with namespaces (issue #9)", () => {
  /** `namespace Pageworks.Barcode.Engine;` nests one level per segment, objects at the deepest. */
  const namespaced = {
    Namespaces: [
      {
        Name: "Pageworks",
        Codeunits: [],
        Namespaces: [
          {
            Name: "Barcode",
            Codeunits: [],
            Namespaces: [
              {
                Name: "Engine",
                Namespaces: [],
                Codeunits: [
                  { Id: 71179724, Name: "Id Probe", Methods: [{ Id: 3, Name: "DoubleIt" }] },
                ],
                Tables: [{ Id: 71179700, Name: "Probe Table", Methods: [] }],
              },
            ],
          },
        ],
      },
    ],
    Codeunits: [],
    Tables: [],
  };

  it("declares an object nested in a namespace", () => {
    const index = AppMethodIndex.fromSymbolReference(namespaced);
    expect([...index.declaredObjects()].sort()).toEqual(["codeunit:71179724", "table:71179700"]);
  });

  it("resolves a method name nested in a namespace", () => {
    const index = AppMethodIndex.fromSymbolReference(namespaced);
    expect(index.lookup(5, 71179724, 3)).toBe("DoubleIt");
  });

  it("still reads a plain app, whose objects sit at the root", () => {
    const index = AppMethodIndex.fromSymbolReference({
      Codeunits: [{ Id: 50100, Name: "Plain", Methods: [{ Id: 1, Name: "Go" }] }],
    });
    expect([...index.declaredObjects()]).toEqual(["codeunit:50100"]);
    expect(index.lookup(5, 50100, 1)).toBe("Go");
  });

  /**
   * A namespaced app that ALSO has root-level objects must yield both. AL allows a file without a
   * `namespace` beside files that have one, so the two are not exclusive.
   */
  it("reads root objects and namespaced objects together", () => {
    const index = AppMethodIndex.fromSymbolReference({
      Codeunits: [{ Id: 50100, Name: "Root", Methods: [] }],
      Namespaces: [
        { Name: "N", Namespaces: [], Codeunits: [{ Id: 50101, Name: "Nested", Methods: [] }] },
      ],
    });
    expect([...index.declaredObjects()].sort()).toEqual(["codeunit:50100", "codeunit:50101"]);
  });
});

/**
 * The warning that fires when coverage rows arrive but none match the artifact.
 *
 * Issue #9 took a local compile-and-compare to diagnose because this message named its two suspects
 * and showed neither side's keys. These tests pin that it now carries the comparison, and that the
 * zero-declared case is called out as its own diagnosis rather than left as one suspect of two.
 */
describe("thinCoverageEvidence (issue #9 diagnosability)", () => {
  it("names the empty declared set as the cause, not the id filter", () => {
    const msg = thinCoverageEvidence(["codeunit:71179724"], 0, [], "71179675..71179775");
    expect(msg).toContain("NO objects at all");
    expect(msg).toContain("not the cause");
    expect(msg).toContain("namespace");
    // The rows that DID arrive still have to appear, or the reader cannot see both sides.
    expect(msg).toContain("codeunit:71179724");
  });

  it("shows both sides when the artifact does declare objects", () => {
    const msg = thinCoverageEvidence(
      ["codeunit:99"],
      2,
      ["codeunit:50100", "table:50101"],
      "50100..50200",
    );
    expect(msg).toContain("codeunit:99");
    expect(msg).toContain("codeunit:50100");
    expect(msg).toContain("50100..50200");
    expect(msg).not.toContain("NO objects at all");
  });

  it("says so when no object-id filter was sent", () => {
    expect(thinCoverageEvidence([], 1, ["codeunit:1"], undefined)).toContain("none sent");
  });
});
