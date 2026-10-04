import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ALSyntaxNode,
  type ArmEvaluation,
  buildSemanticContext,
  evaluateArms,
  findFirst,
  initParser,
  parseAL,
  wrapRoot,
} from "@lethal/engine";
import { generateMutationSet } from "../src/orchestrator";

/**
 * R378 (plan `docs/superpowers/plans/2026-10-02-R-378-member-wide-inactive-arms.md`, r3): the
 * analyses that read more than their own site, and set a tag from what they read, skip the `#if`
 * arms the build compiles out. Every row first asserts the mutant EXISTS in both builds, so an
 * absent tag can never be an absent mutant.
 */

const TABLE_R = `table 50300 "R Tab"
{
    fields
    {
        field(1; "Code"; Code[20]) { }
        field(2; Amount; Integer) { }
    }
    keys
    {
        key(PK; "Code") { Clustered = true; }
    }
    trigger OnInsert()
    begin
#if LETHALX
        "Code" := 'A';
#endif
        Amount := 1;
    end;

    trigger OnModify()
    begin
#if LETHALX
        Error('m');
#endif
        Amount := 2;
    end;
}
`;

// The FIRST key in the text is inactive without LETHALX: the build's primary key is then "Code",
// which OnInsert assigns. With LETHALX the primary key is Amount, which OnInsert does not assign.
const TABLE_K = `table 50301 "K Tab"
{
    fields
    {
        field(1; "Code"; Code[20]) { }
        field(2; Amount; Integer) { }
    }
    keys
    {
#if LETHALX
        key(PK; Amount) { Clustered = true; }
#else
        key(PK; "Code") { Clustered = true; }
#endif
    }
    trigger OnInsert()
    begin
        "Code" := 'A';
    end;
}
`;

// `#if and` cannot be evaluated as alc does (R214: unparsed-condition), so this file is undecided.
// Neither trigger assigns the key or raises, so only "undecided keeps the tag" can tag either site.
const TABLE_U = `table 50302 "U Tab"
{
    fields
    {
        field(1; "Code"; Code[20]) { }
        field(2; Amount; Integer) { }
    }
    keys
    {
        key(PK; "Code") { Clustered = true; }
    }
    trigger OnInsert()
    begin
#if and
        Amount := 1;
#endif
    end;

    trigger OnModify()
    begin
#if and
        Amount := 2;
#endif
    end;
}
`;

// TABLE_U without its directives: the control that says the undecided rule, not the body, tags.
const TABLE_C = `table 50303 "C Tab"
{
    fields
    {
        field(1; "Code"; Code[20]) { }
        field(2; Amount; Integer) { }
    }
    keys
    {
        key(PK; "Code") { Clustered = true; }
    }
    trigger OnInsert()
    begin
        Amount := 1;
    end;

    trigger OnModify()
    begin
        Amount := 2;
    end;
}
`;

// A key with no readable field list: `primaryKeyFields` reads [], which must not prove anything.
const TABLE_N = `table 50304 "N Tab"
{
    fields
    {
        field(1; "Code"; Code[20]) { }
        field(2; Amount; Integer) { }
    }
    keys
    {
        key(PK) { Clustered = true; }
    }
    trigger OnInsert()
    begin
        Amount := 1;
    end;
}
`;

// No keys section and no OnInsert (BaseApp's "Job Queue Notified Admin" shape, measured): with no
// compiled OnInsert there is nothing for Insert(false) to skip, so the unreadable key must not tag.
const TABLE_E = `table 50306 "E Tab"
{
    fields
    {
        field(1; "Code"; Code[20]) { }
    }
}
`;

// A trigger inside a MEMBER-level #if (a `preproc_conditional` in the object body). Before R405 (a)
// `findTableTrigger` read direct members only and never found it, in either build; since R405 (a)
// it is found exactly when the arm is compiled (the A3 pin below).
const TABLE_D = `table 50305 "D Tab"
{
    fields
    {
        field(1; "Code"; Code[20]) { }
    }
    keys
    {
        key(PK; "Code") { Clustered = true; }
    }
#if LETHALX
    trigger OnModify()
    begin
        Error('m');
    end;
#endif
}
`;

// R405 (a): `#if and` cannot be evaluated (R214: unparsed-condition), so this FILE is undecided. A
// direct trigger in an undecided file is found, as before; a trigger INSIDE the undecided `#if` is
// not, because the first arm in the text would otherwise win (plan r2 point 2).
const TABLE_UD = `table 50307 "UD Tab"
{
    fields
    {
        field(1; "Code"; Code[20]) { }
    }
    keys
    {
        key(PK; "Code") { Clustered = true; }
    }
    trigger OnModify()
    begin
        Error('m');
    end;
#if and
    trigger OnDelete()
    begin
        Error('d');
    end;
#endif
}
`;

