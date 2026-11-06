import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  ALNodeKind,
  type MutationSpec,
  findAll,
  initParser,
  parseAL,
  wrapRoot,
} from "@lethal/engine";
import {
  type IdedSpec,
  type TierResolver,
  assignMutantIds,
  buildComponents,
  dedupeSpecs,
  instrumentOneFile,
  planReachGrains,
} from "@lethal/schemata";
import { generateMutationSet, operatorTiers } from "../src/orchestrator";
import { type FileCase, type Finding, checkFile, hasParseError } from "./helpers/r827-residual";

/**
 * R827 residualising test. LethAL puts every mutant behind `Selector.Active('Mxxxx')`. Hand-written
 * AL cannot show that the REAL emitter's text means what each mutant should mean (an `else` can
 * bind to the wrong `if` and still compile). So, for every mutant of every file, this folds the
 * real emitted text as if only that mutant were on, and compares it BY STRUCTURE with the original
 * source plus the mutant's own edit. The rules (what is folded, stripped, and ignored) are in
 * `helpers/r827-residual.ts`.
 *
 * Preprocessor-wrapped files: the generator keeps only mutants in arms active under the build
 * symbols, but the emitted text keeps every arm and its directives. The comparison does not
 * evaluate `#if`: directives and all arms are compared as tree nodes, so the mutant's edit must
 * land in the same arm on both sides. A project with `symbol-sets.json` runs once per set, plus
 * once with no symbols.
 */

const REPO = resolve(import.meta.dir, "../../..");
const tierOf: TierResolver = (name) => operatorTiers.get(name);

const PROJECTS = [
  "fixtures/sandbox-app",
  "fixtures/sandbox-data",
  "fixtures/sandbox-harden",
  "fixtures/sandbox-hang",
  "fixtures/sandbox-wrapped",
  "fixtures/sandbox-names",
  "fixtures/sandbox-multiobject",
  "fixtures/sandbox-symbols",
  "examples/gift-card",
];

/** Mutants checked per project, over its symbol sets. A change here is a change to read. */
const MUTANTS: Readonly<Record<string, number>> = {
  "fixtures/sandbox-app": 19,
  "fixtures/sandbox-data": 406,
  "fixtures/sandbox-harden": 21,
  "fixtures/sandbox-hang": 38,
  "fixtures/sandbox-wrapped": 148,
  "fixtures/sandbox-names": 36,
  "fixtures/sandbox-multiobject": 12,
  "fixtures/sandbox-symbols": 36,
  "examples/gift-card": 60,
};

function symbolSetsOf(rel: string): string[][] {
  const p = join(REPO, rel, "symbol-sets.json");
  const declared = existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as string[][]) : [];
  return [[], ...declared];
}

function caseOf(
  path: string,
  source: string,
  compiled: string,
  ided: readonly IdedSpec[],
): FileCase {
  const grains = planReachGrains(ided, source);
  return {
    path,
    source,
    compiled,
    mutants: ided.map(({ mutantId, spec }) => ({
      mutantId,
      operator: spec.operatorName,
      start: spec.before.startIndex,
      end: spec.before.endIndex,
      afterText: spec.after.text,
      marked: grains.get(mutantId) === "statement",
    })),
  };
}

interface DirResult {
  files: number;
  refused: number;
  mutants: number;
  guards: number;
  markers: number;
  /** R827: free bodies seen. */
  free: number;
  /** R828 O1: components with other components inside them. */
  split: number;
  /** R827: loops the `guard-in-loop` check saw under a guard's `else`. */
  walked: number;
  findings: Finding[];
}

