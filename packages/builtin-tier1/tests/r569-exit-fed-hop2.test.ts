import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import {
  type ALSyntaxNode,
  buildSemanticContext,
  initParser,
  parseAL,
  visit,
  wrapRoot,
} from "@lethal/engine";
import { openItemHangRefuses, tier1Operators } from "../src/index";
import { r569HopTargets, r569Seam } from "../src/loop-hazard";

/**
 * R569 (coord task R-569): the exit-fed second hop. A procedure in a THIRD object whose value
 * reaches an open item's exit through a one-hop callee's RETURN VALUE (its result, or a `var`
 * argument the callee writes and returns) is refused like the one-hop callee. Each test is per
 * mutant: the mutant IS emitted with the rule switched off (`r569Seam.on = false`, master's
 * behaviour) and absent with it on; a control is emitted both ways. "Emitted" is the dispatch rule:
 * the operator targets the node, generates a mutant, and neither `openItemHangRefuses` nor the
 * operator's own hang check refuses it. Every test was red-checked one direction at a time; the red
 * checks are recorded in /coord/handoff/R-569/build.md. All AL here is written for these tests.
 */

beforeAll(async () => {
  await initParser();
});

afterEach(() => {
  r569Seam.on = true;
});

const RA = "lethal.remove-assignment";

const parse = (files: Record<string, string>) =>
  Object.entries(files).map(([path, src]) => ({ path, root: wrapRoot(parseAL(src)) }));

/** Is the remove-assignment mutant at the assignment with exactly `text` in `path` emitted? */
function emits(on: boolean, files: Record<string, string>, path: string, text: string): boolean {
  r569Seam.on = on;
  const parsed = parse(files);
  const ctx = buildSemanticContext(parsed);
  const f = parsed.find((p) => p.path === path);
  if (f === undefined) throw new Error(`no file ${path}`);
  let node: ALSyntaxNode | undefined;
  visit(f.root, (n: ALSyntaxNode) => {
    if (node === undefined && n.rawKind === "assignment_statement" && n.text === text) node = n;
  });
  if (node === undefined) throw new Error(`${text} not found in ${path}`);
  const op = tier1Operators.find((o) => o.name === RA);
  if (op === undefined) throw new Error(`no operator ${RA}`);
  return (
    op.targets(node, ctx) &&
    op.generate(node, ctx).length > 0 &&
    !openItemHangRefuses(node, ctx, op.name) &&
    op.refusesHangCapable?.(node, ctx) !== true
  );
}

/** Seam off emits, seam on refuses. */
const refusedByRule = (files: Record<string, string>, path: string, text: string): void => {
  expect(emits(false, files, path, text)).toBe(true);
  expect(emits(true, files, path, text)).toBe(false);
};
/** Emitted both ways. */
const emittedBothWays = (files: Record<string, string>, path: string, text: string): void => {
  expect(emits(false, files, path, text)).toBe(true);
  expect(emits(true, files, path, text)).toBe(true);
};

// The hop-2 objects, shared.
const PERIOD = `codeunit 50692 "R569 Period"
{
    procedure NextDate(Steps: Integer): Integer
    var
        Moved: Integer;
    begin
        Moved := Steps - 1;
        exit(Moved);
    end;
}
`;
const LOG = `codeunit 50693 "R569 Log"
{
    procedure Log(Steps: Integer)
    begin
        Total := Total + Steps;
    end;

    var
        Total: Integer;
}
`;
const FMT = `codeunit 50694 "R569 Fmt"
{
    procedure Wrap(Value: Integer): Integer
    var
        Wrapped: Integer;
    begin
        Wrapped := Value * 2;
        exit(Wrapped);
    end;
}
`;

// The hop-1 callee: its return is assigned from the hop-2 NextDate; Log feeds nothing.
const MGT = `codeunit 50691 "R569 Mgt"
{
    procedure NextRecord(Steps: Integer): Integer
    var
        ResultSteps: Integer;
    begin
        ResultSteps := Period.NextDate(Steps);
        Other.Log(Steps);
        exit(ResultSteps);
    end;

    procedure NextWrapped(Steps: Integer): Integer
    begin
        exit(Fmt.Wrap(Period.NextDate(Steps)));
    end;

    var
        Period: Codeunit "R569 Period";
        Other: Codeunit "R569 Log";
        Fmt: Codeunit "R569 Fmt";
}
`;

const report = (trigger: string, procs = ""): string => `report 50690 "R569 Budget"
{
    dataset
    {
        dataitem(Loop; Integer)
        {
            trigger OnAfterGetRecord()
            begin
${trigger}
            end;
        }
    }
${procs}
    var
        Mgt: Codeunit "R569 Mgt";
        Lines: Integer;
}
`;

