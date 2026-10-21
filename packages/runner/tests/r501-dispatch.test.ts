import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initParser } from "@lethal/engine";
import { type MutationSetResult, generateMutationSet } from "../src/orchestrator";
import { removeScratchDir } from "./helpers/scratch";

/**
 * R501: ONE dispatch-level hang refusal in `generateMutationSet`, asked for EVERY operator. A site
 * in open report data-item code (R487's scope), or one that deletes or alters a bounded `Integer`
 * item's only bound, is not generated and is counted in R447's `hang-refused` row. Each refused
 * shape has a `MaxIteration` twin (same report, bounded item) and a codeunit twin that still emit,
 * so a rule widened to every report, or to everything, goes red here. The operators used are NOT
 * R196's four value operators, whose own `refusesHangCapable` already covered R487's scope.
 */

const APP_JSON = JSON.stringify({
  id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  name: "T",
  publisher: "P",
  version: "1.0.0.0",
  idRanges: [{ from: 50000, to: 79999 }],
});

// `Loop` is OPEN (its only SetRange is not literal); `Capped` is its MaxIteration twin.
const OPEN = "src/Open.Report.al";
const OPEN_AL = `report 50501 "Open"
{
    dataset
    {
        dataitem(Loop; Integer)
        {
            column(Neg; not Flag) { }
            trigger OnPreDataItem()
            begin
                SetRange(Number, 1, NoOfCopies);
            end;

            trigger OnAfterGetRecord()
            begin
                if not Continue then CurrReport.Break();
                while Buf.Next() <> 0 do
                    Done := true;
                repeat
                until Buf.Next() = 0;
                if Flag then
                    Done := false;
                Step();
            end;
        }
        dataitem(Capped; Integer)
        {
            MaxIteration = 1;
            column(NegC; not Flag) { }
            trigger OnPreDataItem()
            begin
                SetRange(Number, 1, NoOfCopies);
            end;

            trigger OnAfterGetRecord()
            begin
                if not Continue then CurrReport.Break();
                while Buf.Next() <> 0 do
                    Done := true;
                repeat
                until Buf.Next() = 0;
                if Flag then
                    Done := false;
                StepCapped();
            end;
        }
    }
    var
        Buf: Record Customer temporary;
        Continue: Boolean;
        Flag: Boolean;
        Done: Boolean;
        NoOfCopies: Integer;

    local procedure Step()
    begin
        Buf.Init();
    end;

    local procedure StepCapped()
    begin
        Buf.Init();
    end;
}
`;
const TWIN = "src/Twin.Codeunit.al";
const TWIN_AL = `codeunit 50502 "Twin"
{
    procedure P()
    begin
        Buf.SetRange("No.", '1', Code);
        if not Continue then Buf.DeleteAll();
        while Buf.Next() <> 0 do
            Done := true;
        repeat
        until Buf.Next() = 0;
        if Continue then
            Done := false;
        Step();
    end;

    local procedure Step()
    begin
        Buf.Init();
    end;

    var
        Buf: Record Customer temporary;
        Continue: Boolean;
        Done: Boolean;
        Code: Code[20];
}
`;
// The bound class. `Fixed` is bounded by an UNQUALIFIED `SetRange(Number, 1, 3)` and `Qual` by a
// QUALIFIED `Qual.SetRange(...)` (`certifiedCall`'s two branches); each also holds a SetRange on
// ANOTHER record, which emits. `Capped` (MaxIteration) and `Viewed` (view-bounded) are twins.
const BOUND = "src/Bound.Report.al";
const BOUND_AL = `report 50503 "Bound"
{
    dataset
    {
        dataitem(Fixed; Integer)
        {
            trigger OnPreDataItem()
            begin
                SetRange(Number, 1, 3);
                Buf.SetRange("No.", 'F');
            end;

            trigger OnAfterGetRecord()
            begin
                Buf.DeleteAll();
            end;
        }
        dataitem(Qual; Integer)
        {
            trigger OnPreDataItem()
            begin
                Qual.SetRange(Number, 1, 3);
                Buf.SetRange("No.", 'Q');
            end;
        }
        dataitem(Capped; Integer)
        {
            MaxIteration = 3;
            trigger OnPreDataItem()
            begin
                SetRange(Number, 1, 3);
            end;
        }
        dataitem(Viewed; Integer)
        {
            DataItemTableView = where(Number = const(1));
            trigger OnPreDataItem()
            begin
                Buf.SetRange("No.", 'V');
            end;
        }
    }
    var
        Buf: Record Customer temporary;
}
`;
const BOUND_TWIN = "src/BoundTwin.Codeunit.al";
const BOUND_TWIN_AL = `codeunit 50504 "BoundTwin"
{
    procedure P(var Int: Record Integer)
    begin
        Int.SetRange(Number, 1, 3);
    end;
}
`;
// A reportextension `modify(D)` block runs inside base item D: open base, refused; capped base,
// emitted.
const EXT_BASE = "src/ExtOpen.Report.al";
const EXT_BASE_AL = `report 50505 "ExtOpen"
{
    dataset
    {
        dataitem(D; Integer)
        {
            trigger OnAfterGetRecord()
            begin
                if Total > 3 then CurrReport.Break();
            end;
        }
    }
    var
        Total: Integer;
}
`;
const EXT_CAPPED = "src/ExtCapped.Report.al";
const EXT_CAPPED_AL = EXT_BASE_AL.replace('50505 "ExtOpen"', '50506 "ExtCapped"').replace(
  "dataitem(D; Integer)\n        {\n",
  "dataitem(D; Integer)\n        {\n            MaxIteration = 10;\n",
);
const extOf = (
  id: number,
  name: string,
  base: string,
) => `reportextension ${id} "${name}" extends "${base}"
{
    dataset
    {
        modify(D)
        {
            trigger OnAfterAfterGetRecord()
            begin
                Buf.DeleteAll();
            end;
        }
    }
    var
        Buf: Record Customer temporary;
}
`;
const EXT = "src/Open.ReportExt.al";
const EXT_CAPPED_EXT = "src/Capped.ReportExt.al";