/** The generator's files, instrumented the way the trial does, each checked. */
async function checkDir(
  dir: string,
  symbols: readonly string[],
  keep: (index: number) => boolean = () => true,
  withDetail = true,
  excludeOperators?: readonly string[],
): Promise<DirResult> {
  const set = await generateMutationSet(dir, {
    preprocessorSymbols: symbols,
    emit: () => {},
    ...(excludeOperators !== undefined ? { excludeOperators } : {}),
  });
  const out: DirResult = {
    files: 0,
    refused: set.refusedFiles.length,
    mutants: 0,
    guards: 0,
    markers: 0,
    free: 0,
    split: 0,
    walked: 0,
    findings: [],
  };
  let i = 0;
  for (const f of set.files) {
    if (!keep(i++)) continue;
    const deduped = dedupeSpecs(f.specs, tierOf);
    const ided = assignMutantIds(new Map([[f.path, deduped]])).get(f.path) ?? [];
    if (ided.length === 0) continue;
    // No catch: an emitter that throws must fail this test, not shrink what it checked.
    const { compiled } = instrumentOneFile(f, deduped, ided);
    const r = await checkFile(caseOf(f.path, f.source, compiled, ided), withDetail);
    out.files++;
    out.mutants += r.checked;
    out.guards += r.stats.guards;
    out.markers += r.stats.markers;
    // From the components, not the emitted text, where a nested free guard would fold unseen.
    const comps = buildComponents(ided);
    out.free += comps.filter((c) => c.free === true).length;
    out.split += comps.filter((c) => c.split === true).length;
    out.walked += r.walked;
    out.findings.push(...r.findings);
  }
  return out;
}

describe("R827: every mutant, folded, equals the mutant written by hand", () => {
  for (const rel of PROJECTS) {
    test(rel, async () => {
      let mutants = 0;
      let files = 0;
      const findings: Finding[] = [];
      for (const symbols of symbolSetsOf(rel)) {
        const r = await checkDir(join(REPO, rel), symbols);
        mutants += r.mutants;
        files += r.files;
        findings.push(...r.findings);
        expect(r.refused).toBe(0);
        // The fold must have really folded: a guard-free or marker-free pass proves nothing.
        if (r.mutants > 0) {
          expect(r.guards).toBeGreaterThan(0);
          expect(r.markers).toBeGreaterThan(0);
        }
      }
      console.log(`[r827] ${rel}: ${files} files, ${mutants} mutants, ${findings.length} findings`);
      // Exact: a file that silently stopped being checked must fail here.
      expect(mutants).toBe(MUTANTS[rel] ?? -1);
      expect(
        findings.map((f) => `${f.path} ${f.mutantId} ${f.operator} ${f.kind}: ${f.detail}`),
      ).toEqual([]);
    }, 60_000);
  }
});

// R828: with `empty-block` out there is no free body, so nothing but the host rule lifts a nested
// loop mutant out of a loop, and every guard of the file is walked.
describe("R828: the same, with empty-block left out", () => {
  for (const rel of PROJECTS) {
    test(rel, async () => {
      let mutants = 0;
      let split = 0;
      const findings: Finding[] = [];
      for (const symbols of symbolSetsOf(rel)) {
        const r = await checkDir(join(REPO, rel), symbols, undefined, true, ["empty-block"]);
        mutants += r.mutants;
        split += r.split;
        findings.push(...r.findings);
        expect(r.refused).toBe(0);
      }
      console.log(`[r828] ${rel}: ${mutants} mutants, ${split} split, ${findings.length} findings`);
      expect(mutants).toBeGreaterThan(0);
      expect(
        findings.map((f) => `${f.path} ${f.mutantId} ${f.operator} ${f.kind}: ${f.detail}`),
      ).toEqual([]);
    }, 60_000);
  }
});

/** A source whose mutant sits in a nested `if` with no `else`, followed by an outer `else`. */
const NESTED = `codeunit 51995 "R827 Red" { procedure P(C: Boolean; D: Boolean; var X: Integer) begin if C then begin if D then X := 1; end else X := 2; end; }`;

async function nestedCase(): Promise<FileCase> {
  await initParser();
  const root = wrapRoot(parseAL(NESTED));
  const inner = findAll(root, ALNodeKind.if_statement)[1];
  const cond = inner?.childForFieldName("condition");
  if (inner === undefined || cond === null || cond === undefined) throw new Error("nested: drift");
  const spec: MutationSpec = {
    operatorName: "lethal.negate-conditional",
    operatorVersion: "1.0.0",
    astNodeId: `${cond.startIndex}-${cond.endIndex}`,
    before: cond,
    after: { ...cond, text: "not D" } as never,
    parentContext: "statement-position",
  };
  const path = "Red.Codeunit.al";
  const ided = assignMutantIds(new Map([[path, [spec]]])).get(path) ?? [];
  const { compiled } = instrumentOneFile({ path, source: NESTED, root }, [spec], ided);
  return caseOf(path, NESTED, compiled, ided);
}