// T1: the Export Item Budget to Excel shape. The loop ends on a same-object helper whose `exit`
// is the hop-1 call, and the hop-1 return is assigned from the hop-2 call.
const BUDGET = report(
  `                repeat
                    Lines += 1;
                until NextLine(1) = 0;`,
  `
    local procedure NextLine(Steps: Integer): Integer
    begin
        exit(Mgt.NextRecord(Steps));
    end;
`,
);
const T1 = { "r.al": BUDGET, "m.al": MGT, "p.al": PERIOD, "l.al": LOG, "f.al": FMT };

describe("R569 T1: a hop-2 call feeding the hop-1 return that a same-object helper exits", () => {
  // Red: skip the `exitFedHop2` call in `oneHopReach`.
  it("NextDate's step is refused", () => {
    refusedByRule(T1, "p.al", "Moved := Steps - 1");
  });
  it("the debug hook names the target, with no module state", () => {
    const hits = r569HopTargets(buildSemanticContext(parse(T1)));
    // names are normalized (lower case, unquoted)
    expect(hits).toEqual([
      {
        report: "r569 budget",
        hop1: "r569 mgt.nextrecord",
        obj: "r569 period",
        proc: "nextdate",
        tag: "exit",
      },
    ]);
  });
});

describe("R569 T2: a hop-2 call in the hop-1 callee that feeds nothing", () => {
  // Red: follow every hop-2 call of a hop-1 callee.
  it("Log's write stays emitted", () => {
    emittedBothWays(T1, "l.al", "Total := Total + Steps");
  });
});

// T3: report code passes `Amount` to another object's `var` parameter; `Done` is fed by `Amount`.
const CALC = `codeunit 50695 "R569 Calc"
{
    procedure Compute(var Amount: Decimal)
    begin
        Amount := Amount + Inc.Get();
    end;

    var
        Inc: Codeunit "R569 Inc";
}
`;
const INC = `codeunit 50696 "R569 Inc"
{
    procedure Get(): Decimal
    var
        Step: Decimal;
    begin
        Step := 5;
        exit(Step);
    end;
}
`;
const ENTRY = `report 50697 "R569 Entry"
{
    dataset
    {
        dataitem(Loop; Integer)
        {
            trigger OnAfterGetRecord()
            begin
                repeat
                    Calc.Compute(Amount);
                    Done := Amount > 100;
                until Done;
            end;
        }
    }

    var
        Calc: Codeunit "R569 Calc";
        Amount: Decimal;
        Done: Boolean;
}
`;

describe("R569 T3: the entry-var path (a residual) is not followed", () => {
  // Red: follow the hop-0 `var` entry into another object.
  it("Inc.Get, reached only through `Calc.Compute(Amount)` from report code, stays emitted", () => {
    emittedBothWays({ "r.al": ENTRY, "c.al": CALC, "i.al": INC }, "i.al", "Step := 5");
  });
});

describe("R569 T4: the hop-1 call sits directly in `until`", () => {
  const files = {
    "r.al": report(`                repeat
                    Lines += 1;
                until Mgt.NextRecord(1) = 0;`),
    "m.al": MGT,
    "p.al": PERIOD,
    "l.al": LOG,
    "f.al": FMT,
  };
  // Red: do not follow a call into another object that sits directly in the report's exit parts.
  it("NextDate's step is refused", () => {
    refusedByRule(files, "p.al", "Moved := Steps - 1");
  });
});

// T5: a Break guard in OnAfterGetRecord reads a hop-1 return that comes from a third object.
const MORE = `codeunit 50698 "R569 More"
{
    procedure HasMore(): Boolean
    begin
        exit(Src.Step() <> 0);
    end;

    var
        Src: Codeunit "R569 Src";
}
`;
const SRC = `codeunit 50699 "R569 Src"
{
    procedure Step(): Integer
    begin
        Pos += 1;
        exit(10 - Pos);
    end;

    var
        Pos: Integer;
}
`;
const BREAK = `report 50700 "R569 Break"
{
    dataset
    {
        dataitem(Loop; Integer)
        {
            trigger OnAfterGetRecord()
            begin
                if not More.HasMore() then
                    CurrReport.Break();
            end;
        }
    }

    var
        More: Codeunit "R569 More";
}
`;

describe("R569 T5: a CurrReport.Break guard fed by a hop-1 return from a third object", () => {
  // Red: drop the Break-guard exits.
  it("Src.Step's advance is refused", () => {
    refusedByRule({ "r.al": BREAK, "m.al": MORE, "s.al": SRC }, "s.al", "Pos += 1");
  });
});

describe("R569 T6: a third-object call that is an ARGUMENT of a call into another object", () => {
  const files = {
    "r.al": report(`                repeat
                    Lines += 1;
                until Mgt.NextWrapped(1) = 0;`),
    "m.al": MGT,
    "p.al": PERIOD,
    "l.al": LOG,
    "f.al": FMT,
  };
  it("the outer receiver's procedure (Fmt.Wrap) is refused as hop 2", () => {
    refusedByRule(files, "f.al", "Wrapped := Value * 2");
  });
  // Red: ignore `r568StopsAt` in the hop analysis.
  it("the inner argument call (Period.NextDate) stays emitted", () => {
    emittedBothWays(files, "p.al", "Moved := Steps - 1");
  });
});

