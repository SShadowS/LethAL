import { describe, it, expect, beforeAll } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ALNodeKind, findFirst, initParser, parseAL, wrapRoot } from "@lethal/engine";
import type { MutationSpec } from "@lethal/engine";
import { writeInstrumentedProject } from "../src/project";

describe("writeInstrumentedProject", () => {
  beforeAll(async () => { await initParser(); });

  it("writes rewritten sources + selector + manifest", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lethal-"));
    try {
      const src = `codeunit 51040 "P" { procedure P() begin X := 1; end; }`;
      const root = wrapRoot(parseAL(src));
      const assign = findFirst(root, ALNodeKind.assignment_statement);
      if (assign === null) throw new Error("no assignment");
      const specs: MutationSpec[] = [
        {
          operatorName: "op.flip",
          operatorVersion: "1.0.0",
          astNodeId: `${assign.startIndex}`,
          before: assign,
          after: { ...assign, text: "X := 2;" } as never,
          parentContext: "statement-position",
        },
      ];
      await writeInstrumentedProject({
        targetDir: dir,
        files: [{ path: "P.Codeunit.al", source: src, root, specs }],
        selectorIds: { selectorId: 60000, controlId: 60001, tableId: 60002 },
      });

      const entries = (await readdir(dir)).sort();
      expect(entries).toContain("P.Codeunit.al");
      expect(entries).toContain("MutationSelector.Codeunit.al");
      expect(entries).toContain("MutationActive.Table.al");
      expect(entries).toContain("MutationControl.Codeunit.al");
      expect(entries).toContain("webservices.xml");
      expect(entries).toContain("mutant-manifest.json");

      const manifest = JSON.parse(
        await readFile(join(dir, "mutant-manifest.json"), "utf8"),
      );
      expect(manifest.mutants).toHaveLength(1);
      expect(manifest.mutants[0].mutantId).toBe("M0001");
      expect(manifest.mutants[0].operatorName).toBe("op.flip");

      const selector = await readFile(
        join(dir, "MutationSelector.Codeunit.al"),
        "utf8",
      );
      expect(selector).toContain("codeunit 60000");

      const rewritten = await readFile(join(dir, "P.Codeunit.al"), "utf8");
      expect(rewritten).toContain("MutationSelector.Active('M0001')");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("manifest entries carry identity and coverage-lookup fields", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lethal-"));
    try {
      // Test 1: Basic unquoted procedure name with exact line number
      const src1 = `codeunit 51040 "P" {
  procedure P() begin
    X := 1;
  end;
}`;
      const root1 = wrapRoot(parseAL(src1));
      const assign1 = findFirst(root1, ALNodeKind.assignment_statement);
      if (assign1 === null) throw new Error("no assignment in test 1");
      const specs1: MutationSpec[] = [
        {
          operatorName: "op.flip",
          operatorVersion: "1.0.0",
          astNodeId: `${assign1.startIndex}`,
          before: assign1,
          after: { ...assign1, text: "X := 2;" } as never,
          parentContext: "statement-position",
        },
      ];
      await writeInstrumentedProject({
        targetDir: dir,
        files: [{ path: "P.Codeunit.al", source: src1, root: root1, specs: specs1 }],
        selectorIds: { selectorId: 60000, controlId: 60001, tableId: 60002 },
      });

      let manifest = JSON.parse(
        await readFile(join(dir, "mutant-manifest.json"), "utf8"),
      );
      expect(manifest.selectorIds).toEqual({ selectorId: 60000, controlId: 60001, tableId: 60002 });
      let entry = manifest.mutants[0];
      expect(entry.astHash).toMatch(/^[0-9a-f]{8,}$/);
      expect(entry.codeunitId).toBe(51040);
      expect(entry.codeunitName).toBe("P");
      expect(entry.procedureName).toBe("P");
      expect(entry.startLine).toBe(3);

      // Test 2: Quoted procedure name - should strip quotes
      await rm(dir, { recursive: true, force: true });
      await mkdtemp(join(tmpdir(), "lethal-"));
      const src2 = `codeunit 51041 "MyCodeunit" {
  procedure "My Proc"() begin
    Y := 10;
  end;
}`;
      const root2 = wrapRoot(parseAL(src2));
      const assign2 = findFirst(root2, ALNodeKind.assignment_statement);
      if (assign2 === null) throw new Error("no assignment in test 2");
      const specs2: MutationSpec[] = [
        {
          operatorName: "op.flip",
          operatorVersion: "1.0.0",
          astNodeId: `${assign2.startIndex}`,
          before: assign2,
          after: { ...assign2, text: "Y := 20;" } as never,
          parentContext: "statement-position",
        },
      ];
      await writeInstrumentedProject({
        targetDir: dir,
        files: [{ path: "MyCodeunit.Codeunit.al", source: src2, root: root2, specs: specs2 }],
        selectorIds: { selectorId: 60000, controlId: 60001, tableId: 60002 },
      });

      manifest = JSON.parse(
        await readFile(join(dir, "mutant-manifest.json"), "utf8"),
      );
      entry = manifest.mutants[0];
      expect(entry.codeunitId).toBe(51041);
      expect(entry.codeunitName).toBe("MyCodeunit");
      expect(entry.procedureName).toBe("My Proc");
      expect(entry.startLine).toBe(3);

      // Test 3: Unquoted codeunit name in object header
      await rm(dir, { recursive: true, force: true });
      await mkdtemp(join(tmpdir(), "lethal-"));
      const src3 = `codeunit 51042 Plain {
  procedure MyProc() begin
    Z := 5;
  end;
}`;
      const root3 = wrapRoot(parseAL(src3));
      const assign3 = findFirst(root3, ALNodeKind.assignment_statement);
      if (assign3 === null) throw new Error("no assignment in test 3");
      const specs3: MutationSpec[] = [
        {
          operatorName: "op.flip",
          operatorVersion: "1.0.0",
          astNodeId: `${assign3.startIndex}`,
          before: assign3,
          after: { ...assign3, text: "Z := 10;" } as never,
          parentContext: "statement-position",
        },
      ];
      await writeInstrumentedProject({
        targetDir: dir,
        files: [{ path: "Plain.Codeunit.al", source: src3, root: root3, specs: specs3 }],
        selectorIds: { selectorId: 60000, controlId: 60001, tableId: 60002 },
      });

      manifest = JSON.parse(
        await readFile(join(dir, "mutant-manifest.json"), "utf8"),
      );
      entry = manifest.mutants[0];
      expect(entry.codeunitId).toBe(51042);
      expect(entry.codeunitName).toBe("Plain");
      expect(entry.procedureName).toBe("MyProc");
      expect(entry.startLine).toBe(3);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