const MARKERS =
  /if not LethALReachLatch\d* then begin \w+\.Reached\('M\d+'\); LethALReachLatch\d* := true; end; ?/g;

describe("R827: the comparison can fail", () => {
  test("control: the nested shape, real emitted text, is clean", async () => {
    const fc = await nestedCase();
    expect(fc.mutants.length).toBe(1);
    expect((await checkFile(fc)).findings).toEqual([]);
  });

  test("a mutant that lost its marker is reported, and nothing else is", async () => {
    const fc = await nestedCase();
    expect(fc.mutants[0]?.marked).toBe(true);
    const cut = fc.compiled.replace(MARKERS, "");
    expect(cut).not.toBe(fc.compiled);
    const r = await checkFile({ ...fc, compiled: cut });
    expect(r.findings.map((x) => `${x.mutantId} ${x.kind}`)).toEqual(["M0001 marker"]);
  });

  test("an else that binds to the inner if is reported", async () => {
    const fc = await nestedCase();
    const bare = fc.compiled.replace(MARKERS, "");
    // Remove the first guard's begin/end: `if G then begin A end else begin R end` becomes
    // `if G then A else begin R end`, and with A an `if` with no `else` the `else` now belongs to A.
    const planted = bare.replace(
      /(\.Active\('M\d+'\) then )begin\s*([\s\S]*?)\s*end else /,
      "$1$2 else ",
    );
    expect(planted).not.toBe(bare);
    expect(hasParseError(planted)).toBe(false);
    const r = await checkFile({ ...fc, compiled: planted });
    // The guard now has no `else` of its own (the no-mutant fold and a leftover say so too), and
    // the mutant's own fold differs from the hand-written one.
    expect(r.findings.some((f) => f.kind === "diff" && f.mutantId === "M0001")).toBe(true);
    expect(r.findings.some((f) => f.kind === "no-mutant-diff")).toBe(true);
  });

  // R828: a plain branch holds no guard, and a mutant has exactly one.
  test("a guard planted in a plain branch is reported, with the doubled id", async () => {
    const fc = await nestedCase();
    expect((await checkFile(fc)).findings).toEqual([]);
    const planted = fc.compiled.replace(
      /(MutationSelector\.Active\('M0001'\) then begin\s+)/,
      "$1if MutationSelector.Active('M0001') then begin end else begin end; ",
    );
    expect(planted).not.toBe(fc.compiled);
    expect(hasParseError(planted)).toBe(false);
    const kinds = (await checkFile({ ...fc, compiled: planted })).findings.map((x) => x.kind);
    expect(kinds).toContain("plain-branch-guard");
    expect(kinds).toContain("guard-count");
  });

  test("a mutant with no guard at all is reported", async () => {
    const fc = await nestedCase();
    const r = await checkFile({
      ...fc,
      mutants: [...fc.mutants, { ...(fc.mutants[0] as (typeof fc.mutants)[0]), mutantId: "M0099" }],
    });
    expect(r.findings.filter((x) => x.kind === "guard-count").map((x) => x.mutantId)).toEqual([
      "M0099",
    ]);
  });

  test("a branch carrying another mutant's edit is reported", async () => {
    const path = join(REPO, "fixtures/sandbox-app");
    const set = await generateMutationSet(path, { emit: () => {} });
    const f = set.files.find((x) => x.path.endsWith("SandboxLogic.Codeunit.al"));
    if (f === undefined) throw new Error("SandboxLogic: drift");
    const deduped = dedupeSpecs(f.specs, tierOf);
    const ided = assignMutantIds(new Map([[f.path, deduped]])).get(f.path) ?? [];
    const { compiled } = instrumentOneFile(f, deduped, ided);
    const fc = caseOf(f.path, f.source, compiled, ided);
    expect((await checkFile(fc)).findings).toEqual([]);
    // M0002 and M0003 swap their ids in the guards and the markers: each branch now holds the
    // other's edit.
    const swapped = compiled
      .replaceAll("'M0002'", "'MXXXX'")
      .replaceAll("'M0003'", "'M0002'")
      .replaceAll("'MXXXX'", "'M0003'");
    expect(swapped).not.toBe(compiled);
    const r = await checkFile({ ...fc, compiled: swapped });
    expect(r.findings.map((x) => `${x.mutantId} ${x.kind}`).sort()).toEqual([
      "M0002 diff",
      "M0003 diff",
    ]);
  });

  test("a branch that lost a statement is reported", async () => {
    const path = join(REPO, "fixtures/sandbox-app");
    const set = await generateMutationSet(path, { emit: () => {} });
    const f = set.files.find((x) => x.path.endsWith("SandboxLogic.Codeunit.al"));
    if (f === undefined) throw new Error("SandboxLogic: drift");
    const deduped = dedupeSpecs(f.specs, tierOf);
    const ided = assignMutantIds(new Map([[f.path, deduped]])).get(f.path) ?? [];
    const { compiled } = instrumentOneFile(f, deduped, ided);
    const fc = caseOf(f.path, f.source, compiled, ided);
    // M0005's branch holds `exit(0)`. Drop it from that branch only.
    const at = compiled.indexOf("Active('M0005')");
    const drop = compiled.indexOf("exit(0)", at);
    expect(at).toBeGreaterThan(0);
    expect(drop).toBeGreaterThan(at);
    // `begin end`, because the `then` slot must still parse.
    const lost = `${compiled.slice(0, drop)}begin end${compiled.slice(drop + "exit(0)".length)}`;
    const r = await checkFile({ ...fc, compiled: lost });
    expect(r.findings.map((x) => `${x.mutantId} ${x.kind}`)).toEqual(["M0005 diff"]);
  });
});

