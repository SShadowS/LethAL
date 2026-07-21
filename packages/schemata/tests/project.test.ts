import { beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ALNodeKind, findFirst, initParser, parseAL, wrapRoot } from "@lethal/engine";
import type { ALSyntaxNode, MutationSpec } from "@lethal/engine";
import { writeInstrumentedProject } from "../src/project";

// The target project's own app.json `id` — threaded into the delegating selector and the
// register-install codeunit so the control extension keys state on the full identity tuple.
const TARGET_APP_ID = "df1aa9ff-6539-4c86-a9d0-ad702b61ac9a";

describe("writeInstrumentedProject", () => {
  beforeAll(async () => {
    await initParser();
  });

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
        artifactId: "0123456789abcdef0123456789abcdef",
        targetAppId: TARGET_APP_ID,
      });

      const entries = (await readdir(dir)).sort();
      expect(entries).toContain("P.Codeunit.al");
      expect(entries).toContain("MutationSelector.Codeunit.al");
      expect(entries).toContain("MutationRegister.Codeunit.al");
      expect(entries).toContain("mutant-manifest.json");
      // Task 4: the in-target state surface moved to the LethAL Control extension — the target
      // no longer emits its own Mutation Active table, Mutation Control codeunit, or the
      // MutationControl web-service registration.
      expect(entries).not.toContain("MutationActive.Table.al");
      expect(entries).not.toContain("MutationControl.Codeunit.al");
      expect(entries).not.toContain("webservices.xml");

      const manifest = JSON.parse(await readFile(join(dir, "mutant-manifest.json"), "utf8"));
      expect(manifest.mutants).toHaveLength(1);
      expect(manifest.mutants[0].mutantId).toBe("M0001");
      expect(manifest.mutants[0].operatorName).toBe("op.flip");

      // The dispatch/var-injection seam is UNCHANGED: guards still call MutationSelector.Active(id).
      const rewritten = await readFile(join(dir, "P.Codeunit.al"), "utf8");
      expect(rewritten).toContain("MutationSelector.Active('M0001')");

      // The selector is now a thin delegate into the control extension over the identity tuple.
      const selector = await readFile(join(dir, "MutationSelector.Codeunit.al"), "utf8");
      expect(selector).toContain("codeunit 60000");
      expect(selector).toContain(
        `ControlState.IsActive('${TARGET_APP_ID}', '0123456789abcdef0123456789abcdef', MutantId)`,
      );

      // The register-install codeunit reads identity from the selector (single-sourced) instead
      // of baking targetAppId/artifactId in as args (Layer 5C-A Task 8).
      const register = await readFile(join(dir, "MutationRegister.Codeunit.al"), "utf8");
      expect(register).toContain("Subtype = Install;");
      expect(register).toContain('Selector: Codeunit "Mutation Selector"');
      expect(register).toContain(
        "State.RegisterArtifact(Selector.TargetAppId(), Selector.ArtifactId());",
      );
      expect(register).not.toContain(TARGET_APP_ID);
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
        artifactId: "0123456789abcdef0123456789abcdef",
        targetAppId: TARGET_APP_ID,
      });

      let manifest = JSON.parse(await readFile(join(dir, "mutant-manifest.json"), "utf8"));
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
        artifactId: "0123456789abcdef0123456789abcdef",
        targetAppId: TARGET_APP_ID,
      });

      manifest = JSON.parse(await readFile(join(dir, "mutant-manifest.json"), "utf8"));
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
        artifactId: "0123456789abcdef0123456789abcdef",
        targetAppId: TARGET_APP_ID,
      });

      manifest = JSON.parse(await readFile(join(dir, "mutant-manifest.json"), "utf8"));
      entry = manifest.mutants[0];
      expect(entry.codeunitId).toBe(51042);
      expect(entry.codeunitName).toBe("Plain");
      expect(entry.procedureName).toBe("MyProc");
      expect(entry.startLine).toBe(3);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("allocates mutant ids once, artifact-wide, so manifest ids match emitted guards across multiple files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lethal-"));
    try {
      // File A: two non-overlapping statement-position mutants (separate
      // statements, so writeInstrumentedProject's overlap check is unaffected).
      const srcA = `codeunit 51050 "A" { procedure P() begin X := 1; Y := 2; end; }`;
      const rootA = wrapRoot(parseAL(srcA));
      const assignsA: ALSyntaxNode[] = [];
      // findFirst only returns the first match; walk manually to collect both.
      const collectAssignments = (node: ALSyntaxNode, out: ALSyntaxNode[]): void => {
        if (node.kind === ALNodeKind.assignment_statement) out.push(node);
        for (const child of node.namedChildren) collectAssignments(child, out);
      };
      collectAssignments(rootA, assignsA);
      if (assignsA.length !== 2) {
        throw new Error(`expected 2 assignments in file A, found ${assignsA.length}`);
      }
      const [assignA1, assignA2] = assignsA;
      if (assignA1 === undefined || assignA2 === undefined) {
        throw new Error("missing assignment nodes in file A");
      }
      const specsA: MutationSpec[] = [
        {
          operatorName: "op.flip",
          operatorVersion: "1.0.0",
          astNodeId: `${assignA1.startIndex}`,
          before: assignA1,
          after: { ...assignA1, text: "X := 99;" } as never,
          parentContext: "statement-position",
        },
        {
          operatorName: "op.flip",
          operatorVersion: "1.0.0",
          astNodeId: `${assignA2.startIndex}`,
          before: assignA2,
          after: { ...assignA2, text: "Y := 99;" } as never,
          parentContext: "statement-position",
        },
      ];

      // File B: one statement-position mutant.
      const srcB = `codeunit 51051 "B" { procedure Q() begin Z := 3; end; }`;
      const rootB = wrapRoot(parseAL(srcB));
      const assignB = findFirst(rootB, ALNodeKind.assignment_statement);
      if (assignB === null) throw new Error("no assignment in file B");
      const specsB: MutationSpec[] = [
        {
          operatorName: "op.flip",
          operatorVersion: "1.0.0",
          astNodeId: `${assignB.startIndex}`,
          before: assignB,
          after: { ...assignB, text: "Z := 99;" } as never,
          parentContext: "statement-position",
        },
      ];

      await writeInstrumentedProject({
        targetDir: dir,
        files: [
          { path: "A.Codeunit.al", source: srcA, root: rootA, specs: specsA },
          { path: "B.Codeunit.al", source: srcB, root: rootB, specs: specsB },
        ],
        selectorIds: { selectorId: 60000, controlId: 60001, tableId: 60002 },
        artifactId: "0123456789abcdef0123456789abcdef",
        targetAppId: TARGET_APP_ID,
      });

      const manifest = JSON.parse(await readFile(join(dir, "mutant-manifest.json"), "utf8"));
      expect(manifest.mutants).toHaveLength(3);

      const rewrittenA = await readFile(join(dir, "A.Codeunit.al"), "utf8");
      const rewrittenB = await readFile(join(dir, "B.Codeunit.al"), "utf8");
      const guardsByFile: Record<string, string> = {
        "A.Codeunit.al": rewrittenA,
        "B.Codeunit.al": rewrittenB,
      };

      // Regression: every manifest id must appear as an emitted guard in its
      // own file, and in no other file.
      for (const entry of manifest.mutants as Array<{ mutantId: string; file: string }>) {
        const guard = `MutationSelector.Active('${entry.mutantId}')`;
        const ownFileText = guardsByFile[entry.file];
        expect(ownFileText).toBeDefined();
        expect(ownFileText).toContain(guard);

        for (const [otherFile, otherText] of Object.entries(guardsByFile)) {
          if (otherFile === entry.file) continue;
          expect(otherText).not.toContain(guard);
        }
      }

      // The manifest's own ids must be unique (sanity check for the assertion
      // above — if two entries share an id, the "own file" check is vacuous).
      const ids = (manifest.mutants as Array<{ mutantId: string }>).map((m) => m.mutantId);
      expect(new Set(ids).size).toBe(ids.length);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("continues the id counter across files instead of restarting per file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lethal-"));
    try {
      const srcA = `codeunit 51060 "A" { procedure P() begin X := 1; Y := 2; end; }`;
      const rootA = wrapRoot(parseAL(srcA));
      const assignsA: ALSyntaxNode[] = [];
      const collectAssignments = (node: ALSyntaxNode, out: ALSyntaxNode[]): void => {
        if (node.kind === ALNodeKind.assignment_statement) out.push(node);
        for (const child of node.namedChildren) collectAssignments(child, out);
      };
      collectAssignments(rootA, assignsA);
      const [assignA1, assignA2] = assignsA;
      if (assignA1 === undefined || assignA2 === undefined) {
        throw new Error("expected 2 assignments in file A");
      }
      const specsA: MutationSpec[] = [
        {
          operatorName: "op.flip",
          operatorVersion: "1.0.0",
          astNodeId: `${assignA1.startIndex}`,
          before: assignA1,
          after: { ...assignA1, text: "X := 99;" } as never,
          parentContext: "statement-position",
        },
        {
          operatorName: "op.flip",
          operatorVersion: "1.0.0",
          astNodeId: `${assignA2.startIndex}`,
          before: assignA2,
          after: { ...assignA2, text: "Y := 99;" } as never,
          parentContext: "statement-position",
        },
      ];

      const srcB = `codeunit 51061 "B" { procedure Q() begin Z := 3; end; }`;
      const rootB = wrapRoot(parseAL(srcB));
      const assignB = findFirst(rootB, ALNodeKind.assignment_statement);
      if (assignB === null) throw new Error("no assignment in file B");
      const specsB: MutationSpec[] = [
        {
          operatorName: "op.flip",
          operatorVersion: "1.0.0",
          astNodeId: `${assignB.startIndex}`,
          before: assignB,
          after: { ...assignB, text: "Z := 99;" } as never,
          parentContext: "statement-position",
        },
      ];

      await writeInstrumentedProject({
        targetDir: dir,
        files: [
          { path: "A.Codeunit.al", source: srcA, root: rootA, specs: specsA },
          { path: "B.Codeunit.al", source: srcB, root: rootB, specs: specsB },
        ],
        selectorIds: { selectorId: 60000, controlId: 60001, tableId: 60002 },
        artifactId: "0123456789abcdef0123456789abcdef",
        targetAppId: TARGET_APP_ID,
      });

      const manifest = JSON.parse(await readFile(join(dir, "mutant-manifest.json"), "utf8"));
      const bEntry = (manifest.mutants as Array<{ mutantId: string; file: string }>).find(
        (m) => m.file === "B.Codeunit.al",
      );
      expect(bEntry?.mutantId).toBe("M0003");

      const rewrittenB = await readFile(join(dir, "B.Codeunit.al"), "utf8");
      expect(rewrittenB).toContain("MutationSelector.Active('M0003')");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("writes the artifact id into the manifest and the generated selector", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lethal-artifactid-"));
    try {
      await writeInstrumentedProject({
        targetDir: dir,
        files: [],
        selectorIds: { selectorId: 79000, controlId: 79001, tableId: 79002 },
        artifactId: "0123456789abcdef0123456789abcdef",
        targetAppId: TARGET_APP_ID,
      });
      const manifest = JSON.parse(await readFile(join(dir, "mutant-manifest.json"), "utf8")) as {
        artifactId: string;
      };
      expect(manifest.artifactId).toBe("0123456789abcdef0123456789abcdef");
      const selector = await readFile(join(dir, "MutationSelector.Codeunit.al"), "utf8");
      expect(selector).toContain("0123456789abcdef0123456789abcdef");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