const FILES: Readonly<Record<string, string>> = {
  [OPEN]: OPEN_AL,
  [TWIN]: TWIN_AL,
  [BOUND]: BOUND_AL,
  [BOUND_TWIN]: BOUND_TWIN_AL,
  [EXT_BASE]: EXT_BASE_AL,
  [EXT_CAPPED]: EXT_CAPPED_AL,
  [EXT]: extOf(50507, "OpenExt", "ExtOpen"),
  [EXT_CAPPED_EXT]: extOf(50508, "CappedExt", "ExtCapped"),
};

/** 1-based line of the `nth` (1-based) line containing `marker`. */
function at(src: string, marker: string, nth = 1): number {
  let seen = 0;
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]?.includes(marker) === true && ++seen === nth) return i + 1;
  }
  throw new Error(`marker ${JSON.stringify(marker)} #${nth} not found`);
}

let dir = "";
beforeAll(async () => {
  await initParser();
  dir = await mkdtemp(join(tmpdir(), "lethal-r501-"));
  await Bun.write(join(dir, "app.json"), APP_JSON);
  for (const [rel, content] of Object.entries(FILES)) await Bun.write(join(dir, rel), content);
});
afterAll(() => {
  if (dir !== "") removeScratchDir(dir);
});

const gen = (op: string) =>
  generateMutationSet(dir, { emit: () => {}, operators: [`lethal.${op}`] });
const emitted = (set: MutationSetResult, file: string): number[] =>
  set.files
    .filter((f) => f.path === file)
    .flatMap((f) => f.specs)
    .map((s) => s.before.startPosition.row + 1)
    .sort((a, b) => a - b);
const refused = (set: MutationSetResult, file: string): number =>
  set.hangRefused.find((r) => r.file === file)?.sites ?? 0;