/** R827 point 1: every loop kind, in a body with a free `empty-block`, holding mutants. */
const LOOPS_AL = `codeunit 51996 "R827 Loops"
{
    procedure ForLoop(N: Integer) var I: Integer; T: Integer;
    begin
        T := 1;
        for I := 1 to N do begin
            T := T + 1;
            if T > 3 then
                T := T - 1;
        end;
    end;

    procedure WhileLoop(N: Integer) var T: Integer;
    begin
        T := N + 1;
        while N > 0 do begin
            T := T + 2;
            N -= 1;
        end;
    end;

    procedure RepeatLoop(N: Integer) var T: Integer;
    begin
        T := N + 1;
        repeat
            T := T + 2;
            N -= 1;
        until N <= 0;
    end;

    procedure ForeachLoop(L: List of [Integer]) var I: Integer; T: Integer;
    begin
        T := 1;
        foreach I in L do begin
            T := T + I;
            if T > 3 then
                T := T - 1;
        end;
    end;
}
`;

/** `checkDir` over one source, in a throwaway project. */
async function checkSource(
  source: string,
  excludeOperators?: readonly string[],
): Promise<DirResult> {
  const root = await mkdtemp(join(tmpdir(), "lethal-r827-source-"));
  try {
    await writeFile(
      join(root, "app.json"),
      JSON.stringify({
        id: "0f2b7c5e-4d3a-4917-8a1c-3b4a8d9f1027",
        name: "R827 Source",
        publisher: "LethAL",
        version: "1.0.0.0",
        idRanges: [{ from: 51000, to: 51999 }],
      }),
    );
    await writeFile(join(root, "Source.Codeunit.al"), source);
    return await checkDir(root, [], undefined, undefined, excludeOperators);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("R827: a free body keeps its guards out of its loops", () => {
  test("no guard sits inside a loop within a free guard's else, in any loop kind", async () => {
    const r = await checkSource(LOOPS_AL);
    expect(r.mutants).toBeGreaterThan(20);
    expect(r.free).toBe(4);
    // Each of the four bodies holds a loop, so a check that went blind sees fewer.
    expect(r.walked).toBeGreaterThanOrEqual(r.free);
    expect(r.findings.map((f) => `${f.mutantId} ${f.kind}: ${f.detail}`)).toEqual([]);
  });

  // `while` and `repeat` carry their own mutants by default, which root them whatever the rule does.
  test("the same, with the loop's own mutants left out", async () => {
    const r = await checkSource(LOOPS_AL, [
      "conditional-boundary",
      "negate-conditional",
      "loop-skip",
      "loop-truncate",
    ]);
    expect(r.mutants).toBeGreaterThan(10);
    expect(r.free).toBe(4);
    expect(r.walked).toBeGreaterThanOrEqual(r.free);
    expect(r.findings.map((f) => `${f.mutantId} ${f.kind}: ${f.detail}`)).toEqual([]);
  });
});

describe("R827: only a body, and only its own empty-block", () => {
  const BRANCH = `codeunit 51997 "R827 Free"\n{\n    procedure P() var X: Integer;\n    begin\n        if X > 0 then begin\n            X := 1;\n        end;\n    end;\n}\n`;

  test("with no condition mutant a branch's block has no chain root, and is still not free", async () => {
    const r = await checkSource(BRANCH, ["conditional-boundary", "negate-conditional"]);
    expect(r.free).toBe(1);
    expect(r.findings.map((f) => `${f.mutantId} ${f.kind}: ${f.detail}`)).toEqual([]);
  });

  test("another operator's member that resolves to the body is not a guard", async () => {
    const source = `codeunit 51997 "R827 Free"\n{\n    procedure P() var X: Integer; L: List of [Integer];\n    begin\n        foreach X in L do\n            Foo(X + 1);\n    end;\n}\n`;
    // One member alone, so the equal-span rule does not decide it first.
    const r = await checkSource(source, ["empty-block", "void-method-call"]);
    expect(r.mutants).toBeGreaterThan(0);
    expect(r.free).toBe(0);
    expect(r.findings.map((f) => `${f.mutantId} ${f.kind}: ${f.detail}`)).toEqual([]);
  });
});

describe("R853: glued source emits separate words", () => {
  const body = (statements: string): string =>
    `codeunit 51997 "R853 Glued"\n{\n    procedure P(A: Boolean; C: Integer)\n    begin\n${statements}\n    end;\n\n    procedure Foo(C: Integer)\n    begin\n    end;\n\n    procedure "My Q"(C: Integer)\n    begin\n    end;\n}\n`;
  const cases: ReadonlyArray<readonly [string, string]> = [
    ["a replacement before `else`", "        if A then\n            Foo(C + 1)else Foo(C);"],
    ["a wrap before `end`", "        if A then begin\n            if C > 0 then Foo(C + 1)end;"],
    ["a wrap before `until`", "        repeat\n            if C > 0 then Foo(C + 1)until C > 0;"],
    ["a marker after `begin`", `        if A then begin"My Q"(C + 1)end;`],
  ];
  for (const [name, statements] of cases) {
    test(name, async () => {
      const r = await checkSource(body(statements));
      expect(r.findings.map((f) => `${f.mutantId} ${f.kind}: ${f.detail}`)).toEqual([]);
      expect(r.guards).toBeGreaterThan(0);
    });
  }
});

test("R827: a statement touching the body's `end` does not join it", async () => {
  const source = `codeunit 51997 "R827 Free"\n{\n    procedure P() var X: Integer;\n    begin\n        X := 1;\n        Foo(X + 1)end;\n}\n`;
  const r = await checkSource(source);
  expect(r.free).toBe(1);
  expect(r.findings.map((f) => `${f.mutantId} ${f.kind}: ${f.detail}`)).toEqual([]);
});

describe("R827: which body is free", () => {
  const inProc = (body: string, vars = "X: Integer;"): string =>
    `codeunit 51997 "R827 Free"\n{\n    procedure P() var ${vars}\n    begin\n${body}\n    end;\n}\n`;
  const STATEMENTS = "        X := X + 1;\n        X := X + 2;";
  const cases: ReadonlyArray<readonly [string, string, number]> = [
    ["a plain body", inProc(STATEMENTS), 1],
    ["a body with a #pragma", inProc(`${STATEMENTS}\n#pragma warning restore AL0432`), 0],
    ["a body with an #if", inProc(`#if WRAPDEF\n        X := 1;\n#endif\n${STATEMENTS}`), 0],
    [
      "a branch block: the body is, the branch stays in its `if`'s chain",
      inProc("        if X > 0 then begin\n            X := 1;\n        end;"),
      1,
    ],
    [
      "a case arm: the body is, the arm stays in its `case`'s chain",
      inProc("        case X of\n            1: begin X := 2; end;\n        end;"),
      1,
    ],
    [
      "a member that resolves to the block itself",
      inProc(
        "        foreach X in L do\n            Foo(X + 1);",
        "X: Integer; L: List of [Integer];",
      ),
      0,
    ],
    [
      "a trigger's body",
      `codeunit 51997 "R827 Free"\n{\n    trigger OnRun() var X: Integer;\n    begin\n${STATEMENTS}\n    end;\n}\n`,
      1,
    ],
    [
      "`begin` touching the first statement",
      'codeunit 51997 "R827 Free"\n{\n    procedure P() var "Y": Integer;\n    begin"Y" := "Y" + 1;\n    end;\n}\n',
      1,
    ],
    ["comments at both ends", inProc(`// a\n${STATEMENTS}\n// b`), 1],
  ];
  for (const [name, source, free] of cases) {
    test(name, async () => {
      const r = await checkSource(source);
      expect(r.mutants).toBeGreaterThan(0);
      expect(r.free).toBe(free);
      expect(r.findings.map((f) => `${f.mutantId} ${f.kind}: ${f.detail}`)).toEqual([]);
    });
  }
});

/**
 * R828 O1. Every shape the plan names, in a scratch source (no `fixtures/` file changes): a loop
 * with its own member, an inner loop's own member, a loop under `asserterror`, an `if` holding a
 * loop, `if C then Foo()` (root and host close at one index), a `case` arm's empty-block, and a
 * directive inside a root.
 */
const SHAPES_AL = `codeunit 51998 "R828 Shapes"
{
    procedure LoopOwn(N: Integer) var T: Integer;
    begin
        T := 1;
        while N > 0 do begin
            T := T + 1;
            N -= 1;
            if T > 3 then
                T := T - 1;
        end;
    end;

    procedure InnerLoopOwn(N: Integer) var I: Integer; T: Integer;
    begin
        for I := 1 to N do begin
            T := T + I;
            while T < 10 do
                T := T + 2;
        end;
    end;

    procedure LoopUnderAssertError(N: Integer) var T: Integer;
    begin
        asserterror begin
            while N > 0 do begin
                N -= 1;
                T := T + 1;
            end;
        end;
    end;

    procedure IfHoldsLoop(C: Integer; N: Integer) var I: Integer; T: Integer;
    begin
        if C > 0 then
            for I := 1 to N do
                T += 1
        else
            repeat
                N -= 1;
            until N <= 0;
        if C > 1 then begin
            T := 5;
            for I := 1 to N do begin
                T += I;
                if T > 7 then
                    T -= 1;
            end;
        end;
    end;

    procedure IfCallOnly(C: Integer) var T: Integer;
    begin
        if C > 0 then Foo(C + 1);
        if C > 1 then
            Foo(C + 2)
        else
            Foo(C + 3);
    end;

    procedure CaseArms(C: Integer) var T: Integer;
    begin
        case C of
            1: T := 2;
            2:
                begin
                    T := 3;
                end;
            3:
                if T > 0 then
                    T := 9;
            else
                T := 4;
        end;
    end;

    procedure Deep(C: Integer; D: Integer) var T: Integer;
    begin
        if C > 0 then begin
            if D > 0 then begin
                T := 1;
                if T < D then
                    T := 2;
            end else
                T := 3;
        end else if D > 5 then
            T := 4;
    end;

    procedure DirectiveInRoot(C: Integer) var T: Integer;
    begin
        if C > 0 then begin
            T := 1;
#pragma warning disable AL0432
            T := T + 2;
#pragma warning restore AL0432
            if T > 1 then
                T := 7;
        end;
    end;

    procedure TieEnds(C: Integer; D: Integer) var T: Integer;
    begin
        if C > 0 then if D > 0 then T := T + 1;
        if C > 1 then if D > 1 then if T > 0 then T := T + 2 else T := T + 3;
    end;

    // An empty else with its semicolon puts the semicolon INSIDE the if text: the closer must reproduce it.
    procedure EmptyElse(C: Integer) var T: Integer;
    begin
        if C > 0 then T := 1 else;
        T := 2;
        if C > 1 then
            if C > 2 then T := 3 else;
        T := 4;
    end;

    procedure ParenlessCall(C: Integer) var T: Integer;
    begin
        if C > 0 then Touch;
        T := 1;
        if C > 1 then
            Touch
        else
            Touch;
        T := 2;
    end;

    local procedure Touch()
    begin
    end;

    local procedure Foo(X: Integer)
    begin
    end;
}
`;

describe("R828 O1: the shapes, folded, equal the mutant written by hand", () => {
  test("default run: every mutant, every guard walked, nothing split is wrong", async () => {
    const r = await checkSource(SHAPES_AL);
    expect(r.mutants).toBeGreaterThan(60);
    expect(r.split).toBeGreaterThan(5);
    expect(r.walked).toBeGreaterThan(0);
    expect(r.findings.map((f) => `${f.mutantId} ${f.operator} ${f.kind}: ${f.detail}`)).toEqual([]);
  });

  test("with empty-block left out: no guard runs on a pass of a loop its host has", async () => {
    const r = await checkSource(SHAPES_AL, ["empty-block"]);
    expect(r.mutants).toBeGreaterThan(40);
    expect(r.free).toBe(0);
    expect(r.split).toBeGreaterThan(3);
    // The loops under a host's `else` are walked: the `if` holding a loop is one of them.
    expect(r.walked).toBeGreaterThan(0);
    expect(r.findings.map((f) => `${f.mutantId} ${f.operator} ${f.kind}: ${f.detail}`)).toEqual([]);
  });

  test("with the loops' and conditions' own mutants left out too", async () => {
    const r = await checkSource(SHAPES_AL, [
      "empty-block",
      "conditional-boundary",
      "negate-conditional",
      "loop-skip",
      "loop-truncate",
    ]);
    expect(r.mutants).toBeGreaterThan(10);
    expect(r.findings.map((f) => `${f.mutantId} ${f.operator} ${f.kind}: ${f.detail}`)).toEqual([]);
  });

  test("a directive keeps its root a flat chain, and everything below it", async () => {
    const from = SHAPES_AL.indexOf("    procedure DirectiveInRoot");
    const source = SHAPES_AL.slice(from, SHAPES_AL.indexOf("    procedure TieEnds"));
    const head = 'codeunit 51998 "R828 Shapes"\n{\n';
    const r = await checkSource(`${head}${source}}\n`, ["empty-block"]);
    expect(r.mutants).toBeGreaterThan(3);
    // The `if C > 0` holds the pragma, so it hosts its nested `if` as a member: nothing is split.
    expect(r.split).toBe(0);
    expect(r.findings.map((f) => `${f.mutantId} ${f.operator} ${f.kind}: ${f.detail}`)).toEqual([]);
  });

  test("a root with a loop inside and a condition mutant: one component per root, loop flat", async () => {
    const source = `codeunit 51998 "R828 Shapes"\n{\n    procedure P(C: Integer; N: Integer) var I: Integer; T: Integer;\n    begin\n        if C > 0 then\n            for I := 1 to N do\n                T += 1;\n    end;\n}\n`;
    const r = await checkSource(source, ["empty-block", "loop-skip", "loop-truncate"]);
    expect(r.split).toBe(1);
    expect(r.walked).toBeGreaterThan(0);
    expect(r.findings.map((f) => `${f.mutantId} ${f.operator} ${f.kind}: ${f.detail}`)).toEqual([]);
  });
});

/**
 * R828 O1, the GLUED class: source with no space between a root and what follows it. A root that
 * ends in `;` (`else;`, a parenless call) ends where the next statement starts, and a chain's `end`
 * can touch the source's `end`. Each shape here failed once (a statement landing inside a chain,
 * `rewrite.overlap`, `endend`), so a fold or chain bug of this kind fails offline BY CLASS NAME.
 */
const GLUED_AL = `codeunit 51997 "R828 Glued"
{
    procedure SemiThenIf(C: Integer; var T: Integer)
    begin
        if C > 0 then T := T + 1 else;if C > 1 then T := T + 3;
        T := 9;
    end;

    procedure SemiThenAssign(C: Integer; var T: Integer)
    begin
        if C > 0 then T := T + 1 else;T := T + 2;
    end;

    procedure ParenlessThenIf(C: Integer; var T: Integer)
    begin
        if C > 0 then Touch;if C > 1 then T := T + 1;
        if C > 2 then Touch;Touch;
    end;

    procedure WrappedSemiThenAssign(C: Integer; var T: Integer)
    begin
        if C > 1 then if C > 2 then T := 3 else;T := T + 4;
        if C > 3 then if C > 4 then T := 5 else;if C > 5 then T := T + 6;
    end;

    local procedure Touch()
    begin
    end;
}
`;

const GLUED_END_AL = `codeunit 51996 "R828 Glued End"
{
    procedure EndAfterParen(C: Integer; D: Integer)
    begin
        if D > 0 then begin if C > 0 then Foo(C + 1)end;
    end;

    procedure NestedEndAfterParen(C: Integer; D: Integer)
    begin
        if D > 0 then begin if C > 0 then if D > 1 then Foo(C + 1)end;
    end;

    local procedure Foo(X: Integer)
    begin
    end;
}
`;

describe("R828 O1: GLUED class, folded equal to the mutant written by hand", () => {
  const show = (r: DirResult) =>
    r.findings.map((f) => `${f.mutantId} ${f.operator} ${f.kind}: ${f.detail}`);
  test("a statement glued after a root ending in `;`, a parenless call, wrapped forms: all mutants", async () => {
    const r = await checkSource(GLUED_AL);
    expect(r.mutants).toBeGreaterThan(30);
    expect(r.split).toBeGreaterThan(3);
    expect(show(r)).toEqual([]);
  });
  test("the same, with empty-block left out", async () => {
    const r = await checkSource(GLUED_AL, ["empty-block"]);
    expect(r.mutants).toBeGreaterThan(20);
    expect(r.split).toBeGreaterThan(3);
    expect(show(r)).toEqual([]);
  });
  // `void-method-call` deletes the call, leaving `then end`: the hand-written mutant cannot parse.
  test("`end` glued after `)`, nested: all mutants but the call's deletion", async () => {
    const r = await checkSource(GLUED_END_AL, ["void-method-call"]);
    expect(r.mutants).toBeGreaterThan(5);
    expect(r.split).toBeGreaterThan(1);
    expect(show(r)).toEqual([]);
  });
  test("the same, with empty-block left out too", async () => {
    const r = await checkSource(GLUED_END_AL, ["void-method-call", "empty-block"]);
    expect(r.mutants).toBeGreaterThan(3);
    expect(show(r)).toEqual([]);
  });
});

const CORPUS = process.env.LETHAL_R827_CORPUS;

describe("R827: corpus (LETHAL_R827_CORPUS=<dir>, counts only, never source text)", () => {
  test.skipIf(CORPUS === undefined)(
    "folds every mutant of one directory",
    async () => {
      if (CORPUS === undefined) return;
      // LETHAL_R827_STEP=k checks every k-th file that has specs (a sample); default is all.
      const step = Math.max(1, Number(process.env.LETHAL_R827_STEP ?? "1"));
      expect(Number.isInteger(step)).toBe(true);
      const symbols = (process.env.LETHAL_R827_SYMBOLS ?? "").split(",").filter(Boolean);
      const t0 = Date.now();
      const r = await checkDir(CORPUS, symbols, (i) => i % step === 0, false);
      const byKind = new Map<string, number>();
      const byOp = new Map<string, number>();
      for (const f of r.findings) {
        byKind.set(f.kind, (byKind.get(f.kind) ?? 0) + 1);
        byOp.set(`${f.operator} ${f.kind}`, (byOp.get(`${f.operator} ${f.kind}`) ?? 0) + 1);
      }
      console.log(
        `[r827 corpus] step ${step}, checked ${r.files} files, ${r.mutants} mutants, ${r.guards} guards folded, ${r.markers} markers stripped, ${r.refused} refused, ${r.findings.length} findings, ${Date.now() - t0} ms`,
      );
      console.log(`[r827 corpus] findings by kind: ${JSON.stringify([...byKind])}`);
      console.log(`[r827 corpus] findings by operator and kind: ${JSON.stringify([...byOp])}`);
      // A file name and a mutant id are fine to print; `detail` may hold source, so it is left out.
      for (const f of r.findings.slice(0, 20))
        console.log(`[r827 corpus] ${f.kind} ${f.mutantId} ${f.path}`);
      expect(r.files).toBeGreaterThan(0);
      expect(r.mutants).toBeGreaterThan(0);
      expect(r.findings.length).toBe(0);
    },
    3_600_000,
  );
});
