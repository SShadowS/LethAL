import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initParser } from "@lethal/engine";
import { writeInstrumentedProject } from "@lethal/schemata";
import { generateMutationSet, identityOrdinalsOf, operatorTiers } from "../src/orchestrator";
import { removeScratchDir } from "./helpers/scratch";

/**
 * R343, end to end through generation: a codeunit wrapped whole in `#if` (an arm the build
 * compiles) yields the SAME mutants as its unwrapped twin, site for site. Before R343 the wrapped
 * object was never indexed, so its typed sites were lost (`swap-additive`), a Tier-1 operator kept
 * a site Tier 2 claims (`swap-modify-flag` on `Modify(true)`), and R-364's by-name fallback stood in
 * for the hang check. The twin has the same text on the same lines, the two wrapper lines being
 * comments, so (line, operator, tag) must match exactly.
 */
const BODY = (name: string, id: number) => `codeunit ${id} "${name}"
{
    procedure Grow(X: Integer): Integer
    begin
        if X > 10 then
            exit(X + 1);
        exit(X);
    end;

    procedure Touch()
    var
        R: Record Par;
    begin
        R.Modify(true);
    end;

    procedure Loop()
    var
        I: Integer;
        N: Integer;
    begin
        while I < N do
            I := 0;
    end;
}`;
const PAR = `table 50110 Par
{
    fields
    {
        field(1; "No."; Code[20]) { }
    }

    trigger OnModify()
    begin
        Codeunit.Run(50999);
    end;
}
`;

let dir = "";
type Row = { line: number; op: string; plat: string };
let raw: Record<string, Row[]> = {};
let deployed: Record<string, Row[]> = {};

beforeAll(async () => {
  await initParser();
  dir = await mkdtemp(join(tmpdir(), "lethal-r343-"));
  await writeFile(
    join(dir, "app.json"),
    JSON.stringify({
      id: "34334334-3433-4343-8343-343343343343",
      name: "R343",
      publisher: "LethAL",
      version: "1.0.0.0",
      idRanges: [{ from: 50100, to: 50199 }],
    }),
  );
  await writeFile(join(dir, "Par.Table.al"), PAR);
  await writeFile(
    join(dir, "Wrap.Codeunit.al"),
    `#if not CLEANX\n${BODY("WrapA", 50100)}\n#endif\n`,
  );
  await writeFile(join(dir, "Twin.Codeunit.al"), `// wrapper\n${BODY("TwinA", 50101)}\n// end\n`);
  const set = await generateMutationSet(dir, { emit: () => {} });
  raw = {};
  for (const f of set.files) {
    const lineOf = (i: number) => f.source.slice(0, i).split("\n").length;
    raw[f.path] = f.specs
      .map((s) => ({
        line: lineOf(s.before.startIndex),
        op: s.operatorName,
        plat: s.platformKillMechanism ?? "-",
      }))
      .sort((a, b) => a.line - b.line || a.op.localeCompare(b.op));
  }
  const out = join(dir, "batch");
  await writeInstrumentedProject({
    targetDir: out,
    files: set.files,
    identityOrdinals: identityOrdinalsOf(set),
    selectorIds: { selectorId: 50197, controlId: 50198, tableId: 50199 },
    artifactId: "0123456789abcdef0123456789abcdef",
    targetAppId: "34334334-3433-4343-8343-343343343343",
    operatorTiers,
  });
  const m = JSON.parse(await readFile(join(out, "mutant-manifest.json"), "utf8")) as {
    mutants: {
      file: string;
      startLine: number;
      operatorName: string;
      platformKillMechanism?: string;
    }[];
  };
  deployed = {};
  for (const e of m.mutants) {
    const file = e.file.replaceAll("\\", "/");
    const rows = deployed[file] ?? [];
    rows.push({ line: e.startLine, op: e.operatorName, plat: e.platformKillMechanism ?? "-" });
    deployed[file] = rows;
  }
  for (const rows of Object.values(deployed))
    rows.sort((a, b) => a.line - b.line || a.op.localeCompare(b.op));
});

afterAll(() => {
  if (dir !== "") removeScratchDir(dir);
});

describe("R343: a live wrapped codeunit mutates exactly like its unwrapped twin", () => {
  // Revert: leave every wrapped object unindexed (the pre-R343 symbol table).
  test("raw specs: the same (line, operator, tag) set", () => {
    expect(raw["Wrap.Codeunit.al"]?.length ?? 0).toBeGreaterThan(0);
    expect(raw["Wrap.Codeunit.al"]).toEqual(raw["Twin.Codeunit.al"]);
  });

  test("deployed mutants: the same (line, operator, tag) set, after tier precedence", () => {
    expect(deployed["Wrap.Codeunit.al"]).toEqual(deployed["Twin.Codeunit.al"]);
  });

  test("by name: the typed site, the Tier-2 claim and the hang refusal", () => {
    const wrap = deployed["Wrap.Codeunit.al"] ?? [];
    const at = (line: number) => wrap.filter((r) => r.line === line).map((r) => r.op);
    // Line 1 is the `#if`, so the body's lines are one down from BODY's own.
    // `exit(X + 1)`: a typed operator sees the wrapped object's parameter.
    expect(at(7)).toContain("lethal.swap-additive");
    // `R.Modify(true)`: the Tier-2 operator sees the receiver's table (unresolved before R343).
    expect(at(15)).toContain("lethal.swap-modify-flag");
    // `I := 0` under `while I < N`: refused as hang-capable through the RESOLVED path (R196). Its
    // only candidates (remove-assignment, shift-integer) are both refused, so the line is empty;
    // the loop condition's line is mutated, so the procedure was processed.
    expect(at(23).length).toBeGreaterThan(0);
    expect(at(24)).toEqual([]);
  });
});