// T7: the hop-1 callee returns a name it has a third object write through a `var` parameter.
const NEXT = `codeunit 50701 "R569 Next"
{
    procedure HasNext(): Boolean
    var
        Result: Boolean;
    begin
        Helper.Calc(Result);
        exit(Result);
    end;

    var
        Helper: Codeunit "R569 Helper";
}
`;
const HELPER = `codeunit 50702 "R569 Helper"
{
    procedure Calc(var Found: Boolean)
    begin
        Found := Pos < 10;
        Pos += 1;
    end;

    var
        Pos: Integer;
}
`;
const WHILE = `report 50703 "R569 While"
{
    dataset
    {
        dataitem(Loop; Integer)
        {
            trigger OnAfterGetRecord()
            begin
                while Nxt.HasNext() do
                    Lines += 1;
            end;
        }
    }

    var
        Nxt: Codeunit "R569 Next";
        Lines: Integer;
}
`;

describe("R569 T7: a var write inside the hop-1 callee that feeds its return", () => {
  // Red: drop the `var` scan inside procedures reached through their return value.
  it("Helper.Calc's advance is refused", () => {
    refusedByRule({ "r.al": WHILE, "n.al": NEXT, "h.al": HELPER }, "h.al", "Pos += 1");
  });
  it("the debug hook tags it `ret-var`", () => {
    const files = { "r.al": WHILE, "n.al": NEXT, "h.al": HELPER };
    const hits = r569HopTargets(buildSemanticContext(parse(files)));
    expect(hits.map((h) => `${h.obj}.${h.proc}:${h.tag}`)).toEqual(["r569 helper.calc:ret-var"]);
  });
});

// T8: the AsmExists shape: an OnPreDataItem Break of a table item inside an open Integer item.
const ROW = `table 50704 "R569 Row"
{
    fields
    {
        field(1; "No."; Code[20]) { }
    }
}
`;
const JOB = `codeunit 50705 "R569 Job"
{
    procedure AsmToOrderExists(): Boolean
    begin
        exit(Link.AsmExists());
    end;

    var
        Link: Codeunit "R569 Link";
}
`;
const LINK = `codeunit 50706 "R569 Link"
{
    procedure AsmExists(): Boolean
    var
        Found: Boolean;
    begin
        Found := Checks > 0;
        exit(Found);
    end;

    var
        Checks: Integer;
}
`;
const PRE = `report 50707 "R569 Pre"
{
    dataset
    {
        dataitem(Loop; Integer)
        {
            dataitem(Asm; "R569 Row")
            {
                trigger OnPreDataItem()
                begin
                    if not Job.AsmToOrderExists() then
                        CurrReport.Break();
                end;
            }
        }
    }

    var
        Job: Codeunit "R569 Job";
}
`;

describe("R569 T8: an OnPreDataItem Break guard (the stated over-refusal)", () => {
  // Red: skip Break guards in OnPreDataItem.
  it("Link.AsmExists is refused", () => {
    refusedByRule(
      { "r.al": PRE, "t.al": ROW, "j.al": JOB, "k.al": LINK },
      "k.al",
      "Found := Checks > 0",
    );
  });
});

// T9: a report helper reached through its RETURN VALUE passes a fed name to another object's
// `var` parameter; that callee is a hop-1 callee feeding the return, so its third-object call is
// hop 2 (build review r1, finding 1).
const ADV = `codeunit 50708 "R569 Adv"
{
    procedure Advance(var Found: Boolean)
    begin
        Found := Period.NextDate(1) <> 0;
    end;

    var
        Period: Codeunit "R569 Period";
}
`;

describe("R569 T9: a var call in a report helper reached through its return value", () => {
  const loop = `                repeat
                    Lines += 1;
                until not GetNext();`;
  // Red: drop every hop-0 cross-object `var` call, also in a helper reached by return value.
  it("NextDate's step is refused (exit(Found))", () => {
    const r = report(
      loop,
      `
    local procedure GetNext(): Boolean
    var
        Adv: Codeunit "R569 Adv";
        Found: Boolean;
    begin
        Adv.Advance(Found);
        exit(Found);
    end;
`,
    );
    refusedByRule({ "r.al": r, "a.al": ADV, "p.al": PERIOD }, "p.al", "Moved := Steps - 1");
  });
  it("T9b: NextDate's step is refused (named return)", () => {
    const r = report(
      loop,
      `
    local procedure GetNext() Found: Boolean
    var
        Adv: Codeunit "R569 Adv";
    begin
        Adv.Advance(Found);
    end;
`,
    );
    refusedByRule({ "r.al": r, "a.al": ADV, "p.al": PERIOD }, "p.al", "Moved := Steps - 1");
  });
});
