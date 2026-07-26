import { beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ALNodeKind, findAll, findFirst, initParser, parseAL, wrapRoot } from "@lethal/engine";
import type { ALSyntaxNode, MutationSpec } from "@lethal/engine";
import {
  CONTROL_REGISTER_FILENAME,
  CONTROL_SELECTOR_FILENAME,
  CONTROL_UPGRADE_FILENAME,
  attributeHeader,
  scanDeclaredObjects,
  stripAlComments,
  writeInstrumentedProject,
} from "../src/project";
import type { ObjectHeader } from "../src/project";

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

  // Task 7 (R12): the same artifact-level claim as the test above, exercised across all four
  // Tier-2 Phase-1 shapes in ONE snippet instead of a single deletion. Three deletion operators
  // (`RemoveTestField`, `RemoveSetRange`, `RemoveCalcFields`) each collide with `void-method-call`
  // at their OWN site with the identical empty after-form — dedup must fire and Tier 2 must win
  // at each, independently. `SwapModifyFlag`'s after-form (`Modify(true)` -> `Modify(false)`)
  // differs from the deletion's empty one, so it must NOT collide with `void-method-call` at the
  // `Modify(true)` site — both coexist there (design doc §4 intro).
  //
  // Specs are hand-built (mirroring exactly what the real operators in @lethal/builtin-tier1 /
  // @lethal/builtin-tier2 emit for this shape) rather than generated by importing those packages:
  // both depend on @lethal/schemata (see their package.json), so schemata importing either back
  // would be a circular package reference that `tsc --build`'s project-reference graph rejects.
  it("Tier 2 precedence and coexistence across all four Phase-1 shapes in one snippet", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lethal-tier2-dedup-"));
    try {
      const src = `table 50200 "T"
{
    fields
    {
        field(1; "No."; Code[20]) { }
        field(2; "Name"; Text[50]) { }
    }

    trigger OnInsert()
    begin
        Rec.TestField("No.");
        Rec.SetRange("No.", 'A');
        Rec.CalcFields("Name");
        Rec.Modify(true);
    end;
}
`;
      const root = wrapRoot(parseAL(src));
      const calls = findAll(root, ALNodeKind.procedure_call);
      const [testFieldCall, setRangeCall, calcFieldsCall, modifyCall] = calls;
      if (
        testFieldCall === undefined ||
        setRangeCall === undefined ||
        calcFieldsCall === undefined ||
        modifyCall === undefined
      ) {
        throw new Error(`fixture expected 4 procedure_call sites, found ${calls.length}`);
      }

      // A deletion collision: void-method-call and a Tier-2 narrowing at the SAME node, both
      // with the empty after-form — exactly the shape dedup must resolve in Tier 2's favour.
      const deletionPair = (call: ALSyntaxNode, tier2Name: string): MutationSpec[] => [
        {
          operatorName: "lethal.void-method-call",
          operatorVersion: "1.0.0",
          astNodeId: `${call.startIndex}-void`,
          before: call,
          after: { ...call, text: "" } as never,
          parentContext: "statement-position",
        },
        {
          operatorName: tier2Name,
          operatorVersion: "1.0.0",
          astNodeId: `${call.startIndex}-${tier2Name}`,
          before: call,
          after: { ...call, text: "" } as never,
          parentContext: "statement-position",
        },
      ];

      // A non-collision: same node, but swap-modify-flag's after-form is NOT empty, so it must
      // survive dedup alongside void-method-call rather than being merged with it.
      const modifyPair: MutationSpec[] = [
        {
          operatorName: "lethal.void-method-call",
          operatorVersion: "1.0.0",
          astNodeId: `${modifyCall.startIndex}-void`,
          before: modifyCall,
          after: { ...modifyCall, text: "" } as never,
          parentContext: "statement-position",
        },
        {
          operatorName: "lethal.swap-modify-flag",
          operatorVersion: "1.0.0",
          astNodeId: `${modifyCall.startIndex}-swap`,
          before: modifyCall,
          after: { ...modifyCall, text: modifyCall.text.replace("true", "false") } as never,
          parentContext: "statement-position",
        },
      ];

      const specs: MutationSpec[] = [
        ...deletionPair(testFieldCall, "lethal.remove-testfield"),
        ...deletionPair(setRangeCall, "lethal.remove-setrange"),
        ...deletionPair(calcFieldsCall, "lethal.remove-calcfields"),
        ...modifyPair,
      ];

      await writeInstrumentedProject({
        targetDir: dir,
        files: [{ path: "T.Table.al", source: src, root, specs }],
        selectorIds: { selectorId: 60000, controlId: 60001, tableId: 60002 },
        artifactId: "0123456789abcdef0123456789abcdef",
        targetAppId: TARGET_APP_ID,
        operatorTiers: new Map<string, 1 | 2 | 3 | "custom">([
          ["lethal.void-method-call", 1],
          ["lethal.remove-testfield", 2],
          ["lethal.remove-setrange", 2],
          ["lethal.remove-calcfields", 2],
          ["lethal.swap-modify-flag", 2],
        ]),
      });

      const manifest = JSON.parse(await readFile(join(dir, "mutant-manifest.json"), "utf8")) as {
        mutants: Array<{ mutantId: string; startIndex: number; operatorName: string }>;
      };

      // 8 input specs; the 3 deletion collisions each resolve to 1 winner and the Modify pair
      // does not collide at all — 3 + 2 = 5 survivors.
      expect(manifest.mutants).toHaveLength(5);

      const byStart = (start: number) =>
        manifest.mutants.filter((m) => m.startIndex === start).map((m) => m.operatorName);

      // Requirement 1: each Tier-2 deletion suppresses void-method-call at ITS OWN site.
      expect(byStart(testFieldCall.startIndex)).toEqual(["lethal.remove-testfield"]);
      expect(byStart(setRangeCall.startIndex)).toEqual(["lethal.remove-setrange"]);
      expect(byStart(calcFieldsCall.startIndex)).toEqual(["lethal.remove-calcfields"]);

      // Requirement 2: the Modify(true) site yields TWO mutants — coexistence, not dedup.
      expect(byStart(modifyCall.startIndex).sort()).toEqual([
        "lethal.swap-modify-flag",
        "lethal.void-method-call",
      ]);

      // Requirement 3 / exit criterion 4's artifact-level clause: the suppressed Tier-1 mutants
      // are absent from the EMITTED AL, not merely missing from the manifest. If dedup ran only
      // for the manifest while the compile step still saw the raw (undeduped) 8 specs, 8 ids
      // would be assigned and 8 guards emitted while only 5 are reported — exactly the
      // "unreported mutation still in the artifact" failure §3.2 warns about. Matching the guard
      // count to the manifest count, AND confirming no id past the 5 assigned ones appears
      // anywhere, catches that directly.
      const emitted = await readFile(join(dir, "T.Table.al"), "utf8");
      const guards = emitted.match(/MutationSelector\.Active\(/g) ?? [];
      expect(guards).toHaveLength(5);
      for (const { mutantId } of manifest.mutants) {
        expect(emitted).toContain(`MutationSelector.Active('${mutantId}')`);
      }
      expect(emitted).not.toContain("M0006");
      expect(emitted).not.toContain("M0007");
      expect(emitted).not.toContain("M0008");

      // A "(site, operator) never repeats" loop used to sit here, credited against spec §7.4. It
      // could not fail: with four distinct sites and one spec per operator per site in this
      // batch, no key can repeat whatever `dedupeSpecs` does — and any behaviour that got the
      // grouping wrong is already caught by the `toHaveLength(5)` and `byStart(...)` assertions
      // above. §7.4's invariant only bites over the PRE-dedup set produced by REAL operators, so
      // it is asserted where the real registries are importable:
      // `packages/runner/tests/orchestrator.test.ts` ("generateMutationSet: real cross-tier
      // collisions").
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

  // Two objects in ONE file is legal AL (rare, but legal). R6: when every object in the file can
  // carry the injected selector var (a codeunit or a table), LethAL now attributes each mutant to
  // its OWN enclosing object instead of always the first header — see `attributeHeader`
  // (project.ts) and the per-object grouping in `injectMutationSelectorVar` (compile.ts). A file
  // that mixes an injectable object with a non-injectable one (page/report/query/xmlport/enum)
  // still refuses outright: dropping only the non-injectable object's mutants isn't implemented.
  describe("a file declaring more than one AL object", () => {
    // A mutant in EACH object — the fixture that actually exercises attribution, not just
    // "two objects, no throw". If either object's mutant were mislabelled with the OTHER
    // object's (type, id), the assertions below would catch it directly.
    const TWO_INJECTABLE_OBJECTS = `table 51050 "First Obj"
{
    fields { field(1; "No."; Code[20]) { } }

    trigger OnInsert()
    begin
        FirstFlag := 1;
    end;
}

codeunit 51051 "Second Obj"
{
    procedure P()
    begin
        SecondFlag := 1;
    end;
}
`;

    function twoInjectableObjectFile() {
      const root = wrapRoot(parseAL(TWO_INJECTABLE_OBJECTS));
      const assigns: ALSyntaxNode[] = [];
      const collect = (node: ALSyntaxNode): void => {
        if (node.kind === ALNodeKind.assignment_statement) assigns.push(node);
        for (const child of node.namedChildren) collect(child);
      };
      collect(root);
      const [firstAssign, secondAssign] = assigns;
      if (firstAssign === undefined || secondAssign === undefined) {
        throw new Error(`fixture expected 2 assignments, found ${assigns.length}`);
      }
      const specs: MutationSpec[] = [firstAssign, secondAssign].map((assign, i) => ({
        operatorName: "op.flip",
        operatorVersion: "1.0.0",
        astNodeId: `${assign.startIndex}`,
        before: assign,
        after: { ...assign, text: `X := ${i + 2};` } as never,
        parentContext: "statement-position",
      }));
      return { path: "Two.Objects.al", source: TWO_INJECTABLE_OBJECTS, root, specs };
    }

    it("attributes each mutant to its OWN object, not the file's first header", async () => {
      const dir = await mkdtemp(join(tmpdir(), "lethal-two-injectable-objects-"));
      try {
        await writeInstrumentedProject({
          targetDir: dir,
          files: [twoInjectableObjectFile()],
          selectorIds: { selectorId: 60000, controlId: 60001, tableId: 60002 },
          artifactId: "0123456789abcdef0123456789abcdef",
          targetAppId: TARGET_APP_ID,
          operatorTiers: NO_TIERS,
        });

        const manifest = JSON.parse(await readFile(join(dir, "mutant-manifest.json"), "utf8")) as {
          mutants: Array<{
            mutantId: string;
            objectType: string;
            codeunitId: number;
            codeunitName: string;
            triggerName?: string;
            procedureName: string;
          }>;
        };
        expect(manifest.mutants).toHaveLength(2);

        const tableEntry = manifest.mutants.find((m) => m.triggerName === "OnInsert");
        const codeunitEntry = manifest.mutants.find((m) => m.procedureName === "P");
        if (tableEntry === undefined || codeunitEntry === undefined) {
          throw new Error("expected one table-trigger entry and one codeunit-procedure entry");
        }
        // The regression this guards: the old "always the first header" rule would have
        // labelled BOTH entries `table 51050 "First Obj"`.
        expect(tableEntry.objectType).toBe("table");
        expect(tableEntry.codeunitId).toBe(51050);
        expect(tableEntry.codeunitName).toBe("First Obj");
        expect(codeunitEntry.objectType).toBe("codeunit");
        expect(codeunitEntry.codeunitId).toBe(51051);
        expect(codeunitEntry.codeunitName).toBe("Second Obj");

        // Selector-var injection (compile.ts) must have anchored a declaration in BOTH objects —
        // the old `findFirst(codeunit) ?? findFirst(table)` rule injected into only one, leaving
        // the other's guard call with no declaration in scope (AL0118).
        const rewritten = await readFile(join(dir, "Two.Objects.al"), "utf8");
        const declarations = rewritten.match(/MutationSelector: Codeunit "Mutation Selector";/g);
        expect(declarations).toHaveLength(2);
        expect(rewritten).toContain(`MutationSelector.Active('${tableEntry.mutantId}')`);
        expect(rewritten).toContain(`MutationSelector.Active('${codeunitEntry.mutantId}')`);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    const MIXED_KIND_OBJECTS = `codeunit 51052 "Injectable"
{
    procedure P()
    begin
        X := 1;
    end;
}

page 51053 "Not Injectable"
{
    PageType = Card;
    layout { area(Content) { } }
}
`;

    function mixedKindFile() {
      const root = wrapRoot(parseAL(MIXED_KIND_OBJECTS));
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
      return { path: "Mixed.Kind.al", source: MIXED_KIND_OBJECTS, root, specs };
    }

    it("still throws for a file mixing an injectable object with a non-injectable one", async () => {
      const dir = await mkdtemp(join(tmpdir(), "lethal-mixed-kind-"));
      try {
        let thrown: unknown;
        try {
          await writeInstrumentedProject({
            targetDir: dir,
            files: [mixedKindFile()],
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
        expect(message).toContain("Mixed.Kind.al");
        expect(message).toContain("codeunit 51052");
        expect(message).toContain("page 51053");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("refuses BEFORE writing the half-instrumented source into the artifact dir", async () => {
      const dir = await mkdtemp(join(tmpdir(), "lethal-mixed-kind-nowrite-"));
      try {
        await writeInstrumentedProject({
          targetDir: dir,
          files: [mixedKindFile()],
          selectorIds: { selectorId: 60000, controlId: 60001, tableId: 60002 },
          artifactId: "0123456789abcdef0123456789abcdef",
          targetAppId: TARGET_APP_ID,
          operatorTiers: NO_TIERS,
        }).catch(() => {});
        expect(await readdir(dir)).not.toContain("Mixed.Kind.al");
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

    // The refusal above counts headers with a regex, so a COMMENTED-OUT object is a false
    // positive that would refuse a perfectly ordinary file. Worse, a commented object above the
    // live one used to win the `matches[0]` race and label every mutant with ITS (type, id) —
    // the silent misattribution the pair key exists to prevent. Both are why the count runs on
    // comment-stripped text.
    it("ignores a block-commented object header instead of refusing the file", async () => {
      const dir = await mkdtemp(join(tmpdir(), "lethal-commented-object-"));
      try {
        const src = [
          "/*",
          'codeunit 51060 "Retired Impl"',
          "{",
          "}",
          "*/",
          'table 51061 "Live Obj"',
          "{",
          '    fields { field(1; "No."; Code[20]) { } }',
          "",
          "    procedure P()",
          "    begin",
          "        X := 1;",
          "    end;",
          "}",
        ].join("\n");
        const root = wrapRoot(parseAL(src));
        const assign = findFirst(root, ALNodeKind.assignment_statement);
        if (assign === null) throw new Error("fixture has no assignment to mutate");
        await writeInstrumentedProject({
          targetDir: dir,
          files: [
            {
              path: "Live.Table.al",
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
        // The LIVE object, not the commented one — this is the assertion that fails if the
        // stripper is removed (the commented `codeunit 51060` matches first).
        expect(manifest.mutants[0]?.objectType).toBe("table");
        expect(manifest.mutants[0]?.codeunitId).toBe(51061);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe("stripAlComments", () => {
    it("blanks line and block comments while preserving length and newlines", () => {
      const src = "a // gone\n/* also\ngone */ b";
      const out = stripAlComments(src);
      expect(out.length).toBe(src.length);
      expect(out.split("\n").length).toBe(src.split("\n").length);
      expect(out).not.toContain("gone");
      expect(out).toContain("a ");
      expect(out.trimEnd().endsWith("b")).toBe(true);
    });

    it("leaves comment markers that live inside AL string literals alone", () => {
      // A stripper blind to strings would treat this `//` as a comment start and blank the rest
      // of the file — which would then report "no AL object header" on a valid object.
      const src = "Error('use // and /* here');\ncodeunit 51070 \"After\"\n{\n}\n";
      const out = stripAlComments(src);
      expect(out).toContain("use // and /* here");
      expect(out).toContain('codeunit 51070 "After"');
    });

    it("leaves a quoted AL identifier containing a comment marker alone", () => {
      const src = 'Rec."Field // Odd" := 1;\n';
      expect(stripAlComments(src)).toBe(src);
    });
  });

  // R3/R4: `validateSelectorIds` (id-ranges.ts) needs every AL object a target project already
  // declares, across every file — not just the single header `objectHeaderOf` enforces for a file
  // this tool instruments. `scanDeclaredObjects` is the lenient counterpart used only for that
  // collision scan; it never throws on more than one header.
  describe("scanDeclaredObjects", () => {
    it("finds a single object header", () => {
      const src = 'codeunit 50100 "Some Codeunit"\n{\n}\n';
      expect(scanDeclaredObjects(src)).toEqual([
        { type: "codeunit", id: 50100, name: "Some Codeunit" },
      ]);
    });

    it("finds every header in a file with more than one object (unlike objectHeaderOf)", () => {
      const src = 'codeunit 50100 "First"\n{\n}\ntable 50101 "Second"\n{\n}\n';
      expect(scanDeclaredObjects(src)).toEqual([
        { type: "codeunit", id: 50100, name: "First" },
        { type: "table", id: 50101, name: "Second" },
      ]);
    });

    it("ignores a commented-out object header", () => {
      const src = '// codeunit 50100 "Dead"\ncodeunit 50101 "Live"\n{\n}\n';
      expect(scanDeclaredObjects(src)).toEqual([{ type: "codeunit", id: 50101, name: "Live" }]);
    });

    it("returns an empty array for a file with no object header", () => {
      expect(scanDeclaredObjects("// just a comment\n")).toEqual([]);
    });
  });

  // Boundary case a plain revert of `attributeHeader`'s loop condition cannot reach either
  // direction: `header.startIndex > spec.before.startIndex` breaks the loop, so a mutant sitting
  // at EXACTLY a header's own startIndex is the one input where `>` vs `>=` changes the answer.
  describe("attributeHeader", () => {
    const fakeSpecAt = (startIndex: number): MutationSpec =>
      ({ before: { startIndex } }) as unknown as MutationSpec;

    it("attributes a mutant sitting exactly at a header's startIndex to THAT header, not the previous one", () => {
      const headers: readonly ObjectHeader[] = [
        { type: "table", id: 1, name: "A", startIndex: 0 },
        { type: "codeunit", id: 2, name: "B", startIndex: 100 },
      ];
      const atSecondHeader = attributeHeader(headers, fakeSpecAt(100), "test.al");
      expect(atSecondHeader.id).toBe(2);

      // One offset earlier still belongs to the first (previous) object.
      const justBeforeSecondHeader = attributeHeader(headers, fakeSpecAt(99), "test.al");
      expect(justBeforeSecondHeader.id).toBe(1);
    });
  });
});
