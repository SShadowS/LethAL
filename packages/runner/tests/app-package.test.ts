import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppMethodIndex, findLocalProcedureNames, objectTypeName } from "../src/app-package";
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

describe("findLocalProcedureNames", () => {
  test("finds local procedures per object, skipping public ones", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lethal-local-proc-test-"));
    try {
      await writeFile(
        join(dir, "SandboxLogic.Codeunit.al"),
        [
          'codeunit 79000 "Sandbox Logic"',
          "{",
          "    procedure ApplyAudit(Amount: Decimal)",
          "    begin",
          "        LogAudit(Amount);",
          "    end;",
          "",
          "    local procedure LogAudit(Amount: Decimal)",
          "    begin",
          "    end;",
          "}",
          "",
        ].join("\n"),
      );
      const result = await findLocalProcedureNames(dir);
      expect(result.get("5:79000")).toEqual(["LogAudit"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("keys by object type and id, and returns nothing for an object with no locals", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lethal-local-proc-test-"));
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, "SandboxPricing.Codeunit.al"),
        [
          'codeunit 79001 "Sandbox Pricing"',
          "{",
          "    procedure DiscountedPrice(Price: Decimal): Decimal",
          "    begin",
          "        exit(Price);",
          "    end;",
          "}",
          "",
        ].join("\n"),
      );
      const result = await findLocalProcedureNames(dir);
      expect(result.has("5:79001")).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
