import { beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ALNodeKind, findFirst, initParser, parseAL, wrapRoot } from "@lethal/engine";
import type { ALSyntaxNode, MutationSpec } from "@lethal/engine";
import {
  CONTROL_REGISTER_FILENAME,
  CONTROL_SELECTOR_FILENAME,
  CONTROL_UPGRADE_FILENAME,
  writeInstrumentedProject,
} from "../src/project";

// The target project's own app.json `id` — threaded into the delegating selector and the
// register-install codeunit so the control extension keys state on the full identity tuple.
const TARGET_APP_ID = "df1aa9ff-6539-4c86-a9d0-ad702b61ac9a";

// None of these fixtures use colliding operator names, so an empty tier map is enough —
// `dedupeSpecs` (tested on its own in dedup.test.ts) never has to resolve a real precedence
// here. Real callers populate this from the registered operator set (see orchestrator.ts).
const NO_TIERS: ReadonlyMap<string, 1 | 2 | 3 | "custom"> = new Map();

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
        operatorTiers: NO_TIERS,
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

  it("records the enclosing trigger's name for a mutation inside a table trigger", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lethal-trigger-"));
    try {
      const src = `table 50100 "T"
{
    fields { field(1; "No."; Code[20]) { } }
    trigger OnInsert()
    begin
        DoThing();
    end;
}`;
      const root = wrapRoot(parseAL(src));
      const call = findFirst(root, ALNodeKind.procedure_call);
      if (call === null) throw new Error("no call expression");
      const specs: MutationSpec[] = [
        {
          operatorName: "op.void",
          operatorVersion: "1.0.0",
          astNodeId: `${call.startIndex}`,
          before: call,
          after: { ...call, text: "" } as never,
          parentContext: "statement-position",
        },
      ];
      await writeInstrumentedProject({
        targetDir: dir,
        files: [{ path: "T.Table.al", source: src, root, specs }],
        selectorIds: { selectorId: 60000, controlId: 60001, tableId: 60002 },
        artifactId: "0123456789abcdef0123456789abcdef",
        targetAppId: TARGET_APP_ID,
        operatorTiers: NO_TIERS,
      });

      const manifest = JSON.parse(await readFile(join(dir, "mutant-manifest.json"), "utf8"));
      expect(manifest.mutants[0]?.procedureName).toBe("");
      expect(manifest.mutants[0]?.triggerName).toBe("OnInsert");
      // Coverage keys on (objectType, objectId): `table 50100` is not `codeunit 50100`, and it is
      // the TABLE-ness that entitles this mutant to the coverage fallbacks in
      // packages/runner/src/selection.ts. Without it the fallbacks cannot tell the two apart.
      expect(manifest.mutants[0]?.objectType).toBe("table");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("records the enclosing trigger's name for a mutation inside a field-level trigger", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lethal-trigger-field-"));
    try {
      const src = `table 50100 "T"
{
    fields
    {
        field(1; "No."; Code[20])
        {
            trigger OnValidate()
            begin
                DoThing();
            end;
        }
    }
    keys { key(PK; "No.") { Clustered = true; } }
}`;
      const root = wrapRoot(parseAL(src));
      const call = findFirst(root, ALNodeKind.procedure_call);
      if (call === null) throw new Error("no call expression");
      const specs: MutationSpec[] = [
        {
          operatorName: "op.void",
          operatorVersion: "1.0.0",
          astNodeId: `${call.startIndex}`,
          before: call,
          after: { ...call, text: "" } as never,
          parentContext: "statement-position",
        },
      ];
      await writeInstrumentedProject({
        targetDir: dir,
        files: [{ path: "T.Table.al", source: src, root, specs }],
        selectorIds: { selectorId: 60000, controlId: 60001, tableId: 60002 },
        artifactId: "0123456789abcdef0123456789abcdef",
        targetAppId: TARGET_APP_ID,
        operatorTiers: NO_TIERS,
      });

      const manifest = JSON.parse(await readFile(join(dir, "mutant-manifest.json"), "utf8"));
      expect(manifest.mutants[0]?.procedureName).toBe("");
      expect(manifest.mutants[0]?.triggerName).toBe("OnValidate");
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
        operatorTiers: NO_TIERS,
      });

      let manifest = JSON.parse(await readFile(join(dir, "mutant-manifest.json"), "utf8"));
      expect(manifest.selectorIds).toEqual({ selectorId: 60000, controlId: 60001, tableId: 60002 });
      let entry = manifest.mutants[0];
      expect(entry.astHash).toMatch(/^[0-9a-f]{8,}$/);
      expect(entry.objectType).toBe("codeunit");
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
        operatorTiers: NO_TIERS,
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
        operatorTiers: NO_TIERS,
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
        operatorTiers: NO_TIERS,
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
        operatorTiers: NO_TIERS,
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

  // Exit criterion 4's artifact-level clause: "the suppressed mutant is absent from the EMITTED
  // ARTIFACT, not merely from the manifest". dedup.test.ts covers `dedupeSpecs` in isolation, and
  // that is not the same claim: `compileSchemataForFile` ignores its `specs` argument entirely
  // when `ided` is supplied (except for the `specs.length > 0` var-injection guard), so the only
  // thing that keeps the dropped mutant out of the emitted AL is `assignMutantIds` receiving the
  // DEDUPED map. Nothing pinned that. Wiring the deduped specs to the compile call but the raw
  // ones to `assignMutantIds` would leave an id-bearing guard compiled into the dispatch chain
  // that no manifest entry names — an unreported mutation that still exists in the artifact.
  it("emits the surviving mutant ONCE in the AL, not just once in the manifest, when two specs collide", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lethal-dedup-artifact-"));
    try {
      const src = `codeunit 51070 "D" { procedure P() begin Rec.TestField(Name); end; }`;
      const root = wrapRoot(parseAL(src));
      const call = findFirst(root, ALNodeKind.procedure_call);
      if (call === null) throw new Error("no call expression");
      // Same site, same replacement text (deletion), two operators of different tiers — exactly
      // the collision `dedupeSpecs` resolves in favour of the more specific Tier-2 operator.
      const collide = (operatorName: string): MutationSpec => ({
        operatorName,
        operatorVersion: "1.0.0",
        astNodeId: `${call.startIndex}-${operatorName}`,
        before: call,
        after: { ...call, text: "" } as never,
        parentContext: "statement-position",
      });
      await writeInstrumentedProject({
        targetDir: dir,
        files: [
          {
            path: "D.Codeunit.al",
            source: src,
            root,
            specs: [collide("lethal.void-method-call"), collide("lethal.remove-testfield")],
          },
        ],
        selectorIds: { selectorId: 60000, controlId: 60001, tableId: 60002 },
        artifactId: "0123456789abcdef0123456789abcdef",
        targetAppId: TARGET_APP_ID,
        // A REAL tier map — the empty NO_TIERS map would make `dedupeSpecs` throw on this pair
        // ("one of them is unregistered"), so the collision would never be resolved at all.
        operatorTiers: new Map<string, 1 | 2 | 3 | "custom">([
          ["lethal.void-method-call", 1],
          ["lethal.remove-testfield", 2],
        ]),
      });

      const manifest = JSON.parse(await readFile(join(dir, "mutant-manifest.json"), "utf8")) as {
        mutants: Array<{ mutantId: string; operatorName: string }>;
      };
      expect(manifest.mutants).toHaveLength(1);
      expect(manifest.mutants[0]?.operatorName).toBe("lethal.remove-testfield");

      const emitted = await readFile(join(dir, "D.Codeunit.al"), "utf8");
      const guards = emitted.match(/MutationSelector\.Active\(/g) ?? [];
      expect(guards).toHaveLength(1);
      // ...and the one guard emitted is the one the manifest names. A second mutant would have
      // taken M0002, so an artifact holding M0001 AND M0002 while the manifest lists only one is
      // exactly the "unreported mutation still in the artifact" failure.
      expect(emitted).toContain("MutationSelector.Active('M0001')");
      expect(emitted).not.toContain("M0002");
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
        operatorTiers: NO_TIERS,
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

  it("emits an Upgrade codeunit registering identity via the selector (Task 8)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lethal-upgrade-"));
    try {
      await writeInstrumentedProject({
        targetDir: dir,
        files: [],
        selectorIds: { selectorId: 79199, controlId: 79198, tableId: 79197 },
        artifactId: "0123456789abcdef0123456789abcdef",
        targetAppId: TARGET_APP_ID,
        operatorTiers: NO_TIERS,
      });

      const entries = await readdir(dir);
      expect(entries).toContain(CONTROL_SELECTOR_FILENAME);
      expect(entries).toContain(CONTROL_REGISTER_FILENAME);
      expect(entries).toContain(CONTROL_UPGRADE_FILENAME);

      const al = await readFile(join(dir, CONTROL_UPGRADE_FILENAME), "utf8");
      expect(al).toContain("OnUpgradePerCompany");
      expect(al).toContain("State.RegisterArtifact(Selector.TargetAppId(), Selector.ArtifactId())");
      // Object id is the freed tableId (the in-target Mutation Active table is gone).
      expect(al).toContain('codeunit 79197 "Mutation Upgrade"');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // Two objects in ONE file is legal AL (rare, but legal) and every layer below assumes one:
  // the manifest labels every mutant in the file with the FIRST header's (objectType, objectId),
  // so a mutant in the second object gets the first object's coverage key — the wrong test set,
  // hence a verdict that is silently wrong. And `injectMutationSelectorVar` picks
  // `findFirst(codeunit) ?? findFirst(table)`, which for `table` + `codeunit` in one file is the
  // SECOND object, leaving the first object's guards undeclared (AL0118). Refuse the shape.
  describe("a file declaring more than one AL object", () => {
    const TWO_OBJECTS = `table 51050 "First Obj"
{
    fields { field(1; "No."; Code[20]) { } }
}

codeunit 51051 "Second Obj"
{
    procedure P()
    begin
        X := 1;
    end;
}
`;

    function twoObjectFile() {
      const root = wrapRoot(parseAL(TWO_OBJECTS));
      const assign = findFirst(root, ALNodeKind.assignment_statement);
      if (assign === null) throw new Error("fixture has no assignment to mutate");
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
      return { path: "Two.Objects.al", source: TWO_OBJECTS, root, specs };
    }

    it("throws, naming the file and both objects, instead of misattributing the mutants", async () => {
      const dir = await mkdtemp(join(tmpdir(), "lethal-two-objects-"));
      try {
        let thrown: unknown;
        try {
          await writeInstrumentedProject({
            targetDir: dir,
            files: [twoObjectFile()],
            selectorIds: { selectorId: 60000, controlId: 60001, tableId: 60002 },
            artifactId: "0123456789abcdef0123456789abcdef",
            targetAppId: TARGET_APP_ID,
            operatorTiers: NO_TIERS,
          });
        } catch (err) {
          thrown = err;
        }
        expect(thrown).toBeInstanceOf(Error);
        const message = thrown instanceof Error ? thrown.message : "";
        expect(message).toContain("Two.Objects.al");
        expect(message).toContain("table 51050");
        expect(message).toContain("codeunit 51051");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("refuses BEFORE writing the half-instrumented source into the artifact dir", async () => {
      const dir = await mkdtemp(join(tmpdir(), "lethal-two-objects-nowrite-"));
      try {
        await writeInstrumentedProject({
          targetDir: dir,
          files: [twoObjectFile()],
          selectorIds: { selectorId: 60000, controlId: 60001, tableId: 60002 },
          artifactId: "0123456789abcdef0123456789abcdef",
          targetAppId: TARGET_APP_ID,
          operatorTiers: NO_TIERS,
        }).catch(() => {});
        expect(await readdir(dir)).not.toContain("Two.Objects.al");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("still accepts an ordinary one-object file", async () => {
      const dir = await mkdtemp(join(tmpdir(), "lethal-one-object-"));
      try {
        const src = `codeunit 51052 "Only" { procedure P() begin X := 1; end; }`;
        const root = wrapRoot(parseAL(src));
        const assign = findFirst(root, ALNodeKind.assignment_statement);
        if (assign === null) throw new Error("no assignment");
        await writeInstrumentedProject({
          targetDir: dir,
          files: [
            {
              path: "Only.Codeunit.al",
              source: src,
              root,
              specs: [
                {
                  operatorName: "op.flip",
                  operatorVersion: "1.0.0",
                  astNodeId: `${assign.startIndex}`,
                  before: assign,
                  after: { ...assign, text: "X := 2;" } as never,
                  parentContext: "statement-position",
                },
              ],
            },
          ],
          selectorIds: { selectorId: 60000, controlId: 60001, tableId: 60002 },
          artifactId: "0123456789abcdef0123456789abcdef",
          targetAppId: TARGET_APP_ID,
          operatorTiers: NO_TIERS,
        });
        const manifest = JSON.parse(await readFile(join(dir, "mutant-manifest.json"), "utf8")) as {
          mutants: Array<{ objectType: string; codeunitId: number }>;
        };
        expect(manifest.mutants).toHaveLength(1);
        expect(manifest.mutants[0]?.objectType).toBe("codeunit");
        expect(manifest.mutants[0]?.codeunitId).toBe(51052);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});