const OPS = `codeunit 50310 "R378 Ops"
{
    procedure CommitThenRun()
    var
        Ok: Boolean;
    begin
        Ok := false;
        Commit();
#if LETHALX
        Ok := Codeunit.Run(50310);
#endif
    end;

    procedure InsR()
    var
        RTab: Record "R Tab";
    begin
        RTab.Insert(true);
    end;

    procedure ModR()
    var
        RTab: Record "R Tab";
    begin
        RTab.Modify();
    end;

    procedure InsK()
    var
        KTab: Record "K Tab";
    begin
        KTab.Insert(true);
    end;

    procedure InsU()
    var
        UTab: Record "U Tab";
    begin
        UTab.Insert(true);
    end;

    procedure ModU()
    var
        UTab: Record "U Tab";
    begin
        UTab.Modify();
    end;

    procedure InsC()
    var
        CTab: Record "C Tab";
    begin
        CTab.Insert(true);
    end;

    procedure ModC()
    var
        CTab: Record "C Tab";
    begin
        CTab.Modify();
    end;

    procedure InsN()
    var
        NTab: Record "N Tab";
    begin
        NTab.Insert(true);
    end;

    procedure InsE()
    var
        ETab: Record "E Tab";
    begin
        ETab.Insert(true);
    end;

    procedure ModD()
    var
        DTab: Record "D Tab";
    begin
        DTab.Modify();
    end;

    procedure ModUD()
    var
        UDRec: Record "UD Tab";
    begin
        UDRec.Modify();
    end;

    procedure DelUD()
    var
        UDRec: Record "UD Tab";
    begin
        UDRec.Delete();
    end;
}
`;

const FILES: Record<string, string> = {
  "src/RTab.Table.al": TABLE_R,
  "src/KTab.Table.al": TABLE_K,
  "src/UTab.Table.al": TABLE_U,
  "src/CTab.Table.al": TABLE_C,
  "src/NTab.Table.al": TABLE_N,
  "src/DTab.Table.al": TABLE_D,
  "src/ETab.Table.al": TABLE_E,
  "src/UDTab.Table.al": TABLE_UD,
  "src/Ops.Codeunit.al": OPS,
};

const REMOVE_COMMIT = "lethal.remove-commit";
const SWAP_FLAG = "lethal.swap-modify-flag";

/** One row per spec in Ops: `<line> <operator> <tag or ->`. */
type Row = { line: number; op: string; plat: string };

let rowsByBuild: Record<"off" | "on", Row[]>;

const lineOf = (needle: string): number => {
  const at = OPS.indexOf(needle);
  if (at < 0 || OPS.indexOf(needle, at + 1) >= 0) throw new Error(`not unique in OPS: ${needle}`);
  return OPS.slice(0, at).split("\n").length;
};