describe("R501: open report data-item code is refused for every operator", () => {
  test("void-method-call: an unbraced `then CurrReport.Break()`, a callee's call and the CopyLoop SetRange", async () => {
    const set = await gen("void-method-call");
    // Loop's Break, its Step() call, the `Buf.Init()` in Step (reached from Loop), and its own
    // `SetRange(Number, 1, NoOfCopies)`.
    expect(refused(set, OPEN)).toBe(4);
    // Only Capped's Break, its StepCapped() call and StepCapped's body call emit.
    expect(emitted(set, OPEN)).toEqual([
      at(OPEN_AL, "CurrReport.Break()", 2),
      at(OPEN_AL, "StepCapped();"),
      at(OPEN_AL, "Buf.Init();", 2),
    ]);
    expect(emitted(set, TWIN)).toEqual([
      at(TWIN_AL, "Buf.DeleteAll()"),
      at(TWIN_AL, "Step();"),
      at(TWIN_AL, "Buf.Init();"),
    ]);
    expect(refused(set, TWIN)).toBe(0);
  });

  test("empty-block: a whole OnAfterGetRecord, OnPreDataItem, and a callee body", async () => {
    const set = await gen("empty-block");
    expect(refused(set, OPEN)).toBe(3);
    expect(emitted(set, OPEN)).toEqual([
      at(OPEN_AL, "begin", 3), // Capped OnPreDataItem
      at(OPEN_AL, "begin", 4), // Capped OnAfterGetRecord
      at(OPEN_AL, "procedure StepCapped") + 1,
    ]);
    expect(emitted(set, TWIN)).toEqual([
      at(TWIN_AL, "procedure P") + 1,
      at(TWIN_AL, "procedure Step") + 1,
    ]);
  });

  test("negate-guard: a bare-Boolean guard", async () => {
    const set = await gen("negate-guard");
    expect(refused(set, OPEN)).toBe(1);
    expect(emitted(set, OPEN)).toEqual([at(OPEN_AL, "if Flag then", 2)]);
    expect(emitted(set, TWIN)).toEqual([at(TWIN_AL, "if Continue then")]);
  });

  test("remove-setrange (Tier 2): the CopyLoop's own SetRange", async () => {
    const set = await gen("remove-setrange");
    expect(refused(set, OPEN)).toBe(1);
    expect(emitted(set, OPEN)).toEqual([at(OPEN_AL, "SetRange(Number, 1, NoOfCopies)", 2)]);
    expect(emitted(set, TWIN)).toEqual([at(TWIN_AL, "Buf.SetRange")]);
  });

  test("loop-skip and loop-truncate are refused too (no shortening exemption)", async () => {
    const skip = await gen("loop-skip");
    expect(refused(skip, OPEN)).toBe(1);
    expect(emitted(skip, OPEN)).toEqual([at(OPEN_AL, "while Buf.Next()", 2)]);
    expect(emitted(skip, TWIN)).toEqual([at(TWIN_AL, "while Buf.Next()")]);
    const truncate = await gen("loop-truncate");
    expect(refused(truncate, OPEN)).toBe(1);
    // loop-truncate's site is the `until` condition.
    expect(emitted(truncate, OPEN)).toEqual([at(OPEN_AL, "until Buf.Next()", 2)]);
    expect(emitted(truncate, TWIN)).toEqual([at(TWIN_AL, "until Buf.Next()")]);
  });

  test("a report column's source is NOT counted hang-refused: it stays a declarative site", async () => {
    const set = await gen("remove-not");
    // Only Loop's `not Continue`; its column `not Flag` is declarative, as Capped's is.
    expect(refused(set, OPEN)).toBe(1);
    expect(set.declarativeSites).toEqual([{ file: OPEN, kinds: "report_declaration", sites: 2 }]);
    expect(emitted(set, OPEN)).toEqual([at(OPEN_AL, "not Continue", 2)]);
    expect(emitted(set, TWIN)).toEqual([at(TWIN_AL, "not Continue")]);
  });

  test("a reportextension `modify(D)` block: open base refused, MaxIteration base emits", async () => {
    const set = await gen("void-method-call");
    expect(refused(set, EXT)).toBe(1);
    expect(emitted(set, EXT)).toEqual([]);
    expect(refused(set, EXT_CAPPED_EXT)).toBe(0);
    expect(emitted(set, EXT_CAPPED_EXT)).toEqual([
      at(FILES[EXT_CAPPED_EXT] ?? "", "Buf.DeleteAll"),
    ]);
    expect(refused(set, EXT_BASE)).toBe(1);
    expect(emitted(set, EXT_CAPPED)).toEqual([at(EXT_CAPPED_AL, "CurrReport.Break()")]);
  });
});