async function rowsFor(symbols: readonly string[]): Promise<Row[]> {
  const dir = await mkdtemp(join(tmpdir(), "lethal-r378-"));
  try {
    await Bun.write(join(dir, "app.json"), JSON.stringify({ name: "p" }));
    for (const [rel, text] of Object.entries(FILES)) await Bun.write(join(dir, rel), text);
    const set = await generateMutationSet(dir, { preprocessorSymbols: symbols, emit: () => {} });
    const ops = set.files.find((f) => f.path.replaceAll("\\", "/") === "src/Ops.Codeunit.al");
    if (ops === undefined) throw new Error("no specs for Ops");
    return ops.specs.map((s) => ({
      line: OPS.slice(0, s.before.startIndex).split("\n").length,
      op: s.operatorName,
      plat: s.platformKillMechanism ?? "-",
    }));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** The ONE spec of `op` at the line of `needle`, asserted to exist. */
function site(build: "off" | "on", needle: string, op: string): Row {
  const line = lineOf(needle);
  const found = rowsByBuild[build].filter((r) => r.line === line && r.op === op);
  expect(found, `${build}: ${op} at ${needle}`).toHaveLength(1);
  const [only] = found;
  if (only === undefined) throw new Error("unreachable");
  return only;
}

beforeAll(async () => {
  await initParser();
  rowsByBuild = { off: await rowsFor([]), on: await rowsFor(["LETHALX"]) };
});

describe("R378: tags read only the arms the build compiles", () => {
  test("A1: a consumed Codeunit.Run only in an inactive arm does not tag remove-commit", () => {
    expect(site("off", "Commit();", REMOVE_COMMIT).plat).toBe("-");
    expect(site("on", "Commit();", REMOVE_COMMIT).plat).toBe("write-txn-codeunit-run");
  });

  test("A2: a key assignment only in an inactive arm of OnInsert does not keep the skipped-insert tag", () => {
    expect(site("off", "RTab.Insert(true)", SWAP_FLAG).plat).toBe("-");
    expect(site("on", "RTab.Insert(true)", SWAP_FLAG).plat).toBe("run-trigger-skipped-insert");
  });

  test("A2-key: the primary key is the first ACTIVE key, not the first key in the text", () => {
    expect(site("off", "KTab.Insert(true)", SWAP_FLAG).plat).toBe("run-trigger-skipped-insert");
    expect(site("on", "KTab.Insert(true)", SWAP_FLAG).plat).toBe("-");
  });

  test("A3: a raise only in an inactive arm of OnModify does not tag the forced mutant", () => {
    expect(site("off", "RTab.Modify()", SWAP_FLAG).plat).toBe("-");
    expect(site("on", "RTab.Modify()", SWAP_FLAG).plat).toBe("run-trigger-forced");
  });

  test("A2-unreadable-key: a key with no readable field list keeps the skipped-insert tag", () => {
    expect(site("off", "NTab.Insert(true)", SWAP_FLAG).plat).toBe("run-trigger-skipped-insert");
    expect(site("on", "NTab.Insert(true)", SWAP_FLAG).plat).toBe("run-trigger-skipped-insert");
  });

  test("A2-no-trigger: no keys section and no OnInsert gives no skipped-insert tag (as on master)", () => {
    expect(site("off", "ETab.Insert(true)", SWAP_FLAG).plat).toBe("-");
    expect(site("on", "ETab.Insert(true)", SWAP_FLAG).plat).toBe("-");
  });

  test("A3 pin (R405 a): a trigger inside a member-level #if yields a forward mutant only in the build that compiles it", () => {
    expect(site("on", "DTab.Modify()", SWAP_FLAG).plat).toBe("run-trigger-forced");
    const line = lineOf("DTab.Modify()");
    expect(rowsByBuild.off.filter((r) => r.line === line && r.op === SWAP_FLAG)).toEqual([]);
  });

  test("A3 pin (R405 a): every other Ops row is unchanged in both builds (captured on master f396e037)", () => {
    const dLine = lineOf("DTab.Modify()");
    const other = (build: "off" | "on"): string[] =>
      rowsByBuild[build]
        .filter((r) => !(r.line === dLine && r.op === SWAP_FLAG))
        .map((r) => `${r.line} ${r.op} ${r.plat}`);
    expect(other("off")).toEqual(OTHER_ROWS_OFF);
    expect(other("on")).toEqual(OTHER_ROWS_ON);
  });

  test("R405 a: in an UNDECIDED file a direct trigger is found and a trigger inside #if is not", () => {
    expect(evaluateArms(wrapRoot(parseAL(TABLE_UD)), TABLE_UD, []).kind).toBe("undecided");
    for (const build of ["off", "on"] as const) {
      expect(site(build, "UDRec.Modify()", SWAP_FLAG).plat).toBe("run-trigger-forced");
      const line = lineOf("UDRec.Delete()");
      expect(rowsByBuild[build].filter((r) => r.line === line && r.op === SWAP_FLAG)).toEqual([]);
    }
  });
});

// Every Ops row except the D Tab forward mutant, as master f396e037 produced them (R405 a).
const TAIL_ROWS: string[] = [
  "38 lethal.empty-block -",
  "39 lethal.void-method-call -",
  "39 lethal.swap-modify-flag run-trigger-skipped-insert",
  "45 lethal.empty-block -",
  "46 lethal.void-method-call -",
  "46 lethal.swap-modify-flag run-trigger-forced",
  "52 lethal.empty-block -",
  "53 lethal.void-method-call -",
  "53 lethal.swap-modify-flag -",
  "59 lethal.empty-block -",
  "60 lethal.void-method-call -",
  "60 lethal.swap-modify-flag -",
  "66 lethal.empty-block -",
  "67 lethal.void-method-call -",
  "67 lethal.swap-modify-flag run-trigger-skipped-insert",
  "73 lethal.empty-block -",
  "74 lethal.void-method-call -",
  "74 lethal.swap-modify-flag -",
  "80 lethal.empty-block -",
  "81 lethal.void-method-call -",
  "87 lethal.empty-block -",
  "88 lethal.void-method-call -",
  "88 lethal.swap-modify-flag run-trigger-forced",
  "94 lethal.empty-block -",
  "95 lethal.void-method-call -",
];
const OTHER_ROWS_OFF: string[] = [
  "6 lethal.empty-block -",
  "7 lethal.remove-assignment -",
  "7 lethal.flip-boolean-literal -",
  "8 lethal.void-method-call -",
  "8 lethal.remove-commit -",
  "17 lethal.empty-block -",
  "18 lethal.void-method-call -",
  "18 lethal.swap-modify-flag -",
  "24 lethal.empty-block -",
  "25 lethal.void-method-call -",
  "25 lethal.swap-modify-flag -",
  "31 lethal.empty-block -",
  "32 lethal.void-method-call -",
  "32 lethal.swap-modify-flag run-trigger-skipped-insert",
  ...TAIL_ROWS,
];
const OTHER_ROWS_ON: string[] = [
  "6 lethal.empty-block -",
  "7 lethal.remove-assignment -",
  "7 lethal.flip-boolean-literal -",
  "8 lethal.void-method-call -",
  "8 lethal.remove-commit write-txn-codeunit-run",
  "10 lethal.remove-assignment -",
  "17 lethal.empty-block -",
  "18 lethal.void-method-call -",
  "18 lethal.swap-modify-flag run-trigger-skipped-insert",
  "24 lethal.empty-block -",
  "25 lethal.void-method-call -",
  "25 lethal.swap-modify-flag run-trigger-forced",
  "31 lethal.empty-block -",
  "32 lethal.void-method-call -",
  "32 lethal.swap-modify-flag -",
  ...TAIL_ROWS,
];

describe("R378: an undecided receiver file keeps the tag (A2 and A3)", () => {
  const parsed = (text: string): ALSyntaxNode => wrapRoot(parseAL(text));

  test("the control's preconditions: U Tab resolves and is undecided; C Tab is decided", () => {
    const u = parsed(TABLE_U);
    const c = parsed(TABLE_C);
    const ctx = buildSemanticContext([
      { path: "src/UTab.Table.al", root: u },
      { path: "src/CTab.Table.al", root: c },
    ]);
    expect(ctx.symbols.resolveObject({ kind: "table", idOrName: "U Tab" })).not.toBeNull();
    expect(ctx.symbols.resolveObject({ kind: "table", idOrName: "C Tab" })).not.toBeNull();
    for (const symbols of [[], ["LETHALX"]]) {
      expect(evaluateArms(u, TABLE_U, symbols).kind).toBe("undecided");
      expect(evaluateArms(c, TABLE_C, symbols)).toEqual({ kind: "decided", inactive: [] });
    }
  });

  test("the same table without the bad directive gives neither tag", () => {
    for (const build of ["off", "on"] as const) {
      expect(site(build, "CTab.Insert(true)", SWAP_FLAG).plat).toBe("-");
      expect(site(build, "CTab.Modify()", SWAP_FLAG).plat).toBe("-");
    }
  });

  test("A2-undecided: Insert(true) on the undecided table keeps run-trigger-skipped-insert", () => {
    for (const build of ["off", "on"] as const) {
      expect(site(build, "UTab.Insert(true)", SWAP_FLAG).plat).toBe("run-trigger-skipped-insert");
    }
  });

  test("A3-undecided: Modify() on the undecided table keeps run-trigger-forced", () => {
    for (const build of ["off", "on"] as const) {
      expect(site(build, "UTab.Modify()", SWAP_FLAG).plat).toBe("run-trigger-forced");
    }
  });
});

describe("R378: SemanticContext.armOf", () => {
  test("with an arm map, a node from a tree not in the map throws", () => {
    const a = wrapRoot(parseAL(TABLE_C));
    const b = wrapRoot(parseAL(TABLE_R));
    const arms = new Map<ALSyntaxNode, ArmEvaluation>([[a, { kind: "decided", inactive: [] }]]);
    const ctx = buildSemanticContext([{ path: "src/CTab.Table.al", root: a }], arms);
    const inA = findFirst(a, "trigger_declaration" as never);
    const inB = findFirst(b, "trigger_declaration" as never);
    if (inA === null || inB === null) throw new Error("fixture has no trigger");
    expect(ctx.armOf?.(inA)).toBe("active");
    expect(() => ctx.armOf?.(inB)).toThrow(/R378/);
  });

  test("without an arm map, armOf is absent", () => {
    const a = wrapRoot(parseAL(TABLE_C));
    expect(buildSemanticContext([{ path: "src/CTab.Table.al", root: a }]).armOf).toBeUndefined();
  });
});