describe("R501: a bounded item's ONLY bound is refused, through both certificate branches", () => {
  test("void-method-call: both bound calls refused; the item's other code emits", async () => {
    const set = await gen("void-method-call");
    expect(refused(set, BOUND)).toBe(2);
    expect(emitted(set, BOUND)).toEqual([at(BOUND_AL, "Buf.DeleteAll")]);
  });

  test("remove-setrange: both bound calls refused; other-record, MaxIteration and view twins emit", async () => {
    const set = await gen("remove-setrange");
    expect(refused(set, BOUND)).toBe(2);
    expect(emitted(set, BOUND)).toEqual([
      at(BOUND_AL, "Buf.SetRange(\"No.\", 'F')"),
      at(BOUND_AL, "Buf.SetRange(\"No.\", 'Q')"),
      at(BOUND_AL, "SetRange(Number, 1, 3)", 3), // Capped's (the 2nd is Qual's)
      at(BOUND_AL, "Buf.SetRange(\"No.\", 'V')"),
    ]);
    expect(emitted(set, BOUND_TWIN)).toEqual([at(BOUND_TWIN_AL, "Int.SetRange")]);
  });

  test("empty-block of the block CONTAINING the bound: refused; the twins' blocks emit", async () => {
    const set = await gen("empty-block");
    expect(refused(set, BOUND)).toBe(2);
    expect(emitted(set, BOUND)).toEqual([
      at(BOUND_AL, "begin", 2), // Fixed OnAfterGetRecord
      at(BOUND_AL, "begin", 4), // Capped OnPreDataItem
      at(BOUND_AL, "begin", 5), // Viewed OnPreDataItem
    ]);
  });

  test("INSIDE the bound: no operator claims a SetRange(Number, ...) argument, even where allowed", async () => {
    // The `inside` direction of `altersBoundCall` has no generator to exercise it today; this pins
    // that absence on the twins, where nothing would refuse such a site. The predicate's own
    // `inside` answer is pinned in builtin-tier1's `r501-open-item.test.ts`.
    const set = await generateMutationSet(dir, { emit: () => {} });
    const CALL = "SetRange(Number, 1, 3)";
    const argSpans = (src: string): [number, number][] => {
      const out: [number, number][] = [];
      for (let i = src.indexOf(CALL); i >= 0; i = src.indexOf(CALL, i + 1)) {
        out.push([i + "SetRange(".length, i + CALL.length - 1]);
      }
      return out;
    };
    const claimedInside = (file: string, src: string) => {
      const spans = argSpans(src);
      expect(spans.length).toBeGreaterThan(0);
      return set.files
        .filter((f) => f.path === file)
        .flatMap((f) => f.specs)
        .filter((s) => spans.some(([a, b]) => a <= s.before.startIndex && s.before.endIndex <= b))
        .map((s) => s.operatorName);
    };
    expect(claimedInside(BOUND, BOUND_AL)).toEqual([]);
    expect(claimedInside(BOUND_TWIN, BOUND_TWIN_AL)).toEqual([]);
  });
});

describe("R501: refusals land in R447's row and obey --operator and --lines", () => {
  test("a full run names every refusing file", async () => {
    const set = await generateMutationSet(dir, { emit: () => {} });
    expect(set.hangRefused.map((r) => r.file).sort()).toEqual([BOUND, EXT_BASE, EXT, OPEN].sort());
    expect(refused(set, TWIN)).toBe(0);
    expect(refused(set, BOUND_TWIN)).toBe(0);
  });

  test("--operator not admitting the refused operators: no row for them", async () => {
    // remove-setrange admits only the CopyLoop SetRange and the two bound calls.
    const set = await gen("remove-setrange");
    expect(set.hangRefused).toEqual([
      { file: BOUND, kinds: "report_declaration", sites: 2 },
      { file: OPEN, kinds: "report_declaration", sites: 1 },
    ]);
  });

  test("--lines away from the open item: no row; over its Break: the row", async () => {
    const keep = { file: TWIN, start: 1, end: 30 };
    const breakLine = at(OPEN_AL, "CurrReport.Break()");
    const away = await generateMutationSet(dir, {
      emit: () => {},
      operators: ["lethal.void-method-call"],
      lines: [keep, { file: OPEN, start: 1, end: 3 }],
    });
    expect(away.hangRefused).toEqual([]);
    const over = await generateMutationSet(dir, {
      emit: () => {},
      operators: ["lethal.void-method-call"],
      lines: [keep, { file: OPEN, start: breakLine, end: breakLine }],
    });
    expect(over.hangRefused).toEqual([{ file: OPEN, kinds: "report_declaration", sites: 1 }]);
  });

  test("an operator whose only sites are R501-refused: the barren error names R501", async () => {
    const solo = await mkdtemp(join(tmpdir(), "lethal-r501-solo-"));
    try {
      await Bun.write(join(solo, "app.json"), APP_JSON);
      await Bun.write(
        join(solo, OPEN),
        OPEN_AL.replace(/\n {8}dataitem\(Capped[\s\S]*?\n {8}\}\n/, "\n"),
      );
      const err = await generateMutationSet(solo, {
        emit: () => {},
        operators: ["lethal.negate-guard"],
      }).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain(
        `"lethal.negate-guard" had site(s) refused as hang-capable (each writes a variable an enclosing loop's condition reads, R196, or is code of an unbounded report data item or a bounded item's only bound, R487/R501): ${OPEN} (1)`,
      );
    } finally {
      await rm(solo, { recursive: true, force: true });
    }
  });
});
